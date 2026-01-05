const fs = require('fs');
const path = require('path');

// ⭐ AUTO DELETE SESSION ON STARTUP
if (process.env.FORCE_DELETE_SESSION === 'true') {
    console.log('🗑️ FORCE_DELETE_SESSION=true detected!');
    console.log('Deleting auth_info_baileys folder...');
    
    const authPath = path.join(__dirname, 'auth_info_baileys');
    
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log('✅ Auth folder DELETED successfully!');
        } else {
            console.log('ℹ️ Auth folder not found (already deleted)');
        }
    } catch (error) {
        console.error('❌ Error deleting auth folder:', error.message);
    }
}

// Ensure crypto module is available
if (typeof global.crypto === 'undefined') {
    global.crypto = require('crypto');
}

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const P = require('pino');

const app = express();
app.use(express.json());

// ============================
// Global variables
// ============================
let sock;
let qrCodeData = null;
let isReady = false;
let startTime = Date.now();
let activityLogs = [];
let connectionAttempts = 0;
let qrRefreshInterval = null;
let qrExpiryTime = null;
const QR_EXPIRY_SECONDS = 60; // QR code expired setelah 40 detik

// ============================
// Helper function for activity
// ============================
function addActivity(message) {
    const timestamp = new Date().toISOString();
    activityLogs.push({ timestamp, message });

    // Batasi hanya 100 log terakhir
    if (activityLogs.length > 100) {
        activityLogs.shift();
    }
    console.log(`[Activity] ${timestamp} - ${message}`);
}

// ============================
// Initialize WhatsApp Client
// ============================
async function connectToWhatsApp() {
    try {
        connectionAttempts++;

        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Laravel Bot', 'Chrome', '1.0.0'],
        
        // ⭐ TIMEOUT SETTINGS - NAIKKAN SEMUA
        connectTimeoutMs: 120000,        // 2 menit (dari 60 detik)
        defaultQueryTimeoutMs: 60000,    // 1 menit
        qrTimeout: 60000,                // ⭐ QR timeout 60 detik
        
        // ⭐ KEEP ALIVE & RETRY
        keepAliveIntervalMs: 10000,      // Keep alive setiap 10 detik
        retryRequestDelayMs: 1000,       // Delay retry 1 detik
        maxMsgRetryCount: 10,            // Max retry 10x
        
        // ⭐ CONNECTION SETTINGS
        markOnlineOnConnect: false,      // ⭐ Jangan mark online dulu
        syncFullHistory: false,
        getMessage: async () => undefined,
        
        // ⭐ FIREWALL ISSUES FIX
        fireAlreadyExistsError: false,
        shouldIgnoreJid: () => false,
        
        // ⭐ PENTING: QR GENERATION OPTIONS
        generateHighQualityLinkPreview: false,
        patchMessageBeforeSending: (message) => message,
        
        // ⭐ WASocket options
        emitOwnEvents: true,
        downloadHistory: false
    });

        // QR Code Event
        sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, isNewLogin } = update;
    
        if (qr) {
            if (!qrCodeData) {
                qrCodeData = qr;
                qrExpiryTime = Date.now() + (60000); // ⭐ 60 detik (sync dengan qrTimeout)
                
                addActivity("✅ QR Code diterima! Silahkan scan dengan WhatsApp");
                qrcode.generate(qr, { small: true });
                console.log('\n=== QR CODE READY ===');
                console.log('QR Timestamp:', new Date().toISOString());
                console.log('QR will expire at:', new Date(qrExpiryTime).toISOString());
                console.log('Please scan within 60 seconds');
                console.log('====================\n');
                
                // Clear previous interval
                if (qrRefreshInterval) {
                    clearInterval(qrRefreshInterval);
                }
                
                // ⭐ Set timeout untuk auto-restart kalau tidak di-scan
                qrRefreshInterval = setTimeout(() => {
                    if (!isReady) {
                        addActivity("⏰ QR tidak di-scan, generating QR baru...");
                        qrCodeData = null;
                        qrExpiryTime = null;
                        
                        // Restart socket
                        if (sock) {
                            try {
                                sock.end(undefined);
                            } catch (err) {
                                console.error('Error ending socket:', err);
                            }
                        }
                        
                        setTimeout(() => {
                            connectToWhatsApp();
                        }, 3000);
                    }
                }, 58000); // ⭐ 58 detik (2 detik sebelum timeout)
                
            } else {
                console.log('⚠️ QR code already exists, ignoring new QR');
            }
        }
    
        if (connection === 'connecting') {
            addActivity("🔄 Sedang mencoba connect ke WhatsApp...");
            console.log('⏳ Connection state: CONNECTING');
        }
    
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n❌ CONNECTION CLOSED ❌');
            console.log('Status Code:', statusCode);
            console.log('Reason:', DisconnectReason[statusCode] || 'Unknown');
            console.log('Should Reconnect:', shouldReconnect);
            if (lastDisconnect?.error) {
                console.log('Error:', lastDisconnect.error.message);
            }
            console.log('========================\n');
            
            // Clear QR interval/timeout
            if (qrRefreshInterval) {
                clearTimeout(qrRefreshInterval);
                qrRefreshInterval = null;
            }
            
            isReady = false;
            qrCodeData = null;
            qrExpiryTime = null;
            
            if (lastDisconnect?.error) {
                const errorMsg = lastDisconnect.error.message;
                
                // ⭐ HANDLE SPECIFIC ERRORS
                if (errorMsg.includes('QR refs attempts ended')) {
                    addActivity("⚠️ QR timeout. Generating QR baru...");
                    console.log('QR timeout detected, will regenerate...');
                } else if (errorMsg.includes('Connection Closed')) {
                    addActivity("⚠️ Connection closed by server");
                } else {
                    addActivity(`❌ Connection error: ${errorMsg}`);
                }
            }
    
            if (shouldReconnect) {
                // ⭐ UNTUK QR TIMEOUT (408), RECONNECT CEPAT
                const isQRTimeout = statusCode === 408 || 
                                   lastDisconnect?.error?.message?.includes('QR refs');
                
                const delay = isQRTimeout ? 3000 : 
                             Math.min(3000 * Math.pow(1.5, Math.min(connectionAttempts, 5)), 30000);
                
                addActivity(`Reconnecting in ${delay / 1000} seconds...`);
                
                setTimeout(() => {
                    connectToWhatsApp();
                }, delay);
            } else {
                addActivity("🛑 Logged out. Silahkan hapus session dan scan QR baru.");
                connectionAttempts = 0;
            }
        } else if (connection === 'open') {
            isReady = true;
            qrCodeData = null;
            qrExpiryTime = null;
            connectionAttempts = 0;
            
            // Clear QR timeout
            if (qrRefreshInterval) {
                clearTimeout(qrRefreshInterval);
                qrRefreshInterval = null;
            }
            
            console.log('\n✅ CONNECTION ESTABLISHED ✅');
            console.log('Timestamp:', new Date().toISOString());
            console.log('Is New Login:', isNewLogin);
            console.log('============================\n');
            
            addActivity("✅ WhatsApp client berhasil terhubung!");
        }
    });

        // Save credentials when updated
        sock.ev.on('creds.update', saveCreds);

        // Messages update event (optional, untuk log pesan masuk)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.key.fromMe && msg.message) {
                addActivity(`📨 Pesan masuk dari: ${msg.key.remoteJid}`);
            }
        });

    } catch (error) {
        addActivity(`❌ Error initializing client: ${error.message}`);
        console.error('Init error:', error);
        
        // Retry setelah 5 detik
        setTimeout(() => {
            connectToWhatsApp();
        }, 5000);
    }
}

// Start client
connectToWhatsApp();

// ============================
// API ENDPOINTS
// ============================

// Status endpoint
app.get('/status', (req, res) => {
    const secondsRemaining = qrExpiryTime ? Math.max(0, Math.floor((qrExpiryTime - Date.now()) / 1000)) : 0;
    
    res.json({
        status: 'online',
        ready: isReady,
        qr_available: qrCodeData !== null,
        qr_expires_in: secondsRemaining,
        connection_attempts: connectionAttempts,
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's'
    });
});

// Info endpoint
app.get('/info', (req, res) => {
    const secondsRemaining = qrExpiryTime ? Math.max(0, Math.floor((qrExpiryTime - Date.now()) / 1000)) : 0;
    
    res.json({
        connected: isReady,
        qr_needed: qrCodeData !== null,
        qr_expires_in: secondsRemaining,
        connection_attempts: connectionAttempts,
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's',
        library: 'baileys',
        version: '2.0.0'
    });
});

// QR Code endpoint (text + image data URL)
app.get('/qr', async (req, res) => {
    if (qrCodeData) {
        try {
            const qrDataURL = await QRCode.toDataURL(qrCodeData);
            const secondsRemaining = qrExpiryTime ? Math.max(0, Math.floor((qrExpiryTime - Date.now()) / 1000)) : 0;
            
            res.json({
                success: true,
                qr: qrCodeData,
                qr_image: qrDataURL,
                expires_in: secondsRemaining,
                message: `QR code available. Expired dalam ${secondsRemaining} detik.`
            });
        } catch (error) {
            res.json({
                success: true,
                qr: qrCodeData,
                expires_in: 0,
                message: 'QR code available. Scan with WhatsApp.'
            });
        }
    } else if (isReady) {
        res.json({
            success: false,
            qr: null,
            expires_in: 0,
            message: 'Already authenticated. No QR code needed.'
        });
    } else {
        res.json({
            success: false,
            qr: null,
            expires_in: 0,
            message: 'QR code not ready yet. Please wait...',
            connection_attempts: connectionAttempts,
            hint: 'Bot is trying to connect. Check /activity for details.'
        });
    }
});

// QR Code endpoint (image PNG)
app.get('/qr-image', async (req, res) => {
    if (qrCodeData) {
        try {
            const qrImage = await QRCode.toBuffer(qrCodeData);
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': qrImage.length
            });
            res.end(qrImage);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Failed to generate QR image'
            });
        }
    } else if (isReady) {
        res.status(400).json({
            success: false,
            message: 'Already authenticated. No QR code needed.'
        });
    } else {
        res.status(400).json({
            success: false,
            message: 'QR code not ready yet.',
            connection_attempts: connectionAttempts,
            hint: 'Bot is trying to connect. Check /activity for details.'
        });
    }
});

// Uptime endpoint
app.get('/uptime', (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    
    res.json({
        uptime: `${hours}h ${minutes}m ${seconds}s`,
        uptime_seconds: uptimeSeconds
    });
});

// Send Message endpoint
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        addActivity("❌ Gagal kirim pesan: Phone atau message kosong");
        return res.status(400).json({
            success: false,
            message: 'Phone and message are required'
        });
    }

    if (!isReady) {
        addActivity("❌ Gagal kirim pesan: WhatsApp client belum siap");
        return res.status(503).json({
            success: false,
            message: 'WhatsApp client is not ready yet'
        });
    }

    try {
        // Format phone number untuk Baileys
        let jid = phone.replace(/[^0-9]/g, ''); // Hapus karakter non-numeric
        
        // Tambahkan @s.whatsapp.net kalau belum ada
        if (!jid.includes('@')) {
            jid = jid + '@s.whatsapp.net';
        }

        // Kirim pesan
        await sock.sendMessage(jid, { text: message });
        addActivity(`✅ Pesan dikirim ke ${jid}: "${message.substring(0, 50)}..."`);
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        addActivity(`❌ Error mengirim pesan ke ${phone}: ${error.message}`);
        console.error('Error sending message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send message: ' + error.message
        });
    }
});

// Recent Activity endpoint
app.get('/activity', (req, res) => {
    res.json({
        success: true,
        logs: activityLogs,
        total_logs: activityLogs.length,
        connection_attempts: connectionAttempts
    });
});

// Logout/Reset endpoint
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            isReady = false;
            qrCodeData = null;
            qrExpiryTime = null;
            connectionAttempts = 0;
            
            if (qrRefreshInterval) {
                clearInterval(qrRefreshInterval);
                qrRefreshInterval = null;
            }
            
            addActivity("🔓 Bot logged out successfully");
            
            // Reconnect setelah logout
            setTimeout(() => {
                connectToWhatsApp();
            }, 2000);
            
            res.json({
                success: true,
                message: 'Logged out successfully. Reconnecting...'
            });
        } else {
            res.status(400).json({
                success: false,
                message: 'No active connection'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Logout failed: ' + error.message
        });
    }
});

// Force reconnect endpoint
app.post('/reconnect', async (req, res) => {
    try {
        if (sock) {
            sock.end();
        }
        
        connectionAttempts = 0;
        isReady = false;
        qrCodeData = null;
        qrExpiryTime = null;
        
        if (qrRefreshInterval) {
            clearInterval(qrRefreshInterval);
            qrRefreshInterval = null;
        }
        
        addActivity("🔄 Force reconnect triggered");
        connectToWhatsApp();
        
        res.json({
            success: true,
            message: 'Reconnecting...'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Reconnect failed: ' + error.message
        });
    }
});

// ⭐ DELETE SESSION ENDPOINT
app.post('/delete-session', async (req, res) => {
    try {
        const authPath = path.join(__dirname, 'auth_info_baileys');
        
        // Close existing connection first
        if (sock) {
            try {
                sock.end();
            } catch (err) {
                console.error('Error ending socket:', err);
            }
        }
        
        if (qrRefreshInterval) {
            clearInterval(qrRefreshInterval);
            qrRefreshInterval = null;
        }
        
        if (fs.existsSync(authPath)) {
            // Hapus folder auth
            fs.rmSync(authPath, { recursive: true, force: true });
            addActivity('✅ Session folder deleted');
            
            // Reset variables
            qrCodeData = null;
            qrExpiryTime = null;
            isReady = false;
            connectionAttempts = 0;
            
            // Reconnect untuk generate QR baru
            setTimeout(() => {
                connectToWhatsApp();
            }, 1000);
            
            res.json({
                success: true,
                message: 'Session deleted. Reconnecting...'
            });
        } else {
            res.json({
                success: false,
                message: 'Session folder not found'
            });
        }
    } catch (error) {
        addActivity(`❌ Error deleting session: ${error.message}`);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Health check
app.get('/', (req, res) => {
    const secondsRemaining = qrExpiryTime ? Math.max(0, Math.floor((qrExpiryTime - Date.now()) / 1000)) : 0;
    
    res.json({
        service: 'WhatsApp Bot API',
        version: '2.0.0',
        library: 'Baileys',
        status: isReady ? 'connected' : 'disconnected',
        qr_available: qrCodeData !== null,
        qr_expires_in: secondsRemaining,
        connection_attempts: connectionAttempts,
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's',
        endpoints: {
            status: 'GET /status',
            info: 'GET /info',
            qr_code: 'GET /qr',
            qr_image: 'GET /qr-image',
            send_message: 'POST /send-message',
            activity: 'GET /activity',
            logout: 'POST /logout',
            reconnect: 'POST /reconnect',
            delete_session: 'POST /delete-session'
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n=======================================`);
    console.log(`WhatsApp Bot Server running on port ${PORT}`);
    console.log(`Baileys version - Lightweight & Cloud-friendly`);
    console.log(`=======================================\n`);
});






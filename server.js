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
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        browser: ['Laravel Bot', 'Chrome', '1.0.0']
    });

    // QR Code Event
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            addActivity("QR Code diterima, menunggu scan");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            addActivity(`Connection closed. Reconnecting: ${shouldReconnect}`);
            isReady = false;
            qrCodeData = null;

            if (shouldReconnect) {
                setTimeout(() => {
                    connectToWhatsApp();
                }, 3000);
            }
        } else if (connection === 'open') {
            isReady = true;
            qrCodeData = null;
            addActivity("WhatsApp client siap digunakan");
        }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
}

// Start client
connectToWhatsApp();

// ============================
// API ENDPOINTS
// ============================

// Status endpoint
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        ready: isReady,
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's'
    });
});

// Info endpoint
app.get('/info', (req, res) => {
    res.json({
        connected: isReady,
        qr_needed: qrCodeData !== null,
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's',
        library: 'baileys'
    });
});

// QR Code endpoint (text)
app.get('/qr', async (req, res) => {
    if (qrCodeData) {
        try {
            // Generate QR code as data URL
            const qrDataURL = await QRCode.toDataURL(qrCodeData);
            
            res.json({
                success: true,
                qr: qrCodeData,
                qr_image: qrDataURL,
                message: 'QR code available. Scan with WhatsApp.'
            });
        } catch (error) {
            res.json({
                success: true,
                qr: qrCodeData,
                message: 'QR code available. Scan with WhatsApp.'
            });
        }
    } else if (isReady) {
        res.json({
            success: false,
            qr: null,
            message: 'Already authenticated. No QR code needed.'
        });
    } else {
        res.json({
            success: false,
            qr: null,
            message: 'QR code not ready yet. Please wait...'
        });
    }
});

// QR Code endpoint (image)
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
            message: 'QR code not ready yet.'
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
        addActivity("Gagal kirim pesan: Phone atau message kosong");
        return res.status(400).json({
            success: false,
            message: 'Phone and message are required'
        });
    }

    if (!isReady) {
        addActivity("Gagal kirim pesan: WhatsApp client belum siap");
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
        addActivity(`Pesan dikirim ke ${jid}: "${message}"`);
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        addActivity(`Error mengirim pesan ke ${phone}: ${error.message}`);
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
        logs: activityLogs
    });
});

// Logout/Reset endpoint
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            isReady = false;
            qrCodeData = null;
            addActivity("Bot logged out successfully");
            
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

// Health check
app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp Bot API',
        version: '2.0.0',
        library: 'Baileys',
        status: isReady ? 'connected' : 'disconnected',
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's'
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addActivity(`WhatsApp Bot Server running on port ${PORT}`);
    console.log(`WhatsApp Bot Server running on port ${PORT}`);
    console.log(`Baileys version - Lightweight & Cloud-friendly`);
});

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const app = express();

app.use(express.json());

// ============================
// Global variables
// ============================
let client;
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
function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--no-default-browser-check'
            ]
        }
    });

    // QR Code Event
    client.on('qr', (qr) => {
        qrCodeData = qr;
        addActivity("QR Code diterima, menunggu scan");
        qrcode.generate(qr, { small: true });
    });

    // Ready Event
    client.on('ready', () => {
        isReady = true;
        qrCodeData = null;
        addActivity("WhatsApp client siap digunakan");
    });

    // Disconnected Event
    client.on('disconnected', (reason) => {
        isReady = false;
        qrCodeData = null;
        addActivity("Client disconnect: " + reason);
    });

    // Auth Failure Event
    client.on('auth_failure', (msg) => {
        qrCodeData = null;
        addActivity("Auth failure: " + msg);
    });

    client.initialize();
}

// Start client
initializeClient();

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
        uptime: Math.floor((Date.now() - startTime) / 1000) + 's'
    });
});

// QR Code endpoint
app.get('/qr', (req, res) => {
    if (qrCodeData) {
        res.json({
            success: true,
            qr: qrCodeData,
            message: 'QR code available. Scan with WhatsApp.'
        });
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
        addActivity("Gagal kirim pesan: Phone atau message kosong", "error");
        return res.status(400).json({
            success: false,
            message: 'Phone and message are required'
        });
    }

    if (!isReady) {
        addActivity("Gagal kirim pesan: WhatsApp client belum siap", "error");
        return res.status(503).json({
            success: false,
            message: 'WhatsApp client is not ready yet'
        });
    }

    try {
        const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        addActivity(`Pesan dikirim ke ${chatId}: "${message}"`, "success");
        
        res.json({
            success: true,
            message: 'Message sent successfully'
        });
    } catch (error) {
        addActivity(`Error mengirim pesan ke ${phone}: ${error.message}`, "error");
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addActivity(`WhatsApp Bot Server running on port ${PORT}`);
    console.log(`WhatsApp Bot Server running on port ${PORT}`);
});

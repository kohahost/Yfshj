const http = require('http');
const path = require('path');
const { Server: SocketIOServer } = require("socket.io");
const express = require('express');
const fs = require('fs');

const piBot = require('./run.js');
const walletDB = require('./wallet_db.js');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = './config.json';

let config = loadConfig();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

const originalLog = console.log;
console.log = function (...args) {
    originalLog.apply(console, args);
    const logMessage = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
    io.emit('log', logMessage);
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE);
            return {
                recipient: '', memo: 'Pi Transfer', fundingMnemonic: '', sponsorMnemonics: [],
                concurrentWorkers: 5, 
                fundingAmount: 0.0000401, // **TAMBAHAN: Nilai default**
                ...JSON.parse(data)
            };
        }
    } catch (error) { console.error("Gagal memuat config:", error); }
    return { recipient: '', memo: 'Pi Transfer', fundingMnemonic: '', sponsorMnemonics: [], concurrentWorkers: 5, fundingAmount: 0.0000401 };
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        piBot.updateConfig(config);
        console.log('[SYSTEM] Konfigurasi berhasil disimpan.');
    } catch (error) { console.error("Gagal menyimpan config:", error); }
}

piBot.setNotifier((message) => {
    console.log(`[NOTIF] ${message.replace(/[*`[\]()]/g, '')}`);
});
piBot.updateConfig(config);

setInterval(async () => {
    const status = piBot.getStatus();
    const summary = walletDB.getSummary();
    
    io.emit('status_update', {
        isRunning: status.isRunning,
        summary,
        sponsors: status.sponsors || [],
        wallets: walletDB.getAll()
    });
}, 2000);

app.post('/api/start', (req, res) => {
    if (piBot.startBot(config)) { res.json({ message: 'Bot berhasil dimulai.' }); } 
    else { res.status(400).json({ message: 'Bot sudah berjalan atau gagal memulai.' }); }
});

app.post('/api/stop', (req, res) => {
    if (piBot.stopBot()) { res.json({ message: 'Bot berhasil dihentikan.' }); } 
    else { res.status(400).json({ message: 'Bot sudah berhenti.' }); }
});

app.post('/api/add-mnemonics', async (req, res) => {
    const { mnemonics } = req.body;
    if (!Array.isArray(mnemonics) || mnemonics.length === 0) { return res.status(400).json({ message: 'Input mnemonics tidak valid.' }); }
    console.log(`[WEB] Menerima ${mnemonics.length} frasa untuk dijadwalkan...`);
    const results = await piBot.scheduleNewMnemonics(mnemonics);
    res.json({ message: `Proses penjadwalan selesai. Dijadwalkan: ${results.scheduled}, Pending: ${results.pending}, Invalid: ${results.invalid}, Duplikat: ${results.duplicates}` });
});

app.post('/api/clear-database', (req, res) => {
    fs.writeFileSync('./wallets.json', '[]');
    walletDB.load();
    res.json({ message: 'Semua data wallet target berhasil dihapus.' });
});

app.get('/api/get-config', (req, res) => { res.json(config); });

app.post('/api/save-config', (req, res) => {
    const newConfig = req.body;
    if (!newConfig.recipient || !newConfig.fundingMnemonic || !newConfig.sponsorMnemonics || newConfig.sponsorMnemonics.length === 0) {
        return res.status(400).json({ message: 'Recipient, Funder, dan minimal 1 Sponsor wajib diisi.' });
    }
    config = { ...config, ...newConfig };
    saveConfig();
    res.json({ message: 'Konfigurasi berhasil disimpan. Restart bot agar semua perubahan aktif.' });
});

app.get('/api/wallet-details', async (req, res) => {
    const { pubkey } = req.query;
    if (!pubkey) { return res.status(400).json({ message: "Public key diperlukan." }); }
    try {
        const wallet = walletDB.getAll().find(w => w.pubkey === pubkey);
        if (!wallet) { return res.status(404).json({ message: "Wallet tidak ditemukan di database." }); }
        const details = await piBot.getWalletDetails(wallet.mnemonic);
        res.json(details);
    } catch (error) {
        res.status(500).json({ message: error.message || "Gagal mengambil detail wallet dari jaringan." });
    }
});

// **API ENDPOINT BARU UNTUK FITUR "JALANKAN SEKARANG"**
app.post('/api/force-execute', async (req, res) => {
    const { mnemonic } = req.body;
    if (!mnemonic) {
        return res.status(400).json({ message: 'Mnemonic diperlukan.' });
    }
    try {
        const result = await piBot.forceExecuteWallet(mnemonic);
        res.json({ message: result });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Gagal menjalankan tugas.' });
    }
});

server.listen(PORT, () => {
    originalLog(`Dashboard berjalan di http://localhost:${PORT}`);
    originalLog('Menunggu koneksi dari browser...');
});

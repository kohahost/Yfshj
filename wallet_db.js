const fs = require('fs');
const DB_FILE = './wallets.json';

let wallets = [];

// STATUS: PENDING, SCHEDULED, AWAITING_EXECUTION, EXECUTING, SUCCESS, FAILED, INVALID, INACTIVE
function load() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            wallets = JSON.parse(data);
        } else { wallets = []; }
    } catch (e) { console.error("Gagal memuat DB wallet:", e); wallets = []; }
}

function save() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(wallets, null, 2));
    } catch (e) { console.error("Gagal menyimpan DB wallet:", e); }
}

function find(mnemonic) { return wallets.find(w => w.mnemonic === mnemonic); }

function addOrUpdate(walletData) {
    const index = wallets.findIndex(w => w.mnemonic === walletData.mnemonic);
    if (index > -1) {
        wallets[index] = { ...wallets[index], ...walletData };
    } else { wallets.push(walletData); }
    save();
}

function getByStatus(status) { return wallets.filter(w => w.status === status); }
function getAll() { return wallets; }

function getSummary() {
    const summary = {
        PENDING: 0, SCHEDULED: 0, AWAITING_EXECUTION: 0, EXECUTING: 0,
        SUCCESS: 0, FAILED: 0, INVALID: 0, INACTIVE: 0,
        TOTAL: wallets.length
    };
    wallets.forEach(w => { if (summary[w.status] !== undefined) { summary[w.status]++; } });
    return summary;
}

load();

module.exports = { load, save, find, addOrUpdate, getByStatus, getAll, getSummary };

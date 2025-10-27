const { Server, Keypair, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const walletDB = require('./wallet_db.js');

let sendNotification = () => {};

// Konfigurasi Jaringan
const PI_API_SERVERS = ['http://4.194.35.14:31401', 'http://4.194.35.14:31401'];
const PI_NETWORK_PASSPHRASE = 'Pi Network';
let serverRotation = 0;

function getPiServer() {
    const serverUrl = PI_API_SERVERS[serverRotation];
    serverRotation = (serverRotation + 1) % PI_API_SERVERS.length;
    return new Server(serverUrl, { allowHttp: true });
}

// State Internal Bot
let botState = {
    isRunning: false,
    mainInterval: null,
    fundingKeypair: null,
    sponsorPool: [],
};
let currentConfig = {};

function setNotifier(fn) { sendNotification = fn; }
function updateConfig(newConfig) { currentConfig = { ...newConfig }; }

async function getWalletFromMnemonic(mnemonic) {
    const seed = await bip39.mnemonicToSeed(mnemonic.trim());
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return Keypair.fromRawEd25519Seed(key);
}

function parsePiError(error) {
    if (error.response && error.response.data && error.response.data.extras) {
        const resultCodes = error.response.data.extras.result_codes;
        if (resultCodes) {
            if (resultCodes.transaction === 'tx_insufficient_balance') return 'KRITIS: Saldo Funder/Sponsor tidak cukup untuk biaya.';
            if (resultCodes.transaction === 'tx_bad_auth') return 'KRITIS: Mnemonic Funder/Sponsor salah.';
            if (resultCodes.operations && resultCodes.operations.length > 0) {
                const opCode = resultCodes.operations[0];
                if (opCode === 'op_underfunded') return 'KRITIS: Saldo Funder tidak cukup untuk mengirim modal.';
                return `Operasi gagal dengan kode: ${opCode}`;
            }
        }
    }
    return error.message || "Error tidak diketahui.";
}

// ===================================================================================
// SIKLUS UTAMA: FUND -> EXECUTE -> SWEEP (PER TASK)
// ===================================================================================

async function fundSponsorForTask(sponsor) {
    const server = getPiServer();
    const fundingAmount = (currentConfig.fundingAmount || 0.0000401).toFixed(7);
    const funderAccount = await server.loadAccount(botState.fundingKeypair.publicKey());
    
    let operation;
    try {
        await server.loadAccount(sponsor.pubkey);
        console.log(`[Funding] Mengirim modal ${fundingAmount} π ke sponsor ${sponsor.pubkey.substring(0, 6)}...`);
        operation = Operation.payment({ destination: sponsor.pubkey, asset: Asset.native(), amount: fundingAmount });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            console.log(`[Funding] Sponsor ${sponsor.pubkey.substring(0, 6)}... belum aktif. Membuat akun dengan modal ${fundingAmount} π...`);
            operation = Operation.createAccount({ destination: sponsor.pubkey, startingBalance: fundingAmount });
        } else { throw new Error(`Gagal memeriksa sponsor: ${parsePiError(e)}`); }
    }

    const tx = new TransactionBuilder(funderAccount, { fee: (await server.fetchBaseFee()).toString(), networkPassphrase: PI_NETWORK_PASSPHRASE })
        .addOperation(operation)
        .setTimeout(60).build();
    tx.sign(botState.fundingKeypair);
    await server.submitTransaction(tx);
    console.log(`[Funding] ✅ Sponsor ${sponsor.pubkey.substring(0, 6)}... berhasil diberi modal.`);
}

async function executeTransaction(wallet, sponsor) {
    console.log(`[Executor] ${sponsor.pubkey.substring(0, 6)}... -> ${wallet.pubkey.substring(0, 6)}...`);
    const server = getPiServer();
    const sponsorAccount = await server.loadAccount(sponsor.pubkey);
    const targetKeypair = await getWalletFromMnemonic(wallet.mnemonic);
    const targetAccount = await server.loadAccount(wallet.pubkey);
    
    const claimables = await server.claimableBalances().claimant(wallet.pubkey).limit(200).call();
    const unlockedClaimables = claimables.records.filter(r => !r.claimants[0].predicate.not || new Date(r.claimants[0].predicate.not.abs_before) <= new Date());
    
    const existingBalance = parseFloat(targetAccount.balances.find(b => b.asset_type === 'native')?.balance || '0');
    const totalFromClaims = unlockedClaimables.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    const amountToSend = existingBalance + totalFromClaims - 1.0;

    if (amountToSend <= 0.0000001) {
        throw new Error("Tidak ada saldo yang cukup untuk dikirim (setelah dikurangi 1 Pi cadangan).");
    }

    const estimatedFee = (await server.fetchBaseFee()) * (unlockedClaimables.length + 1);
    const txBuilder = new TransactionBuilder(sponsorAccount, { fee: estimatedFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE }).setTimeout(90);

    unlockedClaimables.forEach(cb => txBuilder.addOperation(Operation.claimClaimableBalance({ balanceId: cb.id, source: wallet.pubkey })));
    txBuilder.addOperation(Operation.payment({ destination: currentConfig.recipient, asset: Asset.native(), amount: amountToSend.toFixed(7), source: wallet.pubkey }));

    const tx = txBuilder.build();
    tx.sign(sponsor.keypair, targetKeypair);
    const res = await server.submitTransaction(tx);
    console.log(`[Executor] ✅ SUKSES ${wallet.pubkey.substring(0, 6)} hash: ${res.hash}`);
    return res.hash;
}

async function sweepSponsorFunds(sponsor) {
    try {
        const server = getPiServer();
        const sponsorAccount = await server.loadAccount(sponsor.pubkey);
        const sponsorBalance = parseFloat(sponsorAccount.balances.find(b => b.asset_type === 'native').balance);
        const baseFee = await server.fetchBaseFee();
        const amountToSweep = sponsorBalance - (baseFee / 1e7);

        if (amountToSweep > 0.0000001) {
            console.log(`[Sweep] Mengembalikan ${amountToSweep.toFixed(7)} π dari Sponsor ${sponsor.pubkey.substring(0, 6)}...`);
            const sweepTx = new TransactionBuilder(sponsorAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE })
                .addOperation(Operation.payment({ destination: botState.fundingKeypair.publicKey(), asset: Asset.native(), amount: amountToSweep.toFixed(7) }))
                .setTimeout(30).build();
            sweepTx.sign(sponsor.keypair);
            await server.submitTransaction(sweepTx);
            console.log(`[Sweep] ✅ Pengembalian dana berhasil.`);
        }
    } catch(e) {
        const errorMsg = parsePiError(e);
        console.error(`❌ [Sweep] GAGAL untuk Sponsor ${sponsor.pubkey.substring(0, 6)}: ${errorMsg}`);
        sendNotification(`⚠️ *SWEEP GAGAL* ⚠️\nSponsor: \`${sponsor.pubkey}\`\nDana mungkin tersangkut. Cek manual!`);
    }
}

async function executeFullWalletCycle(wallet, sponsor) {
    let finalStatus = 'FAILED', reason = 'Unknown error';
    walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'EXECUTING', sponsorPubkey: sponsor.pubkey });

    try {
        await fundSponsorForTask(sponsor);
        const txHash = await executeTransaction(wallet, sponsor);
        finalStatus = 'SUCCESS';
        reason = txHash;
    } catch (e) {
        reason = parsePiError(e);
        console.error(`❌ [System] SIKLUS GAGAL untuk ${wallet.pubkey.substring(0,6)}: ${reason}`);
        finalStatus = 'FAILED';
    } finally {
        await sweepSponsorFunds(sponsor);
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: finalStatus, reason: reason });
        sponsor.isBusy = false;
        console.log(`[System] Sponsor ${sponsor.pubkey.substring(0, 6)}... sekarang tersedia.`);
    }
}

async function startBot(config) {
    if (botState.isRunning) return false;
    console.log("Memulai bot...");
    updateConfig(config);

    try {
        botState.fundingKeypair = await getWalletFromMnemonic(currentConfig.fundingMnemonic);
        console.log(`Funder OK: ${botState.fundingKeypair.publicKey()}`);

        botState.sponsorPool = [];
        for (const mnemonic of currentConfig.sponsorMnemonics) {
            const keypair = await getWalletFromMnemonic(mnemonic);
            botState.sponsorPool.push({ keypair, pubkey: keypair.publicKey(), isBusy: false });
        }
        console.log(`Sponsor Pool OK: ${botState.sponsorPool.length} sponsor diinisialisasi.`);
    } catch (e) {
        console.error(`❌ GAGAL MEMULAI: Masalah Funder/Sponsor - ${e.message}`);
        return false;
    }
    
    botState.isRunning = true;
    botState.mainInterval = setInterval(mainLoop, 5000);
    
    console.log("[SYSTEM] Bot berhasil dimulai dengan model 'Per-Task Funding'.");
    return true;
}

function stopBot() {
    if (!botState.isRunning) return false;
    console.log("Menghentikan semua proses...");
    botState.isRunning = false;
    if(botState.mainInterval) clearInterval(botState.mainInterval);
    botState.mainInterval = null;
    return true;
}

function mainLoop() {
    runScheduler();
    processWalletQueue();
}

function runScheduler() {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    [...walletDB.getByStatus('SCHEDULED'), ...walletDB.getByStatus('PENDING')].forEach(wallet => {
        const unlockTime = wallet.unlockTime ? new Date(wallet.unlockTime) : now;
        if (unlockTime <= tenMinutesFromNow) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_EXECUTION' });
            console.log(`[Scheduler] Wallet ${wallet.pubkey.substring(0,6)}... dipindahkan ke antrian eksekusi.`);
        }
    });
}

function processWalletQueue() {
    const availableSponsors = botState.sponsorPool.filter(s => !s.isBusy);
    if (availableSponsors.length === 0) return;

    const walletsToProcess = walletDB.getByStatus('AWAITING_EXECUTION');
    if (walletsToProcess.length === 0) return;

    const tasksToStart = Math.min(walletsToProcess.length, availableSponsors.length);

    for (let i = 0; i < tasksToStart; i++) {
        const wallet = walletsToProcess[i];
        const sponsor = availableSponsors[i];
        
        console.log(`[Assigner] Menugaskan Sponsor ${sponsor.pubkey.substring(0,6)}... untuk Target ${wallet.pubkey.substring(0,6)}...`);
        sponsor.isBusy = true;
        
        executeFullWalletCycle(wallet, sponsor);
    }
}

async function forceExecuteWallet(mnemonic) {
    if (!botState.isRunning) { throw new Error("Bot tidak sedang berjalan."); }
    const wallet = walletDB.find(mnemonic);
    if (!wallet) { throw new Error("Wallet tidak ditemukan di database."); }
    const sponsor = botState.sponsorPool.find(s => !s.isBusy);
    if (!sponsor) { throw new Error("Tidak ada sponsor yang tersedia saat ini."); }

    console.log(`[FORCE EXECUTE] Memulai siklus lengkap untuk ${wallet.pubkey.substring(0, 6)}...`);
    
    sponsor.isBusy = true;
    try {
        await executeFullWalletCycle(wallet, sponsor);
        return `Proses eksekusi paksa untuk wallet ${wallet.pubkey.substring(0, 6)}... telah selesai.`;
    } catch (error) {
        sponsor.isBusy = false; 
        throw error;
    }
}

function getStatus() { return { isRunning: botState.isRunning, sponsors: botState.sponsorPool.map(s => ({ pubkey: s.pubkey, isBusy: s.isBusy })) }; }

async function getWalletDetails(mnemonic) { if (!bip39.validateMnemonic(mnemonic)) { throw new Error("Mnemonic tidak valid."); } const server = getPiServer(); try { const keypair = await getWalletFromMnemonic(mnemonic); const pubkey = keypair.publicKey(); let account, availableBalance = "0.0000000"; try { account = await server.loadAccount(pubkey); availableBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0'; } catch (e) { if (e.response && e.response.status === 404) { availableBalance = "0.0000000 (Belum Aktif)"; } else { throw e; } } const claimablesResponse = await server.claimableBalances().claimant(pubkey).limit(200).call(); let totalLocked = 0; const claimablesDetails = claimablesResponse.records.map(record => { const amount = parseFloat(record.amount); totalLocked += amount; let unlockDateWIB = "Segera tersedia"; if (record.claimants[0]?.predicate?.not?.abs_before) { const unlockDate = new Date(record.claimants[0].predicate.not.abs_before); const options = { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false }; unlockDateWIB = unlockDate.toLocaleString('id-ID', options).replace(/\./g, ':'); } return { amount: amount.toFixed(7), unlockDateWIB }; }); return { mnemonic, pubkey, availableBalance, totalLocked: totalLocked.toFixed(7), claimables: claimablesDetails }; } catch (error) { console.error(`Gagal mengambil detail untuk wallet: ${error.message}`); throw new Error(`Gagal terhubung ke jaringan Pi untuk mengambil detail.`); } }

async function scheduleNewMnemonics(mnemonics) { const stats = { scheduled: 0, pending: 0, invalid: 0, duplicates: 0 }; for (const mnemonic of mnemonics) { if (walletDB.find(mnemonic)) { stats.duplicates++; continue; } if (!bip39.validateMnemonic(mnemonic.trim())) { walletDB.addOrUpdate({ mnemonic, status: 'INVALID', reason: 'Format BIP39 salah' }); stats.invalid++; continue; } try { const keypair = await getWalletFromMnemonic(mnemonic); const pubkey = keypair.publicKey(); const server = getPiServer(); await server.loadAccount(pubkey); const claimables = await server.claimableBalances().claimant(pubkey).limit(200).call(); const now = new Date(); let nextUnlockTime = null; if (claimables.records.length > 0) { for (const r of claimables.records) { const claimant = r.claimants.find(c => c.destination === pubkey); const unlockTimestamp = claimant?.predicate?.not?.abs_before; if (unlockTimestamp) { const unlockDate = new Date(unlockTimestamp); if (unlockDate > now && (!nextUnlockTime || unlockDate < nextUnlockTime)) { nextUnlockTime = unlockDate; } } } } if (nextUnlockTime) { walletDB.addOrUpdate({ mnemonic, pubkey, status: 'SCHEDULED', unlockTime: nextUnlockTime.toISOString() }); stats.scheduled++; } else { walletDB.addOrUpdate({ mnemonic, pubkey, status: 'PENDING', reason: 'Tidak ada lockup mendatang' }); stats.pending++; } } catch (e) { walletDB.addOrUpdate({ mnemonic, status: e.response?.status === 404 ? 'INACTIVE' : 'INVALID', reason: e.message }); stats.invalid++; } } return stats; }

module.exports = { startBot, stopBot, getStatus, setNotifier, updateConfig, scheduleNewMnemonics, getWalletDetails, forceExecuteWallet };

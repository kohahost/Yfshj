// run.js (Just-in-Time Fleet Version)

const { Server, Keypair, TransactionBuilder, Operation, Asset, Memo } = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const walletDB = require('./wallet_db.js');

let sendNotification = () => {};
const PI_API_SERVERS = ['http://4.194.35.14:31401', 'http://113.161.1.223:31401'];
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const FUNDING_AMOUNT_FOR_TASK = 0.1000401; // Fee untuk claim + send + sweep + sedikit buffer

let serverRotation = 0;
function getPiServer() {
    const serverUrl = PI_API_SERVERS[serverRotation];
    serverRotation = (serverRotation + 1) % PI_API_SERVERS.length;
    return new Server(serverUrl, { allowHttp: true });
}

let botState = { 
    isRunning: false, 
    mainInterval: null,
    fundingKeypair: null,
    sponsorPool: [] // { keypair, pubkey, isBusy }
};
let currentConfig = {};

function setNotifier(fn) { sendNotification = fn; }
function updateConfig(newConfig) { currentConfig = { ...newConfig }; }

async function getWalletFromMnemonic(mnemonic) {
    const seed = await bip39.mnemonicToSeed(mnemonic.trim());
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return Keypair.fromRawEd25519Seed(key);
}

async function scheduleNewMnemonics(mnemonics) {
    const stats = { scheduled: 0, pending: 0, invalid: 0, duplicates: 0 };
    for (const mnemonic of mnemonics) {
        if (walletDB.find(mnemonic)) { stats.duplicates++; continue; }
        if (!bip39.validateMnemonic(mnemonic.trim())) { walletDB.addOrUpdate({ mnemonic, status: 'INVALID', reason: 'Format BIP39 salah' }); stats.invalid++; continue; }
        try {
            const keypair = await getWalletFromMnemonic(mnemonic);
            const pubkey = keypair.publicKey();
            const server = getPiServer();
            await server.loadAccount(pubkey);
            const claimables = await server.claimableBalances().claimant(pubkey).limit(200).call();
            const now = new Date();
            let nextUnlockTime = null;
            if (claimables.records.length > 0) {
                for (const r of claimables.records) {
                    const claimant = r.claimants.find(c => c.destination === pubkey);
                    const unlockTimestamp = claimant?.predicate?.not?.abs_before;
                    if (unlockTimestamp) {
                        const unlockDate = new Date(unlockTimestamp);
                        if (unlockDate > now && (!nextUnlockTime || unlockDate < nextUnlockTime)) { nextUnlockTime = unlockDate; }
                    }
                }
            }
            if (nextUnlockTime) { walletDB.addOrUpdate({ mnemonic, pubkey, status: 'SCHEDULED', unlockTime: nextUnlockTime.toISOString() }); stats.scheduled++; }
            else { walletDB.addOrUpdate({ mnemonic, pubkey, status: 'PENDING', reason: 'Tidak ada lockup mendatang' }); stats.pending++; }
        } catch (e) { walletDB.addOrUpdate({ mnemonic, status: e.response?.status === 404 ? 'INACTIVE' : 'INVALID', reason: e.message }); stats.invalid++; }
    }
    return stats;
}

function runScheduler() {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    [...walletDB.getByStatus('SCHEDULED'), ...walletDB.getByStatus('PENDING')].forEach(wallet => {
        const unlockTime = wallet.unlockTime ? new Date(wallet.unlockTime) : now;
        if (unlockTime <= tenMinutesFromNow) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_FUNDING' });
        }
    });
}

function runFunder() {
    const walletsToFund = walletDB.getByStatus('AWAITING_FUNDING');
    const availableSponsors = botState.sponsorPool.filter(s => !s.isBusy);
    const tasksToStart = Math.min(walletsToFund.length, availableSponsors.length);

    if (tasksToStart === 0) return;

    for (let i = 0; i < tasksToStart; i++) {
        const wallet = walletsToFund[i];
        const sponsor = availableSponsors[i];
        
        sponsor.isBusy = true;
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'FUNDING', sponsorPubkey: sponsor.pubkey });
        fundSponsorForTask(wallet, sponsor);
    }
}

async function fundSponsorForTask(wallet, sponsor) {
    console.log(`[Funder] -> Sponsor ${sponsor.pubkey.substring(0,6)}... untuk Target ${wallet.pubkey.substring(0,6)}...`);
    try {
        const server = getPiServer();
        const funderAccount = await server.loadAccount(botState.fundingKeypair.publicKey());
        
        const tx = new TransactionBuilder(funderAccount, { fee: "100", networkPassphrase: PI_NETWORK_PASSPHRASE })
            .addOperation(Operation.payment({
                destination: sponsor.pubkey,
                asset: Asset.native(),
                amount: FUNDING_AMOUNT_FOR_TASK.toFixed(7),
            }))
            .setTimeout(30).build();

        tx.sign(botState.fundingKeypair);
        await server.submitTransaction(tx);
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_EXECUTION' });
    } catch (e) {
        const reason = e.response?.data?.extras?.result_codes?.operations?.[0] || e.message || "Gagal mendanai sponsor";
        console.error(`[Funder] GAGAL: ${reason}`);
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'FAILED', reason });
        sponsor.isBusy = false;
    }
}

function runExecutor() {
    const walletsToExecute = walletDB.getByStatus('AWAITING_EXECUTION');
    const now = new Date();
    const readyWallets = walletsToExecute.filter(w => !w.unlockTime || new Date(w.unlockTime) <= now);
    
    if (readyWallets.length === 0) return;
    
    for (const wallet of readyWallets) {
        const sponsor = botState.sponsorPool.find(s => s.pubkey === wallet.sponsorPubkey);
        if (sponsor && sponsor.isBusy) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'EXECUTING' });
            executeAndSweepTransaction(wallet, sponsor);
        }
    }
}

async function executeAndSweepTransaction(wallet, sponsor) {
    const server = getPiServer();
    let finalStatus = 'FAILED';
    let reason = 'Unknown error';

    try {
        console.log(`[Executor] ${sponsor.pubkey.substring(0,6)}... -> ${wallet.pubkey.substring(0,6)}...`);
        const targetKeypair = await getWalletFromMnemonic(wallet.mnemonic);
        const sponsorAccount = await server.loadAccount(sponsor.pubkey);
        const targetAccount = await server.loadAccount(wallet.pubkey);
        
        const claimables = await server.claimableBalances().claimant(wallet.pubkey).limit(200).call();
        const unlockedClaimables = claimables.records.filter(r => !r.claimants[0].predicate.not || new Date(r.claimants[0].predicate.not.abs_before) <= new Date());
        
        const existingBalance = parseFloat(targetAccount.balances.find(b => b.asset_type === 'native')?.balance || '0');
        const totalFromClaims = unlockedClaimables.reduce((sum, r) => sum + parseFloat(r.amount), 0);
        const amountToSend = existingBalance + totalFromClaims;

        if (unlockedClaimables.length === 0 && amountToSend <= 1) { throw new Error("Tidak ada koin untuk diklaim/dikirim."); }

        const txBuilder = new TransactionBuilder(sponsorAccount, { fee: "100", networkPassphrase: PI_NETWORK_PASSPHRASE }).setTimeout(60);

        unlockedClaimables.forEach(cb => txBuilder.addOperation(Operation.claimClaimableBalance({ balanceId: cb.id, source: wallet.pubkey })));
        if (amountToSend > 0.0000001) {
            txBuilder.addOperation(Operation.payment({ destination: currentConfig.recipient, asset: Asset.native(), amount: amountToSend.toFixed(7), source: wallet.pubkey }));
        }
        
        const tx = txBuilder.build();
        tx.sign(sponsor.keypair, targetKeypair);
        const res = await server.submitTransaction(tx);
        finalStatus = 'SUCCESS';
        reason = res.hash;
    } catch (e) {
        reason = e.response?.data?.extras?.result_codes?.operations?.[0] || e.message || "Eksekusi gagal";
        console.error(`[Executor] GAGAL ${wallet.pubkey.substring(0,6)}: ${reason}`);
    }

    try {
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'SWEEPING' });
        const sponsorAccountForSweep = await server.loadAccount(sponsor.pubkey);
        const sponsorBalance = parseFloat(sponsorAccountForSweep.balances.find(b => b.asset_type === 'native').balance);
        const sweepFee = 0.00001;
        const amountToSweep = sponsorBalance - sweepFee;

        if (amountToSweep > 0.0000001) {
            const sweepTx = new TransactionBuilder(sponsorAccountForSweep, { fee: "100", networkPassphrase: PI_NETWORK_PASSPHRASE })
                .addOperation(Operation.payment({ destination: botState.fundingKeypair.publicKey(), asset: Asset.native(), amount: amountToSweep.toFixed(7) }))
                .setTimeout(30).build();
            sweepTx.sign(sponsor.keypair);
            await server.submitTransaction(sweepTx);
        }
    } catch(e) {
        console.error(`[Sweep] GAGAL untuk Sponsor ${sponsor.pubkey.substring(0,6)}: ${e.message}`);
        sendNotification(`⚠️ *SWEEP GAGAL* ⚠️\nSponsor: \`${sponsor.pubkey}\`\nDana mungkin tersangkut. Cek manual!`);
    } finally {
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: finalStatus, reason: reason });
        sponsor.isBusy = false;
        console.log(`[System] Sponsor ${sponsor.pubkey.substring(0,6)}... sekarang tersedia.`);
    }
}

function mainLoop() {
    if (botState.sponsorPool.filter(s => s.isBusy).length >= currentConfig.concurrentWorkers) {
        // Jika semua worker sibuk, hanya jalankan scheduler & executor
        runScheduler();
        runExecutor();
    } else {
        // Jika ada worker tersedia, jalankan semua
        runScheduler();
        runFunder();
        runExecutor();
    }
}

async function startBot(config) {
    if (botState.isRunning) return false;
    console.log("Memulai bot mode 'Just-in-Time Fleet'...");
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
    botState.mainInterval = setInterval(mainLoop, 3000);
    return true;
}

function stopBot() {
    if (!botState.isRunning) return false;
    console.log("Menghentikan semua proses...");
    botState.isRunning = false;
    clearInterval(botState.mainInterval);
    botState.mainInterval = null;
    return true;
}

function getStatus() { 
    return { 
        isRunning: botState.isRunning,
        sponsors: botState.sponsorPool.map(s => ({ pubkey: s.pubkey, isBusy: s.isBusy }))
    };
}

module.exports = { startBot, stopBot, getStatus, setNotifier, updateConfig, scheduleNewMnemonics };

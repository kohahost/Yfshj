const { Server, Keypair, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const walletDB = require('./wallet_db.js');

let sendNotification = () => {};
const PI_API_SERVERS = ['http://4.194.35.14:31401', 'http://113.161.1.223:31401'];
const PI_NETWORK_PASSPHRASE = 'Pi Network';

let serverRotation = 0;
function getPiServer() {
    const serverUrl = PI_API_SERVERS[serverRotation];
    serverRotation = (serverRotation + 1) % PI_API_SERVERS.length;
    return new Server(serverUrl, { allowHttp: true });
}

let botState = { isRunning: false, mainInterval: null, fundingKeypair: null, sponsorPool: [] };
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
            if (resultCodes.transaction === 'tx_insufficient_balance') return 'KRITIS: Saldo Funder tidak cukup untuk membayar biaya transaksi. Harap isi saldo Funder Anda.';
            if (resultCodes.transaction === 'tx_insufficient_fee') return 'Biaya (Fee) yang ditawarkan terlalu rendah untuk kondisi jaringan saat ini.';
            if (resultCodes.transaction === 'tx_bad_auth') return 'KRITIS: Otentikasi gagal. Kemungkinan Mnemonic Funder salah.';
            if (resultCodes.operations && resultCodes.operations.length > 0) {
                const opCode = resultCodes.operations[0];
                switch (opCode) {
                    case 'op_underfunded': return 'KRITIS: Saldo Funder tidak cukup untuk mengirim jumlah yang ditentukan. Harap isi saldo Funder Anda.';
                    case 'op_no_destination': return 'Akun tujuan (Sponsor) belum aktif dan gagal dibuat.';
                    default: return `Operasi gagal dengan kode: ${opCode}`;
                }
            }
        }
    }
    return error.message || "Terjadi error yang tidak diketahui.";
}

// **FUNGSI YANG HILANG DIKEMBALIKAN DI SINI**
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


async function preFundAllSponsors() {
    console.log('[Pre-Funding] Memeriksa dan mendanai semua sponsor...');
    const server = getPiServer();
    const fundingAmount = currentConfig.fundingAmount || 0.0000401;

    try {
        const funderAccount = await server.loadAccount(botState.fundingKeypair.publicKey());
        const baseFee = await server.fetchBaseFee();
        console.log(`[Network] Base fee saat ini: ${baseFee} stroops.`);

        const txBuilder = new TransactionBuilder(funderAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE });
        let operationsCount = 0;

        for (const sponsor of botState.sponsorPool) {
            try {
                const sponsorAccount = await server.loadAccount(sponsor.pubkey);
                const currentBalance = parseFloat(sponsorAccount.balances.find(b => b.asset_type === 'native')?.balance || '0');
                if (currentBalance < fundingAmount) {
                    const amountToTopUp = fundingAmount - currentBalance;
                    console.log(`[Pre-Funding] Sponsor ${sponsor.pubkey.substring(0,6)}... perlu di-top up sebesar ${amountToTopUp.toFixed(7)} π.`);
                    txBuilder.addOperation(Operation.payment({ destination: sponsor.pubkey, asset: Asset.native(), amount: amountToTopUp.toFixed(7) }));
                    operationsCount++;
                }
            } catch (e) {
                if (e.response && e.response.status === 404) {
                    console.log(`[Pre-Funding] Sponsor ${sponsor.pubkey.substring(0,6)}... perlu diaktifkan.`);
                    txBuilder.addOperation(Operation.createAccount({ destination: sponsor.pubkey, startingBalance: fundingAmount.toFixed(7) }));
                    operationsCount++;
                } else { throw e; }
            }
        }

        if (operationsCount > 0) {
            console.log(`[Pre-Funding] Membangun transaksi untuk mendanai ${operationsCount} sponsor...`);
            const tx = txBuilder.setTimeout(60).build();
            tx.sign(botState.fundingKeypair);
            await server.submitTransaction(tx);
            console.log(`[Pre-Funding] ✅ Berhasil mendanai ${operationsCount} sponsor.`);
        } else {
            console.log('[Pre-Funding] ✅ Semua sponsor sudah memiliki dana yang cukup.');
        }
        return true;
    } catch (e) {
        const reason = parsePiError(e);
        console.error(`❌ [Pre-Funding] GAGAL TOTAL: ${reason}`);
        console.error("DETAIL ERROR DARI PI SERVER:", JSON.stringify(e.response?.data, null, 2));
        return false;
    }
}

async function startBot(config) {
    if (botState.isRunning) return false;
    console.log("Memulai bot mode 'Pre-Funding Fleet'...");
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

        const fundingSuccess = await preFundAllSponsors();
        if (!fundingSuccess) {
            console.error("Gagal melakukan pendanaan awal untuk sponsor. Bot tidak dapat dimulai.");
            return false;
        }

    } catch (e) {
        console.error(`❌ GAGAL MEMULAI: Masalah Funder/Sponsor - ${e.message}`);
        return false;
    }
    botState.isRunning = true;
    botState.mainInterval = setInterval(mainLoop, 3000);
    return true;
}

function assignTasksToSponsors() {
    const walletsToProcess = walletDB.getByStatus('AWAITING_FUNDING');
    if (walletsToProcess.length === 0) return;
    const availableSponsors = botState.sponsorPool.filter(s => !s.isBusy);
    if (availableSponsors.length === 0) return;
    const tasksToStart = Math.min(walletsToProcess.length, availableSponsors.length);
    for (let i = 0; i < tasksToStart; i++) {
        const wallet = walletsToProcess[i];
        const sponsor = availableSponsors[i];
        console.log(`[Assigner] Menugaskan Sponsor ${sponsor.pubkey.substring(0,6)}... untuk Target ${wallet.pubkey.substring(0,6)}...`);
        sponsor.isBusy = true;
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_EXECUTION', sponsorPubkey: sponsor.pubkey });
    }
}

async function executeAndSweepTransaction(wallet, sponsor) {
    const server = getPiServer();
    let finalStatus = 'FAILED', reason = 'Unknown error';
    try {
        console.log(`[Executor] ${sponsor.pubkey.substring(0,6)}... -> ${wallet.pubkey.substring(0,6)}...`);
        const sponsorAccount = await server.loadAccount(sponsor.pubkey);
        const baseFee = await server.fetchBaseFee();

        const targetKeypair = await getWalletFromMnemonic(wallet.mnemonic);
        const targetAccount = await server.loadAccount(wallet.pubkey);
        const claimables = await server.claimableBalances().claimant(wallet.pubkey).limit(200).call();
        const unlockedClaimables = claimables.records.filter(r => !r.claimants[0].predicate.not || new Date(r.claimants[0].predicate.not.abs_before) <= new Date());
        const existingBalance = parseFloat(targetAccount.balances.find(b => b.asset_type === 'native')?.balance || '0');
        const totalFromClaims = unlockedClaimables.reduce((sum, r) => sum + parseFloat(r.amount), 0);
        const amountToSend = existingBalance + totalFromClaims;
        if (unlockedClaimables.length === 0 && amountToSend <= 1) { throw new Error("Tidak ada koin untuk diklaim/dikirim."); }

        const txBuilder = new TransactionBuilder(sponsorAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE }).setTimeout(60);
        unlockedClaimables.forEach(cb => txBuilder.addOperation(Operation.claimClaimableBalance({ balanceId: cb.id, source: wallet.pubkey })));
        if (amountToSend > 0.0000001) { txBuilder.addOperation(Operation.payment({ destination: currentConfig.recipient, asset: Asset.native(), amount: amountToSend.toFixed(7), source: wallet.pubkey })); }

        const tx = txBuilder.build();
        tx.sign(sponsor.keypair, targetKeypair);
        const res = await server.submitTransaction(tx);
        finalStatus = 'SUCCESS'; reason = res.hash;
    } catch (e) {
        reason = parsePiError(e) || "Eksekusi gagal";
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
        console.error(`[Sweep] GAGAL untuk Sponsor ${sponsor.pubkey.substring(0,6)}: ${parsePiError(e)}`);
        sendNotification(`⚠️ *SWEEP GAGAL* ⚠️\nSponsor: \`${sponsor.pubkey}\`\nDana mungkin tersangkut. Cek manual!`);
    } finally {
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: finalStatus, reason: reason });
        sponsor.isBusy = false;
        console.log(`[System] Sponsor ${sponsor.pubkey.substring(0,6)}... sekarang tersedia.`);
    }
}

async function forceExecuteWallet(mnemonic) {
    if (!botState.isRunning) { throw new Error("Bot tidak sedang berjalan. Harap start bot terlebih dahulu."); }
    const wallet = walletDB.find(mnemonic);
    if (!wallet) { throw new Error("Wallet dengan mnemonic tersebut tidak ditemukan di database."); }
    const sponsor = botState.sponsorPool.find(s => !s.isBusy);
    if (!sponsor) { throw new Error("Tidak ada sponsor yang tersedia saat ini. Coba lagi nanti."); }
    console.log(`[FORCE EXECUTE] Memulai proses untuk wallet ${wallet.pubkey.substring(0, 6)}... menggunakan sponsor ${sponsor.pubkey.substring(0, 6)}...`);
    sponsor.isBusy = true;
    try {
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_EXECUTION', sponsorPubkey: sponsor.pubkey });
        await executeAndSweepTransaction(wallet, sponsor);
        return `Proses eksekusi paksa untuk wallet ${wallet.pubkey.substring(0, 6)}... telah selesai.`;
    } catch (error) {
        const errorMessage = error.message || "Error tidak diketahui saat eksekusi paksa.";
        console.error(`[FORCE EXECUTE] GAGAL: ${errorMessage}`);
        if (walletDB.find(mnemonic)) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'FAILED', reason: `Force Execute Error: ${errorMessage}` });
        }
        sponsor.isBusy = false;
        throw error;
    }
}

function mainLoop() {
    assignTasksToSponsors();
    runScheduler();
    runExecutor();
}
function runScheduler() {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    [...walletDB.getByStatus('SCHEDULED'), ...walletDB.getByStatus('PENDING')].forEach(wallet => {
        const unlockTime = wallet.unlockTime ? new Date(wallet.unlockTime) : now;
        if (unlockTime <= tenMinutesFromNow) { walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_FUNDING' }); }
    });
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
function stopBot() {
    if (!botState.isRunning) return false;
    console.log("Menghentikan semua proses...");
    botState.isRunning = false;
    if(botState.mainInterval) clearInterval(botState.mainInterval);
    botState.mainInterval = null;
    return true;
}
function getStatus() { return { isRunning: botState.isRunning, sponsors: botState.sponsorPool.map(s => ({ pubkey: s.pubkey, isBusy: s.isBusy })) }; }
async function getWalletDetails(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) { throw new Error("Mnemonic tidak valid."); }
    const server = getPiServer();
    try {
        const keypair = await getWalletFromMnemonic(mnemonic);
        const pubkey = keypair.publicKey();
        let account, availableBalance = "0.0000000";
        try {
            account = await server.loadAccount(pubkey);
            availableBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0';
        } catch (e) {
            if (e.response && e.response.status === 404) { throw new Error("Akun tidak ditemukan atau belum aktif di mainnet."); }
            throw e;
        }
        const claimablesResponse = await server.claimableBalances().claimant(pubkey).limit(200).call();
        let totalLocked = 0;
        const claimablesDetails = claimablesResponse.records.map(record => {
            const amount = parseFloat(record.amount);
            totalLocked += amount;
            let unlockDateWIB = "Segera tersedia";
            if (record.claimants[0]?.predicate?.not?.abs_before) {
                const unlockDate = new Date(record.claimants[0].predicate.not.abs_before);
                const options = { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true };
                unlockDateWIB = unlockDate.toLocaleString('id-ID', options).replace(/\./g, ':');
            }
            return { amount: amount.toFixed(2), unlockDateWIB };
        });
        return { mnemonic, pubkey, availableBalance, totalLocked: totalLocked.toFixed(7), claimables: claimablesDetails };
    } catch (error) {
        console.error(`Gagal mengambil detail untuk wallet: ${error.message}`);
        throw error;
    }
}

module.exports = { startBot, stopBot, getStatus, setNotifier, updateConfig, scheduleNewMnemonics, getWalletDetails, forceExecuteWallet };

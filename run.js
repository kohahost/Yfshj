const { Server, Keypair, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const walletDB = require('./wallet_db.js');

let sendNotification = () => {};

// Konfigurasi Jaringan
const PI_API_SERVERS = ['http://4.194.35.14:31401', 'http://113.161.1.223:31401'];
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
    lastSponsorCheck: 0, // Timestamp untuk self-funding check
};
let currentConfig = {};

function setNotifier(fn) {
    sendNotification = fn;
}

function updateConfig(newConfig) {
    currentConfig = { ...newConfig };
}

async function getWalletFromMnemonic(mnemonic) {
    const seed = await bip39.mnemonicToSeed(mnemonic.trim());
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return Keypair.fromRawEd25519Seed(key);
}

function parsePiError(error) {
    if (error.response && error.response.data && error.response.data.extras) {
        const resultCodes = error.response.data.extras.result_codes;
        if (resultCodes) {
            if (resultCodes.transaction === 'tx_insufficient_balance') return 'KRITIS: Saldo Funder/Sponsor tidak cukup untuk membayar biaya transaksi.';
            if (resultCodes.transaction === 'tx_insufficient_fee') return 'Biaya (Fee) terlalu rendah untuk kondisi jaringan saat ini.';
            if (resultCodes.transaction === 'tx_bad_auth') return 'KRITIS: Otentikasi gagal. Mnemonic Funder/Sponsor kemungkinan salah.';
            if (resultCodes.operations && resultCodes.operations.length > 0) {
                const opCode = resultCodes.operations[0];
                switch (opCode) {
                    case 'op_underfunded': return 'KRITIS: Saldo Funder tidak cukup untuk mengirim/membuat akun Sponsor.';
                    case 'op_no_destination': return 'Akun tujuan belum aktif dan gagal dibuat.';
                    default: return `Operasi gagal dengan kode: ${opCode}`;
                }
            }
        }
    }
    return error.message || "Terjadi error yang tidak diketahui.";
}

async function scheduleNewMnemonics(mnemonics) {
    const stats = { scheduled: 0, pending: 0, invalid: 0, duplicates: 0 };
    for (const mnemonic of mnemonics) {
        if (walletDB.find(mnemonic)) {
            stats.duplicates++;
            continue;
        }
        if (!bip39.validateMnemonic(mnemonic.trim())) {
            walletDB.addOrUpdate({ mnemonic, status: 'INVALID', reason: 'Format BIP39 salah' });
            stats.invalid++;
            continue;
        }
        try {
            const keypair = await getWalletFromMnemonic(mnemonic);
            const pubkey = keypair.publicKey();
            const server = getPiServer();
            await server.loadAccount(pubkey); // Cek apakah akun aktif
            const claimables = await server.claimableBalances().claimant(pubkey).limit(200).call();
            const now = new Date();
            let nextUnlockTime = null;
            if (claimables.records.length > 0) {
                for (const r of claimables.records) {
                    const claimant = r.claimants.find(c => c.destination === pubkey);
                    const unlockTimestamp = claimant?.predicate?.not?.abs_before;
                    if (unlockTimestamp) {
                        const unlockDate = new Date(unlockTimestamp);
                        if (unlockDate > now && (!nextUnlockTime || unlockDate < nextUnlockTime)) {
                            nextUnlockTime = unlockDate;
                        }
                    }
                }
            }
            if (nextUnlockTime) {
                walletDB.addOrUpdate({ mnemonic, pubkey, status: 'SCHEDULED', unlockTime: nextUnlockTime.toISOString() });
                stats.scheduled++;
            } else {
                walletDB.addOrUpdate({ mnemonic, pubkey, status: 'PENDING', reason: 'Tidak ada lockup mendatang' });
                stats.pending++;
            }
        } catch (e) {
            walletDB.addOrUpdate({ mnemonic, status: e.response?.status === 404 ? 'INACTIVE' : 'INVALID', reason: e.message });
            stats.invalid++;
        }
    }
    return stats;
}

/**
 * **FUNGSI BARU & PENTING**
 * Memeriksa saldo satu sponsor dan mengisinya jika kurang dari jumlah yang ditentukan.
 * Juga menangani pembuatan akun jika sponsor belum aktif.
 */
async function checkAndFundSponsor(sponsor) {
    const server = getPiServer();
    const requiredAmount = currentConfig.fundingAmount || 0.0000401;

    try {
        const sponsorAccount = await server.loadAccount(sponsor.pubkey);
        const currentBalance = parseFloat(sponsorAccount.balances.find(b => b.asset_type === 'native')?.balance || '0');

        if (currentBalance < requiredAmount) {
            const amountToTopUp = (requiredAmount - currentBalance).toFixed(7);
            console.log(`[Self-Funding] Mengisi ulang Sponsor ${sponsor.pubkey.substring(0,6)}... sebesar ${amountToTopUp} π.`);
            const funderAccount = await server.loadAccount(botState.fundingKeypair.publicKey());
            const baseFee = await server.fetchBaseFee();
            const tx = new TransactionBuilder(funderAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRSE })
                .addOperation(Operation.payment({
                    destination: sponsor.pubkey,
                    asset: Asset.native(),
                    amount: amountToTopUp
                }))
                .setTimeout(60).build();
            tx.sign(botState.fundingKeypair);
            await server.submitTransaction(tx);
            console.log(`[Self-Funding] ✅ Sponsor ${sponsor.pubkey.substring(0,6)}... berhasil diisi ulang.`);
        }
    } catch (e) {
        if (e.response && e.response.status === 404) {
            // Jika sponsor belum aktif, buat akunnya
            console.log(`[Self-Funding] Sponsor ${sponsor.pubkey.substring(0,6)}... belum aktif. Membuat akun...`);
            try {
                const funderAccount = await server.loadAccount(botState.fundingKeypair.publicKey());
                const baseFee = await server.fetchBaseFee();
                const tx = new TransactionBuilder(funderAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRSE })
                    .addOperation(Operation.createAccount({
                        destination: sponsor.pubkey,
                        startingBalance: requiredAmount.toFixed(7)
                    }))
                    .setTimeout(60).build();
                tx.sign(botState.fundingKeypair);
                await server.submitTransaction(tx);
                console.log(`[Self-Funding] ✅ Sponsor ${sponsor.pubkey.substring(0,6)}... berhasil dibuat dan didanai.`);
            } catch (creationError) {
                console.error(`❌ [Self-Funding] GAGAL membuat akun sponsor ${sponsor.pubkey.substring(0,6)}: ${parsePiError(creationError)}`);
            }
        } else {
            console.error(`❌ [Self-Funding] GAGAL memeriksa sponsor ${sponsor.pubkey.substring(0,6)}: ${parsePiError(e)}`);
        }
    }
}


async function preFundAllSponsors() {
    console.log('[Pre-Funding] Memeriksa dan mendanai semua sponsor...');
    const fundingPromises = botState.sponsorPool.map(sponsor => checkAndFundSponsor(sponsor));
    await Promise.all(fundingPromises);
    console.log('[Pre-Funding] ✅ Proses pemeriksaan dana sponsor selesai.');
    return true; // Asumsikan sukses, error individu sudah dicatat
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

        const fundingSuccess = await preFundAllSponsors();
        if (!fundingSuccess) {
            console.error("Gagal melakukan pendanaan awal. Bot tidak dapat dimulai.");
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
        // --- TAHAP 1: EKSEKUSI UTAMA (CLAIM & SEND) ---
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

        if (unlockedClaimables.length === 0 && amountToSend <= 1) { // 1 Pi adalah cadangan minimum
            throw new Error("Tidak ada koin untuk diklaim/dikirim.");
        }

        const txBuilder = new TransactionBuilder(sponsorAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRSE }).setTimeout(60);

        // Tambahkan operasi claim untuk setiap koin yang bisa di-claim
        unlockedClaimables.forEach(cb => txBuilder.addOperation(Operation.claimClaimableBalance({ balanceId: cb.id, source: wallet.pubkey })));

        // Tambahkan operasi pengiriman seluruh saldo dari wallet target
        if (amountToSend > 0.0000001) {
            txBuilder.addOperation(Operation.payment({
                destination: currentConfig.recipient,
                asset: Asset.native(),
                amount: amountToSend.toFixed(7),
                source: wallet.pubkey // Penting: sumbernya adalah wallet target
            }));
        }

        const tx = txBuilder.build();
        // Tandatangani dengan KEDUA kunci: Sponsor (pembayar fee) dan Target (pemilik operasi)
        tx.sign(sponsor.keypair, targetKeypair);

        const res = await server.submitTransaction(tx);
        finalStatus = 'SUCCESS';
        reason = res.hash;
        console.log(`[Executor] ✅ SUKSES ${wallet.pubkey.substring(0,6)} hash: ${res.hash}`);

    } catch (e) {
        reason = parsePiError(e);
        console.error(`❌ [Executor] GAGAL ${wallet.pubkey.substring(0,6)}: ${reason}`);
        finalStatus = 'FAILED';
    } finally {
        // --- TAHAP 2: SWEEP SISA DANA DARI SPONSOR (Selalu dijalankan) ---
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'SWEEPING' });
        try {
            const sponsorAccountForSweep = await server.loadAccount(sponsor.pubkey);
            const sponsorBalance = parseFloat(sponsorAccountForSweep.balances.find(b => b.asset_type === 'native').balance);
            
            // **PERBAIKAN:** Gunakan base fee dinamis untuk sweep
            const sweepFee = (await server.fetchBaseFee()) / 1e7; // konversi dari stroops ke Pi
            const amountToSweep = sponsorBalance - sweepFee;

            if (amountToSweep > 0.0000001) {
                console.log(`[Sweep] Mengembalikan ${amountToSweep.toFixed(7)} π dari Sponsor ${sponsor.pubkey.substring(0,6)}...`);
                const sweepTx = new TransactionBuilder(sponsorAccountForSweep, { fee: (sweepFee * 1e7).toString(), networkPassphrase: PI_NETWORK_PASSPHRSE })
                    .addOperation(Operation.payment({
                        destination: botState.fundingKeypair.publicKey(),
                        asset: Asset.native(),
                        amount: amountToSweep.toFixed(7)
                    }))
                    .setTimeout(30).build();
                sweepTx.sign(sponsor.keypair);
                await server.submitTransaction(sweepTx);
                console.log(`[Sweep] ✅ Pengembalian dana dari Sponsor ${sponsor.pubkey.substring(0,6)}... berhasil.`);
            }
        } catch(e) {
            console.error(`❌ [Sweep] GAGAL untuk Sponsor ${sponsor.pubkey.substring(0,6)}: ${parsePiError(e)}`);
            sendNotification(`⚠️ *SWEEP GAGAL* ⚠️\nSponsor: \`${sponsor.pubkey}\`\nDana mungkin tersangkut. Cek manual!`);
        } finally {
            // --- TAHAP 3: FINALISASI ---
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: finalStatus, reason: reason });
            sponsor.isBusy = false;
            console.log(`[System] Sponsor ${sponsor.pubkey.substring(0,6)}... sekarang tersedia.`);
        }
    }
}


async function forceExecuteWallet(mnemonic) {
    if (!botState.isRunning) {
        throw new Error("Bot tidak sedang berjalan. Harap start bot terlebih dahulu.");
    }
    const wallet = walletDB.find(mnemonic);
    if (!wallet) {
        throw new Error("Wallet dengan mnemonic tersebut tidak ditemukan di database.");
    }
    const sponsor = botState.sponsorPool.find(s => !s.isBusy);
    if (!sponsor) {
        throw new Error("Tidak ada sponsor yang tersedia saat ini. Coba lagi nanti.");
    }
    console.log(`[FORCE EXECUTE] Memulai proses untuk wallet ${wallet.pubkey.substring(0, 6)}... menggunakan sponsor ${sponsor.pubkey.substring(0, 6)}...`);
    
    sponsor.isBusy = true;
    try {
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_EXECUTION', sponsorPubkey: sponsor.pubkey });
        // Langsung eksekusi tanpa menunggu loop utama
        await executeAndSweepTransaction(wallet, sponsor);
        return `Proses eksekusi paksa untuk wallet ${wallet.pubkey.substring(0, 6)}... telah selesai.`;
    } catch (error) {
        const errorMessage = error.message || "Error tidak diketahui saat eksekusi paksa.";
        console.error(`[FORCE EXECUTE] GAGAL: ${errorMessage}`);
        // Pastikan status direset jika terjadi error tak terduga
        if (walletDB.find(mnemonic)) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'FAILED', reason: `Force Execute Error: ${errorMessage}` });
        }
        sponsor.isBusy = false; // Pastikan sponsor dilepaskan
        throw error;
    }
}

function mainLoop() {
    // Jalankan tugas-tugas inti
    assignTasksToSponsors();
    runScheduler();
    runExecutor();

    // Jalankan tugas pemeliharaan (self-funding) setiap 60 detik
    const now = Date.now();
    if (now - botState.lastSponsorCheck > 60000) {
        console.log('[Maintenance] Menjalankan pemeriksaan dana sponsor berkala...');
        botState.lastSponsorCheck = now;
        botState.sponsorPool.filter(s => !s.isBusy).forEach(checkAndFundSponsor);
    }
}

function runScheduler() {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);

    // Ambil semua wallet yang sedang menunggu jadwal
    [...walletDB.getByStatus('SCHEDULED'), ...walletDB.getByStatus('PENDING')].forEach(wallet => {
        const unlockTime = wallet.unlockTime ? new Date(wallet.unlockTime) : now; // PENDING dianggap siap sekarang
        if (unlockTime <= tenMinutesFromNow) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'AWAITING_FUNDING' });
            console.log(`[Scheduler] Wallet ${wallet.pubkey.substring(0,6)}... dipindahkan ke antrian eksekusi.`);
        }
    });
}

function runExecutor() {
    const walletsToExecute = walletDB.getByStatus('AWAITING_EXECUTION');
    const now = new Date();
    const readyWallets = walletsToExecute.filter(w => !w.unlockTime || new Date(w.unlockTime) <= now);

    if (readyWallets.length === 0) return;

    for (const wallet of readyWallets) {
        const sponsor = botState.sponsorPool.find(s => s.pubkey === wallet.sponsorPubkey);
        // Pastikan sponsor benar-benar ada dan sedang ditugaskan ke wallet ini
        if (sponsor && sponsor.isBusy) {
            walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'EXECUTING' });
            // Jalankan tanpa 'await' agar loop bisa lanjut dan memicu eksekusi paralel
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

function getStatus() {
    return {
        isRunning: botState.isRunning,
        sponsors: botState.sponsorPool.map(s => ({ pubkey: s.pubkey, isBusy: s.isBusy }))
    };
}

async function getWalletDetails(mnemonic) {
     if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Mnemonic tidak valid.");
    }
    const server = getPiServer();
    try {
        const keypair = await getWalletFromMnemonic(mnemonic);
        const pubkey = keypair.publicKey();
        let account, availableBalance = "0.0000000";

        try {
            account = await server.loadAccount(pubkey);
            availableBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0';
        } catch (e) {
            if (e.response && e.response.status === 404) {
                // Tidak error, hanya akun belum aktif, tetap tampilkan info dasar
                availableBalance = "0.0000000 (Belum Aktif)";
            } else {
                 throw e;
            }
        }
        
        const claimablesResponse = await server.claimableBalances().claimant(pubkey).limit(200).call();
        let totalLocked = 0;
        const claimablesDetails = claimablesResponse.records.map(record => {
            const amount = parseFloat(record.amount);
            totalLocked += amount;
            let unlockDateWIB = "Segera tersedia";

            if (record.claimants[0]?.predicate?.not?.abs_before) {
                const unlockDate = new Date(record.claimants[0].predicate.not.abs_before);
                const options = { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false };
                unlockDateWIB = unlockDate.toLocaleString('id-ID', options).replace(/\./g, ':');
            }
            return { amount: amount.toFixed(7), unlockDateWIB };
        });

        return {
            mnemonic,
            pubkey,
            availableBalance,
            totalLocked: totalLocked.toFixed(7),
            claimables: claimablesDetails
        };
    } catch (error) {
        console.error(`Gagal mengambil detail untuk wallet: ${error.message}`);
        throw new Error(`Gagal terhubung ke jaringan Pi untuk mengambil detail.`);
    }
}

module.exports = {
    startBot,
    stopBot,
    getStatus,
    setNotifier,
    updateConfig,
    scheduleNewMnemonics,
    getWalletDetails,
    forceExecuteWallet
};

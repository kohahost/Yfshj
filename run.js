const { Server, Keypair, TransactionBuilder, Operation, Asset } = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const walletDB = require('./wallet_db.js');

let sendNotification = () => {};

// Konfigurasi Jaringan
const PI_API_SERVERS = ['http://4.194.35.14:31401', 'http://113.161.1.223:31401'];
const PI_NETWORK_PASSPHRASE = 'Pi Network'; // Ini adalah konstanta yang benar
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

// ===================================================================================
// SIKLUS UTAMA: FUNGSI FUND, EXECUTE, SWEEP (LOGIKA BARU)
// ===================================================================================

/**
 * [LANGKAH 1] Mendanai satu sponsor dari Funder.
 * Fungsi ini akan membuat akun sponsor jika belum ada.
 */
async function fundSponsor(sponsor) {
    const server = getPiServer();
    const fundingAmount = (currentConfig.fundingAmount || 0.0000401).toFixed(7);
    const funderAccount = await server.loadAccount(botState.fundingKeypair.publicKey());
    const baseFee = await server.fetchBaseFee();
    
    let operation;

    try {
        // Cek dulu apakah sponsor sudah aktif
        await server.loadAccount(sponsor.pubkey);
        // Jika aktif, kirim payment biasa
        console.log(`[Funding] Mengirim modal ${fundingAmount} π ke sponsor ${sponsor.pubkey.substring(0, 6)}...`);
        operation = Operation.payment({
            destination: sponsor.pubkey,
            asset: Asset.native(),
            amount: fundingAmount
        });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            // Jika belum aktif, buat akun baru
            console.log(`[Funding] Sponsor ${sponsor.pubkey.substring(0, 6)}... belum aktif. Membuat akun dengan modal ${fundingAmount} π...`);
            operation = Operation.createAccount({
                destination: sponsor.pubkey,
                startingBalance: fundingAmount
            });
        } else {
            // Error lain yang tidak terduga
            throw new Error(`Gagal memeriksa sponsor: ${parsePiError(e)}`);
        }
    }

    const tx = new TransactionBuilder(funderAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE })
        .addOperation(operation)
        .setTimeout(60).build();
    tx.sign(botState.fundingKeypair);
    await server.submitTransaction(tx);
    console.log(`[Funding] ✅ Sponsor ${sponsor.pubkey.substring(0, 6)}... berhasil diberi modal.`);
}


/**
 * [LANGKAH 2] Mengeksekusi transaksi utama: klaim dan kirim.
 * Ini menggunakan saldo sponsor untuk biaya transaksi.
 */
async function executeTransaction(wallet, sponsor) {
    console.log(`[Executor] ${sponsor.pubkey.substring(0, 6)}... -> ${wallet.pubkey.substring(0, 6)}...`);
    const server = getPiServer();
    const sponsorAccount = await server.loadAccount(sponsor.pubkey);
    const baseFee = await server.fetchBaseFee();
    const targetKeypair = await getWalletFromMnemonic(wallet.mnemonic);
    const targetAccount = await server.loadAccount(wallet.pubkey);
    
    const claimables = await server.claimableBalances().claimant(wallet.pubkey).limit(200).call();
    // Filter hanya untuk claimable balance yang sudah bisa di klaim
    const unlockedClaimables = claimables.records.filter(r => !r.claimants[0].predicate.not || new Date(r.claimants[0].predicate.not.abs_before) <= new Date());
    
    const existingBalance = parseFloat(targetAccount.balances.find(b => b.asset_type === 'native')?.balance || '0');
    const totalFromClaims = unlockedClaimables.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    // Jumlah total yang akan dikirim (saldo ada + hasil klaim) dikurangi cadangan minimal 1 Pi
    const amountToSend = existingBalance + totalFromClaims - 1.0; 

    if (amountToSend <= 0) {
        throw new Error("Tidak ada saldo yang cukup untuk dikirim setelah dikurangi cadangan.");
    }

    const txBuilder = new TransactionBuilder(sponsorAccount, { fee: (baseFee * 2).toString(), networkPassphrase: PI_NETWORK_PASSPHRASE }).setTimeout(60);

    // Tambahkan operasi claim untuk setiap koin yang bisa di-claim
    unlockedClaimables.forEach(cb => txBuilder.addOperation(Operation.claimClaimableBalance({ balanceId: cb.id, source: wallet.pubkey })));

    // Tambahkan operasi pengiriman seluruh saldo dari wallet target
    txBuilder.addOperation(Operation.payment({
        destination: currentConfig.recipient,
        asset: Asset.native(),
        amount: amountToSend.toFixed(7),
        source: wallet.pubkey // Penting: sumbernya adalah wallet target
    }));

    const tx = txBuilder.build();
    // Ditandatangani oleh Sponsor (pembayar fee) dan Target (pemilik operasi)
    tx.sign(sponsor.keypair, targetKeypair);

    const res = await server.submitTransaction(tx);
    console.log(`[Executor] ✅ SUKSES ${wallet.pubkey.substring(0, 6)} hash: ${res.hash}`);
    return res.hash;
}

/**
 * [LANGKAH 3] Mengambil kembali semua sisa dana dari sponsor ke Funder.
 */
async function sweepSponsor(sponsor) {
    try {
        const server = getPiServer();
        const sponsorAccount = await server.loadAccount(sponsor.pubkey);
        const sponsorBalance = parseFloat(sponsorAccount.balances.find(b => b.asset_type === 'native').balance);
        const baseFee = await server.fetchBaseFee();
        const amountToSweep = sponsorBalance - (baseFee / 1e7); // Konversi fee dari stroops

        if (amountToSweep > 0.0000001) {
            console.log(`[Sweep] Mengembalikan ${amountToSweep.toFixed(7)} π dari Sponsor ${sponsor.pubkey.substring(0, 6)}...`);
            const sweepTx = new TransactionBuilder(sponsorAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE })
                .addOperation(Operation.payment({
                    destination: botState.fundingKeypair.publicKey(),
                    asset: Asset.native(),
                    amount: amountToSweep.toFixed(7)
                }))
                .setTimeout(30).build();
            sweepTx.sign(sponsor.keypair);
            await server.submitTransaction(sweepTx);
            console.log(`[Sweep] ✅ Pengembalian dana dari Sponsor ${sponsor.pubkey.substring(0, 6)}... berhasil.`);
        }
    } catch(e) {
        const errorMsg = parsePiError(e);
        console.error(`❌ [Sweep] GAGAL untuk Sponsor ${sponsor.pubkey.substring(0, 6)}: ${errorMsg}`);
        sendNotification(`⚠️ *SWEEP GAGAL* ⚠️\nSponsor: \`${sponsor.pubkey}\`\nDana mungkin tersangkut. Cek manual!`);
    }
}

/**
 * Fungsi utama yang menjalankan seluruh siklus untuk satu wallet.
 */
async function executeWalletCycle(wallet, sponsor) {
    let finalStatus = 'FAILED', reason = 'Unknown error';
    walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: 'EXECUTING', sponsorPubkey: sponsor.pubkey });

    try {
        // LANGKAH 1: FUND
        await fundSponsor(sponsor);

        // LANGKAH 2: EXECUTE
        const txHash = await executeTransaction(wallet, sponsor);
        finalStatus = 'SUCCESS';
        reason = txHash;
    } catch (e) {
        reason = parsePiError(e);
        console.error(`❌ [System] SIKLUS GAGAL untuk ${wallet.pubkey.substring(0,6)}: ${reason}`);
        finalStatus = 'FAILED';
    } finally {
        // LANGKAH 3: SWEEP (Selalu dijalankan)
        await sweepSponsor(sponsor);
        
        // LANGKAH 4: FINALISASI
        walletDB.addOrUpdate({ mnemonic: wallet.mnemonic, status: finalStatus, reason: reason });
        sponsor.isBusy = false;
        console.log(`[System] Sponsor ${sponsor.pubkey.substring(0, 6)}... sekarang tersedia.`);
    }
}


// ===================================================================================
// KONTROL BOT DAN MANAJEMEN TUGAS
// ===================================================================================

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
    botState.mainInterval = setInterval(mainLoop, 5000); // Loop setiap 5 detik
    console.log("[SYSTEM] Bot berhasil dimulai.");
    return true;
}

function mainLoop() {
    runScheduler(); // Cek wallet baru yang siap diproses
    processWalletQueue(); // Proses antrian wallet
}

function runScheduler() {
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    const walletsToCheck = [...walletDB.getByStatus('SCHEDULED'), ...walletDB.getByStatus('PENDING')];
    
    walletsToCheck.forEach(wallet => {
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
        sponsor.isBusy = true; // Langsung tandai sibuk
        
        // Jalankan seluruh siklus secara async tanpa menunggu selesai
        // agar bisa menjalankan beberapa tugas secara paralel
        executeWalletCycle(wallet, sponsor);
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
    
    sponsor.isBusy = true; // Amankan sponsor
    try {
        // Langsung jalankan siklus lengkap dan tunggu hasilnya
        await executeWalletCycle(wallet, sponsor);
        return `Proses eksekusi paksa untuk wallet ${wallet.pubkey.substring(0, 6)}... telah selesai.`;
    } catch (error) {
        const errorMessage = error.message || "Error tidak diketahui saat eksekusi paksa.";
        console.error(`[FORCE EXECUTE] GAGAL: ${errorMessage}`);
        // Jika terjadi error tak terduga di sini, pastikan sponsor dilepaskan
        sponsor.isBusy = false; 
        throw error; // Lemparkan error ke API caller
    }
}

// ===================================================================================
// FUNGSI UTILITAS LAINNYA
// ===================================================================================

async function scheduleNewMnemonics(mnemonics) {
    // Fungsi ini tidak berubah, jadi saya persingkat agar tidak terlalu panjang.
    // Pastikan Anda tetap menggunakan versi lengkap dari file asli Anda.
    const stats = { scheduled: 0, pending: 0, invalid: 0, duplicates: 0 };
    for (const mnemonic of mnemonics) {
        if (walletDB.find(mnemonic)) { stats.duplicates++; continue; }
        if (!bip39.validateMnemonic(mnemonic.trim())) {
            walletDB.addOrUpdate({ mnemonic, status: 'INVALID', reason: 'Format BIP39 salah' });
            stats.invalid++; continue;
        }
        try {
            const keypair = await getWalletFromMnemonic(mnemonic);
            const pubkey = keypair.publicKey();
            const server = getPiServer();
            await server.loadAccount(pubkey);
            const claimables = await server.claimableBalances().claimant(pubkey).limit(200).call();
            const now = new Date(); let nextUnlockTime = null;
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
    // Fungsi ini juga tidak berubah.
     if (!bip39.validateMnemonic(mnemonic)) { throw new Error("Mnemonic tidak valid."); }
    const server = getPiServer();
    try {
        const keypair = await getWalletFromMnemonic(mnemonic); const pubkey = keypair.publicKey();
        let account, availableBalance = "0.0000000";
        try {
            account = await server.loadAccount(pubkey);
            availableBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0';
        } catch (e) {
            if (e.response && e.response.status === 404) { availableBalance = "0.0000000 (Belum Aktif)"; } else { throw e; }
        }
        const claimablesResponse = await server.claimableBalances().claimant(pubkey).limit(200).call();
        let totalLocked = 0;
        const claimablesDetails = claimablesResponse.records.map(record => {
            const amount = parseFloat(record.amount); totalLocked += amount;
            let unlockDateWIB = "Segera tersedia";
            if (record.claimants[0]?.predicate?.not?.abs_before) {
                const unlockDate = new Date(record.claimants[0].predicate.not.abs_before);
                const options = { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false };
                unlockDateWIB = unlockDate.toLocaleString('id-ID', options).replace(/\./g, ':');
            }
            return { amount: amount.toFixed(7), unlockDateWIB };
        });
        return { mnemonic, pubkey, availableBalance, totalLocked: totalLocked.toFixed(7), claimables: claimablesDetails };
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

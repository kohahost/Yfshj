// public/app.js

document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    // Elements
    const logContainer = document.getElementById('log-container');
    const botStatusIndicator = document.getElementById('bot-status-indicator');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const clearDbButton = document.getElementById('clearDbButton');
    const addMnemonicsForm = document.getElementById('addMnemonicsForm');
    const mnemonicsInput = document.getElementById('mnemonicsInput');
    const configForm = document.getElementById('configForm');
    const walletTableBody = document.getElementById('wallet-table-body');
    const walletSearchInput = document.getElementById('wallet-search');

    let currentWallets = [];

    function addLog(message) {
        logContainer.innerHTML += `<div>${message}</div>`;
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    socket.on('log', (message) => addLog(message));

    socket.on('status_update', (status) => {
        botStatusIndicator.textContent = status.isRunning ? 'ONLINE' : 'OFFLINE';
        botStatusIndicator.className = `status-indicator-box ${status.isRunning ? 'online' : 'offline'}`;

        const summary = status.summary || {};
        document.getElementById('total-wallets').textContent = summary.TOTAL || 0;
        document.getElementById('scheduled-wallets').textContent = (summary.SCHEDULED || 0) + (summary.PENDING || 0);
        document.getElementById('awaiting-execution-wallets').textContent = summary.AWAITING_EXECUTION || 0;
        const inProgress = (summary.AWAITING_FUNDING || 0) + (summary.FUNDING || 0) + (summary.EXECUTING || 0) + (summary.SWEEPING || 0);
        document.getElementById('in-progress-wallets').textContent = inProgress;
        document.getElementById('success-wallets').textContent = summary.SUCCESS || 0;
        document.getElementById('failed-wallets').textContent = summary.FAILED || 0;

        const sponsorList = document.getElementById('sponsor-status-list');
        if (status.sponsors && status.sponsors.length > 0) {
            sponsorList.innerHTML = '';
            status.sponsors.forEach((s, i) => {
                const statusClass = s.isBusy ? 'sponsor-busy' : 'sponsor-available';
                sponsorList.innerHTML += `<p>Sponsor #${i + 1}: <span class="${statusClass}">${s.isBusy ? 'BEKERJA' : 'TERSEDIA'}</span></p>`;
            });
        } else {
            sponsorList.innerHTML = '<p>Bot offline atau tidak ada sponsor.</p>';
        }
        
        if (status.wallets) {
            currentWallets = status.wallets;
            renderWalletTable();
        }
    });

    async function apiCall(endpoint, method, body = null) {
        try {
            const options = { method, headers: { 'Content-Type': 'application/json' } };
            if (body) options.body = JSON.stringify(body);
            const response = await fetch(endpoint, options);
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Unknown error');
            addLog(`[SYSTEM] ${data.message}`);
            return data;
        } catch (error) {
            addLog(`[ERROR] ${error.message}`);
            alert(`Error: ${error.message}`);
        }
    }
    
    startButton.addEventListener('click', () => apiCall('/api/start', 'POST'));
    stopButton.addEventListener('click', () => apiCall('/api/stop', 'POST'));
    clearDbButton.addEventListener('click', () => {
        if (confirm('Anda yakin ingin menghapus SEMUA data wallet target? Aksi ini tidak bisa dibatalkan.')) {
            apiCall('/api/clear-database', 'POST');
        }
    });

    addMnemonicsForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const mnemonics = mnemonicsInput.value.trim().split('\n').filter(Boolean);
        if (mnemonics.length > 0) {
            apiCall('/api/add-mnemonics', 'POST', { mnemonics });
            mnemonicsInput.value = '';
        }
    });

    configForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const config = {
            recipient: document.getElementById('recipientInput').value,
            fundingMnemonic: document.getElementById('funderInput').value,
            sponsorMnemonics: document.getElementById('sponsorsInput').value.trim().split('\n').filter(Boolean),
            concurrentWorkers: parseInt(document.getElementById('concurrencyInput').value)
        };
        apiCall('/api/save-config', 'POST', config);
    });

    async function loadInitialConfig() {
        try {
            const response = await fetch('/api/get-config');
            const config = await response.json();
            document.getElementById('recipientInput').value = config.recipient || '';
            document.getElementById('funderInput').value = config.fundingMnemonic || '';
            document.getElementById('sponsorsInput').value = (config.sponsorMnemonics || []).join('\n');
            document.getElementById('concurrencyInput').value = config.concurrentWorkers || 5;
        } catch (error) { console.error('Failed to load initial config', error); }
    }
    
    function renderWalletTable() {
        const filterText = walletSearchInput.value.toLowerCase();
        const filteredWallets = currentWallets.filter(wallet => {
            const pubkey = wallet.pubkey ? wallet.pubkey.toLowerCase() : '';
            const status = wallet.status ? wallet.status.toLowerCase() : '';
            return pubkey.includes(filterText) || status.includes(filterText);
        });
        walletTableBody.innerHTML = '';
        if (filteredWallets.length === 0) {
            walletTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Tidak ada data ditemukan.</td></tr>';
            return;
        }
        const rowsHtml = filteredWallets.map(wallet => {
            const statusClass = wallet.status ? `status-${wallet.status.toLowerCase()}` : '';
            let unlockTimeDisplay = wallet.unlockTime ? new Date(wallet.unlockTime).toLocaleString('id-ID') : 'N/A';
            if (wallet.status === 'PENDING') unlockTimeDisplay = 'Langsung';
            let pubkeyDisplay = wallet.pubkey ? `${wallet.pubkey.substring(0, 6)}...${wallet.pubkey.substring(wallet.pubkey.length - 6)}` : 'N/A';
            let infoDisplay = wallet.reason || (wallet.sponsorPubkey ? `Sponsor: ...${wallet.sponsorPubkey.slice(-6)}` : '-');
            if (wallet.status === 'SUCCESS') infoDisplay = `Hash: ...${infoDisplay.slice(-6)}`;
            
            return `
                <tr>
                    <td class="status-cell ${statusClass}">${wallet.status || 'N/A'}</td>
                    <td class="pubkey-cell">${pubkeyDisplay}</td>
                    <td>${unlockTimeDisplay}</td>
                    <td>${infoDisplay}</td>
                </tr>
            `;
        }).join('');
        walletTableBody.innerHTML = rowsHtml;
    }
    
    walletSearchInput.addEventListener('input', renderWalletTable);
    loadInitialConfig();
});

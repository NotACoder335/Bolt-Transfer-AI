const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    const qrCodeImage = document.getElementById('qr-code-image');
    const qrUrlText = document.getElementById('qr-url-text');
    const statusMessage = document.getElementById('status-message');
    const backButton = document.getElementById('back-to-main');

    // Request server info from the main process
    ipcRenderer.invoke('get-server-info-for-receive').then(data => {
        if (data.qrCode) {
            qrCodeImage.src = data.qrCode;
            qrUrlText.textContent = data.uploadUrl;
        } else {
            qrUrlText.textContent = 'Could not generate QR code.';
        }
    });

    // Listen for file received event
    ipcRenderer.on('file-received', (event, fileInfo) => {
        statusMessage.textContent = `File received: ${fileInfo.originalName}`;
    });

    // Handle back button click
    backButton.addEventListener('click', () => {
        ipcRenderer.send('show-main-page');
    });
});

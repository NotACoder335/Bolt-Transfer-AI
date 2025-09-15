const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    const saveButton = document.getElementById('save-settings');
    const apiKeyInput = document.getElementById('api-key');

    // Request current API key to display
    ipcRenderer.invoke('get-api-key').then(apiKey => {
        if (apiKey) {
            apiKeyInput.value = apiKey;
        }
    });

    saveButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value;
        ipcRenderer.send('set-api-key', apiKey);
        alert('API Key saved!');
        window.close();
    });

    const clearButton = document.getElementById('clear-api-key');
    clearButton.addEventListener('click', () => {
        ipcRenderer.send('clear-api-key');
        apiKeyInput.value = '';
        alert('API Key cleared!');
    });
});

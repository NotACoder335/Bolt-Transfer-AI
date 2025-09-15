const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
    const sendButton = document.getElementById('chatbot-send');
    const chatbotInput = document.getElementById('chatbot-input');
    const messagesContainer = document.getElementById('chatbot-messages');

    sendButton.addEventListener('click', async () => {
        const question = chatbotInput.value;
        if (!question) return;

        addMessage('user', question);
        chatbotInput.value = '';

        try {
            const response = await ipcRenderer.invoke('ask-gemini', question);
            addMessage('bot', response);
        } catch (error) {
            addMessage('bot', `Error: ${error.message}`);
        }
    });

    function addMessage(sender, text) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${sender}-message`);
        messageElement.textContent = text;
        messagesContainer.appendChild(messageElement);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
});

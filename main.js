const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const getNetworkAddress = require('network-address');
const os = require('os');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let store;
let genAI;

// Store window references
let mainWindow;
let chatbotWindow;
let settingsWindow;
// HTTP server and Socket.io for real-time communication
let httpServer;
let io;
// Express app for file transfer
let expressApp;
// Store received files information
const receivedFiles = [];
// Store sending files information
let sendingFileInfo = null;

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 500,
    height: 750,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'lightning_app.png')
  });

  // Load the index.html of the app
  mainWindow.loadFile('index.html');

  // mainWindow.webContents.openDevTools();
}

function startServer() {
  expressApp = express();

  // Minimal CORS to allow access from other devices on LAN
  expressApp.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  httpServer = http.createServer(expressApp);
  io = socketIo(httpServer);

  // Configure storage for file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const downloadDir = path.join(os.homedir(), 'Downloads', 'Tranfer');
      
      if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
      }
      
      cb(null, downloadDir);
    },
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    }
  });

  const upload = multer({ storage });

  // Set up routes for file transfer
  expressApp.post('/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) {
      logTransfer({
        type: 'receive',
        status: 'failed',
        reason: 'No file uploaded',
        deviceIp: req.ip
      });
      return res.status(400).send('No file uploaded');
    }
    
    const fileInfo = {
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: file.path
    };
    
    receivedFiles.push(fileInfo);

    logTransfer({
      type: 'receive',
      filename: file.originalname,
      size: file.size,
      status: 'completed',
      deviceIp: req.ip
    });
    
    // Emit progress update to the UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-received', fileInfo);
    }
    
    res.send('File received successfully');
  });

  // Route to serve the mobile upload page
  expressApp.get('/mobile-upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'mobile-upload.html'));
  });

  // Serve static files for downloading
  expressApp.use('/files', express.static(path.join(os.homedir(), 'Downloads', 'Tranfer')));

  // Socket.io connection handling
  io.on('connection', (socket) => {
    console.log('New device connected:', socket.id);
    
    // Send device info to UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      const deviceName = socket.handshake.headers['user-agent'] || 'Unknown Device';
      mainWindow.webContents.send('device-connected', { id: socket.id, name: deviceName });
    }

    // Handle transfer progress
    socket.on('transfer-progress', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transfer-progress-update', data);
      }
    });

    socket.on('disconnect', () => {
      console.log('Device disconnected:', socket.id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('device-disconnected', { id: socket.id });
      }
    });
  });

  // Start server on all interfaces so phones can reach it over Wi‑Fi/hotspot
  const port = 8080;
  httpServer.listen(port, '0.0.0.0', () => {
    const ipAddress = getBestIPAddress();
    console.log(`Server running at http://${ipAddress}:${port}`);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-started', { ip: ipAddress, port });
    }
  });
}

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
  const { default: Store } = await import('electron-store');
  store = new Store();

  // Initialize Google Gemini with stored API key if it exists
  if (store.get('apiKey')) {
    genAI = new GoogleGenerativeAI(store.get('apiKey'));
  }

  createWindow();
  startServer();
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Function to log transfer events to a file
function logTransfer(logData) {
  const logFilePath = path.join(app.getPath('userData'), 'transfer_log.jsonl');
  const logEntry = {
    timestamp: new Date().toISOString(),
    ...logData
  };

  try {
    fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Failed to write to transfer log:', error);
  }
}

app.on('activate', () => {
  // On macOS it's common to re-create a window when the dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handle file selection for sending
ipcMain.on('select-files', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('files-selected', { success: true, files: result.filePaths });
    } else {
      event.reply('files-selected', { success: false });
    }
  } catch (error) {
    console.error('Error selecting files:', error);
    event.reply('files-selected', { success: false, error: error.message });
  }
});

// Handle file sending
ipcMain.on('send-files', async (event, { targetAddress, files }) => {
  let totalSize = 0;
  let sentSize = 0;
  // Prefer the active Wi‑Fi/hotspot IPv4 address
  const ipAddress = getBestIPAddress();
  const port = 8080;
  const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2);
  const downloadUrls = [];
  
  // Create a directory for this transfer session
  const transferDir = path.join(os.tmpdir(), 'Tranfer', sessionId);
  if (!fs.existsSync(transferDir)) {
    fs.mkdirSync(transferDir, { recursive: true });
  }
  
  // Set up a specific route for this session WITH logging of first download per file
  const sentLogged = new Set();
  const staticHandler = express.static(transferDir);
  expressApp.use(`/download/${sessionId}`, (req, res, next) => {
    // req.path example: /filename.ext or / (for index.html)
    const relativeReqPath = decodeURIComponent(req.path.replace(/^\//, ''));
    // Skip logging for branding/support files
    if (relativeReqPath === 'tranfer-logo.png' || relativeReqPath === 'index.html') {
      return staticHandler(req, res, next);
    }
    if (relativeReqPath && relativeReqPath !== '' && !relativeReqPath.endsWith('/')) {
      const fullPath = path.join(transferDir, relativeReqPath);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() && !sentLogged.has(relativeReqPath)) {
          sentLogged.add(relativeReqPath);
          const stats = fs.statSync(fullPath);
          logTransfer({
            type: 'send',
            filename: relativeReqPath,
            size: stats.size,
            status: 'completed',
            sessionId,
            deviceIp: req.ip
          });
        }
      } catch (e) {
        console.error('Error logging outgoing file download:', e);
      }
    }
    return staticHandler(req, res, next);
  });

  // Calculate total size and prepare files
  for (const filePath of files) {
    try {
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
      
      // Copy file to transfer directory
      const fileName = path.basename(filePath);
      const destPath = path.join(transferDir, fileName);
      fs.copyFileSync(filePath, destPath);
      
      // Create download URL
      const fileUrl = `http://${ipAddress}:${port}/download/${sessionId}/${encodeURIComponent(fileName)}`;
      downloadUrls.push({ fileName, url: fileUrl });
    } catch (err) {
      console.error(`Error preparing file ${filePath}:`, err);
    }
  }
  
  // Create a simple HTML page for mobile download
  const downloadPagePath = path.join(transferDir, 'index.html');
  const downloadPageHtml = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tranfer Download</title>
    <style>
      body {
        font-family: sans-serif;
        max-width: 500px;
        margin: 0 auto;
        padding: 20px;
        background: #1e1e2e;
        color: white;
      }
      h1 {
        color: #ff5599;
        text-align: center;
      }
      .file {
        background: rgba(255,255,255,0.1);
        border-radius: 8px;
        padding: 15px;
        margin: 10px 0;
      }
      .file a {
        color: #8865ff;
        text-decoration: none;
        font-weight: bold;
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .file .size {
        color: rgba(255,255,255,0.7);
        font-size: 12px;
      }
      .logo {
        width: 80px;
        height: 80px;
        display: block;
        margin: 0 auto 20px auto;
      }
    </style>
  </head>
  <body>
    <img src="/download/${sessionId}/tranfer-logo.png" class="logo" onerror="this.style.display='none'">
    <h1>Tranfer</h1>
    <p>Files ready for download:</p>
    <div id="files">
      ${files.map(filePath => {
        const fileName = path.basename(filePath);
        const stats = fs.statSync(filePath);
        const size = formatFileSize(stats.size);
        return `
        <div class="file">
          <a href="/download/${sessionId}/${encodeURIComponent(fileName)}" download="${fileName}">${fileName}</a>
          <div class="size">${size}</div>
        </div>
        `;
      }).join('')}
    </div>
    <script>
      // Auto-download files on mobile
      if(/Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
        const links = document.querySelectorAll('#files a');
        links.forEach(link => {
          setTimeout(() => {
            link.click();
          }, 500);
        });
      }
    </script>
  </body>
  </html>
  `;
  
  fs.writeFileSync(downloadPagePath, downloadPageHtml);
  
  // Copy logo for the download page
  try {
    const logoSource = path.join(__dirname, 'assets', 'lightning.gif');
    const logoDest = path.join(transferDir, 'tranfer-logo.png');
    if (fs.existsSync(logoSource)) {
      fs.copyFileSync(logoSource, logoDest);
    }
  } catch (err) {
    console.error('Error copying logo:', err);
  }
  
  // Generate QR code for the download URL
  const qrCodeUrl = `http://${ipAddress}:${port}/download/${sessionId}/`;
  let qrCodeDataUrl;
  try {
    qrCodeDataUrl = await QRCode.toDataURL(qrCodeUrl, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 300,
      color: {
        dark: '#ff5599',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('Error generating QR code:', err);
    qrCodeDataUrl = '';
  }
  
  // Send QR code and transfer info to the renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qr-code-generated', {
      qrCode: qrCodeDataUrl,
      downloadUrl: qrCodeUrl,
      sessionId,
      files: downloadUrls,
      totalSize
    });
  }
  
  // Set up for progress tracking
  sendingFileInfo = { totalSize, sentSize: 0, files, sessionId };
  
  // Set up a socket room for this session
  io.on('connection', (socket) => {
    socket.on(`join-session-${sessionId}`, () => {
      socket.join(sessionId);
      console.log(`Device joined session: ${sessionId}`);
      
      // Notify the UI that a device has connected
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('device-connected', { 
          id: socket.id,
          name: socket.handshake.headers['user-agent'] || 'Mobile Device',
          sessionId
        });
      }
      
      socket.on('download-started', (data) => {
        // Update UI to show download has started
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-started', {
            fileName: data.fileName,
            sessionId
          });
        }
      });
      
      socket.on('download-progress', (data) => {
        // Update UI with download progress
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendingFileInfo.sentSize = data.downloaded;
          const progress = Math.round((data.downloaded / totalSize) * 100);
          
          mainWindow.webContents.send('send-progress-update', { 
            progress,
            fileName: data.fileName,
            sentBytes: data.downloaded,
            totalBytes: totalSize,
            sessionId
          });
        }
      });
      
      socket.on('download-complete', (data) => {
        // Notify the UI that the download is complete
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-complete', {
            fileName: data.fileName,
            sessionId
          });
        }
        // Log the sent file
        const sentFile = sendingFileInfo.files.find(f => path.basename(f) === data.fileName);
        if(sentFile) {
            const stats = fs.statSync(sentFile);
            logTransfer({
                type: 'send',
                filename: data.fileName,
                size: stats.size,
                status: 'completed',
                deviceIp: socket.handshake.address
            });
        }
      });
    });
  });
});

// Handle navigation to receive page
ipcMain.on('show-receive-page', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile('receive.html');
  }
});

// Handle navigation back to the main page
ipcMain.on('show-main-page', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile('index.html');
    }
});

// Handle request for server info for the receive page
ipcMain.handle('get-server-info-for-receive', async () => {
    const ipAddress = getBestIPAddress();
    const port = 8080;
    const uploadUrl = `http://${ipAddress}:${port}/mobile-upload`;

    let qrCodeDataUrl;
    try {
        qrCodeDataUrl = await QRCode.toDataURL(uploadUrl, {
            errorCorrectionLevel: 'H',
            margin: 1,
            width: 300,
            color: {
                dark: '#8865ff',
                light: '#ffffff'
            }
        });
    } catch (err) {
        console.error('Error generating QR code for receive page:', err);
        qrCodeDataUrl = '';
    }

    return { qrCode: qrCodeDataUrl, uploadUrl };
});

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  else return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// Enumerate IPv4 addresses and pick the most likely LAN one
function getAllIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info && info.family === 'IPv4' && !info.internal) {
        results.push({ name, address: info.address });
      }
    }
  }
  return results;
}

function getBestIPAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name]) {
      if (info.family === 'IPv4' && !info.internal) {
        let score = 0;
        // Higher score for physical and common interfaces
        if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wlan')) score += 10;
        if (name.toLowerCase().includes('ethernet')) score += 9;
        
        // Bonus for being on a common private network, typical for hotspots/routers
        if (info.address.startsWith('192.168.')) score += 8;
        if (info.address.startsWith('10.')) score += 7;
        if (info.address.startsWith('172.')) score += 6;

        // Lower score for virtual adapters
        if (name.toLowerCase().includes('vmware') || name.toLowerCase().includes('virtual')) score -= 10;

        candidates.push({ address: info.address, score: score, name: name });
      }
    }
  }

  // Sort by score, highest first
  candidates.sort((a, b) => b.score - a.score);
  
  console.log('LAN IP candidates (scored):', candidates);

  if (candidates.length > 0) {
    console.log('Chosen IP:', candidates[0]);
    return candidates[0].address;
  }

  // Fallback
  return '127.0.0.1';
}

// Get server IP address
ipcMain.handle('get-server-info', async () => {
  const ipAddress = getBestIPAddress();
  return { ip: ipAddress, port: 8080 };
});

// Handle opening the chatbot window
ipcMain.on('open-chatbot', () => {
  if (chatbotWindow) {
    chatbotWindow.focus();
    return;
  }
  chatbotWindow = new BrowserWindow({
    width: 400,
    height: 600,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  chatbotWindow.loadFile('chatbot.html');
  chatbotWindow.on('closed', () => {
    chatbotWindow = null;
  });
});

// Handle opening the settings window
ipcMain.on('open-settings', () => {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 400,
    height: 200,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
});

// Handle API key storage
ipcMain.on('set-api-key', (event, apiKey) => {
  store.set('apiKey', apiKey);
  genAI = new GoogleGenerativeAI(apiKey);
});

ipcMain.on('clear-api-key', () => {
    store.delete('apiKey');
    genAI = undefined;
    console.log('API Key has been cleared.');
});

ipcMain.handle('get-api-key', () => {
  return store.get('apiKey');
});

// Handle chatbot questions
ipcMain.handle('ask-gemini', async (event, question) => {
  if (!genAI) {
    return 'Please set your Google Gemini API key in the settings.';
  }

  const logFilePath = path.join(app.getPath('userData'), 'transfer_log.jsonl');
  let fileContent = '';
  try {
    if (fs.existsSync(logFilePath)) {
        fileContent = fs.readFileSync(logFilePath, 'utf-8');
    }
  } catch (error) {
    console.error('Could not read transfer log file:', error);
    return 'An error occurred while reading the transfer log.';
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
    const prompt = `You are a helpful assistant that answers questions based on the provided data from a file transfer application only. 
    **YOUR INSTRUCTIONS GO HERE. ***
    - Always answer in a friendly and concise manner.
    - If you don't know the answer, say "I do not have enough information to answer that."
    - Never mention that you are an AI.
    - The data is in JSONL format.
    - never include * or ''"" in your response
    - also incuded size of files[in mb or gb], and their date [date format: eg 12th Sep 2025]of sending or receiving and genral info of files that user would like to know
    - generate in a pretty readable format
    - eg: reply : You have received 
      img2023.ppng on 27th Mar 2025
      vid.mp4 on 22th Sep 2024
    
    Here is the data:\n${fileContent}\n\nQuestion: ${question}`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return text;
  } catch (error) {
    console.error('Error with Google Gemini API:', error);
    return `Error: ${error.message}`;
  }
});

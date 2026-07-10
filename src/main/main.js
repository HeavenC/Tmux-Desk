const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { registerIpc } = require('./ipc');
const { listDirectory, validatePath } = require('./file-service');
const { PreferencesStore } = require('./preferences-store');
const { TerminalManager } = require('./terminal-manager');
const { TmuxService } = require('./tmux-service');
const { createWebControl } = require('./web-control');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

let mainWindow = null;
let preferencesStore = null;
let terminalManager = null;
let webControl = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function createMainWindow() {
  const preferences = await preferencesStore.load();
  const bounds = preferences.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    ...bounds,
    show: false,
    title: 'Tmux Desk',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 14 },
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', () => {
    if (!mainWindow?.isDestroyed()) {
      preferencesStore.save({ windowBounds: mainWindow.getBounds() }).catch(() => {});
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; terminalManager.dispose(); });
  await mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer-dist', 'index.html'));
}

function installContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
}

function sendCommand(command) {
  sendToRenderer('app:command', command);
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建会话', accelerator: 'CommandOrControl+N', click: () => sendCommand('new-session') },
        { label: '命令面板', accelerator: 'CommandOrControl+K', click: () => sendCommand('command-palette') },
        { type: 'separator' },
        { label: '会话导入指南（给 AI Agent）…', click: () => sendCommand('api-guide') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { label: '刷新会话', accelerator: 'CommandOrControl+R', click: () => sendCommand('refresh') },
        { label: '搜索会话', accelerator: 'CommandOrControl+F', click: () => sendCommand('search') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

async function bootstrap() {
  preferencesStore = new PreferencesStore({
    filePath: path.join(app.getPath('userData'), 'preferences.json'),
  });
  // Prefer a tmux binary bundled inside the .app (Contents/Resources/bin/tmux)
  // so the app can ship self-contained; falls back to Homebrew / system tmux.
  const bundledTmux = app.isPackaged ? path.join(process.resourcesPath, 'bin', 'tmux') : null;
  const tmuxService = new TmuxService({ tmuxPath: bundledTmux });
  const tmuxPath = await tmuxService.resolveTmuxPath();
  terminalManager = new TerminalManager({
    tmuxPath: tmuxPath || 'tmux',
    sendEvent: sendToRenderer,
  });
  webControl = createWebControl({ preferencesStore });
  registerIpc({
    ipcMain,
    tmuxService,
    terminalManager,
    preferencesStore,
    webControl,
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 tmux 会话工作目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] || null;
    },
    fileBridge: {
      list: (dirPath) => listDirectory(dirPath),
      open: async (filePath) => {
        const message = await shell.openPath(validatePath(filePath));
        if (message) throw new Error(message);
        return true;
      },
      reveal: (filePath) => { shell.showItemInFolder(validatePath(filePath)); return true; },
      openWith: async (filePath) => {
        const target = validatePath(filePath);
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择用于打开的应用',
          defaultPath: '/Applications',
          properties: ['openFile'],
          filters: [{ name: '应用程序', extensions: ['app'] }],
        });
        const appPath = result.canceled ? null : result.filePaths[0] || null;
        if (!appPath) return { canceled: true };
        await new Promise((resolve, reject) => {
          execFile('/usr/bin/open', ['-a', appPath, target], (error) => (error ? reject(error) : resolve()));
        });
        return { canceled: false, app: path.basename(appPath, '.app') };
      },
    },
  });
  installContentSecurityPolicy();
  installApplicationMenu();
  await createMainWindow();
}

app.whenReady().then(bootstrap).catch((error) => {
  dialog.showErrorBox('Tmux Desk 启动失败', error.message || String(error));
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && preferencesStore) createMainWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  terminalManager?.dispose();
  webControl?.dispose().catch(() => {});
});

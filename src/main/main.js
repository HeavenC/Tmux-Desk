const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { registerIpc } = require('./ipc');
const { menuText, normalizeMenuLocale } = require('./menu-i18n');
const { listDirectory, toBrowsablePath } = require('./file-service');
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

let menuLocale = normalizeMenuLocale(app.getLocale());

function installApplicationMenu() {
  const m = menuText(menuLocale);
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
      label: m.file,
      submenu: [
        { label: m.newSession, accelerator: 'CommandOrControl+N', click: () => sendCommand('new-session') },
        { label: m.commandPalette, accelerator: 'CommandOrControl+K', click: () => sendCommand('command-palette') },
        { type: 'separator' },
        {
          label: m.importSessions,
          submenu: [
            { label: m.importClaude, click: () => sendCommand('import-codebases:claude') },
            { label: m.importCodex, click: () => sendCommand('import-codebases:codex') },
            { label: m.importIdea, click: () => sendCommand('import-codebases:idea') },
            { label: m.importVscode, click: () => sendCommand('import-codebases:vscode') },
          ],
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: m.view,
      submenu: [
        { label: m.refresh, accelerator: 'CommandOrControl+R', click: () => sendCommand('refresh') },
        { label: m.search, accelerator: 'CommandOrControl+F', click: () => sendCommand('search') },
        { type: 'separator' },
        { label: m.splitVertical, accelerator: 'CommandOrControl+D', click: () => sendCommand('split:vertical') },
        { label: m.splitHorizontal, accelerator: 'CommandOrControl+Shift+D', click: () => sendCommand('split:horizontal') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// The renderer owns the language preference (localStorage); it pushes the
// effective locale here so the native menu matches.
function setMenuLocale(locale) {
  const next = normalizeMenuLocale(locale);
  if (next === menuLocale) return;
  menuLocale = next;
  installApplicationMenu();
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
    setAppLocale: setMenuLocale,
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
        const message = await shell.openPath(await toBrowsablePath(filePath));
        if (message) throw new Error(message);
        return true;
      },
      reveal: async (filePath) => { shell.showItemInFolder(await toBrowsablePath(filePath)); return true; },
      openWith: async (filePath) => {
        const target = await toBrowsablePath(filePath);
        const isWin = process.platform === 'win32';
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择用于打开的应用',
          defaultPath: isWin ? 'C:\\Program Files' : '/Applications',
          properties: ['openFile'],
          filters: isWin
            ? [{ name: '应用程序', extensions: ['exe'] }]
            : [{ name: '应用程序', extensions: ['app'] }],
        });
        const appPath = result.canceled ? null : result.filePaths[0] || null;
        if (!appPath) return { canceled: true };
        await new Promise((resolve, reject) => {
          const done = (error) => (error ? reject(error) : resolve());
          if (isWin) execFile(appPath, [target], done);
          else execFile('/usr/bin/open', ['-a', appPath, target], done);
        });
        return { canceled: false, app: path.basename(appPath, isWin ? '.exe' : '.app') };
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

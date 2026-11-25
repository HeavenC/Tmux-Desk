const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, powerSaveBlocker, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');

const { registerIpc } = require('./ipc');
const { KeepAwakeController } = require('./keep-awake-controller');
const { menuText, normalizeMenuLocale } = require('./menu-i18n');
const { listDirectory, toBrowsablePath } = require('./file-service');
const { PreferencesStore } = require('./preferences-store');
const { SessionSnapshotService } = require('./session-snapshot');
const { TerminalManager } = require('./terminal-manager');
const { TmuxService } = require('./tmux-service');
const { installBundledTmux } = require('./bundled-tmux');
const { createTransferBridge } = require('./transfer-bridge');
const { createWebControl } = require('./web-control');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // Remote takeover: the renderer opens fetch + WebSocket to user-added remote
  // Tmux Desk hosts (arbitrary http(s)/ws(s) origins), so connect-src can't be
  // 'none'. script-src stays 'self', so there's no remote-code path — only the
  // RemoteApi's own requests to hosts the user explicitly trusted.
  "connect-src 'self' http: https: ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

let mainWindow = null;
let preferencesStore = null;
let terminalManager = null;
let webControl = null;
let keepAwakeController = null;
let snapshotService = null;
let transferBridge = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function createMainWindow() {
  const preferences = await preferencesStore.load();
  const bounds = preferences.windowBounds || {};
  const isMac = process.platform === 'darwin';
  // The native material's light/dark comes from nativeTheme, so tie it to the
  // app's own theme preference (see also the 'theme' branch of preferences:save).
  nativeTheme.themeSource = preferences.theme || 'system';
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
    // macOS: paint the window with a vibrant sidebar material and let the
    // rail/session-sidebar be translucent over it (styles.css). The window
    // background must be fully transparent for the material to show through;
    // every other region (workspace, terminal) paints opaque over it.
    ...(isMac
      ? { vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
      : { backgroundColor: '#f6f7f9' }),
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
  // TMUX_DESK_PREFERENCES_FILE lets a demo/test instance keep its own tags,
  // favorites and window sizes instead of touching the real preferences.
  const prefsOverride = typeof process.env.TMUX_DESK_PREFERENCES_FILE === 'string'
    ? process.env.TMUX_DESK_PREFERENCES_FILE.trim()
    : '';
  const preferencesFilePath = prefsOverride
    ? path.resolve(prefsOverride)
    : path.join(app.getPath('userData'), 'preferences.json');
  preferencesStore = new PreferencesStore({ filePath: preferencesFilePath });
  keepAwakeController = new KeepAwakeController({ powerSaveBlocker, powerMonitor });
  keepAwakeController.initialize((await preferencesStore.load()).keepAwake);
  // TMUX_DESK_SOCKET runs every tmux command against a dedicated socket
  // (`tmux -L <name>`) instead of the default one. Handy for demos/screenshots
  // and testing without touching your real sessions. Empty → default socket.
  const socketName = typeof process.env.TMUX_DESK_SOCKET === 'string' && process.env.TMUX_DESK_SOCKET.trim()
    ? process.env.TMUX_DESK_SOCKET.trim()
    : null;
  const tmuxService = new TmuxService({ socketName });
  let tmuxPath = await tmuxService.resolveTmuxPath();
  // No tmux on this machine: fall back to the one shipped in the .app
  // (Contents/Resources/bin/tmux, present in builds that bundle it), installed
  // next to preferences.json so the server never runs from inside the bundle.
  if (!tmuxPath && app.isPackaged) {
    tmuxService.fallbackTmuxPath = await installBundledTmux({
      source: path.join(process.resourcesPath, 'bin', 'tmux'),
      targetDir: path.join(path.dirname(preferencesFilePath), 'bin'),
    });
    tmuxPath = await tmuxService.resolveTmuxPath();
  }
  // Kick the tmux server awake so config-driven restore plugins (e.g.
  // tmux-continuum's auto-restore after a reboot) run at app launch instead of
  // waiting for the first session command. start-server is a no-op on a running
  // server, and without a restore plugin an empty server just exits again.
  if (tmuxPath) tmuxService.run(['start-server']).catch(() => {});
  terminalManager = new TerminalManager({
    tmuxPath: tmuxPath || 'tmux',
    socketName,
    sendEvent: sendToRenderer,
  });
  // Own the session snapshot rather than trusting the user to have a tmux
  // restore plugin: after a reboot the tmux server is gone, and without this
  // every session goes with it (the tags survive only because they live in
  // preferences.json). Lives next to preferences.json so a demo instance
  // pointed at its own preferences gets its own snapshot too.
  snapshotService = new SessionSnapshotService({
    tmuxService,
    preferencesStore,
    filePath: path.join(path.dirname(preferencesFilePath), 'session-snapshot.json'),
    onChange: (health) => sendToRenderer('snapshot:changed', health),
  });
  webControl = createWebControl({ preferencesStore });
  // Auto-open the mobile/cross-device web share at launch when the user opted in.
  // Fire-and-forget: a failure (e.g. the port is held by an external daemon) must
  // not block window creation — the share panel surfaces the state either way.
  if ((await preferencesStore.load()).autoShare) {
    webControl.start().catch((error) => console.error('自动开启共享失败:', error));
  }
  transferBridge = createTransferBridge({
    preferencesStore,
    // Env override for sandboxed runs (e2e), same idea as TMUX_DESK_PREFERENCES_FILE.
    downloadsDir: () => process.env.TMUX_DESK_DOWNLOADS_DIR || app.getPath('downloads'),
    chooseSavePath: async (defaultPath) => {
      const result = await dialog.showSaveDialog(mainWindow, { title: '保存远程文件', defaultPath });
      return result.canceled ? null : result.filePath || null;
    },
    openPath: async (filePath) => {
      const message = await shell.openPath(filePath);
      if (message) throw new Error(message);
    },
    onProgress: (progress) => sendToRenderer('files:transfer-progress', progress),
  });
  registerIpc({
    ipcMain,
    setAppLocale: setMenuLocale,
    tmuxService,
    terminalManager,
    preferencesStore,
    keepAwakeController,
    webControl,
    snapshotService,
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
      downloadRemote: (request) => transferBridge.download(request),
      uploadRemote: (request) => transferBridge.upload(request),
      copyInto: (request) => transferBridge.copyInto(request),
      cancelTransfer: async (transferId) => transferBridge.cancel(transferId),
      // Scheme allow-listed in ipc.js before it reaches here.
      openExternal: async (url) => { await shell.openExternal(url); return true; },
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
    tagFileIO: {
      exportToFile: async (data) => {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出标签配置',
          defaultPath: 'tmux-desk-tags.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return { canceled: true };
        await fs.writeFile(result.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        return { canceled: false, path: result.filePath };
      },
      importFromFile: async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '导入标签配置',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths[0]) return { canceled: true };
        let payload;
        try {
          payload = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
        } catch {
          throw new Error('无法解析标签文件，请确认是有效的 JSON');
        }
        if (!payload || payload.type !== 'tmux-desk-tags') {
          throw new Error('不是 Tmux Desk 标签文件');
        }
        return { canceled: false, payload };
      },
    },
  });
  installContentSecurityPolicy();
  installApplicationMenu();
  await createMainWindow();
  // After the window exists, so the health result has somewhere to land. The
  // recovery pass waits out any foreign restore plugin before deciding what is
  // missing, hence fire-and-forget rather than blocking the first paint.
  snapshotService.start().catch(() => {});
  // A snapshot taken while going to sleep / shutting down is the one that
  // matters: it is the last state before the tmux server dies with the machine.
  powerMonitor.on('suspend', () => snapshotService?.save('suspend').catch(() => {}));
  powerMonitor.on('shutdown', () => snapshotService?.save('shutdown').catch(() => {}));
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
  // Best-effort final snapshot; quitting the app does not kill the tmux server,
  // but it is the last moment we are guaranteed to be running.
  snapshotService?.save('quit').catch(() => {});
  snapshotService?.dispose();
  terminalManager?.dispose();
  keepAwakeController?.dispose();
  transferBridge?.dispose();
  webControl?.dispose().catch(() => {});
});

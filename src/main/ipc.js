const path = require('node:path');
const { nativeTheme } = require('electron');
const { normalizeTagId, normalizeTagName } = require('../shared/tag-model');
const { validateTmuxSettings } = require('../shared/tmux-settings');
const { validateTerminalAppearance } = require('../shared/terminal-appearance');
const { validatePasteGuard } = require('../shared/paste-guard');
const { normalizeSessionRestore } = require('./session-snapshot');
const { parseConnectionInput, parseTarget } = require('../shared/remote-connection');
const { discoverCodebases } = require('./codebase-import');

const TARGET_PATTERNS = {
  session: /^\$\d+$/,
  window: /^@\d+$/,
  pane: /^%\d+$/,
};
const VALID_THEMES = new Set(['light', 'dark', 'system']);
const IPC_CHANNELS = Object.freeze([
  'system:get-status',
  'system:choose-directory',
  'sessions:list',
  'sessions:detail',
  'sessions:create',
  'sessions:duplicate',
  'sessions:rename',
  'sessions:kill',
  'sessions:toggle-favorite',
  'sessions:set-tags',
  'codebases:discover',
  'tags:create',
  'tags:touch',
  'tags:rename',
  'tags:delete',
  'tags:set-pinned',
  'tags:reorder-pinned',
  'tags:export',
  'tags:import',
  'remotes:add',
  'remotes:remove',
  'remotes:set-reshare',
  'windows:select',
  'panes:select',
  'panes:kill',
  'panes:split',
  'panes:resize',
  'panes:zoom',
  'panes:navigate',
  'panes:broadcast',
  'app:set-locale',
  'preferences:get',
  'preferences:save',
  'files:list',
  'files:open',
  'files:open-with',
  'files:open-url',
  'files:reveal',
  'files:remote-download',
  'files:remote-upload',
  'files:copy-into',
  'files:cancel-transfer',
  'terminal:attach',
  'terminal:write',
  'terminal:resize',
  'terminal:scroll',
  'terminal:cancel-copy-mode',
  'terminal:clear',
  'terminal:find',
  'search:sessions',
  'search:reveal',
  'terminal:detach',
  'web:status',
  'web:start',
  'web:stop',
  'snapshot:status',
  'snapshot:save',
  'snapshot:restore',
  'snapshot:repair-cwd',
  'snapshot:reveal',
]);
const WEB_SESSION_PREFIX = '_web_';

function validateTarget(value, kind = 'session') {
  const pattern = TARGET_PATTERNS[kind];
  if (!pattern || typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('tmux 目标无效');
  }
  return value;
}

function validateSessionName(value) {
  if (typeof value !== 'string') throw new Error('会话名称无效');
  const name = value.trim();
  if (!name || Array.from(name).length > 80 || /[.:\x00-\x1f\x7f]/.test(name)) {
    throw new Error('会话名称无效');
  }
  return name;
}

function validateOptionalSessionName(value) {
  return value == null ? null : validateSessionName(value);
}

function validateSessionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话参数无效');
  const name = validateSessionName(value.name);
  if (typeof value.cwd !== 'string' || value.cwd.length > 4096 || value.cwd.includes('\0') || !path.isAbsolute(value.cwd)) {
    throw new Error('工作目录无效');
  }
  const startupCommand = value.startupCommand ?? '';
  if (typeof startupCommand !== 'string' || startupCommand.length > 4096 || /[\x00\r\n]/.test(startupCommand)) {
    throw new Error('启动命令无效');
  }
  return { name, cwd: value.cwd, startupCommand };
}

function validateTagMutation(kind, value) {
  if (kind === 'create') return normalizeTagName(value);
  if (kind === 'delete') return normalizeTagId(value);
  if (kind === 'rename') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tag 参数无效');
    return { id: normalizeTagId(value.id), name: normalizeTagName(value.name) };
  }
  throw new Error('Tag 操作无效');
}

function validateSessionTags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tag 参数无效');
  if (!Array.isArray(value.tagIds) || value.tagIds.length > 100) throw new Error('Tag 列表无效');
  return {
    sessionName: validateSessionName(value.sessionName),
    tagIds: [...new Set(value.tagIds.map(normalizeTagId))],
  };
}

function validateTerminalId(value) {
  if (!Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error('终端编号无效');
  }
  return value;
}

function validateTerminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 1 || rows > 500) {
    throw new Error('终端尺寸无效');
  }
  return { cols, rows };
}

function validateTerminalPayload(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('终端参数无效');
  if (kind === 'attach') {
    return { sessionId: validateTarget(value.sessionId), ...validateTerminalSize(value.cols, value.rows) };
  }
  if (kind === 'scroll') {
    if (!Number.isInteger(value.lines)) throw new Error('滚动量无效');
    return { sessionId: validateTarget(value.sessionId), lines: Math.max(-500, Math.min(500, value.lines)) };
  }
  if (kind === 'cancel-copy-mode' || kind === 'clear') return { sessionId: validateTarget(value.sessionId) };
  if (kind === 'find') {
    const query = typeof value.query === 'string' ? value.query : '';
    if (!query.trim() || query.length > 512) throw new Error('查找内容无效');
    return {
      sessionId: validateTarget(value.sessionId),
      action: value.action === 'step' ? 'step' : 'search',
      direction: value.direction === 'forward' ? 'forward' : 'backward',
      flip: value.flip === true,
      query,
    };
  }
  const terminalId = validateTerminalId(value.terminalId);
  if (kind === 'write') {
    if (typeof value.data !== 'string' || value.data.length > 1024 * 1024) throw new Error('终端输入无效');
    return { terminalId, data: value.data };
  }
  if (kind === 'resize') return { terminalId, ...validateTerminalSize(value.cols, value.rows) };
  throw new Error('终端操作无效');
}

function validateSearchQuery(value) {
  const query = typeof value === 'string' ? value.trim() : '';
  if (!query || query.length > 512) throw new Error('搜索内容无效');
  return query;
}

function validateSearchOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('搜索参数无效');
  const bounded = (input, fallback, min, max) => (Number.isInteger(input)
    ? Math.min(max, Math.max(min, input)) : fallback);
  return {
    query: validateSearchQuery(value.query),
    caseSensitive: value.caseSensitive === true,
    historyLines: bounded(value.historyLines, 20000, 100, 200000),
    maxPerPane: bounded(value.maxPerPane, 20, 1, 200),
    maxTotal: bounded(value.maxTotal, 200, 1, 1000),
  };
}

function validateRevealInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('搜索结果无效');
  if (!Number.isInteger(value.gotoLine) || value.gotoLine < 0) throw new Error('搜索结果无效');
  return {
    windowId: validateTarget(value.windowId, 'window'),
    paneId: validateTarget(value.paneId, 'pane'),
    gotoLine: value.gotoLine,
    historySize: Number.isInteger(value.historySize) ? value.historySize : null,
    query: validateSearchQuery(value.query),
    preview: typeof value.preview === 'string' ? value.preview.slice(0, 512) : '',
  };
}

function validateWindowBounds(value) {
  if (!value || typeof value !== 'object' || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))) {
    throw new Error('窗口尺寸无效');
  }
  if (value.width < 640 || value.height < 480) throw new Error('窗口尺寸无效');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(value[key])]));
}

function validateTabOrders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('页签顺序无效');
  const result = {};
  for (const [viewKey, order] of Object.entries(value)) {
    if (typeof viewKey !== 'string' || !viewKey) throw new Error('页签顺序无效');
    if (!Array.isArray(order) || order.length > 200) throw new Error('页签顺序无效');
    result[viewKey] = order.filter((item) => typeof item === 'string');
  }
  return result;
}

function validatePreferencesPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('偏好设置无效');
  const allowed = new Set(['theme', 'lastSession', 'windowBounds', 'sidebarWidth', 'tagRailExpanded', 'tagRailWidth', 'tabOrders', 'keepAwake', 'autoShare', 'tmuxSettings', 'terminalAppearance', 'pasteProtection', 'sessionRestore']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('偏好字段无效');
  }
  const result = {};
  if ('theme' in value) {
    if (!VALID_THEMES.has(value.theme)) throw new Error('主题无效');
    result.theme = value.theme;
  }
  if ('lastSession' in value) {
    if (value.lastSession === null) result.lastSession = null;
    else result.lastSession = validateSessionName(value.lastSession);
  }
  if ('windowBounds' in value) result.windowBounds = validateWindowBounds(value.windowBounds);
  if ('sidebarWidth' in value) {
    if (value.sidebarWidth !== null && (!Number.isFinite(value.sidebarWidth) || value.sidebarWidth < 100 || value.sidebarWidth > 1000)) {
      throw new Error('侧栏宽度无效');
    }
    result.sidebarWidth = value.sidebarWidth === null ? null : Math.round(value.sidebarWidth);
  }
  if ('tagRailExpanded' in value) {
    if (typeof value.tagRailExpanded !== 'boolean') throw new Error('Tag 栏展开状态无效');
    result.tagRailExpanded = value.tagRailExpanded;
  }
  if ('tagRailWidth' in value) {
    if (value.tagRailWidth !== null && (!Number.isFinite(value.tagRailWidth) || value.tagRailWidth < 100 || value.tagRailWidth > 1000)) {
      throw new Error('Tag 栏宽度无效');
    }
    result.tagRailWidth = value.tagRailWidth === null ? null : Math.round(value.tagRailWidth);
  }
  if ('keepAwake' in value) {
    if (typeof value.keepAwake !== 'boolean') throw new Error('保持唤醒设置无效');
    result.keepAwake = value.keepAwake;
  }
  if ('autoShare' in value) {
    if (typeof value.autoShare !== 'boolean') throw new Error('自动共享设置无效');
    result.autoShare = value.autoShare;
  }
  if ('tmuxSettings' in value) result.tmuxSettings = validateTmuxSettings(value.tmuxSettings);
  if ('terminalAppearance' in value) result.terminalAppearance = validateTerminalAppearance(value.terminalAppearance);
  if ('pasteProtection' in value) result.pasteProtection = validatePasteGuard(value.pasteProtection);
  if ('sessionRestore' in value) {
    if (!value.sessionRestore || typeof value.sessionRestore !== 'object' || Array.isArray(value.sessionRestore)) {
      throw new Error('会话快照设置无效');
    }
    result.sessionRestore = normalizeSessionRestore(value.sessionRestore);
  }
  if ('tabOrders' in value) result.tabOrders = validateTabOrders(value.tabOrders);
  return result;
}

// OSC 8 hyperlinks arrive from whatever is running in the pane — including a
// remote host over ssh — so the URL is untrusted input that ends up at the OS
// shell. Only the three schemes a terminal link plausibly needs are allowed;
// file:, javascript: and custom app schemes are exactly the ones that turn a
// printed escape sequence into code execution on the viewer's machine.
const OPENABLE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function validateExternalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error('链接无效');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('链接无效');
  }
  if (!OPENABLE_URL_PROTOCOLS.has(parsed.protocol)) throw new Error('仅支持打开 http / https / mailto 链接');
  return parsed.toString();
}

function validateFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('路径无效');
  }
  return value;
}

const CONNECTION_ID = /^[a-zA-Z0-9-]{1,64}$/;
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DOWNLOAD_MODES = new Set(['download', 'open', 'save-as']);

// A path in the remote session's namespace (tmux reports POSIX paths, WSL on
// Windows included), so it is checked as POSIX whatever this machine runs.
function validateSessionFilePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || value.includes('\0')) {
    throw new Error('路径无效');
  }
  return value;
}

function validateTransferId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !TRANSFER_ID.test(value)) throw new Error('传输编号无效');
  return value;
}

function validateRemoteFileRequest(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件传输参数无效');
  if (typeof value.connectionId !== 'string' || !CONNECTION_ID.test(value.connectionId)) throw new Error('远程主机无效');
  // The remote host may itself relay another host's session (r:<conn>:$n).
  if (!parseTarget(value.session)) throw new Error('tmux 目标无效');
  const base = { connectionId: value.connectionId, session: value.session, transferId: validateTransferId(value.transferId) };
  if (kind === 'download') {
    const mode = value.mode ?? 'download';
    if (!DOWNLOAD_MODES.has(mode)) throw new Error('下载方式无效');
    return { ...base, path: validateSessionFilePath(value.path), mode };
  }
  return { ...base, dir: validateSessionFilePath(value.dir), source: validateFilePath(value.source) };
}

function validateCopyInto(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件参数无效');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 200) throw new Error('文件列表无效');
  return { sources: value.sources.map(validateFilePath), dir: validateFilePath(value.dir) };
}

function buildTagExport(preferences) {
  return {
    type: 'tmux-desk-tags',
    version: 1,
    exportedAt: new Date().toISOString(),
    tags: preferences.tags,
    sessionTags: preferences.sessionTags,
    favorites: preferences.favorites,
  };
}

function registerIpc({ ipcMain, tmuxService, terminalManager, preferencesStore, chooseDirectory, fileBridge, tagFileIO, webControl, setAppLocale, keepAwakeController, snapshotService }) {
  const requireWebControl = () => {
    if (!webControl) throw new Error('Web 服务不可用');
    return webControl;
  };
  const requireSnapshot = () => {
    if (!snapshotService) throw new Error('会话快照服务不可用');
    return snapshotService;
  };
  // Every structural change to the session tree is worth a fresh snapshot, but
  // debounced: a burst of splits must not turn into a burst of tmux queries.
  const touchSnapshot = (reason) => { snapshotService?.scheduleSave(reason); };
  const handlers = {
    'system:get-status': () => tmuxService.getStatus(),
    'system:choose-directory': () => chooseDirectory(),
    // Grouped sessions the web server derives for phone clients are an
    // implementation detail — keep them out of the desktop session list.
    'sessions:list': async () => (await tmuxService.listSessions())
      .filter((session) => !session.name.startsWith(WEB_SESSION_PREFIX)),
    'sessions:detail': (_event, target) => tmuxService.getSessionDetail(validateTarget(target)),
    'sessions:create': async (_event, input) => {
      const created = await tmuxService.createSession(validateSessionInput(input));
      touchSnapshot('session-create');
      return created;
    },
    'sessions:duplicate': async (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('复制参数无效');
      const source = validateTarget(input.source);
      const sourceName = validateSessionName(input.sourceName);
      const name = validateSessionName(input.name);
      const created = await tmuxService.duplicateSession(source, name);
      await preferencesStore.copySessionTags(sourceName, created.name);
      touchSnapshot('session-duplicate');
      return created;
    },
    'sessions:rename': async (_event, input) => {
      if (!input || typeof input !== 'object') throw new Error('重命名参数无效');
      const target = validateTarget(input.target);
      const oldName = validateSessionName(input.oldName);
      const name = validateSessionName(input.name);
      await tmuxService.renameSession(target, name);
      await preferencesStore.renameSessionReferences(oldName, name);
      touchSnapshot('session-rename');
      return { name };
    },
    'sessions:kill': async (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('关闭参数无效');
      const target = validateTarget(input.target);
      const sessionName = validateSessionName(input.sessionName);
      await tmuxService.killSession(target);
      await preferencesStore.removeSessionTags(sessionName);
      touchSnapshot('session-kill');
      return true;
    },
    'sessions:toggle-favorite': (_event, name) => preferencesStore.toggleFavorite(validateSessionName(name)),
    'sessions:set-tags': (_event, input) => {
      const { sessionName, tagIds } = validateSessionTags(input);
      return preferencesStore.setSessionTags(sessionName, tagIds);
    },
    'codebases:discover': () => discoverCodebases(),
    'tags:create': (_event, name) => preferencesStore.createTag(validateTagMutation('create', name)),
    'tags:touch': (_event, id) => preferencesStore.touchTag(validateTagMutation('delete', id)),
    'tags:rename': (_event, input) => {
      const { id, name } = validateTagMutation('rename', input);
      return preferencesStore.renameTag(id, name);
    },
    'tags:delete': (_event, id) => preferencesStore.deleteTag(validateTagMutation('delete', id)),
    'tags:set-pinned': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tag 参数无效');
      if (typeof input.pinned !== 'boolean') throw new Error('Tag 参数无效');
      return preferencesStore.setTagPinned(normalizeTagId(input.id), input.pinned);
    },
    'tags:reorder-pinned': (_event, ids) => {
      if (!Array.isArray(ids) || ids.length > 200) throw new Error('Tag 顺序无效');
      return preferencesStore.reorderPinnedTags(ids.map((id) => normalizeTagId(id)));
    },
    'tags:export': async () => {
      const preferences = await preferencesStore.load();
      return tagFileIO.exportToFile(buildTagExport(preferences));
    },
    'tags:import': async () => {
      const { canceled, payload } = await tagFileIO.importFromFile();
      if (canceled) return { canceled: true };
      const preferences = await preferencesStore.importTagConfig(payload);
      return { canceled: false, preferences };
    },
    'remotes:add': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('远程连接参数无效');
      const parsed = parseConnectionInput(input);
      return preferencesStore.addRemoteConnection(parsed);
    },
    'remotes:remove': (_event, id) => {
      if (typeof id !== 'string' || !id) throw new Error('远程连接编号无效');
      return preferencesStore.removeRemoteConnection(id);
    },
    'remotes:set-reshare': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string') {
        throw new Error('远程连接参数无效');
      }
      return preferencesStore.setRemoteReshare(input.id, input.reshare === true);
    },
    'windows:select': (_event, target) => tmuxService.selectWindow(validateTarget(target, 'window')),
    'panes:select': (_event, target) => tmuxService.selectPane(validateTarget(target, 'pane')),
    'panes:kill': async (_event, target) => {
      const result = await tmuxService.killPane(validateTarget(target, 'pane'));
      touchSnapshot('pane-kill');
      return result;
    },
    'panes:resize': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('分屏尺寸参数无效');
      const target = validateTarget(input.target, 'pane');
      const size = {};
      for (const axis of ['x', 'y']) {
        if (input[axis] === undefined || input[axis] === null) continue;
        if (!Number.isInteger(input[axis]) || input[axis] < 1) throw new Error('分屏尺寸参数无效');
        size[axis] = input[axis];
      }
      if (!('x' in size) && !('y' in size)) throw new Error('分屏尺寸参数无效');
      return tmuxService.resizePane(target, size).then(() => true);
    },
    // Zoom / directional focus / broadcast input are all window-scoped tmux
    // actions addressed by the SESSION target, so they act on whatever window
    // and pane the session currently has active — the one the user is looking at.
    'panes:zoom': (_event, target) => tmuxService.toggleZoom(validateTarget(target, 'session')),
    'panes:navigate': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('分屏方向参数无效');
      if (!['left', 'right', 'up', 'down'].includes(input.direction)) throw new Error('分屏方向无效');
      return tmuxService.navigatePane(validateTarget(input.target, 'session'), input.direction);
    },
    'panes:broadcast': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('广播输入参数无效');
      if (typeof input.enabled !== 'boolean') throw new Error('广播输入参数无效');
      return tmuxService.setSynchronizePanes(validateTarget(input.target, 'session'), input.enabled);
    },
    'panes:split': async (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('分割参数无效');
      const target = validateTarget(input.target, 'session');
      const orientation = input.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      const result = await tmuxService.splitPane(target, orientation);
      touchSnapshot('pane-split');
      return result;
    },
    'app:set-locale': (_event, locale) => {
      if (typeof setAppLocale === 'function') setAppLocale(locale === 'en' ? 'en' : 'zh');
      return true;
    },
    'preferences:get': () => preferencesStore.load(),
    'preferences:save': async (_event, patch) => {
      const validated = validatePreferencesPatch(patch);
      const preferences = await preferencesStore.save(validated);
      if ('keepAwake' in validated) keepAwakeController?.setEnabled(preferences.keepAwake);
      // The native window material (vibrancy) picks its light/dark appearance
      // from nativeTheme, not from the renderer's data-theme — without this the
      // translucent rail/sidebar stay dark while the app paints light.
      // `nativeTheme` is undefined when this module is loaded outside Electron.
      if ('theme' in validated && nativeTheme) nativeTheme.themeSource = preferences.theme;
      if ('tmuxSettings' in validated) {
        await tmuxService.applySettingsToAllSessions(preferences.tmuxSettings, {
          localMouseSession: terminalManager.attachedSessionId?.() || null,
        });
      }
      // Re-arm the snapshot timer on the new interval and take one right away,
      // so toggling the feature on has a visible effect instead of waiting.
      if ('sessionRestore' in validated) snapshotService?.restart();
      return preferences;
    },
    'files:list': (_event, dirPath) => fileBridge.list(validateFilePath(dirPath)),
    'files:open': (_event, filePath) => fileBridge.open(validateFilePath(filePath)),
    'files:open-with': (_event, filePath) => fileBridge.openWith(validateFilePath(filePath)),
    'files:open-url': (_event, url) => fileBridge.openExternal(validateExternalUrl(url)),
    'files:reveal': (_event, filePath) => fileBridge.reveal(validateFilePath(filePath)),
    'files:remote-download': (_event, payload) => fileBridge.downloadRemote(validateRemoteFileRequest('download', payload)),
    'files:remote-upload': (_event, payload) => fileBridge.uploadRemote(validateRemoteFileRequest('upload', payload)),
    'files:copy-into': (_event, payload) => fileBridge.copyInto(validateCopyInto(payload)),
    'files:cancel-transfer': (_event, transferId) => fileBridge.cancelTransfer(validateTransferId(transferId)),
    'terminal:attach': (_event, payload) => {
      const validated = validateTerminalPayload('attach', payload);
      // Fire-and-forget: tmux applies session options live, so the client sees
      // the UX baseline (mouse, history…) even if this lands after the attach.
      preferencesStore.load()
        // localMouse: this client renders the session itself, so with the option
        // on tmux's own mouse handling is turned off for THIS session only —
        // selection/scroll become the front end's job, iTerm-style. Other
        // clients (the web app attaches to a grouped session) keep the global.
        .then((preferences) => tmuxService.applySessionDefaults(
          validated.sessionId, preferences.tmuxSettings, { localMouse: true },
        ))
        .catch(() => {});
      return terminalManager.attach(validated);
    },
    'terminal:write': (_event, payload) => terminalManager.write(validateTerminalPayload('write', payload)),
    'terminal:resize': (_event, payload) => terminalManager.resize(validateTerminalPayload('resize', payload)),
    'terminal:scroll': (_event, payload) => {
      const { sessionId, lines } = validateTerminalPayload('scroll', payload);
      return tmuxService.scrollSession(sessionId, lines);
    },
    'search:sessions': (_event, payload) => {
      const { query, ...options } = validateSearchOptions(payload);
      return tmuxService.searchSessions(query, options);
    },
    'search:reveal': (_event, payload) => tmuxService.revealMatch(validateRevealInput(payload)),
    'terminal:find': (_event, payload) => {
      const { sessionId, ...options } = validateTerminalPayload('find', payload);
      return tmuxService.findInSession(sessionId, options);
    },
    'terminal:clear': (_event, payload) => {
      const { sessionId } = validateTerminalPayload('clear', payload);
      return tmuxService.clearPane(sessionId);
    },
    'terminal:cancel-copy-mode': (_event, payload) => {
      const { sessionId } = validateTerminalPayload('cancel-copy-mode', payload);
      return tmuxService.cancelCopyMode(sessionId);
    },
    'terminal:detach': () => { terminalManager.dispose(); return true; },
    'web:status': (_event, sessionName) => requireWebControl().status(validateOptionalSessionName(sessionName)),
    'web:start': (_event, sessionName) => requireWebControl().start(validateOptionalSessionName(sessionName)),
    'web:stop': () => requireWebControl().stop(),
    'snapshot:status': () => requireSnapshot().health(),
    'snapshot:save': async () => {
      await requireSnapshot().save('manual');
      return snapshotService.health();
    },
    'snapshot:restore': async () => {
      const report = await requireSnapshot().restoreNow();
      return { report, status: snapshotService.health() };
    },
    'snapshot:repair-cwd': async () => {
      const result = await requireSnapshot().repairCwd();
      return { ...result, status: snapshotService.health() };
    },
    // Point the user at the snapshot + log files they may need to hand back.
    // Writing a line first guarantees the file exists, otherwise Finder ignores
    // the reveal on a machine that has never logged anything.
    'snapshot:reveal': async () => {
      await requireSnapshot().log('info', '用户打开了日志所在目录');
      return fileBridge.reveal(snapshotService.logPath);
    },
  };
  for (const channel of IPC_CHANNELS) ipcMain.handle(channel, handlers[channel]);
  return handlers;
}

module.exports = {
  IPC_CHANNELS,
  registerIpc,
  validatePreferencesPatch,
  validateOptionalSessionName,
  validateSessionInput,
  validateSessionTags,
  validateTagMutation,
  validateTarget,
  validateTerminalPayload,
  validateExternalUrl,
  validateRevealInput,
  validateSearchOptions,
  validateRemoteFileRequest,
  validateCopyInto,
};

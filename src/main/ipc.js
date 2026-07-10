const path = require('node:path');
const { normalizeTagId, normalizeTagName } = require('../shared/tag-model');

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
  'tags:create',
  'tags:rename',
  'tags:delete',
  'windows:select',
  'panes:select',
  'preferences:get',
  'preferences:save',
  'files:list',
  'files:open',
  'files:open-with',
  'files:reveal',
  'terminal:attach',
  'terminal:write',
  'terminal:resize',
  'terminal:detach',
  'web:status',
  'web:start',
  'web:stop',
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
  const terminalId = validateTerminalId(value.terminalId);
  if (kind === 'write') {
    if (typeof value.data !== 'string' || value.data.length > 1024 * 1024) throw new Error('终端输入无效');
    return { terminalId, data: value.data };
  }
  if (kind === 'resize') return { terminalId, ...validateTerminalSize(value.cols, value.rows) };
  throw new Error('终端操作无效');
}

function validateWindowBounds(value) {
  if (!value || typeof value !== 'object' || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))) {
    throw new Error('窗口尺寸无效');
  }
  if (value.width < 640 || value.height < 480) throw new Error('窗口尺寸无效');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Math.round(value[key])]));
}

function validatePreferencesPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('偏好设置无效');
  const allowed = new Set(['theme', 'lastSession', 'windowBounds']);
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
  return result;
}

function validateFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('路径无效');
  }
  return value;
}

function registerIpc({ ipcMain, tmuxService, terminalManager, preferencesStore, chooseDirectory, fileBridge, webControl }) {
  const requireWebControl = () => {
    if (!webControl) throw new Error('Web 服务不可用');
    return webControl;
  };
  const handlers = {
    'system:get-status': () => tmuxService.getStatus(),
    'system:choose-directory': () => chooseDirectory(),
    // Grouped sessions the web server derives for phone clients are an
    // implementation detail — keep them out of the desktop session list.
    'sessions:list': async () => (await tmuxService.listSessions())
      .filter((session) => !session.name.startsWith(WEB_SESSION_PREFIX)),
    'sessions:detail': (_event, target) => tmuxService.getSessionDetail(validateTarget(target)),
    'sessions:create': (_event, input) => tmuxService.createSession(validateSessionInput(input)),
    'sessions:duplicate': async (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('复制参数无效');
      const source = validateTarget(input.source);
      const sourceName = validateSessionName(input.sourceName);
      const name = validateSessionName(input.name);
      const created = await tmuxService.duplicateSession(source, name);
      await preferencesStore.copySessionTags(sourceName, created.name);
      return created;
    },
    'sessions:rename': async (_event, input) => {
      if (!input || typeof input !== 'object') throw new Error('重命名参数无效');
      const target = validateTarget(input.target);
      const oldName = validateSessionName(input.oldName);
      const name = validateSessionName(input.name);
      await tmuxService.renameSession(target, name);
      await preferencesStore.renameSessionReferences(oldName, name);
      return { name };
    },
    'sessions:kill': async (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('关闭参数无效');
      const target = validateTarget(input.target);
      const sessionName = validateSessionName(input.sessionName);
      await tmuxService.killSession(target);
      await preferencesStore.removeSessionTags(sessionName);
      return true;
    },
    'sessions:toggle-favorite': (_event, name) => preferencesStore.toggleFavorite(validateSessionName(name)),
    'sessions:set-tags': (_event, input) => {
      const { sessionName, tagIds } = validateSessionTags(input);
      return preferencesStore.setSessionTags(sessionName, tagIds);
    },
    'tags:create': (_event, name) => preferencesStore.createTag(validateTagMutation('create', name)),
    'tags:rename': (_event, input) => {
      const { id, name } = validateTagMutation('rename', input);
      return preferencesStore.renameTag(id, name);
    },
    'tags:delete': (_event, id) => preferencesStore.deleteTag(validateTagMutation('delete', id)),
    'windows:select': (_event, target) => tmuxService.selectWindow(validateTarget(target, 'window')),
    'panes:select': (_event, target) => tmuxService.selectPane(validateTarget(target, 'pane')),
    'preferences:get': () => preferencesStore.load(),
    'preferences:save': (_event, patch) => preferencesStore.save(validatePreferencesPatch(patch)),
    'files:list': (_event, dirPath) => fileBridge.list(validateFilePath(dirPath)),
    'files:open': (_event, filePath) => fileBridge.open(validateFilePath(filePath)),
    'files:open-with': (_event, filePath) => fileBridge.openWith(validateFilePath(filePath)),
    'files:reveal': (_event, filePath) => fileBridge.reveal(validateFilePath(filePath)),
    'terminal:attach': (_event, payload) => terminalManager.attach(validateTerminalPayload('attach', payload)),
    'terminal:write': (_event, payload) => terminalManager.write(validateTerminalPayload('write', payload)),
    'terminal:resize': (_event, payload) => terminalManager.resize(validateTerminalPayload('resize', payload)),
    'terminal:detach': () => { terminalManager.dispose(); return true; },
    'web:status': () => requireWebControl().status(),
    'web:start': () => requireWebControl().start(),
    'web:stop': () => requireWebControl().stop(),
  };
  for (const channel of IPC_CHANNELS) ipcMain.handle(channel, handlers[channel]);
  return handlers;
}

module.exports = {
  IPC_CHANNELS,
  registerIpc,
  validatePreferencesPatch,
  validateSessionInput,
  validateSessionTags,
  validateTagMutation,
  validateTarget,
  validateTerminalPayload,
};

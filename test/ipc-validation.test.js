const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IPC_CHANNELS,
  registerIpc,
  validateOptionalSessionName,
  validatePreferencesPatch,
  validateSessionInput,
  validateSessionTags,
  validateTagMutation,
  validateTarget,
  validateTerminalPayload,
  validateRemoteFileRequest,
  validateCopyInto,
} = require('../src/main/ipc');
const { DEFAULT_TMUX_SETTINGS } = require('../src/shared/tmux-settings');

test('rejects malformed tmux targets before reaching the service', () => {
  assert.throws(() => validateTarget('api; rm -rf ~'), /目标无效/);
  assert.equal(validateTarget('$12'), '$12');
  assert.equal(validateTarget('@3', 'window'), '@3');
  assert.equal(validateTarget('%9', 'pane'), '%9');
  assert.throws(() => validateTarget('$1', 'pane'), /目标无效/);
});

test('session input accepts local unicode values and rejects malformed fields', () => {
  assert.deepEqual(validateSessionInput({ name: ' 开发环境 ', cwd: '/Users/liwei/work', startupCommand: 'npm run dev' }), {
    name: '开发环境', cwd: '/Users/liwei/work', startupCommand: 'npm run dev',
  });
  assert.throws(() => validateSessionInput({ name: '', cwd: '/tmp' }), /会话名称/);
  assert.throws(() => validateSessionInput({ name: 'api', cwd: 'relative' }), /工作目录/);
  assert.throws(() => validateSessionInput({ name: 'api', cwd: '/tmp', startupCommand: 'one\ntwo' }), /启动命令/);
});

test('optional web share scope accepts a session name without changing full-access calls', () => {
  assert.equal(validateOptionalSessionName(undefined), null);
  assert.equal(validateOptionalSessionName(null), null);
  assert.equal(validateOptionalSessionName(' api '), 'api');
  assert.throws(() => validateOptionalSessionName('bad:name'), /会话名称/);
});

test('terminal IPC payload validates ids, dimensions, and bounded strings', () => {
  assert.deepEqual(validateTerminalPayload('attach', { sessionId: '$2', cols: 120, rows: 40 }), {
    sessionId: '$2', cols: 120, rows: 40,
  });
  assert.deepEqual(validateTerminalPayload('write', { terminalId: 3, data: 'ls\r' }), {
    terminalId: 3, data: 'ls\r',
  });
  assert.throws(() => validateTerminalPayload('resize', { terminalId: 3, cols: 5000, rows: 40 }), /终端尺寸/);
  assert.throws(() => validateTerminalPayload('write', { terminalId: -1, data: 'x' }), /终端编号/);
  assert.throws(() => validateTerminalPayload('write', { terminalId: 1, data: 'x'.repeat(1024 * 1024 + 1) }), /终端输入/);
});

test('preference patches allow only local UI preference fields', () => {
  assert.deepEqual(validatePreferencesPatch({
    theme: 'system', lastSession: 'api', windowBounds: { x: 1, y: 2, width: 1200, height: 800 }, sidebarWidth: 279.6,
  }), {
    theme: 'system', lastSession: 'api', windowBounds: { x: 1, y: 2, width: 1200, height: 800 }, sidebarWidth: 280,
  });
  assert.deepEqual(validatePreferencesPatch({ sidebarWidth: null }), { sidebarWidth: null });
  assert.deepEqual(validatePreferencesPatch({ tagRailExpanded: true }), { tagRailExpanded: true });
  assert.deepEqual(validatePreferencesPatch({ tagRailWidth: 259.6 }), { tagRailWidth: 260 });
  assert.deepEqual(validatePreferencesPatch({ tagRailWidth: null }), { tagRailWidth: null });
  assert.deepEqual(validatePreferencesPatch({ keepAwake: true }), { keepAwake: true });
  assert.throws(() => validatePreferencesPatch({ theme: 'sepia' }), /主题/);
  assert.throws(() => validatePreferencesPatch({ token: 'secret' }), /偏好字段/);
  assert.throws(() => validatePreferencesPatch({ windowBounds: { width: 2 } }), /窗口尺寸/);
  assert.throws(() => validatePreferencesPatch({ sidebarWidth: 50 }), /侧栏宽度/);
  assert.throws(() => validatePreferencesPatch({ sidebarWidth: 1001 }), /侧栏宽度/);
  assert.throws(() => validatePreferencesPatch({ tagRailExpanded: 'yes' }), /Tag 栏展开状态/);
  assert.throws(() => validatePreferencesPatch({ tagRailWidth: '260' }), /Tag 栏宽度/);
  assert.throws(() => validatePreferencesPatch({ tagRailWidth: 50 }), /Tag 栏宽度/);
  assert.throws(() => validatePreferencesPatch({ tagRailWidth: 1001 }), /Tag 栏宽度/);
  assert.throws(() => validatePreferencesPatch({ keepAwake: 'yes' }), /保持唤醒/);
  assert.deepEqual(
    validatePreferencesPatch({ tmuxSettings: { ...DEFAULT_TMUX_SETTINGS, mouse: false } }),
    { tmuxSettings: { ...DEFAULT_TMUX_SETTINGS, mouse: false } },
  );
  assert.throws(() => validatePreferencesPatch({ tmuxSettings: { mouse: 'yes' } }), /tmux 设置/);
  assert.throws(() => validatePreferencesPatch({ tmuxSettings: { statusRight: true } }), /未知字段/);
  assert.throws(() => validatePreferencesPatch({ tmuxSettings: null }), /tmux 设置/);
});

test('saving keep-awake preference applies the persisted value to the system controller', async () => {
  const handlers = new Map();
  const calls = [];
  registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    tmuxService: {},
    terminalManager: {},
    preferencesStore: {
      save: async (patch) => ({ theme: 'light', keepAwake: patch.keepAwake }),
    },
    keepAwakeController: { setEnabled: (enabled) => calls.push(enabled) },
    chooseDirectory: async () => null,
  });

  const preferences = await handlers.get('preferences:save')(null, { keepAwake: true });
  assert.equal(preferences.keepAwake, true);
  assert.deepEqual(calls, [true]);
});

test('saving tmux settings immediately applies the persisted profile to live sessions', async () => {
  const handlers = new Map();
  const applied = [];
  const settings = { ...DEFAULT_TMUX_SETTINGS, status: true };
  registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    tmuxService: { applySettingsToAllSessions: async (profile) => { applied.push(profile); return true; } },
    terminalManager: {},
    preferencesStore: { save: async (patch) => ({ theme: 'light', tmuxSettings: patch.tmuxSettings }) },
    chooseDirectory: async () => null,
  });

  const preferences = await handlers.get('preferences:save')(null, { tmuxSettings: settings });
  assert.equal(preferences.tmuxSettings.status, true);
  assert.deepEqual(applied, [settings]);
});

test('preference patches shape-check tabOrders but leave deep validation to the store', () => {
  assert.deepEqual(validatePreferencesPatch({ tabOrders: { favorites: ['api', 3, 'worker'] } }), {
    tabOrders: { favorites: ['api', 'worker'] },
  });
  assert.deepEqual(validatePreferencesPatch({ tabOrders: {} }), { tabOrders: {} });
  assert.throws(() => validatePreferencesPatch({ tabOrders: null }), /页签顺序/);
  assert.throws(() => validatePreferencesPatch({ tabOrders: { favorites: 'api' } }), /页签顺序/);
  assert.throws(() => validatePreferencesPatch({ tabOrders: { favorites: Array(201).fill('x') } }), /页签顺序/);
});

test('tag mutations validate names, ids, and deduplicated session associations', () => {
  assert.equal(validateTagMutation('create', ' DMS 渠道 '), 'DMS 渠道');
  assert.deepEqual(validateTagMutation('rename', { id: 'tag-abc', name: ' DMS ' }), {
    id: 'tag-abc', name: 'DMS',
  });
  assert.equal(validateTagMutation('delete', 'tag-abc'), 'tag-abc');
  assert.deepEqual(validateSessionTags({ sessionName: 'api', tagIds: ['tag-a', 'tag-a', 'tag-b'] }), {
    sessionName: 'api', tagIds: ['tag-a', 'tag-b'],
  });
  assert.throws(() => validateTagMutation('create', ''), /Tag 名称/);
  assert.throws(() => validateTagMutation('rename', { id: 'bad', name: 'DMS' }), /Tag 编号/);
  assert.throws(() => validateSessionTags({ sessionName: 'api', tagIds: ['bad'] }), /Tag 编号/);
  assert.throws(() => validateSessionTags({ sessionName: 'api', tagIds: Array(101).fill('tag-a') }), /Tag 列表/);
});

test('registerIpc exposes only the documented local channels', () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerIpc({
    ipcMain,
    tmuxService: {},
    terminalManager: {},
    preferencesStore: {},
    chooseDirectory: async () => null,
  });
  assert.deepEqual([...handlers.keys()].sort(), [...IPC_CHANNELS].sort());
  assert.equal([...handlers.keys()].some((channel) => channel.includes('exec')), false);
});

test('web IPC forwards a validated optional session name to status and start', async () => {
  const handlers = new Map();
  const calls = [];
  registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    tmuxService: {},
    terminalManager: {},
    preferencesStore: {},
    chooseDirectory: async () => null,
    webControl: {
      status: async (sessionName) => { calls.push(['status', sessionName]); return {}; },
      start: async (sessionName) => { calls.push(['start', sessionName]); return {}; },
      stop: async () => ({}),
    },
  });

  await handlers.get('web:status')(null, undefined);
  await handlers.get('web:status')(null, ' api ');
  await handlers.get('web:start')(null, 'worker');
  assert.throws(() => handlers.get('web:start')(null, 'bad:name'), /会话名称/);
  assert.deepEqual(calls, [['status', null], ['status', 'api'], ['start', 'worker']]);
});

test('tag and session lifecycle handlers update preferences after tmux succeeds', async () => {
  const handlers = new Map();
  const calls = [];
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  registerIpc({
    ipcMain,
    tmuxService: {
      duplicateSession: async (source, name) => {
        calls.push(['duplicate', source, name]);
        return { id: '$9', name };
      },
      renameSession: async (target, name) => calls.push(['rename', target, name]),
      killSession: async (target) => calls.push(['kill', target]),
    },
    terminalManager: {},
    preferencesStore: {
      createTag: async (name) => { calls.push(['createTag', name]); return { tags: [] }; },
      renameTag: async (id, name) => { calls.push(['renameTag', id, name]); return { tags: [] }; },
      deleteTag: async (id) => { calls.push(['deleteTag', id]); return { tags: [] }; },
      touchTag: async (id) => { calls.push(['touchTag', id]); return { tags: [] }; },
      setSessionTags: async (name, ids) => { calls.push(['setSessionTags', name, ids]); return { tags: [] }; },
      copySessionTags: async (source, target) => calls.push(['copySessionTags', source, target]),
      renameSessionReferences: async (oldName, newName) => calls.push(['renameSessionReferences', oldName, newName]),
      removeSessionTags: async (name) => calls.push(['removeSessionTags', name]),
    },
    chooseDirectory: async () => null,
  });

  assert.deepEqual(await handlers.get('tags:create')(null, ' DMS '), { tags: [] });
  await handlers.get('tags:rename')(null, { id: 'tag-one', name: '渠道' });
  await handlers.get('tags:delete')(null, 'tag-one');
  await handlers.get('tags:touch')(null, 'tag-one');
  await handlers.get('sessions:set-tags')(null, { sessionName: 'api', tagIds: ['tag-one', 'tag-one'] });
  assert.deepEqual(await handlers.get('sessions:duplicate')(null, {
    source: '$1', sourceName: 'api', name: 'api-copy',
  }), { id: '$9', name: 'api-copy' });
  await handlers.get('sessions:rename')(null, { target: '$1', oldName: 'api', name: 'backend' });
  assert.equal(await handlers.get('sessions:kill')(null, { target: '$1', sessionName: 'backend' }), true);

  assert.deepEqual(calls, [
    ['createTag', 'DMS'],
    ['renameTag', 'tag-one', '渠道'],
    ['deleteTag', 'tag-one'],
    ['touchTag', 'tag-one'],
    ['setSessionTags', 'api', ['tag-one']],
    ['duplicate', '$1', 'api-copy'],
    ['copySessionTags', 'api', 'api-copy'],
    ['rename', '$1', 'backend'],
    ['renameSessionReferences', 'api', 'backend'],
    ['kill', '$1'],
    ['removeSessionTags', 'backend'],
  ]);
});

test('failed tmux kill does not remove stored tag associations', async () => {
  const handlers = new Map();
  let removed = false;
  registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    tmuxService: { killSession: async () => { throw new Error('tmux failed'); } },
    terminalManager: {},
    preferencesStore: { removeSessionTags: async () => { removed = true; } },
    chooseDirectory: async () => null,
  });
  await assert.rejects(
    () => handlers.get('sessions:kill')(null, { target: '$1', sessionName: 'api' }),
    /tmux failed/,
  );
  assert.equal(removed, false);
});

test('attaching takes the mouse for this session only, and pane resizes are shape-checked', async () => {
  const handlers = new Map();
  const applied = [];
  const resizes = [];
  registerIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    tmuxService: {
      applySessionDefaults: async (target, settings, options) => { applied.push({ target, options }); return true; },
      resizePane: async (target, size) => { resizes.push({ target, size }); return true; },
    },
    terminalManager: { attach: () => ({ terminalId: 1 }) },
    preferencesStore: { load: async () => ({ tmuxSettings: DEFAULT_TMUX_SETTINGS }) },
    chooseDirectory: async () => null,
  });

  handlers.get('terminal:attach')(null, { sessionId: '$4', cols: 80, rows: 24 });
  await new Promise((resolve) => setImmediate(resolve)); // the profile write is fire-and-forget
  assert.deepEqual(applied, [{ target: '$4', options: { localMouse: true } }]);

  assert.equal(await handlers.get('panes:resize')(null, { target: '%2', x: 40 }), true);
  assert.deepEqual(resizes, [{ target: '%2', size: { x: 40 } }]);
  // Shape checks run before the service is touched, so they throw synchronously.
  assert.throws(() => handlers.get('panes:resize')(null, { target: '%2' }), /分屏尺寸参数无效/);
  assert.throws(() => handlers.get('panes:resize')(null, { target: '%2', x: 0 }), /分屏尺寸参数无效/);
  assert.throws(() => handlers.get('panes:resize')(null, { target: '$2', x: 4 }), /目标无效/);
});

test('remote file transfer requests are validated before reaching the main process', () => {
  assert.deepEqual(validateRemoteFileRequest('download', {
    connectionId: 'remote-abc', session: 'r:remote-x:$3', path: '/work/报告.md', mode: 'open', transferId: 't1',
  }), { connectionId: 'remote-abc', session: 'r:remote-x:$3', transferId: 't1', path: '/work/报告.md', mode: 'open' });
  assert.equal(validateRemoteFileRequest('download', { connectionId: 'remote-abc', session: '$1', path: '/a' }).mode, 'download');
  assert.throws(() => validateRemoteFileRequest('download', { connectionId: 'remote-abc', session: '$1', path: 'rel' }), /路径无效/);
  assert.throws(() => validateRemoteFileRequest('download', { connectionId: 'remote-abc', session: 'nope', path: '/a' }), /tmux 目标/);
  assert.throws(() => validateRemoteFileRequest('download', { connectionId: '../x', session: '$1', path: '/a' }), /远程主机/);
  assert.throws(() => validateRemoteFileRequest('download', { connectionId: 'remote-abc', session: '$1', path: '/a', mode: 'exec' }), /下载方式/);
  assert.throws(() => validateRemoteFileRequest('upload', { connectionId: 'remote-abc', session: '$1', dir: '/a', source: 'relative' }), /路径无效/);
  assert.throws(() => validateRemoteFileRequest('upload', { connectionId: 'remote-abc', session: '$1', dir: '/a', source: '/b', transferId: 'x y' }), /传输编号/);
  assert.deepEqual(validateCopyInto({ sources: ['/a', '/b'], dir: '/c' }), { sources: ['/a', '/b'], dir: '/c' });
  assert.throws(() => validateCopyInto({ sources: [], dir: '/c' }), /文件列表/);
  assert.throws(() => validateCopyInto({ sources: ['rel'], dir: '/c' }), /路径无效/);
});

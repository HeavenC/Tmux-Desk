const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IPC_CHANNELS,
  registerIpc,
  validatePreferencesPatch,
  validateSessionInput,
  validateSessionTags,
  validateTagMutation,
  validateTarget,
  validateTerminalPayload,
} = require('../src/main/ipc');

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
  assert.throws(() => validatePreferencesPatch({ theme: 'sepia' }), /主题/);
  assert.throws(() => validatePreferencesPatch({ token: 'secret' }), /偏好字段/);
  assert.throws(() => validatePreferencesPatch({ windowBounds: { width: 2 } }), /窗口尺寸/);
  assert.throws(() => validatePreferencesPatch({ sidebarWidth: 50 }), /侧栏宽度/);
  assert.throws(() => validatePreferencesPatch({ sidebarWidth: 1001 }), /侧栏宽度/);
  assert.throws(() => validatePreferencesPatch({ tagRailExpanded: 'yes' }), /Tag 栏展开状态/);
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

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');
const { WebSocket } = require('ws');

const { PreferencesStore } = require('../src/main/preferences-store');

// Keep the RED phase isolated from the user's real tmux server even when the
// production implementation has not started accepting an injected service.
const tmuxModulePath = require.resolve('../src/main/tmux-service');
const previousTmuxModule = require.cache[tmuxModulePath];
const terminalManagerModulePath = require.resolve('../src/main/terminal-manager');
const previousTerminalManagerModule = require.cache[terminalManagerModulePath];
class SafeDefaultTmuxService {
  async listSessions() { return []; }
  async killSession() {}
}
class SafeTerminalManager {
  attach() { return { terminalId: 1 }; }
  write() {}
  resize() {}
  dispose() {}
}
require.cache[tmuxModulePath] = {
  id: tmuxModulePath,
  filename: tmuxModulePath,
  loaded: true,
  exports: { TmuxService: SafeDefaultTmuxService },
};
require.cache[terminalManagerModulePath] = {
  id: terminalManagerModulePath,
  filename: terminalManagerModulePath,
  loaded: true,
  exports: { TerminalManager: SafeTerminalManager },
};
delete require.cache[require.resolve('../src/server/web-server')];
const {
  createSessionShareToken,
  probeExternalServer,
  startWebServer,
  verifySessionShareToken,
} = require('../src/server/web-server');
if (previousTmuxModule) require.cache[tmuxModulePath] = previousTmuxModule;
else delete require.cache[tmuxModulePath];
if (previousTerminalManagerModule) require.cache[terminalManagerModulePath] = previousTerminalManagerModule;
else delete require.cache[terminalManagerModulePath];

async function responseJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

function nextWebSocketMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(String(data))));
    ws.once('error', reject);
  });
}

test('web API projects shared tags and validates mobile session assignments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-web-test-'));
  const store = new PreferencesStore({
    filePath: join(root, 'preferences.json'),
    createId: (() => {
      const ids = ['one', 'two'];
      return () => ids.shift();
    })(),
  });
  let preferences = await store.createTag('DMS');
  const first = preferences.tags[0];
  preferences = await store.createTag('K8S');
  const second = preferences.tags.find((tag) => tag.name === 'K8S');
  await store.touchTag(first.id);
  await store.save({ favorites: ['worker'] });
  await store.setSessionTags('api', [first.id]);

  const sessions = [
    { id: '$1', name: 'api', activity: 10, windows: 1, paneCount: 1 },
    { id: '$2', name: 'worker', activity: 20, windows: 2, paneCount: 2 },
    { id: '$9', name: '_web_stale', activity: 30, windows: 1, paneCount: 1 },
  ];
  const killed = [];
  const tmuxCalls = [];
  const service = {
    listSessions: async () => sessions,
    killSession: async (target) => killed.push(target),
    run: async (args) => { tmuxCalls.push(args); return { stdout: '', stderr: '' }; },
  };
  let handle;
  try {
    handle = await startWebServer({
      port: 0,
      host: '127.0.0.1',
      token: 'test-token',
      service,
      preferencesStore: store,
    });
    assert.ok(handle.port > 0, 'port 0 must resolve to the actual loopback port');
    const base = `http://127.0.0.1:${handle.port}`;

    const list = await responseJson(`${base}/api/sessions?token=test-token`);
    assert.equal(list.response.status, 200);
    assert.deepEqual(list.body.sessions.map((session) => session.name), ['api', 'worker']);
    assert.deepEqual(list.body.preferences, {
      tags: [first, second],
      favorites: ['worker'],
      sessionTags: { api: [first.id] },
      tabOrders: {},
      webQuickKeys: [],
    });
    assert.equal('theme' in list.body.preferences, false);
    assert.deepEqual(killed, ['$9']);
    assert.deepEqual(tmuxCalls[0], ['set-option', '-g', 'aggressive-resize', 'on']);

    const webAsset = await fetch(`${base}/assets/styles.css`);
    assert.equal(webAsset.status, 200);
    assert.equal(webAsset.headers.get('cache-control'), 'no-store');

    const saved = await responseJson(`${base}/api/session-tags?token=test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'api',
        tagIds: [first.id, first.id, second.id],
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.body.preferences.sessionTags.api, [first.id, second.id]);
    assert.deepEqual((await store.load()).sessionTags.api, [first.id, second.id]);

    const missing = await responseJson(`${base}/api/session-tags?token=test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'missing', tagIds: [first.id] }),
    });
    assert.equal(missing.response.status, 404);
    assert.match(missing.body.error, /会话不存在/);

    const malformed = await responseJson(`${base}/api/session-tags?token=test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'api', tagIds: ['invalid'] }),
    });
    assert.equal(malformed.response.status, 400);
    assert.match(malformed.body.error, /Tag 编号/);

    const unauthorized = await responseJson(`${base}/api/sessions?token=wrong`);
    assert.equal(unauthorized.response.status, 401);
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('web terminal attach inherits the tmux service socket', async () => {
  const source = await readFile(join(__dirname, '..', 'src', 'server', 'web-server.js'), 'utf8');
  assert.match(source, /new TerminalManager\(\{[\s\S]*?socketName:\s*service\.socketName,[\s\S]*?sendEvent:/);
});

test('session-scoped shares only expose and control their selected session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-web-scope-test-'));
  const store = new PreferencesStore({ filePath: join(root, 'preferences.json') });
  let preferences = await store.createTag('Shared');
  const tag = preferences.tags[0];
  preferences = await store.createTag('Private worker metadata');
  const workerTag = preferences.tags.find((item) => item.name === 'Private worker metadata');
  await store.save({
    favorites: ['api', 'worker'],
    sessionTags: { api: [tag.id], worker: [workerTag.id] },
    tabOrders: {
      favorites: ['worker', 'api'],
      [tag.id]: ['worker', 'api'],
    },
    webQuickKeys: [{ type: 'preset', id: 'esc' }],
  });

  const sessions = [
    { id: '$1', name: 'api', activity: 10, windows: 1, paneCount: 1 },
    { id: '$2', name: 'worker', activity: 20, windows: 1, paneCount: 1 },
  ];
  const details = [];
  const tmuxCalls = [];
  const killed = [];
  const mouseEnabled = [];
  let nextGrouped = 50;
  const service = {
    socketName: 'test-socket',
    listSessions: async () => sessions,
    killSession: async (target) => killed.push(target),
    resolveTmuxPath: async () => '/fake/tmux',
    applySessionDefaults: async (target) => { mouseEnabled.push(target); return true; },
    getSessionDetail: async (target) => {
      details.push(target);
      return { windows: [{ id: '@1', index: 0, name: 'main', active: true, panes: 1 }], panes: [] };
    },
    run: async (args) => {
      tmuxCalls.push(args);
      if (args[0] === 'new-session') return { stdout: `$${nextGrouped++}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
  };

  let handle;
  let allowedSocket;
  let deniedSocket;
  try {
    handle = await startWebServer({
      port: 0,
      host: '127.0.0.1',
      token: 'test-token',
      service,
      preferencesStore: store,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const share = createSessionShareToken('test-token', 'api');
    const workerShare = createSessionShareToken('test-token', 'worker');
    const [sharePayload, shareSignature] = share.split('.');
    const tamperedShare = `${sharePayload}.${shareSignature[0] === 'A' ? 'B' : 'A'}${shareSignature.slice(1)}`;
    const shareQuery = `share=${encodeURIComponent(share)}`;
    const workerShareQuery = `share=${encodeURIComponent(workerShare)}`;
    assert.deepEqual(verifySessionShareToken('test-token', share), { sessionName: 'api' });
    assert.equal(share.includes('test-token'), false);
    assert.equal(verifySessionShareToken('wrong-token', share), null);
    assert.equal(verifySessionShareToken('test-token', tamperedShare), null);

    const scoped = await responseJson(`${base}/api/sessions?${shareQuery}`);
    assert.equal(scoped.response.status, 200);
    assert.deepEqual(scoped.body.sessions.map((session) => session.name), ['api']);
    assert.deepEqual(scoped.body.preferences.favorites, ['api']);
    assert.deepEqual(scoped.body.preferences.tags, [tag]);
    assert.deepEqual(scoped.body.preferences.sessionTags, { api: [tag.id] });
    assert.deepEqual(scoped.body.preferences.tabOrders, {
      favorites: ['api'],
      [tag.id]: ['api'],
    });
    assert.deepEqual(scoped.body.preferences.webQuickKeys, []);
    assert.equal(await probeExternalServer({ port: handle.port, share }), true);
    assert.equal(await probeExternalServer({ port: handle.port, share: tamperedShare }), false);

    const scopedQuickKeys = await responseJson(`${base}/api/quick-keys?${shareQuery}`);
    assert.equal(scopedQuickKeys.response.status, 200);
    assert.deepEqual(scopedQuickKeys.body.keys, []);

    const invalidShare = await responseJson(`${base}/api/sessions?share=${encodeURIComponent(tamperedShare)}`);
    assert.equal(invalidShare.response.status, 401);

    const global = await responseJson(`${base}/api/sessions?token=test-token`);
    assert.deepEqual(global.body.sessions.map((session) => session.name), ['api', 'worker']);

    const tagWrite = await responseJson(`${base}/api/session-tags?${shareQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'api', tagIds: [] }),
    });
    assert.equal(tagWrite.response.status, 403);
    assert.deepEqual((await store.load()).sessionTags.api, [tag.id]);

    const quickKeyWrite = await responseJson(`${base}/api/quick-keys?${shareQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    assert.equal(quickKeyWrite.response.status, 403);
    assert.deepEqual((await store.load()).webQuickKeys, [{ type: 'preset', id: 'esc' }]);

    const forbiddenDetail = await responseJson(`${base}/api/session-detail?${shareQuery}&session=%242`);
    assert.equal(forbiddenDetail.response.status, 403);
    assert.deepEqual(details, []);

    allowedSocket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?${shareQuery}&session=%241`);
    const ready = await nextWebSocketMessage(allowedSocket);
    assert.equal(ready.type, 'ready');
    assert.equal(ready.grouped, '$50');
    // The attach must apply the tmux UX baseline (mouse etc.) to the grouped
    // session. It's fire-and-forget behind a preferences load — poll briefly.
    for (let i = 0; i < 100 && mouseEnabled.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(mouseEnabled, ['$50']);

    const allowedDetail = await responseJson(`${base}/api/session-detail?${shareQuery}&session=%2450`);
    assert.equal(allowedDetail.response.status, 200);
    assert.deepEqual(details, ['$50']);

    const forbiddenSelect = await responseJson(`${base}/api/select-window?${workerShareQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grouped: '$50', windowIndex: 0 }),
    });
    assert.equal(forbiddenSelect.response.status, 403);

    const allowedSelect = await responseJson(`${base}/api/select-window?${shareQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grouped: '$50', windowIndex: 0 }),
    });
    assert.equal(allowedSelect.response.status, 200);
    assert.ok(tmuxCalls.some((args) => args[0] === 'select-window' && args[2] === '$50:0'));

    deniedSocket = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?${shareQuery}&session=%242`);
    const denied = await nextWebSocketMessage(deniedSocket);
    assert.equal(denied.type, 'error');
    assert.match(denied.message, /无权访问/);
    assert.equal(tmuxCalls.filter((args) => args[0] === 'new-session').length, 1);
  } finally {
    allowedSocket?.close();
    deniedSocket?.close();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
});

const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const { PreferencesStore } = require('../src/main/preferences-store');

// Keep the RED phase isolated from the user's real tmux server even when the
// production implementation has not started accepting an injected service.
const tmuxModulePath = require.resolve('../src/main/tmux-service');
const previousTmuxModule = require.cache[tmuxModulePath];
class SafeDefaultTmuxService {
  async listSessions() { return []; }
  async killSession() {}
}
require.cache[tmuxModulePath] = {
  id: tmuxModulePath,
  filename: tmuxModulePath,
  loaded: true,
  exports: { TmuxService: SafeDefaultTmuxService },
};
delete require.cache[require.resolve('../src/server/web-server')];
const { startWebServer } = require('../src/server/web-server');
if (previousTmuxModule) require.cache[tmuxModulePath] = previousTmuxModule;
else delete require.cache[tmuxModulePath];

async function responseJson(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
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

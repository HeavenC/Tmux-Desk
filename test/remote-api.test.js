// The desktop takeover client must never inherit the OS TCP timeout: a saved host
// whose address went stale (VM moved networks, laptop asleep) answers nothing at
// all, and an unbounded fetch would freeze the source switch for ~75s on macOS.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { RemoteApi, normalizeViewPreferences } = require('../src/renderer/remote-api');
const { sessionsForView } = require('../src/shared/session-model');

// A server that accepts the connection and then simply never replies — the same
// shape as a black-holed host, but deterministic.
function startSilentServer() {
  const server = http.createServer(() => { /* never respond */ });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, server });
    });
  });
}

test('a request against an unresponsive host rejects on its own deadline', async () => {
  const { base, server } = await startSilentServer();
  try {
    const api = new RemoteApi({ base, token: 'tok' });
    const started = Date.now();
    await assert.rejects(() => api.request('/api/sessions', { timeout: 400 }), /超时/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `expected the deadline to fire, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('probe reports an unreachable host instead of throwing, and bounds itself tighter', async () => {
  const { base, server } = await startSilentServer();
  try {
    const api = new RemoteApi({ base, token: 'tok' });
    const started = Date.now();
    const result = await api.probe();
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
    assert.ok(elapsed < 4000, `probe should stay snappy, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('probe reports a reachable host with a latency reading', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: [{ id: '$0', name: 'demo' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = new RemoteApi({ base: `http://127.0.0.1:${server.address().port}`, token: 'tok' });
    const result = await api.probe();
    assert.equal(result.ok, true);
    assert.equal(result.sessions, 1);
    assert.ok(Number.isFinite(result.ms));
  } finally {
    server.close();
  }
});

// Viewing another host's sessions from here: they were tagged over THERE, so the
// tag rail has to use that host's tags — this machine's sessionTags are keyed by
// its own session names and select nothing on the remote list.
test('listSessionsWithPreferences carries the remote host\'s own tag config', async () => {
  const remotePreferences = {
    tags: [
      { id: 'tag-vm', name: 'vm-work', color: 'blue', pinned: true },
      { id: 'tag-bad', name: 'bad color', color: 'url(x)' },
    ],
    sessionTags: { api: ['tag-vm'], db: ['tag-vm', 'tag-bad', 'tag-gone'], 'bad.name': ['tag-vm'] },
    favorites: ['db', 42],
    tabOrders: { 'tag-vm': ['db', 'api', null] },
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      sessions: [{ id: '$1', name: 'api' }, { id: '$2', name: 'db' }, { id: '$3', name: 'scratch' }],
      preferences: remotePreferences,
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = new RemoteApi({ base: `http://127.0.0.1:${server.address().port}`, token: 'tok' });
    const { sessions, preferences } = await api.listSessionsWithPreferences();
    assert.equal(sessions.length, 3);
    assert.deepEqual(preferences.tags, [{ id: 'tag-vm', name: 'vm-work', color: 'blue', pinned: true }]);
    assert.deepEqual(preferences.sessionTags, { api: ['tag-vm'], db: ['tag-vm'] });
    assert.deepEqual(preferences.favorites, ['db']);
    assert.deepEqual(preferences.tabOrders, { 'tag-vm': ['db', 'api'] });

    const view = { kind: 'tag', tagId: 'tag-vm' };
    assert.deepEqual(sessionsForView(sessions, preferences, view).map((s) => s.name), ['db', 'api']);
    // What the rail did before: the local machine's tags against remote names.
    const local = { tags: [{ id: 'tag-vm', name: 'x', color: 'blue' }], sessionTags: { 'host-only': ['tag-vm'] } };
    assert.deepEqual(sessionsForView(sessions, local, view), []);

    assert.deepEqual((await api.listSessions()).map((s) => s.name), ['api', 'db', 'scratch']);
  } finally {
    server.close();
  }
});

test('normalizeViewPreferences tolerates an older host that sends no preferences', () => {
  assert.deepEqual(normalizeViewPreferences(undefined), { tags: [], sessionTags: {}, favorites: [], tabOrders: {} });
  assert.deepEqual(normalizeViewPreferences([]), { tags: [], sessionTags: {}, favorites: [], tabOrders: {} });
});

const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const { PreferencesStore } = require('../src/main/preferences-store');
const { parseTarget, qualifyTarget, parseConnectionInput } = require('../src/shared/remote-connection');
const { startWebServer, createSessionShareToken } = require('../src/server/web-server');

test('remote target qualify/parse round-trips and rejects malformed ids', () => {
  assert.equal(qualifyTarget('remote-abc', '$7'), 'r:remote-abc:$7');
  assert.deepEqual(parseTarget('$3'), { kind: 'local', id: '$3' });
  assert.deepEqual(parseTarget('r:remote-abc:$7'), { kind: 'remote', connId: 'remote-abc', id: '$7' });
  assert.equal(parseTarget('r:bad:@3'), null);
  assert.equal(parseTarget('nonsense'), null);
});

test('parseConnectionInput extracts token from a share URL and keeps subpaths', () => {
  assert.deepEqual(parseConnectionInput({ url: '192.168.0.5:8790', token: 'abc' }),
    { base: 'http://192.168.0.5:8790', token: 'abc', label: '192.168.0.5:8790' });
  assert.deepEqual(parseConnectionInput({ url: 'https://h/tmux/?token=zz', label: 'VM' }),
    { base: 'https://h/tmux', token: 'zz', label: 'VM' });
  assert.throws(() => parseConnectionInput({ url: 'http://h/', token: '' }), /访问令牌/);
});

test('preferences store adds, dedupes, reshare-toggles and removes remote connections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-remotes-'));
  try {
    const store = new PreferencesStore({
      filePath: join(root, 'preferences.json'),
      createId: (() => { let n = 0; return () => `c${++n}`; })(),
    });
    const first = await store.addRemoteConnection({ base: 'http://a:8790/', token: 't1', label: 'A' });
    assert.equal(first.connection.id, 'remote-c1');
    assert.equal(first.connection.base, 'http://a:8790');
    assert.equal(first.connection.reshare, false);
    // Re-adding the same base updates in place instead of duplicating.
    const again = await store.addRemoteConnection({ base: 'http://a:8790', token: 't1b', label: 'A2' });
    assert.equal(again.connection.id, 'remote-c1');
    assert.equal((await store.load()).remoteConnections.length, 1);
    assert.equal((await store.load()).remoteConnections[0].token, 't1b');

    await store.addRemoteConnection({ base: 'http://b:8790', token: 't2', label: 'B' });
    const enabled = await store.setRemoteReshare('remote-c1', true);
    assert.equal(enabled.remoteConnections.find((c) => c.id === 'remote-c1').reshare, true);
    assert.equal(enabled.remoteConnections.find((c) => c.id === 'remote-c1a')?.reshare, undefined);

    const removed = await store.removeRemoteConnection('remote-c1');
    assert.equal(removed.remoteConnections.length, 1);
    assert.equal(removed.remoteConnections[0].label, 'B');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function localServiceStub() {
  return {
    socketName: null,
    async run() { return { stdout: '' }; },
    async listSessions() {
      return [{ id: '$1', name: 'local1', attached: false, windows: 1, activity: 0, path: '/', paneCount: 1, activeCommand: 'zsh' }];
    },
    async killSession() {},
    async resolveTmuxPath() { return '/usr/bin/tmux'; },
    async getSessionDetail() { return { windows: [], panes: [] }; },
    async applySessionDefaults() {},
  };
}

// A stand-in for the upstream device "A": answers the same REST protocol the real
// web-server does, so device "B" can relay to it without a real tmux upstream.
function startMockUpstream(token) {
  const selectCalls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://internal');
    res.setHeader('Content-Type', 'application/json');
    if (url.searchParams.get('token') !== token) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'bad token' })); return;
    }
    if (url.pathname === '/api/sessions') {
      res.end(JSON.stringify({ ok: true, sessions: [
        { id: '$7', name: 'remoteSess', attached: false, windows: 2, activity: 0, path: '/r', paneCount: 1, activeCommand: 'vim' },
      ] }));
      return;
    }
    if (url.pathname === '/api/quick-keys' && req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, keys: [{ type: 'text', label: 'A-key', text: 'from-A', enter: true }] }));
      return;
    }
    if (url.pathname === '/api/session-detail') {
      res.end(JSON.stringify({ ok: true, session: url.searchParams.get('session'),
        windows: [{ id: '@3', index: 0, name: 'w', active: true, panes: 1 }], panes: [] }));
      return;
    }
    if (url.pathname === '/api/select-window' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { selectCalls.push(JSON.parse(body || '{}')); res.end(JSON.stringify({ ok: true })); });
      return;
    }
    res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'nope' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, selectCalls }));
  });
}

test('web-server aggregates + proxies reshare-enabled remotes (REST relay)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-relay-'));
  const upstream = await startMockUpstream('Atoken');
  let handle = null;
  try {
    const store = new PreferencesStore({
      filePath: join(root, 'preferences.json'),
      createId: (() => { let n = 0; return () => `c${++n}`; })(),
    });
    // One reshare-enabled remote (A) and one that stays private.
    await store.addRemoteConnection({ base: `http://127.0.0.1:${upstream.port}`, token: 'Atoken', label: 'A' });
    await store.setRemoteReshare('remote-c1', true);
    await store.addRemoteConnection({ base: 'http://127.0.0.1:59999', token: 'Xtoken', label: 'Private' });

    handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 'Btoken', service: localServiceStub(), preferencesStore: store });
    const b = `http://127.0.0.1:${handle.port}`;

    // Full-token list = local + qualified reshared remote; private remote excluded.
    const list = await (await fetch(`${b}/api/sessions?token=Btoken`)).json();
    const ids = list.sessions.map((s) => s.id).sort();
    assert.deepEqual(ids, ['$1', 'r:remote-c1:$7']);
    const remote = list.sessions.find((s) => s.id === 'r:remote-c1:$7');
    assert.equal(remote.name, 'remoteSess');
    assert.equal(remote.source.label, 'A');
    assert.ok(!list.sessions.some((s) => s.source && s.source.label === 'Private'));

    // Detail for a remote id is proxied through to the upstream host.
    const detail = await (await fetch(`${b}/api/session-detail?token=Btoken&session=r:remote-c1:$7`)).json();
    assert.equal(detail.ok, true);
    assert.equal(detail.windows.length, 1);
    assert.equal(detail.windows[0].id, '@3');

    // Window switch on a relayed grouped id routes to the upstream, unqualified.
    const sw = await fetch(`${b}/api/select-window?token=Btoken`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grouped: 'r:remote-c1:$9', windowIndex: 2 }),
    });
    assert.equal(sw.status, 200);
    assert.deepEqual(upstream.selectCalls.at(-1), { grouped: '$9', windowIndex: 2 });

    // Quick keys follow the session's host: a remote target relays to the
    // upstream's bar, while a local/absent target returns this host's own bar.
    await store.setWebQuickKeys([{ type: 'preset', id: 'esc' }]);
    const remoteKeys = await (await fetch(`${b}/api/quick-keys?token=Btoken&session=r:remote-c1:$7`)).json();
    assert.deepEqual(remoteKeys.keys, [{ type: 'text', label: 'A-key', text: 'from-A', enter: true }]);
    const localKeys = await (await fetch(`${b}/api/quick-keys?token=Btoken`)).json();
    assert.deepEqual(localKeys.keys, [{ type: 'preset', id: 'esc' }]);

    // A scoped single-session share never sees relayed remotes.
    const share = createSessionShareToken('Btoken', 'local1');
    const scoped = await (await fetch(`${b}/api/sessions?share=${share}`)).json();
    assert.deepEqual(scoped.sessions.map((s) => s.id), ['$1']);
    const blocked = await fetch(`${b}/api/session-detail?share=${share}&session=r:remote-c1:$7`);
    assert.equal(blocked.status, 403);
  } finally {
    if (handle) await handle.close();
    await new Promise((resolve) => upstream.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

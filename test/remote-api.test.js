// The desktop takeover client must never inherit the OS TCP timeout: a saved host
// whose address went stale (VM moved networks, laptop asleep) answers nothing at
// all, and an unbounded fetch would freeze the source switch for ~75s on macOS.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { RemoteApi } = require('../src/renderer/remote-api');

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

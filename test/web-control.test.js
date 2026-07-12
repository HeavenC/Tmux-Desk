const assert = require('node:assert/strict');
const test = require('node:test');

const { createWebControl, sessionShareUrls } = require('../src/main/web-control');

test('session share URLs replace the global token with only an opaque share capability', () => {
  const [entry] = sessionShareUrls([
    { kind: 'lan', url: 'http://192.168.1.2:17890/?token=global-secret' },
  ], 'opaque/value');
  const url = new URL(entry.url);
  assert.equal(url.searchParams.get('share'), 'opaque/value');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.has('scope'), false);
});

test('web control keeps full-access URLs unchanged and mints scoped URLs on demand', async () => {
  const calls = [];
  const probes = [];
  const control = createWebControl({
    port: 12345,
    loadWebToken: () => 'global-secret',
    listUrls: async () => [{ kind: 'lan', url: 'http://10.0.0.2:12345/?token=global-secret' }],
    createShareToken: (token, sessionName) => {
      calls.push([token, sessionName]);
      return `share-${sessionName}`;
    },
    probeServer: async (input) => { probes.push(input); return true; },
  });

  const full = await control.status();
  assert.equal(new URL(full.urls[0].url).searchParams.get('token'), 'global-secret');

  const scoped = await control.status('api');
  const scopedUrl = new URL(scoped.urls[0].url);
  assert.equal(scopedUrl.searchParams.get('share'), 'share-api');
  assert.equal(scopedUrl.searchParams.has('token'), false);
  assert.deepEqual(calls, [['global-secret', 'api'], ['global-secret', 'api']]);
  assert.deepEqual(probes, [
    { port: 12345, token: 'global-secret' },
    { port: 12345, token: 'global-secret' },
    { port: 12345, share: 'share-api' },
  ]);
});

test('web control rejects a session link when an old external daemon only understands the global token', async () => {
  const control = createWebControl({
    port: 8790,
    loadWebToken: () => 'global-secret',
    createShareToken: () => 'share-api',
    probeServer: async ({ token, share }) => Boolean(token) && !share,
  });

  await assert.rejects(
    () => control.status('api'),
    /旧版 Web 服务占用[\s\S]*npm run serve:web/,
  );
  await assert.rejects(
    () => control.start('api'),
    /旧版 Web 服务占用/,
  );
});

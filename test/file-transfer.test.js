const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const test = require('node:test');

const { PreferencesStore } = require('../src/main/preferences-store');
const {
  contentDisposition,
  copyIntoDirectory,
  downloadToFile,
  hostUrl,
  listSessionDirectory,
  receiveSessionUpload,
  resolveSessionPath,
  sessionRoots,
  uploadFromFile,
  validateTransferName,
} = require('../src/main/file-transfer');
const { createTransferBridge } = require('../src/main/transfer-bridge');
const { startWebServer, createSessionShareToken } = require('../src/server/web-server');

function detailFor(...paths) {
  return {
    windows: [{ id: '@1', index: 1, active: true }],
    panes: paths.map((panePath, index) => ({ id: `%${index}`, windowId: '@1', active: index === 0, path: panePath })),
  };
}

function bodyStream(text, headers = {}) {
  const stream = Readable.from([Buffer.from(text)]);
  stream.headers = { 'content-length': String(Buffer.byteLength(text)), ...headers };
  return stream;
}

test('session roots put the focused pane first and dedupe', () => {
  const detail = {
    windows: [{ id: '@1', active: false }, { id: '@2', active: true }],
    panes: [
      { windowId: '@1', active: true, path: '/w/one' },
      { windowId: '@2', active: false, path: '/w/two' },
      { windowId: '@2', active: true, path: '/w/three/' },
      { windowId: '@2', active: false, path: '/w/one' },
    ],
  };
  assert.deepEqual(sessionRoots(detail), { root: '/w/three', roots: ['/w/three', '/w/one', '/w/two'] });
  assert.deepEqual(sessionRoots({}), { root: null, roots: [] });
});

test('paths are confined to the session directories, traversal included', () => {
  const detail = detailFor('/work/app', '/work/lib');
  assert.equal(resolveSessionPath(detail, null).path, '/work/app');
  assert.equal(resolveSessionPath(detail, '/work/app/src/../README.md').path, '/work/app/README.md');
  assert.equal(resolveSessionPath(detail, '/work/lib/x').path, '/work/lib/x');
  assert.throws(() => resolveSessionPath(detail, '/work/app/../../etc/passwd'), (error) => error.status === 403);
  assert.throws(() => resolveSessionPath(detail, '/work/application'), (error) => error.status === 403);
  assert.throws(() => resolveSessionPath(detail, 'relative/x'), (error) => error.status === 400);
  assert.throws(() => resolveSessionPath(detail, '/work/app/\0x'), (error) => error.status === 400);
  assert.throws(() => resolveSessionPath(detailFor(), null), (error) => error.status === 404);
  // A pane sitting in / already has the whole disk through its shell.
  assert.equal(resolveSessionPath(detailFor('/'), '/etc').path, '/etc');
});

test('transfer names keep unicode and spaces but never escape the folder', () => {
  assert.equal(validateTransferName(' 需求 文档.md '), '需求 文档.md');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x\0y', 'line\nbreak', 'x'.repeat(256), 42]) {
    assert.throws(() => validateTransferName(bad), /文件名无效/);
  }
});

test('content disposition carries the exact UTF-8 name with an ASCII fallback', () => {
  assert.equal(
    contentDisposition('报告 (final).md'),
    "attachment; filename=\"__ (final).md\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%28final%29.md",
  );
});

test('listing returns session-namespace paths and a parent only inside the roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-files-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'a.txt'), 'hello');
    await writeFile(join(root, 'src', 'b.js'), '1');
    const detail = detailFor(root);
    const top = await listSessionDirectory(detail, null);
    assert.equal(top.path, root);
    assert.equal(top.parent, null);
    assert.deepEqual(top.entries.map((entry) => [entry.name, entry.isDir, entry.size]), [['src', true, 0], ['a.txt', false, 5]]);
    assert.equal(top.entries[0].path, `${root}/src`);
    assert.ok(top.entries[1].mtime > 0);
    const nested = await listSessionDirectory(detail, `${root}/src`);
    assert.equal(nested.parent, root);
    await assert.rejects(listSessionDirectory(detail, `${root}/missing`), (error) => error.status === 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uploads land complete, never clobber, and leave nothing behind on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-upload-'));
  try {
    const detail = detailFor(root);
    const first = await receiveSessionUpload(bodyStream('one'), detail, { dir: root, name: 'notes.md' });
    assert.deepEqual(first, { name: 'notes.md', path: `${root}/notes.md`, size: 3 });
    const second = await receiveSessionUpload(bodyStream('two'), detail, { dir: root, name: 'notes.md' });
    assert.equal(second.name, 'notes (1).md');
    assert.equal(await readFile(join(root, 'notes.md'), 'utf8'), 'one');
    assert.equal(await readFile(join(root, 'notes (1).md'), 'utf8'), 'two');

    await assert.rejects(
      receiveSessionUpload(bodyStream('x'.repeat(64), { 'content-length': undefined }), detail, { dir: root, name: 'big.bin', limit: 10 }),
      (error) => error.status === 413,
    );
    await assert.rejects(receiveSessionUpload(bodyStream('x'), detail, { dir: '/etc', name: 'x' }), (error) => error.status === 403);
    await assert.rejects(receiveSessionUpload(bodyStream('x'), detail, { dir: root, name: '../x' }), /文件名无效/);
    // Only the two good uploads: no temp parts, no empty claims.
    assert.deepEqual((await readdir(root)).sort(), ['notes (1).md', 'notes.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local copy keeps both names and refuses copying a folder into itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-copy-'));
  try {
    const source = join(root, 'source');
    const dest = join(root, 'dest');
    await mkdir(join(source, 'nested'), { recursive: true });
    await mkdir(dest);
    await writeFile(join(source, 'nested', 'deep.txt'), 'deep');
    await writeFile(join(root, 'file.txt'), 'f');
    await writeFile(join(dest, 'file.txt'), 'existing');
    const copied = await copyIntoDirectory([join(root, 'file.txt'), source], dest);
    assert.deepEqual(copied.map((item) => item.name), ['file (1).txt', 'source']);
    assert.equal(await readFile(join(dest, 'file.txt'), 'utf8'), 'existing');
    assert.equal(await readFile(join(dest, 'source', 'nested', 'deep.txt'), 'utf8'), 'deep');
    await assert.rejects(copyIntoDirectory([source], join(source, 'nested')), /自己里面/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function serviceFor(sessions) {
  return {
    socketName: null,
    async run() { return { stdout: '' }; },
    async listSessions() {
      return sessions.map((session) => ({ id: session.id, name: session.name, attached: false, windows: 1, activity: 0, path: session.dir, paneCount: 1, activeCommand: 'zsh' }));
    },
    async getSessionDetail(target) {
      const session = sessions.find((candidate) => candidate.id === target);
      if (!session) throw new Error('no session');
      return detailFor(session.dir);
    },
    async killSession() {},
    async resolveTmuxPath() { return '/usr/bin/tmux'; },
    async applySessionDefaults() {},
  };
}

test('web API: full token, single-session share and a relayed host all transfer files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-web-files-'));
  const dirA = join(root, 'hostA-project');
  const dirOther = join(root, 'hostA-other');
  const downloads = join(root, 'downloads');
  await mkdir(join(dirA, 'sub'), { recursive: true });
  await mkdir(dirOther);
  await mkdir(downloads);
  await writeFile(join(dirA, '报告.md'), '# 你好');
  await writeFile(join(dirOther, 'secret.txt'), 'nope');

  const storeA = new PreferencesStore({ filePath: join(root, 'a-prefs.json') });
  const storeB = new PreferencesStore({
    filePath: join(root, 'b-prefs.json'),
    createId: (() => { let n = 0; return () => `c${++n}`; })(),
  });
  let hostA = null;
  let hostB = null;
  try {
    hostA = await startWebServer({
      port: 0, host: '127.0.0.1', token: 'Atoken', preferencesStore: storeA,
      service: serviceFor([{ id: '$1', name: 'proj', dir: dirA }, { id: '$2', name: 'other', dir: dirOther }]),
    });
    const a = `http://127.0.0.1:${hostA.port}`;

    // Full token: list, download (with HEAD), upload.
    const list = await (await fetch(`${a}/api/files/list?token=Atoken&session=$1`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.path, dirA);
    assert.deepEqual(list.entries.map((entry) => entry.name), ['sub', '报告.md']);
    const fileUrl = `${a}/api/files/download?token=Atoken&session=$1&path=${encodeURIComponent(`${dirA}/报告.md`)}`;
    const head = await fetch(fileUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('# 你好')));
    const download = await fetch(fileUrl);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.md/);
    assert.equal(await download.text(), '# 你好');
    const upload = await (await fetch(`${a}/api/files/upload?token=Atoken&session=$1&dir=${encodeURIComponent(`${dirA}/sub`)}&name=${encodeURIComponent('图 1.png')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3]),
    })).json();
    assert.deepEqual(upload, { ok: true, name: '图 1.png', path: `${dirA}/sub/图 1.png`, size: 3 });

    // Confinement: another session's directory is not reachable through $1.
    const escape = await fetch(`${a}/api/files/download?token=Atoken&session=$1&path=${encodeURIComponent(`${dirOther}/secret.txt`)}`);
    assert.equal(escape.status, 403);
    const headMissing = await fetch(`${a}/api/files/download?token=Atoken&session=$1&path=${encodeURIComponent(`${dirA}/nope`)}`, { method: 'HEAD' });
    assert.equal(headMissing.status, 404);

    // Single-session share link: its own session's files work both ways…
    const share = createSessionShareToken('Atoken', 'proj');
    const sharedList = await (await fetch(`${a}/api/files/list?share=${share}&session=$1`)).json();
    assert.equal(sharedList.ok, true);
    const sharedDownload = await fetch(`${a}/api/files/download?share=${share}&session=$1&path=${encodeURIComponent(`${dirA}/报告.md`)}`);
    assert.equal(await sharedDownload.text(), '# 你好');
    const sharedUpload = await (await fetch(`${a}/api/files/upload?share=${share}&session=$1&dir=${encodeURIComponent(dirA)}&name=from-phone.txt`, {
      method: 'POST', body: 'phone',
    })).json();
    assert.equal(sharedUpload.path, `${dirA}/from-phone.txt`);
    assert.equal(await readFile(join(dirA, 'from-phone.txt'), 'utf8'), 'phone');
    // …but it can't reach another session, nor relayed hosts.
    for (const action of ['list', 'download']) {
      const denied = await fetch(`${a}/api/files/${action}?share=${share}&session=$2&path=${encodeURIComponent(`${dirOther}/secret.txt`)}`);
      assert.equal(denied.status, 403, action);
    }
    const deniedUpload = await fetch(`${a}/api/files/upload?share=${share}&session=$2&dir=${encodeURIComponent(dirOther)}&name=x.txt`, { method: 'POST', body: 'x' });
    assert.equal(deniedUpload.status, 403);
    assert.equal((await readdir(dirOther)).includes('x.txt'), false);
    const deniedRelay = await fetch(`${a}/api/files/list?share=${share}&session=r:remote-c1:$1`);
    assert.equal(deniedRelay.status, 403);

    // Host B relays A's session (reshare on): same three calls, bytes streamed through.
    await storeB.addRemoteConnection({ base: a, token: 'Atoken', label: 'A' });
    await storeB.setRemoteReshare('remote-c1', true);
    hostB = await startWebServer({ port: 0, host: '127.0.0.1', token: 'Btoken', preferencesStore: storeB, service: serviceFor([]) });
    const b = `http://127.0.0.1:${hostB.port}`;
    const relayed = await (await fetch(`${b}/api/files/list?token=Btoken&session=r:remote-c1:$1&path=${encodeURIComponent(`${dirA}/sub`)}`)).json();
    assert.deepEqual(relayed.entries.map((entry) => entry.name), ['图 1.png']);
    const relayedHead = await fetch(`${b}/api/files/download?token=Btoken&session=r:remote-c1:$1&path=${encodeURIComponent(`${dirA}/报告.md`)}`, { method: 'HEAD' });
    assert.equal(relayedHead.status, 200);
    const relayedDownload = await fetch(`${b}/api/files/download?token=Btoken&session=r:remote-c1:$1&path=${encodeURIComponent(`${dirA}/报告.md`)}`);
    assert.equal(await relayedDownload.text(), '# 你好');
    const relayedUpload = await (await fetch(`${b}/api/files/upload?token=Btoken&session=r:remote-c1:$1&dir=${encodeURIComponent(dirA)}&name=relayed.bin`, {
      method: 'POST', body: Buffer.alloc(256 * 1024, 7),
    })).json();
    assert.equal(relayedUpload.size, 256 * 1024);
    assert.equal((await stat(join(dirA, 'relayed.bin'))).size, 256 * 1024);
    const relayedDenied = await (await fetch(`${b}/api/files/download?token=Btoken&session=r:remote-c1:$1&path=${encodeURIComponent(`${dirOther}/secret.txt`)}`)).json();
    assert.match(relayedDenied.error, /会话工作目录/);

    // Desktop bridge taking over host B: streams to/from disk with progress,
    // token stays in main — and the session is A's, two hops away.
    const storeDesktop = new PreferencesStore({
      filePath: join(root, 'desktop-prefs.json'),
      createId: (() => { let n = 0; return () => `d${++n}`; })(),
    });
    await storeDesktop.addRemoteConnection({ base: b, token: 'Btoken', label: 'B' });
    const progress = [];
    const bridge = createTransferBridge({
      preferencesStore: storeDesktop,
      downloadsDir: () => downloads,
      chooseSavePath: async () => null,
      openPath: async () => {},
      onProgress: (event) => progress.push(event),
    });
    const saved = await bridge.download({ connectionId: 'remote-d1', session: 'r:remote-c1:$1', path: `${dirA}/报告.md`, transferId: 't1' });
    assert.equal(saved.canceled, false);
    assert.equal(saved.path, join(downloads, '报告.md'));
    assert.equal(await readFile(saved.path, 'utf8'), '# 你好');
    const again = await bridge.download({ connectionId: 'remote-d1', session: 'r:remote-c1:$1', path: `${dirA}/报告.md` });
    assert.equal(again.name, '报告 (1).md');
    assert.deepEqual(await bridge.download({ connectionId: 'remote-d1', session: 'r:remote-c1:$1', path: `${dirA}/报告.md`, mode: 'save-as' }), { canceled: true });
    await writeFile(join(root, 'local.txt'), 'from desktop');
    const pushed = await bridge.upload({ connectionId: 'remote-d1', session: 'r:remote-c1:$1', dir: dirA, source: join(root, 'local.txt'), transferId: 't2' });
    assert.equal(pushed.path, `${dirA}/local.txt`);
    assert.equal(await readFile(join(dirA, 'local.txt'), 'utf8'), 'from desktop');
    assert.ok(progress.some((event) => event.id === 't1' && event.loaded === event.total));
    assert.ok(progress.some((event) => event.id === 't2' && event.loaded === event.total));
    await assert.rejects(bridge.download({ connectionId: 'remote-zz', session: '$1', path: `${dirA}/报告.md` }), /远程主机不存在/);
    // Nothing half-written left in Downloads.
    assert.deepEqual((await readdir(downloads)).sort(), ['报告 (1).md', '报告.md']);
  } finally {
    if (hostB) await hostB.close();
    if (hostA) await hostA.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a host without the file endpoints is reported as an old version, not a bug', async () => {
  const http = require('node:http');
  const old = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '未知接口' }));
  });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-old-host-'));
  try {
    const base = `http://127.0.0.1:${old.address().port}`;
    await assert.rejects(
      downloadToFile({ url: hostUrl(base, '/api/files/download', { path: '/x' }), destDir: root, name: 'x', label: 'old' }),
      /「old」版本较旧/,
    );
    await writeFile(join(root, 'up.txt'), 'x');
    await assert.rejects(
      uploadFromFile({ url: hostUrl(base, '/api/files/upload', {}), filePath: join(root, 'up.txt') }),
      /版本较旧/,
    );
    assert.deepEqual(await readdir(root), ['up.txt']);
  } finally {
    await new Promise((resolve) => old.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelling a download mid-stream leaves no partial file behind', async () => {
  const http = require('node:http');
  // Sends half the declared body, then stalls — like a host going to sleep.
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write(Buffer.alloc(500, 1));
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-cancel-'));
  try {
    const controller = new AbortController();
    const pending = downloadToFile({
      url: hostUrl(`http://127.0.0.1:${slow.address().port}`, '/api/files/download', {}),
      destDir: root,
      name: 'big.iso',
      signal: controller.signal,
      onProgress: (loaded) => { if (loaded >= 500) controller.abort(); },
    });
    await assert.rejects(pending, /已取消/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    slow.closeAllConnections();
    await new Promise((resolve) => slow.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

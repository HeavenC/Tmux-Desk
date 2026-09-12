const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const {
  MAX_UPLOAD_BYTES,
  decodeFilePayload,
  sanitizeName,
  stageUploadedFile,
} = require('../src/main/upload-file');

// cacheDir() derives from os.homedir(), which honours $HOME on POSIX — so the
// staging dir can be redirected without the module knowing about tests.
async function withTempHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'tmux-desk-upload-home-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('uploaded names stay typeable as an @path token', () => {
  // The path is sent as `@<path>`; a space would end the token halfway.
  assert.deepEqual(sanitizeName('deploy log 2026.txt'), { stem: 'deploy_log_2026', ext: '.txt' });
  // Chinese names are the common case on the phone and survive intact.
  assert.deepEqual(sanitizeName('季度 报告.pdf'), { stem: '季度_报告', ext: '.pdf' });
  // Shell metacharacters and quotes are dropped, not escaped.
  assert.deepEqual(sanitizeName('a"b$c;d.txt'), { stem: 'abcd', ext: '.txt' });
  // Only the basename is ever used, so traversal can't escape the staging dir.
  assert.deepEqual(sanitizeName('../../etc/passwd'), { stem: 'passwd', ext: '' });
  assert.deepEqual(sanitizeName('...'), { stem: 'file', ext: '' });
  assert.deepEqual(sanitizeName(''), { stem: 'file', ext: '' });
  assert.equal(sanitizeName(`${'x'.repeat(200)}.log`).stem.length, 64);
});

test('staging writes the bytes and keeps the original name recognisable', async () => {
  await withTempHome(async () => {
    const first = await stageUploadedFile(Buffer.from('hello'), 'notes.md');
    assert.match(first.name, /^notes-[0-9a-f]{6}\.md$/);
    assert.equal(first.size, 5);
    assert.equal(await readFile(first.path, 'utf8'), 'hello');

    // Re-uploading the same name must not clobber the earlier reference: a
    // prompt may still be pointing at it.
    const second = await stageUploadedFile(Buffer.from('world'), 'notes.md');
    assert.notEqual(second.path, first.path);
    assert.equal((await readdir(dirname(first.path))).length, 2);
    assert.equal(await readFile(first.path, 'utf8'), 'hello');
  });
});

test('empty and oversized uploads are refused before anything is written', async () => {
  await withTempHome(async () => {
    await assert.rejects(() => stageUploadedFile(Buffer.alloc(0), 'x.txt'), /为空/);
    await assert.rejects(() => stageUploadedFile('not a buffer', 'x.txt'), /为空/);
  });
  assert.throws(() => decodeFilePayload({}), /缺少文件数据/);
  assert.throws(() => decodeFilePayload({ data: 'x'.repeat(Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1) }), /过大/);
  assert.deepEqual(decodeFilePayload({ data: Buffer.from('hi').toString('base64') }).buffer, Buffer.from('hi'));
});

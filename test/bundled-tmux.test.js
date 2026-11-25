const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installBundledTmux } = require('../src/main/bundled-tmux');

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-tmux-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'app', 'tmux');
  fs.mkdirSync(path.dirname(source));
  fs.writeFileSync(source, 'tmux-v1', { mode: 0o755 });
  return { dir, source, targetDir: path.join(dir, 'user', 'bin') };
}

test('copies the bundled tmux out of the app and makes it executable', async (t) => {
  const { source, targetDir } = sandbox(t);
  const installed = await installBundledTmux({ source, targetDir });

  assert.equal(installed, path.join(targetDir, 'tmux'));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'tmux-v1');
  assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(targetDir), ['tmux']);
});

test('leaves an identical copy untouched', async (t) => {
  const { source, targetDir } = sandbox(t);
  const installed = await installBundledTmux({ source, targetDir });
  const before = fs.statSync(installed).ino;

  assert.equal(await installBundledTmux({ source, targetDir }), installed);
  assert.equal(fs.statSync(installed).ino, before);
});

test('replaces an outdated copy by rename so a running server keeps its binary', async (t) => {
  const { source, targetDir } = sandbox(t);
  const installed = await installBundledTmux({ source, targetDir });
  // Stands in for a tmux server still executing the old binary.
  const held = fs.openSync(installed, 'r');
  t.after(() => fs.closeSync(held));
  const oldInode = fs.fstatSync(held).ino;

  fs.writeFileSync(source, 'tmux-v2-longer');
  assert.equal(await installBundledTmux({ source, targetDir }), installed);

  assert.equal(fs.readFileSync(installed, 'utf8'), 'tmux-v2-longer');
  assert.notEqual(fs.statSync(installed).ino, oldInode);
  const buf = Buffer.alloc(16);
  const n = fs.readSync(held, buf, 0, buf.length, 0);
  assert.equal(buf.subarray(0, n).toString(), 'tmux-v1');
  assert.deepEqual(fs.readdirSync(targetDir), ['tmux']);
});

test('returns null when the app carries no tmux', async (t) => {
  const { dir, targetDir } = sandbox(t);
  assert.equal(await installBundledTmux({ source: path.join(dir, 'missing'), targetDir }), null);
  assert.equal(await installBundledTmux({ source: null, targetDir }), null);
  assert.equal(fs.existsSync(targetDir), false);
});

test('falls back to the bundled path when the target cannot be written', async (t) => {
  const { dir, source } = sandbox(t);
  // A regular file where the directory should be makes mkdir fail.
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, '');
  assert.equal(await installBundledTmux({ source, targetDir: path.join(blocker, 'bin') }), source);
});

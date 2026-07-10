const assert = require('node:assert/strict');
const test = require('node:test');

const { listDirectory, validatePath } = require('../src/main/file-service');

function fakeFs(entries, statByPath = {}) {
  return {
    async readdir() {
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => Boolean(entry.dir),
        isSymbolicLink: () => Boolean(entry.link),
      }));
    },
    async stat(full) { return statByPath[full] || { isDirectory: () => false, isFile: () => true, size: 0 }; },
    async lstat(full) { return statByPath[full] || { isDirectory: () => false, isFile: () => true, size: 0 }; },
  };
}

test('validatePath rejects relative paths, NUL bytes, and non-strings', () => {
  assert.equal(validatePath('/Users/liwei/work'), '/Users/liwei/work');
  assert.throws(() => validatePath('relative'), /路径无效/);
  assert.throws(() => validatePath('/bad\0path'), /路径无效/);
  assert.throws(() => validatePath(42), /路径无效/);
});

test('listDirectory sorts folders first then names, and flags hidden entries', async () => {
  const fsImpl = fakeFs([
    { name: 'readme.md' },
    { name: 'src', dir: true },
    { name: '.git', dir: true },
    { name: 'App.js' },
  ], {
    '/root/readme.md': { isDirectory: () => false, isFile: () => true, size: 12 },
    '/root/App.js': { isDirectory: () => false, isFile: () => true, size: 34 },
  });

  const { path: root, entries } = await listDirectory('/root', { fsImpl });
  assert.equal(root, '/root');
  assert.deepEqual(entries.map((entry) => entry.name), ['.git', 'src', 'App.js', 'readme.md']);
  assert.equal(entries.find((entry) => entry.name === '.git').hidden, true);
  assert.equal(entries.find((entry) => entry.name === 'readme.md').size, 12);
});

test('listDirectory resolves a symlink that points at a directory', async () => {
  const fsImpl = fakeFs([
    { name: 'linked', link: true },
  ], {
    '/root/linked': { isDirectory: () => true, isFile: () => false, size: 0 },
  });
  const { entries } = await listDirectory('/root', { fsImpl });
  assert.equal(entries[0].isDir, true);
  assert.equal(entries[0].isSymlink, true);
});

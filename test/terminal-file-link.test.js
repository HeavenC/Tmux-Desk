const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findTerminalFileReferences,
  resolveTerminalFileReference,
} = require('../src/shared/terminal-file-link');

test('terminal file references cover absolute, relative, bare, quoted, and source-location forms', () => {
  const line = 'error: src/app.js:12:3 then /tmp/report.pdf, "docs/My Guide.md" and Makefile';
  assert.deepEqual(findTerminalFileReferences(line).map(({ text, reference }) => ({ text, reference })), [
    { text: 'src/app.js:12:3', reference: 'src/app.js' },
    { text: '/tmp/report.pdf', reference: '/tmp/report.pdf' },
    { text: 'docs/My Guide.md', reference: 'docs/My Guide.md' },
    { text: 'Makefile', reference: 'Makefile' },
  ]);
});

test('terminal file references ignore web URLs, versions, and ordinary words', () => {
  assert.deepEqual(findTerminalFileReferences('open https://example.com/app.js with release v1.2 now'), []);
});

test('terminal file references preserve exact offsets after surrounding punctuation', () => {
  const line = 'at foo (/Users/me/work/index.ts(42,7))';
  const [match] = findTerminalFileReferences(line);
  assert.equal(line.slice(match.start, match.end), '/Users/me/work/index.ts(42,7)');
  assert.equal(match.reference, '/Users/me/work/index.ts');
});

test('terminal file resolution uses the active pane cwd and understands home and file URLs', () => {
  assert.equal(
    resolveTerminalFileReference('../README.md:8', '/Users/liwei/work/app'),
    '/Users/liwei/work/README.md',
  );
  assert.equal(
    resolveTerminalFileReference('~/notes/todo.md', '/Users/liwei/work/app'),
    '/Users/liwei/notes/todo.md',
  );
  assert.equal(
    resolveTerminalFileReference('file:///Users/liwei/My%20File.txt:12', '/tmp'),
    '/Users/liwei/My File.txt',
  );
  assert.equal(resolveTerminalFileReference('C:\\work\\app.js:2', '/mnt/c/work'), 'C:\\work\\app.js');
  assert.equal(resolveTerminalFileReference('relative.js', null), null);
});

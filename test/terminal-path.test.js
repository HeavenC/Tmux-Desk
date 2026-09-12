const assert = require('node:assert/strict');
const test = require('node:test');

const { escapePathForTerminal, pathReference } = require('../src/shared/terminal-path');

test('a path with spaces survives as one token', () => {
  // Unescaped, an agent reads "@/tmp/my" plus a stray word — the reference is
  // silently wrong rather than obviously broken.
  assert.equal(pathReference('/tmp/my notes.md'), '@/tmp/my\\ notes.md ');
  assert.equal(pathReference('/a/b.txt'), '@/a/b.txt ');
});

test('shell metacharacters are escaped, ordinary path characters are not', () => {
  assert.equal(escapePathForTerminal("/tmp/it's (v2)&.log"), "/tmp/it\\'s\\ \\(v2\\)\\&.log");
  assert.equal(escapePathForTerminal('/Users/x/我的-项目_1.2/a.md'), '/Users/x/我的-项目_1.2/a.md');
  assert.equal(escapePathForTerminal(''), '');
  assert.equal(escapePathForTerminal(null), '');
});

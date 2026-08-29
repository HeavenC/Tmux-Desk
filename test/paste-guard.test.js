const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PASTE_GUARD,
  chunkPaste,
  inspectPaste,
  normalizePasteGuard,
  pasteDecision,
  validatePasteGuard,
} = require('../src/shared/paste-guard');

test('a single trailing newline is not a multi-line paste', () => {
  // Every "copy this command" button ends with one; warning about it would
  // train people to click straight through the dialog.
  assert.deepEqual(inspectPaste('npm test\n'), { chars: 9, lines: 1, multiline: false, trailingNewline: true });
  assert.deepEqual(inspectPaste('npm test\r\n'), { chars: 10, lines: 1, multiline: false, trailingNewline: true });
  assert.equal(inspectPaste('a\nb').multiline, true);
  assert.equal(inspectPaste('a\rb').multiline, true);
  assert.equal(inspectPaste('a\r\nb\r\n').lines, 2);
  assert.equal(inspectPaste('').lines, 0);
});

test('decision reports which rule fired, and honours each rule being off', () => {
  assert.equal(pasteDecision('one line', DEFAULT_PASTE_GUARD).confirm, false);
  assert.equal(pasteDecision('a\nb', DEFAULT_PASTE_GUARD).reason, 'multiline');
  assert.equal(pasteDecision('a\nb', { confirmMultiline: false, confirmChars: 0 }).confirm, false);

  const big = 'x'.repeat(5000);
  assert.equal(pasteDecision(big, DEFAULT_PASTE_GUARD).reason, 'size');
  assert.equal(pasteDecision(big, { confirmChars: 0 }).confirm, false);
  assert.equal(pasteDecision('x'.repeat(4096), DEFAULT_PASTE_GUARD).confirm, false);

  assert.equal(pasteDecision('a\nb', { slow: true }).slow, true);
});

test('guard settings normalize and validate', () => {
  assert.deepEqual(normalizePasteGuard(undefined), DEFAULT_PASTE_GUARD);
  assert.equal(normalizePasteGuard({ confirmChars: -5 }).confirmChars, 0);
  assert.equal(normalizePasteGuard({ confirmChars: 1e9 }).confirmChars, 1000000);
  assert.equal(normalizePasteGuard({ confirmMultiline: 'yes' }).confirmMultiline, true);
  assert.throws(() => validatePasteGuard({ nope: 1 }), /未知字段/);
  assert.throws(() => validatePasteGuard({ slow: 'on' }), /slow/);
  assert.throws(() => validatePasteGuard({ confirmChars: -1 }), /confirmChars/);
  assert.deepEqual(validatePasteGuard({ slow: true }), { ...DEFAULT_PASTE_GUARD, slow: true });
});

test('slow-paste chunking never splits a surrogate pair', () => {
  // Half an emoji written to a pty is bytes the application can never reassemble.
  const chunks = chunkPaste('😀😀😀', 2);
  assert.deepEqual(chunks, ['😀', '😀', '😀']);
  assert.equal(chunks.join(''), '😀😀😀');
  assert.deepEqual(chunkPaste('abcde', 2), ['ab', 'cd', 'e']);
  assert.deepEqual(chunkPaste(''), []);
});

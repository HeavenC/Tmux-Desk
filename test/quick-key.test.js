const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const test = require('node:test');

const {
  comboSequence,
  comboLabel,
  describeSequence,
  normalizeComboKey,
  normalizeQuickKeyEntry,
} = require('../src/shared/quick-key');

test('legacy encodings win when they exist', () => {
  assert.equal(comboSequence({ key: 'c', ctrl: true }), '\x03');
  assert.equal(comboSequence({ key: 'z', alt: true }), '\x1bz');
  assert.equal(comboSequence({ key: 'a' }), 'a');
  assert.equal(comboSequence({ key: 'a', shift: true }), 'A');
  assert.equal(comboSequence({ key: 'c', ctrl: true, alt: true }), '\x1b\x03');
  assert.equal(comboSequence({ key: 'space', ctrl: true }), '\x00');
  assert.equal(comboSequence({ key: '[', ctrl: true }), '\x1b');
});

test('modifiers parameterize cursor and function keys', () => {
  assert.equal(comboSequence({ key: 'up' }), '\x1b[A');
  assert.equal(comboSequence({ key: 'up', ctrl: true }), '\x1b[1;5A');
  assert.equal(comboSequence({ key: 'left', alt: true, shift: true }), '\x1b[1;4D');
  assert.equal(comboSequence({ key: 'f1' }), '\x1bOP');
  assert.equal(comboSequence({ key: 'f1', ctrl: true }), '\x1b[1;5P');
  assert.equal(comboSequence({ key: 'f5', meta: true }), '\x1b[15;9~');
  assert.equal(comboSequence({ key: 'pageup' }), '\x1b[5~');
});

test('shift+tab keeps the classic back-tab sequence', () => {
  assert.equal(comboSequence({ key: 'tab' }), '\t');
  assert.equal(comboSequence({ key: 'tab', shift: true }), '\x1b[Z');
  assert.equal(comboSequence({ key: 'enter', alt: true }), '\x1b\r');
});

test('combos with no legacy encoding fall back to CSI u', () => {
  // ⌥⌘C — Cmd has no legacy form at all.
  assert.equal(comboSequence({ key: 'c', alt: true, meta: true }), '\x1b[99;11u');
  assert.equal(comboSequence({ key: 'c', meta: true }), '\x1b[99;9u');
  // Ctrl+Shift collapses onto plain Ctrl in the legacy encoding, so keep it extended.
  assert.equal(comboSequence({ key: 'c', ctrl: true, shift: true }), '\x1b[99;6u');
  assert.equal(comboSequence({ key: 'enter', ctrl: true }), '\x1b[13;5u');
  // The CSI u key code is the unshifted key, not the typed character.
  assert.equal(comboSequence({ key: 'C', meta: true }), '\x1b[99;9u');
});

test('labels use Mac modifier order and can be overridden', () => {
  assert.equal(comboLabel({ key: 'c', alt: true, meta: true }), '⌥⌘C');
  assert.equal(comboLabel({ key: 'c', ctrl: true, alt: true, shift: true, meta: true }), '⌃⌥⇧⌘C');
  assert.equal(comboLabel({ key: 'up', ctrl: true }), '⌃↑');
  assert.equal(comboLabel({ key: 'c', meta: true, label: '复制' }), '复制');
  assert.equal(comboLabel({ key: '' }), '');
});

test('describeSequence renders escapes readably', () => {
  assert.equal(describeSequence('\x1b[99;9u'), '\\e[99;9u');
  assert.equal(describeSequence('\x03'), '\\x03');
  assert.equal(describeSequence('\x1b\r'), '\\e\\r');
});

test('combo keys are one printable character or a known named key', () => {
  assert.equal(normalizeComboKey('c'), 'c');
  assert.equal(normalizeComboKey('Up'), 'up');
  assert.equal(normalizeComboKey('中'), '中');
  assert.equal(normalizeComboKey('ab'), null);
  assert.equal(normalizeComboKey('\x1b'), null);
  assert.equal(normalizeComboKey(''), null);
  assert.equal(normalizeComboKey(42), null);
});

test('stored entries normalize to preset, text and combo shapes only', () => {
  assert.deepEqual(
    normalizeQuickKeyEntry({ type: 'combo', key: 'c', alt: true, meta: true, bogus: 1 }),
    { type: 'combo', key: 'c', alt: true, meta: true },
  );
  assert.deepEqual(
    normalizeQuickKeyEntry({ type: 'combo', key: 'c', ctrl: 'yes' }),
    { type: 'combo', key: 'c' },
  );
  assert.equal(normalizeQuickKeyEntry({ type: 'combo', key: 'nope' }), null);
  assert.deepEqual(normalizeQuickKeyEntry({ type: 'preset', id: 'esc' }), { type: 'preset', id: 'esc' });
  assert.equal(normalizeQuickKeyEntry({ type: 'preset', id: 'esc' }, { isPreset: () => false }), null);
  assert.deepEqual(
    normalizeQuickKeyEntry({ type: 'text', label: 'x', text: '/usage', enter: true }),
    { type: 'text', label: 'x', text: '/usage', enter: true },
  );
  assert.equal(normalizeQuickKeyEntry({ type: 'wat' }), null);
  assert.equal(normalizeQuickKeyEntry(null), null);
});

test('the mobile editor exposes a combo builder wired to the shared codec', async () => {
  const webappDir = join(__dirname, '..', 'src', 'webapp');
  const [app, html] = await Promise.all([
    readFile(join(webappDir, 'app.js'), 'utf8'),
    readFile(join(webappDir, 'index.html'), 'utf8'),
  ]);
  for (const id of ['qk-add-combo', 'qk-combo-mods', 'qk-combo-key', 'qk-combo-named', 'qk-combo-preview', 'qk-combo-hint']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(app, /require\(['"]\.\.\/shared\/quick-key['"]\)/);
  assert.match(app, /el\(['"]qk-add-combo['"]\)\.addEventListener\(['"]submit['"], addQuickComboKey\)/);
  assert.match(app, /el\(['"]qk-combo-key['"]\)\.addEventListener\(['"]keydown['"], recordComboKeydown\)/);
  // The bar and the sheet must both encode through the codec, never a stored blob.
  assert.match(app, /key\.type === 'combo'[\s\S]*comboSequence\(key\)/);
});

test('the main-process store keeps combos through its shared normalizer', async () => {
  const store = await readFile(join(__dirname, '..', 'src', 'main', 'preferences-store.js'), 'utf8');
  assert.match(store, /require\(['"]\.\.\/shared\/quick-key['"]\)/);
  assert.match(store, /normalizeQuickKeyEntry\(item\)/);
});

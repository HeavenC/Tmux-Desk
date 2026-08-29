const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BASE_FONT_STACK,
  DEFAULT_TERMINAL_APPEARANCE,
  normalizeTerminalAppearance,
  terminalFontStack,
  validateTerminalAppearance,
} = require('../src/shared/terminal-appearance');

test('appearance normalization clamps, rounds and falls back per field', () => {
  assert.deepEqual(normalizeTerminalAppearance(undefined), DEFAULT_TERMINAL_APPEARANCE);
  assert.deepEqual(normalizeTerminalAppearance({ fontSize: 99, lineHeight: 0.1, letterSpacing: 12 }), {
    fontFamily: '', fontSize: 32, lineHeight: 0.8, letterSpacing: 4,
  });
  // Rounded to the control's own step, so the number input can reproduce it.
  assert.equal(normalizeTerminalAppearance({ lineHeight: 1.2199999 }).lineHeight, 1.22);
  assert.equal(normalizeTerminalAppearance({ fontSize: 15.6 }).fontSize, 16);
  assert.equal(normalizeTerminalAppearance({ fontSize: 'big' }).fontSize, DEFAULT_TERMINAL_APPEARANCE.fontSize);
});

test('a font family that could break out of the CSS declaration is discarded', () => {
  assert.equal(normalizeTerminalAppearance({ fontFamily: 'JetBrains Mono' }).fontFamily, 'JetBrains Mono');
  assert.equal(normalizeTerminalAppearance({ fontFamily: '  SF Mono  ' }).fontFamily, 'SF Mono');
  for (const hostile of ['a; background: url(x)', 'a}', 'a/*x*/', 'a(b)']) {
    assert.equal(normalizeTerminalAppearance({ fontFamily: hostile }).fontFamily, '');
  }
});

test('a custom family is prepended to the composite stack, never replacing it', () => {
  // The CJK half of BASE_FONT_STACK is what keeps fullwidth punctuation two
  // cells wide, so it has to survive every custom family.
  assert.equal(terminalFontStack({}), BASE_FONT_STACK);
  assert.equal(terminalFontStack({ fontFamily: 'JetBrains Mono' }), `"JetBrains Mono", ${BASE_FONT_STACK}`);
  assert.equal(terminalFontStack({ fontFamily: 'Menlo' }), `Menlo, ${BASE_FONT_STACK}`);
  // Already quoted or already a list: passed through untouched.
  assert.equal(terminalFontStack({ fontFamily: '"SF Mono"' }), `"SF Mono", ${BASE_FONT_STACK}`);
  assert.equal(terminalFontStack({ fontFamily: 'Fira Code, Menlo' }), `Fira Code, Menlo, ${BASE_FONT_STACK}`);
});

test('validation rejects unknown fields and out-of-range numbers', () => {
  assert.throws(() => validateTerminalAppearance(null), /终端外观设置无效/);
  assert.throws(() => validateTerminalAppearance({ nope: 1 }), /未知字段/);
  assert.throws(() => validateTerminalAppearance({ fontSize: 200 }), /fontSize/);
  assert.throws(() => validateTerminalAppearance({ fontFamily: 12 }), /终端字体无效/);
  assert.deepEqual(validateTerminalAppearance({ fontSize: 16 }), { ...DEFAULT_TERMINAL_APPEARANCE, fontSize: 16 });
});

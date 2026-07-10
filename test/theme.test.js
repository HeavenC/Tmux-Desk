const assert = require('node:assert/strict');
const test = require('node:test');

const { applyTheme, resolveTheme } = require('../src/renderer/theme');

test('resolveTheme defaults to light and resolves system appearance', () => {
  assert.equal(resolveTheme(undefined, true), 'light');
  assert.equal(resolveTheme('invalid', true), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('applyTheme updates theme data and native color scheme', () => {
  const root = { dataset: {}, style: {} };
  assert.equal(applyTheme(root, 'dark'), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
});

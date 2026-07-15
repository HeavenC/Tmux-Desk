const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_TMUX_SETTINGS,
  buildTmuxSettingCommands,
  normalizeTmuxSettings,
  parseAdvancedConfig,
  validateTmuxSettings,
} = require('../src/shared/tmux-settings');

test('tmux settings normalize to the iTerm-like profile and clamp persisted numbers', () => {
  assert.deepEqual(normalizeTmuxSettings(), DEFAULT_TMUX_SETTINGS);
  const normalized = normalizeTmuxSettings({
    mouse: false,
    historyLimit: 9999999,
    escapeTime: -2,
    modeKeys: 'invalid',
    prefix: 'C-a',
  });
  assert.equal(normalized.mouse, false);
  assert.equal(normalized.historyLimit, 1000000);
  assert.equal(normalized.escapeTime, 0);
  assert.equal(normalized.modeKeys, 'emacs');
  assert.equal(normalized.prefix, 'C-a');
});

test('advanced config parses quoted tmux options without a shell', () => {
  assert.deepEqual(parseAdvancedConfig([
    '# local appearance',
    "set -g status-left '#S · #{session_windows}'",
    "setw -g pane-border-style 'fg=colour240'",
  ].join('\n')), [
    ['set', '-g', 'status-left', '#S · #{session_windows}'],
    ['setw', '-g', 'pane-border-style', 'fg=colour240'],
  ]);
});

test('advanced config blocks shell expansion, executable options, targets, and unsupported commands', () => {
  assert.throws(() => parseAdvancedConfig("set -g status-right '#(whoami)'"), /不安全/);
  assert.throws(() => parseAdvancedConfig('set -g default-command zsh'), /不允许/);
  assert.throws(() => parseAdvancedConfig('set -t $1 status off'), /必须使用 -g 或 -s|不能指定/);
  assert.throws(() => parseAdvancedConfig('run-shell whoami'), /仅支持/);
  assert.throws(() => parseAdvancedConfig('set status off'), /必须使用 -g 或 -s/);
});

test('IPC-level validation rejects unknown and out-of-range tmux fields', () => {
  assert.equal(validateTmuxSettings({ ...DEFAULT_TMUX_SETTINGS, escapeTime: 20 }).escapeTime, 20);
  assert.throws(() => validateTmuxSettings({ ...DEFAULT_TMUX_SETTINGS, escapeTime: -1 }), /escapeTime/);
  assert.throws(() => validateTmuxSettings({ ...DEFAULT_TMUX_SETTINGS, hidden: true }), /未知字段/);
});

test('subsequent sessions only clear stale local overrides', () => {
  const commands = buildTmuxSettingCommands('$8', DEFAULT_TMUX_SETTINGS, { includeGlobal: false });
  assert.equal(commands.length, 12);
  assert.equal(commands.every((args) => args[0] === 'set-option' && args[1] === '-u' && args[3] === '$8'), true);
});

test('managed copy-mode bindings forward Ctrl+V to the pane instead of scrolling', () => {
  const commands = buildTmuxSettingCommands('$8', DEFAULT_TMUX_SETTINGS);
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    assert.deepEqual(commands.find((args) => args[0] === 'bind-key' && args[2] === table), [
      'bind-key', '-T', table, 'C-v',
      'send-keys', '-X', 'cancel', '\\;', 'send-keys', 'C-v',
    ]);
  }
});

const DEFAULT_TMUX_SETTINGS = Object.freeze({
  mouse: true,
  historyLimit: 50000,
  baseIndex: 1,
  paneBaseIndex: 1,
  renumberWindows: true,
  status: false,
  statusPosition: 'bottom',
  modeKeys: 'emacs',
  prefix: 'C-b',
  escapeTime: 10,
  repeatTime: 500,
  displayTime: 750,
  focusEvents: true,
  setClipboard: true,
  extendedKeys: true,
  trueColor: true,
  automaticRename: true,
  setTitles: true,
  aggressiveResize: true,
  detachOnDestroy: false,
  remainOnExit: false,
  advancedConfig: '',
});

const TMUX_SETTING_FIELDS = Object.freeze([
  { key: 'mouse', type: 'boolean', group: 'interaction' },
  { key: 'modeKeys', type: 'select', group: 'interaction', values: ['emacs', 'vi'] },
  { key: 'prefix', type: 'select', group: 'interaction', values: ['C-b', 'C-a', 'C-Space'] },
  { key: 'extendedKeys', type: 'boolean', group: 'interaction' },
  { key: 'setClipboard', type: 'boolean', group: 'interaction' },
  { key: 'historyLimit', type: 'number', group: 'scrollback', min: 2000, max: 1000000, step: 1000 },
  { key: 'escapeTime', type: 'number', group: 'scrollback', min: 0, max: 2000, step: 10 },
  { key: 'repeatTime', type: 'number', group: 'scrollback', min: 100, max: 5000, step: 50 },
  { key: 'displayTime', type: 'number', group: 'scrollback', min: 100, max: 10000, step: 50 },
  { key: 'status', type: 'boolean', group: 'appearance' },
  { key: 'statusPosition', type: 'select', group: 'appearance', values: ['bottom', 'top'] },
  { key: 'trueColor', type: 'boolean', group: 'appearance' },
  { key: 'setTitles', type: 'boolean', group: 'appearance' },
  { key: 'automaticRename', type: 'boolean', group: 'appearance' },
  { key: 'baseIndex', type: 'select-number', group: 'windows', values: [0, 1] },
  { key: 'paneBaseIndex', type: 'select-number', group: 'windows', values: [0, 1] },
  { key: 'renumberWindows', type: 'boolean', group: 'windows' },
  { key: 'focusEvents', type: 'boolean', group: 'windows' },
  { key: 'aggressiveResize', type: 'boolean', group: 'windows' },
  { key: 'detachOnDestroy', type: 'boolean', group: 'windows' },
  { key: 'remainOnExit', type: 'boolean', group: 'windows' },
]);

const FIELD_BY_KEY = new Map(TMUX_SETTING_FIELDS.map((field) => [field.key, field]));
const UNSAFE_OPTIONS = new Set([
  'command-alias',
  'copy-command',
  'default-command',
  'default-shell',
  'lock-command',
]);

function normalizeField(field, value, fallback) {
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : fallback;
  if (field.type === 'number') {
    if (!Number.isInteger(value)) return fallback;
    return Math.min(field.max, Math.max(field.min, value));
  }
  if (field.type === 'select' || field.type === 'select-number') {
    return field.values.includes(value) ? value : fallback;
  }
  return fallback;
}

function migrateLegacyTmuxDefaults(legacy) {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {};
  const migrated = {};
  if (typeof legacy.mouse === 'boolean') migrated.mouse = legacy.mouse;
  if (typeof legacy.history === 'boolean') migrated.historyLimit = legacy.history ? 50000 : 2000;
  if (typeof legacy.detachOnDestroy === 'boolean') migrated.detachOnDestroy = !legacy.detachOnDestroy;
  if (typeof legacy.windowNumbering === 'boolean') {
    migrated.baseIndex = legacy.windowNumbering ? 1 : 0;
    migrated.paneBaseIndex = legacy.windowNumbering ? 1 : 0;
    migrated.renumberWindows = legacy.windowNumbering;
  }
  if (typeof legacy.extendedKeys === 'boolean') migrated.extendedKeys = legacy.extendedKeys;
  return migrated;
}

function normalizeTmuxSettings(value, legacy) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : migrateLegacyTmuxDefaults(legacy);
  const normalized = {};
  for (const field of TMUX_SETTING_FIELDS) {
    normalized[field.key] = normalizeField(field, source[field.key], DEFAULT_TMUX_SETTINGS[field.key]);
  }
  normalized.advancedConfig = typeof source.advancedConfig === 'string'
    ? source.advancedConfig.slice(0, 16384)
    : DEFAULT_TMUX_SETTINGS.advancedConfig;
  return normalized;
}

function validateTmuxSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tmux 设置无效');
  }
  const allowed = new Set([...FIELD_BY_KEY.keys(), 'advancedConfig']);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error('tmux 设置包含未知字段');
  for (const field of TMUX_SETTING_FIELDS) {
    if (!(field.key in value)) continue;
    const candidate = value[field.key];
    const valid = field.type === 'boolean'
      ? typeof candidate === 'boolean'
      : field.type === 'number'
        ? Number.isInteger(candidate) && candidate >= field.min && candidate <= field.max
        : field.values.includes(candidate);
    if (!valid) throw new Error(`tmux 设置 ${field.key} 无效`);
  }
  if ('advancedConfig' in value) parseAdvancedConfig(value.advancedConfig);
  return normalizeTmuxSettings(value);
}

function tokenizeConfigLine(line, lineNumber) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const character of line.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) { tokens.push(token); token = ''; }
    } else {
      token += character;
    }
  }
  if (escaped || quote) throw new Error(`高级配置第 ${lineNumber} 行的引号或转义未闭合`);
  if (token) tokens.push(token);
  return tokens;
}

function parseAdvancedConfig(value) {
  if (typeof value !== 'string' || value.length > 16384 || /[\0\r]/.test(value)) {
    throw new Error('高级配置必须是不超过 16 KB 的纯文本');
  }
  const lines = value.split('\n');
  if (lines.length > 100) throw new Error('高级配置最多支持 100 行');
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (raw.length > 2048) throw new Error(`高级配置第 ${index + 1} 行过长`);
    if (raw.includes(';') || raw.includes('#(')) {
      throw new Error(`高级配置第 ${index + 1} 行包含不安全的命令或 shell 展开`);
    }
    const tokens = tokenizeConfigLine(raw, index + 1);
    const command = tokens[0];
    const windowCommand = command === 'setw' || command === 'set-window-option';
    if (!['set', 'set-option', 'setw', 'set-window-option'].includes(command)) {
      throw new Error(`高级配置第 ${index + 1} 行仅支持 set-option / set-window-option`);
    }
    const flags = [];
    let optionIndex = 1;
    while (tokens[optionIndex]?.startsWith('-')) flags.push(tokens[optionIndex++]);
    if (!flags.some((flag) => /[gs]/.test(flag))) {
      throw new Error(`高级配置第 ${index + 1} 行必须使用 -g 或 -s 作用域`);
    }
    if (flags.some((flag) => flag.includes('t'))) {
      throw new Error(`高级配置第 ${index + 1} 行不能指定 -t 目标`);
    }
    const option = tokens[optionIndex];
    if (!option || (!option.startsWith('@') && !/^[a-z][a-z0-9-]*$/i.test(option))) {
      throw new Error(`高级配置第 ${index + 1} 行缺少有效的选项名`);
    }
    if (UNSAFE_OPTIONS.has(option)) throw new Error(`高级配置不允许修改可执行命令选项 ${option}`);
    if (windowCommand && flags.some((flag) => flag.includes('s'))) {
      throw new Error(`高级配置第 ${index + 1} 行的窗口选项不能使用 -s`);
    }
    commands.push(tokens);
  }
  return commands;
}

function booleanValue(value) {
  return value ? 'on' : 'off';
}

function buildTmuxSettingCommands(sessionTarget, settings, { includeGlobal = true } = {}) {
  const profile = normalizeTmuxSettings(settings);
  const sessionOptions = [
    ['mouse', booleanValue(profile.mouse)],
    ['history-limit', profile.historyLimit],
    ['base-index', profile.baseIndex],
    ['renumber-windows', booleanValue(profile.renumberWindows)],
    ['status', booleanValue(profile.status)],
    ['status-position', profile.statusPosition],
    ['prefix', profile.prefix],
    ['repeat-time', profile.repeatTime],
    ['display-time', profile.displayTime],
    ['focus-events', booleanValue(profile.focusEvents)],
    ['set-titles', booleanValue(profile.setTitles)],
    ['detach-on-destroy', booleanValue(profile.detachOnDestroy)],
  ];
  const unsets = sessionOptions.map(([option]) => ['set-option', '-u', '-t', sessionTarget, option]);
  if (!includeGlobal) return unsets;
  const sessionGlobals = sessionOptions.map(([option, value]) => ['set-option', '-g', option, String(value)]);
  const server = (option, value) => ['set-option', '-s', option, String(value)];
  const windowGlobal = (option, value) => ['set-window-option', '-g', option, String(value)];
  return [
    ...unsets,
    ...sessionGlobals,
    server('escape-time', profile.escapeTime),
    server('extended-keys', booleanValue(profile.extendedKeys)),
    server('set-clipboard', profile.setClipboard ? 'on' : 'off'),
    server('default-terminal', profile.trueColor ? 'tmux-256color' : 'screen-256color'),
    windowGlobal('pane-base-index', profile.paneBaseIndex),
    windowGlobal('mode-keys', profile.modeKeys),
    windowGlobal('automatic-rename', booleanValue(profile.automaticRename)),
    windowGlobal('aggressive-resize', booleanValue(profile.aggressiveResize)),
    windowGlobal('remain-on-exit', booleanValue(profile.remainOnExit)),
    ...parseAdvancedConfig(profile.advancedConfig),
  ];
}

module.exports = {
  DEFAULT_TMUX_SETTINGS,
  TMUX_SETTING_FIELDS,
  buildTmuxSettingCommands,
  normalizeTmuxSettings,
  parseAdvancedConfig,
  validateTmuxSettings,
};

// Desktop terminal typography. These were hard-coded in terminal-view.js; they
// are the settings people reach for first (a 13px grid is unreadable on a 27"
// display and oversized on a laptop), so they live in preferences instead.
//
// fontFamily is stored as a *stack fragment*, empty meaning "the built-in one".
// That built-in value is the composite "Tmux Desk Mono" face (styles.css), and
// it is not just a preference: it is what keeps fullwidth CJK punctuation one
// cell wide (see the @font-face comment there). A custom family is therefore
// prepended to it rather than replacing it — the user picks the Latin face and
// still inherits the CJK half of the stack.
const BASE_FONT_STACK = '"Tmux Desk Mono", Menlo, Monaco, Consolas, monospace';

const DEFAULT_TERMINAL_APPEARANCE = Object.freeze({
  fontFamily: '',
  fontSize: 13,
  lineHeight: 1.22,
  letterSpacing: 0,
});

const TERMINAL_APPEARANCE_FIELDS = Object.freeze([
  { key: 'fontSize', min: 8, max: 32, step: 1, integer: true },
  { key: 'lineHeight', min: 0.8, max: 2.4, step: 0.02, integer: false },
  { key: 'letterSpacing', min: -2, max: 4, step: 0.1, integer: false },
]);

const FIELD_BY_KEY = new Map(TERMINAL_APPEARANCE_FIELDS.map((field) => [field.key, field]));

// A font-family value is interpolated straight into a CSS property by xterm, so
// anything that could close the declaration and start another one has to go.
// Names are conservative on purpose: letters, digits, spaces, quotes, commas,
// hyphens and dots cover every real font name and nothing else.
function normalizeFontFamily(value) {
  if (typeof value !== 'string') return DEFAULT_TERMINAL_APPEARANCE.fontFamily;
  const family = value.trim().slice(0, 200);
  if (!family) return '';
  if (!/^[A-Za-z0-9 ,._'"-]+$/.test(family)) return '';
  return family;
}

function normalizeNumber(field, value) {
  const fallback = DEFAULT_TERMINAL_APPEARANCE[field.key];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(field.max, Math.max(field.min, number));
  // Round to the control's own step so a stored 1.2199999 does not keep
  // re-rendering the number input with a value it can never reproduce.
  return field.integer ? Math.round(clamped) : Math.round(clamped / field.step) * field.step;
}

function normalizeTerminalAppearance(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = { fontFamily: normalizeFontFamily(source.fontFamily) };
  for (const field of TERMINAL_APPEARANCE_FIELDS) {
    result[field.key] = normalizeNumber(field, source[field.key]);
  }
  return result;
}

function validateTerminalAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('终端外观设置无效');
  const allowed = new Set(['fontFamily', ...FIELD_BY_KEY.keys()]);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error('终端外观设置包含未知字段');
  if ('fontFamily' in value && typeof value.fontFamily !== 'string') throw new Error('终端字体无效');
  for (const field of TERMINAL_APPEARANCE_FIELDS) {
    if (!(field.key in value)) continue;
    const candidate = Number(value[field.key]);
    if (!Number.isFinite(candidate) || candidate < field.min || candidate > field.max) {
      throw new Error(`终端外观设置 ${field.key} 无效`);
    }
  }
  return normalizeTerminalAppearance(value);
}

// The stack actually handed to xterm: the user's family first (so it wins for
// Latin), the composite face behind it (so CJK stays double-width).
function terminalFontStack(appearance) {
  const { fontFamily } = normalizeTerminalAppearance(appearance);
  if (!fontFamily) return BASE_FONT_STACK;
  // Bare multi-word names need quoting; a value the user already quoted or
  // wrote as a comma list is passed through untouched.
  const quoted = /[",]/.test(fontFamily) || !/\s/.test(fontFamily)
    ? fontFamily
    : `"${fontFamily}"`;
  return `${quoted}, ${BASE_FONT_STACK}`;
}

module.exports = {
  BASE_FONT_STACK,
  DEFAULT_TERMINAL_APPEARANCE,
  TERMINAL_APPEARANCE_FIELDS,
  normalizeTerminalAppearance,
  terminalFontStack,
  validateTerminalAppearance,
};

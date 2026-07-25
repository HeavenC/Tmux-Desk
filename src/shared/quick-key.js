// Quick-bar key model shared by the mobile web client (bundled into the webapp)
// and the main-process preferences store (which validates what phones save).
//
// Besides the fixed `preset` buttons and free `text` buttons, a bar can hold
// `combo` entries: an arbitrary modifier set (⌃⌥⇧⌘) plus one key, encoded to a
// terminal byte sequence at send time. Legacy encodings are used whenever they
// exist (Ctrl-letter control chars, ESC-prefixed Option keys, `\e[1;5A`-style
// parameterized arrows); anything legacy can't express — notably ⌘/Super, and
// Ctrl+Shift — falls back to the CSI u ("extended keys") form. tmux is attached
// with `-T ...,extkeys` and `extended-keys on`, so it parses CSI u from us and
// re-encodes it for the foreground app in whatever form that app negotiated.

// Named (non-character) keys a combo can target.
//   csi:   CSI final byte      → `\e[A`      / `\e[1;<m>A`
//   ss3:   SS3 final byte      → `\eOP`      / `\e[1;<m>P`
//   tilde: CSI numeric key     → `\e[5~`     / `\e[5;<m>~`
//   base:  literal byte for a character-like key, with `code` its CSI u number
const NAMED_KEYS = {
  enter: { label: '⏎', base: '\r', code: 13 },
  tab: { label: '⇥', base: '\t', code: 9 },
  escape: { label: 'Esc', base: '\x1b', code: 27 },
  backspace: { label: '⌫', base: '\x7f', code: 127 },
  space: { label: '␣', base: ' ', code: 32 },
  up: { label: '↑', csi: 'A' },
  down: { label: '↓', csi: 'B' },
  right: { label: '→', csi: 'C' },
  left: { label: '←', csi: 'D' },
  home: { label: 'Home', csi: 'H' },
  end: { label: 'End', csi: 'F' },
  insert: { label: 'Ins', tilde: 2 },
  delete: { label: 'Del', tilde: 3 },
  pageup: { label: 'PgUp', tilde: 5 },
  pagedown: { label: 'PgDn', tilde: 6 },
  f1: { label: 'F1', ss3: 'P' },
  f2: { label: 'F2', ss3: 'Q' },
  f3: { label: 'F3', ss3: 'R' },
  f4: { label: 'F4', ss3: 'S' },
  f5: { label: 'F5', tilde: 15 },
  f6: { label: 'F6', tilde: 17 },
  f7: { label: 'F7', tilde: 18 },
  f8: { label: 'F8', tilde: 19 },
  f9: { label: 'F9', tilde: 20 },
  f10: { label: 'F10', tilde: 21 },
  f11: { label: 'F11', tilde: 23 },
  f12: { label: 'F12', tilde: 24 },
};

// Mac-style display order; also the CSI u modifier bit order (shift 1, alt 2,
// ctrl 4, super 8 — the mask is 1 + sum).
const MODIFIERS = [
  { id: 'ctrl', symbol: '⌃', bit: 4 },
  { id: 'alt', symbol: '⌥', bit: 2 },
  { id: 'shift', symbol: '⇧', bit: 1 },
  { id: 'meta', symbol: '⌘', bit: 8 },
];

// Characters that have a classic Ctrl- control code beyond the letters.
const CTRL_PUNCTUATION = { '@': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127, ' ': 0 };

function isNamedKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(NAMED_KEYS, key);
}

// A combo key is either a named key id or exactly one printable character.
function normalizeComboKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const named = value.toLowerCase();
  if (isNamedKey(named)) return named;
  const chars = [...value];
  if (chars.length !== 1) return null;
  const char = chars[0];
  const code = char.codePointAt(0);
  if (code < 0x20 || code === 0x7f) return null;
  return char;
}

function modifierMask(combo) {
  return MODIFIERS.reduce((mask, mod) => (combo[mod.id] ? mask | mod.bit : mask), 0);
}

function ctrlCode(char) {
  if (/^[a-zA-Z]$/.test(char)) return char.toUpperCase().charCodeAt(0) - 64;
  const punctuation = CTRL_PUNCTUATION[char];
  return punctuation === undefined ? null : punctuation;
}

function csiU(code, mask) {
  return mask ? `\x1b[${code};${mask + 1}u` : `\x1b[${code}u`;
}

// Encode a combo into the bytes to write to the pty. Returns '' for a key the
// model rejects (shouldn't happen for normalized entries).
function comboSequence(combo) {
  const key = normalizeComboKey(combo && combo.key);
  if (!key) return '';
  const mask = modifierMask(combo);
  const { ctrl, alt, shift, meta } = {
    ctrl: Boolean(combo.ctrl), alt: Boolean(combo.alt), shift: Boolean(combo.shift), meta: Boolean(combo.meta),
  };

  if (isNamedKey(key)) {
    const spec = NAMED_KEYS[key];
    // Cursor/function keys: the parameterized CSI form carries every modifier,
    // including ⌘, so no CSI u fallback is needed.
    if (spec.csi) return mask ? `\x1b[1;${mask + 1}${spec.csi}` : `\x1b[${spec.csi}`;
    if (spec.ss3) return mask ? `\x1b[1;${mask + 1}${spec.ss3}` : `\x1bO${spec.ss3}`;
    if (spec.tilde) return mask ? `\x1b[${spec.tilde};${mask + 1}~` : `\x1b[${spec.tilde}~`;
    // Character-like named keys (Enter/Tab/Esc/Backspace/Space).
    if (!mask) return spec.base;
    if (key === 'tab' && shift && !ctrl && !alt && !meta) return '\x1b[Z'; // back-tab
    if (key === 'space' && ctrl && !shift && !meta) return alt ? '\x1b\x00' : '\x00';
    if (!ctrl && !shift && !meta && alt) return `\x1b${spec.base}`;
    return csiU(spec.code, mask);
  }

  // Printable character.
  const control = ctrl ? ctrlCode(key) : null;
  // ⌘ has no legacy encoding, and Ctrl+Shift collapses onto plain Ctrl — both
  // only survive as CSI u (tmux downgrades for apps that can't read it).
  if (meta || (ctrl && shift) || (ctrl && control === null)) {
    return csiU(key.toLowerCase().codePointAt(0), mask);
  }
  let out = key;
  if (shift) out = out.toUpperCase();
  if (ctrl) out = String.fromCharCode(control);
  if (alt) out = `\x1b${out}`;
  return out;
}

function comboKeyLabel(key) {
  if (isNamedKey(key)) return NAMED_KEYS[key].label;
  return /^[a-z]$/.test(key) ? key.toUpperCase() : key;
}

// "⌥⌘C" — modifier symbols in Mac order, then the key.
function comboLabel(combo) {
  const key = normalizeComboKey(combo && combo.key);
  if (!key) return '';
  if (typeof combo.label === 'string' && combo.label.trim()) return combo.label.trim();
  const mods = MODIFIERS.filter((mod) => combo[mod.id]).map((mod) => mod.symbol).join('');
  return mods + comboKeyLabel(key);
}

// Human-readable form of an escape sequence, for the editor's preview/meta line.
function describeSequence(sequence) {
  return [...String(sequence)].map((char) => {
    const code = char.codePointAt(0);
    if (code === 27) return '\\e';
    if (code === 13) return '\\r';
    if (code === 10) return '\\n';
    if (code === 9) return '\\t';
    if (code === 0) return '\\0';
    if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, '0')}`;
    return char;
  }).join('');
}

function normalizeCombo(item) {
  const key = normalizeComboKey(item && item.key);
  if (!key) return null;
  const combo = { type: 'combo', key };
  for (const mod of MODIFIERS) {
    if (item[mod.id] === true) combo[mod.id] = true;
  }
  if (typeof item.label === 'string' && item.label.trim()) combo.label = item.label.trim().slice(0, 16);
  return combo;
}

// Single source of truth for what a stored quick-bar entry may look like; used
// by the web client on load and by the preferences store on save.
function normalizeQuickKeyEntry(item, { isPreset } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (item.type === 'preset') {
    if (typeof item.id !== 'string' || !item.id || item.id.length > 40) return null;
    if (typeof isPreset === 'function' && !isPreset(item.id)) return null;
    return { type: 'preset', id: item.id };
  }
  if (item.type === 'combo') return normalizeCombo(item);
  if (item.type === 'text' && typeof item.label === 'string' && typeof item.text === 'string') {
    const label = item.label.slice(0, 16);
    const text = item.text.slice(0, 200);
    if (!label || !text) return null;
    return { type: 'text', label, text, enter: item.enter === true };
  }
  return null;
}

module.exports = {
  NAMED_KEYS,
  MODIFIERS,
  comboSequence,
  comboLabel,
  comboKeyLabel,
  describeSequence,
  normalizeCombo,
  normalizeComboKey,
  normalizeQuickKeyEntry,
};

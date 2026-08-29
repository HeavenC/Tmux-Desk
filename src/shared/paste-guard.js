// Paste protection. A terminal paste is not inert text: with bracketed paste
// off (plain `sh`, a password prompt, an ssh session to an old box) every
// newline in the clipboard is an Enter, so pasting a snippet you skimmed runs
// every line of it. iTerm guards this with "warn before multi-line paste"; the
// same guard here, plus a size threshold, because a single 200 KB line is its
// own kind of accident.

const DEFAULT_PASTE_GUARD = Object.freeze({
  // Confirm anything that would submit more than one command.
  confirmMultiline: true,
  // Confirm a paste this large even on one line; 0 disables the size check.
  confirmChars: 4096,
  // Dribble the paste in instead of handing it over in one write — for TUIs
  // and serial-ish links that drop input when it arrives faster than they read.
  slow: false,
});

const SLOW_PASTE_CHUNK = 128;
const SLOW_PASTE_INTERVAL_MS = 40;

function normalizePasteGuard(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const chars = Number(source.confirmChars);
  return {
    confirmMultiline: typeof source.confirmMultiline === 'boolean'
      ? source.confirmMultiline
      : DEFAULT_PASTE_GUARD.confirmMultiline,
    confirmChars: Number.isFinite(chars)
      ? Math.round(Math.min(1000000, Math.max(0, chars)))
      : DEFAULT_PASTE_GUARD.confirmChars,
    slow: typeof source.slow === 'boolean' ? source.slow : DEFAULT_PASTE_GUARD.slow,
  };
}

function validatePasteGuard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('粘贴保护设置无效');
  const allowed = new Set(['confirmMultiline', 'confirmChars', 'slow']);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error('粘贴保护设置包含未知字段');
  for (const key of ['confirmMultiline', 'slow']) {
    if (key in value && typeof value[key] !== 'boolean') throw new Error(`粘贴保护设置 ${key} 无效`);
  }
  if ('confirmChars' in value) {
    const chars = Number(value.confirmChars);
    if (!Number.isFinite(chars) || chars < 0 || chars > 1000000) throw new Error('粘贴保护设置 confirmChars 无效');
  }
  return normalizePasteGuard(value);
}

// What the clipboard would actually do to the pane, ignoring how it is spelled:
// CR, LF and CRLF are all one Enter to the terminal, and a single trailing
// newline is how every "copy this command" button ends — warning about that one
// would train people to click through the dialog.
function inspectPaste(text) {
  const value = typeof text === 'string' ? text : '';
  const body = value.replace(/(\r\n|\r|\n)$/, '');
  const lines = body ? body.split(/\r\n|\r|\n/).length : 0;
  return { chars: value.length, lines, multiline: lines > 1, trailingNewline: value.length !== body.length };
}

function pasteDecision(text, guard) {
  const settings = normalizePasteGuard(guard);
  const info = inspectPaste(text);
  const overSize = settings.confirmChars > 0 && info.chars > settings.confirmChars;
  return {
    ...info,
    slow: settings.slow,
    confirm: (settings.confirmMultiline && info.multiline) || overSize,
    // Which rule fired, so the dialog can say why rather than just "are you sure".
    reason: settings.confirmMultiline && info.multiline ? 'multiline' : (overSize ? 'size' : null),
  };
}

// Chunks for a slow paste. Split on code points, never in the middle of a
// surrogate pair: half an emoji written to a pty is a mojibake byte sequence
// the application can never reassemble.
function chunkPaste(text, size = SLOW_PASTE_CHUNK) {
  const value = typeof text === 'string' ? text : '';
  const limit = Math.max(1, Math.round(size));
  const chunks = [];
  let current = '';
  for (const character of value) {
    current += character;
    if (current.length >= limit) { chunks.push(current); current = ''; }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  DEFAULT_PASTE_GUARD,
  SLOW_PASTE_CHUNK,
  SLOW_PASTE_INTERVAL_MS,
  chunkPaste,
  inspectPaste,
  normalizePasteGuard,
  pasteDecision,
  validatePasteGuard,
};

const UTF8_PATTERN = /utf-?8/i;
const DEFAULT_UTF8_LOCALE = 'en_US.UTF-8';

// When Tmux Desk is launched from Finder/Dock, the process inherits no
// LANG/LC_* variables, so the tmux CLI falls back to the C locale and
// sanitizes its formatted output — replacing the tab field separators (and
// every non-ASCII byte) with "_". That collapses each `list-sessions` record
// into one garbage field: blank names, 0 windows, and ids that no longer match
// `$<n>`. Guaranteeing a UTF-8 locale keeps tmux emitting real tabs + UTF-8.
function withUtf8Locale(env = process.env) {
  const source = env || {};
  if (UTF8_PATTERN.test(source.LC_ALL || source.LC_CTYPE || source.LANG || '')) {
    return { ...source };
  }
  return { ...source, LANG: source.LANG || DEFAULT_UTF8_LOCALE, LC_ALL: DEFAULT_UTF8_LOCALE };
}

module.exports = { withUtf8Locale, DEFAULT_UTF8_LOCALE };

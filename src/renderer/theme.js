const THEMES = new Set(['light', 'dark']);

function resolveTheme(theme, systemDark) {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return THEMES.has(theme) ? theme : 'light';
}

function applyTheme(documentElement, theme) {
  const resolved = THEMES.has(theme) ? theme : 'light';
  documentElement.dataset.theme = resolved;
  documentElement.style.colorScheme = resolved;
  return resolved;
}

module.exports = { applyTheme, resolveTheme };

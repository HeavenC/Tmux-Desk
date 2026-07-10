function normalizeShortcut(value) {
  return String(value || '')
    .replaceAll('⌘', ' cmd ')
    .replaceAll('⇧', ' shift ')
    .replaceAll('⌥', ' option ')
    .replaceAll('⌃', ' control ')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

function commandText(command) {
  return [
    command.title,
    command.subtitle,
    normalizeShortcut(command.shortcut),
    ...(Array.isArray(command.keywords) ? command.keywords : []),
  ].join(' ').toLocaleLowerCase();
}

function searchCommands(commands, query) {
  const items = Array.isArray(commands) ? commands : [];
  const tokens = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [...items];
  return items.filter((command) => {
    const haystack = commandText(command);
    return tokens.every((token) => haystack.includes(token));
  });
}

module.exports = { searchCommands };

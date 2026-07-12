const KNOWN_EXTENSIONLESS_FILES = new Set([
  'Dockerfile', 'Gemfile', 'LICENSE', 'Makefile', 'Procfile', 'Rakefile', 'README',
  '.env', '.gitignore', '.npmrc', '.prettierrc', '.tool-versions',
]);

const LOCATION_SUFFIX = /(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))$/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function normalizeReference(value) {
  let reference = String(value || '').replace(/\\ /g, ' ').trim();
  reference = reference.replace(LOCATION_SUFFIX, '');
  if (reference.startsWith('file://')) {
    try {
      const url = new URL(reference);
      reference = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(reference)) reference = reference.slice(1);
    } catch {
      return '';
    }
  }
  return reference;
}

function looksLikeFileReference(reference) {
  if (!reference || reference.includes('\0')) return false;
  if (URI_SCHEME.test(reference) && !reference.startsWith('file://')) return false;
  if (/^(?:file:\/\/\/|~\/|\/|\.\.?\/|[A-Za-z]:[\\/]|\\\\)/.test(reference)) return true;
  if (reference.includes('/') || reference.includes('\\')) return true;
  if (KNOWN_EXTENSIONLESS_FILES.has(reference)) return true;
  return /(?:^|[\\/])[^\\/]+\.[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(reference);
}

function trimToken(text, start, end) {
  while (start < end && /[([{<]/.test(text[start])) start += 1;
  while (end > start && /[,;!?:.]/.test(text[end - 1])) end -= 1;
  const openingFor = { ')': '(', ']': '[', '}': '{', '>': '<' };
  while (end > start && openingFor[text[end - 1]]) {
    const value = text.slice(start, end);
    const close = text[end - 1];
    const open = openingFor[close];
    const openCount = [...value].filter((char) => char === open).length;
    const closeCount = [...value].filter((char) => char === close).length;
    if (closeCount <= openCount) break;
    end -= 1;
  }
  return { start, end };
}

function addCandidate(text, start, end, results, occupied) {
  ({ start, end } = trimToken(text, start, end));
  if (start >= end) return;
  const display = text.slice(start, end);
  const reference = normalizeReference(display);
  if (!looksLikeFileReference(reference)) return;
  const key = `${start}:${end}`;
  if (occupied.has(key)) return;
  occupied.add(key);
  results.push({ text: display, reference, start, end });
}

// Find file-like tokens in one terminal line. Quoted paths may contain spaces;
// unquoted paths may use shell-style escaped spaces. The returned end offset is
// exclusive and location suffixes (file.js:12:3 / file.js(12,3)) stay inside
// the clickable range but are removed from `reference` before opening.
function findTerminalFileReferences(value) {
  const text = String(value || '');
  const results = [];
  const occupied = new Set();
  const quotedRanges = [];
  const quoted = /(["'])(.*?)\1/g;
  for (const match of text.matchAll(quoted)) {
    const start = match.index + 1;
    const end = start + match[2].length;
    quotedRanges.push([match.index, match.index + match[0].length]);
    addCandidate(text, start, end, results, occupied);
  }

  const unquoted = /(?:\\\s|[^\s])+/g;
  for (const match of text.matchAll(unquoted)) {
    const start = match.index;
    const end = start + match[0].length;
    if (quotedRanges.some(([from, to]) => start < to && end > from)) continue;
    addCandidate(text, start, end, results, occupied);
  }
  return results.sort((left, right) => left.start - right.start);
}

function normalizePosixPath(value) {
  const absolute = value.startsWith('/');
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}

function homeFromWorkingDirectory(cwd) {
  const match = String(cwd || '').match(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/);
  return match ? match[1] : null;
}

// Resolve a terminal reference without importing node:path so the helper stays
// browser-bundle friendly. tmux paths are POSIX on macOS/Linux/WSL; native
// Windows absolute paths are passed through for the main-process file bridge.
function resolveTerminalFileReference(value, cwd) {
  let reference = normalizeReference(value);
  if (!reference) return null;
  if (/^[A-Za-z]:[\\/]/.test(reference) || reference.startsWith('\\\\')) return reference;
  if (reference.startsWith('~/')) {
    const home = homeFromWorkingDirectory(cwd);
    if (!home) return null;
    reference = `${home}/${reference.slice(2)}`;
  }
  if (reference.startsWith('/')) return normalizePosixPath(reference);
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  return normalizePosixPath(`${cwd}/${reference}`);
}

module.exports = {
  findTerminalFileReferences,
  looksLikeFileReference,
  normalizeReference,
  resolveTerminalFileReference,
};

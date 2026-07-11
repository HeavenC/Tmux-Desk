const fsDefault = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Discover the recently-opened codebase directories of common coding agents and
// IDEs so the user can spin up one tmux session per project. Every source is
// best-effort: a missing or malformed config yields no entries instead of an
// error, so one broken tool never blocks the others.

function readJson(file, fs) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code keeps every project it has seen as a key in ~/.claude.json.
function claudeCodebases({ home, fs }) {
  const data = readJson(path.join(home, '.claude.json'), fs);
  return data && data.projects && typeof data.projects === 'object'
    ? Object.keys(data.projects)
    : [];
}

// The Codex app records its workspace roots in a global-state JSON; the union of
// these arrays covers both the current and previously opened projects.
function codexCodebases({ home, fs }) {
  const data = readJson(path.join(home, '.codex', '.codex-global-state.json'), fs);
  if (!data) return [];
  return [
    ...(Array.isArray(data['project-order']) ? data['project-order'] : []),
    ...(Array.isArray(data['electron-saved-workspace-roots']) ? data['electron-saved-workspace-roots'] : []),
    ...(Array.isArray(data['active-workspace-roots']) ? data['active-workspace-roots'] : []),
  ];
}

// Every JetBrains IDE (IntelliJ, PyCharm, WebStorm, …) lists recent projects in
// options/recentProjects.xml as `key="$USER_HOME$/path"` attributes.
function jetbrainsCodebases({ home, fs }) {
  const base = path.join(home, 'Library', 'Application Support', 'JetBrains');
  let products;
  try {
    products = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const product of products) {
    let xml;
    try {
      xml = fs.readFileSync(path.join(base, product, 'options', 'recentProjects.xml'), 'utf8');
    } catch {
      continue;
    }
    for (const match of xml.matchAll(/key="([^"]+)"/g)) {
      const raw = match[1];
      if (!raw.includes('/')) continue; // skip non-path keys
      const expanded = raw.replace('$USER_HOME$', home);
      if (expanded.startsWith('$')) continue; // an unresolved macro we can't map
      out.push(expanded);
    }
  }
  return out;
}

// VS Code / Cursor store recent folders as file:// URIs. Modern builds keep them
// in a SQLite state DB we deliberately don't depend on; this reads whatever JSON
// stores still carry them, and simply finds nothing when only SQLite exists.
function vscodeCodebases({ home, fs }) {
  const candidates = [
    ['Code', 'User', 'globalStorage', 'storage.json'],
    ['Code', 'storage.json'],
    ['Cursor', 'User', 'globalStorage', 'storage.json'],
    ['Cursor', 'storage.json'],
  ];
  const out = [];
  for (const parts of candidates) {
    let text;
    try {
      text = fs.readFileSync(path.join(home, 'Library', 'Application Support', ...parts), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/"file:\/\/([^"]*)"/g)) {
      let decoded;
      try {
        decoded = decodeURIComponent(match[1]);
      } catch {
        continue;
      }
      if (decoded.startsWith('/')) out.push(decoded);
    }
  }
  return out;
}

const SOURCES = [
  ['claude', claudeCodebases],
  ['codex', codexCodebases],
  ['idea', jetbrainsCodebases],
  ['vscode', vscodeCodebases],
];

// tmux session names can't contain '.', ':', or control characters (see
// validateName in tmux-service). Derive a safe name from the directory's base.
function sessionNameFor(dir) {
  const base = path.basename(dir.replace(/[\\/]+$/, ''));
  const cleaned = base.replace(/[.:\x00-\x1f\x7f]/g, '_').trim();
  return cleaned.slice(0, 80) || 'session';
}

function isDirectory(dir, fs) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Merge every source into a deduplicated list of existing directories, each
// tagged with which tools reference it. Insertion order is preserved so a tool's
// own recency ordering survives into the per-tool filtered view.
function discoverCodebases({ home = os.homedir(), fsImpl = fsDefault } = {}) {
  const byPath = new Map();
  for (const [source, collect] of SOURCES) {
    let dirs;
    try {
      dirs = collect({ home, fs: fsImpl });
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      if (typeof dir !== 'string' || !dir) continue;
      const normalized = path.normalize(dir).replace(/[\\/]+$/, '') || dir;
      if (!isDirectory(normalized, fsImpl)) continue;
      let entry = byPath.get(normalized);
      if (!entry) {
        entry = { path: normalized, name: sessionNameFor(normalized), sources: [] };
        byPath.set(normalized, entry);
      }
      if (!entry.sources.includes(source)) entry.sources.push(source);
    }
  }
  return [...byPath.values()];
}

module.exports = {
  discoverCodebases,
  sessionNameFor,
  // exported for focused unit tests
  claudeCodebases,
  codexCodebases,
  jetbrainsCodebases,
  vscodeCodebases,
};

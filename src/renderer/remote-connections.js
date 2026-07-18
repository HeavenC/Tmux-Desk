// Remote connections now live in the main-process preferences store (so the
// web-server can read reshare-enabled hosts' tokens to relay). Earlier builds
// kept them in localStorage; this module only migrates those legacy entries the
// first time, then clears them.
const STORAGE_KEY = 'tmux-desk.remoteConnections';

function loadLegacyConnections() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry === 'object'
        && typeof entry.base === 'string' && typeof entry.token === 'string')
      .map((entry) => ({
        url: entry.base,
        token: entry.token,
        label: typeof entry.label === 'string' ? entry.label : '',
      }));
  } catch {
    return [];
  }
}

function clearLegacy() {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

module.exports = { STORAGE_KEY, loadLegacyConnections, clearLegacy };

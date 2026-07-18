// Shared rules for remote takeover connections, used by BOTH the renderer
// (add-remote UX) and the main process (validation + web-server relay), so the
// two never disagree on how a URL is parsed or how a cross-source session target
// is qualified.

const LOCAL_TARGET = /^\$\d+$/;
// A relayed session id: r:<connId>:$<n>. connId matches the ids minted by the
// preferences store (`remote-xxxx`).
const REMOTE_TARGET = /^r:([a-zA-Z0-9-]{1,64}):(\$\d+)$/;

function qualifyTarget(connId, rawId) {
  return `r:${connId}:${rawId}`;
}

// Classify a session/grouped target from the web protocol. Returns null for
// anything that is neither a local tmux id nor a well-formed relayed id.
function parseTarget(target) {
  if (typeof target !== 'string') return null;
  if (LOCAL_TARGET.test(target)) return { kind: 'local', id: target };
  const match = REMOTE_TARGET.exec(target);
  if (match) return { kind: 'remote', connId: match[1], id: match[2] };
  return null;
}

// Accept anything from a bare host (`192.168.64.3:8790`) to a full share URL the
// remote's mobile-access panel produced (`http://host:8790/?token=abc`). Keep
// origin + pathname (so a reverse-proxied subpath survives), drop the query, and
// pull the token out of it when the token field was left blank.
function parseConnectionInput({ label, url, token } = {}) {
  let raw = String(url || '').trim();
  if (!raw) throw new Error('请填写远程地址');
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('远程地址无效');
  }
  let finalToken = String(token || '').trim();
  const urlToken = parsed.searchParams.get('token');
  if (!finalToken && urlToken) finalToken = urlToken.trim();
  if (!finalToken) throw new Error('请填写访问令牌（或粘贴带 token 的分享地址）');
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  const displayLabel = String(label || '').trim() || parsed.host;
  return { base, token: finalToken, label: displayLabel };
}

function toWsBase(base) {
  if (/^https:/i.test(base)) return `wss${base.slice('https'.length)}`;
  if (/^http:/i.test(base)) return `ws${base.slice('http'.length)}`;
  return base;
}

module.exports = {
  LOCAL_TARGET,
  REMOTE_TARGET,
  qualifyTarget,
  parseTarget,
  parseConnectionInput,
  toWsBase,
};

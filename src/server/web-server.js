const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { WebSocketServer, WebSocket } = require('ws');

const { parseTarget, qualifyTarget, toWsBase } = require('../shared/remote-connection');
const { validateSessionTags } = require('../main/ipc');
const {
  PreferencesStore,
  defaultPreferencesFilePath,
  normalizePreferences,
} = require('../main/preferences-store');
const {
  stageImageForPaste,
  decodeImagePayload,
  MAX_IMAGE_BYTES,
} = require('../main/clipboard-image');
const { TerminalManager } = require('../main/terminal-manager');
const { TmuxService } = require('../main/tmux-service');

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 8790;
const SESSION_TARGET = /^\$\d+$/;
const WEB_SESSION_PREFIX = '_web_';
const STATIC_ROOT = path.resolve(__dirname, '..', '..', 'webapp-dist');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function tokenFilePath() {
  return path.join(os.homedir(), '.config', 'tmux-desk', 'web-token');
}

function loadToken() {
  if (process.env.TMUX_DESK_WEB_TOKEN) return process.env.TMUX_DESK_WEB_TOKEN.trim();
  const file = tokenFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* generate a fresh token below */ }
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function validShareSessionName(value) {
  return typeof value === 'string'
    && Boolean(value.trim())
    && value === value.trim()
    && Array.from(value).length <= 80
    && !/[.:\x00-\x1f\x7f]/.test(value);
}

function createSessionShareToken(token, sessionName) {
  if (typeof token !== 'string' || !token || !validShareSessionName(sessionName)) {
    throw new Error('无法为无效会话创建分享链接');
  }
  const payload = Buffer.from(JSON.stringify({ v: 1, sessionName }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', token).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionShareToken(token, candidate) {
  if (typeof token !== 'string' || !token || typeof candidate !== 'string' || candidate.length > 2048) return null;
  const parts = candidate.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', token).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1 || !validShareSessionName(payload.sessionName)) return null;
    return { sessionName: payload.sessionName };
  } catch {
    return null;
  }
}

function isTailscaleAddress(address) {
  const octets = address.split('.').map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

async function defaultRouteInterface() {
  try {
    const { stdout } = await execFileAsync('/sbin/route', ['-n', 'get', 'default']);
    return (String(stdout).match(/interface:\s*(\S+)/) || [])[1] || null;
  } catch {
    return null;
  }
}

// Enumerate reachable URLs for this server: Tailscale first, then LAN, then
// everything else. "LAN" means a physical interface (en0/en1 = WiFi/Ethernet) —
// a VPN or proxy tunnel often owns the default route, so routing is no signal
// of what the phone can actually reach.
async function listAccessUrls({ port = DEFAULT_PORT, token } = {}) {
  const routeInterface = await defaultRouteInterface();
  const urls = [];
  for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
    for (const net of interfaces || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const kind = isTailscaleAddress(net.address) ? 'tailscale' : (/^en\d+$/.test(name) ? 'lan' : 'other');
      urls.push({ kind, address: net.address, interface: name, url: `http://${net.address}:${port}/?token=${token}` });
    }
  }
  const rank = { tailscale: 0, lan: 1, other: 2 };
  urls.sort((left, right) => (rank[left.kind] - rank[right.kind])
    || (Number(right.interface === routeInterface) - Number(left.interface === routeInterface)));
  return urls;
}

function publicPreferences(value, sessionName) {
  const preferences = normalizePreferences(value);
  const scoped = typeof sessionName === 'string';
  const scopedTagIds = new Set(scoped ? (preferences.sessionTags[sessionName] || []) : []);
  const tags = scoped
    ? preferences.tags.filter((tag) => scopedTagIds.has(tag.id))
    : preferences.tags;
  const favorites = scoped
    ? preferences.favorites.filter((name) => name === sessionName)
    : preferences.favorites;
  const sessionTags = scoped && preferences.sessionTags[sessionName]
    ? { [sessionName]: preferences.sessionTags[sessionName] }
    : (scoped ? {} : preferences.sessionTags);
  const tabOrders = scoped
    ? Object.fromEntries(Object.entries(preferences.tabOrders)
      .map(([view, names]) => [view, names.filter((name) => name === sessionName)])
      .filter(([, names]) => names.length))
    : preferences.tabOrders;
  return {
    tags,
    favorites,
    sessionTags,
    // Mobile has no drag UI, but it should still show the desktop's manual
    // tab order rather than falling back to activity/alphabetical sorting.
    tabOrders,
    // Custom quick keys can contain user-authored command text. Keep them out
    // of a session capability response; shared clients fall back to local
    // defaults and cannot mutate the machine-wide quick-key configuration.
    webQuickKeys: scoped ? [] : preferences.webQuickKeys,
  };
}

function startWebServer({
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  token,
  log = () => {},
  service: providedService,
  preferencesStore: providedPreferencesStore,
} = {}) {
  if (!token) token = loadToken();

  const socketName = typeof process.env.TMUX_DESK_SOCKET === 'string' && process.env.TMUX_DESK_SOCKET.trim()
    ? process.env.TMUX_DESK_SOCKET.trim()
    : null;
  const service = providedService || new TmuxService({ socketName });
  const preferencesStore = providedPreferencesStore || new PreferencesStore({
    filePath: defaultPreferencesFilePath(),
  });
  // A grouped session is a browser-only view derived from one public source
  // session. Keep the source association so a scoped share cannot use a valid
  // grouped id that belongs to a different shared session.
  const liveGrouped = new Map();
  let groupedCounter = 1;

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string' || !candidate) return false;
    const expected = crypto.createHash('sha256').update(token).digest();
    const actual = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(expected, actual);
  }

  function authenticateUrl(url) {
    if (tokenMatches(url.searchParams.get('token'))) return { sessionName: null };
    return verifySessionShareToken(token, url.searchParams.get('share'));
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  }

  function sendError(res, status, message) {
    sendJson(res, status, { ok: false, error: message });
  }

  function serveStatic(res, filePath, cacheable) {
    const resolved = path.resolve(filePath);
    if (resolved !== STATIC_ROOT && !resolved.startsWith(STATIC_ROOT + path.sep)) {
      return sendError(res, 404, '未找到资源');
    }
    fs.readFile(resolved, (error, data) => {
      if (error) return sendError(res, 404, '未找到资源');
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': cacheable ? 'max-age=300' : 'no-store',
      });
      res.end(data);
    });
  }

  async function readJsonBody(req, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async function createGroupedSession(sourceId) {
    const name = `${WEB_SESSION_PREFIX}${groupedCounter++}_${crypto.randomBytes(2).toString('hex')}`;
    const { stdout } = await service.run([
      'new-session', '-d', '-P', '-F', '#{session_id}', '-t', sourceId, '-s', name,
    ]);
    const groupedId = String(stdout || '').trim();
    liveGrouped.set(groupedId, sourceId);
    return groupedId;
  }

  async function destroyGroupedSession(groupedId) {
    if (!liveGrouped.delete(groupedId)) return;
    try { await service.killSession(groupedId); } catch { /* already gone */ }
  }

  async function cleanupStaleWebSessions() {
    try {
      // Size windows by the clients actually viewing them, so a 48-column phone
      // reading window A doesn't shrink the desktop's window B in the same group.
      try { await service.run(['set-option', '-g', 'aggressive-resize', 'on']); } catch { /* best-effort */ }
      const sessions = await service.listSessions();
      for (const session of sessions) {
        if (!session.name.startsWith(WEB_SESSION_PREFIX)) continue;
        try { await service.killSession(session.id); } catch { /* already gone */ }
      }
    } catch { /* no tmux server yet — nothing to clean */ }
  }

  async function listPublicSessions() {
    return (await service.listSessions()).filter((session) => !session.name.startsWith(WEB_SESSION_PREFIX));
  }

  // Remote takeover hosts this machine is allowed to relay onward. Only hosts the
  // user explicitly opted into ("允许再分享") are exposed to web clients.
  function reshareConnections(preferences) {
    return (preferences.remoteConnections || [])
      .filter((connection) => connection.reshare && connection.base && connection.token);
  }

  async function findReshareConnection(connId) {
    const preferences = await preferencesStore.load();
    return reshareConnections(preferences).find((connection) => connection.id === connId) || null;
  }

  // Issue a REST call to an upstream remote host as its client, using that host's
  // stored token. Times out so one dead remote can't hang an aggregate request.
  async function upstreamRequest(connection, pathname, { method = 'GET', body, params, timeout = 4000 } = {}) {
    const url = new URL(`${connection.base}${pathname}`);
    url.searchParams.set('token', connection.token);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const options = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.error) || `远程请求失败（${response.status}）`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // Merge reshare-enabled remotes' sessions into the local list, qualifying each
  // remote session id (r:<connId>:<$n>) so ids never collide across hosts. A dead
  // or unreachable remote is skipped rather than failing the whole list.
  async function aggregateRemoteSessions(preferences) {
    const remotes = reshareConnections(preferences);
    const results = await Promise.all(remotes.map(async (connection) => {
      try {
        const payload = await upstreamRequest(connection, '/api/sessions');
        return (payload.sessions || []).map((session) => ({
          ...session,
          id: qualifyTarget(connection.id, session.id),
          source: { id: connection.id, label: connection.label },
        }));
      } catch {
        return [];
      }
    }));
    return results.flat();
  }

  function findScopedSession(sessions, sessionName) {
    if (sessionName === null) return null;
    return sessions.find((session) => session.name === sessionName) || null;
  }

  function targetAllowedByScope(target, scopedSession) {
    return target === scopedSession.id || liveGrouped.get(target) === scopedSession.id;
  }

  async function requireScopedTarget(res, sessionName, target) {
    if (sessionName === null) return true;
    const scopedSession = findScopedSession(await listPublicSessions(), sessionName);
    if (!scopedSession) {
      sendError(res, 404, '共享会话不存在或已关闭');
      return false;
    }
    if (!targetAllowedByScope(target, scopedSession)) {
      sendError(res, 403, '无权访问此会话');
      return false;
    }
    return true;
  }

  async function handleApi(req, res, url, access) {
    const scope = access.sessionName;
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const [sessions, preferences] = await Promise.all([
        listPublicSessions(),
        preferencesStore.load(),
      ]);
      const scopedSession = findScopedSession(sessions, scope);
      // Full-token clients also see reshare-enabled remotes' sessions (relayed
      // through this host); scoped single-session shares stay strictly local.
      const remoteSessions = scope === null ? await aggregateRemoteSessions(preferences) : [];
      return sendJson(res, 200, {
        ok: true,
        sessions: scope === null
          ? [...sessions, ...remoteSessions]
          : (scopedSession ? [scopedSession] : []),
        preferences: publicPreferences(preferences, scope === null ? undefined : (scopedSession?.name || '')),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/session-tags') {
      if (scope !== null) return sendError(res, 403, '共享链接不允许修改会话设置');
      const { sessionName, tagIds } = validateSessionTags(await readJsonBody(req));
      const sessions = await listPublicSessions();
      if (!sessions.some((session) => session.name === sessionName)) {
        return sendError(res, 404, '会话不存在');
      }
      const preferences = await preferencesStore.setSessionTags(sessionName, tagIds);
      return sendJson(res, 200, {
        ok: true,
        preferences: publicPreferences(preferences),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/quick-keys') {
      if (scope !== null) return sendJson(res, 200, { ok: true, keys: [] });
      // The floating quick-key bar follows the session's owning host: when the
      // client is viewing a relayed remote session, return that upstream host's
      // bar (relayed through this host) instead of the local one.
      const parsed = parseTarget(url.searchParams.get('session'));
      if (parsed && parsed.kind === 'remote') {
        const connection = await findReshareConnection(parsed.connId);
        if (connection) {
          try {
            const payload = await upstreamRequest(connection, '/api/quick-keys', { params: { session: parsed.id } });
            return sendJson(res, 200, { ok: true, keys: Array.isArray(payload.keys) ? payload.keys : [] });
          } catch { /* upstream unreachable — fall back to this host's bar */ }
        }
      }
      const preferences = await preferencesStore.load();
      return sendJson(res, 200, { ok: true, keys: preferences.webQuickKeys });
    }
    if (req.method === 'POST' && url.pathname === '/api/quick-keys') {
      if (scope !== null) return sendError(res, 403, '共享链接不允许修改快捷键设置');
      const body = await readJsonBody(req);
      const keys = Array.isArray(body) ? body : (body && Array.isArray(body.keys) ? body.keys : null);
      if (!keys) return sendError(res, 400, '快捷键格式无效');
      const preferences = await preferencesStore.setWebQuickKeys(keys);
      return sendJson(res, 200, { ok: true, preferences: publicPreferences(preferences) });
    }
    if (req.method === 'GET' && url.pathname === '/api/session-detail') {
      const target = url.searchParams.get('session');
      const parsed = parseTarget(target);
      if (parsed && parsed.kind === 'remote') {
        if (scope !== null) return sendError(res, 403, '无权访问此会话');
        const connection = await findReshareConnection(parsed.connId);
        if (!connection) return sendError(res, 404, '远程会话不可用');
        const detail = await upstreamRequest(connection, '/api/session-detail', { params: { session: parsed.id } });
        return sendJson(res, 200, { ok: true, windows: detail.windows || [], panes: detail.panes || [] });
      }
      if (!await requireScopedTarget(res, scope, target)) return;
      const detail = await service.getSessionDetail(target);
      return sendJson(res, 200, { ok: true, ...detail });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-window') {
      const { grouped, windowIndex } = await readJsonBody(req);
      const parsedGrouped = parseTarget(grouped);
      if (parsedGrouped && parsedGrouped.kind === 'remote') {
        // The grouped id was rewritten to r:<connId>:<$n> when the relayed WS
        // reported ready; route the switch back to that upstream host.
        if (scope !== null) return sendError(res, 403, '无权访问此会话');
        if (!Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex > 999) {
          return sendError(res, 400, '无效的窗口序号');
        }
        const connection = await findReshareConnection(parsedGrouped.connId);
        if (!connection) return sendError(res, 404, '远程会话不可用');
        await upstreamRequest(connection, '/api/select-window', {
          method: 'POST',
          body: { grouped: parsedGrouped.id, windowIndex },
        });
        return sendJson(res, 200, { ok: true });
      }
      if (typeof grouped !== 'string' || !SESSION_TARGET.test(grouped) || !liveGrouped.has(grouped)) {
        return sendError(res, 400, '无效的派生会话');
      }
      if (!await requireScopedTarget(res, scope, grouped)) return;
      if (!Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex > 999) {
        return sendError(res, 400, '无效的窗口序号');
      }
      await service.run(['select-window', '-t', `${grouped}:${windowIndex}`]);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/paste-image') {
      // Base64 inflates by 4/3, plus JSON overhead; the phone downscales first
      // so a real payload lands well under this.
      const body = await readJsonBody(req, Math.ceil(MAX_IMAGE_BYTES * 1.4) + 4096);
      const target = body.session;
      const parsed = parseTarget(target);
      if (parsed && parsed.kind === 'remote') {
        // The clipboard that matters is the one on the machine running the
        // session, so a relayed target has to be handled by ITS host, not here.
        if (scope !== null) return sendError(res, 403, '无权访问此会话');
        const connection = await findReshareConnection(parsed.connId);
        if (!connection) return sendError(res, 404, '远程会话不可用');
        const staged = await upstreamRequest(connection, '/api/paste-image', {
          method: 'POST',
          body: { session: parsed.id, mime: body.mime, data: body.data },
          timeout: 30000,
        });
        // The path in the reply is on the upstream host — which is exactly the
        // machine the session runs on, so it's the one worth passing along.
        return sendJson(res, 200, { ok: true, path: staged.path, clipboard: staged.clipboard === true });
      }
      if (typeof target !== 'string' || !SESSION_TARGET.test(target)) {
        return sendError(res, 400, '无效的会话');
      }
      if (!await requireScopedTarget(res, scope, target)) return;
      const { buffer, mime } = decodeImagePayload(body);
      const staged = await stageImageForPaste(buffer, mime);
      return sendJson(res, 200, { ok: true, ...staged });
    }
    return sendError(res, 404, '未知接口');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal');
    try {
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname.startsWith('/assets/')) {
        // Asset filenames are stable across releases, so caching can pair a new
        // HTML/API shape with stale JS after an app upgrade.
        return serveStatic(res, path.join(STATIC_ROOT, 'assets', path.basename(url.pathname)), false);
      }
      const access = authenticateUrl(url);
      if (!access) {
        return sendError(res, 401, '缺少或错误的访问令牌');
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return serveStatic(res, path.join(STATIC_ROOT, 'index.html'), false);
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url, access);
      }
      return sendError(res, 404, '未找到资源');
    } catch (error) {
      return sendError(res, error && error.name === 'TmuxError' ? 500 : 400, error?.message || '请求失败');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://internal');
    const access = authenticateUrl(url);
    if (url.pathname !== '/ws' || !access) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function wsSend(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  // Relay a downstream client's terminal WS to an upstream remote host, byte for
  // byte. The only rewrite is the 'ready' message's grouped id, qualified to
  // r:<connId>:<$n> so a later /api/select-window routes back to this host.
  function proxyRemoteWs(downstream, connection, sessionId, cols, rows) {
    const upstreamUrl = new URL(`${toWsBase(connection.base)}/ws`);
    upstreamUrl.searchParams.set('token', connection.token);
    upstreamUrl.searchParams.set('session', sessionId);
    upstreamUrl.searchParams.set('cols', String(cols));
    upstreamUrl.searchParams.set('rows', String(rows));

    let upstream;
    try {
      upstream = new WebSocket(upstreamUrl.toString());
    } catch {
      wsSend(downstream, { type: 'error', message: '无法连接远程主机' });
      try { downstream.close(); } catch { /* already closed */ }
      return;
    }

    const pending = [];
    let sawReady = false;
    let closed = false;
    const teardown = () => {
      if (closed) return;
      closed = true;
      try { upstream.close(); } catch { /* already closing */ }
      try { downstream.close(); } catch { /* already closing */ }
    };

    upstream.on('open', () => {
      for (const message of pending.splice(0)) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
      }
    });
    upstream.on('message', (raw) => {
      if (downstream.readyState !== downstream.OPEN) return;
      if (!sawReady) {
        let message = null;
        try { message = JSON.parse(String(raw)); } catch { /* forward as-is below */ }
        if (message && message.type === 'ready') {
          sawReady = true;
          if (message.grouped) message.grouped = qualifyTarget(connection.id, message.grouped);
          downstream.send(JSON.stringify(message));
          return;
        }
      }
      // Post-ready (and any non-ready pre-ready frame): forward verbatim.
      downstream.send(typeof raw === 'string' ? raw : raw.toString());
    });
    upstream.on('close', teardown);
    upstream.on('error', () => {
      wsSend(downstream, { type: 'error', message: '远程连接错误' });
      teardown();
    });

    downstream.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else pending.push(text);
    });
    downstream.on('close', teardown);
    downstream.on('error', teardown);
    // Keep the heartbeat sweep from terminating this relayed client.
    downstream.isAlive = true;
    downstream.on('pong', () => { downstream.isAlive = true; });
  }

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://internal');
    const access = authenticateUrl(url);
    const scope = access.sessionName;
    const sourceId = url.searchParams.get('session');
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    const parsedSource = parseTarget(sourceId);
    if (!parsedSource) {
      wsSend(ws, { type: 'error', message: '无效的会话目标' });
      ws.close();
      return;
    }

    if (parsedSource.kind === 'remote') {
      // Relayed session: only full-token clients may reach remotes, and only
      // reshare-enabled hosts are routable.
      if (scope !== null) {
        wsSend(ws, { type: 'error', message: '无权访问此会话' });
        ws.close();
        return;
      }
      const connection = await findReshareConnection(parsedSource.connId);
      if (!connection) {
        wsSend(ws, { type: 'error', message: '远程会话不可用' });
        ws.close();
        return;
      }
      proxyRemoteWs(ws, connection, parsedSource.id, cols, rows);
      return;
    }

    if (scope !== null) {
      try {
        const scopedSession = findScopedSession(await listPublicSessions(), scope);
        if (!scopedSession) {
          wsSend(ws, { type: 'error', message: '共享会话不存在或已关闭' });
          ws.close();
          return;
        }
        if (sourceId !== scopedSession.id) {
          wsSend(ws, { type: 'error', message: '无权访问此会话' });
          ws.close();
          return;
        }
      } catch (error) {
        wsSend(ws, { type: 'error', message: error?.message || '连接失败' });
        ws.close();
        return;
      }
    }

    let groupedId = null;
    let manager = null;
    let closed = false;

    const teardown = () => {
      if (closed) return;
      closed = true;
      manager?.dispose();
      if (groupedId) destroyGroupedSession(groupedId);
    };

    try {
      const tmuxPath = await service.resolveTmuxPath();
      if (!tmuxPath) throw new Error('未找到 tmux');
      groupedId = await createGroupedSession(sourceId);
      // Touch scrolling on mobile needs tmux mouse mode; apply the same UX
      // baseline as the desktop attach to the grouped session
      // (fire-and-forget, session options apply live).
      preferencesStore.load()
        .then((preferences) => service.applySessionDefaults(groupedId, preferences.tmuxSettings))
        .catch(() => {});
      manager = new TerminalManager({
        tmuxPath,
        socketName: service.socketName,
        sendEvent: (channel, payload) => {
          if (channel === 'terminal:data') wsSend(ws, { type: 'data', data: payload.data });
          if (channel === 'terminal:exit') {
            wsSend(ws, { type: 'exit' });
            teardown();
            ws.close();
          }
        },
      });
      const { terminalId } = manager.attach({ sessionId: groupedId, cols, rows });
      wsSend(ws, { type: 'ready', terminalId, grouped: groupedId });
      log(`[ws] attach ${sourceId} via ${groupedId} (${cols}x${rows})`);

      ws.on('message', (raw) => {
        let message = null;
        try { message = JSON.parse(String(raw)); } catch { return; }
        try {
          if (message.type === 'input') manager.write({ terminalId, data: message.data });
          if (message.type === 'resize') manager.resize({ terminalId, cols: message.cols, rows: message.rows });
          // Wheel scroll: drive tmux copy-mode on the grouped session this client
          // views (never mouse events — a foreground agent that grabbed mouse
          // reporting would otherwise swallow them). copy-mode -e auto-exits to the
          // live screen when scrolled past the bottom, so the tail is always reachable.
          if (message.type === 'scroll') service.scrollSession(groupedId, message.lines).catch(() => {});
          // Browser tab gained focus: send a focus-in report so tmux marks this
          // client as the "latest" one — with window-size=latest the shared
          // window then snaps to THIS client's width instead of staying at the
          // last-active client's (which leaves a dead strip on the wider view).
          // tmux consumes the sequence itself (verified with focus-events off:
          // nothing leaks into the pane application).
          if (message.type === 'focus') manager.write({ terminalId, data: '\x1b[I' });
          if (message.type === 'ping') wsSend(ws, { type: 'pong' });
        } catch (error) {
          wsSend(ws, { type: 'error', message: error?.message || '操作失败' });
        }
      });
    } catch (error) {
      wsSend(ws, { type: 'error', message: error?.message || '连接失败' });
      teardown();
      ws.close();
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      log(`[ws] detach ${groupedId}`);
      teardown();
    });
    ws.on('error', teardown);
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    for (const groupedId of [...liveGrouped.keys()]) await destroyGroupedSession(groupedId);
    await new Promise((resolve) => server.close(resolve));
  }

  return cleanupStaleWebSessions().then(() => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve({
        port: address && typeof address === 'object' ? address.port : port,
        host,
        token,
        close,
      });
    });
  }));
}

// Probe whether some other process (e.g. the CLI daemon) accepts a specific
// credential. web-control probes both the global token and a freshly minted
// share capability so an old daemon cannot be mistaken for a compatible one.
async function probeExternalServer({ port = DEFAULT_PORT, token, share } = {}) {
  const params = new URLSearchParams();
  if (typeof share === 'string' && share) params.set('share', share);
  else if (typeof token === 'string' && token) params.set('token', token);
  else return false;
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions?${params}`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_PORT,
  WEB_SESSION_PREFIX,
  createSessionShareToken,
  loadToken,
  listAccessUrls,
  publicPreferences,
  startWebServer,
  probeExternalServer,
  verifySessionShareToken,
};

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { WebSocketServer } = require('ws');

const { validateSessionTags } = require('../main/ipc');
const {
  PreferencesStore,
  defaultPreferencesFilePath,
  normalizePreferences,
} = require('../main/preferences-store');
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

function publicPreferences(value) {
  const preferences = normalizePreferences(value);
  return {
    tags: preferences.tags,
    favorites: preferences.favorites,
    sessionTags: preferences.sessionTags,
    // Mobile has no drag UI, but it should still show the desktop's manual
    // tab order rather than falling back to activity/alphabetical sorting.
    tabOrders: preferences.tabOrders,
    // Shared across every phone that connects to this machine.
    webQuickKeys: preferences.webQuickKeys,
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

  const service = providedService || new TmuxService();
  const preferencesStore = providedPreferencesStore || new PreferencesStore({
    filePath: defaultPreferencesFilePath(),
  });
  const liveGrouped = new Set();
  let groupedCounter = 1;

  function tokenMatches(candidate) {
    if (typeof candidate !== 'string' || !candidate) return false;
    const expected = crypto.createHash('sha256').update(token).digest();
    const actual = crypto.createHash('sha256').update(candidate).digest();
    return crypto.timingSafeEqual(expected, actual);
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

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error('请求体过大');
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
    liveGrouped.add(groupedId);
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

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const [sessions, preferences] = await Promise.all([
        listPublicSessions(),
        preferencesStore.load(),
      ]);
      return sendJson(res, 200, {
        ok: true,
        sessions,
        preferences: publicPreferences(preferences),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/session-tags') {
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
      const preferences = await preferencesStore.load();
      return sendJson(res, 200, { ok: true, keys: preferences.webQuickKeys });
    }
    if (req.method === 'POST' && url.pathname === '/api/quick-keys') {
      const body = await readJsonBody(req);
      const keys = Array.isArray(body) ? body : (body && Array.isArray(body.keys) ? body.keys : null);
      if (!keys) return sendError(res, 400, '快捷键格式无效');
      const preferences = await preferencesStore.setWebQuickKeys(keys);
      return sendJson(res, 200, { ok: true, preferences: publicPreferences(preferences) });
    }
    if (req.method === 'GET' && url.pathname === '/api/session-detail') {
      const detail = await service.getSessionDetail(url.searchParams.get('session'));
      return sendJson(res, 200, { ok: true, ...detail });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-window') {
      const { grouped, windowIndex } = await readJsonBody(req);
      if (typeof grouped !== 'string' || !SESSION_TARGET.test(grouped) || !liveGrouped.has(grouped)) {
        return sendError(res, 400, '无效的派生会话');
      }
      if (!Number.isInteger(windowIndex) || windowIndex < 0 || windowIndex > 999) {
        return sendError(res, 400, '无效的窗口序号');
      }
      await service.run(['select-window', '-t', `${grouped}:${windowIndex}`]);
      return sendJson(res, 200, { ok: true });
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
      if (!tokenMatches(url.searchParams.get('token'))) {
        return sendError(res, 401, '缺少或错误的访问令牌');
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return serveStatic(res, path.join(STATIC_ROOT, 'index.html'), false);
      }
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      return sendError(res, 404, '未找到资源');
    } catch (error) {
      return sendError(res, error && error.name === 'TmuxError' ? 500 : 400, error?.message || '请求失败');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://internal');
    if (url.pathname !== '/ws' || !tokenMatches(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function wsSend(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://internal');
    const sourceId = url.searchParams.get('session');
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    if (typeof sourceId !== 'string' || !SESSION_TARGET.test(sourceId)) {
      wsSend(ws, { type: 'error', message: '无效的会话目标' });
      ws.close();
      return;
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
    for (const groupedId of [...liveGrouped]) await destroyGroupedSession(groupedId);
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

// Probe whether some other process (e.g. the CLI daemon) already serves on the
// port with our token, so the app can show its URLs instead of failing to bind.
async function probeExternalServer({ port = DEFAULT_PORT, token } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions?token=${token}`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_PORT,
  WEB_SESSION_PREFIX,
  loadToken,
  listAccessUrls,
  publicPreferences,
  startWebServer,
  probeExternalServer,
};

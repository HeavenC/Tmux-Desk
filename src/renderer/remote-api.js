// RemoteApi speaks the exact REST + WebSocket protocol that src/server/web-server.js
// already exposes for phone clients, but presents the same method shape the desktop
// TerminalView + app.js expect from window.tmuxDesk. Swapping this in for the local
// IPC bridge lets the desktop "take over" another machine's tmux sessions — the same
// way Termius runs a local shell or an SSH target through one UI.
//
// Scope (minimal takeover): list + attach + input/resize + view detail + window
// switch. Session create/kill/rename/split and pane ops stay local-only; the app
// guards them when a remote source is active.

// A remote host that is simply gone (stale IP after the machine moved networks,
// laptop asleep, firewall dropping SYNs) never answers and never refuses — the
// fetch would hang for the OS TCP timeout (~75s on macOS). Everything here is
// therefore bounded by an explicit AbortController deadline, the same way the
// web-server's own upstream relay already is.
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
const ATTACH_TIMEOUT_MS = 8000;
// An upload is bytes on the wire, not a status call — the short request deadline
// would abort a few-MB file on any non-LAN link.
const UPLOAD_TIMEOUT_MS = 60000;

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function toWsBase(base) {
  if (/^https:/i.test(base)) return `wss${base.slice('https'.length)}`;
  if (/^http:/i.test(base)) return `ws${base.slice('http'.length)}`;
  return base;
}

class RemoteApi {
  constructor({ base, token } = {}) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.token = String(token || '');
    this.wsBase = toWsBase(this.base);
    this.dataListeners = new Set();
    this.exitListeners = new Set();
    this.ws = null;
    this.terminalId = null;
    this.grouped = null;
    this.sessionId = null;
    this.lastDetail = { windows: [], panes: [] };
    this.intentionalClose = false;
  }

  onTerminalData(listener) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onTerminalExit(listener) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitData(payload) {
    for (const listener of this.dataListeners) listener(payload);
  }

  emitExit(payload) {
    for (const listener of this.exitListeners) listener(payload);
  }

  restUrl(pathname, params = {}) {
    const url = new URL(`${this.base}${pathname}`);
    url.searchParams.set('token', this.token);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async request(pathname, { method = 'GET', params, body, timeout = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const options = { method, headers: {}, signal: controller.signal };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response;
      try {
        response = await fetch(this.restUrl(pathname, params), options);
      } catch {
        // AbortError and a real connection failure both land here; only the
        // signal tells them apart, and the wording matters for the user (a
        // timeout means "host unreachable", not "wrong URL").
        throw new Error(controller.signal.aborted ? '远程主机无响应（超时）' : '无法连接远程主机');
      }
      let payload = null;
      try { payload = await response.json(); } catch { /* non-JSON error body */ }
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.error) || `远程请求失败（${response.status}）`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // Cheap reachability check used to light up the source popover before the user
  // commits to a switch. Short deadline on purpose: this runs for every saved
  // host in parallel while a menu is open, so a dead one must not hold the row
  // in "checking" for seconds.
  async probe({ timeout = PROBE_TIMEOUT_MS } = {}) {
    const started = nowMs();
    try {
      const payload = await this.request('/api/sessions', { timeout });
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      return { ok: true, ms: Math.round(nowMs() - started), sessions: sessions.length };
    } catch (error) {
      return { ok: false, ms: Math.round(nowMs() - started), error: error?.message || '无法连接远程主机' };
    }
  }

  async getSystemStatus() {
    // Reachability probe: if /api/sessions answers, the remote tmux is usable.
    await this.request('/api/sessions');
    return { installed: true, remote: true, path: this.base, version: null };
  }

  async listSessions() {
    const payload = await this.request('/api/sessions');
    return Array.isArray(payload.sessions) ? payload.sessions : [];
  }

  async getSessionDetail(target) {
    const payload = await this.request('/api/session-detail', { params: { session: target } });
    this.lastDetail = {
      windows: Array.isArray(payload.windows) ? payload.windows : [],
      panes: Array.isArray(payload.panes) ? payload.panes : [],
    };
    return this.lastDetail;
  }

  attachTerminal({ sessionId, cols, rows } = {}) {
    this.closeSocket(true);
    // Remembered for uploads: a dropped file has to be staged on the machine
    // that RUNS this session, addressed by the id this host knows it under
    // (which may itself be a relayed `r:<conn>:$n`).
    this.sessionId = sessionId || null;
    return new Promise((resolve, reject) => {
      let settled = false;
      // restUrl builds a fully-formed http(s) URL with token + query; only the
      // scheme needs to become ws(s) for the WebSocket handshake.
      const wsUrl = new URL(this.restUrl('/ws', { session: sessionId, cols, rows }));
      wsUrl.protocol = /^wss/i.test(this.wsBase) ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(wsUrl.toString());
      } catch (error) {
        reject(new Error(error?.message || '无法建立远程连接'));
        return;
      }
      this.ws = ws;
      this.intentionalClose = false;
      // Same reasoning as request(): a black-holed host leaves the handshake
      // pending indefinitely, which would freeze the attach with no feedback.
      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closeSocket(true);
        reject(new Error('远程会话连接超时'));
      }, ATTACH_TIMEOUT_MS);
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        fn(value);
      };

      ws.addEventListener('message', (event) => {
        let message = null;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'ready') {
          this.terminalId = message.terminalId;
          this.grouped = message.grouped || null;
          settle(resolve, { terminalId: message.terminalId });
          return;
        }
        if (message.type === 'data') {
          this.emitData({ terminalId: this.terminalId, data: message.data });
          return;
        }
        if (message.type === 'exit') {
          this.emitExit({ terminalId: this.terminalId, exitCode: null, signal: null });
          return;
        }
        if (message.type === 'error') {
          settle(reject, new Error(message.message || '远程连接失败'));
        }
      });

      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!settled) { settle(reject, new Error('远程连接已关闭')); return; }
        clearTimeout(handshakeTimer);
        // An unexpected drop (not our own detach) surfaces as an exit so the UI
        // shows the reconnect affordance instead of a silently frozen terminal.
        if (!this.intentionalClose) this.emitExit({ terminalId: this.terminalId, exitCode: null, signal: null });
      });

      ws.addEventListener('error', () => {
        settle(reject, new Error('远程连接错误'));
      });
    });
  }

  wsReady() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // These mirror the local IPC bridge (window.tmuxDesk), whose methods all return
  // a Promise from ipcRenderer.invoke — terminal-view chains `.catch()` on the
  // result (write/resize responses to xterm's device-attribute, color and focus
  // queries). Returning a bare boolean here throws "….catch is not a function"
  // inside xterm's parser on every such reply, corrupting the remote data/redraw
  // stream. Keep them `async` so a boolean is wrapped in a resolved Promise.
  async writeTerminal({ terminalId, data } = {}) {
    if (terminalId !== this.terminalId || !this.wsReady()) return false;
    this.ws.send(JSON.stringify({ type: 'input', data }));
    return true;
  }

  async resizeTerminal({ terminalId, cols, rows } = {}) {
    if (terminalId !== this.terminalId || !this.wsReady()) return false;
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    return true;
  }

  // Wheel scroll over the takeover WS. terminal-view drives this with the source
  // session id, but the WS is already bound to one attached (grouped) session on
  // the remote host, so only the line delta matters — the remote's own scroll
  // handler runs tmux copy-mode against the session this socket views. Relayed
  // (reshared) hosts forward this frame upstream verbatim, so it works B→C too.
  async scrollTerminal({ lines } = {}) {
    if (!this.wsReady() || !Number.isInteger(lines) || lines === 0) return false;
    this.ws.send(JSON.stringify({ type: 'scroll', lines }));
    return true;
  }

  async detachTerminal() {
    this.closeSocket(true);
    this.terminalId = null;
    this.grouped = null;
    this.sessionId = null;
    return true;
  }

  // Drag & drop of a local file onto a REMOTE session: the file exists on this
  // machine, the agent runs on the other one, so the bytes have to travel and
  // the path that gets typed is the remote host's.
  async uploadFile({ name, data } = {}) {
    if (!this.sessionId) throw new Error('远程会话尚未连接');
    const payload = await this.request('/api/upload-file', {
      method: 'POST',
      body: { session: this.sessionId, name, data },
      timeout: UPLOAD_TIMEOUT_MS,
    });
    if (!payload.path) throw new Error('远程主机未返回文件路径');
    return { path: payload.path, name: payload.name };
  }

  closeSocket(intentional) {
    if (!this.ws) return;
    this.intentionalClose = Boolean(intentional);
    try { this.ws.close(); } catch { /* already closing */ }
    this.ws = null;
  }

  // ⌘1-9 window switch. The server's /api/select-window works on the derived
  // grouped session by window INDEX (grouped is `-t`-linked to the source, so
  // indexes match); translate the desktop's window id via the cached detail.
  async selectWindow(windowId) {
    if (!this.grouped) throw new Error('远程会话尚未连接');
    const target = this.lastDetail.windows.find((window) => window.id === windowId);
    if (!target) throw new Error('窗口不存在');
    await this.request('/api/select-window', {
      method: 'POST',
      body: { grouped: this.grouped, windowIndex: target.index },
    });
    return true;
  }

  dispose() {
    this.closeSocket(true);
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

module.exports = { RemoteApi, toWsBase };

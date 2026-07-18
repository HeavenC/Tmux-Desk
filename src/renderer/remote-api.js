// RemoteApi speaks the exact REST + WebSocket protocol that src/server/web-server.js
// already exposes for phone clients, but presents the same method shape the desktop
// TerminalView + app.js expect from window.tmuxDesk. Swapping this in for the local
// IPC bridge lets the desktop "take over" another machine's tmux sessions — the same
// way Termius runs a local shell or an SSH target through one UI.
//
// Scope (minimal takeover): list + attach + input/resize + view detail + window
// switch. Session create/kill/rename/split and pane ops stay local-only; the app
// guards them when a remote source is active.

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

  async request(pathname, { method = 'GET', params, body } = {}) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(this.restUrl(pathname, params), options);
    } catch {
      throw new Error('无法连接远程主机');
    }
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON error body */ }
    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `远程请求失败（${response.status}）`);
    }
    return payload;
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

      ws.addEventListener('message', (event) => {
        let message = null;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'ready') {
          this.terminalId = message.terminalId;
          this.grouped = message.grouped || null;
          if (!settled) { settled = true; resolve({ terminalId: message.terminalId }); }
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
          if (!settled) { settled = true; reject(new Error(message.message || '远程连接失败')); }
        }
      });

      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!settled) { settled = true; reject(new Error('远程连接已关闭')); return; }
        // An unexpected drop (not our own detach) surfaces as an exit so the UI
        // shows the reconnect affordance instead of a silently frozen terminal.
        if (!this.intentionalClose) this.emitExit({ terminalId: this.terminalId, exitCode: null, signal: null });
      });

      ws.addEventListener('error', () => {
        if (!settled) { settled = true; reject(new Error('远程连接错误')); }
      });
    });
  }

  wsReady() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  writeTerminal({ terminalId, data } = {}) {
    if (terminalId !== this.terminalId || !this.wsReady()) return false;
    this.ws.send(JSON.stringify({ type: 'input', data }));
    return true;
  }

  resizeTerminal({ terminalId, cols, rows } = {}) {
    if (terminalId !== this.terminalId || !this.wsReady()) return false;
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    return true;
  }

  detachTerminal() {
    this.closeSocket(true);
    this.terminalId = null;
    this.grouped = null;
    return true;
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

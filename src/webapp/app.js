const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const LIST_REFRESH_MS = 15000;
const PING_INTERVAL_MS = 25000;
const TERMINAL_THEME = {
  background: '#111417',
  foreground: '#d8dde7',
  cursor: '#8bb8ff',
  cursorAccent: '#111417',
  selectionBackground: '#31588a99',
};

const state = {
  token: '',
  currentView: 'list',
  currentSession: null,
  grouped: null,
  windows: [],
  ws: null,
  wsSessionId: null,
  pingTimer: null,
  listRefreshTimer: null,
  ctrlActive: false,
  manualClose: false,
  term: null,
  fitAddon: null,
};

const el = (id) => document.getElementById(id);

function getToken() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('token', state.token);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('服务器响应格式错误');
  }
  if (!response.ok || !body.ok) throw new Error(body.error || '请求失败');
  return body;
}

function showToast(message) {
  const toast = el('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2500);
}

function showView(name) {
  state.currentView = name;
  el('view-list').hidden = name !== 'list';
  el('view-terminal').hidden = name !== 'terminal';
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatRelativeTime(epochSeconds) {
  if (!epochSeconds) return '';
  const now = new Date();
  const then = new Date(epochSeconds * 1000);
  const diffSec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
  if (dayDiff <= 1) return '昨天';
  if (dayDiff < 7) return `${dayDiff} 天前`;
  const mm = String(then.getMonth() + 1).padStart(2, '0');
  const dd = String(then.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

function setListState({ loading = false, error = null, sessions = null }) {
  el('list-loading').hidden = !loading;
  el('list-error').hidden = error === null;
  if (error !== null) el('list-error-text').textContent = error;
  el('list-empty').hidden = sessions === null || sessions.length > 0;
  if (sessions !== null) renderSessionList(sessions);
}

function renderSessionList(sessions) {
  const list = el('session-list');
  list.innerHTML = '';
  for (const session of sessions) {
    const li = document.createElement('li');
    li.className = 'session-card';

    const head = document.createElement('div');
    head.className = 'session-card-head';
    const dot = document.createElement('span');
    dot.className = `status-dot${session.attached ? ' attached' : ''}`;
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name || session.id;
    head.append(name, dot);

    const sub = document.createElement('div');
    sub.className = 'session-sub';
    sub.textContent = `${session.windows ?? 0} 窗口 · ${session.paneCount ?? 0} 面板 · ${session.activeCommand || '-'}`;

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = `${session.path || ''} · ${formatRelativeTime(session.activity)}`;

    li.append(head, sub, meta);
    li.addEventListener('click', () => openSession(session));
    list.appendChild(li);
  }
}

async function loadSessions() {
  setListState({ loading: true, error: null });
  try {
    const body = await fetchJson(apiUrl('/api/sessions'));
    setListState({ loading: false, error: null, sessions: body.sessions || [] });
  } catch (err) {
    setListState({ loading: false, error: err.message || '加载失败' });
  }
}

function startListAutoRefresh() {
  clearInterval(state.listRefreshTimer);
  state.listRefreshTimer = setInterval(() => {
    if (state.currentView === 'list' && document.visibilityState === 'visible') loadSessions();
  }, LIST_REFRESH_MS);
}

function ensureTerminalCreated() {
  if (state.term) return;
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, monospace',
    cursorBlink: true,
    scrollback: 3000,
    theme: TERMINAL_THEME,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(el('terminal-container'));
  term.onData((data) => handleTerminalInput(data));
  state.term = term;
  state.fitAddon = fitAddon;
}

function handleTerminalInput(data) {
  if (state.ctrlActive && data.length === 1 && /[a-zA-Z]/.test(data)) {
    const code = data.toUpperCase().charCodeAt(0) & 31;
    sendWsInput(String.fromCharCode(code));
    setCtrlActive(false);
    return;
  }
  sendWsInput(data);
}

function setCtrlActive(active) {
  state.ctrlActive = active;
  el('ctrl-btn').classList.toggle('active', active);
}

function sendWsJson(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function sendWsInput(data) {
  sendWsJson({ type: 'input', data });
}

function fitAndNotify() {
  if (state.currentView !== 'terminal' || !state.term) return;
  try {
    state.fitAddon.fit();
    sendWsJson({ type: 'resize', cols: state.term.cols, rows: state.term.rows });
  } catch {}
}

function wsUrlFor(sessionId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cols = state.term ? state.term.cols : 80;
  const rows = state.term ? state.term.rows : 24;
  const params = new URLSearchParams({
    token: state.token,
    session: sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  return `${protocol}//${window.location.host}/ws?${params.toString()}`;
}

function connectWebSocket(sessionId) {
  clearInterval(state.pingTimer);
  if (state.ws) {
    state.manualClose = true;
    state.ws.close();
  }
  state.manualClose = false;
  state.wsSessionId = sessionId;
  hideDisconnectBanner();
  const ws = new WebSocket(wsUrlFor(sessionId));
  state.ws = ws;

  ws.onopen = () => {
    hideDisconnectBanner();
    state.pingTimer = setInterval(() => sendWsJson({ type: 'ping' }), PING_INTERVAL_MS);
  };
  ws.onmessage = (event) => handleWsMessage(event);
  ws.onclose = () => {
    clearInterval(state.pingTimer);
    if (!state.manualClose && state.currentView === 'terminal' && state.wsSessionId === sessionId) {
      showDisconnectBanner();
    }
  };
  ws.onerror = () => {};
}

function handleWsMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'ready':
      state.grouped = msg.grouped;
      state.term.focus();
      loadWindows(msg.grouped);
      break;
    case 'data':
      state.term.write(msg.data);
      break;
    case 'exit':
      showToast('会话已结束');
      backToList();
      break;
    case 'error':
      showToast(msg.message || '发生错误');
      break;
    default:
      break;
  }
}

function showDisconnectBanner() {
  el('disconnect-banner').hidden = false;
}

function hideDisconnectBanner() {
  el('disconnect-banner').hidden = true;
}

async function loadWindows(sessionId) {
  try {
    const body = await fetchJson(apiUrl('/api/session-detail', { session: sessionId }));
    state.windows = (body.windows || []).slice().sort((a, b) => a.index - b.index);
    renderWindowChips();
  } catch (err) {
    showToast(err.message || '获取窗口失败');
  }
}

function renderWindowChips() {
  const container = el('window-chips');
  container.innerHTML = '';
  for (const win of state.windows) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `window-chip${win.active ? ' active' : ''}`;
    chip.textContent = `${win.index}:${win.name}`;
    chip.addEventListener('click', () => selectWindow(win.index));
    container.appendChild(chip);
  }
}

async function selectWindow(windowIndex) {
  if (!state.grouped) return;
  state.windows = state.windows.map((w) => ({ ...w, active: w.index === windowIndex }));
  renderWindowChips();
  try {
    await fetchJson(apiUrl('/api/select-window'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grouped: state.grouped, windowIndex }),
    });
    await loadWindows(state.grouped);
  } catch (err) {
    showToast(err.message || '切换窗口失败');
  }
  state.term.focus();
}

function openSession(session) {
  state.currentSession = session;
  state.grouped = null;
  state.windows = [];
  el('term-title').textContent = session.name || session.id;
  el('window-chips').innerHTML = '';
  showView('terminal');
  ensureTerminalCreated();
  state.term.reset();
  requestAnimationFrame(() => {
    state.fitAddon.fit();
    connectWebSocket(session.id);
  });
}

function backToList() {
  state.manualClose = true;
  clearInterval(state.pingTimer);
  if (state.ws) state.ws.close();
  state.ws = null;
  hideDisconnectBanner();
  setCtrlActive(false);
  showView('list');
  loadSessions();
}

const TOOLBAR_SEQUENCES = {
  esc: '\x1b',
  tab: '\t',
  prefix: '\x02',
  left: '\x1b[D',
  down: '\x1b[B',
  up: '\x1b[A',
  right: '\x1b[C',
};

function setupToolbar() {
  const buttons = document.querySelectorAll('.key-btn');
  buttons.forEach((button) => {
    const key = button.dataset.key;
    const preventFocusLoss = (event) => event.preventDefault();
    button.addEventListener('mousedown', preventFocusLoss);
    button.addEventListener('touchstart', preventFocusLoss, { passive: false });
    button.addEventListener('click', () => {
      if (key === 'ctrl') {
        setCtrlActive(!state.ctrlActive);
      } else {
        sendWsInput(TOOLBAR_SEQUENCES[key]);
      }
      state.term.focus();
    });
  });
}

function setupViewportHandling() {
  const applyHeight = (height) => {
    el('app').style.height = `${height}px`;
  };
  if (window.visualViewport) {
    const onViewportChange = () => {
      applyHeight(window.visualViewport.height);
      fitAndNotify();
    };
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
  }
  window.addEventListener('resize', fitAndNotify);
  window.addEventListener('orientationchange', () => setTimeout(fitAndNotify, 300));
}

function setupStaticHandlers() {
  el('refresh-btn').addEventListener('click', loadSessions);
  el('list-retry-btn').addEventListener('click', loadSessions);
  el('back-btn').addEventListener('click', backToList);
  el('reconnect-btn').addEventListener('click', () => {
    if (state.currentSession) connectWebSocket(state.currentSession.id);
  });
}

function bootstrap() {
  state.token = getToken();
  setupStaticHandlers();
  setupToolbar();
  setupViewportHandling();
  if (!state.token) {
    setListState({ loading: false, error: '缺少 token 参数，请通过正确链接访问' });
    return;
  }
  loadSessions();
  startListAutoRefresh();
}

document.addEventListener('DOMContentLoaded', bootstrap);

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { ClipboardAddon } = require('@xterm/addon-clipboard');
const { liveCountForView, mobileSessionsForView } = require('./mobile-session-model');

const LIST_REFRESH_MS = 15000;
const PING_INTERVAL_MS = 25000;
const THEME_KEY = 'tmux-desk-web-theme';
const CUSTOM_KEYS_KEY = 'tmux-desk-web-custom-keys';
const THEME_META_COLORS = { light: '#f2f4f7', dark: '#15191d' };
const TOUCH_SCROLL_SLOP = 8;
const TERMINAL_THEMES = {
  light: {
    background: '#fbfbfc', foreground: '#20242c', cursor: '#1769e0', cursorAccent: '#ffffff',
    selectionBackground: '#b9d4ff99', black: '#20242c', red: '#c9343f', green: '#177245',
    yellow: '#8a6200', blue: '#1769e0', magenta: '#8750ad', cyan: '#087f8c', white: '#e8ebef',
    brightBlack: '#6f7785', brightRed: '#d84b56', brightGreen: '#268657', brightYellow: '#a77700',
    brightBlue: '#3281ee', brightMagenta: '#9b67be', brightCyan: '#1594a1', brightWhite: '#ffffff',
  },
  dark: {
    background: '#111318', foreground: '#d8dde7', cursor: '#8bb8ff', cursorAccent: '#111318',
    selectionBackground: '#31588a99', black: '#20242d', red: '#f06a74', green: '#68d391',
    yellow: '#e7b75d', blue: '#74a9f5', magenta: '#c495e8', cyan: '#67c6d2', white: '#d8dde7',
    brightBlack: '#727b8c', brightRed: '#ff7c86', brightGreen: '#7ae3a3', brightYellow: '#f4c76f',
    brightBlue: '#8bb8ff', brightMagenta: '#d5a8f3', brightCyan: '#7dd8e3', brightWhite: '#ffffff',
  },
};

const state = {
  token: '',
  currentView: 'list',
  sessions: [],
  preferences: { tags: [], favorites: [], sessionTags: {}, tabOrders: {} },
  listView: { kind: 'all' },
  currentSession: null,
  grouped: null,
  windows: [],
  ws: null,
  wsSessionId: null,
  pingTimer: null,
  listRefreshTimer: null,
  ctrlActive: false,
  manualClose: false,
  theme: 'light',
  term: null,
  fitAddon: null,
  termTextarea: null,
  keyboardActive: false,
  customKeys: [],
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

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'dark' || value === 'light' ? value : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_META_COLORS[state.theme]);
  const icon = state.theme === 'dark' ? '☀︎' : '☾';
  document.querySelectorAll('.theme-btn').forEach((button) => { button.textContent = icon; });
  if (state.term) state.term.options.theme = TERMINAL_THEMES[state.theme];
  try { localStorage.setItem(THEME_KEY, state.theme); } catch {}
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function normalizePreferenceProjection(value) {
  const preferences = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    tags: Array.isArray(preferences.tags) ? preferences.tags.filter((tag) => (
      tag && typeof tag.id === 'string' && typeof tag.name === 'string' && typeof tag.color === 'string'
    )) : [],
    favorites: Array.isArray(preferences.favorites)
      ? preferences.favorites.filter((name) => typeof name === 'string')
      : [],
    sessionTags: preferences.sessionTags
      && typeof preferences.sessionTags === 'object'
      && !Array.isArray(preferences.sessionTags)
      ? preferences.sessionTags
      : {},
    tabOrders: preferences.tabOrders
      && typeof preferences.tabOrders === 'object'
      && !Array.isArray(preferences.tabOrders)
      ? preferences.tabOrders
      : {},
  };
}

function sameListView(left, right) {
  return left?.kind === right?.kind && left?.tagId === right?.tagId;
}

function ensureListView() {
  if (state.listView.kind !== 'tag') return;
  if (!state.preferences.tags.some((tag) => tag.id === state.listView.tagId)) {
    state.listView = { kind: 'all' };
  }
}

function currentListSessions() {
  return mobileSessionsForView(state.sessions, state.preferences, state.listView);
}

function currentListLabel() {
  if (state.listView.kind === 'favorites') return '收藏';
  if (state.listView.kind === 'tag') {
    return state.preferences.tags.find((tag) => tag.id === state.listView.tagId)?.name || 'Tag';
  }
  return '全部';
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
  if (sessions !== null) {
    const emptyText = el('list-empty').querySelector('p');
    emptyText.textContent = state.listView.kind === 'all'
      ? '暂无 tmux 会话'
      : `${currentListLabel()}中暂无会话`;
    renderSessionList(sessions);
  }
}

function createWorkspaceFilter(view, label, count, tag = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `workspace-filter${sameListView(view, state.listView) ? ' active' : ''}`;
  button.setAttribute('aria-pressed', String(sameListView(view, state.listView)));
  button.title = `${label}（${count}）`;
  if (tag) {
    button.dataset.tagColor = tag.color;
    const dot = document.createElement('span');
    dot.className = 'tag-color-dot';
    dot.setAttribute('aria-hidden', 'true');
    button.appendChild(dot);
  }
  const text = document.createElement('span');
  text.className = 'workspace-filter-label';
  text.textContent = label;
  const badge = document.createElement('span');
  badge.className = 'workspace-filter-count';
  badge.textContent = String(count);
  button.append(text, badge);
  button.addEventListener('click', () => {
    state.listView = view;
    renderWorkspaceFilters();
    setListState({ loading: false, error: null, sessions: currentListSessions() });
  });
  return button;
}

function renderWorkspaceFilters() {
  ensureListView();
  const filters = el('workspace-filters');
  const views = [
    { view: { kind: 'all' }, label: '全部' },
    { view: { kind: 'favorites' }, label: '收藏' },
    ...state.preferences.tags.map((tag) => ({
      view: { kind: 'tag', tagId: tag.id },
      label: tag.name,
      tag,
    })),
  ];
  filters.replaceChildren(...views.map(({ view, label, tag }) => createWorkspaceFilter(
    view,
    label,
    liveCountForView(state.sessions, state.preferences, view),
    tag,
  )));
  filters.querySelector('.workspace-filter.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function tagsForSession(sessionName) {
  const ids = Array.isArray(state.preferences.sessionTags[sessionName])
    ? state.preferences.sessionTags[sessionName]
    : [];
  const selected = new Set(ids);
  return state.preferences.tags.filter((tag) => selected.has(tag.id));
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
    meta.textContent = [session.path || '', formatRelativeTime(session.activity)].filter(Boolean).join(' · ');

    const footer = document.createElement('div');
    footer.className = 'session-card-footer';
    const tagList = document.createElement('div');
    tagList.className = 'session-tags';
    tagList.setAttribute('aria-label', '已关联 Tag');
    for (const tag of tagsForSession(session.name)) {
      const pill = document.createElement('span');
      pill.className = 'session-tag-pill';
      pill.dataset.tagColor = tag.color;
      pill.textContent = tag.name;
      pill.title = tag.name;
      tagList.appendChild(pill);
    }
    const manageTags = document.createElement('button');
    manageTags.type = 'button';
    manageTags.className = 'session-tag-button';
    manageTags.textContent = 'Tag';
    manageTags.setAttribute('aria-label', `管理 ${session.name} 的 Tag`);
    manageTags.addEventListener('click', (event) => {
      event.stopPropagation();
      openSessionTagsModal(session);
    });
    footer.append(tagList, manageTags);

    li.append(head, sub, meta, footer);
    li.addEventListener('click', () => openSession(session));
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.addEventListener('keydown', (event) => {
      if (event.target !== li) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSession(session);
      }
    });
    list.appendChild(li);
  }
}

async function loadSessions() {
  setListState({ loading: true, error: null });
  try {
    const body = await fetchJson(apiUrl('/api/sessions'));
    state.sessions = Array.isArray(body.sessions) ? body.sessions : [];
    state.preferences = normalizePreferenceProjection(body.preferences);
    ensureListView();
    renderWorkspaceFilters();
    setListState({ loading: false, error: null, sessions: currentListSessions() });
  } catch (err) {
    setListState({ loading: false, error: err.message || '加载失败' });
  }
}

function closeSessionTagsModal() {
  const modal = el('session-tags-modal');
  modal.hidden = true;
  el('session-tags-form').removeAttribute('data-session-name');
}

function openSessionTagsModal(session) {
  const form = el('session-tags-form');
  const list = el('session-tags-list');
  const selectedIds = new Set(Array.isArray(state.preferences.sessionTags[session.name])
    ? state.preferences.sessionTags[session.name]
    : []);
  form.dataset.sessionName = session.name;
  el('session-tags-message').textContent = session.name;
  list.replaceChildren();
  for (const tag of state.preferences.tags) {
    const row = document.createElement('label');
    row.className = 'tag-check-row';
    row.dataset.tagColor = tag.color;
    const dot = document.createElement('span');
    dot.className = 'tag-color-dot';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = tag.name;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'tagId';
    checkbox.value = tag.id;
    checkbox.checked = selectedIds.has(tag.id);
    row.append(dot, name, checkbox);
    list.appendChild(row);
  }
  if (!state.preferences.tags.length) {
    const empty = document.createElement('p');
    empty.className = 'tag-check-empty';
    empty.textContent = '还没有 Tag，请先在 Mac 桌面端创建。';
    list.appendChild(empty);
  }
  el('session-tags-save').disabled = !state.preferences.tags.length;
  el('session-tags-modal').hidden = false;
  requestAnimationFrame(() => list.querySelector('input')?.focus());
}

async function saveSessionTags(event) {
  event.preventDefault();
  const form = el('session-tags-form');
  const sessionName = form.dataset.sessionName;
  if (!sessionName) return;
  const saveButton = el('session-tags-save');
  const checkedTagIds = [...form.querySelectorAll('input[name="tagId"]:checked')]
    .map((input) => input.value);
  saveButton.disabled = true;
  saveButton.textContent = '保存中…';
  try {
    const body = await fetchJson(apiUrl('/api/session-tags'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName, tagIds: checkedTagIds }),
    });
    state.preferences = normalizePreferenceProjection(body.preferences);
    ensureListView();
    renderWorkspaceFilters();
    setListState({ loading: false, error: null, sessions: currentListSessions() });
    closeSessionTagsModal();
    showToast('Tag 已保存');
  } catch (error) {
    showToast(error.message || 'Tag 保存失败');
  } finally {
    saveButton.textContent = '保存';
    saveButton.disabled = !state.preferences.tags.length;
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
    fontFamily: '"Tmux Desk Mono", Menlo, Monaco, monospace',
    cursorBlink: true,
    scrollback: 3000,
    theme: TERMINAL_THEMES[state.theme],
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // Lets tmux's OSC52 (set-clipboard external + the "clipboard" terminal
  // feature TerminalManager.attach() now requests) reach the phone's system
  // clipboard — xterm.js otherwise ignores OSC52 entirely. tmux sends the
  // OSC52 selection parameter as an EMPTY string, which the addon's default
  // provider drops (it only acts on "c"), so accept both here.
  term.loadAddon(new ClipboardAddon(undefined, {
    async readText(selection) {
      if (selection !== 'c' && selection !== '') return '';
      return navigator.clipboard.readText();
    },
    async writeText(selection, text) {
      if (selection !== 'c' && selection !== '' && selection !== 'p' && selection !== 's') return;
      return navigator.clipboard.writeText(text);
    },
  }));
  term.open(el('terminal-container'));
  term.onData((data) => handleTerminalInput(data));
  state.term = term;
  state.fitAddon = fitAddon;
  setupKeyboardGate();
}

// iOS only shows the on-screen keyboard for a focus() call when the focused
// field is actually editable at that moment — readonly + inputmode="none"
// together suppress it (inputmode alone isn't reliably honored on older
// Safari) while still letting a physical/Bluetooth keyboard reach xterm via
// keydown, and without touching the input path used by the toolbar keys
// (those call sendWsInput() directly over the websocket, never through this
// textarea). Toggled explicitly via the keyboard-btn toolbar button.
function setupKeyboardGate() {
  const textarea = state.term?.element?.querySelector('.xterm-helper-textarea');
  if (!textarea) return;
  state.termTextarea = textarea;
  lockKeyboard();
  textarea.addEventListener('blur', lockKeyboard);
}

function lockKeyboard() {
  const textarea = state.termTextarea;
  if (!textarea) return;
  textarea.setAttribute('readonly', 'readonly');
  textarea.setAttribute('inputmode', 'none');
  state.keyboardActive = false;
  el('keyboard-btn')?.classList.remove('active');
}

function unlockKeyboard() {
  const textarea = state.termTextarea;
  if (!textarea) return;
  textarea.removeAttribute('readonly');
  textarea.removeAttribute('inputmode');
  state.keyboardActive = true;
  el('keyboard-btn')?.classList.add('active');
}

function toggleKeyboard() {
  if (!state.term) return;
  if (state.keyboardActive) {
    state.term.blur();
  } else {
    unlockKeyboard();
    state.term.focus();
  }
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

// xterm.js has no native long-press text selection on touch, and tmux runs
// with mouse mode on globally so touches drive tmux's own mouse tracking
// instead of producing a local xterm selection. This dumps the visible
// scrollback into a plain <pre> the OS can natively select/copy from.
const COPY_OVERLAY_MAX_LINES = 2000;

function getTerminalBufferText(term, maxLines = COPY_OVERLAY_MAX_LINES) {
  const buffer = term?.buffer?.active;
  if (!buffer) return '';
  const total = buffer.length;
  const start = Math.max(0, total - maxLines);
  const lines = [];
  for (let y = start; y < total; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    lines.push(line.translateToString(true));
  }
  return lines.join('\n').replace(/\s+$/, '');
}

function openCopyOverlay() {
  if (!state.term) return;
  el('copy-modal-text').textContent = getTerminalBufferText(state.term);
  el('copy-modal').hidden = false;
}

function closeCopyOverlay() {
  el('copy-modal').hidden = true;
}

async function copyOverlayText() {
  const pre = el('copy-modal-text');
  const text = pre.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch {
    // Clipboard API unavailable/denied: select the text so the user can
    // still copy it manually (long-press → 拷贝 on iOS/Android).
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pre);
    selection.removeAllRanges();
    selection.addRange(range);
    showToast('无法自动复制，已为你选中内容，请手动复制');
  }
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
    renderWindowPicker();
  } catch (err) {
    showToast(err.message || '获取窗口失败');
  }
}

function renderWindowPicker() {
  const picker = el('window-picker');
  picker.replaceChildren();
  for (const win of state.windows) {
    const option = document.createElement('option');
    option.value = String(win.index);
    option.textContent = `${win.index}: ${win.name}`;
    option.selected = Boolean(win.active);
    picker.appendChild(option);
  }
  picker.hidden = state.windows.length <= 1;
}

async function selectWindow(windowIndex) {
  if (!state.grouped) return;
  state.windows = state.windows.map((w) => ({ ...w, active: w.index === windowIndex }));
  renderWindowPicker();
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
  renderWindowPicker();
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
  'ctrl-c': '\x03',
  left: '\x1b[D',
  down: '\x1b[B',
  up: '\x1b[A',
  right: '\x1b[C',
};

function runToolbarKey(key) {
  if (key === 'ctrl') {
    setCtrlActive(!state.ctrlActive);
  } else {
    sendWsInput(TOOLBAR_SEQUENCES[key]);
  }
  // Only refocus xterm when the user has explicitly summoned the keyboard.
  // Focusing the helper textarea during a tap re-raises the iOS/iPadOS soft
  // keyboard — the very thing these toolbar keys exist to avoid, since arrows
  // and Esc/Tab are sent over the websocket, not typed.
  if (state.keyboardActive) state.term?.focus();
}

// ---- User-defined toolbar keys (persisted per device) --------------------

function loadCustomKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_KEYS_KEY) || '[]');
    state.customKeys = Array.isArray(parsed)
      ? parsed
        .filter((item) => item && typeof item.label === 'string' && typeof item.text === 'string')
        .slice(0, 30)
        .map((item) => ({ label: item.label.slice(0, 16), text: item.text.slice(0, 200), enter: item.enter !== false }))
      : [];
  } catch {
    state.customKeys = [];
  }
}

function saveCustomKeys() {
  try { localStorage.setItem(CUSTOM_KEYS_KEY, JSON.stringify(state.customKeys)); } catch { /* private mode */ }
}

function renderCustomKeys() {
  const container = el('custom-keys');
  if (!container) return;
  container.replaceChildren(...state.customKeys.map((key, index) => {
    const button = document.createElement('button');
    button.className = 'key-btn custom';
    button.type = 'button';
    button.textContent = key.label;
    button.title = key.text + (key.enter ? ' ⏎' : '');
    bindTap(button, () => runCustomKey(index));
    return button;
  }));
}

function runCustomKey(index) {
  const key = state.customKeys[index];
  if (!key) return;
  sendWsInput(key.text);
  if (key.enter) sendWsInput('\r');
  if (state.keyboardActive) state.term?.focus();
}

function renderCustomKeysEditor() {
  const list = el('custom-keys-list');
  if (!list) return;
  if (!state.customKeys.length) {
    const empty = document.createElement('p');
    empty.className = 'custom-keys-empty';
    empty.textContent = '还没有自定义快捷键。';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...state.customKeys.map((key, index) => {
    const row = document.createElement('div');
    row.className = 'custom-keys-row';
    const info = document.createElement('div');
    info.className = 'custom-keys-info';
    const label = document.createElement('span');
    label.className = 'custom-keys-label';
    label.textContent = key.label;
    const text = document.createElement('span');
    text.className = 'custom-keys-text';
    text.textContent = key.text + (key.enter ? ' ⏎' : '');
    info.append(label, text);
    const remove = document.createElement('button');
    remove.className = 'btn secondary btn-sm';
    remove.type = 'button';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      state.customKeys.splice(index, 1);
      saveCustomKeys();
      renderCustomKeys();
      renderCustomKeysEditor();
    });
    row.append(info, remove);
    return row;
  }));
}

function openCustomKeysModal() {
  renderCustomKeysEditor();
  el('custom-keys-modal').hidden = false;
}

function closeCustomKeysModal() {
  el('custom-keys-modal').hidden = true;
}

function addCustomKeyFromForm(event) {
  event.preventDefault();
  const label = el('custom-key-label').value.trim().slice(0, 16);
  const text = el('custom-key-text').value.slice(0, 200);
  if (!label || !text) { showToast('请填写按钮名和发送内容'); return; }
  state.customKeys.push({ label, text, enter: el('custom-key-enter').checked });
  saveCustomKeys();
  renderCustomKeys();
  renderCustomKeysEditor();
  el('custom-key-label').value = '';
  el('custom-key-text').value = '';
  el('custom-key-enter').checked = true;
  el('custom-key-label').focus();
}

// ---- Fullscreen -----------------------------------------------------------

function isStandalone() {
  return window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function fullscreenSupported() {
  const root = document.documentElement;
  return typeof root.requestFullscreen === 'function' || typeof root.webkitRequestFullscreen === 'function';
}

function setupFullscreen() {
  const button = el('fullscreen-btn');
  if (!button) return;
  // Already launched from the home screen: the chrome is gone, nothing to do.
  if (isStandalone()) { button.hidden = true; return; }
  button.hidden = false;
  button.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', syncFullscreenButton);
}

function toggleFullscreen() {
  const root = document.documentElement;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (active) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    return;
  }
  if (fullscreenSupported()) {
    (root.requestFullscreen || root.webkitRequestFullscreen).call(root).catch(() => {
      showToast('全屏被浏览器拒绝');
    });
  } else {
    // iOS/iPadOS Safari won't fullscreen arbitrary elements — the home-screen
    // web app is the only way to drop the address bar there.
    showToast('在 Safari 中点击分享 → 添加到主屏幕，即可全屏使用');
  }
}

function syncFullscreenButton() {
  const button = el('fullscreen-btn');
  if (!button) return;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  button.classList.toggle('active', Boolean(active));
  button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
}

// Shared tap binding for toolbar-style buttons: avoids the ~300ms synthetic
// click delay and the double-fire some mobile browsers produce for
// touchend+click on the same tap.
function bindTap(button, handler) {
  if (!button) return;
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
  // iOS：touchstart 已 preventDefault，不会再合成 click，动作在 touchend 执行
  button.addEventListener('touchend', (event) => {
    event.preventDefault();
    handler();
  });
  button.addEventListener('click', () => handler());
}

function setupToolbar() {
  document.querySelectorAll('.key-btn[data-key]').forEach((button) => {
    bindTap(button, () => runToolbarKey(button.dataset.key));
  });
  bindTap(el('copy-btn'), openCopyOverlay);
  bindTap(el('keyboard-btn'), toggleKeyboard);
  bindTap(el('custom-keys-edit'), openCustomKeysModal);
  bindTap(el('quickbar-toggle'), toggleQuickbar);
  renderCustomKeys();
}

function toggleQuickbar() {
  const quickbar = el('quickbar');
  const collapsed = quickbar.classList.toggle('collapsed');
  const toggle = el('quickbar-toggle');
  toggle.innerHTML = collapsed ? '&#x2039;' : '&#x203A;';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? '展开快捷键' : '收起快捷键');
}

function sendScrollLine(up, clientX, clientY, rect) {
  const term = state.term;
  if (term.modes.mouseTrackingMode !== 'none') {
    const col = Math.min(term.cols, Math.max(1, Math.floor(((clientX - rect.left) / rect.width) * term.cols) + 1));
    const row = Math.min(term.rows, Math.max(1, Math.floor(((clientY - rect.top) / rect.height) * term.rows) + 1));
    sendWsInput(`\x1b[<${up ? 64 : 65};${col};${row}M`);
  } else {
    term.scrollLines(up ? -1 : 1);
  }
}

function setupTouchScroll() {
  const container = el('terminal-container');
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let scrolling = false;
  container.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    lastY = startY;
    scrolling = false;
  }, { passive: true });
  container.addEventListener('touchmove', (event) => {
    if (!state.term || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!scrolling) {
      if (Math.abs(touch.clientY - startY) < TOUCH_SCROLL_SLOP
        && Math.abs(touch.clientX - startX) < TOUCH_SCROLL_SLOP) return;
      scrolling = true;
      lastY = touch.clientY;
    }
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const rowHeight = rect.height / Math.max(1, state.term.rows);
    const lines = Math.trunc((touch.clientY - lastY) / rowHeight);
    if (!lines) return;
    lastY += lines * rowHeight;
    // 手指下拉（lines > 0）= 内容向上滚 = wheel up
    for (let i = 0; i < Math.abs(lines); i += 1) {
      sendScrollLine(lines > 0, touch.clientX, touch.clientY, rect);
    }
  }, { passive: false });
}

function setupViewportHandling() {
  let fitFrame = null;
  const onViewportChange = () => {
    const viewport = window.visualViewport;
    const height = Math.round(viewport?.height || window.innerHeight);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    el('app').style.height = `${height}px`;
    el('app').style.top = `${offsetTop}px`;
    if (fitFrame !== null) cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      fitAndNotify();
    });
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
  }
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 300));
  onViewportChange();
}

function setupStaticHandlers() {
  el('refresh-btn').addEventListener('click', loadSessions);
  document.querySelectorAll('.theme-btn').forEach((button) => button.addEventListener('click', toggleTheme));
  el('list-retry-btn').addEventListener('click', loadSessions);
  el('back-btn').addEventListener('click', backToList);
  el('reconnect-btn').addEventListener('click', () => {
    if (state.currentSession) connectWebSocket(state.currentSession.id);
  });
  el('window-picker').addEventListener('change', (event) => {
    const windowIndex = Number(event.target.value);
    if (Number.isInteger(windowIndex)) selectWindow(windowIndex);
  });
  el('session-tags-cancel').addEventListener('click', closeSessionTagsModal);
  el('session-tags-form').addEventListener('submit', saveSessionTags);
  el('session-tags-modal').addEventListener('click', (event) => {
    if (event.target === el('session-tags-modal')) closeSessionTagsModal();
  });
  bindTap(el('copy-modal-close'), closeCopyOverlay);
  bindTap(el('copy-modal-selectall'), copyOverlayText);
  el('copy-modal').addEventListener('click', (event) => {
    if (event.target === el('copy-modal')) closeCopyOverlay();
  });
  el('custom-keys-close').addEventListener('click', closeCustomKeysModal);
  el('custom-keys-add').addEventListener('submit', addCustomKeyFromForm);
  el('custom-keys-modal').addEventListener('click', (event) => {
    if (event.target === el('custom-keys-modal')) closeCustomKeysModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el('session-tags-modal').hidden) closeSessionTagsModal();
    if (!el('copy-modal').hidden) closeCopyOverlay();
    if (!el('custom-keys-modal').hidden) closeCustomKeysModal();
  });
}

function bootstrap() {
  state.token = getToken();
  applyTheme(storedTheme());
  loadCustomKeys();
  setupStaticHandlers();
  setupToolbar();
  setupTouchScroll();
  setupViewportHandling();
  setupFullscreen();
  renderWorkspaceFilters();
  // Warm the composite terminal font ahead of the first term.open() so the
  // very first paint doesn't fall back to the browser default monospace
  // font while "Tmux Desk Mono" is still resolving.
  document.fonts?.load?.('13px "Tmux Desk Mono"', 'Aa中。（）').catch(() => {});
  if (!state.token) {
    setListState({ loading: false, error: '缺少 token 参数，请通过正确链接访问' });
    return;
  }
  loadSessions();
  startListAutoRefresh();
}

document.addEventListener('DOMContentLoaded', bootstrap);

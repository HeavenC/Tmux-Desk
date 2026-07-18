const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { ClipboardAddon } = require('@xterm/addon-clipboard');
const { liveCountForView, mobileSessionsForView } = require('./mobile-session-model');
const { t, applyStaticI18n, setLocale, getLocale, detectLocale } = require('./i18n');

const LIST_REFRESH_MS = 15000;
const PING_INTERVAL_MS = 25000;
const THEME_KEY = 'tmux-desk-web-theme';
const LANG_KEY = 'tmux-desk-web-lang'; // 'zh' | 'en'; unset = follow system
const CUSTOM_KEYS_KEY = 'tmux-desk-web-custom-keys'; // legacy text-only keys, migrated on first load
const QUICKKEYS_KEY = 'tmux-desk-web-quickkeys';
const BALL_KEY = 'tmux-desk-web-ball';

// Preset keys the user can add to the quick bar. `ctrl` is the sticky-Ctrl
// toggle; the rest send a fixed escape/control sequence.
const PRESET_KEYS = {
  esc: { label: 'Esc', seq: '\x1b' },
  tab: { label: 'Tab', seq: '\t' },
  enter: { label: '⏎', seq: '\r' },
  backspace: { label: '⌫', seq: '\x7f' },
  ctrl: { label: 'Ctrl', ctrl: true },
  prefix: { label: '⌃B', seq: '\x02' },
  'ctrl-c': { label: '⌃C', seq: '\x03' },
  'ctrl-d': { label: '⌃D', seq: '\x04' },
  'ctrl-z': { label: '⌃Z', seq: '\x1a' },
  'ctrl-l': { label: '⌃L', seq: '\x0c' },
  'ctrl-r': { label: '⌃R', seq: '\x12' },
  'ctrl-u': { label: '⌃U', seq: '\x15' },
  'ctrl-a': { label: '⌃A', seq: '\x01' },
  'ctrl-e': { label: '⌃E', seq: '\x05' },
  up: { label: '↑', seq: '\x1b[A' },
  down: { label: '↓', seq: '\x1b[B' },
  left: { label: '←', seq: '\x1b[D' },
  right: { label: '→', seq: '\x1b[C' },
};

const DEFAULT_QUICKKEYS = [
  { type: 'preset', id: 'esc' },
  { type: 'preset', id: 'up' },
  { type: 'preset', id: 'ctrl-c' },
  { type: 'preset', id: 'enter' },
  { type: 'preset', id: 'left' },
  { type: 'preset', id: 'down' },
  { type: 'preset', id: 'right' },
  { type: 'text', label: '/btw', text: '/btw', enter: true },
  { type: 'text', label: '/usage', text: '/usage', enter: true },
  { type: 'text', label: '/new', text: '/new', enter: true },
  { type: 'text', label: '/resume', text: '/resume', enter: true },
  { type: 'text', label: '/context', text: '/context', enter: true },
  { type: 'preset', id: 'backspace' },
];
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
  share: '',
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
  reconnectAttempts: 0,
  reconnectTimer: null,
  listRefreshTimer: null,
  ctrlActive: false,
  manualClose: false,
  theme: 'light',
  term: null,
  fitAddon: null,
  termTextarea: null,
  keyboardActive: false,
  relockTimer: null,
  composing: false,
  quickKeys: [],
  // Non-null when the open session lives on a relayed remote host: its quick-key
  // bar overrides the local one for display/sending, and is read-only here.
  remoteQuickKeys: null,
  panelOpen: false,
};

const el = (id) => document.getElementById(id);

function getToken() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

function getShare() {
  return new URLSearchParams(window.location.search).get('share') || '';
}

function applySharedSessionMode() {
  const shared = Boolean(state.share);
  document.documentElement.dataset.sharedSession = String(shared);
  document.querySelectorAll('.shared-mode-badge').forEach((badge) => { badge.hidden = !shared; });
  el('workspace-filters').hidden = shared;
  el('back-btn').hidden = shared;
  if (shared) closeSessionTagsModal();
}

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  if (state.share) url.searchParams.set('share', state.share);
  else if (state.token) url.searchParams.set('token', state.token);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(t('error.badResponse'));
  }
  if (!response.ok || !body.ok) throw new Error(body.error || t('error.requestFailed'));
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
  // The floating quick bar shows over a live terminal on every client. On
  // desktop the on-screen-keyboard button is hidden (see setupKeyboardGate) and
  // the textarea stays editable, but the quick-key / copy actions are still
  // useful — e.g. one-tap /usage, /new — so the ball is no longer desktop-gated.
  const ball = el('quickball');
  if (ball) ball.hidden = name !== 'terminal';
  if (name !== 'terminal') closeQuickPanel();
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

// Language: default follows the system; a manual pick is remembered per device.
function storedLanguage() {
  try {
    const value = localStorage.getItem(LANG_KEY);
    return value === 'zh' || value === 'en' ? value : null;
  } catch {
    return null;
  }
}

function applyStoredLanguage() {
  setLocale(storedLanguage() || detectLocale());
  updateLangButton();
}

function updateLangButton() {
  const button = document.getElementById('lang-btn');
  if (!button) return;
  // Show the current language; tapping switches to the other.
  button.textContent = getLocale() === 'zh' ? '中' : 'EN';
  button.setAttribute('aria-label', getLocale() === 'zh' ? '切换到英文' : 'Switch to Chinese');
}

function toggleLanguage() {
  const next = getLocale() === 'zh' ? 'en' : 'zh';
  try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode */ }
  setLocale(next);
  relocalize();
}

// Re-apply every translated string after a language change, without reloading.
function relocalize() {
  applyStaticI18n();
  updateLangButton();
  renderWorkspaceFilters();
  if (state.currentView === 'list' && state.sessions.length) {
    setListState({ loading: false, error: null, sessions: currentListSessions() });
  }
  renderQuickKeys();
  if (!el('quickedit-modal').hidden) {
    renderQuickPresets();
    renderQuickCurrent();
  }
  syncFullscreenButton();
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
    webQuickKeys: Array.isArray(preferences.webQuickKeys) ? preferences.webQuickKeys : [],
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

function sessionsForShare(sessions) {
  if (!state.share) return sessions;
  return sessions.filter(Boolean).slice(0, 1);
}

function currentListLabel() {
  if (state.listView.kind === 'favorites') return t('filter.favorites');
  if (state.listView.kind === 'tag') {
    return state.preferences.tags.find((tag) => tag.id === state.listView.tagId)?.name || 'Tag';
  }
  return t('filter.all');
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatRelativeTime(epochSeconds) {
  if (!epochSeconds) return '';
  const now = new Date();
  const then = new Date(epochSeconds * 1000);
  const diffSec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (diffSec < 60) return t('time.justNow');
  if (diffSec < 3600) return t('time.minutesAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t('time.hoursAgo', { n: Math.floor(diffSec / 3600) });
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
  if (dayDiff <= 1) return t('time.yesterday');
  if (dayDiff < 7) return t('time.daysAgo', { n: dayDiff });
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
    emptyText.textContent = state.share
      ? t('list.emptyShared')
      : state.listView.kind === 'all'
        ? t('list.emptyAll')
        : t('list.emptyFiltered', { label: currentListLabel() });
    renderSessionList(sessions);
  }
}

function createWorkspaceFilter(view, label, count, tag = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `workspace-filter${sameListView(view, state.listView) ? ' active' : ''}`;
  button.setAttribute('aria-pressed', String(sameListView(view, state.listView)));
  button.title = t('filter.titleCount', { label, count });
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
  if (state.share) {
    filters.replaceChildren();
    filters.hidden = true;
    return;
  }
  filters.hidden = false;
  const views = [
    { view: { kind: 'all' }, label: t('filter.all') },
    { view: { kind: 'favorites' }, label: t('filter.favorites') },
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
    // Which host this session lives on: local sessions show 本机, relayed remote
    // sessions show the alias configured for that remote connection.
    const host = document.createElement('span');
    host.className = `session-host${session.source ? ' remote' : ''}`;
    host.textContent = session.source && session.source.label ? session.source.label : t('list.localHost');
    head.append(name, host, dot);

    const sub = document.createElement('div');
    sub.className = 'session-sub';
    sub.textContent = t('list.sessionSub', {
      windows: session.windows ?? 0,
      panes: session.paneCount ?? 0,
      cmd: session.activeCommand || '-',
    });

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = [session.path || '', formatRelativeTime(session.activity)].filter(Boolean).join(' · ');

    li.append(head, sub, meta);
    if (!state.share) {
      const footer = document.createElement('div');
      footer.className = 'session-card-footer';
      const tagList = document.createElement('div');
      tagList.className = 'session-tags';
      tagList.setAttribute('aria-label', t('list.tagsAssociatedAria'));
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
      manageTags.setAttribute('aria-label', t('list.manageTagsAria', { name: session.name }));
      manageTags.addEventListener('click', (event) => {
        event.stopPropagation();
        openSessionTagsModal(session);
      });
      footer.append(tagList, manageTags);
      li.appendChild(footer);
    }
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
    const sessions = Array.isArray(body.sessions) ? body.sessions : [];
    state.sessions = sessionsForShare(sessions);
    state.preferences = normalizePreferenceProjection(body.preferences);
    applyServerQuickKeys(state.preferences.webQuickKeys);
    ensureListView();
    renderWorkspaceFilters();
    setListState({ loading: false, error: null, sessions: currentListSessions() });
    if (state.share && state.currentView === 'list' && state.sessions.length === 1) {
      openSession(state.sessions[0]);
    }
  } catch (err) {
    setListState({ loading: false, error: err.message || t('error.loadFailed') });
  }
}

function closeSessionTagsModal() {
  const modal = el('session-tags-modal');
  modal.hidden = true;
  el('session-tags-form').removeAttribute('data-session-name');
}

function openSessionTagsModal(session) {
  if (state.share) return;
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
    empty.textContent = t('sheet.noTagsHint');
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
  saveButton.textContent = t('common.saving');
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
    showToast(t('toast.tagSaved'));
  } catch (error) {
    showToast(error.message || t('toast.tagSaveFailed'));
  } finally {
    saveButton.textContent = t('common.save');
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
// Whether this client has a precise pointer (mouse / trackpad). Desktop browsers
// — including touchscreen laptops — report a fine pointer; phones/tablets do not.
// The soft-keyboard gate below only makes sense where there IS an on-screen
// keyboard to suppress; on desktop it must never engage, because setting the
// xterm textarea readonly kills IME composition (Latin keys still reach xterm via
// keydown, so ASCII works while Chinese input appears "disabled").
function hasFinePointer() {
  return !!(window.matchMedia && window.matchMedia('(any-pointer: fine)').matches);
}

function setupKeyboardGate() {
  const textarea = state.term?.element?.querySelector('.xterm-helper-textarea');
  if (!textarea) return;
  state.termTextarea = textarea;
  // Desktop: keep the textarea permanently editable so IME composition works.
  // Skip the lock and the blur-relock listener entirely, and hide the "键盘"
  // quick-bar button — it only exists to raise the on-screen keyboard, which
  // desktop browsers don't have.
  if (hasFinePointer()) {
    unlockKeyboard();
    el('keyboard-btn')?.setAttribute('hidden', '');
    return;
  }
  lockKeyboard();
  textarea.addEventListener('blur', onTextareaBlur);
  textarea.addEventListener('focus', () => { clearTimeout(state.relockTimer); });
  // While an IME composition is active, never re-lock — locking sets the
  // textarea readonly, which drops the committed text (notably Chinese
  // full-width punctuation on iOS/iPadOS).
  textarea.addEventListener('compositionstart', () => { state.composing = true; clearTimeout(state.relockTimer); });
  textarea.addEventListener('compositionend', () => { state.composing = false; });
}

function onTextareaBlur() {
  // The Chinese IME's punctuation panel briefly blurs the textarea; re-locking
  // it synchronously swallows the punctuation. Defer the re-lock and skip it if
  // focus (or a composition) has come back by then.
  clearTimeout(state.relockTimer);
  state.relockTimer = setTimeout(() => {
    if (!state.composing && document.activeElement !== state.termTextarea) lockKeyboard();
  }, 500);
}

function lockKeyboard() {
  const textarea = state.termTextarea;
  if (!textarea) return;
  clearTimeout(state.relockTimer);
  textarea.setAttribute('readonly', 'readonly');
  textarea.setAttribute('inputmode', 'none');
  state.keyboardActive = false;
  el('keyboard-btn')?.classList.remove('active');
}

function unlockKeyboard() {
  const textarea = state.termTextarea;
  if (!textarea) return;
  clearTimeout(state.relockTimer);
  textarea.removeAttribute('readonly');
  textarea.removeAttribute('inputmode');
  state.keyboardActive = true;
  el('keyboard-btn')?.classList.add('active');
}

function toggleKeyboard() {
  const textarea = state.termTextarea;
  if (!state.term || !textarea) return;
  // On desktop the textarea stays editable (see setupKeyboardGate); locking it
  // would kill IME, so the button just (re)focuses the terminal.
  if (hasFinePointer()) {
    unlockKeyboard();
    try { textarea.focus({ preventScroll: true }); } catch { textarea.focus(); }
    return;
  }
  if (state.keyboardActive) {
    textarea.blur();
    lockKeyboard();
  } else {
    unlockKeyboard();
    // Focus the real IME textarea synchronously inside the tap gesture: iOS only
    // raises the keyboard for a focus() made editable in the same user gesture,
    // and term.focus() is frequently a no-op there (the "needs 3 taps" bug).
    try { textarea.focus({ preventScroll: true }); } catch { textarea.focus(); }
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
  document.querySelectorAll('.qk-ctrl').forEach((button) => button.classList.toggle('active', active));
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
    showToast(t('toast.copied'));
  } catch {
    // Clipboard API unavailable/denied: select the text so the user can
    // still copy it manually (long-press → 拷贝 on iOS/Android).
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pre);
    selection.removeAllRanges();
    selection.addRange(range);
    showToast(t('toast.copyManual'));
  }
}

function sendWsJson(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function sendWsInput(data) {
  sendWsJson({ type: 'input', data });
}

// Ask the server to emit a focus-in report on our tmux client (see the
// 'focus' handler in web-server.js). Safe to call any time; no-op when the
// socket is down or we're not on the terminal view.
function notifyClientFocus() {
  if (state.currentView !== 'terminal') return;
  sendWsJson({ type: 'focus' });
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
    session: sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  if (state.share) params.set('share', state.share);
  else if (state.token) params.set('token', state.token);
  return `${protocol}//${window.location.host}/ws?${params.toString()}`;
}

const RECONNECT_MAX = 10;

// Growing backoff, capped at 30s: 1s, 2s, 4s, 8s, 16s, then 30s.
function reconnectDelay(attempt) {
  return Math.min(1000 * 2 ** (attempt - 1), 30000);
}

// Public entry: (re)connect fresh, resetting the auto-reconnect counter.
function connectWebSocket(sessionId) {
  state.reconnectAttempts = 0;
  clearTimeout(state.reconnectTimer);
  openSocket(sessionId);
}

function openSocket(sessionId) {
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
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    hideDisconnectBanner();
    state.pingTimer = setInterval(() => sendWsJson({ type: 'ping' }), PING_INTERVAL_MS);
  };
  ws.onmessage = (event) => handleWsMessage(event);
  ws.onclose = () => {
    clearInterval(state.pingTimer);
    if (!state.manualClose && state.currentView === 'terminal' && state.wsSessionId === sessionId) {
      scheduleReconnect(sessionId);
    }
  };
  ws.onerror = () => {};
}

// Auto-reconnect on an unexpected drop: retry with growing
// delay up to RECONNECT_MAX times, surfacing progress; only after all attempts
// fail do we fall back to a manual "重连" button.
function scheduleReconnect(sessionId) {
  state.reconnectAttempts += 1;
  if (state.reconnectAttempts > RECONNECT_MAX) {
    showDisconnectBanner({ reconnecting: false });
    return;
  }
  showDisconnectBanner({ reconnecting: true, attempt: state.reconnectAttempts });
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    if (state.manualClose || state.currentView !== 'terminal' || state.wsSessionId !== sessionId) return;
    openSocket(sessionId);
  }, reconnectDelay(state.reconnectAttempts));
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
      showToast(t('toast.sessionEnded'));
      backToList();
      break;
    case 'error':
      showToast(msg.message || t('toast.genericError'));
      break;
    default:
      break;
  }
}

function showDisconnectBanner({ reconnecting = false, attempt = 0 } = {}) {
  const banner = el('disconnect-banner');
  const label = banner.querySelector('span');
  const button = el('reconnect-btn');
  if (reconnecting) {
    if (label) label.textContent = t('reconnect.progress', { n: attempt, max: RECONNECT_MAX });
    if (button) button.hidden = true;
  } else {
    if (label) label.textContent = t('reconnect.disconnected');
    if (button) button.hidden = false;
  }
  banner.hidden = false;
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
    showToast(err.message || t('error.loadWindowsFailed'));
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
    showToast(err.message || t('error.switchWindowFailed'));
  }
  state.term.focus();
}

function openSession(session) {
  state.currentSession = session;
  state.grouped = null;
  state.windows = [];
  el('term-title').textContent = session.name || session.id;
  renderWindowPicker();
  syncQuickKeysForSession(session);
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
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempts = 0;
  if (state.ws) state.ws.close();
  state.ws = null;
  hideDisconnectBanner();
  setCtrlActive(false);
  state.remoteQuickKeys = null;
  showView('list');
  loadSessions();
}

// ---- Quick bar: a customizable, draggable floating key panel --------------

function normalizeQuickKey(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'preset' && PRESET_KEYS[item.id]) return { type: 'preset', id: item.id };
  if (item.type === 'text' && typeof item.label === 'string' && typeof item.text === 'string') {
    return { type: 'text', label: item.label.slice(0, 16), text: item.text.slice(0, 200), enter: item.enter === true };
  }
  return null;
}

function loadQuickKeys() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(QUICKKEYS_KEY)); } catch { stored = null; }
  if (Array.isArray(stored)) {
    state.quickKeys = stored.map(normalizeQuickKey).filter(Boolean).slice(0, 40);
    return;
  }
  // First run: seed defaults, then fold in any legacy text-only custom keys.
  const keys = [...DEFAULT_QUICKKEYS];
  try {
    const legacy = JSON.parse(localStorage.getItem(CUSTOM_KEYS_KEY) || '[]');
    if (Array.isArray(legacy)) {
      for (const item of legacy) {
        if (item && typeof item.label === 'string' && typeof item.text === 'string') {
          keys.push({ type: 'text', label: item.label.slice(0, 16), text: item.text.slice(0, 200), enter: item.enter !== false });
        }
      }
    }
  } catch { /* ignore malformed legacy data */ }
  state.quickKeys = keys;
  saveQuickKeys();
}

function saveQuickKeys() {
  // localStorage is a per-device cache / offline fallback; the machine running
  // tmux-desk is the shared source of truth so every phone sees the same bar.
  try { localStorage.setItem(QUICKKEYS_KEY, JSON.stringify(state.quickKeys)); } catch { /* private mode */ }
  pushQuickKeysToServer();
}

function pushQuickKeysToServer() {
  if (!state.token) return;
  fetchJson(apiUrl('/api/quick-keys'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.quickKeys),
  }).catch(() => { /* offline — the localStorage copy re-syncs on next edit */ });
}

// Pull the latest shared bar on demand (opening the panel / editor), so a change
// made on another device shows up without waiting for a session-list refresh.
function refreshQuickKeysFromServer() {
  if (!state.token) return;
  fetchJson(apiUrl('/api/quick-keys'))
    .then((body) => applyServerQuickKeys(body.keys))
    .catch(() => { /* offline — keep the local copy */ });
}

// Reconcile with the shared copy on this machine, delivered alongside the
// session list. A non-empty shared copy wins; an empty one gets seeded from this
// device so the first phone to edit publishes its bar to the rest.
function applyServerQuickKeys(serverKeys) {
  const normalized = (Array.isArray(serverKeys) ? serverKeys : []).map(normalizeQuickKey).filter(Boolean);
  if (normalized.length) {
    if (JSON.stringify(normalized) === JSON.stringify(state.quickKeys)) return;
    state.quickKeys = normalized;
    try { localStorage.setItem(QUICKKEYS_KEY, JSON.stringify(state.quickKeys)); } catch { /* private mode */ }
    renderQuickKeys();
    if (!el('quickedit-modal').hidden) renderQuickCurrent();
  } else if (state.quickKeys.length) {
    pushQuickKeysToServer();
  }
}

function quickKeyLabel(key) {
  return key.type === 'preset' ? (PRESET_KEYS[key.id]?.label ?? key.id) : key.label;
}

// The bar actually shown/typed: a relayed remote session's bar wins over the
// local one so the floating shortcuts follow the session's owning host.
function effectiveQuickKeys() {
  return Array.isArray(state.remoteQuickKeys) ? state.remoteQuickKeys : state.quickKeys;
}

// Remote sessions are a read-only takeover, so their relayed bar can't be edited
// from here (edits would otherwise silently mutate this device's local bar).
function quickKeysReadonly() {
  return Array.isArray(state.remoteQuickKeys);
}

// Load the quick-key bar for the session being opened. Remote sessions carry a
// source; ask the server for that host's bar (it relays upstream). Local
// sessions clear the override and fall back to this device's own bar.
async function syncQuickKeysForSession(session) {
  if (!session || !session.source) {
    state.remoteQuickKeys = null;
    renderQuickKeys();
    return;
  }
  try {
    const body = await fetchJson(apiUrl('/api/quick-keys', { session: session.id }));
    const keys = (Array.isArray(body.keys) ? body.keys : []).map(normalizeQuickKey).filter(Boolean);
    state.remoteQuickKeys = keys.length ? keys : null;
  } catch {
    state.remoteQuickKeys = null;
  }
  renderQuickKeys();
}

function renderQuickKeys() {
  const container = el('quickpanel-keys');
  if (!container) return;
  container.replaceChildren(...effectiveQuickKeys().map((key, index) => {
    const button = document.createElement('button');
    button.className = 'qk-btn';
    button.type = 'button';
    button.textContent = quickKeyLabel(key);
    if (key.type === 'preset' && PRESET_KEYS[key.id]?.ctrl) button.classList.add('qk-ctrl');
    if (key.type === 'text') button.title = key.text + (key.enter ? ' ⏎' : '');
    bindTap(button, () => runQuickKey(index));
    return button;
  }));
  if (state.ctrlActive) setCtrlActive(true);
}

function runQuickKey(index) {
  const key = effectiveQuickKeys()[index];
  if (!key) return;
  if (key.type === 'preset') {
    const preset = PRESET_KEYS[key.id];
    if (!preset) return;
    if (preset.ctrl) { setCtrlActive(!state.ctrlActive); return; }
    sendWsInput(preset.seq);
  } else {
    sendWsInput(key.text);
    if (key.enter) sendWsInput('\r');
  }
  if (state.keyboardActive) state.term?.focus();
}

// ---- Quick-bar editor sheet ----

function renderQuickPresets() {
  const container = el('qk-presets');
  if (!container) return;
  container.replaceChildren(...Object.entries(PRESET_KEYS).map(([id, preset]) => {
    const button = document.createElement('button');
    button.className = 'qk-preset';
    button.type = 'button';
    button.textContent = preset.label;
    button.addEventListener('click', () => {
      if (quickKeysReadonly()) return;
      state.quickKeys.push({ type: 'preset', id });
      saveQuickKeys();
      renderQuickKeys();
      renderQuickCurrent();
    });
    return button;
  }));
}

function renderQuickCurrent() {
  const list = el('qk-current');
  if (!list) return;
  const readonly = quickKeysReadonly();
  const keys = effectiveQuickKeys();
  if (!keys.length) {
    const empty = document.createElement('p');
    empty.className = 'qk-empty';
    empty.textContent = t('quick.empty');
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...keys.map((key, index) => {
    const row = document.createElement('div');
    row.className = 'qk-row';
    row.dataset.index = String(index);
    const label = document.createElement('span');
    label.className = 'qk-row-label';
    label.textContent = quickKeyLabel(key);
    const meta = document.createElement('span');
    meta.className = 'qk-row-meta';
    meta.textContent = key.type === 'text' ? (key.text + (key.enter ? ' ⏎' : '')) : t('quick.keyTypeMeta');
    if (readonly) {
      // Relayed remote bar: display only, no drag handle / delete.
      row.append(label, meta);
      return row;
    }
    const handle = document.createElement('span');
    handle.className = 'qk-handle';
    handle.textContent = '≡';
    handle.setAttribute('aria-label', t('quick.dragHandleAria'));
    handle.addEventListener('pointerdown', (event) => startQkDrag(event, index));
    const remove = document.createElement('button');
    remove.className = 'btn secondary btn-sm';
    remove.type = 'button';
    remove.textContent = t('common.delete');
    remove.addEventListener('click', () => {
      state.quickKeys.splice(index, 1);
      saveQuickKeys();
      renderQuickKeys();
      renderQuickCurrent();
    });
    row.append(handle, label, meta, remove);
    return row;
  }));
}

// Pointer-based drag reordering (works for both touch and mouse) of the saved
// keys. The drag doesn't reshuffle the DOM live; it marks the insertion point
// and commits on release.
function startQkDrag(event, fromIndex) {
  event.preventDefault();
  const list = el('qk-current');
  const rows = [...list.querySelectorAll('.qk-row')];
  const dragRow = rows[fromIndex];
  dragRow?.classList.add('dragging');

  const insertionIndexAt = (y) => {
    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return i;
    }
    return rows.length;
  };
  const mark = (insertion) => {
    rows.forEach((row, i) => {
      row.classList.toggle('drop-before', i === insertion);
      row.classList.toggle('drop-after', insertion === rows.length && i === rows.length - 1);
    });
  };

  const onMove = (moveEvent) => mark(insertionIndexAt(moveEvent.clientY));
  const onUp = (upEvent) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    const insertion = insertionIndexAt(upEvent.clientY);
    const to = fromIndex < insertion ? insertion - 1 : insertion;
    if (to !== fromIndex && to >= 0 && to < state.quickKeys.length) {
      const [item] = state.quickKeys.splice(fromIndex, 1);
      state.quickKeys.splice(to, 0, item);
      saveQuickKeys();
      renderQuickKeys();
    }
    renderQuickCurrent();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

function openQuickEdit() {
  const readonly = quickKeysReadonly();
  // The add/preset/reset controls edit this device's local bar; hide them while a
  // read-only remote bar is on screen so the editor matches what's shown.
  document.querySelectorAll('#quickedit-modal .qk-editable').forEach((node) => { node.hidden = readonly; });
  el('qk-readonly-note').hidden = !readonly;
  if (!readonly) refreshQuickKeysFromServer();
  renderQuickPresets();
  renderQuickCurrent();
  el('quickedit-modal').hidden = false;
}

function closeQuickEdit() {
  el('quickedit-modal').hidden = true;
}

function addQuickTextKey(event) {
  event.preventDefault();
  if (quickKeysReadonly()) return;
  const label = el('qk-text-label').value.trim().slice(0, 16);
  const text = el('qk-text-value').value.slice(0, 200);
  if (!label || !text) { showToast(t('toast.fillLabelAndText')); return; }
  state.quickKeys.push({ type: 'text', label, text, enter: el('qk-text-enter').checked });
  saveQuickKeys();
  renderQuickKeys();
  renderQuickCurrent();
  el('qk-text-label').value = '';
  el('qk-text-value').value = '';
  el('qk-text-enter').checked = false;
  el('qk-text-label').focus();
}

function resetQuickKeys() {
  if (quickKeysReadonly()) return;
  state.quickKeys = [...DEFAULT_QUICKKEYS];
  saveQuickKeys();
  renderQuickKeys();
  renderQuickCurrent();
}

// ---- The floating ball (drag to move, tap to open) ----

function openQuickPanel() {
  state.panelOpen = true;
  refreshQuickKeysFromServer();
  const panel = el('quickpanel');
  panel.hidden = false;
  positionQuickPanel();
  el('quickball').setAttribute('aria-expanded', 'true');
}

function closeQuickPanel() {
  state.panelOpen = false;
  el('quickpanel').hidden = true;
  el('quickball').setAttribute('aria-expanded', 'false');
}

function toggleQuickPanel() {
  if (state.panelOpen) closeQuickPanel();
  else openQuickPanel();
}

// Anchor the panel next to the ball, opening toward the side with more room and
// clamped inside the viewport.
function positionQuickPanel() {
  const panel = el('quickpanel');
  const ball = el('quickball');
  if (!panel || !ball || panel.hidden) return;
  const ballRect = ball.getBoundingClientRect();
  const margin = 8;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const openLeft = ballRect.left + ballRect.width / 2 > window.innerWidth / 2;
  let left = openLeft ? ballRect.left - pw - margin : ballRect.right + margin;
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
  let top = ballRect.top + ballRect.height / 2 - ph / 2;
  top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function loadBallPosition() {
  const ball = el('quickball');
  if (!ball) return;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(BALL_KEY)); } catch { pos = null; }
  const size = 56;
  const defaultPos = { x: window.innerWidth - size - 12, y: Math.round(window.innerHeight * 0.62) };
  applyBallPosition(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : defaultPos);
}

function applyBallPosition({ x, y }) {
  const ball = el('quickball');
  const size = ball.offsetWidth || 56;
  const margin = 6;
  const clampedX = Math.max(margin, Math.min(x, window.innerWidth - size - margin));
  const clampedY = Math.max(margin, Math.min(y, window.innerHeight - size - margin));
  ball.style.left = `${clampedX}px`;
  ball.style.top = `${clampedY}px`;
}

function saveBallPosition() {
  const ball = el('quickball');
  const pos = { x: parseFloat(ball.style.left) || 0, y: parseFloat(ball.style.top) || 0 };
  try { localStorage.setItem(BALL_KEY, JSON.stringify(pos)); } catch { /* private mode */ }
}

function setupQuickball() {
  const ball = el('quickball');
  if (!ball) return;
  loadBallPosition();

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  ball.addEventListener('pointerdown', (event) => {
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    originLeft = parseFloat(ball.style.left) || 0;
    originTop = parseFloat(ball.style.top) || 0;
    ball.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  ball.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    moved = true;
    if (state.panelOpen) closeQuickPanel();
    applyBallPosition({ x: originLeft + dx, y: originTop + dy });
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    try { ball.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (moved) {
      // Snap to the nearer horizontal edge, iPhone-style, and remember it.
      const size = ball.offsetWidth || 56;
      const left = parseFloat(ball.style.left) || 0;
      const snapLeft = left + size / 2 < window.innerWidth / 2 ? 6 : window.innerWidth - size - 6;
      applyBallPosition({ x: snapLeft, y: parseFloat(ball.style.top) || 0 });
      saveBallPosition();
    } else {
      toggleQuickPanel();
    }
  };
  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    applyBallPosition({ x: parseFloat(ball.style.left) || 0, y: parseFloat(ball.style.top) || 0 });
    if (state.panelOpen) positionQuickPanel();
  });
  // Tapping outside the panel (and not on the ball) closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!state.panelOpen) return;
    if (el('quickpanel').contains(event.target) || event.target === ball) return;
    closeQuickPanel();
  });
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
      showToast(t('toast.fullscreenDenied'));
    });
  } else {
    // iOS/iPadOS Safari won't fullscreen arbitrary elements — the home-screen
    // web app is the only way to drop the address bar there.
    showToast(t('toast.fullscreenSafariHint'));
  }
}

function syncFullscreenButton() {
  const button = el('fullscreen-btn');
  if (!button) return;
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  button.classList.toggle('active', Boolean(active));
  button.setAttribute('aria-label', active ? t('fullscreen.exit') : t('fullscreen.enter'));
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
  bindTap(el('copy-btn'), openCopyOverlay);
  // A plain click (not bindTap) keeps the tap a genuine user gesture so the
  // focus() inside toggleKeyboard reliably raises the soft keyboard; bindTap's
  // touchstart preventDefault is what made the first tap silently fail.
  el('keyboard-btn').addEventListener('click', toggleKeyboard);
  bindTap(el('quickedit-open'), openQuickEdit);
  renderQuickKeys();
  setupQuickball();
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
  el('lang-btn').addEventListener('click', toggleLanguage);
  document.querySelectorAll('.theme-btn').forEach((button) => button.addEventListener('click', toggleTheme));
  el('list-retry-btn').addEventListener('click', loadSessions);
  el('back-btn').addEventListener('click', backToList);
  el('reconnect-btn').addEventListener('click', () => {
    if (state.currentSession) connectWebSocket(state.currentSession.id);
  });
  // Coming back to the foreground after the OS froze/closed the socket: retry
  // immediately instead of waiting out the backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.currentView !== 'terminal' || !state.currentSession) return;
    const socketDown = !state.ws || state.ws.readyState > WebSocket.OPEN;
    if (socketDown) connectWebSocket(state.currentSession.id);
    else notifyClientFocus();
  });
  // Tell tmux this client is the active one whenever the tab regains focus, so
  // the shared window resizes to OUR width (window-size=latest) — otherwise a
  // narrower client that typed last leaves a dead strip on the right here.
  window.addEventListener('focus', notifyClientFocus);
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
  el('quickedit-close').addEventListener('click', closeQuickEdit);
  el('qk-reset').addEventListener('click', resetQuickKeys);
  el('qk-add-text').addEventListener('submit', addQuickTextKey);
  el('quickedit-modal').addEventListener('click', (event) => {
    if (event.target === el('quickedit-modal')) closeQuickEdit();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!el('session-tags-modal').hidden) closeSessionTagsModal();
    if (!el('copy-modal').hidden) closeCopyOverlay();
    if (!el('quickedit-modal').hidden) closeQuickEdit();
  });
}

function bootstrap() {
  applyStoredLanguage();
  applyStaticI18n();
  state.share = getShare();
  state.token = state.share ? '' : getToken();
  applySharedSessionMode();
  applyTheme(storedTheme());
  loadQuickKeys();
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
  if (!state.token && !state.share) {
    setListState({ loading: false, error: t('error.missingCredential') });
    return;
  }
  loadSessions();
  startListAutoRefresh();
}

document.addEventListener('DOMContentLoaded', bootstrap);

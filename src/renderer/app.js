const QRCode = require('qrcode');
const { icon } = require('./icons');
const { searchCommands } = require('./command-palette');
const { filterAndGroupSessions, sessionsForView } = require('../shared/session-model');
const { adjacentTagId } = require('../shared/tag-model');
const { resolveTerminalFileReference } = require('../shared/terminal-file-link');
const { pathReference } = require('../shared/terminal-path');
const { DEFAULT_TMUX_SETTINGS, TMUX_SETTING_FIELDS, parseAdvancedConfig } = require('../shared/tmux-settings');
const { DEFAULT_TERMINAL_APPEARANCE, normalizeTerminalAppearance } = require('../shared/terminal-appearance');
const { DEFAULT_PASTE_GUARD, normalizePasteGuard } = require('../shared/paste-guard');
const { applyTheme, resolveTheme } = require('./theme');
const { TerminalView } = require('./terminal-view');
const { RemoteApi } = require('./remote-api');
const remoteStore = require('./remote-connections');
const { t, applyStaticI18n, setLocale, getLocale, resolveLocale, loadStoredLanguage, saveLanguage } = require('./i18n');

const api = window.tmuxDesk;
// The local IPC bridge is one "source"; each remote takeover host is another.
// activeApi() resolves the currently-selected source to an object with the same
// method shape TerminalView + the session code expect.
const localApi = api;
const remoteApis = new Map();

function emptyViewPrefs() {
  return { tags: [], sessionTags: {}, favorites: [], tabOrders: {} };
}
const $ = (selector) => document.querySelector(selector);
const refs = {};
const state = {
  systemStatus: { installed: false, path: null, version: null },
  preferences: {
    theme: 'light', favorites: [], tags: [], sessionTags: {}, tabOrders: {}, lastSession: null, windowBounds: null, sidebarWidth: null,
    tagRailExpanded: false, tagRailWidth: null, keepAwake: false, autoShare: false, remoteConnections: [], remoteLastSessions: {},
    tmuxSettings: { ...DEFAULT_TMUX_SETTINGS },
    sessionRestore: { enabled: true, autoRestore: true, repairCwd: true, intervalMinutes: 3 },
  },
  sessions: [],
  selectedSessionId: null,
  detail: { windows: [], panes: [] },
  // Cross-session search (Cmd+F): results from every pane on the tmux server,
  // not just the attached one. token drops answers from stale queries.
  search: { open: false, results: [], index: 0, token: 0, truncated: false, panes: 0 },
  // What Cmd+G steps through in the attached pane, and which way it went last
  // (a reversal costs tmux one extra step — see TmuxService.findInSession).
  paneSearch: null,
  query: '',
  view: { kind: 'all' },
  // Set by a source switch: the first listing that arrives (possibly a later
  // poll, if the host was unreachable at switch time) reopens the session the
  // user left on that source.
  restorePending: false,
  commandIndex: 0,
  // key = source + session + dir the panel shows; transfers = live/finished
  // cross-device transfer rows (see startTransfer).
  files: { open: false, root: null, key: null, uploadDir: null, transfers: [] },
  source: { kind: 'local', id: 'local' },
  // Tags / favorites / tab order of the remote host being viewed (see viewPrefs).
  remotePrefs: emptyViewPrefs(),
  remoteConnections: [],
  sourceStatus: 'online',
  // Reachability of each saved remote host, keyed by connection id:
  // { status: 'checking' | 'online' | 'offline', ms, error, at }. Filled by
  // probeRemoteHosts() so the source popover can say which host is actually
  // there before the user commits to a switch.
  remoteProbes: new Map(),
  // Session snapshot health, pushed from the main process (see session-snapshot.js).
  snapshot: null,
};

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let terminalView = null;
let pollTimer = null;
let lastOfflinePoll = 0;
let selectionToken = 0;
let sourceToken = 0;
// sourceToken of the refresh in flight, if any (see refreshSessions).
let refreshingToken = null;
let tagActivationToken = 0;
let draggedTabName = null;

function cacheElements() {
  for (const id of [
    'appShell', 'tagRail', 'newTagButton', 'sessionSummary', 'refreshButton', 'newSessionButton', 'searchIcon', 'sessionSearch', 'sessionList',
    'sourceBar', 'sourceButton', 'sourceIcon', 'sourceLabel', 'sourceStatusDot', 'sourceCaret', 'sourcePopover',
    'remoteModal', 'remoteForm', 'remoteLabelInput', 'remoteUrlInput', 'remoteTokenInput',
    'tmuxStatusDot', 'tmuxStatusText', 'themeButton', 'settingsButton', 'activeSessionName',
    'activeSessionPath', 'attachedBadge', 'workspaceViewBadge', 'panePickerWrap', 'panePicker', 'panePickerIcon',
    'sessionMenuButton', 'sessionTabs', 'terminalStage', 'terminalSurface', 'terminalMount', 'paneCloseLayer', 'terminalReconnect', 'terminalDrop',
    'globalSearch', 'globalSearchIcon', 'globalSearchInput', 'globalSearchResults', 'globalSearchStatus',
    'reconnectButton', 'emptyState', 'emptyTitle', 'emptyMessage', 'emptyActions', 'emptyNewButton',
    'emptyInstallButton', 'emptyRefreshButton', 'emptyAllButton', 'workspaceStatus', 'commandHint', 'themePopover', 'contextMenu', 'toastStack',
    'broadcastFlag',
    'sessionModal', 'sessionForm', 'sessionNameInput', 'sessionCwdInput', 'startupCommandInput',
    'chooseDirectoryButton', 'renameModal', 'renameForm', 'renameInput', 'killModal', 'killMessage',
    'confirmKillButton', 'settingsModal', 'themeCards', 'languageCards', 'tagSettingsList', 'settingsNewTagButton', 'tagImportButton', 'tagExportButton', 'settingsTmuxVersion', 'commandPalette',
    'commandInput', 'commandSearchIcon', 'commandResults',
    'duplicateModal', 'duplicateForm', 'duplicateInput', 'duplicateMessage',
    'importModal', 'importList', 'importTitle', 'importSubtitle', 'importSelectAll', 'importCreateButton',
    'mobileAccessButton', 'mobileAccessModal', 'mobileAccessTitle', 'mobileAccessSubtitle', 'mobileAccessBody',
    'tagEditorModal', 'tagEditorForm', 'tagEditorTitle', 'tagNameInput',
    'sessionTagsModal', 'sessionTagsForm', 'sessionTagsMessage', 'sessionTagsList',
    'tagDeleteModal', 'tagDeleteMessage', 'confirmTagDeleteButton',
    'filesToggleButton', 'fileBrowser', 'fbTree', 'fbPath', 'fbRevealButton', 'fbRefreshButton', 'fbCollapseButton',
    'fbHost', 'fbUploadButton', 'fbUploadInput', 'fbTransfers', 'fbDrop', 'fbDropText',
    'sidebarResizer', 'tagRailResizer', 'tagRailToggleButton', 'settingsScroll', 'keepAwakeToggle', 'autoShareToggle',
    'tmuxSettingsGroups', 'tmuxResetButton', 'tmuxAdvancedConfig', 'tmuxAdvancedError', 'tmuxAdvancedApplyButton',
    'snapshotHealthButton', 'snapshotModal', 'snapshotSummary', 'snapshotIssues', 'snapshotPaths',
    'snapshotSaveButton', 'snapshotRestoreButton', 'snapshotRevealButton', 'snapshotOpenButton',
    'snapshotEnabledToggle', 'snapshotAutoRestoreToggle', 'snapshotRepairToggle', 'snapshotIntervalInput',
    'snapshotSettingsStatus',
    'terminalFontFamilyInput', 'terminalFontSizeInput', 'terminalLineHeightInput',
    'terminalLetterSpacingInput', 'terminalFontResetButton',
    'pasteConfirmMultilineToggle', 'pasteConfirmCharsInput', 'pasteSlowToggle',
    'pasteConfirmModal', 'pasteConfirmMessage', 'pasteConfirmPreview', 'confirmPasteButton',
  ]) refs[id] = document.getElementById(id);
}

function installIcons() {
  $('[data-view="all"]').innerHTML = railButtonContent('terminal', t('rail.all'));
  $('[data-view="favorites"]').innerHTML = railButtonContent('star', t('rail.favorites'));
  refs.settingsButton.innerHTML = railButtonContent('settings', t('rail.settings'));
  refs.refreshButton.innerHTML = icon('refresh', 16);
  refs.newSessionButton.innerHTML = icon('plus', 17);
  refs.newTagButton.innerHTML = railButtonContent('plus', t('tag.new'), 16);
  refs.tagRailToggleButton.innerHTML = railButtonContent('chevron', t('tag.railToggleExpand'), 16);
  refs.searchIcon.innerHTML = icon('search', 14);
  refs.panePickerIcon.innerHTML = icon('panes', 15);
  refs.sessionMenuButton.innerHTML = icon('more', 18);
  refs.commandSearchIcon.innerHTML = icon('search', 18);
  refs.filesToggleButton.innerHTML = icon('sidebar', 17);
  refs.mobileAccessButton.innerHTML = railButtonContent('phone', t('rail.share'), 18);
  refs.snapshotHealthButton.innerHTML = icon('alert', 17);
  refs.fbUploadButton.innerHTML = icon('upload', 15);
  refs.fbRevealButton.innerHTML = icon('folder', 15);
  refs.fbRefreshButton.innerHTML = icon('refresh', 15);
  refs.fbCollapseButton.innerHTML = icon('close', 15);
  document.querySelectorAll('.modal-close').forEach((button) => { button.innerHTML = icon('close', 16); });
}

function railButtonContent(iconName, label, size = 18) {
  return `${icon(iconName, size)}<span class="rail-label">${label}</span>`;
}

function selectedSession() {
  return state.sessions.find((session) => session.id === state.selectedSessionId) || null;
}

// Tags, favorites and tab order of the machine whose sessions are on screen.
// A remote host's sessions were tagged on THAT host (its preferences come along
// with its /api/sessions); this machine's sessionTags are keyed by its own
// session names and can never select them. Everything that READS tag state for
// the rail, the list or the tabs goes through here; writes stay local-only.
function viewPrefs() {
  return isRemoteActive() ? state.remotePrefs : state.preferences;
}

function currentTag() {
  if (state.view.kind !== 'tag') return null;
  return viewPrefs().tags.find((tag) => tag.id === state.view.tagId) || null;
}

function compactSessions() {
  return sessionsForView(state.sessions, viewPrefs(), state.view);
}

// Key into preferences.tabOrders for the currently active compact view, or
// null when tab order has no meaning (the "all sessions" left-hand list).
function currentViewKey() {
  if (state.view.kind === 'favorites') return 'favorites';
  if (state.view.kind === 'tag') return state.view.tagId;
  return null;
}

function tagsForSession(name) {
  const prefs = viewPrefs();
  const ids = new Set(prefs.sessionTags[name] || []);
  return prefs.tags.filter((tag) => ids.has(tag.id));
}

function tagColor(tag) {
  return `var(--tag-${tag.color})`;
}

function tagSessionCount(tagId) {
  const { sessionTags } = viewPrefs();
  return state.sessions.filter((session) => (sessionTags[session.name] || []).includes(tagId)).length;
}

function compactViewLabel() {
  if (state.view.kind === 'favorites') return t('rail.favorites');
  return currentTag()?.name || 'Tag';
}

function friendlyError(error) {
  return String(error?.message || error || t('error.unknown'))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.innerHTML = icon(type === 'error' ? 'info' : 'check', 16);
  const text = document.createElement('span');
  text.textContent = message;
  item.append(text);
  refs.toastStack.append(item);
  setTimeout(() => item.remove(), type === 'error' ? 5200 : 2800);
}

function shortenPath(value) {
  return String(value || '').replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 420;
const TAG_RAIL_WIDTH_MIN = 180;
const TAG_RAIL_WIDTH_MAX = 420;

function clampSidebarWidth(value) {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

function clampTagRailWidth(value) {
  return Math.min(TAG_RAIL_WIDTH_MAX, Math.max(TAG_RAIL_WIDTH_MIN, Math.round(value)));
}

// Change only the sidebar track. Compact-view and narrow-window rules keep
// ownership of the remaining grid columns, including the responsive rail.
function applySidebarWidth() {
  const stored = state.preferences.sidebarWidth;
  const custom = Number.isFinite(stored) ? clampSidebarWidth(stored) : null;
  if (custom === null) refs.appShell.style.removeProperty('--session-sidebar-width');
  else refs.appShell.style.setProperty('--session-sidebar-width', `${custom}px`);
}

function applyTagRailWidth() {
  const stored = state.preferences.tagRailWidth;
  const custom = Number.isFinite(stored) ? clampTagRailWidth(stored) : null;
  if (custom === null) refs.appShell.style.removeProperty('--activity-rail-expanded-width');
  else refs.appShell.style.setProperty('--activity-rail-expanded-width', `${custom}px`);
}

function applyTagRailExpanded() {
  const expanded = state.preferences.tagRailExpanded === true;
  refs.appShell.classList.toggle('tag-rail-expanded', expanded);
  refs.tagRailToggleButton.setAttribute('aria-expanded', String(expanded));
  refs.tagRailToggleButton.setAttribute('aria-label', expanded ? t('tag.railToggleCollapse') : t('tag.railToggleExpand'));
  refs.tagRailToggleButton.title = expanded ? t('tag.railToggleCollapse') : t('tag.railToggleExpand');
  const label = refs.tagRailToggleButton.querySelector('.rail-label');
  if (label) label.textContent = expanded ? t('tag.railToggleCollapse') : t('tag.railToggleExpand');
}

async function setTagRailExpanded(expanded) {
  const previous = state.preferences.tagRailExpanded === true;
  state.preferences = { ...state.preferences, tagRailExpanded: expanded };
  applyTagRailExpanded();
  try {
    state.preferences = await api.savePreferences({ tagRailExpanded: expanded });
  } catch (error) {
    state.preferences = { ...state.preferences, tagRailExpanded: previous };
    applyTagRailExpanded();
    toast(friendlyError(error), 'error');
  }
}

function bindTagRailResizer() {
  refs.tagRailResizer.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || state.preferences.tagRailExpanded !== true) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = $('.activity-rail').getBoundingClientRect().width;
    const previous = state.preferences.tagRailWidth;
    let width = clampTagRailWidth(startWidth);
    let moved = false;
    refs.tagRailResizer.classList.add('dragging');
    document.body.classList.add('tag-rail-resizing');
    const onMove = (moveEvent) => {
      moved = true;
      width = clampTagRailWidth(startWidth + moveEvent.clientX - startX);
      refs.appShell.style.setProperty('--activity-rail-expanded-width', `${width}px`);
    };
    const onUp = async () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refs.tagRailResizer.classList.remove('dragging');
      document.body.classList.remove('tag-rail-resizing');
      if (!moved) return;
      state.preferences = { ...state.preferences, tagRailWidth: width };
      try {
        state.preferences = await api.savePreferences({ tagRailWidth: width });
      } catch (error) {
        state.preferences = { ...state.preferences, tagRailWidth: previous };
        toast(friendlyError(error), 'error');
      }
      applyTagRailWidth();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  refs.tagRailResizer.addEventListener('dblclick', async () => {
    if (state.preferences.tagRailExpanded !== true) return;
    const previous = state.preferences.tagRailWidth;
    state.preferences = { ...state.preferences, tagRailWidth: null };
    try {
      state.preferences = await api.savePreferences({ tagRailWidth: null });
    } catch (error) {
      state.preferences = { ...state.preferences, tagRailWidth: previous };
      toast(friendlyError(error), 'error');
    }
    applyTagRailWidth();
  });
}

function bindSidebarResizer() {
  refs.sidebarResizer.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = $('.session-sidebar').getBoundingClientRect().width;
    let width = clampSidebarWidth(startWidth);
    refs.sidebarResizer.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
    const onMove = (moveEvent) => {
      width = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      refs.appShell.style.setProperty('--session-sidebar-width', `${width}px`);
    };
    const onUp = async () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      refs.sidebarResizer.classList.remove('dragging');
      document.body.classList.remove('sidebar-resizing');
      try { state.preferences = await api.savePreferences({ sidebarWidth: width }); }
      catch (error) { toast(friendlyError(error), 'error'); }
      applySidebarWidth();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  refs.sidebarResizer.addEventListener('dblclick', async () => {
    try { state.preferences = await api.savePreferences({ sidebarWidth: null }); }
    catch (error) { toast(friendlyError(error), 'error'); }
    applySidebarWidth();
  });
}

function applyCurrentTheme() {
  const resolved = resolveTheme(state.preferences.theme, systemTheme.matches);
  applyTheme(document.documentElement, resolved);
  terminalView?.setTheme(resolved);
  const themeIcon = state.preferences.theme === 'system' ? 'laptop' : resolved === 'dark' ? 'moon' : 'sun';
  refs.themeButton.innerHTML = railButtonContent(themeIcon, t('theme.toggle'));
  refs.themeButton.title = t('theme.current', { mode: { light: t('theme.light'), dark: t('theme.dark'), system: t('theme.system') }[state.preferences.theme] });
  renderThemeControls();
}

async function setThemePreference(theme) {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  state.preferences.theme = theme;
  applyCurrentTheme();
  try { state.preferences = await api.savePreferences({ theme }); } catch (error) { toast(friendlyError(error), 'error'); }
}

function renderThemeControls() {
  if (!refs.themeCards) return;
  const modes = [
    { id: 'light', title: t('theme.light'), icon: 'sun' },
    { id: 'dark', title: t('theme.dark'), icon: 'moon' },
    { id: 'system', title: t('theme.system'), icon: 'laptop' },
  ];
  refs.themeCards.replaceChildren(...modes.map((mode) => {
    const button = document.createElement('button');
    button.className = `theme-card ${state.preferences.theme === mode.id ? 'active' : ''}`;
    button.dataset.theme = mode.id;
    const preview = document.createElement('div');
    preview.className = `theme-preview ${mode.id}`;
    const title = document.createElement('strong');
    title.textContent = mode.title;
    button.append(preview, title);
    button.addEventListener('click', () => setThemePreference(mode.id));
    return button;
  }));

  refs.themePopover.replaceChildren(...modes.map((mode) => menuButton({
    iconName: mode.icon,
    title: mode.title,
    checked: state.preferences.theme === mode.id,
    action: () => { setThemePreference(mode.id); closeFloatingMenus(); },
  })));
}

// Manual language override (defaults to following the system language). Kept
// separate from theme prefs: it's persisted client-side in localStorage
// rather than through the preferences store, since it only affects this
// renderer's own display language.
function renderLanguageControls() {
  if (!refs.languageCards) return;
  const modes = [
    { id: 'system', title: t('settings.languageSystem') },
    { id: 'zh', title: t('settings.languageZh') },
    { id: 'en', title: t('settings.languageEn') },
  ];
  const current = loadStoredLanguage();
  refs.languageCards.replaceChildren(...modes.map((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `theme-card ${current === mode.id ? 'active' : ''}`;
    button.dataset.language = mode.id;
    const title = document.createElement('strong');
    title.textContent = mode.title;
    button.append(title);
    button.addEventListener('click', () => setLanguagePreference(mode.id));
    return button;
  }));
}

function setLanguagePreference(language) {
  const stored = saveLanguage(language);
  setLocale(resolveLocale(stored));
  relocalize();
}

async function setKeepAwakePreference(enabled) {
  const previous = state.preferences.keepAwake === true;
  refs.keepAwakeToggle.disabled = true;
  try {
    state.preferences = await api.savePreferences({ keepAwake: enabled });
  } catch (error) {
    refs.keepAwakeToggle.checked = previous;
    toast(friendlyError(error), 'error');
  } finally {
    refs.keepAwakeToggle.disabled = false;
  }
}

async function setAutoSharePreference(enabled) {
  const previous = state.preferences.autoShare === true;
  refs.autoShareToggle.disabled = true;
  try {
    state.preferences = await api.savePreferences({ autoShare: enabled });
  } catch (error) {
    refs.autoShareToggle.checked = previous;
    toast(friendlyError(error), 'error');
    refs.autoShareToggle.disabled = false;
    return;
  }
  // Best-effort immediate start so flipping the switch does something visible;
  // the persisted preference is what actually re-opens sharing on the next launch.
  if (enabled) {
    try { await api.webStart(); } catch (error) { toast(friendlyError(error), 'error'); }
  }
  refs.autoShareToggle.disabled = false;
}

async function saveTmuxSettings(next, input) {
  const previous = state.preferences.tmuxSettings;
  const controls = [
    ...refs.tmuxSettingsGroups.querySelectorAll('input, select, button'),
    refs.tmuxAdvancedConfig,
    refs.tmuxAdvancedApplyButton,
    refs.tmuxResetButton,
  ].filter(Boolean);
  for (const control of controls) control.disabled = true;
  try {
    state.preferences = await api.savePreferences({
      tmuxSettings: next,
    });
    renderTmuxSettings();
    toast(t('toast.tmuxApplied'));
  } catch (error) {
    state.preferences = { ...state.preferences, tmuxSettings: previous };
    renderTmuxSettings();
    toast(friendlyError(error), 'error');
  } finally {
    if (input?.isConnected) input.disabled = false;
    for (const control of controls) {
      if (control.isConnected) control.disabled = false;
    }
  }
}

const TMUX_SETTING_GROUPS = ['interaction', 'scrollback', 'appearance', 'windows'];

function tmuxSettingOptionLabel(field, value) {
  if (field.key === 'modeKeys') return t(`settings.tmuxOption.modeKeys.${value}`);
  if (field.key === 'prefix') return value;
  if (field.key === 'statusPosition') return t(`settings.tmuxOption.statusPosition.${value}`);
  if (field.key === 'baseIndex' || field.key === 'paneBaseIndex') return String(value);
  return String(value);
}

function createTmuxSettingControl(field) {
  const value = state.preferences.tmuxSettings?.[field.key] ?? DEFAULT_TMUX_SETTINGS[field.key];
  const row = document.createElement(field.type === 'boolean' ? 'label' : 'div');
  row.className = field.type === 'boolean' ? 'settings-toggle-row' : 'settings-value-row';
  const copy = document.createElement('span');
  copy.className = 'settings-toggle-copy';
  const title = document.createElement('strong');
  title.textContent = t(`settings.tmuxField.${field.key}`);
  const description = document.createElement('span');
  description.textContent = t(`settings.tmuxField.${field.key}Description`);
  copy.append(title, description);
  const input = document.createElement(field.type === 'boolean' ? 'input' : 'select');
  input.dataset.tmuxKey = field.key;
  input.setAttribute('aria-label', title.textContent);
  if (field.type === 'boolean') {
    input.type = 'checkbox';
    input.className = 'settings-switch';
    input.setAttribute('role', 'switch');
    input.checked = value === true;
  } else if (field.type === 'number') {
    const number = document.createElement('input');
    number.type = 'number';
    number.className = 'settings-number';
    number.dataset.tmuxKey = field.key;
    number.setAttribute('aria-label', title.textContent);
    number.min = String(field.min);
    number.max = String(field.max);
    number.step = String(field.step);
    number.value = String(value);
    row.append(copy, number);
    number.addEventListener('change', () => {
      const nextValue = Number(number.value);
      saveTmuxSettings({ ...state.preferences.tmuxSettings, [field.key]: nextValue }, number);
    });
    return row;
  } else {
    input.className = 'settings-select';
    for (const optionValue of field.values) {
      const option = document.createElement('option');
      option.value = String(optionValue);
      option.textContent = tmuxSettingOptionLabel(field, optionValue);
      option.selected = optionValue === value;
      input.append(option);
    }
  }
  row.append(copy, input);
  input.addEventListener('change', () => {
    const nextValue = field.type === 'boolean'
      ? input.checked
      : field.type === 'select-number' ? Number(input.value) : input.value;
    saveTmuxSettings({ ...state.preferences.tmuxSettings, [field.key]: nextValue }, input);
  });
  return row;
}

// ---------------------------------------------------------------------------
// Terminal typography. Font family/size/line height/tracking were hard-coded in
// terminal-view.js; they now live in preferences and apply to the live view.
// ---------------------------------------------------------------------------

const TERMINAL_APPEARANCE_INPUTS = [
  { key: 'fontFamily', ref: 'terminalFontFamilyInput', kind: 'text' },
  { key: 'fontSize', ref: 'terminalFontSizeInput', kind: 'number' },
  { key: 'lineHeight', ref: 'terminalLineHeightInput', kind: 'number' },
  { key: 'letterSpacing', ref: 'terminalLetterSpacingInput', kind: 'number' },
];

function currentTerminalAppearance() {
  return normalizeTerminalAppearance(state.preferences.terminalAppearance || DEFAULT_TERMINAL_APPEARANCE);
}

function renderTerminalAppearanceSettings() {
  const appearance = currentTerminalAppearance();
  for (const { key, ref } of TERMINAL_APPEARANCE_INPUTS) {
    const input = refs[ref];
    if (input) input.value = String(appearance[key]);
  }
}

// Applied to the live terminal first, saved second: typing a size and watching
// the grid change is the whole point, and a rejected write just re-renders the
// inputs from the stored value.
function applyTerminalAppearance() {
  terminalView?.setAppearance(currentTerminalAppearance());
}

async function saveTerminalAppearance(patch, input) {
  const previous = state.preferences.terminalAppearance;
  const next = normalizeTerminalAppearance({ ...currentTerminalAppearance(), ...patch });
  state.preferences = { ...state.preferences, terminalAppearance: next };
  applyTerminalAppearance();
  if (input) input.disabled = true;
  try {
    state.preferences = await api.savePreferences({ terminalAppearance: next });
  } catch (error) {
    state.preferences = { ...state.preferences, terminalAppearance: previous };
    applyTerminalAppearance();
    toast(friendlyError(error), 'error');
  } finally {
    if (input?.isConnected) input.disabled = false;
    // Always re-read from state: normalization clamps and rounds, so what the
    // user typed is not necessarily what got stored.
    renderTerminalAppearanceSettings();
  }
}

function bindTerminalAppearanceInputs() {
  for (const { key, ref, kind } of TERMINAL_APPEARANCE_INPUTS) {
    const input = refs[ref];
    if (!input) continue;
    input.addEventListener('change', () => {
      saveTerminalAppearance({ [key]: kind === 'number' ? Number(input.value) : input.value }, input);
    });
  }
  refs.terminalFontResetButton?.addEventListener('click', () => {
    saveTerminalAppearance({ ...DEFAULT_TERMINAL_APPEARANCE }, refs.terminalFontResetButton);
  });
}

// ---------------------------------------------------------------------------
// Paste protection. Everything that reaches the pty as a paste funnels through
// TerminalView.paste(); this side owns the preference and the confirm dialog.
// ---------------------------------------------------------------------------

function currentPasteGuard() {
  return normalizePasteGuard(state.preferences.pasteProtection || DEFAULT_PASTE_GUARD);
}

function renderPasteGuardSettings() {
  const guard = currentPasteGuard();
  if (refs.pasteConfirmMultilineToggle) refs.pasteConfirmMultilineToggle.checked = guard.confirmMultiline;
  if (refs.pasteConfirmCharsInput) refs.pasteConfirmCharsInput.value = String(guard.confirmChars);
  if (refs.pasteSlowToggle) refs.pasteSlowToggle.checked = guard.slow;
}

function applyPasteGuard() {
  terminalView?.setPasteGuard(currentPasteGuard());
}

async function savePasteGuard(patch, input) {
  const previous = state.preferences.pasteProtection;
  const next = normalizePasteGuard({ ...currentPasteGuard(), ...patch });
  state.preferences = { ...state.preferences, pasteProtection: next };
  applyPasteGuard();
  if (input) input.disabled = true;
  try {
    state.preferences = await api.savePreferences({ pasteProtection: next });
  } catch (error) {
    state.preferences = { ...state.preferences, pasteProtection: previous };
    applyPasteGuard();
    toast(friendlyError(error), 'error');
  } finally {
    if (input?.isConnected) input.disabled = false;
    renderPasteGuardSettings();
  }
}

function bindPasteGuardInputs() {
  refs.pasteConfirmMultilineToggle?.addEventListener('change', () => {
    savePasteGuard({ confirmMultiline: refs.pasteConfirmMultilineToggle.checked }, refs.pasteConfirmMultilineToggle);
  });
  refs.pasteSlowToggle?.addEventListener('change', () => {
    savePasteGuard({ slow: refs.pasteSlowToggle.checked }, refs.pasteSlowToggle);
  });
  refs.pasteConfirmCharsInput?.addEventListener('change', () => {
    savePasteGuard({ confirmChars: Number(refs.pasteConfirmCharsInput.value) }, refs.pasteConfirmCharsInput);
  });
}

// Shows what is about to be pasted and resolves to the user's answer. The
// preview is the point: "12 lines" tells you nothing, the first lines of a
// script you did not mean to copy tell you everything.
const PASTE_PREVIEW_LINES = 8;
const PASTE_PREVIEW_CHARS = 600;
let resolvePasteConfirm = null;

function confirmPaste({ text, lines, chars, reason }) {
  // A dialog is already up (a second paste raced in) — answer no rather than
  // stranding the first promise.
  if (resolvePasteConfirm) return Promise.resolve(false);
  refs.pasteConfirmMessage.textContent = reason === 'size'
    ? t('paste.confirmSize', { chars })
    : t('paste.confirmMultiline', { lines });
  const preview = text.split(/\r\n|\r|\n/).slice(0, PASTE_PREVIEW_LINES).join('\n').slice(0, PASTE_PREVIEW_CHARS);
  refs.pasteConfirmPreview.textContent = preview === text ? preview : `${preview}\n…`;
  openModal(refs.pasteConfirmModal, refs.confirmPasteButton);
  return new Promise((resolve) => {
    resolvePasteConfirm = resolve;
  });
}

// Idempotent, and deliberately does NOT call closeModal(): closeModal routes
// dismissals back here, so the two would recurse.
function settlePasteConfirm(approved) {
  const resolve = resolvePasteConfirm;
  resolvePasteConfirm = null;
  refs.pasteConfirmModal?.classList.add('hidden');
  if (approved) terminalView?.focus();
  resolve?.(approved === true);
}

function renderTmuxSettings() {
  if (!refs.tmuxSettingsGroups) return;
  refs.tmuxSettingsGroups.replaceChildren();
  for (const groupName of TMUX_SETTING_GROUPS) {
    const group = document.createElement('section');
    group.className = 'tmux-settings-group';
    const heading = document.createElement('h4');
    heading.textContent = t(`settings.tmuxGroup.${groupName}`);
    group.append(heading);
    for (const field of TMUX_SETTING_FIELDS.filter((item) => item.group === groupName)) {
      group.append(createTmuxSettingControl(field));
    }
    refs.tmuxSettingsGroups.append(group);
  }
  refs.tmuxAdvancedConfig.value = state.preferences.tmuxSettings?.advancedConfig || '';
  refs.tmuxAdvancedError.textContent = '';
}

async function applyAdvancedTmuxSettings() {
  const advancedConfig = refs.tmuxAdvancedConfig.value;
  refs.tmuxAdvancedError.textContent = '';
  try {
    parseAdvancedConfig(advancedConfig);
    await saveTmuxSettings({ ...state.preferences.tmuxSettings, advancedConfig }, refs.tmuxAdvancedApplyButton);
  } catch (error) {
    refs.tmuxAdvancedError.textContent = getLocale() === 'zh'
      ? `${t('settings.tmuxAdvancedInvalid')} ${friendlyError(error)}`
      : t('settings.tmuxAdvancedInvalid');
  }
}

async function resetTmuxSettings() {
  await saveTmuxSettings({ ...DEFAULT_TMUX_SETTINGS }, refs.tmuxResetButton);
}

// Re-applies every translated string after a manual language switch, without
// requiring an app restart: static markup via applyStaticI18n, plus every
// render path that bakes t() output into dynamically-created DOM.
// ---------------------------------------------------------------------------
// Session snapshot health. The main process owns the snapshot (session-snapshot.js)
// and pushes a health object here; this section renders the "!" button in the
// workspace header, the detail panel behind it, and the settings switches.
// ---------------------------------------------------------------------------

function formatSnapshotTime(value) {
  if (!value) return t('snapshot.never');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

// The button is an alarm, not a status light: it only appears when something
// actually needs the user. Purely informational states live in the panel.
function renderSnapshotHealth() {
  const button = refs.snapshotHealthButton;
  if (!button) return;
  const health = state.snapshot;
  const level = health?.level || 'ok';
  const count = health?.issues?.length || 0;
  const alarming = level === 'error' || level === 'warn';
  button.classList.toggle('hidden', !alarming);
  button.dataset.level = level;
  const summary = level === 'error'
    ? t('snapshot.statusError', { count })
    : (level === 'warn' ? t('snapshot.statusWarn', { count }) : t('snapshot.statusOk'));
  button.title = summary;
  button.setAttribute('aria-label', `${t('snapshot.buttonAria')} · ${summary}`);
}

function snapshotSummaryRow(label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

const SNAPSHOT_ACTIONS = {
  save: () => runSnapshotSave(),
  restore: () => runSnapshotRestore(),
  repair: () => runSnapshotRepair(),
  reveal: () => runSnapshotReveal(),
  enable: () => saveSnapshotSettings({ enabled: true }),
};

function renderSnapshotPanel() {
  const health = state.snapshot;
  if (!refs.snapshotSummary) return;
  const summary = document.createElement('dl');
  if (health) {
    summary.append(
      snapshotSummaryRow(t('snapshot.lastSave'), formatSnapshotTime(health.lastSaveAt)),
      snapshotSummaryRow(t('snapshot.sessionsInSnapshot'), String(health.snapshotSessionCount ?? 0)),
      snapshotSummaryRow(t('snapshot.sessionsLive'), health.liveSessionCount == null ? '—' : String(health.liveSessionCount)),
      snapshotSummaryRow(
        t('snapshot.lastStartupRestore'),
        health.restore && health.restore.restored.length
          ? t('snapshot.restoredCount', { count: health.restore.restored.length })
          : t('snapshot.restoredNone'),
      ),
    );
  }
  refs.snapshotSummary.replaceChildren(summary);

  const issues = document.createElement('div');
  if (!health || !health.issues.length) {
    const ok = document.createElement('p');
    ok.className = 'snapshot-ok';
    ok.textContent = t('snapshot.noIssues');
    issues.append(ok);
  }
  for (const issue of health?.issues || []) {
    const card = document.createElement('div');
    card.className = `snapshot-issue level-${issue.level}`;
    const title = document.createElement('h4');
    title.textContent = t(`snapshot.issue.${issueKey(issue.id)}`, { count: issue.count ?? 0 });
    const hint = document.createElement('p');
    hint.className = 'snapshot-issue-hint';
    hint.textContent = t(`snapshot.issue.${issueKey(issue.id)}Hint`);
    card.append(title, hint);
    if (issue.detail) {
      const detail = document.createElement('pre');
      detail.className = 'snapshot-issue-detail';
      detail.textContent = issue.detail;
      card.append(detail);
    }
    const actions = (issue.actions || []).filter((action) => SNAPSHOT_ACTIONS[action]);
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'snapshot-issue-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button';
        button.textContent = t(`snapshot.action.${action}`);
        button.addEventListener('click', () => SNAPSHOT_ACTIONS[action]());
        row.append(button);
      }
      card.append(row);
    }
    issues.append(card);
  }
  refs.snapshotIssues.replaceChildren(issues);

  refs.snapshotPaths.replaceChildren(
    snapshotPathRow(t('snapshot.pathSnapshot'), health?.snapshotPath),
    snapshotPathRow(t('snapshot.pathLog'), health?.logPath),
  );
}

// health.issues carries ids like 'restore-failed'; the message keys are camel.
function issueKey(id) {
  return String(id).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function snapshotPathRow(label, value) {
  const row = document.createElement('div');
  row.className = 'snapshot-path';
  const name = document.createElement('span');
  name.className = 'snapshot-path-label';
  name.textContent = label;
  const path = document.createElement('code');
  path.textContent = value || '—';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'button';
  copy.textContent = t('snapshot.copyPath');
  copy.disabled = !value;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast(t('snapshot.pathCopied'));
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
  });
  row.append(name, path, copy);
  return row;
}

function applySnapshotHealth(health) {
  state.snapshot = health || null;
  renderSnapshotHealth();
  if (refs.snapshotModal && !refs.snapshotModal.classList.contains('hidden')) renderSnapshotPanel();
  renderSnapshotSettings();
}

async function refreshSnapshotHealth() {
  if (!api?.snapshotStatus) return;
  try {
    applySnapshotHealth(await api.snapshotStatus());
  } catch {
    // A missing snapshot service is not worth a toast; the panel stays empty.
  }
}

function openSnapshotPanel() {
  renderSnapshotPanel();
  openModal(refs.snapshotModal, refs.snapshotSaveButton);
  refreshSnapshotHealth();
}

function withSnapshotButtonsDisabled(run) {
  const buttons = [refs.snapshotSaveButton, refs.snapshotRestoreButton, refs.snapshotRevealButton]
    .filter(Boolean);
  for (const button of buttons) button.disabled = true;
  return run().finally(() => {
    for (const button of buttons) { if (button.isConnected) button.disabled = false; }
  });
}

function runSnapshotSave() {
  return withSnapshotButtonsDisabled(async () => {
    try {
      const health = await api.snapshotSave();
      applySnapshotHealth(health);
      toast(t('toast.snapshotSaved', { count: health.snapshotSessionCount ?? 0 }));
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
  });
}

function runSnapshotRestore() {
  return withSnapshotButtonsDisabled(async () => {
    try {
      const { report, status } = await api.snapshotRestore();
      applySnapshotHealth(status);
      if (report.restored.length) toast(t('toast.snapshotRestored', { count: report.restored.length }));
      else toast(t('toast.snapshotNothingToRestore'));
      await refreshSessions({ notify: false });
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
  });
}

function runSnapshotRepair() {
  return withSnapshotButtonsDisabled(async () => {
    try {
      const result = await api.snapshotRepairCwd();
      applySnapshotHealth(result.status);
      toast(t('toast.snapshotRepaired', { count: result.repaired }));
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
  });
}

async function runSnapshotReveal() {
  try {
    await api.snapshotReveal();
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

function renderSnapshotSettings() {
  if (!refs.snapshotEnabledToggle) return;
  const settings = state.preferences.sessionRestore || {};
  refs.snapshotEnabledToggle.checked = settings.enabled !== false;
  refs.snapshotAutoRestoreToggle.checked = settings.autoRestore !== false;
  refs.snapshotRepairToggle.checked = settings.repairCwd !== false;
  refs.snapshotIntervalInput.value = String(settings.intervalMinutes || 3);
  const health = state.snapshot;
  refs.snapshotSettingsStatus.textContent = health
    ? `${t('snapshot.lastSave')}：${formatSnapshotTime(health.lastSaveAt)} · ${t('snapshot.sessionsInSnapshot')} ${health.snapshotSessionCount ?? 0}`
    : '';
}

async function saveSnapshotSettings(patch) {
  const previous = state.preferences.sessionRestore;
  const controls = [
    refs.snapshotEnabledToggle, refs.snapshotAutoRestoreToggle,
    refs.snapshotRepairToggle, refs.snapshotIntervalInput,
  ].filter(Boolean);
  for (const control of controls) control.disabled = true;
  try {
    state.preferences = await api.savePreferences({ sessionRestore: { ...previous, ...patch } });
  } catch (error) {
    toast(friendlyError(error), 'error');
  } finally {
    for (const control of controls) { if (control.isConnected) control.disabled = false; }
  }
  renderSnapshotSettings();
  refreshSnapshotHealth();
}

function relocalize() {
  installIcons();
  renderSnapshotHealth();
  renderSnapshotSettings();
  applyStaticI18n();
  applyCurrentTheme();
  renderTmuxSettings();
  renderLanguageControls();
  renderSystemStatus();
  renderTagRail();
  renderTagSettings();
  renderSessionList();
  renderSessionTabs();
  renderWorkspace();
  renderDetail();
  if (refs.commandPalette && !refs.commandPalette.classList.contains('hidden')) renderCommandResults();
  if (refs.mobileAccessModal && !refs.mobileAccessModal.classList.contains('hidden')) {
    syncMobileAccessHeading();
    loadMobileAccessStatus();
  }
  // Keep the native application menu (main process) in the same language.
  if (api && api.setAppLocale) api.setAppLocale(getLocale());
}

function renderTagSettings() {
  refs.tagSettingsList.replaceChildren();
  if (!state.preferences.tags.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-settings-empty';
    empty.textContent = t('tag.none');
    refs.tagSettingsList.append(empty);
    return;
  }
  for (const tag of state.preferences.tags) {
    const row = document.createElement('div');
    row.className = 'tag-settings-row';
    const dot = document.createElement('span');
    dot.className = 'tag-settings-dot';
    dot.style.setProperty('--tag-color', tagColor(tag));
    const name = document.createElement('span');
    name.className = 'tag-settings-name';
    name.textContent = tag.name;
    const count = document.createElement('span');
    count.className = 'tag-settings-count';
    count.textContent = t('tag.sessionCount', { count: tagSessionCount(tag.id) });
    const actions = document.createElement('span');
    actions.className = 'tag-settings-actions';
    const rename = document.createElement('button');
    rename.className = 'icon-button';
    rename.type = 'button';
    rename.setAttribute('aria-label', t('tag.renameAria', { name: tag.name }));
    rename.title = t('action.rename');
    rename.innerHTML = icon('edit', 14);
    rename.addEventListener('click', () => openTagEditor(tag));
    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.type = 'button';
    remove.setAttribute('aria-label', t('tag.deleteAria', { name: tag.name }));
    remove.title = t('action.delete');
    remove.innerHTML = icon('trash', 14);
    remove.addEventListener('click', () => openTagDeleteModal(tag));
    actions.append(rename, remove);
    row.append(dot, name, count, actions);
    refs.tagSettingsList.append(row);
  }
}

function renderSystemStatus() {
  const installed = state.systemStatus.installed;
  refs.tmuxStatusDot.className = `status-dot ${installed ? 'ok' : 'error'}`;
  refs.tmuxStatusText.textContent = installed ? state.systemStatus.version || t('status.tmuxReady') : t('status.tmuxNotFound');
  refs.settingsTmuxVersion.textContent = installed
    ? `${state.systemStatus.version || t('status.installed')} · ${state.systemStatus.path}`
    : t('status.notInstalled');
}

function sessionMeta(session) {
  const counts = t('session.metaTemplate', { windows: session.windows || 0, panes: session.paneCount || 0 });
  return session.activeCommand ? `${counts} · ${session.activeCommand}` : counts;
}

function tagRailPositions() {
  return new Map([...refs.tagRail.querySelectorAll('[data-tag-id]')].map((button) => (
    [button.dataset.tagId, button.getBoundingClientRect().top]
  )));
}

function animateTagRail(previousPositions) {
  if (!previousPositions?.size || reducedMotion.matches) return;
  for (const button of refs.tagRail.querySelectorAll('[data-tag-id]')) {
    const previousTop = previousPositions.get(button.dataset.tagId);
    if (!Number.isFinite(previousTop) || typeof button.animate !== 'function') continue;
    const nextTop = button.getBoundingClientRect().top;
    const delta = previousTop - nextTop;
    if (Math.abs(delta) < 0.5) continue;
    button.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
  }
}

function sameTagList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((tag, index) => tag.id === right[index].id
      && tag.name === right[index].name && tag.color === right[index].color);
}

function tagRailMatchesTags(tags) {
  const buttons = [...refs.tagRail.querySelectorAll('[data-tag-id]')];
  return buttons.length === tags.length && buttons.every((button, index) => {
    const name = button.querySelector('.tag-name')?.textContent;
    return button.dataset.tagId === tags[index].id && name === tags[index].name;
  });
}

// Pinned tags sit above the recency-ordered rest, in their own manual order.
// This mirrors normalizeTags on the store side so optimistic client updates and
// the persisted result agree.
function orderTags(tags) {
  const pinned = tags.filter((tag) => tag.pinned);
  const rest = tags.filter((tag) => !tag.pinned);
  return pinned.length ? [...pinned, ...rest] : tags;
}

// Promote a used tag to the top of the unpinned region (pinned tags never move).
function withTagPromoted(tags, tagId) {
  const tag = tags.find((item) => item.id === tagId);
  if (!tag || tag.pinned) return tags;
  const pinned = tags.filter((item) => item.pinned);
  const rest = tags.filter((item) => !item.pinned && item.id !== tagId);
  return [...pinned, tag, ...rest];
}

function tagOrderEqual(left, right) {
  return left.length === right.length && left.every((tag, index) => tag.id === right[index].id);
}

function firstUnpinnedTag() {
  return state.preferences.tags.find((tag) => !tag.pinned) || null;
}

async function reloadTagPreferences() {
  try {
    const preferences = await api.getPreferences();
    state.preferences = { ...state.preferences, tags: preferences.tags };
    renderTagRail();
    renderTagSettings();
  } catch { /* leave the optimistic view; the next refresh reconciles */ }
}

async function setTagPinned(tag, pinned) {
  const previousPositions = tagRailPositions();
  const updated = state.preferences.tags.map((item) => {
    if (item.id !== tag.id) return item;
    const next = { ...item };
    if (pinned) next.pinned = true;
    else delete next.pinned;
    return next;
  });
  state.preferences = { ...state.preferences, tags: orderTags(updated) };
  renderTagRail(previousPositions);
  renderTagSettings();
  try {
    const preferences = await api.setTagPinned({ id: tag.id, pinned });
    state.preferences = { ...state.preferences, tags: preferences.tags };
    renderTagRail();
    renderTagSettings();
  } catch (error) {
    toast(friendlyError(error), 'error');
    await reloadTagPreferences();
  }
}

let pinnedDragId = null;

function clearPinnedDropMarkers() {
  for (const button of refs.tagRail.querySelectorAll('.drop-before, .drop-after')) {
    button.classList.remove('drop-before', 'drop-after');
  }
}

function handlePinnedDragStart(event, tag) {
  pinnedDragId = tag.id;
  event.dataTransfer.effectAllowed = 'move';
  try { event.dataTransfer.setData('text/plain', tag.id); } catch { /* some engines disallow */ }
}

function handlePinnedDragOver(event, tag) {
  if (!pinnedDragId || !tag.pinned) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const rect = event.currentTarget.getBoundingClientRect();
  const before = (event.clientY - rect.top) < rect.height / 2;
  clearPinnedDropMarkers();
  if (tag.id !== pinnedDragId) event.currentTarget.classList.add(before ? 'drop-before' : 'drop-after');
}

async function handlePinnedDrop(event, tag) {
  if (!pinnedDragId || !tag.pinned) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  const before = (event.clientY - rect.top) < rect.height / 2;
  const dragId = pinnedDragId;
  pinnedDragId = null;
  clearPinnedDropMarkers();
  await reorderPinnedByDrop(dragId, tag.id, before);
}

async function reorderPinnedByDrop(dragId, targetId, before) {
  const tags = state.preferences.tags;
  const pinnedIds = tags.filter((tag) => tag.pinned).map((tag) => tag.id);
  if (dragId === targetId || !pinnedIds.includes(dragId) || !pinnedIds.includes(targetId)) return;
  const without = pinnedIds.filter((id) => id !== dragId);
  let index = without.indexOf(targetId);
  if (index < 0) return;
  if (!before) index += 1;
  without.splice(index, 0, dragId);
  if (without.length === pinnedIds.length && without.every((id, i) => id === pinnedIds[i])) return;

  const previousPositions = tagRailPositions();
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const rest = tags.filter((tag) => !tag.pinned);
  state.preferences = { ...state.preferences, tags: [...without.map((id) => byId.get(id)), ...rest] };
  renderTagRail(previousPositions);
  renderTagSettings();
  try {
    const preferences = await api.reorderPinnedTags(without);
    state.preferences = { ...state.preferences, tags: preferences.tags };
  } catch (error) {
    toast(friendlyError(error), 'error');
    await reloadTagPreferences();
  }
}

function renderTagRail(previousPositions = null) {
  refs.tagRail.replaceChildren();
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.view.kind);
  });
  const remote = isRemoteActive();
  for (const tag of viewPrefs().tags) {
    const count = tagSessionCount(tag.id);
    const button = document.createElement('button');
    button.className = `rail-button tag-rail-button ${state.view.kind === 'tag' && state.view.tagId === tag.id ? 'active' : ''}`;
    button.dataset.tagId = tag.id;
    button.setAttribute('aria-label', t('tag.railItemAria', { name: tag.name, count }));
    button.title = t('tag.railItemTitle', { name: tag.name, count });
    button.style.setProperty('--tag-color', tagColor(tag));
    const initial = document.createElement('span');
    initial.className = 'tag-initial';
    initial.textContent = Array.from(tag.name)[0].toLocaleUpperCase();
    const name = document.createElement('span');
    name.className = 'tag-name';
    name.textContent = tag.name;
    button.append(initial, name);
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'tag-count';
      badge.textContent = count > 99 ? '99+' : String(count);
      button.append(badge);
    }
    if (tag.pinned) {
      button.classList.add('pinned');
      const pin = document.createElement('span');
      pin.className = 'tag-pin';
      pin.innerHTML = icon('star', 11);
      button.append(pin);
    }
    // Reordering pinned tags writes this machine's preferences; a remote host's
    // tags are shown, not managed.
    if (tag.pinned && !remote) {
      button.draggable = true;
      // Show the grab cursor only after a short press-and-hold, so a normal
      // click to open the tag doesn't feel draggable; a plain hover stays a
      // pointer. Native drag still works regardless of the timer.
      let holdTimer = null;
      const clearHold = () => { clearTimeout(holdTimer); button.classList.remove('grabbable'); };
      button.addEventListener('mousedown', () => {
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => button.classList.add('grabbable'), 250);
      });
      button.addEventListener('mouseup', clearHold);
      button.addEventListener('mouseleave', clearHold);
      button.addEventListener('dragstart', (event) => { button.classList.add('dragging'); handlePinnedDragStart(event, tag); });
      button.addEventListener('dragover', (event) => handlePinnedDragOver(event, tag));
      button.addEventListener('drop', (event) => handlePinnedDrop(event, tag));
      button.addEventListener('dragend', () => { pinnedDragId = null; clearPinnedDropMarkers(); clearHold(); button.classList.remove('dragging'); });
    }
    button.addEventListener('click', () => activateTag(tag));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openTagMenu(tag, event.clientX, event.clientY);
    });
    refs.tagRail.append(button);
  }
  animateTagRail(previousPositions);
}

async function activateTag(tag) {
  const token = ++tagActivationToken;
  // The recency promotion below persists to this machine's tag list; a remote
  // host's tags only switch the view.
  if (isRemoteActive()) {
    await setView({ kind: 'tag', tagId: tag.id });
    return;
  }
  const promoted = withTagPromoted(state.preferences.tags, tag.id);
  const reordered = !tagOrderEqual(promoted, state.preferences.tags);
  const previousPositions = reordered ? tagRailPositions() : null;
  if (reordered) {
    state.preferences = { ...state.preferences, tags: promoted };
    renderTagSettings();
  }
  const touchResult = api.touchTag(tag.id).then(
    (preferences) => ({ tags: preferences.tags }),
    (error) => ({ error }),
  );
  await setView({ kind: 'tag', tagId: tag.id }, { tagRailPreviousPositions: previousPositions });
  const result = await touchResult;
  if (token !== tagActivationToken) return;
  if (!result.error) {
    const needsRender = !tagRailMatchesTags(result.tags);
    state.preferences = { ...state.preferences, tags: result.tags };
    if (needsRender) renderTagRail();
    renderTagSettings();
    return;
  }
  try {
    const preferences = await api.getPreferences();
    if (token !== tagActivationToken) return;
    state.preferences = { ...state.preferences, tags: preferences.tags };
  } catch {}
  renderTagRail();
  renderTagSettings();
  toast(friendlyError(result.error), 'error');
}

function renderSessionList() {
  const groups = filterAndGroupSessions(
    state.sessions,
    viewPrefs().favorites,
    state.query,
    false,
  );
  refs.sessionList.replaceChildren();
  const addGroup = (title, sessions) => {
    if (!sessions.length) return;
    const group = document.createElement('section');
    group.className = 'session-group';
    const heading = document.createElement('div');
    heading.className = 'group-heading';
    const label = document.createElement('span');
    label.textContent = title;
    const count = document.createElement('span');
    count.textContent = String(sessions.length);
    heading.append(label, count);
    group.append(heading);
    for (const session of sessions) group.append(createSessionRow(session));
    refs.sessionList.append(group);
  };
  addGroup(t('rail.favorites'), groups.favorites);
  addGroup(t('rail.all'), groups.sessions);
  if (!groups.favorites.length && !groups.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    if (state.query) empty.textContent = t('session.noMatch');
    else if (isRemoteActive() && state.sourceStatus === 'connecting') empty.textContent = t('source.loadingSessions');
    else if (isRemoteActive() && state.sourceStatus === 'offline') empty.textContent = t('source.unreachableHint');
    else empty.textContent = t('session.none');
    refs.sessionList.append(empty);
  }
  const attached = state.sessions.filter((session) => session.attached).length;
  refs.sessionSummary.textContent = `${t('session.summary', { count: state.sessions.length })}${attached ? t('session.summaryAttached', { count: attached }) : ''}`;
}

function createSessionRow(session) {
  const item = document.createElement('div');
  item.className = `session-item ${session.id === state.selectedSessionId ? 'active' : ''}`;
  const main = document.createElement('button');
  main.className = 'session-main';
  main.title = session.path || session.name;
  const dot = document.createElement('span');
  dot.className = `session-state ${session.attached ? 'attached' : ''}`;
  const copy = document.createElement('span');
  copy.className = 'session-copy';
  const nameLine = document.createElement('span');
  nameLine.className = 'session-name-line';
  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = session.name;
  nameLine.append(name);
  if (viewPrefs().favorites.includes(session.name)) {
    const star = document.createElement('span');
    star.className = 'favorite-mark';
    star.innerHTML = icon('star', 11);
    nameLine.append(star);
  }
  const sessionTags = tagsForSession(session.name);
  if (sessionTags.length) {
    const marks = document.createElement('span');
    marks.className = 'session-tag-marks';
    marks.title = sessionTags.map((tag) => tag.name).join(t('tag.listSeparator'));
    for (const tag of sessionTags.slice(0, 4)) {
      const mark = document.createElement('span');
      mark.className = 'session-tag-mark';
      mark.style.setProperty('--tag-color', tagColor(tag));
      marks.append(mark);
    }
    nameLine.append(marks);
  }
  const meta = document.createElement('span');
  meta.className = 'session-meta';
  meta.textContent = sessionMeta(session);
  copy.append(nameLine, meta);
  main.append(dot, copy);
  main.addEventListener('click', () => selectSession(session));
  const more = document.createElement('button');
  more.className = 'icon-button session-more';
  more.setAttribute('aria-label', t('session.actionsAria', { name: session.name }));
  more.innerHTML = icon('more', 16);
  more.addEventListener('click', (event) => { event.stopPropagation(); openSessionMenu(session, more); });
  item.append(main, more);
  return item;
}

function renderWorkspace() {
  const session = selectedSession();
  const tag = currentTag();
  const compact = state.view.kind !== 'all';
  refs.workspaceViewBadge.classList.toggle('hidden', !compact);
  if (compact) {
    refs.workspaceViewBadge.textContent = compactViewLabel();
    refs.workspaceViewBadge.style.setProperty('--tag-color', tag ? tagColor(tag) : 'var(--warning)');
  }
  if (session) {
    refs.activeSessionName.textContent = session.name;
    refs.activeSessionPath.textContent = shortenPath(session.path) || t('session.localTmux');
    refs.attachedBadge.classList.toggle('hidden', !session.attached);
    refs.terminalSurface.classList.remove('hidden');
    refs.emptyState.classList.add('hidden');
    refs.sessionMenuButton.classList.remove('hidden');
    refs.workspaceStatus.textContent = t('workspace.statusLocal', { windows: session.windows || 0, panes: session.paneCount || 0 });
  } else {
    refs.activeSessionName.textContent = compact ? compactViewLabel() : 'Tmux Desk';
    refs.activeSessionPath.textContent = compact ? t('session.selectFromTabs') : t('session.selectLocal');
    refs.attachedBadge.classList.add('hidden');
    refs.terminalSurface.classList.add('hidden');
    refs.terminalReconnect.classList.add('hidden');
    refs.sessionMenuButton.classList.add('hidden');
    refs.panePickerWrap.classList.add('hidden');
    refs.emptyState.classList.remove('hidden');
    refs.emptyNewButton.classList.add('hidden');
    refs.emptyInstallButton.classList.add('hidden');
    refs.emptyRefreshButton.classList.add('hidden');
    refs.emptyAllButton.classList.add('hidden');
    if (!state.systemStatus.installed) {
      refs.emptyTitle.textContent = t('empty.installTitle');
      refs.emptyMessage.textContent = t('empty.installMessage');
      refs.emptyInstallButton.classList.remove('hidden');
      refs.emptyRefreshButton.classList.remove('hidden');
      refs.emptyRefreshButton.textContent = t('action.recheck');
    } else if (compact) {
      refs.emptyTitle.textContent = state.view.kind === 'favorites' ? t('empty.noFavorites') : t('empty.noTagSessions', { tag: compactViewLabel() });
      refs.emptyMessage.textContent = state.view.kind === 'favorites'
        ? t('empty.favoritesHint')
        : t('empty.tagHint');
      refs.emptyAllButton.classList.remove('hidden');
      if (state.view.kind === 'tag') refs.emptyNewButton.classList.remove('hidden');
      refs.workspaceStatus.textContent = t('workspace.statusEmptyTag', { label: compactViewLabel() });
    } else if (!state.sessions.length) {
      refs.emptyTitle.textContent = t('empty.noSessionsTitle');
      refs.emptyMessage.textContent = t('empty.noSessionsMessage');
      refs.emptyNewButton.classList.remove('hidden');
      refs.emptyRefreshButton.classList.remove('hidden');
      refs.emptyRefreshButton.textContent = t('action.refreshList');
    } else {
      refs.emptyTitle.textContent = t('empty.workspaceTitle');
      refs.emptyMessage.textContent = t('empty.workspaceMessage');
      refs.emptyNewButton.classList.remove('hidden');
      refs.emptyRefreshButton.classList.remove('hidden');
      refs.emptyRefreshButton.textContent = t('action.refreshList');
    }
  }
}

function renderSessionTabs() {
  refs.sessionTabs.replaceChildren();
  if (state.view.kind === 'all') return;
  for (const session of compactSessions()) {
    const button = document.createElement('button');
    const active = session.id === state.selectedSessionId;
    button.className = `session-tab ${active ? 'active' : ''}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(active));
    button.title = session.name;
    button.draggable = !isRemoteActive();
    const stateDot = document.createElement('span');
    stateDot.className = `session-tab-state ${session.attached ? 'attached' : ''}`;
    const name = document.createElement('span');
    name.className = 'session-tab-name';
    name.textContent = session.name;
    button.append(stateDot, name);
    button.addEventListener('click', () => selectSession(session));
    button.addEventListener('dragstart', (event) => handleTabDragStart(event, session));
    button.addEventListener('dragover', handleTabDragOver);
    button.addEventListener('dragleave', handleTabDragLeave);
    button.addEventListener('drop', (event) => handleTabDrop(event, session));
    button.addEventListener('dragend', clearTabDragState);
    refs.sessionTabs.append(button);
  }
}

function handleTabDragStart(event, session) {
  draggedTabName = session.name;
  event.dataTransfer.effectAllowed = 'move';
  try { event.dataTransfer.setData('text/plain', session.name); } catch { /* Safari needs no data set to drag */ }
}

function handleTabDragOver(event) {
  if (!draggedTabName) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const button = event.currentTarget;
  for (const other of refs.sessionTabs.querySelectorAll('.session-tab')) {
    if (other !== button) other.classList.remove('drop-before', 'drop-after');
  }
  const rect = button.getBoundingClientRect();
  const before = event.clientX < rect.left + rect.width / 2;
  button.classList.toggle('drop-before', before);
  button.classList.toggle('drop-after', !before);
}

function handleTabDragLeave(event) {
  event.currentTarget.classList.remove('drop-before', 'drop-after');
}

async function handleTabDrop(event, targetSession) {
  event.preventDefault();
  const button = event.currentTarget;
  const before = button.classList.contains('drop-before');
  const draggedName = draggedTabName;
  clearTabDragState();
  if (!draggedName || draggedName === targetSession.name) return;
  const names = compactSessions().map((session) => session.name);
  const fromIndex = names.indexOf(draggedName);
  if (fromIndex === -1) return;
  names.splice(fromIndex, 1);
  let targetIndex = names.indexOf(targetSession.name);
  if (targetIndex === -1) return;
  if (!before) targetIndex += 1;
  names.splice(targetIndex, 0, draggedName);
  await persistTabOrder(names);
}

function clearTabDragState() {
  draggedTabName = null;
  for (const button of refs.sessionTabs.querySelectorAll('.session-tab')) {
    button.classList.remove('drop-before', 'drop-after');
  }
}

// Writes the full manual order for the active view and re-renders — used by
// both drag-and-drop and the ⌘⇧←/→ keyboard reorder.
async function persistTabOrder(names) {
  const viewKey = currentViewKey();
  if (!viewKey) return;
  if (!requireLocal()) return;
  try {
    state.preferences = await api.savePreferences({
      tabOrders: { ...state.preferences.tabOrders, [viewKey]: names },
    });
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
  renderSessionTabs();
}

async function moveSelectedTab(direction) {
  const session = selectedSession();
  if (!session) return;
  const names = compactSessions().map((item) => item.name);
  const index = names.indexOf(session.name);
  if (index === -1) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= names.length) return;
  [names[index], names[targetIndex]] = [names[targetIndex], names[index]];
  await persistTabOrder(names);
}

async function selectAdjacentTab(direction) {
  const sessions = compactSessions();
  const index = sessions.findIndex((item) => item.id === state.selectedSessionId);
  if (index === -1) return;
  const target = sessions[index + direction];
  if (target) await selectSession(target);
}

// ⌘↑/↓ browses between tags in the rail order. Unlike clicking a tag
// (activateTag, which promotes the tag to the top of the unpinned region),
// this switches the view WITHOUT reordering the rail — so repeated ⌘↑/↓ never
// reshuffles non-pinned tags. setView jumps to the tag's first session, so the
// effect is "click that tag once" minus the recency promotion.
async function selectAdjacentTagView(direction) {
  const currentTagId = state.view.kind === 'tag' ? state.view.tagId : null;
  const targetId = adjacentTagId(viewPrefs().tags, currentTagId, direction);
  if (!targetId) return;
  await setView({ kind: 'tag', tagId: targetId });
}

function renderDetail() {
  const session = selectedSession();
  refs.panePicker.replaceChildren();
  if (!session) {
    refs.panePickerWrap.classList.add('hidden');
    return;
  }
  refs.panePicker.replaceChildren(...state.detail.panes.map((pane) => {
    const option = document.createElement('option');
    option.value = pane.id;
    option.selected = pane.active;
    option.textContent = `${pane.windowIndex + 1}.${pane.index + 1} · ${pane.command || 'shell'} · ${shortenPath(pane.path)}`;
    return option;
  }));
  refs.panePickerWrap.classList.toggle('hidden', state.detail.panes.length < 2);
  // Broadcast input has no on-screen trace inside the terminal, so the only
  // thing standing between the user and typing into four panes at once is this
  // badge. It doubles as the off switch.
  refs.broadcastFlag?.classList.toggle('hidden', !activeWindow()?.synchronized);
  renderPaneCloseButtons();
}

// Panes of the window currently shown in the terminal (the active window). Only
// these carry meaningful pane_left/top geometry for the visible grid.
function activeWindowPanes() {
  const panes = state.detail.panes || [];
  const activePane = panes.find((pane) => pane.active);
  const activeWindowId = activePane
    ? activePane.windowId
    : (state.detail.windows || []).find((win) => win.active)?.id;
  if (!activeWindowId) return [];
  return panes.filter((pane) => pane.windowId === activeWindowId);
}

// iTerm-style per-pane close (×) buttons overlaid on the terminal. They only
// appear once a window is split (>=2 panes); clicking one kills that pane, so
// closing every extra pane restores the window to its unsplit state. Positions
// are derived from tmux cell geometry mapped through the live grid metrics.
function renderPaneCloseButtons() {
  const layer = refs.paneCloseLayer;
  if (!layer) return;
  layer.replaceChildren();
  const panes = activeWindowPanes();
  if (!selectedSession() || panes.length < 2) return;
  const metrics = terminalView?.getGridMetrics?.();
  if (!metrics) return;
  const layerRect = layer.getBoundingClientRect();
  const MARGIN = 2;
  const SIZE = 16;
  for (const pane of panes) {
    if (![pane.left, pane.top, pane.width].every((value) => Number.isFinite(value))) continue;
    const right = metrics.left + (pane.left + pane.width) * metrics.cellWidth;
    const top = metrics.top + pane.top * metrics.cellHeight;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pane-close-button';
    button.innerHTML = icon('close', 10);
    button.title = t('pane.close');
    button.setAttribute('aria-label', t('pane.close'));
    button.style.left = `${Math.round(right - layerRect.left - SIZE - MARGIN)}px`;
    button.style.top = `${Math.round(top - layerRect.top + MARGIN)}px`;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closePane(pane.id);
    });
    layer.append(button);
  }
}

// The terminal grid resized: re-place the close buttons immediately against the
// new cell metrics (proportional layout keeps last-known cells close enough),
// then refetch geometry once tmux has settled its reflow, debounced.
let paneResizeTimer = null;
function onTerminalResize() {
  renderPaneCloseButtons();
  clearTimeout(paneResizeTimer);
  paneResizeTimer = setTimeout(() => {
    if (selectedSession() && activeWindowPanes().length >= 2) refreshDetail();
  }, 200);
}

// ---------------------------------------------------------------------------
// Global search (Cmd+F). A terminal emulator can only search what it is showing;
// tmux holds every pane's scrollback, so this asks tmux to grep ALL of them and
// then jumps straight to the hit — session, window, pane and row. That is why
// Cmd+F here is not iTerm's per-pane find bar.
let searchDebounceTimer = null;

function openGlobalSearch() {
  if (isRemoteActive()) { toast(t('search.localOnly')); return; }
  const selection = terminalView?.getSelection?.().trim() || '';
  if (selection && !selection.includes('\n') && selection.length <= 120) {
    refs.globalSearchInput.value = selection;
  }
  state.search.open = true;
  refs.globalSearch.classList.remove('hidden');
  refs.globalSearchInput.focus();
  refs.globalSearchInput.select();
  if (refs.globalSearchInput.value.trim()) runGlobalSearch();
  else renderSearchResults();
}

function closeGlobalSearch() {
  clearTimeout(searchDebounceTimer);
  state.search.open = false;
  state.search.token += 1; // in-flight answers are no longer wanted
  refs.globalSearch.classList.add('hidden');
  terminalView?.focus();
}

async function runGlobalSearch() {
  const query = refs.globalSearchInput.value.trim();
  const token = ++state.search.token;
  if (!query) {
    state.search.results = [];
    renderSearchResults();
    return;
  }
  refs.globalSearchStatus.textContent = t('search.searching');
  try {
    const found = await localApi.searchSessions({ query });
    if (token !== state.search.token) return; // a newer query already went out
    state.search.results = found.results || [];
    state.search.truncated = found.truncated === true;
    state.search.panes = found.panes || 0;
    state.search.index = 0;
    renderSearchResults();
  } catch (error) {
    if (token !== state.search.token) return;
    state.search.results = [];
    renderSearchResults();
    toast(friendlyError(error), 'error');
  }
}

// The matched line with the query highlighted — built as nodes, so terminal
// output never goes through innerHTML.
function searchLineFragment(result) {
  const line = document.createElement('span');
  line.className = 'search-result-line';
  const column = Number.isInteger(result.column) ? result.column : 0;
  const length = Number.isInteger(result.length) ? result.length : 0;
  const before = result.preview.slice(0, column);
  const hit = result.preview.slice(column, column + length);
  const after = result.preview.slice(column + length);
  if (before) line.append(document.createTextNode(before));
  if (hit) {
    const mark = document.createElement('mark');
    mark.textContent = hit;
    line.append(mark);
  }
  if (after) line.append(document.createTextNode(after));
  return line;
}

function renderSearchResults() {
  const { results, index } = state.search;
  refs.globalSearchResults.replaceChildren();
  const query = refs.globalSearchInput.value.trim();
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = query ? t('search.noMatch') : t('search.hint');
    refs.globalSearchResults.append(empty);
    refs.globalSearchStatus.textContent = '';
    return;
  }
  results.forEach((result, position) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `search-result ${position === index ? 'selected' : ''}`;
    button.setAttribute('role', 'option');
    const where = document.createElement('span');
    where.className = 'search-result-where';
    const session = document.createElement('b');
    session.textContent = result.sessionName;
    const rest = document.createElement('span');
    const windowLabel = result.windowName ? `${result.windowIndex}:${result.windowName}` : String(result.windowIndex);
    rest.textContent = `› ${windowLabel}${result.paneIndex ? ` · pane ${result.paneIndex}` : ''}`;
    where.append(session, rest);
    button.append(where, searchLineFragment(result));
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { state.search.index = position; revealSelectedSearchResult(); });
    refs.globalSearchResults.append(button);
  });
  refs.globalSearchResults.children[index]?.scrollIntoView({ block: 'nearest' });
  refs.globalSearchStatus.textContent = t(state.search.truncated ? 'search.countCapped' : 'search.count', {
    count: results.length,
    panes: state.search.panes,
  });
}

function moveSearchSelection(delta) {
  const { results } = state.search;
  if (!results.length) return;
  state.search.index = Math.min(results.length - 1, Math.max(0, state.search.index + delta));
  renderSearchResults();
}

// Attach the hit's session, then let tmux focus its window/pane and park
// copy-mode on the row. The view is told it is in copy-mode so the next
// keystroke cancels it instead of being eaten as a copy-mode command.
async function revealSelectedSearchResult() {
  const result = state.search.results[state.search.index];
  if (!result) return;
  const query = refs.globalSearchInput.value.trim();
  closeGlobalSearch();
  try {
    const session = state.sessions.find((item) => item.id === result.sessionId);
    if (session && session.id !== state.selectedSessionId) await selectSession(session);
    const landed = await localApi.revealSearchMatch({
      windowId: result.windowId,
      paneId: result.paneId,
      gotoLine: result.gotoLine,
      historySize: result.historySize,
      preview: result.preview,
      query,
    });
    state.paneSearch = { query, direction: 'backward' };
    terminalView?.setCopyModeActive?.(true);
    await refreshDetail();
    if (landed && landed.exact === false) toast(t('search.approximate'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

// Cmd+G / Cmd+Shift+G walk the matches inside the pane that is on screen,
// reusing whatever was last searched for (from the global panel or a previous
// step). tmux keeps its own search string per pane, so this stays in sync.
async function stepPaneSearch(direction) {
  const session = selectedSession();
  const previous = state.paneSearch;
  if (!session || !previous?.query) { toast(t('search.nothingToStep')); return; }
  try {
    const result = await localApi.findInTerminal({
      sessionId: session.id,
      query: previous.query,
      action: 'step',
      direction,
      flip: previous.direction !== direction,
    });
    state.paneSearch = { query: previous.query, direction };
    terminalView?.setCopyModeActive?.(result?.inCopyMode === true);
    if (result && result.present === false) toast(t('search.noMatch'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

function setupGlobalSearch() {
  refs.globalSearchIcon.innerHTML = icon('search', 16);
  refs.globalSearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(runGlobalSearch, 200);
  });
  refs.globalSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeGlobalSearch(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSearchSelection(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSearchSelection(-1); return; }
    if (event.key === 'Enter') { event.preventDefault(); revealSelectedSearchResult(); }
  });
  refs.globalSearch.addEventListener('mousedown', (event) => {
    if (event.target === refs.globalSearch) closeGlobalSearch();
  });
}

// ---------------------------------------------------------------------------
// Clear buffer (Cmd+K) and the terminal's own context menu.
async function clearTerminalBuffer() {
  const session = selectedSession();
  if (!session || isRemoteActive()) { toast(t('search.localOnly')); return; }
  try {
    await localApi.clearTerminal({ sessionId: session.id });
    terminalView?.setCopyModeActive?.(false);
    terminalView?.focus();
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function pasteIntoTerminal() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    terminalView?.paste(text);
    terminalView?.focus();
  } catch {
    toast(t('toast.pasteFailed'), 'error');
  }
}

function openTerminalContextMenu(event) {
  const session = selectedSession();
  if (!session) return;
  event.preventDefault();
  closeFloatingMenus();
  const selection = terminalView?.getSelection?.() || '';
  const remote = isRemoteActive();
  const items = [];
  if (selection) {
    items.push(menuButton({
      iconName: 'copy',
      title: t('terminal.copySelection'),
      action: () => { closeFloatingMenus(); navigator.clipboard.writeText(selection).catch(() => {}); },
    }));
  }
  items.push(menuButton({
    iconName: 'terminal',
    title: t('terminal.paste'),
    action: () => { closeFloatingMenus(); pasteIntoTerminal(); },
  }));
  if (!remote) {
    items.push(menuButton({
      iconName: 'search',
      title: selection ? t('terminal.searchSelection') : t('palette.globalSearch'),
      action: () => { closeFloatingMenus(); openGlobalSearch(); },
    }));
    items.push(separator());
    items.push(menuButton({
      iconName: 'panes',
      title: t('palette.splitVertical'),
      action: () => { closeFloatingMenus(); splitActivePane('vertical'); },
    }));
    items.push(menuButton({
      iconName: 'panes',
      title: t('palette.splitHorizontal'),
      action: () => { closeFloatingMenus(); splitActivePane('horizontal'); },
    }));
    if (activeWindowPanes().length >= 2 || activeWindow()?.zoomed) {
      items.push(menuButton({
        iconName: 'panes',
        title: activeWindow()?.zoomed ? t('palette.unzoomPane') : t('palette.zoomPane'),
        action: () => { closeFloatingMenus(); toggleZoomActivePane(); },
      }));
      items.push(menuButton({
        iconName: 'terminal',
        title: activeWindow()?.synchronized ? t('palette.broadcastOff') : t('palette.broadcastOn'),
        action: () => { closeFloatingMenus(); toggleBroadcastInput(); },
      }));
      items.push(menuButton({
        iconName: 'close',
        title: t('palette.closePane'),
        action: () => { closeFloatingMenus(); closeActivePane(); },
      }));
    }
    items.push(separator());
    items.push(menuButton({
      iconName: 'trash',
      title: t('terminal.clearBuffer'),
      action: () => { closeFloatingMenus(); clearTerminalBuffer(); },
    }));
  }
  refs.contextMenu.replaceChildren(...items);
  placePopoverAt(refs.contextMenu, event.clientX, event.clientY);
}

// ---------------------------------------------------------------------------
// Pane mouse (localMouse). With the localMouse profile on, the session this app
// attaches to runs with tmux's `mouse off`, so xterm.js keeps the mouse: word
// selection on double click, line on triple, drag-select, select-to-copy — the
// iTerm behaviour. The price is the two things tmux's own mouse used to do
// inside the grid, so the client does them over the command channel instead:
// clicking a split focuses it, dragging a split border resizes it.
const PANE_BORDER_SLOP = 3;

function paneMouseEnabled() {
  return state.preferences.tmuxSettings?.localMouse !== false && !isRemoteActive();
}

// Pane rects in pixels, plus the grid extent, so callers can tell an interior
// border (a real divider) from the window's own edge.
function paneLayout() {
  const metrics = terminalView?.getGridMetrics?.();
  const panes = activeWindowPanes().filter(
    (pane) => [pane.left, pane.top, pane.width, pane.height].every((value) => Number.isFinite(value)),
  );
  if (!metrics || panes.length < 2) return null;
  return {
    metrics,
    panes,
    cols: Math.max(...panes.map((pane) => pane.left + pane.width)),
    rows: Math.max(...panes.map((pane) => pane.top + pane.height)),
  };
}

// The divider between two panes is the one cell column/row that separates them:
// a pane spanning columns [left, left+width) has its border at column left+width.
function paneBorderAt(clientX, clientY) {
  const layout = paneLayout();
  if (!layout) return null;
  const { metrics, panes, cols, rows } = layout;
  for (const pane of panes) {
    const leftPx = metrics.left + pane.left * metrics.cellWidth;
    const topPx = metrics.top + pane.top * metrics.cellHeight;
    const rightPx = leftPx + pane.width * metrics.cellWidth;
    const bottomPx = topPx + pane.height * metrics.cellHeight;
    const spansRow = clientY >= topPx && clientY <= bottomPx;
    const spansCol = clientX >= leftPx && clientX <= rightPx;
    if (spansRow && pane.left + pane.width < cols
      && Math.abs(clientX - (rightPx + metrics.cellWidth / 2)) <= metrics.cellWidth / 2 + PANE_BORDER_SLOP) {
      return { pane, axis: 'x', originPx: leftPx, cell: metrics.cellWidth };
    }
    if (spansCol && pane.top + pane.height < rows
      && Math.abs(clientY - (bottomPx + metrics.cellHeight / 2)) <= metrics.cellHeight / 2 + PANE_BORDER_SLOP) {
      return { pane, axis: 'y', originPx: topPx, cell: metrics.cellHeight };
    }
  }
  return null;
}

function paneAt(clientX, clientY) {
  const layout = paneLayout();
  if (!layout) return null;
  const { metrics, panes } = layout;
  const col = (clientX - metrics.left) / metrics.cellWidth;
  const row = (clientY - metrics.top) / metrics.cellHeight;
  return panes.find((pane) => col >= pane.left && col < pane.left + pane.width
    && row >= pane.top && row < pane.top + pane.height) || null;
}

function beginPaneBorderDrag(border, event) {
  event.preventDefault();
  event.stopPropagation();
  const axis = border.axis === 'x' ? 'x' : 'y';
  let lastSize = axis === 'x' ? border.pane.width : border.pane.height;
  let pending = null;
  const sizeAt = (position) => Math.max(1, Math.round((position - border.originPx) / border.cell));
  // tmux reflows on every resize-pane, so throttle to roughly a frame; the
  // pointer keeps moving while the command is in flight.
  const apply = (size) => {
    if (size === lastSize || pending) return;
    lastSize = size;
    pending = localApi.resizePane({ target: border.pane.id, [axis]: size })
      .catch(() => {})
      .then(() => { pending = null; });
  };
  const onMove = (move) => apply(sizeAt(axis === 'x' ? move.clientX : move.clientY));
  const onUp = (up) => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.body.classList.remove('pane-resizing');
    document.body.style.cursor = '';
    apply(sizeAt(axis === 'x' ? up.clientX : up.clientY));
    refreshDetail().catch(() => {});
  };
  document.body.classList.add('pane-resizing');
  document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

/* ---- Drag & drop a file onto the terminal --------------------------------
   What gets typed is always `@<absolute path>`, but where that path comes from
   depends on who runs the session. A local session shares this filesystem, so
   the file is already reachable and only its real path is needed — no copy, no
   upload. A remote takeover does not: the agent lives on the other machine, so
   the bytes travel to its host first and the path that gets typed is the one it
   staged them at. */

// Mirrors MAX_UPLOAD_BYTES on the receiving host.
const DROP_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

function dragCarriesFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL, not btoa over the bytes: btoa needs a binary string and
    // building one from a multi-MB buffer blows the argument limit.
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(new Error(t('terminal.dropReadFailed')));
    reader.readAsDataURL(file);
  });
}

async function dropFilesOnTerminal(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.selectedSessionId || !terminalView) {
    toast(t('terminal.dropNoSession'), 'error');
    return;
  }
  const remote = isRemoteActive();
  const paths = [];
  if (remote) toast(t('terminal.dropUploading'));
  try {
    for (const file of files) {
      if (!remote) {
        // Electron 32 removed File.path; preload's webUtils bridge is the only
        // way to learn where a dropped file actually lives.
        const filePath = localApi.getFilePath ? localApi.getFilePath(file) : '';
        if (!filePath) throw new Error(t('terminal.dropNoPath'));
        paths.push(filePath);
        continue;
      }
      if (file.size > DROP_UPLOAD_MAX_BYTES) throw new Error(t('terminal.dropTooLarge'));
      const staged = await sessionApi().uploadFile({ name: file.name, data: await readFileBase64(file) });
      paths.push(staged.path);
    }
  } catch (error) {
    toast(friendlyError(error), 'error');
    return;
  }
  terminalView.focus();
  for (const filePath of paths) terminalView.sendInput(pathReference(filePath));
  if (remote) toast(t('terminal.dropUploaded', { n: paths.length }));
}

function setupTerminalFileDrop() {
  const stage = refs.terminalStage;
  const overlay = refs.terminalDrop;
  if (!stage || !overlay) return;
  // dragenter/dragleave fire for every child the pointer crosses, so a counter
  // is what keeps the overlay from flickering mid-drag.
  let depth = 0;
  const reset = () => { depth = 0; overlay.classList.add('hidden'); };

  stage.addEventListener('dragenter', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    depth += 1;
    if (state.selectedSessionId) overlay.classList.remove('hidden');
  });
  stage.addEventListener('dragover', (event) => {
    if (!dragCarriesFiles(event)) return;
    // Without preventDefault here the drop is refused outright.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  stage.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  stage.addEventListener('drop', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    reset();
    dropFilesOnTerminal(event.dataTransfer.files);
  });
  // A drag that ends outside the window never fires drop, and a drag started in
  // another app sends us no dragend either — so also clear on losing focus.
  window.addEventListener('dragend', reset);
  window.addEventListener('blur', reset);
  // Anywhere else in the window, a dropped file would make Chromium navigate to
  // it and replace the whole app with a file:// view.
  window.addEventListener('dragover', (event) => { if (dragCarriesFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', (event) => { if (dragCarriesFiles(event)) event.preventDefault(); });
}

function setupPaneMouse() {
  const mount = refs.terminalMount;
  if (!mount) return;
  // Capture phase for both: xterm.js owns pointer events inside the grid, so a
  // bubbling listener never sees the move that should flip the resize cursor.
  mount.addEventListener('mousemove', (event) => {
    if (!paneMouseEnabled() || event.buttons) return;
    const border = paneBorderAt(event.clientX, event.clientY);
    mount.style.cursor = border ? (border.axis === 'x' ? 'col-resize' : 'row-resize') : '';
  }, true);
  mount.addEventListener('mouseleave', () => { mount.style.cursor = ''; });
  mount.addEventListener('contextmenu', (event) => openTerminalContextMenu(event));
  // A border drag must win before xterm.js starts a selection.
  mount.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !paneMouseEnabled()) return;
    const border = paneBorderAt(event.clientX, event.clientY);
    if (border) {
      beginPaneBorderDrag(border, event);
      return;
    }
    // Plain click in another split: focus it, but let the event through so the
    // click still places/starts an xterm selection there.
    const pane = paneAt(event.clientX, event.clientY);
    if (!pane || pane.active) return;
    localApi.selectPane(pane.id).then(() => refreshDetail()).catch(() => {});
  }, true);
}

// Close the pane tmux considers active (used by the command palette; the ×
// overlay closes a specific pane instead).
// The window the attached session currently shows. Zoom and broadcast input are
// window options, so their state comes from here rather than from a pane.
function activeWindow() {
  const panes = state.detail.panes || [];
  const activePane = panes.find((pane) => pane.active);
  const windows = state.detail.windows || [];
  return (activePane && windows.find((win) => win.id === activePane.windowId))
    || windows.find((win) => win.active)
    || null;
}

// tmux's `resize-pane -Z`: the active pane fills the window and a second call
// puts the layout back — iTerm's "Maximize Active Pane". Zoom on an unsplit
// window is a no-op in tmux, so it is only offered once there is a split.
async function toggleZoomActivePane() {
  if (!requireLocal()) return;
  const session = selectedSession();
  if (!session) { toast(t('toast.noSession')); return; }
  if (activeWindowPanes().length < 2 && !activeWindow()?.zoomed) { toast(t('toast.noSplit')); return; }
  try {
    const { zoomed } = await api.zoomPane(session.id);
    await refreshDetail();
    terminalView?.focus();
    toast(zoomed ? t('toast.paneZoomed') : t('toast.paneUnzoomed'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

// Cmd+Alt+arrow moves focus between splits. tmux resolves the direction from
// the real layout, so nested splits work without any geometry maths here.
async function navigateActivePane(direction) {
  if (isRemoteActive()) return;
  const session = selectedSession();
  if (!session || activeWindowPanes().length < 2) return;
  try {
    await api.navigatePane({ target: session.id, direction });
    await refreshDetail();
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

// Broadcast input (tmux synchronize-panes): every keystroke reaches every pane
// of the window. Deliberately window-scoped and never part of the tmux profile
// — it stays on until turned off, which is why the workspace header shows a
// badge while it is active.
async function toggleBroadcastInput() {
  if (!requireLocal()) return;
  const session = selectedSession();
  if (!session) { toast(t('toast.noSession')); return; }
  const enabled = !activeWindow()?.synchronized;
  if (enabled && activeWindowPanes().length < 2) { toast(t('toast.noSplit')); return; }
  try {
    const result = await api.setBroadcastInput({ target: session.id, enabled });
    await refreshDetail();
    terminalView?.focus();
    toast(result.synchronized ? t('toast.broadcastOn') : t('toast.broadcastOff'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

function closeActivePane() {
  const active = (state.detail.panes || []).find((pane) => pane.active);
  if (!active || activeWindowPanes().length < 2) { toast(t('toast.noSession')); return; }
  closePane(active.id);
}

// Close (kill) a split pane, then refresh so the overlay and terminal reflect
// the collapsed layout. tmux reflows the surviving panes to fill the space.
async function closePane(paneId) {
  if (!requireLocal()) return;
  try {
    await api.killPane(paneId);
    await refreshDetail();
    terminalView?.focus();
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function refreshDetail() {
  const session = selectedSession();
  if (!session) return;
  const targetId = session.id;
  try {
    const detail = await sessionApi().getSessionDetail(targetId);
    if (state.selectedSessionId !== targetId) return;
    state.detail = detail;
    renderDetail();
    syncFileBrowser();
  } catch (error) {
    if (state.selectedSessionId === targetId) toast(friendlyError(error), 'error');
  }
}

function activeSessionDir() {
  const active = state.detail.panes.find((pane) => pane.active) || state.detail.panes[0];
  if (active && active.path) return active.path;
  return selectedSession()?.path || null;
}

// OSC 8 hyperlink target. Always opened through the LOCAL bridge, never the
// session api: the browser has to come up on the machine the user is looking
// at, not on the host a remote takeover is attached to.
async function openTerminalUrl(url) {
  if (!localApi.openExternalUrl) throw new Error(t('file.resolveFailed'));
  await localApi.openExternalUrl(url);
}

async function openTerminalFileReference(reference) {
  const target = resolveTerminalFileReference(reference, activeSessionDir());
  if (!target) throw new Error(t('file.resolveFailed'));
  // A remote session's path names a file on THAT host; opening it here means
  // fetching it first.
  if (fileContext().remote) {
    await downloadRemoteEntry({ name: target.split('/').pop(), path: target, size: 0 }, 'open');
    return;
  }
  await api.openFile(target);
}

/* ── File panel ─────────────────────────────────────────────────────────────
   Shows the directory of the session being viewed, on the machine that RUNS it.
   A local session's is this filesystem (IPC). A remote takeover's is the other
   host's: the listing comes from that host's file API, and files cross devices
   through the main process — downloads stream into ~/Downloads, uploads come
   from a drop or the picker — with progress at the bottom of the panel. */

function fileContext() {
  const connection = activeConnection();
  if (connection) {
    return { remote: true, connection, sessionId: state.selectedSessionId, key: `${connection.id}|${state.selectedSessionId}` };
  }
  return { remote: false, key: 'local' };
}

function listPanelDir(dir) {
  const context = fileContext();
  if (!context.remote) return api.listFiles(dir);
  return sessionApi().listSessionFiles({ sessionId: context.sessionId, path: dir });
}

function setFileBrowserOpen(open) {
  state.files.open = Boolean(open);
  refs.fileBrowser.classList.toggle('hidden', !state.files.open);
  refs.filesToggleButton.classList.toggle('active', state.files.open);
  if (state.files.open) syncFileBrowser(true);
}

function toggleFileBrowser() { setFileBrowserOpen(!state.files.open); }

function syncFileBrowser(force = false) {
  if (!state.files.open) return;
  const dir = activeSessionDir();
  // Keyed on the source too: a remote host often has the very same path as this
  // machine (same user, same repo layout), and switching sources must not keep
  // showing the local listing under the remote's name.
  const key = `${fileContext().key}|${dir || ''}`;
  if (!force && key === state.files.key) return;
  state.files.key = key;
  state.files.root = dir;
  loadFileTree(dir);
}

function paintFileHeader() {
  const context = fileContext();
  const host = context.remote ? (context.connection.label || context.connection.base) : '';
  refs.fbHost.textContent = host;
  refs.fbHost.title = context.remote ? t('file.remoteHostTitle', { host }) : '';
  refs.fbHost.classList.toggle('hidden', !context.remote);
  // Revealing in Finder only means something for a directory on this disk.
  refs.fbRevealButton.classList.toggle('hidden', context.remote);
  const uploadLabel = t(context.remote ? 'file.uploadHere' : 'file.copyHere');
  refs.fbUploadButton.title = uploadLabel;
  refs.fbUploadButton.setAttribute('aria-label', uploadLabel);
}

async function loadFileTree(dir, { reopen = [] } = {}) {
  paintFileHeader();
  // The label is right-to-left so a long path truncates at its start; a leading
  // LRM keeps the "~/" there in place instead of it being laid out at the end.
  refs.fbPath.textContent = dir ? `‎${shortenPath(dir)}` : t('file.noDir');
  refs.fbPath.title = dir || '';
  const loading = document.createElement('div');
  loading.className = 'fb-loading';
  loading.textContent = dir ? t('file.loading') : t('file.selectSessionHint');
  if (!reopen.length) refs.fbTree.replaceChildren(loading);
  if (!dir) return;
  const key = state.files.key;
  try {
    const listing = await listPanelDir(dir);
    if (state.files.key !== key) return;
    refs.fbTree.replaceChildren();
    renderFileEntries(refs.fbTree, listing.entries, 0);
    // Restore what was expanded, parents first (document order), so a refresh
    // after a transfer doesn't collapse the folder the user is working in.
    for (const openPath of reopen) {
      const node = findFileNode(openPath);
      if (node && !node.classList.contains('open')) await expandDir(node);
      if (state.files.key !== key) return;
    }
  } catch (error) {
    if (state.files.key !== key) return;
    const failed = document.createElement('div');
    failed.className = 'fb-empty';
    failed.textContent = friendlyError(error);
    refs.fbTree.replaceChildren(failed);
  }
}

function reloadFileTree() {
  const reopen = [...refs.fbTree.querySelectorAll('.fb-node.open')].map((node) => node.dataset.path);
  loadFileTree(state.files.root, { reopen });
}

function findFileNode(filePath) {
  return [...refs.fbTree.querySelectorAll('.fb-node')].find((node) => node.dataset.path === filePath) || null;
}

const fileNodeEntries = new WeakMap();

function renderFileEntries(mount, entries, depth) {
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'fb-empty';
    empty.style.paddingLeft = `${14 + depth * 14}px`;
    empty.textContent = t('file.emptyFolder');
    mount.append(empty);
    return;
  }
  for (const entry of entries) mount.append(createFileRow(entry, depth));
}

function createFileRow(entry, depth) {
  const node = document.createElement('div');
  node.className = 'fb-node';
  node.dataset.path = entry.path;
  node.dataset.depth = String(depth);
  if (entry.isDir) node.dataset.dir = '1';
  fileNodeEntries.set(node, entry);
  const row = document.createElement('button');
  row.className = `fb-row ${entry.hidden ? 'dim' : ''}`;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.title = entry.isDir ? entry.name : `${entry.name} · ${formatBytes(entry.size)}`;
  const chevron = document.createElement('span');
  chevron.className = `fb-chevron ${entry.isDir ? '' : 'spacer'}`;
  if (entry.isDir) chevron.innerHTML = icon('chevron', 12);
  const iconBox = document.createElement('span');
  iconBox.className = `fb-icon ${entry.isDir ? 'folder' : 'file'}`;
  iconBox.innerHTML = icon(entry.isDir ? 'folder' : 'file', 15);
  const name = document.createElement('span');
  name.className = 'fb-name';
  name.textContent = entry.name;
  row.append(chevron, iconBox, name);
  row.addEventListener('click', () => { if (entry.isDir) toggleDir(node); else openEntry(entry); });
  row.addEventListener('contextmenu', (event) => { event.preventDefault(); openFileMenu(entry, event.clientX, event.clientY); });
  node.append(row);
  return node;
}

function toggleDir(node) {
  const existing = node.querySelector(':scope > .fb-children');
  if (existing) { existing.remove(); node.classList.remove('open'); return; }
  expandDir(node);
}

async function expandDir(node) {
  const entry = fileNodeEntries.get(node);
  if (!entry) return;
  const depth = Number(node.dataset.depth) || 0;
  const children = document.createElement('div');
  children.className = 'fb-children';
  const loading = document.createElement('div');
  loading.className = 'fb-loading';
  loading.style.paddingLeft = `${14 + (depth + 1) * 14}px`;
  loading.textContent = t('file.loading');
  children.append(loading);
  node.append(children);
  node.classList.add('open');
  try {
    const listing = await listPanelDir(entry.path);
    if (!node.isConnected || !node.classList.contains('open')) return;
    children.replaceChildren();
    renderFileEntries(children, listing.entries, depth + 1);
  } catch (error) {
    const failed = document.createElement('div');
    failed.className = 'fb-empty';
    failed.style.paddingLeft = `${14 + (depth + 1) * 14}px`;
    failed.textContent = friendlyError(error);
    children.replaceChildren(failed);
  }
}

async function openEntry(entry) {
  if (fileContext().remote) { downloadRemoteEntry(entry, 'open'); return; }
  try { await api.openFile(entry.path); }
  catch (error) { toast(friendlyError(error), 'error'); }
}

function referenceInTerminal(filePath) {
  if (!state.selectedSessionId || !terminalView) { toast(t('terminal.dropNoSession'), 'error'); return; }
  terminalView.focus();
  terminalView.sendInput(pathReference(filePath));
}

function pickFilesFor(dir) {
  state.files.uploadDir = dir;
  refs.fbUploadInput.click();
}

function openFileMenu(entry, x, y) {
  closeFloatingMenus();
  const remote = fileContext().remote;
  const run = (fn) => () => { closeFloatingMenus(); fn(); };
  const items = [];
  if (remote && entry.isDir) {
    items.push(menuButton({ iconName: 'upload', title: t('file.uploadInto'), action: run(() => pickFilesFor(entry.path)) }));
  } else if (remote) {
    items.push(
      menuButton({ iconName: 'download', title: t('file.download'), action: run(() => downloadRemoteEntry(entry, 'download')) }),
      menuButton({ iconName: 'external', title: t('file.downloadOpen'), action: run(() => downloadRemoteEntry(entry, 'open')) }),
      menuButton({ iconName: 'folder', title: t('file.saveAs'), action: run(() => downloadRemoteEntry(entry, 'save-as')) }),
    );
  } else {
    items.push(
      menuButton({ iconName: entry.isDir ? 'folder' : 'terminal', title: entry.isDir ? t('file.openInFinder') : t('action.open'), action: run(() => openEntry(entry)) }),
      menuButton({ iconName: 'external', title: t('file.openWith'), action: run(async () => {
        try { const result = await api.openFileWith(entry.path); if (result && result.app) toast(t('file.openedWith', { app: result.app })); }
        catch (error) { toast(friendlyError(error), 'error'); }
      }) }),
      menuButton({ iconName: 'folder', title: t('action.revealInFinder'), action: run(async () => {
        try { await api.revealFile(entry.path); } catch (error) { toast(friendlyError(error), 'error'); }
      }) }),
    );
    if (entry.isDir) items.push(menuButton({ iconName: 'upload', title: t('file.copyInto'), action: run(() => pickFilesFor(entry.path)) }));
  }
  items.push(
    separator(),
    menuButton({ iconName: 'at', title: t('file.reference'), action: run(() => referenceInTerminal(entry.path)) }),
    menuButton({ iconName: 'copy', title: t('action.copyPath'), action: run(async () => {
      await navigator.clipboard.writeText(entry.path);
      toast(t('toast.pathCopied'));
    }) }),
  );
  refs.contextMenu.replaceChildren(...items);
  placePopoverAt(refs.contextMenu, x, y);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function baseName(filePath) {
  const trimmed = String(filePath || '').replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/';
}

/* Transfers. The bytes move in the main process; the renderer only keeps a row
   per transfer, fed by its progress events. Rows update in place — rebuilding
   them on every tick would swallow a click on the cancel button mid-press. */

let transferSeq = 0;

function startTransfer({ direction, name, total, pending = false }) {
  transferSeq += 1;
  const transfer = {
    id: `t${Date.now().toString(36)}${transferSeq.toString(36)}`,
    direction,
    name,
    total: total || 0,
    loaded: 0,
    // A save-as download waits on the save dialog first; it only shows up once
    // bytes are actually moving (or never, if the dialog is cancelled).
    status: pending ? 'pending' : 'running',
    path: null,
    resultName: null,
    error: null,
  };
  state.files.transfers.push(transfer);
  renderTransfers();
  return transfer;
}

function removeTransfer(transfer) {
  state.files.transfers = state.files.transfers.filter((item) => item !== transfer);
  renderTransfers();
}

function finishTransfer(transfer, { status, path: filePath = null, name = null, error = null }) {
  Object.assign(transfer, { status, path: filePath, resultName: name, error });
  if (status === 'done' && transfer.total) transfer.loaded = transfer.total;
  renderTransfers();
  if (status === 'failed' && error) toast(error, 'error');
  // Successes and cancels clear themselves; a failure stays until dismissed so
  // the reason is still there when the user looks.
  if (status === 'done' || status === 'canceled') {
    setTimeout(() => { if (transfer.status === status) removeTransfer(transfer); }, status === 'done' ? 12000 : 3000);
  }
}

function onTransferProgress({ id, loaded, total } = {}) {
  const transfer = state.files.transfers.find((item) => item.id === id);
  if (!transfer || (transfer.status !== 'running' && transfer.status !== 'pending')) return;
  transfer.loaded = loaded || 0;
  if (total) transfer.total = total;
  if (transfer.status === 'pending') {
    transfer.status = 'running';
    renderTransfers();
    return;
  }
  paintTransfer(transfer);
}

function transferRow(transfer) {
  if (transfer.el) return transfer.el;
  const row = document.createElement('div');
  row.className = 'fb-transfer';
  row.dataset.direction = transfer.direction;
  const iconBox = document.createElement('span');
  iconBox.className = 'fb-transfer-icon';
  iconBox.innerHTML = icon(transfer.direction === 'down' ? 'download' : 'upload', 14);
  const body = document.createElement('div');
  body.className = 'fb-transfer-body';
  const name = document.createElement('div');
  name.className = 'fb-transfer-name';
  name.textContent = transfer.name;
  const bar = document.createElement('div');
  bar.className = 'fb-transfer-bar';
  const fill = document.createElement('span');
  bar.append(fill);
  const meta = document.createElement('div');
  meta.className = 'fb-transfer-meta';
  body.append(name, bar, meta);
  const action = document.createElement('button');
  action.className = 'icon-button fb-transfer-action';
  action.addEventListener('click', (event) => { event.stopPropagation(); onTransferAction(transfer); });
  row.addEventListener('click', () => {
    if (transfer.status === 'done' && transfer.direction === 'down' && transfer.path) {
      localApi.revealFile(transfer.path).catch((error) => toast(friendlyError(error), 'error'));
    }
  });
  row.append(iconBox, body, action);
  transfer.el = row;
  transfer.parts = { name, fill, meta, action };
  return row;
}

function paintTransfer(transfer) {
  const row = transferRow(transfer);
  const { name, fill, meta, action } = transfer.parts;
  row.dataset.status = transfer.status;
  const percent = transfer.total ? Math.min(100, Math.round((transfer.loaded / transfer.total) * 100)) : 0;
  fill.style.width = `${percent}%`;
  name.textContent = transfer.resultName || transfer.name;
  name.title = transfer.path || transfer.name;
  if (transfer.status === 'running') {
    meta.textContent = transfer.total
      ? `${formatBytes(transfer.loaded)} / ${formatBytes(transfer.total)} · ${percent}%`
      : formatBytes(transfer.loaded);
  } else if (transfer.status === 'done') {
    meta.textContent = transfer.direction === 'down'
      ? t('file.transferSaved', { path: shortenPath(transfer.path) })
      : t('file.transferUploaded', { size: formatBytes(transfer.total) });
  } else if (transfer.status === 'canceled') {
    meta.textContent = t('file.transferCanceled');
  } else {
    meta.textContent = transfer.error || t('error.unknown');
  }
  const reveal = transfer.status === 'done' && transfer.direction === 'down';
  const label = transfer.status === 'running'
    ? t('file.transferCancel')
    : (reveal ? t('action.revealInFinder') : t('file.transferDismiss'));
  action.innerHTML = icon(reveal ? 'folder' : 'close', 13);
  action.title = label;
  action.setAttribute('aria-label', label);
}

function renderTransfers() {
  const visible = state.files.transfers.filter((transfer) => transfer.status !== 'pending');
  refs.fbTransfers.classList.toggle('hidden', !visible.length);
  refs.fbTransfers.replaceChildren(...visible.map((transfer) => {
    paintTransfer(transfer);
    return transfer.el;
  }));
}

function onTransferAction(transfer) {
  if (transfer.status === 'running') {
    localApi.cancelTransfer(transfer.id).catch(() => {});
    return;
  }
  if (transfer.status === 'done' && transfer.direction === 'down' && transfer.path) {
    localApi.revealFile(transfer.path).catch((error) => toast(friendlyError(error), 'error'));
    return;
  }
  removeTransfer(transfer);
}

function isCancelError(message) {
  return /已取消|cancel/i.test(message || '');
}

async function downloadRemoteEntry(entry, mode = 'download') {
  const context = fileContext();
  if (!context.remote || !context.sessionId) return;
  const transfer = startTransfer({ direction: 'down', name: entry.name, total: entry.size, pending: mode === 'save-as' });
  try {
    const result = await localApi.downloadRemoteFile({
      connectionId: context.connection.id,
      session: context.sessionId,
      path: entry.path,
      mode,
      transferId: transfer.id,
    });
    if (result.canceled) { removeTransfer(transfer); return; }
    transfer.total = result.size || transfer.total;
    finishTransfer(transfer, { status: 'done', path: result.path, name: result.name });
    if (!state.files.open && mode !== 'open') toast(t('file.downloadedToast', { path: shortenPath(result.path) }));
  } catch (error) {
    const message = friendlyError(error);
    finishTransfer(transfer, { status: isCancelError(message) ? 'canceled' : 'failed', error: message });
  }
}

/* Put files into a folder of the viewed session. Dropped or picked files are on
   THIS machine, so a local session just copies them; a remote one uploads them
   to its host, one after another (each file is its own transfer row). */
async function uploadFilesTo(files, dir) {
  if (!files.length) return;
  if (!dir || !state.selectedSessionId) { toast(t('terminal.dropNoSession'), 'error'); return; }
  const context = fileContext();
  const panelKey = state.files.key;
  const sources = files.map((file) => (localApi.getFilePath ? localApi.getFilePath(file) : ''));
  if (sources.some((source) => !source)) { toast(t('terminal.dropNoPath'), 'error'); return; }
  const refresh = () => { if (state.files.open && state.files.key === panelKey) reloadFileTree(); };
  if (!context.remote) {
    try {
      const copied = await localApi.copyFilesInto({ sources, dir });
      toast(t('file.copiedInto', { n: copied.length, dir: baseName(dir) }));
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
    refresh();
    return;
  }
  let uploaded = 0;
  for (const [index, file] of files.entries()) {
    const transfer = startTransfer({ direction: 'up', name: file.name, total: file.size });
    try {
      const result = await localApi.uploadRemoteFile({
        connectionId: context.connection.id,
        session: context.sessionId,
        dir,
        source: sources[index],
        transferId: transfer.id,
      });
      finishTransfer(transfer, { status: 'done', path: result.path, name: result.name });
      uploaded += 1;
    } catch (error) {
      const message = friendlyError(error);
      finishTransfer(transfer, { status: isCancelError(message) ? 'canceled' : 'failed', error: message });
    }
  }
  if (uploaded) {
    refresh();
    if (!state.files.open) toast(t('file.uploadedToast', { n: uploaded, host: context.connection.label || context.connection.base }));
  }
}

// The folder a drop lands in: the directory row under the pointer, the folder
// that contains a file row under it, or (null) the panel's root.
function dropDirNode(element) {
  let node = element?.closest?.('.fb-node') || null;
  while (node && !node.dataset.dir) node = node.parentElement?.closest('.fb-node') || null;
  return node;
}

function setupFileBrowserDrop() {
  const panel = refs.fileBrowser;
  if (!panel) return;
  let depth = 0;
  let target = null;
  const setTarget = (node) => {
    if (target === node) return;
    target?.classList.remove('drop-target');
    target = node;
    target?.classList.add('drop-target');
  };
  const reset = () => { depth = 0; setTarget(null); refs.fbDrop.classList.add('hidden'); };
  const describe = (node) => {
    const dir = node ? node.dataset.path : state.files.root;
    const context = fileContext();
    return context.remote
      ? t('file.dropUpload', { host: context.connection.label || context.connection.base, dir: baseName(dir) })
      : t('file.dropCopy', { dir: baseName(dir) });
  };

  panel.addEventListener('dragenter', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    depth += 1;
    if (state.files.root) refs.fbDrop.classList.remove('hidden');
  });
  panel.addEventListener('dragover', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    if (!state.files.root) { event.dataTransfer.dropEffect = 'none'; return; }
    event.dataTransfer.dropEffect = 'copy';
    const node = dropDirNode(event.target);
    setTarget(node);
    refs.fbDropText.textContent = describe(node);
  });
  panel.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) reset();
  });
  panel.addEventListener('drop', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    const node = dropDirNode(event.target);
    const dir = node ? node.dataset.path : state.files.root;
    reset();
    uploadFilesTo(Array.from(event.dataTransfer.files || []), dir);
  });
  window.addEventListener('dragend', reset);
  window.addEventListener('blur', reset);

  refs.fbUploadInput.addEventListener('change', () => {
    const files = Array.from(refs.fbUploadInput.files || []);
    // Clear first: picking the same file twice otherwise fires no change event.
    refs.fbUploadInput.value = '';
    const dir = state.files.uploadDir || state.files.root;
    state.files.uploadDir = null;
    uploadFilesTo(files, dir);
  });
  if (localApi.onTransferProgress) localApi.onTransferProgress(onTransferProgress);
}

async function clearSessionSelection() {
  selectionToken += 1;
  if (state.selectedSessionId) await terminalView.detach();
  state.selectedSessionId = null;
  state.detail = { windows: [], panes: [] };
  syncFileBrowser();
  renderSessionList();
  renderSessionTabs();
  renderWorkspace();
  renderDetail();
}

async function setView(view, { tagRailPreviousPositions = null } = {}) {
  let nextView = view;
  if (!nextView || !['all', 'favorites', 'tag'].includes(nextView.kind)) nextView = { kind: 'all' };
  if (nextView.kind === 'tag' && !viewPrefs().tags.some((tag) => tag.id === nextView.tagId)) {
    nextView = { kind: 'all' };
  }
  state.view = nextView;
  refs.appShell.classList.toggle('compact-view', nextView.kind !== 'all');
  applySidebarWidth();
  closeFloatingMenus();
  renderTagRail(tagRailPreviousPositions);
  renderSessionList();
  renderSessionTabs();
  renderWorkspace();

  if (nextView.kind === 'all') {
    if (!selectedSession() && state.sessions.length) {
      await selectSession(rememberedSession(state.sessions) || state.sessions[0]);
    } else {
      terminalView?.focus();
    }
    return;
  }

  const sessions = compactSessions();
  const selected = selectedSession();
  if (selected && sessions.some((session) => session.id === selected.id)) {
    terminalView?.focus();
    return;
  }
  if (sessions.length) await selectSession(sessions[0]);
  else await clearSessionSelection();
}

async function selectSession(session) {
  if (!session || session.id === state.selectedSessionId) {
    renderSessionTabs();
    terminalView?.focus();
    return;
  }
  const token = ++selectionToken;
  state.selectedSessionId = session.id;
  state.restorePending = false;
  state.detail = { windows: [], panes: [] };
  refs.terminalReconnect.classList.add('hidden');
  renderSessionList();
  renderSessionTabs();
  renderWorkspace();
  renderDetail();
  rememberSelection(session);
  try {
    await Promise.all([refreshDetail(), terminalView.attach(session.id)]);
    if (token !== selectionToken) return;
    refs.workspaceStatus.textContent = t('workspace.statusAttached', { windows: session.windows || 0, panes: session.paneCount || 0 });
  } catch (error) {
    if (token === selectionToken) {
      refs.terminalReconnect.classList.remove('hidden');
      toast(friendlyError(error), 'error');
    }
  }
}

// Which session to land on when a source's list arrives: the one the user was
// on when they last left that source. Local matches by name (tmux reuses ids
// after a server restart). A remote host keeps id + name: a host that reshares
// others can list two sessions with the same name, and the id still finds one
// that was renamed since.
function rememberedSession(sessions) {
  if (!isRemoteActive()) return sessions.find((session) => session.name === state.preferences.lastSession) || null;
  const saved = state.preferences.remoteLastSessions?.[state.source.id];
  if (!saved) return null;
  return sessions.find((session) => session.id === saved.id && session.name === saved.name)
    || sessions.find((session) => session.name === saved.name)
    || sessions.find((session) => session.id === saved.id)
    || null;
}

// Best effort and off the attach path: a failed write only costs the restore.
function rememberSelection(session) {
  let patch;
  if (!isRemoteActive()) {
    patch = { lastSession: session.name };
  } else {
    const saved = state.preferences.remoteLastSessions?.[state.source.id];
    if (saved && saved.id === session.id && saved.name === session.name) return;
    patch = {
      remoteLastSessions: {
        ...(state.preferences.remoteLastSessions || {}),
        [state.source.id]: { id: session.id, name: session.name },
      },
    };
  }
  api.savePreferences(patch).then((preferences) => { state.preferences = preferences; }, () => {});
}

async function refreshSessions({ initial = false, notify = false, poll = false } = {}) {
  // One refresh per source at a time. One still waiting on the source the user
  // just left must not hold up the new source's first listing — an unreachable
  // host keeps it for the whole request timeout, and the switch's own refresh
  // would be dropped, leaving nothing selected. Its answer is discarded by the
  // token checks below anyway.
  if (refreshingToken === sourceToken) return;
  const token = sourceToken;
  refreshingToken = token;
  refs.refreshButton.classList.add('spinning');
  try {
    if (isRemoteActive()) {
      // A remote host that answers /api/sessions has usable tmux; skip the local
      // tmux probe entirely.
      state.systemStatus = { installed: true };
    } else if (initial || !state.systemStatus.installed) {
      state.systemStatus = await api.getSystemStatus();
    }
    const source = sessionApi();
    let sessions = [];
    let remotePrefs = null;
    if (state.systemStatus.installed && isRemoteActive() && typeof source.listSessionsWithPreferences === 'function') {
      ({ sessions, preferences: remotePrefs } = await source.listSessionsWithPreferences());
    } else if (state.systemStatus.installed) {
      sessions = await source.listSessions();
    }
    // A source switch (or another concurrent refresh) happened while we awaited;
    // these results belong to the old source — drop them.
    if (token !== sourceToken) return;
    if (remotePrefs) {
      state.remotePrefs = remotePrefs;
      // The tag being viewed was deleted (or renamed away) on the remote host.
      if (state.view.kind === 'tag' && !remotePrefs.tags.some((tag) => tag.id === state.view.tagId)) {
        state.view = { kind: 'all' };
        refs.appShell.classList.remove('compact-view');
        applySidebarWidth();
      }
    }
    if (isRemoteActive()) {
      // A successful listing is a stronger reachability signal than the probe;
      // keep the popover's dot in sync with it.
      state.remoteProbes.set(state.source.id, { status: 'online', ms: null, at: Date.now() });
      if (state.sourceStatus !== 'online') { state.sourceStatus = 'online'; renderSourceBar(); }
    }
    const previousId = state.selectedSessionId;
    state.sessions = sessions;
    if (previousId && !sessions.some((session) => session.id === previousId)) {
      selectionToken += 1;
      state.selectedSessionId = null;
      state.detail = { windows: [], panes: [] };
      await terminalView.detach();
      if (token !== sourceToken) return;
      syncFileBrowser();
      if (!initial) toast(t('toast.sessionClosedExternally'), 'error');
    }
    renderSystemStatus();
    renderTagRail();
    renderSessionList();
    renderSessionTabs();
    renderWorkspace();
    if (state.view.kind !== 'all') {
      const available = compactSessions();
      if (!selectedSession() || !available.some((session) => session.id === state.selectedSessionId)) {
        if (available.length) await selectSession(available[0]);
        else if (state.selectedSessionId) await clearSessionSelection();
      } else {
        await refreshDetail();
      }
    } else if (state.selectedSessionId) {
      await refreshDetail();
    } else if ((initial || state.restorePending) && sessions.length) {
      await selectSession(rememberedSession(sessions) || sessions[0]);
    }
    if (notify) toast(t('toast.sessionsRefreshed'));
  } catch (error) {
    // The source we left failing must not mark the one now shown as offline.
    if (token !== sourceToken) return;
    if (isRemoteActive()) {
      state.remoteProbes.set(state.source.id, { status: 'offline', error: error?.message, at: Date.now() });
      if (state.sourceStatus !== 'offline') {
        state.sourceStatus = 'offline';
        renderSourceBar();
        renderSessionList();
      }
    }
    // Background polls fail quietly (a remote blip shouldn't spam toasts); only
    // user-initiated refreshes surface the error.
    if (!poll) toast(friendlyError(error), 'error');
  } finally {
    if (refreshingToken === token) {
      refreshingToken = null;
      refs.refreshButton.classList.remove('spinning');
    }
  }
}

function menuButton({ iconName, title, action, danger = false, checked = false, disabled = false }) {
  const button = document.createElement('button');
  button.className = `menu-item ${danger ? 'danger' : ''} ${disabled ? 'disabled' : ''}`.trim();
  button.innerHTML = icon(iconName, 15);
  const label = document.createElement('span');
  label.textContent = title;
  button.append(label);
  if (checked) {
    const check = document.createElement('span');
    check.className = 'menu-check';
    check.innerHTML = icon('check', 14);
    button.append(check);
  }
  if (disabled) button.disabled = true;
  else button.addEventListener('click', action);
  return button;
}

function separator() {
  const item = document.createElement('div');
  item.className = 'menu-separator';
  return item;
}

function placePopover(popover, anchor) {
  popover.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  popover.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width))}px`;
  popover.style.top = `${Math.min(window.innerHeight - height - 8, rect.bottom + 5)}px`;
}

function placePopoverAt(popover, x, y) {
  popover.classList.remove('hidden');
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  popover.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, x))}px`;
  popover.style.top = `${Math.min(window.innerHeight - height - 8, Math.max(8, y))}px`;
}

function closeFloatingMenus() {
  refs.contextMenu.classList.add('hidden');
  refs.themePopover.classList.add('hidden');
  closeSourcePopover();
}

function openSessionMenu(session, anchor) {
  closeFloatingMenus();
  const copyName = menuButton({ iconName: 'copy', title: t('menu.copyName'), action: async () => {
    closeFloatingMenus();
    await navigator.clipboard.writeText(session.name);
    toast(t('toast.nameCopied'));
  } });
  const connect = menuButton({ iconName: 'terminal', title: t('menu.connectSession'), action: () => { closeFloatingMenus(); selectSession(session); } });
  if (isRemoteActive()) {
    // Remote takeover is read-only: only navigation + copy, no session mutation
    // and no re-sharing through the local web server (which lacks this session).
    refs.contextMenu.replaceChildren(connect, separator(), copyName);
    placePopover(refs.contextMenu, anchor);
    return;
  }
  const isFavorite = state.preferences.favorites.includes(session.name);
  refs.contextMenu.replaceChildren(
    connect,
    menuButton({ iconName: 'star', title: isFavorite ? t('menu.unfavorite') : t('menu.favorite'), action: async () => {
      closeFloatingMenus();
      try { await toggleFavorite(session); }
      catch (error) { toast(friendlyError(error), 'error'); }
    } }),
    menuButton({ iconName: 'tag', title: t('menu.manageTags'), action: () => { closeFloatingMenus(); openSessionTagsModal(session); } }),
    menuButton({ iconName: 'external', title: t('menu.shareSession'), action: () => { closeFloatingMenus(); openMobileAccessModal(session); } }),
    separator(),
    menuButton({ iconName: 'edit', title: t('action.rename'), action: () => { closeFloatingMenus(); openRenameModal(session); } }),
    menuButton({ iconName: 'copy', title: t('menu.duplicateSession'), action: () => { closeFloatingMenus(); openDuplicateModal(session); } }),
    copyName,
    separator(),
    menuButton({ iconName: 'trash', title: t('menu.closeSession'), danger: true, action: () => { closeFloatingMenus(); openKillModal(session); } }),
  );
  placePopover(refs.contextMenu, anchor);
}

function openTagMenu(tag, x, y) {
  closeFloatingMenus();
  const openItem = menuButton({ iconName: 'terminal', title: t('menu.openTag', { name: tag.name }), action: () => setView({ kind: 'tag', tagId: tag.id }) });
  if (isRemoteActive()) {
    // Pin / rename / delete edit this machine's tag list, not the remote's.
    refs.contextMenu.replaceChildren(openItem);
    placePopoverAt(refs.contextMenu, x, y);
    return;
  }
  const topUnpinned = firstUnpinnedTag();
  let pinItem;
  if (tag.pinned) {
    pinItem = menuButton({ iconName: 'star', title: t('menu.unpin'), action: () => { closeFloatingMenus(); setTagPinned(tag, false); } });
  } else if (topUnpinned && topUnpinned.id === tag.id) {
    pinItem = menuButton({ iconName: 'star', title: t('menu.pinToTop'), action: () => { closeFloatingMenus(); setTagPinned(tag, true); } });
  } else {
    pinItem = menuButton({ iconName: 'star', title: t('menu.pinDisabledHint'), disabled: true });
  }
  refs.contextMenu.replaceChildren(
    openItem,
    separator(),
    pinItem,
    menuButton({ iconName: 'edit', title: t('menu.renameTag'), action: () => { closeFloatingMenus(); openTagEditor(tag); } }),
    menuButton({ iconName: 'trash', title: t('menu.deleteTag'), danger: true, action: () => { closeFloatingMenus(); openTagDeleteModal(tag); } }),
  );
  placePopoverAt(refs.contextMenu, x, y);
}

function openModal(modal, focusTarget) {
  closeFloatingMenus();
  modal.classList.remove('hidden');
  requestAnimationFrame(() => focusTarget?.focus());
}

function closeModal(modal) {
  modal.classList.add('hidden');
  // Cancel button and Escape both land here, and the paste dialog has a promise
  // waiting on the answer — dismissing it means "no", not "hang forever".
  if (modal === refs.pasteConfirmModal) settlePasteConfirm(false);
}

function openTagEditor(tag = null) {
  refs.tagEditorModal.dataset.tagId = tag?.id || '';
  refs.tagEditorTitle.textContent = tag ? t('tag.renameTitle') : t('tag.new');
  refs.tagNameInput.value = tag?.name || '';
  openModal(refs.tagEditorModal, refs.tagNameInput);
  refs.tagNameInput.select();
}

async function exportTags() {
  try {
    const result = await api.exportTags();
    if (!result?.canceled) toast(t('toast.tagsExported'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function importTags() {
  try {
    const outcome = await api.importTags();
    if (outcome?.canceled) return;
    state.preferences = outcome.preferences;
    renderTagSettings();
    renderTagRail();
    renderSessionList();
    renderSessionTabs();
    renderWorkspace();
    toast(t('toast.tagsImported'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

function openTagDeleteModal(tag) {
  refs.tagDeleteModal.dataset.tagId = tag.id;
  refs.tagDeleteMessage.textContent = t('tag.deleteMessage', { name: tag.name });
  openModal(refs.tagDeleteModal, refs.confirmTagDeleteButton);
}

function openSessionTagsModal(session = selectedSession()) {
  if (!session) return;
  // It would file a REMOTE session name under this machine's tags.
  if (!requireLocal()) return;
  refs.sessionTagsModal.dataset.sessionName = session.name;
  refs.sessionTagsMessage.textContent = t('session.tagsMessage', { name: session.name });
  const selectedIds = new Set(state.preferences.sessionTags[session.name] || []);
  refs.sessionTagsList.replaceChildren();
  if (!state.preferences.tags.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-settings-empty';
    empty.textContent = t('tag.noneHint');
    refs.sessionTagsList.append(empty);
  } else {
    for (const tag of state.preferences.tags) {
      const row = document.createElement('label');
      row.className = 'tag-check-row';
      const dot = document.createElement('span');
      dot.className = 'tag-check-dot';
      dot.style.setProperty('--tag-color', tagColor(tag));
      const name = document.createElement('span');
      name.className = 'tag-check-name';
      name.textContent = tag.name;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'tag';
      input.value = tag.id;
      input.checked = selectedIds.has(tag.id);
      row.append(dot, name, input);
      refs.sessionTagsList.append(row);
    }
  }
  openModal(refs.sessionTagsModal, refs.sessionTagsList.querySelector('input'));
}

function openNewSessionModal() {
  if (!requireLocal()) return;
  refs.sessionForm.reset();
  const session = selectedSession();
  refs.sessionCwdInput.value = session?.path || '';
  openModal(refs.sessionModal, refs.sessionNameInput);
}

function openRenameModal(session = selectedSession()) {
  if (!session) return;
  refs.renameModal.dataset.sessionId = session.id;
  refs.renameModal.dataset.oldName = session.name;
  refs.renameInput.value = session.name;
  openModal(refs.renameModal, refs.renameInput);
  refs.renameInput.select();
}

function openKillModal(session = selectedSession()) {
  if (!session) return;
  refs.killModal.dataset.sessionId = session.id;
  refs.killModal.dataset.sessionName = session.name;
  refs.killMessage.textContent = t('session.killMessage', { name: session.name, count: session.paneCount || 0 });
  openModal(refs.killModal, refs.confirmKillButton);
}

function suggestCopyName(name) {
  const base = String(name || 'session').replace(/-copy(-\d+)?$/, '');
  const taken = new Set(state.sessions.map((session) => session.name));
  let candidate = `${base}-copy`;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${base}-copy-${counter++}`;
  return candidate.slice(0, 80);
}

function openDuplicateModal(session = selectedSession()) {
  if (!session) return;
  refs.duplicateModal.dataset.sessionId = session.id;
  refs.duplicateModal.dataset.sessionName = session.name;
  refs.duplicateMessage.textContent = t('session.duplicateMessage', { name: session.name });
  refs.duplicateInput.value = suggestCopyName(session.name);
  openModal(refs.duplicateModal, refs.duplicateInput);
  refs.duplicateInput.select();
}

function openSettings() {
  renderThemeControls();
  renderLanguageControls();
  renderTagSettings();
  refs.keepAwakeToggle.checked = state.preferences.keepAwake === true;
  refs.autoShareToggle.checked = state.preferences.autoShare === true;
  renderSnapshotSettings();
  refreshSnapshotHealth();
  renderTerminalAppearanceSettings();
  renderPasteGuardSettings();
  renderTmuxSettings();
  openModal(refs.settingsModal, refs.settingsModal.querySelector('.theme-card'));
}

const IMPORT_TOOLS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'idea', label: 'IntelliJ IDEA' },
  { id: 'vscode', label: 'VS Code' },
];

let importEntries = [];

function uniqueSessionName(base, used) {
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${used.size}`;
}

async function openImportModal(tool) {
  const meta = IMPORT_TOOLS.find((item) => item.id === tool) || { id: tool, label: tool };
  refs.importTitle.textContent = t('import.title', { tool: meta.label });
  refs.importSubtitle.textContent = t('import.scanning');
  refs.importList.replaceChildren();
  importEntries = [];
  openModal(refs.importModal, refs.importCreateButton);

  let discovered = [];
  try {
    discovered = await api.discoverCodebases();
  } catch (error) {
    refs.importSubtitle.textContent = friendlyError(error);
    return;
  }
  importEntries = (discovered || []).filter((entry) => entry.sources.includes(tool));
  renderImportList();
}

function renderImportList() {
  refs.importList.replaceChildren();
  if (!importEntries.length) {
    refs.importSubtitle.textContent = t('import.noneFound');
    const empty = document.createElement('p');
    empty.className = 'import-empty';
    empty.textContent = t('import.noRecentProjects');
    refs.importList.append(empty);
    return;
  }
  refs.importSubtitle.textContent = t('import.foundCount', { count: importEntries.length });
  const existing = new Set(state.sessions.map((session) => session.name));
  refs.importList.replaceChildren(...importEntries.map((entry, index) => {
    const row = document.createElement('label');
    row.className = 'import-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.index = String(index);
    checkbox.checked = !existing.has(entry.name);
    const text = document.createElement('div');
    text.className = 'import-row-text';
    const name = document.createElement('div');
    name.className = 'import-row-name';
    name.textContent = entry.name;
    if (existing.has(entry.name)) {
      const badge = document.createElement('span');
      badge.className = 'import-row-badge';
      badge.textContent = t('import.exists');
      name.append(badge);
    }
    const dir = document.createElement('div');
    dir.className = 'import-row-path';
    dir.textContent = entry.path;
    text.append(name, dir);
    row.append(checkbox, text);
    return row;
  }));
}

function toggleAllImports() {
  const checkboxes = [...refs.importList.querySelectorAll('input[type="checkbox"]')];
  const nextChecked = !checkboxes.every((checkbox) => checkbox.checked);
  for (const checkbox of checkboxes) checkbox.checked = nextChecked;
}

async function runImport() {
  const checkboxes = [...refs.importList.querySelectorAll('input[type="checkbox"]:checked')];
  const chosen = checkboxes.map((checkbox) => importEntries[Number(checkbox.dataset.index)]).filter(Boolean);
  if (!chosen.length) { toast(t('import.noneSelected')); return; }

  const used = new Set(state.sessions.map((session) => session.name));
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of chosen) {
    const name = uniqueSessionName(entry.name, used);
    try {
      await api.createSession({ name, cwd: entry.path, startupCommand: '' });
      used.add(name);
      created += 1;
    } catch (error) {
      if (String(error && error.message || '').includes('已存在')) skipped += 1;
      else failed += 1;
    }
  }

  closeModal(refs.importModal);
  await refreshSessions();
  const parts = [t('import.created', { count: created })];
  if (skipped) parts.push(t('import.skipped', { count: skipped }));
  if (failed) parts.push(t('import.failed', { count: failed }));
  toast(parts.join(t('import.partsSeparator')), failed ? 'error' : 'info');
}

let mobileAccessBusy = false;
let mobileAccessSession = null;

function syncMobileAccessHeading() {
  if (mobileAccessSession) {
    refs.mobileAccessTitle.textContent = t('mobile.shareTitle', { name: mobileAccessSession.name });
    refs.mobileAccessSubtitle.textContent = t('mobile.shareSubtitle');
  } else {
    refs.mobileAccessTitle.textContent = t('rail.share');
    refs.mobileAccessSubtitle.textContent = t('modal.shareSubtitle');
  }
}

function openMobileAccessModal(session = null) {
  mobileAccessSession = session ? { id: session.id, name: session.name } : null;
  syncMobileAccessHeading();
  openModal(refs.mobileAccessModal);
  loadMobileAccessStatus();
}

async function loadMobileAccessStatus() {
  renderMobileAccessLoading();
  try {
    const status = await api.webStatus(mobileAccessSession?.name);
    renderMobileAccess(status);
  } catch (error) {
    renderMobileAccessError(error);
  }
}

function renderMobileAccessLoading() {
  const loading = document.createElement('div');
  loading.className = 'mobile-access-loading';
  loading.textContent = t('mobile.checking');
  refs.mobileAccessBody.replaceChildren(loading);
}

function renderMobileAccessError(error) {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-access-empty';
  const message = document.createElement('p');
  message.textContent = friendlyError(error);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'button';
  retry.textContent = t('action.retry');
  retry.addEventListener('click', loadMobileAccessStatus);
  wrap.append(message, retry);
  refs.mobileAccessBody.replaceChildren(wrap);
}

function renderMobileAccessIdle() {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-access-empty';
  const message = document.createElement('p');
  message.textContent = mobileAccessSession
    ? t('mobile.shareIdleMessage', { name: mobileAccessSession.name })
    : t('mobile.idleMessage');
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'button primary';
  start.textContent = t('mobile.start');
  start.addEventListener('click', startMobileAccess);
  wrap.append(message, start);
  refs.mobileAccessBody.replaceChildren(wrap);
}

function renderMobileAccessStarting() {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-access-empty';
  const message = document.createElement('p');
  message.textContent = mobileAccessSession
    ? t('mobile.shareIdleMessage', { name: mobileAccessSession.name })
    : t('mobile.idleMessage');
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'button primary';
  start.textContent = t('mobile.starting');
  start.disabled = true;
  wrap.append(message, start);
  refs.mobileAccessBody.replaceChildren(wrap);
}

async function startMobileAccess() {
  if (mobileAccessBusy) return;
  mobileAccessBusy = true;
  renderMobileAccessStarting();
  try {
    const status = await api.webStart(mobileAccessSession?.name);
    renderMobileAccess(status);
  } catch (error) {
    toast(friendlyError(error), 'error');
    renderMobileAccessIdle();
  } finally {
    mobileAccessBusy = false;
  }
}

async function stopMobileAccess() {
  if (mobileAccessBusy) return;
  mobileAccessBusy = true;
  try {
    const status = await api.webStop();
    renderMobileAccess(status);
    toast(t('toast.webStopped'));
  } catch (error) {
    toast(friendlyError(error), 'error');
  } finally {
    mobileAccessBusy = false;
  }
}

function mobileAccessCards(urls) {
  const tailscale = urls.find((entry) => entry.kind === 'tailscale');
  const lan = urls.find((entry) => entry.kind === 'lan');
  const other = urls.find((entry) => entry.kind === 'other');
  const cards = [];
  if (tailscale) cards.push({ entry: tailscale, title: 'Tailscale', subtitle: t('mobile.tailscaleSubtitle') });
  if (lan) cards.push({ entry: lan, title: t('mobile.lan'), subtitle: t('mobile.lanSubtitle') });
  if (!tailscale && !lan && other) cards.push({ entry: other, title: t('mobile.localNetwork'), subtitle: t('mobile.localNetworkSubtitle') });
  return { cards, hasTailscale: Boolean(tailscale), hasLan: Boolean(lan) };
}

function createMobileAccessCard(card) {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-access-card';
  const title = document.createElement('h4');
  title.textContent = card.title;
  const subtitle = document.createElement('p');
  subtitle.className = 'mobile-access-card-sub';
  subtitle.textContent = card.subtitle;
  const qrFrame = document.createElement('div');
  qrFrame.className = 'mobile-access-qr';
  const img = document.createElement('img');
  img.alt = t('mobile.qrAlt', { title: card.title });
  qrFrame.append(img);
  const urlButton = document.createElement('button');
  urlButton.type = 'button';
  urlButton.className = 'mobile-access-url';
  urlButton.textContent = card.entry.url;
  urlButton.title = t('mobile.clickToCopy');
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'button mobile-access-copy';
  copyButton.textContent = t('action.copyLink');
  const copyLink = async (trigger) => {
    try {
      await navigator.clipboard.writeText(card.entry.url);
      const original = trigger.textContent;
      trigger.textContent = t('action.copied');
      setTimeout(() => { trigger.textContent = original; }, 1400);
    } catch (error) { toast(friendlyError(error), 'error'); }
  };
  urlButton.addEventListener('click', () => copyLink(urlButton));
  copyButton.addEventListener('click', () => copyLink(copyButton));
  wrap.append(title, subtitle, qrFrame, urlButton, copyButton);
  QRCode.toDataURL(card.entry.url, { width: 220, margin: 1 })
    .then((dataUrl) => { img.src = dataUrl; })
    .catch(() => { qrFrame.textContent = t('mobile.qrFailed'); });
  return wrap;
}

function renderMobileAccessRunning(status) {
  const wrap = document.createElement('div');

  const statusRow = document.createElement('div');
  statusRow.className = 'mobile-access-status';
  const dot = document.createElement('span');
  dot.className = 'status-dot ok';
  const text = document.createElement('span');
  text.textContent = `${t('mobile.running', { port: status.port })}${status.external ? t('mobile.externalSuffix') : ''}`;
  statusRow.append(dot, text);
  wrap.append(statusRow);

  const { cards, hasTailscale, hasLan } = mobileAccessCards(status.urls || []);
  if (cards.length) {
    const cardRow = document.createElement('div');
    cardRow.className = 'mobile-access-cards';
    cardRow.append(...cards.map(createMobileAccessCard));
    wrap.append(cardRow);
    if (!hasTailscale && hasLan) {
      const hint = document.createElement('p');
      hint.className = 'mobile-access-hint';
      hint.textContent = t('mobile.noTailscale');
      wrap.append(hint);
    }
  } else {
    const empty = document.createElement('p');
    empty.className = 'mobile-access-hint';
    empty.textContent = t('mobile.noNetwork');
    wrap.append(empty);
  }

  const footer = document.createElement('div');
  footer.className = 'mobile-access-footer';
  if (status.external) {
    const note = document.createElement('p');
    note.className = 'mobile-access-hint';
    note.textContent = t('mobile.externalHint');
    footer.append(note);
  } else {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'button mobile-access-stop';
    stop.textContent = t('mobile.stop');
    stop.addEventListener('click', stopMobileAccess);
    footer.append(stop);
  }
  wrap.append(footer);

  refs.mobileAccessBody.replaceChildren(wrap);
}

function renderMobileAccess(status) {
  if (status.running) renderMobileAccessRunning(status);
  else renderMobileAccessIdle();
}

function focusSessionSearch() {
  const focus = () => { refs.sessionSearch.focus(); refs.sessionSearch.select(); };
  if (state.view.kind === 'all') focus();
  else setView({ kind: 'all' }).then(focus);
}

function commands() {
  const session = selectedSession();
  return [
    { id: 'new', title: t('action.newSession'), subtitle: t('palette.newSessionSubtitle'), shortcut: '⌘N', icon: 'plus', action: openNewSessionModal },
    { id: 'refresh', title: t('action.refreshSessions'), subtitle: t('palette.refreshSubtitle'), shortcut: '⌘R', icon: 'refresh', action: () => refreshSessions({ notify: true }) },
    { id: 'search', title: t('action.searchSessions'), subtitle: t('palette.searchSubtitle'), shortcut: '⌘F', icon: 'search', action: focusSessionSearch },
    { id: 'files', title: state.files.open ? t('palette.hideFiles') : t('palette.showFiles'), subtitle: t('palette.filesSubtitle'), shortcut: '⌘B', icon: 'sidebar', action: toggleFileBrowser },
    { id: 'all', title: t('palette.showAll'), subtitle: t('palette.showAllSubtitle'), icon: 'terminal', action: () => setView({ kind: 'all' }) },
    { id: 'favorites', title: t('palette.openFavorites'), subtitle: t('palette.favoritesSubtitle'), icon: 'star', action: () => setView({ kind: 'favorites' }) },
    { id: 'newTag', title: t('tag.new'), subtitle: t('palette.newTagSubtitle'), icon: 'tag', action: () => { if (requireLocal()) openTagEditor(); } },
    { id: 'theme', title: t('theme.toggle'), subtitle: t('palette.themeSubtitle'), shortcut: '⌘⇧T', keywords: ['light', 'dark'], icon: 'palette', action: cycleTheme },
    { id: 'settings', title: t('palette.openSettings'), subtitle: t('palette.settingsSubtitle'), icon: 'settings', action: openSettings },
    ...IMPORT_TOOLS.map((tool) => ({
      id: `import-${tool.id}`,
      title: t('import.title', { tool: tool.label }),
      subtitle: t('palette.importSubtitle'),
      keywords: ['import', 'codebase', '导入', '代码库', '项目', tool.id, tool.label.toLowerCase()],
      icon: 'copy',
      action: () => openImportModal(tool.id),
    })),
    ...(session && !isRemoteActive() ? [{ id: 'clearBuffer', title: t('terminal.clearBuffer'), subtitle: t('palette.clearBufferSubtitle'), shortcut: '⌘K', keywords: ['clear', 'cls', '清屏', '清空'], icon: 'trash', action: clearTerminalBuffer }] : []),
    { id: 'globalSearch', title: t('palette.globalSearch'), subtitle: t('palette.globalSearchSubtitle'), shortcut: '⌘F', keywords: ['search', 'find', 'grep', '搜索', '查找'], icon: 'search', action: openGlobalSearch },
    { id: 'mobileAccess', title: t('action.mobileAccess'), subtitle: t('palette.mobileAccessSubtitle'), keywords: ['mobile', 'web', 'qrcode', '二维码'], icon: 'phone', action: openMobileAccessModal },
    ...(session ? [
      { id: 'shareSession', title: t('palette.shareSessionTitle', { name: session.name }), subtitle: t('palette.shareSessionSubtitle'), keywords: ['share', 'link', '分享', '链接'], icon: 'external', action: () => openMobileAccessModal(session) },
      { id: 'splitV', title: t('palette.splitVertical'), subtitle: t('palette.splitVerticalSubtitle'), shortcut: '⌘D', icon: 'panes', action: () => splitActivePane('vertical') },
      { id: 'splitH', title: t('palette.splitHorizontal'), subtitle: t('palette.splitHorizontalSubtitle'), shortcut: '⌘⇧D', icon: 'panes', action: () => splitActivePane('horizontal') },
      ...(activeWindowPanes().length >= 2 || activeWindow()?.zoomed ? [
        { id: 'zoomPane', title: activeWindow()?.zoomed ? t('palette.unzoomPane') : t('palette.zoomPane'), subtitle: t('palette.zoomPaneSubtitle'), shortcut: '⌘⇧↩', keywords: ['zoom', 'maximize', '最大化', '全屏'], icon: 'panes', action: toggleZoomActivePane },
        { id: 'broadcast', title: activeWindow()?.synchronized ? t('palette.broadcastOff') : t('palette.broadcastOn'), subtitle: t('palette.broadcastSubtitle'), keywords: ['broadcast', 'synchronize', 'sync', '广播', '同步'], icon: 'terminal', action: toggleBroadcastInput },
        { id: 'closePane', title: t('palette.closePane'), subtitle: t('palette.closePaneSubtitle'), icon: 'close', action: closeActivePane },
      ] : []),
      { id: 'rename', title: t('palette.renameTitle', { name: session.name }), subtitle: t('palette.renameSubtitle'), icon: 'edit', action: () => openRenameModal(session) },
      { id: 'duplicate', title: t('palette.duplicateTitle', { name: session.name }), subtitle: t('palette.duplicateSubtitle'), icon: 'copy', action: () => openDuplicateModal(session) },
      { id: 'sessionTags', title: t('palette.manageTagsTitle', { name: session.name }), subtitle: t('palette.manageTagsSubtitle'), icon: 'tag', action: () => openSessionTagsModal(session) },
      { id: 'favorite', title: viewPrefs().favorites.includes(session.name) ? t('palette.unfavoriteCurrent') : t('palette.favoriteCurrent'), subtitle: session.name, icon: 'star', action: () => toggleSelectedFavorite() },
      { id: 'kill', title: t('palette.killTitle', { name: session.name }), subtitle: t('palette.killSubtitle'), icon: 'trash', action: () => openKillModal(session) },
    ] : []),
  ];
}

function openCommandPalette() {
  refs.commandInput.value = '';
  state.commandIndex = 0;
  refs.commandPalette.classList.remove('hidden');
  renderCommandResults();
  requestAnimationFrame(() => refs.commandInput.focus());
}

function closeCommandPalette() { refs.commandPalette.classList.add('hidden'); }

function filteredCommands() { return searchCommands(commands(), refs.commandInput.value); }

function renderCommandResults() {
  const items = filteredCommands();
  if (state.commandIndex >= items.length) state.commandIndex = Math.max(0, items.length - 1);
  refs.commandResults.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'command-empty';
    empty.textContent = t('palette.noMatch');
    refs.commandResults.append(empty);
    return;
  }
  items.forEach((command, index) => {
    const button = document.createElement('button');
    button.className = `command-result ${index === state.commandIndex ? 'selected' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === state.commandIndex));
    const iconBox = document.createElement('span');
    iconBox.className = 'command-result-icon';
    iconBox.innerHTML = icon(command.icon || 'command', 16);
    const copy = document.createElement('span');
    copy.className = 'command-result-copy';
    const title = document.createElement('span');
    title.className = 'command-result-title';
    title.textContent = command.title;
    const subtitle = document.createElement('span');
    subtitle.className = 'command-result-subtitle';
    subtitle.textContent = command.subtitle || '';
    copy.append(title, subtitle);
    button.append(iconBox, copy);
    if (command.shortcut) {
      const shortcut = document.createElement('kbd');
      shortcut.textContent = command.shortcut;
      button.append(shortcut);
    }
    button.addEventListener('mouseenter', () => {
      state.commandIndex = index;
      [...refs.commandResults.querySelectorAll('.command-result')].forEach((item, itemIndex) => {
        item.classList.toggle('selected', itemIndex === index);
        item.setAttribute('aria-selected', String(itemIndex === index));
      });
    });
    button.addEventListener('click', () => executeCommand(command));
    refs.commandResults.append(button);
  });
  refs.commandResults.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
}

function executeCommand(command = filteredCommands()[state.commandIndex]) {
  if (!command) return;
  closeCommandPalette();
  Promise.resolve(command.action()).catch((error) => toast(friendlyError(error), 'error'));
}

function cycleTheme() {
  const modes = ['light', 'dark', 'system'];
  setThemePreference(modes[(modes.indexOf(state.preferences.theme) + 1) % modes.length]);
}

async function toggleFavorite(session) {
  if (!session) return;
  if (!requireLocal()) return;
  state.preferences = await api.toggleFavorite(session.name);
  renderTagRail();
  renderSessionList();
  renderSessionTabs();
  if (state.view.kind === 'favorites' && !state.preferences.favorites.includes(session.name)) {
    await setView(state.view);
  }
}

async function toggleSelectedFavorite() {
  await toggleFavorite(selectedSession());
}

// ── Session sources (local + remote takeover) ────────────────────────────────

function isRemoteActive() {
  return state.source.kind === 'remote';
}

function activeConnection() {
  if (!isRemoteActive()) return null;
  return state.remoteConnections.find((connection) => connection.id === state.source.id) || null;
}

// The api backing the active source. Terminal attach, session listing and detail
// all route through this; management ops stay on localApi (and are gated off for
// remote by requireLocal).
function sessionApi() {
  if (!isRemoteActive()) return localApi;
  return remoteApis.get(state.source.id) || localApi;
}

function ensureRemoteApi(connection) {
  let remote = remoteApis.get(connection.id);
  // The stored base/token can change under a live id (host moved networks, token
  // rotated); a cached api built from the old values would keep talking to the
  // dead address forever.
  if (remote && (remote.base !== String(connection.base || '').replace(/\/+$/, '') || remote.token !== connection.token)) {
    remote.dispose();
    remoteApis.delete(connection.id);
    remote = null;
  }
  if (!remote) {
    remote = new RemoteApi({ base: connection.base, token: connection.token });
    remoteApis.set(connection.id, remote);
  }
  return remote;
}

// How long a reachability answer stays trustworthy. Short enough that a host
// that just came back shows up on the next menu open, long enough that opening
// the menu twice in a row does not re-ping.
const PROBE_FRESH_MS = 8000;

// Ping every saved host in parallel and repaint the rows as answers land, so the
// popover opens instantly and then fills in "online 3 ms" / "unreachable"
// instead of making the user discover a dead host by clicking it and waiting.
function probeRemoteHosts({ force = false } = {}) {
  const now = Date.now();
  for (const connection of state.remoteConnections) {
    const cached = state.remoteProbes.get(connection.id);
    if (cached && cached.status === 'checking') continue;
    if (!force && cached && now - cached.at < PROBE_FRESH_MS) continue;
    state.remoteProbes.set(connection.id, { status: 'checking', at: now });
    ensureRemoteApi(connection).probe().then((result) => {
      state.remoteProbes.set(connection.id, {
        status: result.ok ? 'online' : 'offline',
        ms: result.ms,
        sessions: result.sessions,
        error: result.error,
        at: Date.now(),
      });
      paintRemoteProbes();
    });
  }
  paintRemoteProbes();
}

function probeStatusText(entry) {
  if (!entry) return '';
  if (entry.status === 'checking') return t('source.checking');
  if (entry.status === 'online') {
    return Number.isFinite(entry.ms) ? t('source.onlineLatency', { ms: entry.ms }) : t('source.online');
  }
  return t('source.unreachable');
}

// In-place update so a probe landing while the menu is open does not rebuild the
// rows under the pointer.
function paintRemoteProbes() {
  const popover = refs.sourcePopover;
  if (!popover || popover.classList.contains('hidden')) return;
  for (const row of popover.querySelectorAll('.source-row[data-connection-id]')) {
    const entry = state.remoteProbes.get(row.dataset.connectionId);
    const dot = row.querySelector('.source-row-dot');
    const status = row.querySelector('.source-row-status');
    const main = row.querySelector('.source-row-main');
    if (dot) dot.dataset.status = entry ? entry.status : 'unknown';
    if (status) status.textContent = probeStatusText(entry);
    if (main) main.title = entry?.error || '';
  }
}

// Guard for mutating actions that only make sense on the local machine. Remote
// takeover is deliberately read-only in this first cut.
function requireLocal() {
  if (isRemoteActive()) { toast(t('remote.readOnly')); return false; }
  return true;
}

function loadRemoteConnections() {
  state.remoteConnections = state.preferences.remoteConnections || [];
}

// One-time migration of remote connections saved by an earlier build in
// localStorage into the main-process preferences store.
async function migrateLegacyRemoteConnections() {
  const legacy = remoteStore.loadLegacyConnections();
  if (!legacy.length) return;
  for (const entry of legacy) {
    try {
      const { preferences } = await api.addRemote(entry);
      state.preferences = preferences;
    } catch { /* skip malformed legacy entry */ }
  }
  remoteStore.clearLegacy();
  loadRemoteConnections();
}

function sourceStatusLabel() {
  if (!isRemoteActive()) return '';
  if (state.sourceStatus === 'offline') return t('source.offline');
  if (state.sourceStatus === 'connecting') return t('source.connecting');
  return t('source.online');
}

function renderSourceBar() {
  if (!refs.sourceButton) return;
  const connection = activeConnection();
  const localMode = !isRemoteActive();
  refs.sourceIcon.innerHTML = icon(localMode ? 'laptop' : 'external', 16);
  refs.sourceLabel.textContent = localMode ? t('source.local') : (connection?.label || t('source.local'));
  refs.sourceButton.title = localMode ? t('source.localHint') : `${connection?.base || ''} · ${sourceStatusLabel()}`;
  refs.sourceCaret.innerHTML = icon('chevron', 14);
  refs.sourceBar.dataset.remote = String(!localMode);
  refs.sourceStatusDot.dataset.status = localMode ? 'local' : state.sourceStatus;
  refs.sourceStatusDot.hidden = localMode;
  // New-session is local-only; hide the affordance while a remote source is active.
  if (refs.newSessionButton) refs.newSessionButton.hidden = !localMode;
}

function closeSourcePopover() {
  refs.sourcePopover?.classList.add('hidden');
  refs.sourceButton?.setAttribute('aria-expanded', 'false');
}

function sourceRow({ iconName, label, sublabel, active, connectionId, onClick, onRemove, reshare, onToggleReshare }) {
  const row = document.createElement('div');
  row.className = `source-row${active ? ' active' : ''}`;
  if (connectionId) row.dataset.connectionId = connectionId;
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'source-row-main';
  main.innerHTML = icon(iconName, 15);
  const text = document.createElement('span');
  text.className = 'source-row-text';
  const name = document.createElement('span');
  name.className = 'source-row-name';
  name.textContent = label;
  text.append(name);
  if (sublabel) {
    const sub = document.createElement('span');
    sub.className = 'source-row-sub';
    const subText = document.createElement('span');
    subText.className = 'source-row-sub-text';
    subText.textContent = sublabel;
    sub.append(subText);
    if (connectionId) {
      const entry = state.remoteProbes.get(connectionId);
      const dot = document.createElement('span');
      dot.className = 'source-row-dot';
      dot.dataset.status = entry ? entry.status : 'unknown';
      const status = document.createElement('span');
      status.className = 'source-row-status';
      status.textContent = probeStatusText(entry);
      // A probe uses a tighter deadline than a real switch, so an unreachable
      // verdict is a hint, not a veto — the row stays clickable and says why.
      if (entry?.error) main.title = entry.error;
      sub.append(dot, status);
    }
    text.append(sub);
  }
  main.append(text);
  if (active) {
    const check = document.createElement('span');
    check.className = 'source-row-check';
    check.innerHTML = icon('check', 14);
    main.append(check);
  }
  main.addEventListener('click', onClick);
  row.append(main);
  if (onToggleReshare) {
    const reshareToggle = document.createElement('button');
    reshareToggle.type = 'button';
    reshareToggle.className = `source-row-reshare${reshare ? ' on' : ''}`;
    reshareToggle.title = reshare ? t('source.reshareOn') : t('source.reshareOff');
    reshareToggle.setAttribute('aria-label', t('source.reshareTitle'));
    reshareToggle.setAttribute('aria-pressed', String(Boolean(reshare)));
    reshareToggle.innerHTML = icon('external', 13);
    reshareToggle.addEventListener('click', (event) => { event.stopPropagation(); onToggleReshare(); });
    row.append(reshareToggle);
  }
  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'source-row-remove';
    remove.title = t('source.removeRemote');
    remove.setAttribute('aria-label', t('source.removeRemote'));
    remove.innerHTML = icon('close', 13);
    remove.addEventListener('click', (event) => { event.stopPropagation(); onRemove(); });
    row.append(remove);
  }
  return row;
}

function renderSourcePopover() {
  const popover = refs.sourcePopover;
  popover.replaceChildren();
  popover.append(sourceRow({
    iconName: 'laptop',
    label: t('source.local'),
    sublabel: t('source.localHint'),
    active: !isRemoteActive(),
    onClick: () => switchSource({ kind: 'local', id: 'local' }),
  }));
  for (const connection of state.remoteConnections) {
    popover.append(sourceRow({
      iconName: 'external',
      label: connection.label,
      sublabel: connection.base,
      active: isRemoteActive() && state.source.id === connection.id,
      connectionId: connection.id,
      onClick: () => switchSource({ kind: 'remote', id: connection.id }),
      onRemove: () => removeRemoteConnection(connection),
      reshare: connection.reshare === true,
      onToggleReshare: () => toggleRemoteReshare(connection),
    }));
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'source-add';
  add.innerHTML = `${icon('plus', 15)}<span>${t('source.addRemote')}</span>`;
  add.addEventListener('click', () => { closeSourcePopover(); openRemoteModal(); });
  popover.append(add);
}

function toggleSourcePopover() {
  if (!refs.sourcePopover.classList.contains('hidden')) { closeSourcePopover(); return; }
  closeFloatingMenus();
  renderSourcePopover();
  refs.sourcePopover.classList.remove('hidden');
  refs.sourceButton.setAttribute('aria-expanded', 'true');
  placePopover(refs.sourcePopover, refs.sourceButton);
  probeRemoteHosts();
}

async function switchSource(source) {
  if (source.kind === state.source.kind && source.id === state.source.id) { closeSourcePopover(); return; }
  closeSourcePopover();
  if (source.kind === 'remote') {
    const connection = state.remoteConnections.find((entry) => entry.id === source.id);
    if (!connection) return;
    ensureRemoteApi(connection);
  }
  // Tear down the current attachment before repointing the terminal at the new
  // source so no stray data from the old session leaks in.
  selectionToken += 1;
  sourceToken += 1;
  try { await terminalView.detach(); } catch { /* nothing attached */ }
  state.source = source;
  state.remotePrefs = emptyViewPrefs();
  state.selectedSessionId = null;
  state.detail = { windows: [], panes: [] };
  state.sessions = [];
  state.query = '';
  if (refs.sessionSearch) refs.sessionSearch.value = '';
  state.view = { kind: 'all' };
  state.restorePending = true;
  state.sourceStatus = source.kind === 'remote' ? 'connecting' : 'online';
  terminalView.setApi(sessionApi());
  renderSourceBar();
  renderTagRail();
  renderSessionList();
  renderSessionTabs();
  renderWorkspace();
  await refreshSessions({ initial: true });
}

function openRemoteModal() {
  refs.remoteLabelInput.value = '';
  refs.remoteUrlInput.value = '';
  refs.remoteTokenInput.value = '';
  openModal(refs.remoteModal, refs.remoteUrlInput);
}

async function removeRemoteConnection(connection) {
  if (!window.confirm(t('remote.removeConfirm', { name: connection.label }))) return;
  const wasActive = isRemoteActive() && state.source.id === connection.id;
  try {
    state.preferences = await api.removeRemote(connection.id);
  } catch (error) {
    toast(friendlyError(error), 'error');
    return;
  }
  loadRemoteConnections();
  const remote = remoteApis.get(connection.id);
  if (remote) { remote.dispose(); remoteApis.delete(connection.id); }
  if (wasActive) await switchSource({ kind: 'local', id: 'local' });
  else if (!refs.sourcePopover.classList.contains('hidden')) renderSourcePopover();
  renderSourceBar();
}

async function toggleRemoteReshare(connection) {
  try {
    state.preferences = await api.setRemoteReshare({ id: connection.id, reshare: !connection.reshare });
  } catch (error) {
    toast(friendlyError(error), 'error');
    return;
  }
  loadRemoteConnections();
  if (!refs.sourcePopover.classList.contains('hidden')) renderSourcePopover();
}

function bindEvents() {
  setupPaneMouse();
  setupTerminalFileDrop();
  setupFileBrowserDrop();
  setupGlobalSearch();
  refs.refreshButton.addEventListener('click', () => refreshSessions({ notify: true }));
  refs.emptyRefreshButton.addEventListener('click', () => refreshSessions({ initial: !state.systemStatus.installed, notify: true }));
  refs.newSessionButton.addEventListener('click', openNewSessionModal);
  refs.emptyNewButton.addEventListener('click', openNewSessionModal);
  refs.emptyAllButton.addEventListener('click', () => setView({ kind: 'all' }));
  // The rail lists the viewed host's tags, so a tag created here while a remote
  // is on screen would vanish from it. Settings (always this machine) still can.
  refs.newTagButton.addEventListener('click', () => { if (requireLocal()) openTagEditor(); });
  refs.tagRailToggleButton.addEventListener('click', () => setTagRailExpanded(!state.preferences.tagRailExpanded));
  refs.settingsNewTagButton.addEventListener('click', () => openTagEditor());
  refs.tagExportButton.addEventListener('click', exportTags);
  refs.tagImportButton.addEventListener('click', importTags);
  refs.keepAwakeToggle.addEventListener('change', () => setKeepAwakePreference(refs.keepAwakeToggle.checked));
  refs.autoShareToggle.addEventListener('change', () => setAutoSharePreference(refs.autoShareToggle.checked));
  refs.broadcastFlag?.addEventListener('click', toggleBroadcastInput);
  refs.tmuxResetButton.addEventListener('click', resetTmuxSettings);
  refs.tmuxAdvancedApplyButton.addEventListener('click', applyAdvancedTmuxSettings);
  bindTerminalAppearanceInputs();
  bindPasteGuardInputs();
  refs.confirmPasteButton?.addEventListener('click', () => settlePasteConfirm(true));
  refs.emptyInstallButton.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('brew install tmux'); toast(t('toast.copiedInstallCmd')); }
    catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.sessionSearch.addEventListener('input', () => { state.query = refs.sessionSearch.value; renderSessionList(); });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView({ kind: button.dataset.view })));
  refs.settingsButton.addEventListener('click', openSettings);
  refs.snapshotHealthButton.addEventListener('click', openSnapshotPanel);
  refs.snapshotOpenButton.addEventListener('click', openSnapshotPanel);
  refs.snapshotSaveButton.addEventListener('click', runSnapshotSave);
  refs.snapshotRestoreButton.addEventListener('click', runSnapshotRestore);
  refs.snapshotRevealButton.addEventListener('click', runSnapshotReveal);
  refs.snapshotEnabledToggle.addEventListener('change', (event) => saveSnapshotSettings({ enabled: event.target.checked }));
  refs.snapshotAutoRestoreToggle.addEventListener('change', (event) => saveSnapshotSettings({ autoRestore: event.target.checked }));
  refs.snapshotRepairToggle.addEventListener('change', (event) => saveSnapshotSettings({ repairCwd: event.target.checked }));
  refs.snapshotIntervalInput.addEventListener('change', (event) => {
    const minutes = Math.min(60, Math.max(1, Math.round(Number(event.target.value) || 3)));
    event.target.value = String(minutes);
    saveSnapshotSettings({ intervalMinutes: minutes });
  });
  refs.sourceButton.addEventListener('click', toggleSourcePopover);
  // Warm the reachability check on hover so the menu is already decided by the
  // time it opens (a LAN probe answers in ~30ms; the pointer takes longer).
  refs.sourceButton.addEventListener('pointerenter', () => probeRemoteHosts());
  refs.remoteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = refs.remoteForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const { preferences, connection } = await api.addRemote({
        label: refs.remoteLabelInput.value,
        url: refs.remoteUrlInput.value,
        token: refs.remoteTokenInput.value,
      });
      state.preferences = preferences;
      loadRemoteConnections();
      closeModal(refs.remoteModal);
      await switchSource({ kind: 'remote', id: connection.id });
      if (state.sourceStatus === 'offline') toast(t('remote.offlineHint'), 'error');
      else toast(t('remote.connected', { name: connection.label }));
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { submit.disabled = false; }
  });
  refs.commandHint.addEventListener('click', openCommandPalette);
  refs.themeButton.addEventListener('click', () => {
    if (!refs.themePopover.classList.contains('hidden')) return closeFloatingMenus();
    closeFloatingMenus();
    renderThemeControls();
    placePopover(refs.themePopover, refs.themeButton);
  });
  refs.sessionMenuButton.addEventListener('click', () => {
    const session = selectedSession();
    if (session) openSessionMenu(session, refs.sessionMenuButton);
  });
  refs.panePicker.addEventListener('change', async () => {
    if (!requireLocal()) return;
    try { await api.selectPane(refs.panePicker.value); await refreshDetail(); terminalView.focus(); }
    catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.reconnectButton.addEventListener('click', () => {
    const session = selectedSession();
    if (!session) return;
    refs.terminalReconnect.classList.add('hidden');
    terminalView.attach(session.id)
      .then(() => { refs.workspaceStatus.textContent = t('workspace.reconnected'); })
      .catch((error) => { refs.terminalReconnect.classList.remove('hidden'); toast(friendlyError(error), 'error'); });
  });

  refs.filesToggleButton.addEventListener('click', toggleFileBrowser);
  bindTagRailResizer();
  bindSidebarResizer();
  refs.fbCollapseButton.addEventListener('click', () => setFileBrowserOpen(false));
  refs.fbRefreshButton.addEventListener('click', () => { if (state.files.root) reloadFileTree(); else syncFileBrowser(true); });
  refs.fbUploadButton.addEventListener('click', () => {
    if (!state.files.root) { toast(t('terminal.dropNoSession'), 'error'); return; }
    pickFilesFor(state.files.root);
  });
  refs.fbRevealButton.addEventListener('click', async () => {
    if (!state.files.root) return;
    try { await api.revealFile(state.files.root); } catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.tagEditorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    ++tagActivationToken;
    const submit = refs.tagEditorForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const editingId = refs.tagEditorModal.dataset.tagId;
      const previousIds = new Set(state.preferences.tags.map((tag) => tag.id));
      state.preferences = editingId
        ? await api.renameTag({ id: editingId, name: refs.tagNameInput.value })
        : await api.createTag(refs.tagNameInput.value);
      closeModal(refs.tagEditorModal);
      renderTagSettings();
      renderTagRail();
      renderSessionList();
      renderSessionTabs();
      renderWorkspace();
      if (!editingId) {
        const created = state.preferences.tags.find((tag) => !previousIds.has(tag.id));
        if (created) await setView({ kind: 'tag', tagId: created.id });
      }
      toast(editingId ? t('toast.tagRenamed') : t('toast.tagCreated'));
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { submit.disabled = false; }
  });
  refs.sessionTagsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sessionName = refs.sessionTagsModal.dataset.sessionName;
    const tagIds = [...refs.sessionTagsList.querySelectorAll('input[name="tag"]:checked')].map((input) => input.value);
    try {
      state.preferences = await api.setSessionTags({ sessionName, tagIds });
      closeModal(refs.sessionTagsModal);
      renderTagSettings();
      renderTagRail();
      renderSessionList();
      await setView(state.view);
      toast(t('toast.sessionTagsUpdated'));
    } catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.confirmTagDeleteButton.addEventListener('click', async () => {
    ++tagActivationToken;
    const tagId = refs.tagDeleteModal.dataset.tagId;
    refs.confirmTagDeleteButton.disabled = true;
    try {
      const deletingCurrent = state.view.kind === 'tag' && state.view.tagId === tagId;
      state.preferences = await api.deleteTag(tagId);
      closeModal(refs.tagDeleteModal);
      renderTagSettings();
      if (deletingCurrent) await setView({ kind: 'all' });
      else {
        renderTagRail();
        renderSessionList();
        renderSessionTabs();
        renderWorkspace();
      }
      toast(t('toast.tagDeleted'));
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { refs.confirmTagDeleteButton.disabled = false; }
  });
  refs.duplicateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = refs.duplicateForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const created = await api.duplicateSession({
        source: refs.duplicateModal.dataset.sessionId,
        sourceName: refs.duplicateModal.dataset.sessionName,
        name: refs.duplicateInput.value,
      });
      state.preferences = await api.getPreferences();
      closeModal(refs.duplicateModal);
      await refreshSessions();
      const session = state.sessions.find((item) => item.id === created.id || item.name === created.name);
      if (session) await selectSession(session);
      toast(t('toast.duplicatedAs', { name: created.name }));
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { submit.disabled = false; }
  });

  refs.importSelectAll.addEventListener('click', toggleAllImports);
  refs.importCreateButton.addEventListener('click', runImport);
  refs.mobileAccessButton.addEventListener('click', () => openMobileAccessModal());

  refs.chooseDirectoryButton.addEventListener('click', async () => {
    try {
      const directory = await api.chooseDirectory();
      if (directory) refs.sessionCwdInput.value = directory;
    } catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.sessionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = refs.sessionForm.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const created = await api.createSession({
        name: refs.sessionNameInput.value,
        cwd: refs.sessionCwdInput.value,
        startupCommand: refs.startupCommandInput.value,
      });
      if (state.view.kind === 'tag') {
        state.preferences = await api.setSessionTags({ sessionName: created.name, tagIds: [state.view.tagId] });
      }
      closeModal(refs.sessionModal);
      await refreshSessions();
      const session = state.sessions.find((item) => item.id === created.id || item.name === created.name);
      if (session) await selectSession(session);
      toast(t('toast.sessionCreated', { name: created.name }));
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { submit.disabled = false; }
  });
  refs.renameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.renameSession({
        target: refs.renameModal.dataset.sessionId,
        oldName: refs.renameModal.dataset.oldName,
        name: refs.renameInput.value,
      });
      state.preferences = await api.getPreferences();
      closeModal(refs.renameModal);
      await refreshSessions();
      toast(t('toast.sessionRenamed'));
    } catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.confirmKillButton.addEventListener('click', async () => {
    const target = refs.killModal.dataset.sessionId;
    refs.confirmKillButton.disabled = true;
    try {
      if (target === state.selectedSessionId) await terminalView.detach();
      await api.killSession({ target, sessionName: refs.killModal.dataset.sessionName });
      state.preferences = await api.getPreferences();
      if (target === state.selectedSessionId) state.selectedSessionId = null;
      closeModal(refs.killModal);
      await refreshSessions();
      toast(t('toast.sessionClosed'));
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { refs.confirmKillButton.disabled = false; }
  });
  document.querySelectorAll('.modal-cancel').forEach((button) => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
  document.querySelectorAll('.modal-close').forEach((button) => button.addEventListener('click', () => closeModal(button.closest('.modal-backdrop'))));
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal(backdrop);
  }));

  refs.commandInput.addEventListener('input', () => { state.commandIndex = 0; renderCommandResults(); });
  refs.commandPalette.addEventListener('mousedown', (event) => { if (event.target === refs.commandPalette) closeCommandPalette(); });
  document.addEventListener('mousedown', (event) => {
    if (!refs.contextMenu.contains(event.target)
      && !refs.themePopover.contains(event.target)
      && !refs.sourcePopover.contains(event.target)
      && !refs.sourceButton.contains(event.target)) closeFloatingMenus();
  });
  window.addEventListener('keydown', handleKeyboard);
  systemTheme.addEventListener('change', () => { if (state.preferences.theme === 'system') applyCurrentTheme(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSessions({ poll: true }); });
  api.onAppCommand((command) => handleAppCommand(command));
  window.addEventListener('beforeunload', () => {
    clearInterval(pollTimer);
    terminalView?.dispose();
  });
}

const PANE_ARROW_DIRECTIONS = Object.freeze({
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
});

function handleKeyboard(event) {
  if (!refs.commandPalette.classList.contains('hidden')) {
    const items = filteredCommands();
    if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); state.commandIndex = Math.min(items.length - 1, state.commandIndex + 1); renderCommandResults(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); state.commandIndex = Math.max(0, state.commandIndex - 1); renderCommandResults(); }
    else if (event.key === 'Enter') { event.preventDefault(); executeCommand(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); }
    return;
  }
  const meta = event.metaKey || event.ctrlKey;
  // The search panel owns the keyboard while it is open — its input handles
  // arrows, Enter and Escape — so nothing behind it (Cmd+K especially) fires.
  if (state.search.open) {
    if (meta && !event.altKey && event.key.toLowerCase() === 'f') event.preventDefault();
    return;
  }
  if (meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    // iTerm muscle memory: Cmd+K clears the buffer. The command palette moved to
    // Cmd+Shift+P (and keeps Cmd+Shift+K).
    event.preventDefault();
    clearTerminalBuffer();
  } else if (meta && event.shiftKey && ['k', 'p'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    openCommandPalette();
  }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openNewSessionModal(); }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'f') {
    // Cmd+F searches every session's scrollback (see openGlobalSearch); the
    // session-list filter keeps Cmd+Shift+F and its always-visible field.
    event.preventDefault();
    if (event.shiftKey || isRemoteActive()) focusSessionSearch();
    else openGlobalSearch();
  } else if (meta && !event.altKey && event.key.toLowerCase() === 'g' && !isRemoteActive()) {
    event.preventDefault();
    stepPaneSearch(event.shiftKey ? 'forward' : 'backward');
  }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'r') { event.preventDefault(); refreshSessions({ notify: true }); }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleFileBrowser(); }
  else if (meta && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); cycleTheme(); }
  else if (meta && /^[1-9]$/.test(event.key)) {
    const windowInfo = state.detail.windows[Number(event.key) - 1];
    if (windowInfo) { event.preventDefault(); sessionApi().selectWindow(windowInfo.id).then(refreshDetail).catch((error) => toast(friendlyError(error), 'error')); }
  } else if (meta && event.shiftKey && !event.altKey && event.key === 'Enter') {
    // iTerm's Maximize Active Pane. Shift+Enter alone is a newline the terminal
    // view handles; adding Cmd makes it a window action instead.
    event.preventDefault();
    toggleZoomActivePane();
  } else if (event.metaKey && event.altKey && !event.shiftKey && PANE_ARROW_DIRECTIONS[event.key]) {
    // Cmd+Alt+arrow moves focus between splits (iTerm's pane navigation).
    event.preventDefault();
    navigateActivePane(PANE_ARROW_DIRECTIONS[event.key]);
  } else if (event.metaKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    && state.view.kind !== 'all' && selectedSession()) {
    event.preventDefault();
    // ⌘←/→ switches to the neighboring tab (terminal follows, like iTerm);
    // adding Shift moves the current tab within the manual order instead.
    if (event.shiftKey) moveSelectedTab(event.key === 'ArrowLeft' ? -1 : 1);
    else selectAdjacentTab(event.key === 'ArrowLeft' ? -1 : 1);
  } else if (event.metaKey && !event.altKey && !event.shiftKey
    && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    && viewPrefs().tags.length) {
    event.preventDefault();
    // ⌘↑/↓ switches between tags (jumps to the target tag's first session),
    // without triggering the recency reorder that clicking a tag does.
    selectAdjacentTagView(event.key === 'ArrowUp' ? -1 : 1);
  } else if (event.key === 'Escape') {
    closeFloatingMenus();
    const openModalElement = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')].pop();
    if (openModalElement) closeModal(openModalElement);
  }
}

function handleAppCommand(command) {
  if (command === 'new-session') openNewSessionModal();
  else if (command === 'command-palette') openCommandPalette();
  else if (command === 'refresh') refreshSessions({ notify: true });
  else if (command === 'search') focusSessionSearch();
  else if (command === 'split:vertical' || command === 'split:horizontal') {
    splitActivePane(command.slice('split:'.length));
  } else if (typeof command === 'string' && command.startsWith('import-codebases:')) {
    openImportModal(command.slice('import-codebases:'.length));
  }
}

// Split the attached session's active pane (tmux handles nesting, so repeated
// splits keep subdividing). The terminal reflects it since we attach to the
// whole window.
async function splitActivePane(orientation) {
  if (!requireLocal()) return;
  const session = selectedSession();
  if (!session) { toast(t('toast.noSession')); return; }
  try {
    await api.splitPane({ target: session.id, orientation });
    await refreshDetail();
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function initialize() {
  // Resolve the manual language override (defaults to "system") before any
  // label is computed, so installIcons()/applyStaticI18n() below render in
  // the right language from the very first paint.
  setLocale(resolveLocale(loadStoredLanguage()));
  cacheElements();
  installIcons();
  applyStaticI18n();
  if (!api) {
    refs.emptyTitle.textContent = t('error.noLocalService');
    refs.emptyMessage.textContent = t('error.openViaApp');
    refs.emptyActions.classList.add('hidden');
    return;
  }
  if (api.setAppLocale) api.setAppLocale(getLocale());
  // The composite "Tmux Desk Mono" @font-face (local Menlo + PingFang SC by
  // unicode-range) loads lazily; xterm measures and caches per-char cell
  // widths at open, so make both faces ready before the terminal exists.
  try {
    await document.fonts.load('13px "Tmux Desk Mono"', 'Aa中。（）');
  } catch {}
  terminalView = new TerminalView({
    container: refs.terminalMount,
    api,
    onExit: () => {
      refs.terminalReconnect.classList.remove('hidden');
      refs.workspaceStatus.textContent = t('workspace.disconnected');
    },
    onError: (error) => toast(friendlyError(error), 'error'),
    onResize: () => onTerminalResize(),
    onOpenFile: (reference) => openTerminalFileReference(reference),
    onOpenUrl: (url) => openTerminalUrl(url),
    onConfirmPaste: (info) => confirmPaste(info),
  });
  bindEvents();
  loadRemoteConnections();
  renderSourceBar();
  // Startup recovery in the main process finishes after the first paint, so the
  // health arrives via this push rather than the initial fetch below.
  if (api.onSnapshotChanged) api.onSnapshotChanged((health) => applySnapshotHealth(health));
  refreshSnapshotHealth();
  try {
    state.preferences = await api.getPreferences();
    await migrateLegacyRemoteConnections();
    loadRemoteConnections();
    renderSourceBar();
    applyCurrentTheme();
    applyTerminalAppearance();
    applyPasteGuard();
    applySidebarWidth();
    applyTagRailWidth();
    applyTagRailExpanded();
    await refreshSessions({ initial: true });
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      // An unreachable remote costs a full request timeout per poll; stop
      // hammering it every 2s and retry on a slower beat instead.
      if (isRemoteActive() && state.sourceStatus === 'offline' && Date.now() - lastOfflinePoll < 10000) return;
      if (isRemoteActive() && state.sourceStatus === 'offline') lastOfflinePoll = Date.now();
      refreshSessions({ poll: true });
    }, 2000);
  } catch (error) {
    toast(friendlyError(error), 'error');
    renderWorkspace();
  }
}

initialize();

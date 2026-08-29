const QRCode = require('qrcode');
const { icon } = require('./icons');
const { searchCommands } = require('./command-palette');
const { filterAndGroupSessions, sessionsForView } = require('../shared/session-model');
const { adjacentTagId } = require('../shared/tag-model');
const { resolveTerminalFileReference } = require('../shared/terminal-file-link');
const { DEFAULT_TMUX_SETTINGS, TMUX_SETTING_FIELDS, parseAdvancedConfig } = require('../shared/tmux-settings');
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
const $ = (selector) => document.querySelector(selector);
const refs = {};
const state = {
  systemStatus: { installed: false, path: null, version: null },
  preferences: {
    theme: 'light', favorites: [], tags: [], sessionTags: {}, tabOrders: {}, lastSession: null, windowBounds: null, sidebarWidth: null,
    tagRailExpanded: false, tagRailWidth: null, keepAwake: false, autoShare: false, remoteConnections: [],
    tmuxSettings: { ...DEFAULT_TMUX_SETTINGS },
    sessionRestore: { enabled: true, autoRestore: true, repairCwd: true, intervalMinutes: 3 },
  },
  sessions: [],
  selectedSessionId: null,
  detail: { windows: [], panes: [] },
  query: '',
  view: { kind: 'all' },
  refreshing: false,
  commandIndex: 0,
  files: { open: false, root: null },
  source: { kind: 'local', id: 'local' },
  remoteConnections: [],
  sourceStatus: 'online',
  // Session snapshot health, pushed from the main process (see session-snapshot.js).
  snapshot: null,
};

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let terminalView = null;
let pollTimer = null;
let selectionToken = 0;
let sourceToken = 0;
let tagActivationToken = 0;
let draggedTabName = null;

function cacheElements() {
  for (const id of [
    'appShell', 'tagRail', 'newTagButton', 'sessionSummary', 'refreshButton', 'newSessionButton', 'searchIcon', 'sessionSearch', 'sessionList',
    'sourceBar', 'sourceButton', 'sourceIcon', 'sourceLabel', 'sourceStatusDot', 'sourceCaret', 'sourcePopover',
    'remoteModal', 'remoteForm', 'remoteLabelInput', 'remoteUrlInput', 'remoteTokenInput',
    'tmuxStatusDot', 'tmuxStatusText', 'themeButton', 'settingsButton', 'activeSessionName',
    'activeSessionPath', 'attachedBadge', 'workspaceViewBadge', 'panePickerWrap', 'panePicker', 'panePickerIcon',
    'sessionMenuButton', 'sessionTabs', 'terminalSurface', 'terminalMount', 'paneCloseLayer', 'terminalReconnect',
    'reconnectButton', 'emptyState', 'emptyTitle', 'emptyMessage', 'emptyActions', 'emptyNewButton',
    'emptyInstallButton', 'emptyRefreshButton', 'emptyAllButton', 'workspaceStatus', 'commandHint', 'themePopover', 'contextMenu', 'toastStack',
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
    'sidebarResizer', 'tagRailResizer', 'tagRailToggleButton', 'settingsScroll', 'keepAwakeToggle', 'autoShareToggle',
    'tmuxSettingsGroups', 'tmuxResetButton', 'tmuxAdvancedConfig', 'tmuxAdvancedError', 'tmuxAdvancedApplyButton',
    'snapshotHealthButton', 'snapshotModal', 'snapshotSummary', 'snapshotIssues', 'snapshotPaths',
    'snapshotSaveButton', 'snapshotRestoreButton', 'snapshotRevealButton', 'snapshotOpenButton',
    'snapshotEnabledToggle', 'snapshotAutoRestoreToggle', 'snapshotRepairToggle', 'snapshotIntervalInput',
    'snapshotSettingsStatus',
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

function currentTag() {
  if (state.view.kind !== 'tag') return null;
  return state.preferences.tags.find((tag) => tag.id === state.view.tagId) || null;
}

function compactSessions() {
  return sessionsForView(state.sessions, state.preferences, state.view);
}

// Key into preferences.tabOrders for the currently active compact view, or
// null when tab order has no meaning (the "all sessions" left-hand list).
function currentViewKey() {
  if (state.view.kind === 'favorites') return 'favorites';
  if (state.view.kind === 'tag') return state.view.tagId;
  return null;
}

function tagsForSession(name) {
  const ids = new Set(state.preferences.sessionTags[name] || []);
  return state.preferences.tags.filter((tag) => ids.has(tag.id));
}

function tagColor(tag) {
  return `var(--tag-${tag.color})`;
}

function tagSessionCount(tagId) {
  return state.sessions.filter((session) => (state.preferences.sessionTags[session.name] || []).includes(tagId)).length;
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
  for (const tag of state.preferences.tags) {
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
    state.preferences.favorites,
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
    empty.textContent = state.query ? t('session.noMatch') : t('session.none');
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
  if (state.preferences.favorites.includes(session.name)) {
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
    button.draggable = true;
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
  const targetId = adjacentTagId(state.preferences.tags, currentTagId, direction);
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

async function openTerminalFileReference(reference) {
  const target = resolveTerminalFileReference(reference, activeSessionDir());
  if (!target) throw new Error(t('file.resolveFailed'));
  await api.openFile(target);
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
  if (!force && dir === state.files.root) return;
  state.files.root = dir;
  loadFileTree(dir);
}

async function loadFileTree(dir) {
  refs.fbPath.textContent = shortenPath(dir) || t('file.noDir');
  refs.fbPath.title = dir || '';
  const loading = document.createElement('div');
  loading.className = 'fb-loading';
  loading.textContent = dir ? t('file.loading') : t('file.selectSessionHint');
  refs.fbTree.replaceChildren(loading);
  if (!dir) return;
  try {
    const listing = await api.listFiles(dir);
    if (state.files.root !== dir) return;
    refs.fbTree.replaceChildren();
    renderFileEntries(refs.fbTree, listing.entries, 0);
  } catch (error) {
    if (state.files.root !== dir) return;
    const failed = document.createElement('div');
    failed.className = 'fb-empty';
    failed.textContent = friendlyError(error);
    refs.fbTree.replaceChildren(failed);
  }
}

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
  const row = document.createElement('button');
  row.className = `fb-row ${entry.hidden ? 'dim' : ''}`;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.title = entry.name;
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
  row.addEventListener('click', () => { if (entry.isDir) toggleDir(node, entry, depth); else openEntry(entry); });
  row.addEventListener('contextmenu', (event) => { event.preventDefault(); openFileMenu(entry, event.clientX, event.clientY); });
  node.append(row);
  return node;
}

async function toggleDir(node, entry, depth) {
  const existing = node.querySelector(':scope > .fb-children');
  if (existing) { existing.remove(); node.classList.remove('open'); return; }
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
    const listing = await api.listFiles(entry.path);
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
  try { await api.openFile(entry.path); }
  catch (error) { toast(friendlyError(error), 'error'); }
}

function openFileMenu(entry, x, y) {
  closeFloatingMenus();
  refs.contextMenu.replaceChildren(
    menuButton({ iconName: entry.isDir ? 'folder' : 'terminal', title: entry.isDir ? t('file.openInFinder') : t('action.open'), action: () => { closeFloatingMenus(); openEntry(entry); } }),
    menuButton({ iconName: 'external', title: t('file.openWith'), action: async () => {
      closeFloatingMenus();
      try { const result = await api.openFileWith(entry.path); if (result && result.app) toast(t('file.openedWith', { app: result.app })); }
      catch (error) { toast(friendlyError(error), 'error'); }
    } }),
    menuButton({ iconName: 'folder', title: t('action.revealInFinder'), action: async () => {
      closeFloatingMenus();
      try { await api.revealFile(entry.path); } catch (error) { toast(friendlyError(error), 'error'); }
    } }),
    separator(),
    menuButton({ iconName: 'copy', title: t('action.copyPath'), action: async () => {
      closeFloatingMenus();
      await navigator.clipboard.writeText(entry.path);
      toast(t('toast.pathCopied'));
    } }),
  );
  placePopoverAt(refs.contextMenu, x, y);
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
  if (nextView.kind === 'tag' && !state.preferences.tags.some((tag) => tag.id === nextView.tagId)) {
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
      const preferred = state.sessions.find((session) => session.name === state.preferences.lastSession) || state.sessions[0];
      await selectSession(preferred);
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
  state.detail = { windows: [], panes: [] };
  refs.terminalReconnect.classList.add('hidden');
  renderSessionList();
  renderSessionTabs();
  renderWorkspace();
  renderDetail();
  try {
    // lastSession is a local-machine preference; a remote session name could
    // collide with a local one, so only persist it for the local source.
    if (!isRemoteActive()) {
      state.preferences = await api.savePreferences({ lastSession: session.name });
    }
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

async function refreshSessions({ initial = false, notify = false, poll = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  const token = sourceToken;
  refs.refreshButton.classList.add('spinning');
  try {
    if (isRemoteActive()) {
      // A remote host that answers /api/sessions has usable tmux; skip the local
      // tmux probe entirely.
      state.systemStatus = { installed: true };
    } else if (initial || !state.systemStatus.installed) {
      state.systemStatus = await api.getSystemStatus();
    }
    const sessions = state.systemStatus.installed ? await sessionApi().listSessions() : [];
    // A source switch (or another concurrent refresh) happened while we awaited;
    // these results belong to the old source — drop them.
    if (token !== sourceToken) return;
    if (isRemoteActive() && state.sourceStatus !== 'online') { state.sourceStatus = 'online'; renderSourceBar(); }
    const previousId = state.selectedSessionId;
    state.sessions = sessions;
    if (previousId && !sessions.some((session) => session.id === previousId)) {
      selectionToken += 1;
      state.selectedSessionId = null;
      state.detail = { windows: [], panes: [] };
      await terminalView.detach();
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
    } else if (initial && sessions.length) {
      const preferred = sessions.find((session) => session.name === state.preferences.lastSession) || sessions[0];
      await selectSession(preferred);
    }
    if (notify) toast(t('toast.sessionsRefreshed'));
  } catch (error) {
    if (isRemoteActive() && state.sourceStatus !== 'offline') {
      state.sourceStatus = 'offline';
      renderSourceBar();
    }
    // Background polls fail quietly (a remote blip shouldn't spam toasts); only
    // user-initiated refreshes surface the error.
    if (!poll) toast(friendlyError(error), 'error');
  } finally {
    state.refreshing = false;
    refs.refreshButton.classList.remove('spinning');
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
    menuButton({ iconName: 'terminal', title: t('menu.openTag', { name: tag.name }), action: () => setView({ kind: 'tag', tagId: tag.id }) }),
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

function closeModal(modal) { modal.classList.add('hidden'); }

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
    { id: 'newTag', title: t('tag.new'), subtitle: t('palette.newTagSubtitle'), icon: 'tag', action: () => openTagEditor() },
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
    { id: 'mobileAccess', title: t('action.mobileAccess'), subtitle: t('palette.mobileAccessSubtitle'), keywords: ['mobile', 'web', 'qrcode', '二维码'], icon: 'phone', action: openMobileAccessModal },
    ...(session ? [
      { id: 'shareSession', title: t('palette.shareSessionTitle', { name: session.name }), subtitle: t('palette.shareSessionSubtitle'), keywords: ['share', 'link', '分享', '链接'], icon: 'external', action: () => openMobileAccessModal(session) },
      { id: 'splitV', title: t('palette.splitVertical'), subtitle: t('palette.splitVerticalSubtitle'), shortcut: '⌘D', icon: 'panes', action: () => splitActivePane('vertical') },
      { id: 'splitH', title: t('palette.splitHorizontal'), subtitle: t('palette.splitHorizontalSubtitle'), shortcut: '⌘⇧D', icon: 'panes', action: () => splitActivePane('horizontal') },
      ...(activeWindowPanes().length >= 2 ? [
        { id: 'closePane', title: t('palette.closePane'), subtitle: t('palette.closePaneSubtitle'), icon: 'close', action: closeActivePane },
      ] : []),
      { id: 'rename', title: t('palette.renameTitle', { name: session.name }), subtitle: t('palette.renameSubtitle'), icon: 'edit', action: () => openRenameModal(session) },
      { id: 'duplicate', title: t('palette.duplicateTitle', { name: session.name }), subtitle: t('palette.duplicateSubtitle'), icon: 'copy', action: () => openDuplicateModal(session) },
      { id: 'sessionTags', title: t('palette.manageTagsTitle', { name: session.name }), subtitle: t('palette.manageTagsSubtitle'), icon: 'tag', action: () => openSessionTagsModal(session) },
      { id: 'favorite', title: state.preferences.favorites.includes(session.name) ? t('palette.unfavoriteCurrent') : t('palette.favoriteCurrent'), subtitle: session.name, icon: 'star', action: () => toggleSelectedFavorite() },
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
  if (!remote) {
    remote = new RemoteApi({ base: connection.base, token: connection.token });
    remoteApis.set(connection.id, remote);
  }
  return remote;
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

function sourceRow({ iconName, label, sublabel, active, onClick, onRemove, reshare, onToggleReshare }) {
  const row = document.createElement('div');
  row.className = `source-row${active ? ' active' : ''}`;
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
    sub.textContent = sublabel;
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
  state.selectedSessionId = null;
  state.detail = { windows: [], panes: [] };
  state.sessions = [];
  state.query = '';
  if (refs.sessionSearch) refs.sessionSearch.value = '';
  state.view = { kind: 'all' };
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
  refs.refreshButton.addEventListener('click', () => refreshSessions({ notify: true }));
  refs.emptyRefreshButton.addEventListener('click', () => refreshSessions({ initial: !state.systemStatus.installed, notify: true }));
  refs.newSessionButton.addEventListener('click', openNewSessionModal);
  refs.emptyNewButton.addEventListener('click', openNewSessionModal);
  refs.emptyAllButton.addEventListener('click', () => setView({ kind: 'all' }));
  refs.newTagButton.addEventListener('click', () => openTagEditor());
  refs.tagRailToggleButton.addEventListener('click', () => setTagRailExpanded(!state.preferences.tagRailExpanded));
  refs.settingsNewTagButton.addEventListener('click', () => openTagEditor());
  refs.tagExportButton.addEventListener('click', exportTags);
  refs.tagImportButton.addEventListener('click', importTags);
  refs.keepAwakeToggle.addEventListener('change', () => setKeepAwakePreference(refs.keepAwakeToggle.checked));
  refs.autoShareToggle.addEventListener('change', () => setAutoSharePreference(refs.autoShareToggle.checked));
  refs.tmuxResetButton.addEventListener('click', resetTmuxSettings);
  refs.tmuxAdvancedApplyButton.addEventListener('click', applyAdvancedTmuxSettings);
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
  refs.fbRefreshButton.addEventListener('click', () => syncFileBrowser(true));
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
  if (meta && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); openNewSessionModal(); }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); focusSessionSearch(); }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'r') { event.preventDefault(); refreshSessions({ notify: true }); }
  else if (meta && !event.altKey && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleFileBrowser(); }
  else if (meta && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); cycleTheme(); }
  else if (meta && /^[1-9]$/.test(event.key)) {
    const windowInfo = state.detail.windows[Number(event.key) - 1];
    if (windowInfo) { event.preventDefault(); sessionApi().selectWindow(windowInfo.id).then(refreshDetail).catch((error) => toast(friendlyError(error), 'error')); }
  } else if (event.metaKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    && state.view.kind !== 'all' && selectedSession()) {
    event.preventDefault();
    // ⌘←/→ switches to the neighboring tab (terminal follows, like iTerm);
    // adding Shift moves the current tab within the manual order instead.
    if (event.shiftKey) moveSelectedTab(event.key === 'ArrowLeft' ? -1 : 1);
    else selectAdjacentTab(event.key === 'ArrowLeft' ? -1 : 1);
  } else if (event.metaKey && !event.altKey && !event.shiftKey
    && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    && state.preferences.tags.length) {
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
    applySidebarWidth();
    applyTagRailWidth();
    applyTagRailExpanded();
    await refreshSessions({ initial: true });
    pollTimer = setInterval(() => { if (!document.hidden) refreshSessions({ poll: true }); }, 2000);
  } catch (error) {
    toast(friendlyError(error), 'error');
    renderWorkspace();
  }
}

initialize();

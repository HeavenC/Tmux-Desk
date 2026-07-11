const QRCode = require('qrcode');
const { icon } = require('./icons');
const { searchCommands } = require('./command-palette');
const { filterAndGroupSessions, sessionsForView } = require('../shared/session-model');
const { applyTheme, resolveTheme } = require('./theme');
const { TerminalView } = require('./terminal-view');

const api = window.tmuxDesk;
const $ = (selector) => document.querySelector(selector);
const refs = {};
const state = {
  systemStatus: { installed: false, path: null, version: null },
  preferences: {
    theme: 'light', favorites: [], tags: [], sessionTags: {}, tabOrders: {}, lastSession: null, windowBounds: null, sidebarWidth: null,
    tagRailExpanded: false, tagRailWidth: null,
  },
  sessions: [],
  selectedSessionId: null,
  detail: { windows: [], panes: [] },
  query: '',
  view: { kind: 'all' },
  refreshing: false,
  commandIndex: 0,
  files: { open: false, root: null },
};

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let terminalView = null;
let pollTimer = null;
let selectionToken = 0;
let tagActivationToken = 0;
let draggedTabName = null;

function cacheElements() {
  for (const id of [
    'appShell', 'tagRail', 'newTagButton', 'sessionSummary', 'refreshButton', 'newSessionButton', 'searchIcon', 'sessionSearch', 'sessionList',
    'tmuxStatusDot', 'tmuxStatusText', 'themeButton', 'settingsButton', 'activeSessionName',
    'activeSessionPath', 'attachedBadge', 'workspaceViewBadge', 'panePickerWrap', 'panePicker', 'panePickerIcon',
    'sessionMenuButton', 'sessionTabs', 'terminalSurface', 'terminalMount', 'terminalReconnect',
    'reconnectButton', 'emptyState', 'emptyTitle', 'emptyMessage', 'emptyActions', 'emptyNewButton',
    'emptyInstallButton', 'emptyRefreshButton', 'emptyAllButton', 'workspaceStatus', 'commandHint', 'themePopover', 'contextMenu', 'toastStack',
    'sessionModal', 'sessionForm', 'sessionNameInput', 'sessionCwdInput', 'startupCommandInput',
    'chooseDirectoryButton', 'renameModal', 'renameForm', 'renameInput', 'killModal', 'killMessage',
    'confirmKillButton', 'settingsModal', 'themeCards', 'tagSettingsList', 'settingsNewTagButton', 'settingsTmuxVersion', 'commandPalette',
    'commandInput', 'commandSearchIcon', 'commandResults',
    'duplicateModal', 'duplicateForm', 'duplicateInput', 'duplicateMessage',
    'importModal', 'importList', 'importTitle', 'importSubtitle', 'importSelectAll', 'importCreateButton',
    'mobileAccessButton', 'mobileAccessModal', 'mobileAccessBody',
    'tagEditorModal', 'tagEditorForm', 'tagEditorTitle', 'tagNameInput',
    'sessionTagsModal', 'sessionTagsForm', 'sessionTagsMessage', 'sessionTagsList',
    'tagDeleteModal', 'tagDeleteMessage', 'confirmTagDeleteButton',
    'filesToggleButton', 'fileBrowser', 'fbTree', 'fbPath', 'fbRevealButton', 'fbRefreshButton', 'fbCollapseButton',
    'sidebarResizer', 'tagRailResizer', 'tagRailToggleButton', 'settingsScroll',
  ]) refs[id] = document.getElementById(id);
}

function installIcons() {
  $('[data-view="all"]').innerHTML = railButtonContent('terminal', '全部会话');
  $('[data-view="favorites"]').innerHTML = railButtonContent('star', '收藏会话');
  refs.settingsButton.innerHTML = railButtonContent('settings', '设置');
  refs.refreshButton.innerHTML = icon('refresh', 16);
  refs.newSessionButton.innerHTML = icon('plus', 17);
  refs.newTagButton.innerHTML = railButtonContent('plus', '新建 Tag', 16);
  refs.tagRailToggleButton.innerHTML = railButtonContent('chevron', '展开 Tag 栏', 16);
  refs.searchIcon.innerHTML = icon('search', 14);
  refs.panePickerIcon.innerHTML = icon('panes', 15);
  refs.sessionMenuButton.innerHTML = icon('more', 18);
  refs.commandSearchIcon.innerHTML = icon('search', 18);
  refs.filesToggleButton.innerHTML = icon('sidebar', 17);
  refs.mobileAccessButton.innerHTML = railButtonContent('phone', '手机访问', 18);
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
  if (state.view.kind === 'favorites') return '收藏';
  return currentTag()?.name || 'Tag';
}

function friendlyError(error) {
  return String(error?.message || error || '未知错误')
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
  refs.tagRailToggleButton.setAttribute('aria-label', expanded ? '收起 Tag 栏' : '展开 Tag 栏');
  refs.tagRailToggleButton.title = expanded ? '收起 Tag 栏' : '展开 Tag 栏';
  const label = refs.tagRailToggleButton.querySelector('.rail-label');
  if (label) label.textContent = expanded ? '收起 Tag 栏' : '展开 Tag 栏';
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
  refs.themeButton.innerHTML = railButtonContent(themeIcon, '切换主题');
  refs.themeButton.title = `主题：${{ light: '亮色', dark: '暗色', system: '跟随系统' }[state.preferences.theme]}`;
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
    { id: 'light', title: '亮色', icon: 'sun' },
    { id: 'dark', title: '暗色', icon: 'moon' },
    { id: 'system', title: '跟随系统', icon: 'laptop' },
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

function renderTagSettings() {
  refs.tagSettingsList.replaceChildren();
  if (!state.preferences.tags.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-settings-empty';
    empty.textContent = '还没有 Tag';
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
    count.textContent = `${tagSessionCount(tag.id)} 个会话`;
    const actions = document.createElement('span');
    actions.className = 'tag-settings-actions';
    const rename = document.createElement('button');
    rename.className = 'icon-button';
    rename.type = 'button';
    rename.setAttribute('aria-label', `重命名 ${tag.name}`);
    rename.title = '重命名';
    rename.innerHTML = icon('edit', 14);
    rename.addEventListener('click', () => openTagEditor(tag));
    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.type = 'button';
    remove.setAttribute('aria-label', `删除 ${tag.name}`);
    remove.title = '删除';
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
  refs.tmuxStatusText.textContent = installed ? state.systemStatus.version || 'tmux 已就绪' : '未找到 tmux';
  refs.settingsTmuxVersion.textContent = installed
    ? `${state.systemStatus.version || '已安装'} · ${state.systemStatus.path}`
    : '未安装（brew install tmux）';
}

function sessionMeta(session) {
  const counts = `${session.windows || 0} 窗口 · ${session.paneCount || 0} 面板`;
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
    button.setAttribute('aria-label', `${tag.name}，${count} 个会话`);
    button.title = `${tag.name} · ${count} 个会话`;
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
      button.addEventListener('dragstart', (event) => handlePinnedDragStart(event, tag));
      button.addEventListener('dragover', (event) => handlePinnedDragOver(event, tag));
      button.addEventListener('drop', (event) => handlePinnedDrop(event, tag));
      button.addEventListener('dragend', () => { pinnedDragId = null; clearPinnedDropMarkers(); });
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
  addGroup('收藏', groups.favorites);
  addGroup('全部会话', groups.sessions);
  if (!groups.favorites.length && !groups.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.textContent = state.query ? '没有匹配的会话' : '暂无 tmux 会话';
    refs.sessionList.append(empty);
  }
  const attached = state.sessions.filter((session) => session.attached).length;
  refs.sessionSummary.textContent = `${state.sessions.length} 个会话${attached ? ` · ${attached} 已连接` : ''}`;
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
    marks.title = sessionTags.map((tag) => tag.name).join('、');
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
  more.setAttribute('aria-label', `${session.name} 操作`);
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
    refs.activeSessionPath.textContent = shortenPath(session.path) || '本地 tmux 会话';
    refs.attachedBadge.classList.toggle('hidden', !session.attached);
    refs.terminalSurface.classList.remove('hidden');
    refs.emptyState.classList.add('hidden');
    refs.sessionMenuButton.classList.remove('hidden');
    refs.workspaceStatus.textContent = `${session.windows || 0} 窗口 · ${session.paneCount || 0} 面板 · 纯本地连接`;
  } else {
    refs.activeSessionName.textContent = compact ? compactViewLabel() : 'Tmux Desk';
    refs.activeSessionPath.textContent = compact ? '选择页签中的会话开始工作' : '选择一个本机会话开始工作';
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
      refs.emptyTitle.textContent = '需要安装 tmux';
      refs.emptyMessage.textContent = 'Tmux Desk 是 tmux 的图形前端，需要本机的 tmux。请用 Homebrew 安装后重新检测。';
      refs.emptyInstallButton.classList.remove('hidden');
      refs.emptyRefreshButton.classList.remove('hidden');
      refs.emptyRefreshButton.textContent = '重新检测';
    } else if (compact) {
      refs.emptyTitle.textContent = state.view.kind === 'favorites' ? '还没有收藏会话' : `“${compactViewLabel()}” 还没有会话`;
      refs.emptyMessage.textContent = state.view.kind === 'favorites'
        ? '收藏会话后，它们会作为页签显示在这里。'
        : '可回到全部会话分配 Tag，或直接新建一个自动归入当前 Tag 的会话。';
      refs.emptyAllButton.classList.remove('hidden');
      if (state.view.kind === 'tag') refs.emptyNewButton.classList.remove('hidden');
      refs.workspaceStatus.textContent = `${compactViewLabel()} · 0 个会话`;
    } else if (!state.sessions.length) {
      refs.emptyTitle.textContent = '还没有 tmux 会话';
      refs.emptyMessage.textContent = '创建第一个会话，应用会在所选目录中启动一个真实 tmux 终端。';
      refs.emptyNewButton.classList.remove('hidden');
      refs.emptyRefreshButton.classList.remove('hidden');
      refs.emptyRefreshButton.textContent = '刷新列表';
    } else {
      refs.emptyTitle.textContent = '你的 tmux 工作台';
      refs.emptyMessage.textContent = '从左侧选择一个会话，或新建会话开始工作。';
      refs.emptyNewButton.classList.remove('hidden');
      refs.emptyRefreshButton.classList.remove('hidden');
      refs.emptyRefreshButton.textContent = '刷新列表';
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
// both drag-and-drop and the Cmd+Option+Arrow keyboard reorder.
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
}

async function refreshDetail() {
  const session = selectedSession();
  if (!session) return;
  const targetId = session.id;
  try {
    const detail = await api.getSessionDetail(targetId);
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
  refs.fbPath.textContent = shortenPath(dir) || '没有可用目录';
  refs.fbPath.title = dir || '';
  const loading = document.createElement('div');
  loading.className = 'fb-loading';
  loading.textContent = dir ? '正在读取…' : '选择一个会话后即可浏览其目录。';
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
    empty.textContent = '空文件夹';
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
  loading.textContent = '正在读取…';
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
    menuButton({ iconName: entry.isDir ? 'folder' : 'terminal', title: entry.isDir ? '在访达中打开' : '打开', action: () => { closeFloatingMenus(); openEntry(entry); } }),
    menuButton({ iconName: 'external', title: '打开方式…', action: async () => {
      closeFloatingMenus();
      try { const result = await api.openFileWith(entry.path); if (result && result.app) toast(`已用 ${result.app} 打开`); }
      catch (error) { toast(friendlyError(error), 'error'); }
    } }),
    menuButton({ iconName: 'folder', title: '在访达中显示', action: async () => {
      closeFloatingMenus();
      try { await api.revealFile(entry.path); } catch (error) { toast(friendlyError(error), 'error'); }
    } }),
    separator(),
    menuButton({ iconName: 'copy', title: '复制路径', action: async () => {
      closeFloatingMenus();
      await navigator.clipboard.writeText(entry.path);
      toast('路径已复制');
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
    state.preferences = await api.savePreferences({ lastSession: session.name });
    await Promise.all([refreshDetail(), terminalView.attach(session.id)]);
    if (token !== selectionToken) return;
    refs.workspaceStatus.textContent = `${session.windows || 0} 窗口 · ${session.paneCount || 0} 面板 · 已连接`;
  } catch (error) {
    if (token === selectionToken) {
      refs.terminalReconnect.classList.remove('hidden');
      toast(friendlyError(error), 'error');
    }
  }
}

async function refreshSessions({ initial = false, notify = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  refs.refreshButton.classList.add('spinning');
  try {
    if (initial || !state.systemStatus.installed) state.systemStatus = await api.getSystemStatus();
    const sessions = state.systemStatus.installed ? await api.listSessions() : [];
    const previousId = state.selectedSessionId;
    state.sessions = sessions;
    if (previousId && !sessions.some((session) => session.id === previousId)) {
      selectionToken += 1;
      state.selectedSessionId = null;
      state.detail = { windows: [], panes: [] };
      await terminalView.detach();
      syncFileBrowser();
      if (!initial) toast('当前 tmux 会话已在外部关闭', 'error');
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
    if (notify) toast('会话列表已刷新');
  } catch (error) {
    toast(friendlyError(error), 'error');
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
}

function openSessionMenu(session, anchor) {
  closeFloatingMenus();
  const isFavorite = state.preferences.favorites.includes(session.name);
  refs.contextMenu.replaceChildren(
    menuButton({ iconName: 'terminal', title: '连接会话', action: () => { closeFloatingMenus(); selectSession(session); } }),
    menuButton({ iconName: 'star', title: isFavorite ? '取消收藏' : '收藏会话', action: async () => {
      closeFloatingMenus();
      try { await toggleFavorite(session); }
      catch (error) { toast(friendlyError(error), 'error'); }
    } }),
    menuButton({ iconName: 'tag', title: '管理 Tag…', action: () => { closeFloatingMenus(); openSessionTagsModal(session); } }),
    separator(),
    menuButton({ iconName: 'edit', title: '重命名', action: () => { closeFloatingMenus(); openRenameModal(session); } }),
    menuButton({ iconName: 'copy', title: '复制会话…', action: () => { closeFloatingMenus(); openDuplicateModal(session); } }),
    menuButton({ iconName: 'copy', title: '复制名称', action: async () => {
      closeFloatingMenus();
      await navigator.clipboard.writeText(session.name);
      toast('会话名称已复制');
    } }),
    separator(),
    menuButton({ iconName: 'trash', title: '关闭会话…', danger: true, action: () => { closeFloatingMenus(); openKillModal(session); } }),
  );
  placePopover(refs.contextMenu, anchor);
}

function openTagMenu(tag, x, y) {
  closeFloatingMenus();
  const topUnpinned = firstUnpinnedTag();
  let pinItem;
  if (tag.pinned) {
    pinItem = menuButton({ iconName: 'star', title: '取消固定', action: () => { closeFloatingMenus(); setTagPinned(tag, false); } });
  } else if (topUnpinned && topUnpinned.id === tag.id) {
    pinItem = menuButton({ iconName: 'star', title: '固定到顶部', action: () => { closeFloatingMenus(); setTagPinned(tag, true); } });
  } else {
    pinItem = menuButton({ iconName: 'star', title: '固定（仅可固定最上方的 Tag）', disabled: true });
  }
  refs.contextMenu.replaceChildren(
    menuButton({ iconName: 'terminal', title: `打开 “${tag.name}”`, action: () => setView({ kind: 'tag', tagId: tag.id }) }),
    separator(),
    pinItem,
    menuButton({ iconName: 'edit', title: '重命名 Tag…', action: () => { closeFloatingMenus(); openTagEditor(tag); } }),
    menuButton({ iconName: 'trash', title: '删除 Tag…', danger: true, action: () => { closeFloatingMenus(); openTagDeleteModal(tag); } }),
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
  refs.tagEditorTitle.textContent = tag ? '重命名 Tag' : '新建 Tag';
  refs.tagNameInput.value = tag?.name || '';
  openModal(refs.tagEditorModal, refs.tagNameInput);
  refs.tagNameInput.select();
}

function openTagDeleteModal(tag) {
  refs.tagDeleteModal.dataset.tagId = tag.id;
  refs.tagDeleteMessage.textContent = `删除 “${tag.name}” 只会移除 Tag 和分类关系，不会关闭任何 tmux 会话。`;
  openModal(refs.tagDeleteModal, refs.confirmTagDeleteButton);
}

function openSessionTagsModal(session = selectedSession()) {
  if (!session) return;
  refs.sessionTagsModal.dataset.sessionName = session.name;
  refs.sessionTagsMessage.textContent = `为 “${session.name}” 选择一个或多个 Tag。`;
  const selectedIds = new Set(state.preferences.sessionTags[session.name] || []);
  refs.sessionTagsList.replaceChildren();
  if (!state.preferences.tags.length) {
    const empty = document.createElement('div');
    empty.className = 'tag-settings-empty';
    empty.textContent = '还没有 Tag，请先从左侧 + 或设置中新建。';
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
  refs.killMessage.textContent = `“${session.name}” 中的 ${session.paneCount || 0} 个面板及其进程都会被终止。此操作不可撤销。`;
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
  refs.duplicateMessage.textContent = `按 “${session.name}” 的窗口与目录创建一个副本，原会话保持不变。`;
  refs.duplicateInput.value = suggestCopyName(session.name);
  openModal(refs.duplicateModal, refs.duplicateInput);
  refs.duplicateInput.select();
}

function openSettings() {
  renderThemeControls();
  renderTagSettings();
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
  refs.importTitle.textContent = `从 ${meta.label} 导入会话`;
  refs.importSubtitle.textContent = '正在扫描…';
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
    refs.importSubtitle.textContent = '未发现可导入的代码库';
    const empty = document.createElement('p');
    empty.className = 'import-empty';
    empty.textContent = '这个工具还没有可用的最近项目记录。';
    refs.importList.append(empty);
    return;
  }
  refs.importSubtitle.textContent = `发现 ${importEntries.length} 个代码库，勾选后点击“导入选中”。`;
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
      badge.textContent = '已存在';
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
  if (!chosen.length) { toast('未选择任何代码库'); return; }

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
  const parts = [`已创建 ${created} 个会话`];
  if (skipped) parts.push(`跳过 ${skipped} 个已存在`);
  if (failed) parts.push(`失败 ${failed} 个`);
  toast(parts.join('，'), failed ? 'error' : 'info');
}

let mobileAccessBusy = false;

function openMobileAccessModal() {
  openModal(refs.mobileAccessModal);
  loadMobileAccessStatus();
}

async function loadMobileAccessStatus() {
  renderMobileAccessLoading();
  try {
    const status = await api.webStatus();
    renderMobileAccess(status);
  } catch (error) {
    renderMobileAccessError(error);
  }
}

function renderMobileAccessLoading() {
  const loading = document.createElement('div');
  loading.className = 'mobile-access-loading';
  loading.textContent = '正在检测服务状态…';
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
  retry.textContent = '重试';
  retry.addEventListener('click', loadMobileAccessStatus);
  wrap.append(message, retry);
  refs.mobileAccessBody.replaceChildren(wrap);
}

function renderMobileAccessIdle() {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-access-empty';
  const message = document.createElement('p');
  message.textContent = '服务尚未启动，点击下方按钮启动后即可用手机扫码访问全部 tmux 会话。';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'button primary';
  start.textContent = '启动 Web 服务';
  start.addEventListener('click', startMobileAccess);
  wrap.append(message, start);
  refs.mobileAccessBody.replaceChildren(wrap);
}

function renderMobileAccessStarting() {
  const wrap = document.createElement('div');
  wrap.className = 'mobile-access-empty';
  const message = document.createElement('p');
  message.textContent = '服务尚未启动，点击下方按钮启动后即可用手机扫码访问全部 tmux 会话。';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'button primary';
  start.textContent = '启动中…';
  start.disabled = true;
  wrap.append(message, start);
  refs.mobileAccessBody.replaceChildren(wrap);
}

async function startMobileAccess() {
  if (mobileAccessBusy) return;
  mobileAccessBusy = true;
  renderMobileAccessStarting();
  try {
    const status = await api.webStart();
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
    toast('Web 服务已停止');
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
  if (tailscale) cards.push({ entry: tailscale, title: 'Tailscale', subtitle: '外网可用（需手机装 Tailscale）' });
  if (lan) cards.push({ entry: lan, title: '局域网', subtitle: '同一 WiFi 下可用' });
  if (!tailscale && !lan && other) cards.push({ entry: other, title: '本机网络', subtitle: '同一局域网下可用' });
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
  img.alt = `${card.title} 二维码`;
  qrFrame.append(img);
  const urlButton = document.createElement('button');
  urlButton.type = 'button';
  urlButton.className = 'mobile-access-url';
  urlButton.textContent = card.entry.url;
  urlButton.title = '点击复制';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'button mobile-access-copy';
  copyButton.textContent = '复制链接';
  const copyLink = async (trigger) => {
    try {
      await navigator.clipboard.writeText(card.entry.url);
      const original = trigger.textContent;
      trigger.textContent = '已复制';
      setTimeout(() => { trigger.textContent = original; }, 1400);
    } catch (error) { toast(friendlyError(error), 'error'); }
  };
  urlButton.addEventListener('click', () => copyLink(urlButton));
  copyButton.addEventListener('click', () => copyLink(copyButton));
  wrap.append(title, subtitle, qrFrame, urlButton, copyButton);
  QRCode.toDataURL(card.entry.url, { width: 220, margin: 1 })
    .then((dataUrl) => { img.src = dataUrl; })
    .catch(() => { qrFrame.textContent = '二维码生成失败'; });
  return wrap;
}

function renderMobileAccessRunning(status) {
  const wrap = document.createElement('div');

  const statusRow = document.createElement('div');
  statusRow.className = 'mobile-access-status';
  const dot = document.createElement('span');
  dot.className = 'status-dot ok';
  const text = document.createElement('span');
  text.textContent = `运行中 · 端口 ${status.port}${status.external ? '（由外部进程启动）' : ''}`;
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
      hint.textContent = '未检测到 Tailscale 网卡';
      wrap.append(hint);
    }
  } else {
    const empty = document.createElement('p');
    empty.className = 'mobile-access-hint';
    empty.textContent = '未检测到可用的网络地址，请确认已连接局域网或 Tailscale。';
    wrap.append(empty);
  }

  const footer = document.createElement('div');
  footer.className = 'mobile-access-footer';
  if (status.external) {
    const note = document.createElement('p');
    note.className = 'mobile-access-hint';
    note.textContent = '由外部进程启动，如需停止请在终端中结束该进程。';
    footer.append(note);
  } else {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'button mobile-access-stop';
    stop.textContent = '停止服务';
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
    { id: 'new', title: '新建会话', subtitle: '创建一个本地 tmux 会话', shortcut: '⌘N', icon: 'plus', action: openNewSessionModal },
    { id: 'refresh', title: '刷新会话', subtitle: '重新读取本机 tmux 状态', shortcut: '⌘R', icon: 'refresh', action: () => refreshSessions({ notify: true }) },
    { id: 'search', title: '搜索会话', subtitle: '回到全部并聚焦搜索框', shortcut: '⌘F', icon: 'search', action: focusSessionSearch },
    { id: 'files', title: state.files.open ? '隐藏文件浏览器' : '显示文件浏览器', subtitle: '浏览当前会话目录', shortcut: '⌘B', icon: 'sidebar', action: toggleFileBrowser },
    { id: 'all', title: '显示全部会话', subtitle: '恢复左侧会话列表', icon: 'terminal', action: () => setView({ kind: 'all' }) },
    { id: 'favorites', title: '打开收藏工作区', subtitle: '用页签切换收藏会话', icon: 'star', action: () => setView({ kind: 'favorites' }) },
    { id: 'newTag', title: '新建 Tag', subtitle: '创建本地会话分组', icon: 'tag', action: () => openTagEditor() },
    { id: 'theme', title: '切换主题', subtitle: '亮色、暗色、跟随系统', shortcut: '⌘⇧T', keywords: ['light', 'dark'], icon: 'palette', action: cycleTheme },
    { id: 'settings', title: '打开设置', subtitle: '外观与本地环境信息', icon: 'settings', action: openSettings },
    ...IMPORT_TOOLS.map((tool) => ({
      id: `import-${tool.id}`,
      title: `从 ${tool.label} 导入会话`,
      subtitle: '按最近打开的代码库目录创建 tmux 会话',
      keywords: ['import', 'codebase', '导入', '代码库', '项目', tool.id, tool.label.toLowerCase()],
      icon: 'copy',
      action: () => openImportModal(tool.id),
    })),
    { id: 'mobileAccess', title: '手机访问（Web 服务）', subtitle: '扫码在手机浏览器中操作全部 tmux 会话', keywords: ['mobile', 'web', 'qrcode', '二维码'], icon: 'phone', action: openMobileAccessModal },
    ...(session ? [
      { id: 'rename', title: `重命名 “${session.name}”`, subtitle: '修改 tmux 会话名称', icon: 'edit', action: () => openRenameModal(session) },
      { id: 'duplicate', title: `复制 “${session.name}”`, subtitle: '按现有会话创建副本', icon: 'copy', action: () => openDuplicateModal(session) },
      { id: 'sessionTags', title: `管理 “${session.name}” 的 Tag`, subtitle: '可同时选择多个 Tag', icon: 'tag', action: () => openSessionTagsModal(session) },
      { id: 'favorite', title: state.preferences.favorites.includes(session.name) ? '取消收藏当前会话' : '收藏当前会话', subtitle: session.name, icon: 'star', action: () => toggleSelectedFavorite() },
      { id: 'kill', title: `关闭 “${session.name}”…`, subtitle: '终止此会话中的所有进程', icon: 'trash', action: () => openKillModal(session) },
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
    empty.textContent = '没有匹配的命令';
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

function bindEvents() {
  refs.refreshButton.addEventListener('click', () => refreshSessions({ notify: true }));
  refs.emptyRefreshButton.addEventListener('click', () => refreshSessions({ initial: !state.systemStatus.installed, notify: true }));
  refs.newSessionButton.addEventListener('click', openNewSessionModal);
  refs.emptyNewButton.addEventListener('click', openNewSessionModal);
  refs.emptyAllButton.addEventListener('click', () => setView({ kind: 'all' }));
  refs.newTagButton.addEventListener('click', () => openTagEditor());
  refs.tagRailToggleButton.addEventListener('click', () => setTagRailExpanded(!state.preferences.tagRailExpanded));
  refs.settingsNewTagButton.addEventListener('click', () => openTagEditor());
  refs.emptyInstallButton.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('brew install tmux'); toast('已复制：brew install tmux'); }
    catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.sessionSearch.addEventListener('input', () => { state.query = refs.sessionSearch.value; renderSessionList(); });
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView({ kind: button.dataset.view })));
  refs.settingsButton.addEventListener('click', openSettings);
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
    try { await api.selectPane(refs.panePicker.value); await refreshDetail(); terminalView.focus(); }
    catch (error) { toast(friendlyError(error), 'error'); }
  });
  refs.reconnectButton.addEventListener('click', () => {
    const session = selectedSession();
    if (!session) return;
    refs.terminalReconnect.classList.add('hidden');
    terminalView.attach(session.id)
      .then(() => { refs.workspaceStatus.textContent = '已重新连接本地 tmux 会话'; })
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
      toast(editingId ? 'Tag 已重命名' : 'Tag 已创建');
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
      toast('会话 Tag 已更新');
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
      toast('Tag 已删除');
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
      toast(`已复制为 ${created.name}`);
    } catch (error) { toast(friendlyError(error), 'error'); }
    finally { submit.disabled = false; }
  });

  refs.importSelectAll.addEventListener('click', toggleAllImports);
  refs.importCreateButton.addEventListener('click', runImport);
  refs.mobileAccessButton.addEventListener('click', openMobileAccessModal);

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
      toast(`已创建会话 ${created.name}`);
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
      toast('会话已重命名');
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
      toast('tmux 会话已关闭');
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
    if (!refs.contextMenu.contains(event.target) && !refs.themePopover.contains(event.target)) closeFloatingMenus();
  });
  window.addEventListener('keydown', handleKeyboard);
  systemTheme.addEventListener('change', () => { if (state.preferences.theme === 'system') applyCurrentTheme(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSessions(); });
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
    if (windowInfo) { event.preventDefault(); api.selectWindow(windowInfo.id).then(refreshDetail).catch((error) => toast(friendlyError(error), 'error')); }
  } else if (event.metaKey && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    && state.view.kind !== 'all' && selectedSession()) {
    event.preventDefault();
    // ⌘⌥←/→ switches to the neighboring tab (terminal follows, like iTerm);
    // adding Shift moves the current tab within the manual order instead.
    if (event.shiftKey) moveSelectedTab(event.key === 'ArrowLeft' ? -1 : 1);
    else selectAdjacentTab(event.key === 'ArrowLeft' ? -1 : 1);
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
  else if (typeof command === 'string' && command.startsWith('import-codebases:')) {
    openImportModal(command.slice('import-codebases:'.length));
  }
}

async function initialize() {
  cacheElements();
  installIcons();
  if (!api) {
    refs.emptyTitle.textContent = '无法连接本地服务';
    refs.emptyMessage.textContent = '请通过 Tmux Desk 桌面应用打开此界面。';
    refs.emptyActions.classList.add('hidden');
    return;
  }
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
      refs.workspaceStatus.textContent = '连接已结束 · tmux 会话可能仍在运行';
    },
    onError: (error) => toast(friendlyError(error), 'error'),
  });
  bindEvents();
  try {
    state.preferences = await api.getPreferences();
    applyCurrentTheme();
    applySidebarWidth();
    applyTagRailWidth();
    applyTagRailExpanded();
    await refreshSessions({ initial: true });
    pollTimer = setInterval(() => { if (!document.hidden) refreshSessions(); }, 2000);
  } catch (error) {
    toast(friendlyError(error), 'error');
    renderWorkspace();
  }
}

initialize();

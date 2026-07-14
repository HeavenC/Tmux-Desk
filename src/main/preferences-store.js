const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const lockfile = require('proper-lockfile');
const { DEFAULT_TMUX_SETTINGS, normalizeTmuxSettings } = require('../shared/tmux-settings');
const {
  TAG_COLORS,
  normalizeSessionKey,
  normalizeSessionTags,
  normalizeTagId,
  normalizeTagName,
  normalizeTags,
} = require('../shared/tag-model');

const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'light',
  favorites: [],
  tags: [],
  sessionTags: {},
  tabOrders: {},
  lastSession: null,
  windowBounds: null,
  sidebarWidth: null,
  tagRailExpanded: false,
  tagRailWidth: null,
  keepAwake: false,
  webQuickKeys: [],
  // The app-managed tmux profile is deliberately complete and deterministic:
  // a user does not need a ~/.tmux.conf to get the same iTerm-like behavior.
  tmuxSettings: DEFAULT_TMUX_SETTINGS,
});
const SIDEBAR_WIDTH_RANGE = Object.freeze({ min: 200, max: 420 });
const TAG_RAIL_WIDTH_RANGE = Object.freeze({ min: 180, max: 420 });

const VALID_THEMES = new Set(['light', 'dark', 'system']);

function normalizeFavorites(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = ['x', 'y', 'width', 'height'];
  if (!keys.every((key) => Number.isFinite(value[key]))) return null;
  if (value.width < 640 || value.height < 480) return null;
  return Object.fromEntries(keys.map((key) => [key, Math.round(value[key])]));
}

function normalizeSidebarWidth(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(SIDEBAR_WIDTH_RANGE.max, Math.max(SIDEBAR_WIDTH_RANGE.min, value)));
}

function normalizeTagRailWidth(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(TAG_RAIL_WIDTH_RANGE.max, Math.max(TAG_RAIL_WIDTH_RANGE.min, value)));
}

// tabOrders keys are view identifiers: 'favorites' or a tag id that must
// still exist in `tags` — an order for a deleted tag is dead weight, drop it.
function normalizeTabOrders(value, tags) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const availableViewKeys = new Set(['favorites', ...tags.map((tag) => tag.id)]);
  const result = {};
  for (const [viewKey, order] of Object.entries(value)) {
    if (!availableViewKeys.has(viewKey) || !Array.isArray(order)) continue;
    const seen = new Set();
    const names = [];
    for (const item of order) {
      const name = normalizeSessionKey(item);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    if (names.length) result[viewKey] = names;
  }
  return result;
}

// On rename, replay the old→new substitution into every stored order so a
// renamed session keeps the position the user dragged it to.
function renameInTabOrders(tabOrders, oldValue, newValue) {
  const result = {};
  for (const [viewKey, order] of Object.entries(tabOrders || {})) {
    const seen = new Set();
    const renamed = [];
    for (const item of order) {
      const name = item === oldValue ? newValue : item;
      if (seen.has(name)) continue;
      seen.add(name);
      renamed.push(name);
    }
    if (renamed.length) result[viewKey] = renamed;
  }
  return result;
}

function normalizePreferences(value = {}) {
  const tags = normalizeTags(value.tags);
  return {
    theme: VALID_THEMES.has(value.theme) ? value.theme : DEFAULT_PREFERENCES.theme,
    favorites: normalizeFavorites(value.favorites),
    tags,
    sessionTags: normalizeSessionTags(value.sessionTags, tags),
    tabOrders: normalizeTabOrders(value.tabOrders, tags),
    lastSession: typeof value.lastSession === 'string' && value.lastSession.trim()
      ? value.lastSession.trim()
      : null,
    windowBounds: normalizeBounds(value.windowBounds),
    sidebarWidth: normalizeSidebarWidth(value.sidebarWidth),
    tagRailExpanded: typeof value.tagRailExpanded === 'boolean'
      ? value.tagRailExpanded
      : DEFAULT_PREFERENCES.tagRailExpanded,
    tagRailWidth: normalizeTagRailWidth(value.tagRailWidth),
    keepAwake: typeof value.keepAwake === 'boolean'
      ? value.keepAwake
      : DEFAULT_PREFERENCES.keepAwake,
    webQuickKeys: normalizeWebQuickKeys(value.webQuickKeys),
    tmuxSettings: normalizeTmuxSettings(value.tmuxSettings, value.tmuxDefaults),
  };
}

// The mobile web toolbar's user-defined keys, stored on this machine so every
// phone that connects shares them. Validated structurally; the web client drops
// any preset id it no longer recognizes.
function normalizeWebQuickKeys(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.type === 'preset' && typeof item.id === 'string' && item.id && item.id.length <= 40) {
      out.push({ type: 'preset', id: item.id });
    } else if (item.type === 'text' && typeof item.label === 'string' && typeof item.text === 'string') {
      const label = item.label.slice(0, 16);
      const text = item.text.slice(0, 200);
      if (label && text) out.push({ type: 'text', label, text, enter: item.enter === true });
    }
    if (out.length >= 40) break;
  }
  return out;
}

function normalizeSessionName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('会话名称无效');
  return value.trim();
}

function defaultPreferencesFilePath({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const override = typeof env.TMUX_DESK_PREFERENCES_FILE === 'string'
    ? env.TMUX_DESK_PREFERENCES_FILE.trim()
    : '';
  if (override) return path.resolve(override);
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'tmux-desk', 'preferences.json');
  }
  if (platform === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA.trim()
      ? env.APPDATA
      : path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'tmux-desk', 'preferences.json');
  }
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(configHome, 'tmux-desk', 'preferences.json');
}

class PreferencesStore {
  constructor({ filePath, fsImpl, createId } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new Error('偏好文件路径无效');
    this.filePath = filePath;
    this.fs = fsImpl ? Object.assign(Object.create(fs), fsImpl) : fs;
    this.createId = createId || randomUUID;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await this.fs.readFile(this.filePath, 'utf8');
      return normalizePreferences(JSON.parse(raw));
    } catch {
      return normalizePreferences(DEFAULT_PREFERENCES);
    }
  }

  async save(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('偏好设置无效');
    }
    return this.update(() => patch);
  }

  update(createPatch) {
    const operation = this.writeQueue.then(() => this.withFileLock(async () => {
      const current = await this.load();
      const patch = await createPatch(current);
      const next = normalizePreferences({ ...current, ...patch });
      await this.writeNormalized(next);
      return next;
    }));
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async withFileLock(run) {
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const release = await lockfile.lock(this.filePath, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100 },
    });
    try {
      return await run();
    } finally {
      await release();
    }
  }

  async writeNormalized(next) {
    const temporaryPath = `${this.filePath}.tmp`;
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      try { await this.fs.unlink(temporaryPath); } catch {}
      throw error;
    }
  }

  async toggleFavorite(name) {
    const normalizedName = normalizeSessionName(name);
    return this.update((current) => ({
      favorites: current.favorites.includes(normalizedName)
        ? current.favorites.filter((item) => item !== normalizedName)
        : [...current.favorites, normalizedName],
    }));
  }

  async renameSessionReferences(oldName, newName) {
    const oldValue = normalizeSessionName(oldName);
    const newValue = normalizeSessionName(newName);
    return this.update((current) => {
      const favorites = normalizeFavorites(current.favorites.map((item) => (
        item === oldValue ? newValue : item
      )));
      const sessionTags = { ...current.sessionTags };
      let tabOrders = current.tabOrders;
      if (oldValue !== newValue) {
        const merged = [...new Set([
          ...(sessionTags[newValue] || []),
          ...(sessionTags[oldValue] || []),
        ])];
        delete sessionTags[oldValue];
        if (merged.length) sessionTags[newValue] = merged;
        tabOrders = renameInTabOrders(current.tabOrders, oldValue, newValue);
      }
      return {
        favorites,
        sessionTags,
        tabOrders,
        lastSession: current.lastSession === oldValue ? newValue : current.lastSession,
      };
    });
  }

  async renameFavorite(oldName, newName) {
    return this.renameSessionReferences(oldName, newName);
  }

  async createTag(value) {
    const name = normalizeTagName(value);
    return this.update((current) => {
      this.assertUniqueTagName(current.tags, name);
      const id = normalizeTagId(`tag-${this.createId()}`);
      if (current.tags.some((tag) => tag.id === id)) throw new Error('Tag 编号冲突');
      const tag = { id, name, color: TAG_COLORS[current.tags.length % TAG_COLORS.length] };
      return { tags: [tag, ...current.tags] };
    });
  }

  async touchTag(id) {
    const tagId = normalizeTagId(id);
    return this.update((current) => {
      const tag = current.tags.find((item) => item.id === tagId);
      if (!tag) throw new Error('Tag 不存在');
      // Pinned tags hold their manual order and never bubble up on use.
      if (tag.pinned) return {};
      // Move to the front of the unpinned region; normalizeTags re-partitions so
      // this tag lands just below the pinned block, not above it.
      const firstUnpinned = current.tags.find((item) => !item.pinned);
      if (firstUnpinned?.id === tagId) return {};
      return { tags: [tag, ...current.tags.filter((item) => item.id !== tagId)] };
    });
  }

  // Pin/unpin a tag. Pinning promotes it to the end of the pinned block;
  // unpinning drops it to the top of the recency-ordered rest. The "only the
  // topmost unpinned tag may be pinned" rule is enforced in the UI — the store
  // just maintains the pinned/unpinned split.
  async setTagPinned(id, pinned) {
    const tagId = normalizeTagId(id);
    const shouldPin = pinned === true;
    return this.update((current) => {
      const tag = current.tags.find((item) => item.id === tagId);
      if (!tag) throw new Error('Tag 不存在');
      if (Boolean(tag.pinned) === shouldPin) return {};
      const tags = current.tags.map((item) => {
        if (item.id !== tagId) return item;
        const next = { ...item };
        if (shouldPin) next.pinned = true;
        else delete next.pinned;
        return next;
      });
      return { tags };
    });
  }

  // Reorder the pinned block to match orderedIds (which must be exactly the set
  // of currently-pinned tags). The unpinned tail keeps its order.
  async reorderPinnedTags(orderedIds) {
    if (!Array.isArray(orderedIds)) throw new Error('Tag 顺序无效');
    const ids = orderedIds.map((value) => normalizeTagId(value));
    return this.update((current) => {
      const pinned = current.tags.filter((tag) => tag.pinned);
      const pinnedIds = new Set(pinned.map((tag) => tag.id));
      if (ids.length !== pinned.length || new Set(ids).size !== ids.length
        || !ids.every((tagId) => pinnedIds.has(tagId))) {
        throw new Error('Tag 顺序无效');
      }
      const byId = new Map(current.tags.map((tag) => [tag.id, tag]));
      const rest = current.tags.filter((tag) => !tag.pinned);
      return { tags: [...ids.map((tagId) => byId.get(tagId)), ...rest] };
    });
  }

  async renameTag(id, value) {
    const tagId = normalizeTagId(id);
    const name = normalizeTagName(value);
    return this.update((current) => {
      if (!current.tags.some((tag) => tag.id === tagId)) throw new Error('Tag 不存在');
      this.assertUniqueTagName(current.tags, name, tagId);
      return {
        tags: current.tags.map((tag) => (tag.id === tagId ? { ...tag, name } : tag)),
      };
    });
  }

  async deleteTag(id) {
    const tagId = normalizeTagId(id);
    return this.update((current) => {
      if (!current.tags.some((tag) => tag.id === tagId)) throw new Error('Tag 不存在');
      const sessionTags = {};
      for (const [name, ids] of Object.entries(current.sessionTags)) {
        const remaining = ids.filter((item) => item !== tagId);
        if (remaining.length) sessionTags[name] = remaining;
      }
      const tabOrders = { ...current.tabOrders };
      delete tabOrders[tagId];
      return {
        tags: current.tags.filter((tag) => tag.id !== tagId),
        sessionTags,
        tabOrders,
      };
    });
  }

  async setWebQuickKeys(keys) {
    const webQuickKeys = normalizeWebQuickKeys(keys);
    return this.update(() => ({ webQuickKeys }));
  }

  async setSessionTags(name, ids) {
    const sessionName = normalizeSessionName(name);
    if (!Array.isArray(ids)) throw new Error('Tag 列表无效');
    const tagIds = [...new Set(ids.map(normalizeTagId))];
    return this.update((current) => {
      const available = new Set(current.tags.map((tag) => tag.id));
      if (tagIds.some((id) => !available.has(id))) throw new Error('Tag 不存在');
      const sessionTags = { ...current.sessionTags };
      if (tagIds.length) sessionTags[sessionName] = tagIds;
      else delete sessionTags[sessionName];
      return { sessionTags };
    });
  }

  async copySessionTags(sourceName, targetName) {
    const source = normalizeSessionName(sourceName);
    const target = normalizeSessionName(targetName);
    return this.update((current) => {
      const sessionTags = { ...current.sessionTags };
      const sourceTags = current.sessionTags[source] || [];
      if (sourceTags.length) sessionTags[target] = [...sourceTags];
      else delete sessionTags[target];
      return { sessionTags };
    });
  }

  async removeSessionTags(name) {
    const sessionName = normalizeSessionName(name);
    return this.update((current) => {
      const sessionTags = { ...current.sessionTags };
      delete sessionTags[sessionName];
      return { sessionTags };
    });
  }

  assertUniqueTagName(tags, name, exceptId = null) {
    const normalizedName = name.toLocaleLowerCase();
    if (tags.some((tag) => tag.id !== exceptId && tag.name.toLocaleLowerCase() === normalizedName)) {
      throw new Error('已存在同名 Tag');
    }
  }
}

module.exports = {
  DEFAULT_PREFERENCES,
  PreferencesStore,
  defaultPreferencesFilePath,
  normalizePreferences,
};

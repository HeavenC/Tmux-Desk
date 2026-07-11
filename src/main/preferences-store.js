const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  TAG_COLORS,
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
  lastSession: null,
  windowBounds: null,
  sidebarWidth: null,
  tagRailExpanded: false,
});
const SIDEBAR_WIDTH_RANGE = Object.freeze({ min: 200, max: 420 });
const PREFERENCES_LOCK_TIMEOUT_MS = 5000;
const PREFERENCES_LOCK_STALE_MS = 30000;
const PREFERENCES_LOCK_RETRY_MS = 10;

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

function normalizePreferences(value = {}) {
  const tags = normalizeTags(value.tags);
  return {
    theme: VALID_THEMES.has(value.theme) ? value.theme : DEFAULT_PREFERENCES.theme,
    favorites: normalizeFavorites(value.favorites),
    tags,
    sessionTags: normalizeSessionTags(value.sessionTags, tags),
    lastSession: typeof value.lastSession === 'string' && value.lastSession.trim()
      ? value.lastSession.trim()
      : null,
    windowBounds: normalizeBounds(value.windowBounds),
    sidebarWidth: normalizeSidebarWidth(value.sidebarWidth),
    tagRailExpanded: typeof value.tagRailExpanded === 'boolean'
      ? value.tagRailExpanded
      : DEFAULT_PREFERENCES.tagRailExpanded,
  };
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
    this.lockPath = `${this.filePath}.lock`;
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
    const startedAt = Date.now();
    let handle = null;
    while (!handle) {
      try {
        handle = await this.fs.open(this.lockPath, 'wx');
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (await this.removeStaleLock()) continue;
        if (Date.now() - startedAt >= PREFERENCES_LOCK_TIMEOUT_MS) {
          throw new Error('偏好文件正被其他进程占用');
        }
        await new Promise((resolve) => setTimeout(resolve, PREFERENCES_LOCK_RETRY_MS));
      }
    }
    try {
      return await run();
    } finally {
      try { await handle.close(); } finally {
        try { await this.fs.unlink(this.lockPath); } catch {}
      }
    }
  }

  async removeStaleLock() {
    try {
      const stats = await this.fs.stat(this.lockPath);
      if (Date.now() - stats.mtimeMs <= PREFERENCES_LOCK_STALE_MS) return false;
      await this.fs.unlink(this.lockPath);
      return true;
    } catch (error) {
      return error?.code === 'ENOENT';
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
      if (oldValue !== newValue) {
        const merged = [...new Set([
          ...(sessionTags[newValue] || []),
          ...(sessionTags[oldValue] || []),
        ])];
        delete sessionTags[oldValue];
        if (merged.length) sessionTags[newValue] = merged;
      }
      return {
        favorites,
        sessionTags,
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
      if (current.tags[0]?.id === tagId) return {};
      return { tags: [tag, ...current.tags.filter((item) => item.id !== tagId)] };
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
      return {
        tags: current.tags.filter((tag) => tag.id !== tagId),
        sessionTags,
      };
    });
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

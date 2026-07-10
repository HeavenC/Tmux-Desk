const fs = require('node:fs/promises');
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
});

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
  };
}

function normalizeSessionName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('会话名称无效');
  return value.trim();
}

class PreferencesStore {
  constructor({ filePath, fsImpl, createId } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new Error('偏好文件路径无效');
    this.filePath = filePath;
    this.fs = fsImpl || fs;
    this.createId = createId || randomUUID;
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
    const next = normalizePreferences({ ...(await this.load()), ...patch });
    const temporaryPath = `${this.filePath}.tmp`;
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      try { await this.fs.unlink(temporaryPath); } catch {}
      throw error;
    }
    return next;
  }

  async toggleFavorite(name) {
    const normalizedName = normalizeSessionName(name);
    const current = await this.load();
    const favorites = current.favorites.includes(normalizedName)
      ? current.favorites.filter((item) => item !== normalizedName)
      : [...current.favorites, normalizedName];
    return this.save({ favorites });
  }

  async renameSessionReferences(oldName, newName) {
    const oldValue = normalizeSessionName(oldName);
    const newValue = normalizeSessionName(newName);
    const current = await this.load();
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
    return this.save({
      favorites,
      sessionTags,
      lastSession: current.lastSession === oldValue ? newValue : current.lastSession,
    });
  }

  async renameFavorite(oldName, newName) {
    return this.renameSessionReferences(oldName, newName);
  }

  async createTag(value) {
    const name = normalizeTagName(value);
    const current = await this.load();
    this.assertUniqueTagName(current.tags, name);
    const id = normalizeTagId(`tag-${this.createId()}`);
    if (current.tags.some((tag) => tag.id === id)) throw new Error('Tag 编号冲突');
    const tag = { id, name, color: TAG_COLORS[current.tags.length % TAG_COLORS.length] };
    return this.save({ tags: [...current.tags, tag] });
  }

  async renameTag(id, value) {
    const tagId = normalizeTagId(id);
    const name = normalizeTagName(value);
    const current = await this.load();
    if (!current.tags.some((tag) => tag.id === tagId)) throw new Error('Tag 不存在');
    this.assertUniqueTagName(current.tags, name, tagId);
    return this.save({
      tags: current.tags.map((tag) => (tag.id === tagId ? { ...tag, name } : tag)),
    });
  }

  async deleteTag(id) {
    const tagId = normalizeTagId(id);
    const current = await this.load();
    if (!current.tags.some((tag) => tag.id === tagId)) throw new Error('Tag 不存在');
    const sessionTags = {};
    for (const [name, ids] of Object.entries(current.sessionTags)) {
      const remaining = ids.filter((item) => item !== tagId);
      if (remaining.length) sessionTags[name] = remaining;
    }
    return this.save({
      tags: current.tags.filter((tag) => tag.id !== tagId),
      sessionTags,
    });
  }

  async setSessionTags(name, ids) {
    const sessionName = normalizeSessionName(name);
    if (!Array.isArray(ids)) throw new Error('Tag 列表无效');
    const current = await this.load();
    const available = new Set(current.tags.map((tag) => tag.id));
    const tagIds = [...new Set(ids.map(normalizeTagId))];
    if (tagIds.some((id) => !available.has(id))) throw new Error('Tag 不存在');
    const sessionTags = { ...current.sessionTags };
    if (tagIds.length) sessionTags[sessionName] = tagIds;
    else delete sessionTags[sessionName];
    return this.save({ sessionTags });
  }

  async copySessionTags(sourceName, targetName) {
    const source = normalizeSessionName(sourceName);
    const target = normalizeSessionName(targetName);
    const current = await this.load();
    const sessionTags = { ...current.sessionTags };
    const sourceTags = current.sessionTags[source] || [];
    if (sourceTags.length) sessionTags[target] = [...sourceTags];
    else delete sessionTags[target];
    return this.save({ sessionTags });
  }

  async removeSessionTags(name) {
    const sessionName = normalizeSessionName(name);
    const current = await this.load();
    const sessionTags = { ...current.sessionTags };
    delete sessionTags[sessionName];
    return this.save({ sessionTags });
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
  normalizePreferences,
};

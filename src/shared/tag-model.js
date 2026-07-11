const TAG_COLORS = Object.freeze(['blue', 'green', 'gold', 'purple', 'rose', 'cyan']);
const TAG_ID_PATTERN = /^tag-[a-zA-Z0-9-]{1,80}$/;

function normalizeTagName(value) {
  if (typeof value !== 'string') throw new Error('Tag 名称无效');
  const name = value.trim();
  if (!name || Array.from(name).length > 40) throw new Error('Tag 名称无效');
  return name;
}

function normalizeTagId(value) {
  if (typeof value !== 'string' || !TAG_ID_PATTERN.test(value)) throw new Error('Tag 编号无效');
  return value;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const names = new Set();
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let id;
    let name;
    try {
      id = normalizeTagId(item.id);
      name = normalizeTagName(item.name);
    } catch {
      continue;
    }
    const normalizedName = name.toLocaleLowerCase();
    if (ids.has(id) || names.has(normalizedName) || !TAG_COLORS.includes(item.color)) continue;
    ids.add(id);
    names.add(normalizedName);
    result.push({ id, name, color: item.color });
  }
  return result;
}

function normalizeSessionKey(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || Array.from(name).length > 80 || /[.:\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}

function normalizeSessionTags(value, tags) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const available = new Set(normalizeTags(tags).map((tag) => tag.id));
  const result = {};
  for (const [rawName, rawIds] of Object.entries(value)) {
    const name = normalizeSessionKey(rawName);
    if (!name || !Array.isArray(rawIds)) continue;
    const ids = [...new Set(rawIds.filter((id) => typeof id === 'string' && available.has(id)))];
    if (!ids.length) continue;
    result[name] = [...new Set([...(result[name] || []), ...ids])];
  }
  return result;
}

module.exports = {
  TAG_COLORS,
  TAG_ID_PATTERN,
  normalizeSessionKey,
  normalizeSessionTags,
  normalizeTagId,
  normalizeTagName,
  normalizeTags,
};

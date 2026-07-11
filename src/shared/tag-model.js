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
    const tag = { id, name, color: item.color };
    if (item.pinned === true) tag.pinned = true;
    result.push(tag);
  }
  // Pinned tags always sort ahead of the recency-ordered rest. A stable
  // partition keeps each group's relative order, so pinning never depends on how
  // the array happened to be persisted — the invariant holds after every load.
  const pinned = result.filter((tag) => tag.pinned);
  const rest = result.filter((tag) => !tag.pinned);
  return pinned.length ? [...pinned, ...rest] : result;
}

// The tag id one step away from `currentTagId` in the rail order, for ⌘↑/↓
// browsing. direction -1 = previous (up), +1 = next (down). When the current
// view isn't a tag (All/Favorites — currentTagId not in the list), enter from
// the matching end: down → first tag, up → last tag. Clamps at the ends (no
// wrap-around, matching ⌘←/→ tab switching). Returns null when there's nowhere
// to go. This is deliberately order-only: it never reorders the list, so ⌘↑/↓
// never triggers the recency promotion that clicking a tag does.
function adjacentTagId(tags, currentTagId, direction) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length || (direction !== 1 && direction !== -1)) return null;
  const index = list.findIndex((tag) => tag && tag.id === currentTagId);
  let target;
  if (index === -1) {
    target = direction > 0 ? 0 : list.length - 1;
  } else {
    target = index + direction;
    if (target < 0 || target >= list.length) return null;
  }
  const tag = list[target];
  return tag && tag.id !== currentTagId ? tag.id : null;
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
  adjacentTagId,
  normalizeSessionKey,
  normalizeSessionTags,
  normalizeTagId,
  normalizeTagName,
  normalizeTags,
};

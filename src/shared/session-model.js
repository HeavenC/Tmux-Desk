function searchableText(session) {
  return [session.name, session.path, session.activeCommand]
    .filter((value) => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase();
}

function byRecentActivity(left, right) {
  const activityDifference = Number(right.activity || 0) - Number(left.activity || 0);
  if (activityDifference) return activityDifference;
  return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
}

function filterAndGroupSessions(sessions, favorites, query, favoritesOnly) {
  const items = Array.isArray(sessions) ? sessions : [];
  const favoriteNames = Array.isArray(favorites) ? favorites : [];
  const favoriteOrder = new Map(favoriteNames.map((name, index) => [name, index]));
  const normalizedQuery = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
  const filtered = items.filter((session) => (
    !normalizedQuery || searchableText(session).includes(normalizedQuery)
  ));
  const favoriteSessions = filtered
    .filter((session) => favoriteOrder.has(session.name))
    .sort((left, right) => favoriteOrder.get(left.name) - favoriteOrder.get(right.name));
  const ordinarySessions = favoritesOnly
    ? []
    : filtered.filter((session) => !favoriteOrder.has(session.name)).sort(byRecentActivity);
  return { favorites: favoriteSessions, sessions: ordinarySessions };
}

function sessionsForView(sessions, preferences, view) {
  const items = Array.isArray(sessions) ? sessions : [];
  if (!view || view.kind === 'all') return [];
  const stored = preferences && typeof preferences === 'object' ? preferences : {};
  let includedNames;
  if (view.kind === 'favorites') {
    includedNames = new Set(Array.isArray(stored.favorites) ? stored.favorites : []);
  } else if (view.kind === 'tag' && typeof view.tagId === 'string') {
    const sessionTags = stored.sessionTags && typeof stored.sessionTags === 'object' && !Array.isArray(stored.sessionTags)
      ? stored.sessionTags
      : {};
    includedNames = new Set(Object.entries(sessionTags)
      .filter(([, tagIds]) => Array.isArray(tagIds) && tagIds.includes(view.tagId))
      .map(([name]) => name));
  } else {
    return [];
  }
  const seen = new Set();
  return items
    .filter((session) => {
      if (!session || !includedNames.has(session.name) || seen.has(session.name)) return false;
      seen.add(session.name);
      return true;
    })
    .sort(byRecentActivity);
}

module.exports = { filterAndGroupSessions, sessionsForView };

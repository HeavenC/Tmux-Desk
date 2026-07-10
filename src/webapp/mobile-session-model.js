const { sessionsForView } = require('../shared/session-model');

function byRecentActivity(left, right) {
  const activityDifference = Number(right.activity || 0) - Number(left.activity || 0);
  if (activityDifference) return activityDifference;
  return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
}

function uniqueLiveSessions(sessions) {
  const sorted = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session
      && typeof session.name === 'string'
      && session.name.trim())
    .slice()
    .sort(byRecentActivity);
  const seen = new Set();
  return sorted.filter((session) => {
    if (seen.has(session.name)) return false;
    seen.add(session.name);
    return true;
  });
}

function mobileSessionsForView(sessions, preferences, view) {
  const items = uniqueLiveSessions(sessions);
  if (view?.kind === 'all') return items;
  if (view?.kind === 'favorites' || view?.kind === 'tag') {
    return sessionsForView(items, preferences, view);
  }
  return [];
}

function liveCountForView(sessions, preferences, view) {
  return mobileSessionsForView(sessions, preferences, view).length;
}

module.exports = {
  liveCountForView,
  mobileSessionsForView,
};

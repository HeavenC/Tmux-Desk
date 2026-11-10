const assert = require('node:assert/strict');
const test = require('node:test');

const { filterAndGroupSessions, sessionMatchesQuery, sessionsForView } = require('../src/shared/session-model');

const sessions = [
  { name: 'api', path: '/work/backend', activeCommand: 'node', activity: 20 },
  { name: 'db', path: '/work/data', activeCommand: 'mysql', activity: 10 },
  { name: '☸️ K8S-UAT', path: '/work/infra', activeCommand: 'kubectl', activity: 30 },
];

test('favorites are grouped before other sessions and retain favorite order', () => {
  const result = filterAndGroupSessions(sessions, ['db', 'api'], '', false);
  assert.deepEqual(result.favorites.map((item) => item.name), ['db', 'api']);
  assert.deepEqual(result.sessions.map((item) => item.name), ['☸️ K8S-UAT']);
});

test('search is case insensitive across name, path, and active command', () => {
  assert.deepEqual(filterAndGroupSessions(sessions, [], 'k8s', false).sessions.map((item) => item.name), ['☸️ K8S-UAT']);
  assert.deepEqual(filterAndGroupSessions(sessions, [], 'BACKEND', false).sessions.map((item) => item.name), ['api']);
  assert.deepEqual(filterAndGroupSessions(sessions, [], 'mysql', false).sessions.map((item) => item.name), ['db']);
});

test('favorites-only mode excludes ordinary sessions and stale favorite names', () => {
  const result = filterAndGroupSessions(sessions, ['missing', 'db'], '', true);
  assert.deepEqual(result.favorites.map((item) => item.name), ['db']);
  assert.deepEqual(result.sessions, []);
});

test('ordinary sessions are sorted by recent activity without mutating input', () => {
  const original = sessions.map((item) => item.name);
  const result = filterAndGroupSessions(sessions, [], '', false);
  assert.deepEqual(result.sessions.map((item) => item.name), ['☸️ K8S-UAT', 'api', 'db']);
  assert.deepEqual(sessions.map((item) => item.name), original);
});

test('tag view returns each associated live session once, name-sorted without a stored tab order', () => {
  const preferences = {
    favorites: [],
    sessionTags: { api: ['tag-a', 'tag-a'], db: ['tag-b'], '☸️ K8S-UAT': ['tag-a', 'tag-b'] },
  };
  assert.deepEqual(
    sessionsForView(sessions, preferences, { kind: 'tag', tagId: 'tag-a' }).map((item) => item.name),
    ['☸️ K8S-UAT', 'api'],
  );
});

test('favorites view is name-sorted without a stored tab order and all view has no compact tabs', () => {
  const preferences = { favorites: ['db', 'api', 'missing'], sessionTags: {} };
  assert.deepEqual(
    sessionsForView(sessions, preferences, { kind: 'favorites' }).map((item) => item.name),
    ['api', 'db'],
  );
  assert.deepEqual(sessionsForView(sessions, preferences, { kind: 'all' }), []);
});

test('compact view selection tolerates malformed preferences without mutating sessions', () => {
  const original = sessions.map((item) => item.name);
  assert.deepEqual(sessionsForView(sessions, null, { kind: 'favorites' }), []);
  assert.deepEqual(sessionsForView(sessions, { favorites: [], sessionTags: [] }, { kind: 'tag', tagId: 'tag-a' }), []);
  assert.deepEqual(sessionsForView(sessions, {}, { kind: 'tag' }), []);
  assert.deepEqual(sessions.map((item) => item.name), original);
});

test('a stored tab order wins over both activity and name, ignoring activity entirely', () => {
  const preferences = { favorites: ['db', 'api'], sessionTags: {}, tabOrders: { favorites: ['db', 'api'] } };
  // api has higher activity (20) than db (10) — if activity still influenced
  // ordering this would come back ['api', 'db'] instead of the stored order.
  assert.deepEqual(
    sessionsForView(sessions, preferences, { kind: 'favorites' }).map((item) => item.name),
    ['db', 'api'],
  );
});

test('sessions absent from the stored tab order are appended at the end, name-sorted', () => {
  const preferences = {
    favorites: [],
    sessionTags: { api: ['tag-a'], db: ['tag-a'], '☸️ K8S-UAT': ['tag-a'] },
    tabOrders: { 'tag-a': ['db'] },
  };
  assert.deepEqual(
    sessionsForView(sessions, preferences, { kind: 'tag', tagId: 'tag-a' }).map((item) => item.name),
    ['db', '☸️ K8S-UAT', 'api'],
  );
});

test('stale names in the stored tab order are ignored when the session is no longer in view', () => {
  const preferences = { favorites: ['api'], sessionTags: {}, tabOrders: { favorites: ['ghost', 'api'] } };
  assert.deepEqual(
    sessionsForView(sessions, preferences, { kind: 'favorites' }).map((item) => item.name),
    ['api'],
  );
});

test('sessionMatchesQuery matches name, path and command case-insensitively; blank matches all', () => {
  const names = (query) => sessions.filter((session) => sessionMatchesQuery(session, query)).map((item) => item.name);
  assert.deepEqual(names(''), ['api', 'db', '☸️ K8S-UAT']);
  assert.deepEqual(names('   '), ['api', 'db', '☸️ K8S-UAT']);
  assert.deepEqual(names('k8s'), ['☸️ K8S-UAT']);
  assert.deepEqual(names('  BACKEND '), ['api']);
  assert.deepEqual(names('mysql'), ['db']);
  assert.deepEqual(names('nothing-here'), []);
  assert.equal(sessionMatchesQuery(null, 'x'), false);
});

test('the desktop sidebar and the shared predicate agree on every query', () => {
  for (const query of ['', 'a', 'WORK', 'kubectl', '☸️', 'zzz']) {
    const grouped = filterAndGroupSessions(sessions, ['db'], query, false);
    const desktop = [...grouped.favorites, ...grouped.sessions].map((item) => item.name).sort();
    const shared = sessions.filter((session) => sessionMatchesQuery(session, query)).map((item) => item.name).sort();
    assert.deepEqual(desktop, shared, `query ${JSON.stringify(query)}`);
  }
});

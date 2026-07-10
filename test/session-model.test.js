const assert = require('node:assert/strict');
const test = require('node:test');

const { filterAndGroupSessions, sessionsForView } = require('../src/shared/session-model');

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

test('tag view returns each associated live session once by recent activity', () => {
  const preferences = {
    favorites: [],
    sessionTags: { api: ['tag-a', 'tag-a'], db: ['tag-b'], '☸️ K8S-UAT': ['tag-a', 'tag-b'] },
  };
  assert.deepEqual(
    sessionsForView(sessions, preferences, { kind: 'tag', tagId: 'tag-a' }).map((item) => item.name),
    ['☸️ K8S-UAT', 'api'],
  );
});

test('favorites view is activity sorted and all view has no compact tabs', () => {
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

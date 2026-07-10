const assert = require('node:assert/strict');
const test = require('node:test');

const {
  liveCountForView,
  mobileSessionsForView,
} = require('../src/webapp/mobile-session-model');

const sessions = [
  { id: '$1', name: 'api', activity: 10, marker: 'older' },
  { id: '$3', name: 'other', activity: 5 },
  { id: '$2', name: 'worker', activity: 20 },
  { id: '$1', name: 'api', activity: 30, marker: 'newer' },
];
const preferences = {
  favorites: ['worker', 'api'],
  tags: [
    { id: 'tag-a', name: 'DMS', color: 'blue' },
    { id: 'tag-b', name: 'K8S', color: 'green' },
  ],
  sessionTags: {
    api: ['tag-a', 'tag-a'],
    worker: ['tag-a', 'tag-b'],
  },
};

test('mobile all view keeps the newest copy of each session without mutating input', () => {
  const before = structuredClone(sessions);
  const selected = mobileSessionsForView(sessions, preferences, { kind: 'all' });
  assert.deepEqual(selected.map((session) => session.name), ['api', 'worker', 'other']);
  assert.equal(selected[0].marker, 'newer');
  assert.deepEqual(sessions, before);
});

test('mobile favorites and tag views share activity ordering and deduplicate names', () => {
  assert.deepEqual(
    mobileSessionsForView(sessions, preferences, { kind: 'favorites' }).map((session) => session.name),
    ['api', 'worker'],
  );
  assert.deepEqual(
    mobileSessionsForView(sessions, preferences, { kind: 'tag', tagId: 'tag-a' }).map((session) => session.name),
    ['api', 'worker'],
  );
  assert.deepEqual(
    mobileSessionsForView(sessions, preferences, { kind: 'tag', tagId: 'tag-b' }).map((session) => session.name),
    ['worker'],
  );
  assert.equal(liveCountForView(sessions, preferences, { kind: 'tag', tagId: 'tag-a' }), 2);
});

test('mobile selector tolerates malformed payloads and unknown views', () => {
  assert.deepEqual(mobileSessionsForView(null, null, { kind: 'all' }), []);
  assert.deepEqual(mobileSessionsForView([null, { name: '' }], {}, { kind: 'all' }), []);
  assert.deepEqual(mobileSessionsForView(sessions, { sessionTags: [] }, { kind: 'tag', tagId: 'tag-a' }), []);
  assert.deepEqual(mobileSessionsForView(sessions, preferences, { kind: 'tag' }), []);
  assert.deepEqual(mobileSessionsForView(sessions, preferences, { kind: 'unknown' }), []);
  assert.equal(liveCountForView(null, null, { kind: 'all' }), 0);
});

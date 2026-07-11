const assert = require('node:assert/strict');
const test = require('node:test');

const { adjacentTagId } = require('../src/shared/tag-model');

const TAGS = [{ id: 'tag-a' }, { id: 'tag-b' }, { id: 'tag-c' }];

test('moves to the next / previous tag in rail order', () => {
  assert.equal(adjacentTagId(TAGS, 'tag-a', 1), 'tag-b');
  assert.equal(adjacentTagId(TAGS, 'tag-b', 1), 'tag-c');
  assert.equal(adjacentTagId(TAGS, 'tag-b', -1), 'tag-a');
  assert.equal(adjacentTagId(TAGS, 'tag-c', -1), 'tag-b');
});

test('clamps at the ends (no wrap-around)', () => {
  assert.equal(adjacentTagId(TAGS, 'tag-c', 1), null);
  assert.equal(adjacentTagId(TAGS, 'tag-a', -1), null);
});

test('enters from the matching end when no tag is active (All / Favorites view)', () => {
  assert.equal(adjacentTagId(TAGS, null, 1), 'tag-a');
  assert.equal(adjacentTagId(TAGS, null, -1), 'tag-c');
  // An unknown / stale tag id behaves like "no current tag".
  assert.equal(adjacentTagId(TAGS, 'tag-gone', 1), 'tag-a');
});

test('returns null for empty lists and invalid directions', () => {
  assert.equal(adjacentTagId([], 'tag-a', 1), null);
  assert.equal(adjacentTagId(null, 'tag-a', 1), null);
  assert.equal(adjacentTagId(TAGS, 'tag-a', 0), null);
  assert.equal(adjacentTagId(TAGS, 'tag-a', 2), null);
});

test('does not reorder or mutate the tag list', () => {
  const tags = [{ id: 'tag-a' }, { id: 'tag-b' }, { id: 'tag-c' }];
  const snapshot = JSON.stringify(tags);
  adjacentTagId(tags, 'tag-c', 1);
  adjacentTagId(tags, 'tag-a', 1);
  assert.equal(JSON.stringify(tags), snapshot);
});

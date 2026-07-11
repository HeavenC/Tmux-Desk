const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
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
const webappDir = join(__dirname, '..', 'src', 'webapp');

test('mobile all view keeps the newest copy of each session without mutating input', () => {
  const before = structuredClone(sessions);
  const selected = mobileSessionsForView(sessions, preferences, { kind: 'all' });
  assert.deepEqual(selected.map((session) => session.name), ['api', 'worker', 'other']);
  assert.equal(selected[0].marker, 'newer');
  assert.deepEqual(sessions, before);
});

test('mobile favorites and tag views fall back to a name sort without a stored tab order, deduplicating names', () => {
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

test('mobile favorites and tag views honor a stored tab order, same as the desktop compact view', () => {
  const ordered = { ...preferences, tabOrders: { favorites: ['worker', 'api'], 'tag-a': ['worker', 'api'] } };
  assert.deepEqual(
    mobileSessionsForView(sessions, ordered, { kind: 'favorites' }).map((session) => session.name),
    ['worker', 'api'],
  );
  assert.deepEqual(
    mobileSessionsForView(sessions, ordered, { kind: 'tag', tagId: 'tag-a' }).map((session) => session.name),
    ['worker', 'api'],
  );
});

test('mobile selector tolerates malformed payloads and unknown views', () => {
  assert.deepEqual(mobileSessionsForView(null, null, { kind: 'all' }), []);
  assert.deepEqual(mobileSessionsForView([null, { name: '' }], {}, { kind: 'all' }), []);
  assert.deepEqual(mobileSessionsForView(sessions, { sessionTags: [] }, { kind: 'tag', tagId: 'tag-a' }), []);
  assert.deepEqual(mobileSessionsForView(sessions, preferences, { kind: 'tag' }), []);
  assert.deepEqual(mobileSessionsForView(sessions, preferences, { kind: 'unknown' }), []);
  assert.equal(liveCountForView(null, null, { kind: 'all' }), 0);
});

test('mobile page exposes touch-first tag workspaces and one window picker', async () => {
  const [html, css] = await Promise.all([
    readFile(join(webappDir, 'index.html'), 'utf8'),
    readFile(join(webappDir, 'styles.css'), 'utf8'),
  ]);
  for (const id of [
    'workspace-filters', 'session-tags-modal', 'session-tags-form',
    'session-tags-list', 'session-tags-cancel', 'window-picker',
    'theme-btn-list', 'theme-btn-term',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /id="workspace-filters"[^>]+aria-label="会话工作区"/);
  assert.match(html, /id="session-tags-modal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="window-picker"[^>]+aria-label="tmux 窗口"/);
  assert.doesNotMatch(html + css, /window-chips|window-chip/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);

  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /\.workspace-filter[^{]*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.session-tag-button[^{]*\{[^}]*min-(?:height|width):\s*44px/s);
  assert.match(css, /padding-bottom:[^;]*safe-area-inset-bottom/s);
  assert.match(css, /\.sheet-panel\s*\{/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{/);
});

test('mobile controller consumes shared tag data and preserves terminal controls', async () => {
  const app = await readFile(join(webappDir, 'app.js'), 'utf8');
  assert.match(app, /require\(['"]\.\/mobile-session-model['"]\)/);
  assert.match(app, /listView:\s*\{\s*kind:\s*'all'\s*\}/);
  assert.match(app, /function renderWorkspaceFilters\(/);
  assert.match(app, /function openSessionTagsModal\(/);
  assert.match(app, /apiUrl\(['"]\/api\/session-tags['"]\)/);
  assert.match(app, /event\.stopPropagation\(\)/);
  assert.match(app, /if \(event\.target !== li\) return;/);
  assert.match(app, /function renderWindowPicker\(/);
  assert.doesNotMatch(app, /renderWindowChips|window-chips|window-chip/);
  assert.match(app, /window\.visualViewport/);
  assert.match(app, /onViewportChange\(\)/);
  assert.match(app, /function setupTouchScroll\(/);
  assert.match(app, /setupTouchScroll\(\)/);
  assert.match(app, /document\.querySelectorAll\(['"]\.theme-btn['"]\)[\s\S]*addEventListener\(['"]click['"],\s*toggleTheme\)/);
  assert.match(app, /applyTheme\(storedTheme\(\)\)/);
});

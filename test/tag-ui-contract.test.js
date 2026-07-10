const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const test = require('node:test');

const rendererDir = join(__dirname, '..', 'src', 'renderer');

test('renderer exposes tag navigation, management dialogs, and one session tab row', async () => {
  const html = await readFile(join(rendererDir, 'index.html'), 'utf8');
  for (const id of [
    'appShell', 'tagRail', 'newTagButton', 'sessionTabs', 'tagEditorModal', 'tagEditorForm',
    'sessionTagsModal', 'sessionTagsForm', 'tagDeleteModal', 'tagSettingsList', 'settingsNewTagButton',
    'sidebarResizer',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']windowTabs["']/);
  assert.match(html, /id="sessionTabs"[^>]+aria-label="会话页签"/);
});

test('compact views hide the middle sidebar and collapse an empty session tab row', async () => {
  const css = await readFile(join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /\.app-shell\.compact-view\s*\{[^}]*grid-template-columns:\s*62px\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(css, /\.app-shell\.compact-view\s+\.session-sidebar\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.session-tabs:empty\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.tag-rail\s*\{/);
  assert.match(css, /\.app-shell\.compact-view\s+\.sidebar-resizer\s*\{[^}]*display:\s*none/s);
  assert.match(css, /--session-sidebar-width:\s*284px/);
  assert.match(css, /grid-template-columns:\s*62px\s+var\(--session-sidebar-width\)\s+0\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /@media\s*\(max-width:\s*1050px\)[\s\S]*grid-template-columns:\s*56px\s+var\(--session-sidebar-width\)/);
});

test('renderer controller uses explicit all, favorites, and tag workspace state', async () => {
  const app = await readFile(join(rendererDir, 'app.js'), 'utf8');
  assert.match(app, /view:\s*\{\s*kind:\s*'all'\s*\}/);
  assert.match(app, /function renderSessionTabs\(/);
  assert.match(app, /function openSessionTagsModal\(/);
  assert.match(app, /function renderTagRail\(/);
  assert.doesNotMatch(app, /favoritesOnly/);
  assert.doesNotMatch(app, /windowTabs/);
  assert.doesNotMatch(app, /setAttribute\(['"]role['"],\s*['"]listitem['"]\)/);
  assert.match(app, /style\.setProperty\(['"]--session-sidebar-width['"]/);
  assert.doesNotMatch(app, /style\.gridTemplateColumns/);
});

test('tag icon has its own artwork rather than falling back to the info icon', () => {
  const { icon } = require('../src/renderer/icons');
  assert.notEqual(icon('tag'), icon('info'));
});

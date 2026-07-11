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
    'sidebarResizer', 'tagRailResizer', 'tagRailToggleButton', 'settingsScroll',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']windowTabs["']/);
  assert.match(html, /id="sessionTabs"[^>]+aria-label="会话页签"/);
  assert.match(html, /id="tagRail"[^>]+role="group"[^>]+aria-label="会话 Tag"/);
  assert.match(html, /id="tagRailToggleButton"[^>]+aria-controls="tagRail"/);
});

test('tag rail owns the available height and compact views keep the dynamic rail width', async () => {
  const css = await readFile(join(rendererDir, 'styles.css'), 'utf8');
  assert.match(css, /--activity-rail-width:\s*62px/);
  assert.match(css, /--tag-rail-resizer-width:\s*0px/);
  assert.match(css, /\.app-shell\.tag-rail-expanded\s*\{[^}]*--activity-rail-width:[^}]*--tag-rail-resizer-width:\s*5px/s);
  assert.match(css, /\.app-shell\.compact-view\s*\{[^}]*grid-template-columns:\s*var\(--activity-rail-width\)\s+var\(--tag-rail-resizer-width\)\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(css, /\.app-shell\.compact-view\s+\.session-sidebar\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.session-tabs:empty\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.tag-rail\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(css, /\.rail-spacer\s*\{[^}]*flex:\s*1/s);
  assert.match(css, /\.tag-name\s*\{/);
  assert.match(css, /\.app-shell\.compact-view\s+\.sidebar-resizer\s*\{[^}]*display:\s*none/s);
  assert.match(css, /--session-sidebar-width:\s*284px/);
  assert.match(css, /grid-template-columns:\s*var\(--activity-rail-width\)\s+var\(--tag-rail-resizer-width\)\s+var\(--session-sidebar-width\)\s+0\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /\.tag-rail-resizer\s*\{[^}]*cursor:\s*col-resize/s);
  assert.match(css, /\.app-shell:not\(\.tag-rail-expanded\)\s+\.tag-rail-resizer\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /body\.tag-rail-resizing\s*\{[^}]*user-select:\s*none/s);
  assert.match(css, /@media\s*\(max-width:\s*1050px\)[\s\S]*--activity-rail-width:\s*56px/);
});

test('settings modal caps its height and scrolls only its content body', async () => {
  const [html, css] = await Promise.all([
    readFile(join(rendererDir, 'index.html'), 'utf8'),
    readFile(join(rendererDir, 'styles.css'), 'utf8'),
  ]);
  assert.match(html, /class=["']settings-scroll["'][^>]+id=["']settingsScroll["']/);
  assert.match(css, /\.settings-modal\s*\{[^}]*max-height:\s*min\(760px,\s*calc\(100vh\s*-\s*56px\)\)[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.settings-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
});

test('renderer controller uses explicit all, favorites, and tag workspace state', async () => {
  const app = await readFile(join(rendererDir, 'app.js'), 'utf8');
  assert.match(app, /view:\s*\{\s*kind:\s*'all'\s*\}/);
  assert.match(app, /function renderSessionTabs\(/);
  assert.match(app, /function openSessionTagsModal\(/);
  assert.match(app, /function renderTagRail\(/);
  assert.match(app, /api\.touchTag\(/);
  assert.match(app, /tagRailExpanded/);
  assert.match(app, /tagRailWidth/);
  assert.match(app, /const TAG_RAIL_WIDTH_MIN\s*=\s*180/);
  assert.match(app, /const TAG_RAIL_WIDTH_MAX\s*=\s*420/);
  assert.match(app, /function clampTagRailWidth\(/);
  assert.match(app, /function applyTagRailWidth\(/);
  assert.match(app, /function bindTagRailResizer\(/);
  assert.match(app, /savePreferences\(\{ tagRailWidth: width \}\)/);
  assert.match(app, /savePreferences\(\{ tagRailWidth: null \}\)/);
  assert.match(app, /function tagRailPositions\(/);
  assert.match(app, /prefers-reduced-motion:\s*reduce/);
  assert.match(app, /\.animate\([\s\S]*duration:\s*180[\s\S]*cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\)/);
  assert.doesNotMatch(app, /result\.preferences/);
  assert.match(app, /const token\s*=\s*\+\+tagActivationToken/);
  assert.ok((app.match(/token\s*!==\s*tagActivationToken/g) || []).length >= 2);
  assert.ok((app.match(/\+\+tagActivationToken/g) || []).length >= 3);
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

test('compact-view shortcuts switch adjacent sessions and reserve Shift for tab reordering', async () => {
  const app = await readFile(join(rendererDir, 'app.js'), 'utf8');
  assert.match(app, /async function selectAdjacentTab\(direction\)/);
  assert.match(app, /if \(event\.shiftKey\) moveSelectedTab\([^)]+\);\s*else selectAdjacentTab\([^)]+\);/s);
});

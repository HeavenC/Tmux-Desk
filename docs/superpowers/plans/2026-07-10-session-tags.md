# Session Tags and Workspace Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent multi-Tag classification for tmux sessions and compact Tag/favorites workspaces whose sessions switch through one browser-style tab row.

**Architecture:** Extend the atomic preferences store with normalized Tag definitions and session-name associations, then expose narrowly validated IPC operations. Keep filtering and compact-view selection pure in `src/shared/session-model.js`; let the existing renderer orchestrate navigation, modals and terminal attachment while CSS changes the grid between list and compact views.

**Tech Stack:** Electron 43, CommonJS JavaScript, native DOM/CSS, Node `node:test`, tmux, xterm.js, node-pty, Electron Builder.

## Global Constraints

- One session may belong to zero or multiple Tags; it appears at most once inside one Tag.
- Only the “全部” view shows the middle session sidebar; favorites and Tag views use compact session tabs.
- Remove the visible tmux window tab row; preserve pane picker and `⌘1…9` behavior.
- Tag data remains local in Electron `userData/preferences.json`; no network or cloud synchronization.
- Tag names are unique after trimming, contain 1–40 Unicode characters, and colors come from the fixed palette.
- Deleting a Tag never calls tmux or closes a session.
- Preserve the user’s existing uncommitted `src/renderer/terminal-view.js` and `test/terminal-view.test.js` changes.

---

### Task 1: Tag preference model and lifecycle

**Files:**
- Create: `src/shared/tag-model.js`
- Modify: `src/main/preferences-store.js`
- Test: `test/preferences-store.test.js`

**Interfaces:**
- Produces: `TAG_COLORS`, `normalizeTagName(value)`, `normalizeTags(value)`, `normalizeSessionTags(value, tags)` from `src/shared/tag-model.js`.
- Produces: `PreferencesStore.createTag(name)`, `renameTag(id, name)`, `deleteTag(id)`, `setSessionTags(sessionName, tagIds)`, `copySessionTags(sourceName, targetName)`, `removeSessionTags(sessionName)`, and `renameSessionReferences(oldName, newName)`; every method returns the complete normalized preferences.
- Preferences shape becomes `{ theme, favorites, tags, sessionTags, lastSession, windowBounds }`.

- [ ] **Step 1: Write failing preference tests**

Add tests that load valid/invalid Tag definitions and exercise the complete lifecycle with a deterministic `createId`:

```js
test('tag preferences normalize definitions and remove duplicate or stale associations', async () => {
  await withStore(async (store, filePath) => {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      tags: [
        { id: 'tag-one', name: ' DMS ', color: 'blue' },
        { id: 'tag-one', name: 'duplicate id', color: 'green' },
        { id: 'tag-two', name: 'DMS', color: 'gold' },
        { id: 'tag-three', name: 'K8S', color: 'invalid' },
      ],
      sessionTags: { api: ['tag-one', 'tag-one', 'missing'], empty: ['missing'] },
    }), 'utf8');
    const preferences = await store.load();
    assert.deepEqual(preferences.tags, [{ id: 'tag-one', name: 'DMS', color: 'blue' }]);
    assert.deepEqual(preferences.sessionTags, { api: ['tag-one'] });
  });
});

test('tag lifecycle persists associations and migrates session references', async () => {
  await withStore(async (store) => {
    let preferences = await store.createTag('DMS');
    const first = preferences.tags[0];
    preferences = await store.createTag('K8S');
    const second = preferences.tags[1];
    await store.setSessionTags('api', [first.id, second.id, first.id]);
    await store.copySessionTags('api', 'api-copy');
    await store.renameSessionReferences('api', 'backend');
    await store.renameTag(first.id, '渠道');
    await store.deleteTag(second.id);
    const preferences = await store.removeSessionTags('api-copy');
    assert.equal(preferences.tags[0].name, '渠道');
    assert.deepEqual(preferences.sessionTags, { backend: [first.id] });
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test test/preferences-store.test.js`

Expected: FAIL because `tags`, `sessionTags` and Tag lifecycle methods do not exist.

- [ ] **Step 3: Implement normalized Tag data and store methods**

Create the shared model with the exact palette and validators:

```js
const TAG_COLORS = Object.freeze(['blue', 'green', 'gold', 'purple', 'rose', 'cyan']);
const TAG_ID = /^tag-[a-zA-Z0-9-]{1,80}$/;

function normalizeTagName(value) {
  if (typeof value !== 'string') throw new Error('Tag 名称无效');
  const name = value.trim();
  if (!name || Array.from(name).length > 40) throw new Error('Tag 名称无效');
  return name;
}
```

`normalizeTags()` must keep the first valid unique id and first case-insensitively unique name. `normalizeSessionTags()` must keep only valid session-name keys, existing Tag ids and the first occurrence of each id; omit empty arrays.

Extend defaults and normalization:

```js
const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'light', favorites: [], tags: [], sessionTags: {}, lastSession: null, windowBounds: null,
});
```

Inject `createId = () => randomUUID()` in `PreferencesStore` and generate ids as `tag-${this.createId()}`. Assign `TAG_COLORS[current.tags.length % TAG_COLORS.length]`. All lifecycle methods load once, validate, write through `save()`, and return the complete normalized preferences. Tests construct the store with a deterministic `createId` sequence so expected ids are stable.

- [ ] **Step 4: Run preference tests and confirm GREEN**

Run: `node --test test/preferences-store.test.js`

Expected: all preference tests pass, including old-config defaults with `tags: []` and `sessionTags: {}`.

- [ ] **Step 5: Commit the preference slice**

```bash
git add src/shared/tag-model.js src/main/preferences-store.js test/preferences-store.test.js
git commit -m "feat(tmux-desk): persist session tags"
```

---

### Task 2: Strict Tag IPC and session lifecycle integration

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/preload.js`
- Test: `test/ipc-validation.test.js`

**Interfaces:**
- Consumes: Task 1 `PreferencesStore` lifecycle methods and `TAG_COLORS`.
- Produces preload APIs: `createTag(name)`, `renameTag({ id, name })`, `deleteTag(id)`, `setSessionTags({ sessionName, tagIds })`.
- Changes duplicate input to `{ source, sourceName, name }` and kill input to `{ target, sessionName }` so preference references can follow tmux lifecycle.

- [ ] **Step 1: Write failing IPC tests**

Add validation cases:

```js
assert.deepEqual(validateTagMutation('rename', { id: 'tag-abc', name: ' DMS ' }), {
  id: 'tag-abc', name: 'DMS',
});
assert.deepEqual(validateSessionTags({ sessionName: 'api', tagIds: ['tag-a', 'tag-a', 'tag-b'] }), {
  sessionName: 'api', tagIds: ['tag-a', 'tag-b'],
});
assert.throws(() => validateTagMutation('create', ''), /Tag 名称/);
assert.throws(() => validateSessionTags({ sessionName: 'api', tagIds: ['bad'] }), /Tag/);
```

Extend the registered-handler test to assert `tags:create`, `tags:rename`, `tags:delete`, and `sessions:set-tags` exist and call the matching store method. Assert duplicate copies source Tag associations and kill removes associations only after tmux succeeds.

- [ ] **Step 2: Run IPC tests and confirm RED**

Run: `node --test test/ipc-validation.test.js`

Expected: FAIL because the new validators, channels and handlers are absent.

- [ ] **Step 3: Implement validators, handlers and preload bridge**

Add channels and exact payload boundaries:

```js
'tags:create', 'tags:rename', 'tags:delete', 'sessions:set-tags'
```

`validateTagMutation(kind, value)` accepts a string name for create, `{ id, name }` for rename, and a Tag id string for delete. `validateSessionTags(value)` accepts one validated session name and at most 100 unique `tag-*` ids.

Duplicate handler flow: validate `source`, `sourceName`, `name`; await `tmuxService.duplicateSession`; await `preferencesStore.copySessionTags(sourceName, created.name)`; return `created`. Kill flow: validate `{ target, sessionName }`; await tmux kill; await `removeSessionTags(sessionName)`; return `true`. Rename calls `renameSessionReferences()`.

- [ ] **Step 4: Run IPC and preference tests and confirm GREEN**

Run: `node --test test/ipc-validation.test.js test/preferences-store.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the IPC slice**

```bash
git add src/main/ipc.js src/preload.js test/ipc-validation.test.js
git commit -m "feat(tmux-desk): expose safe tag operations"
```

---

### Task 3: Pure session selection for compact workspaces

**Files:**
- Modify: `src/shared/session-model.js`
- Test: `test/session-model.test.js`

**Interfaces:**
- Produces: `sessionsForView(sessions, preferences, view)` returning a new activity-sorted unique array.
- `view` is `{ kind: 'all' }`, `{ kind: 'favorites' }`, or `{ kind: 'tag', tagId: 'tag-*' }`.

- [ ] **Step 1: Write failing view-model tests**

```js
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

test('favorites view is activity sorted and all view returns no compact tabs', () => {
  const preferences = { favorites: ['db', 'api'], sessionTags: {} };
  assert.deepEqual(sessionsForView(sessions, preferences, { kind: 'favorites' }).map((item) => item.name), ['api', 'db']);
  assert.deepEqual(sessionsForView(sessions, preferences, { kind: 'all' }), []);
});
```

- [ ] **Step 2: Run model tests and confirm RED**

Run: `node --test test/session-model.test.js`

Expected: FAIL because `sessionsForView` is not exported.

- [ ] **Step 3: Implement the pure selector**

For favorites, build a `Set(preferences.favorites)`; for a Tag, include names whose normalized association array includes `view.tagId`; for all return `[]`. Filter only live `sessions`, dedupe by `session.name`, sort a copy with existing `byRecentActivity`, and export the function.

- [ ] **Step 4: Run model tests and confirm GREEN**

Run: `node --test test/session-model.test.js`

Expected: all model tests pass and the input session array remains unchanged.

- [ ] **Step 5: Commit the model slice**

```bash
git add src/shared/session-model.js test/session-model.test.js
git commit -m "feat(tmux-desk): select sessions for tag workspaces"
```

---

### Task 4: Tag navigation, management and single-row session tabs

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/icons.js`
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: Task 2 preload APIs and Task 3 `sessionsForView()`.
- Produces UI state `view`, rail Tag buttons, Tag editor/settings controls, session Tag checklist, compact session tab row and Tag/favorites empty states.

- [ ] **Step 1: Add the static DOM contract and verify renderer build fails until JS is updated**

Add `id="appShell"`; add `id="tagRail"` and `id="newTagButton"` between favorites and the rail spacer; rename `windowTabs` to `sessionTabs` with `aria-label="会话页签"`. Add:

```html
<div class="modal-backdrop hidden no-drag" id="tagEditorModal">
  <form class="modal compact" id="tagEditorForm">
    <header><div><h2 id="tagEditorTitle">新建 Tag</h2><p>Tag 仅保存在这台 Mac。</p></div><button type="button" class="icon-button modal-close" aria-label="关闭"></button></header>
    <label class="field"><span>名称</span><input id="tagNameInput" maxlength="40" required autocomplete="off"></label>
    <footer><button type="button" class="button modal-cancel">取消</button><button type="submit" class="button primary">保存</button></footer>
  </form>
</div>
<div class="modal-backdrop hidden no-drag" id="sessionTagsModal">
  <form class="modal compact" id="sessionTagsForm">
    <header><div><h2>管理 Tag</h2><p id="sessionTagsMessage"></p></div><button type="button" class="icon-button modal-close" aria-label="关闭"></button></header>
    <div class="tag-check-list" id="sessionTagsList"></div>
    <footer><button type="button" class="button modal-cancel">取消</button><button type="submit" class="button primary">保存</button></footer>
  </form>
</div>
<div class="modal-backdrop hidden no-drag" id="tagDeleteModal">
  <div class="modal compact danger-modal">
    <header><div><h2>删除 Tag？</h2><p id="tagDeleteMessage"></p></div></header>
    <footer><button class="button modal-cancel">取消</button><button class="button danger" id="confirmTagDeleteButton">删除 Tag</button></footer>
  </div>
</div>
```

Add a “Tag” section with `tagSettingsList` and `settingsNewTagButton` inside settings. Use only existing `.modal`, `.field`, `.button`, and `.icon-button` patterns.

Run: `npm run build`

Expected: FAIL or runtime contract mismatch until `app.js` replaces `windowTabs` references and caches the new ids.

- [ ] **Step 2: Implement renderer state and view transitions**

Replace `favoritesOnly` with:

```js
view: { kind: 'all' },
```

Add `currentTag()`, `compactSessions()`, `setView(view)`, and `ensureViewSelection()`. `setView()` toggles `appShell.classList.toggle('compact-view', view.kind !== 'all')`, renders rail/list/tabs/workspace, and retains the current terminal when it belongs to the new view. Otherwise attach the first compact session; empty compact views detach and clear selection.

Render Tag rail buttons in preference order, with CSS custom property `--tag-color`, first grapheme label, full `title`, count, active class, click-to-select, and context menu entries for rename/delete. The rail add button opens the Tag editor.

- [ ] **Step 3: Implement Tag and session-assignment modals**

`openTagEditor(tag = null)` sets mode in `dataset.tagId`; submit calls create or rename then replaces `state.preferences`, rerenders rail/settings, and keeps/updates the selected Tag. Settings rows show color dot, name, rename and delete actions.

`openSessionTagsModal(session)` writes `dataset.sessionName`, renders one checkbox per Tag and prechecks `preferences.sessionTags[session.name]`. Submit sends `{ sessionName, tagIds }`, replaces preferences, rerenders all affected views, and if the current compact view no longer contains the selected session selects the next available session.

Deletion uses the existing compact confirmation-modal pattern with copy “只会删除 Tag 和分类关系，不会关闭 tmux 会话”.

- [ ] **Step 4: Replace tmux window tabs with compact session tabs**

`renderSessionTabs()` clears `sessionTabs`; it stays collapsed in all view and renders `compactSessions()` in favorites/Tag views. Each tab contains attached-state dot and name, exposes `role="tab"`, `aria-selected`, and calls `selectSession(session)`.

Remove window button creation from `renderDetail()` but preserve pane-picker options. Keep `state.detail.windows` so `⌘1…9` continues to call `selectWindow()`.

Update create/duplicate/kill payloads: new session created in Tag view calls `setSessionTags()` with the current Tag and stores its returned preferences; duplicate sends `sourceName`, then reloads preferences so inherited Tags appear; kill sends `{ target, sessionName }`, then reloads preferences so the removed association disappears. Add “管理 Tag…” to session menus and command palette.

- [ ] **Step 5: Add responsive compact-layout styling**

The default grid remains `56px 300px minmax(0,1fr) auto`. In compact view:

```css
.app-shell.compact-view { grid-template-columns: 56px minmax(0, 1fr) auto; }
.app-shell.compact-view .session-sidebar { display: none; }
```

Add a vertically scrollable rail Tag region, color-aware Tag buttons, count badges, settings rows, checklist rows and a single `.session-tabs/.session-tab` row using the current theme variables. Empty `sessionTabs` must have zero height and no border. At the 1050px breakpoint preserve compact columns rather than reintroducing the sidebar.

- [ ] **Step 6: Build and run all unit tests**

Run: `npm run build && npm test`

Expected: renderer bundle builds and every unit test passes.

- [ ] **Step 7: Commit the renderer slice without staging unrelated terminal-view changes**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/icons.js src/renderer/app.js
git commit -m "feat(tmux-desk): add tag workspace navigation"
```

---

### Task 5: Documentation, live verification and packages

**Files:**
- Modify: `README.md`
- Modify: `.Codex/notes/INDEX.md`
- Rename/Modify: `.Codex/notes/features/tmux-desktop-manager__main-bak.md`

**Interfaces:**
- Consumes: complete feature from Tasks 1–4.
- Produces: verified arm64 `.dmg` and `.zip` under `dist/`, plus current onboarding notes.

- [ ] **Step 1: Update user documentation**

Document multi-Tag assignment, Tag/favorites compact workspaces, Tag persistence location, pane-picker behavior after visible tmux window tabs are removed, and the unchanged local-only privacy boundary.

- [ ] **Step 2: Run fresh automated verification**

Run:

```bash
npm test
npm run test:integration
npm run build
```

Expected: all commands exit 0. Integration output must show the isolated `tmux -L tmux-desk-test-*` lifecycle tests passing.

- [ ] **Step 3: Launch and inspect the app manually**

Run `npm start`, create two disposable Tags, assign one live session to both, switch between all/favorites/Tag views, verify sidebar collapse and the one-row session tabs, then rename/delete the disposable Tags. Verify pane picker and terminal input still operate. Do not kill or rename the user’s real tmux sessions.

- [ ] **Step 4: Build the current architecture package**

Run: `./build.sh`

Expected on this Apple Silicon host: exit 0 with `dist/Tmux Desk-0.1.0-arm64.dmg` and `dist/Tmux Desk-0.1.0-arm64-mac.zip` (Electron Builder may name the zip `Tmux Desk-0.1.0-arm64.zip`; accept the actual configured artifact name).

- [ ] **Step 5: Verify package contents and signature**

Run:

```bash
ls -lh dist/*.dmg dist/*.zip
codesign --verify --deep --strict "dist/mac-arm64/Tmux Desk.app"
test -f "dist/mac-arm64/Tmux Desk.app/Contents/Resources/app.asar"
```

Expected: DMG and zip are non-empty, deep ad-hoc signature verification exits 0, and packaged `app.asar` exists.

- [ ] **Step 6: Update the code notebook and final completion audit**

Update the existing Tmux Desk note with Tag data flow, file/symbol pointers, rename/delete gotchas, test evidence, package names and the actual final commit. Add `Tag, 标签, 会话分组, session tabs` to index keywords. Check `git status --short` and distinguish pre-existing unrelated changes from this feature.

- [ ] **Step 7: Commit only feature documentation changes**

```bash
git add README.md
git commit -m "docs(tmux-desk): document session tag workspaces"
```

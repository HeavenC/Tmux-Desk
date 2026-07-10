# Session Tags Mobile Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing multi-Tag session model available and touch-friendly in the new phone/other-device Web client without regressing desktop Tag workspaces or mobile terminal control.

**Architecture:** Reuse the normalized `PreferencesStore` as the single Tag source, inject it into the in-process Web server, and locate the same Electron preferences file for the standalone daemon. Expose only a minimal authenticated mobile preference projection and one validated session-assignment endpoint; use a pure mobile selector around the existing shared session selector so desktop and mobile deduplication semantics stay aligned.

**Tech Stack:** Electron 43, Node.js HTTP + `ws`, CommonJS, native mobile HTML/CSS, xterm.js, esbuild, Node `node:test`, Electron Builder.

## Global Constraints

- One session may belong to multiple Tags but appears at most once in any selected mobile view.
- Preserve the desktop rule that only “全部” shows the middle sidebar and no desktop tmux window tab row returns.
- Mobile Tag mutations may only replace associations for a live non-`_web_*` session; no arbitrary preference patch endpoint.
- Desktop in-process Web service and standalone Web daemon must read the same preferences file.
- Mobile controls use at least 44px touch targets, safe-area insets and dynamic viewport sizing.
- Replace the mobile tmux window chip row with one compact picker; do not remove mobile window switching.
- Follow RED → GREEN for every production behavior change.

---

### Task 1: Shared preference path and serialized mutations

**Files:**
- Modify: `src/main/preferences-store.js`
- Modify: `test/preferences-store.test.js`

**Interfaces:**
- Produces: `defaultPreferencesFilePath({ platform, home, env }) -> string`.
- Changes: all `PreferencesStore` mutations serialize their complete read-modify-write sequence on one instance.

- [ ] **Step 1: Write failing tests** for macOS/Linux/override paths and concurrent associations:

```js
assert.equal(defaultPreferencesFilePath({ platform: 'darwin', home: '/Users/me', env: {} }),
  '/Users/me/Library/Application Support/tmux-desk/preferences.json');
assert.equal(defaultPreferencesFilePath({ platform: 'linux', home: '/home/me', env: {} }),
  '/home/me/.config/tmux-desk/preferences.json');
assert.equal(defaultPreferencesFilePath({ platform: 'darwin', home: '/Users/me', env: {
  TMUX_DESK_PREFERENCES_FILE: '/tmp/shared.json',
} }), '/tmp/shared.json');

await Promise.all([
  store.setSessionTags('api', [first.id]),
  store.setSessionTags('worker', [second.id]),
]);
assert.deepEqual((await store.load()).sessionTags, {
  api: [first.id], worker: [second.id],
});
```
- [ ] **Step 2: Run `node --test test/preferences-store.test.js`** and confirm RED because the path helper is absent and concurrent updates lose one association.
- [ ] **Step 3: Implement `defaultPreferencesFilePath()`** with `TMUX_DESK_PREFERENCES_FILE` precedence and Electron-compatible platform directories:

```js
function defaultPreferencesFilePath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.TMUX_DESK_PREFERENCES_FILE) return path.resolve(env.TMUX_DESK_PREFERENCES_FILE);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'tmux-desk', 'preferences.json');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'tmux-desk', 'preferences.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'tmux-desk', 'preferences.json');
}
```

- [ ] **Step 4: Add an internal queued `update(createPatch)` primitive** so each mutation derives and writes its patch under the same promise queue; keep atomic temporary-file rename semantics:

```js
update(createPatch) {
  const operation = this.writeQueue.then(async () => {
    const current = await this.load();
    const next = normalizePreferences({ ...current, ...await createPatch(current) });
    await this.writeNormalized(next);
    return next;
  });
  this.writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}
```
- [ ] **Step 5: Re-run `node --test test/preferences-store.test.js`** and confirm GREEN.

### Task 2: Authenticated Web Tag projection and assignment API

**Files:**
- Create: `test/web-server.test.js`
- Modify: `src/server/web-server.js`
- Modify: `src/main/web-control.js`
- Modify: `src/main/main.js`

**Interfaces:**
- `startWebServer({ service?, preferencesStore?, port, host, token, log })` accepts test/runtime dependencies.
- `GET /api/sessions` returns `{ ok, sessions, preferences: { tags, favorites, sessionTags } }`.
- `POST /api/session-tags` accepts `{ sessionName, tagIds }`, validates/deduplicates it, requires a live non-Web session, and returns the same public preference projection.

- [ ] **Step 1: Write a failing loopback-server test** using port `0`, a fake tmux service and temporary `PreferencesStore`; the core assertions are:

```js
const handle = await startWebServer({
  port: 0, host: '127.0.0.1', token: 'test-token', service, preferencesStore: store,
});
const list = await fetch(`http://127.0.0.1:${handle.port}/api/sessions?token=test-token`).then((r) => r.json());
assert.deepEqual(list.sessions.map((session) => session.name), ['api', 'worker']);
assert.deepEqual(list.preferences.tags, preferences.tags);

const saved = await fetch(`http://127.0.0.1:${handle.port}/api/session-tags?token=test-token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionName: 'api', tagIds: [first.id, first.id, second.id] }),
}).then((r) => r.json());
assert.deepEqual(saved.preferences.sessionTags.api, [first.id, second.id]);
```
- [ ] **Step 2: Run `node --test test/web-server.test.js`** and confirm RED because dependency injection, the preference projection and assignment route are absent.
- [ ] **Step 3: Inject the tmux service and preference store**, construct defaults only for standalone mode, and report the actual ephemeral port:

```js
function startWebServer({ service = new TmuxService(), preferencesStore = new PreferencesStore({
  filePath: defaultPreferencesFilePath(),
}), port = DEFAULT_PORT, host = '0.0.0.0', token, log = () => {} } = {}) { /* ... */ }

const address = server.address();
resolve({ port: typeof address === 'object' ? address.port : port, host, token, close });
```

- [ ] **Step 4: Implement the two API contracts** with existing `validateSessionTags()` and a live-session name check before `setSessionTags()`:

```js
if (req.method === 'POST' && url.pathname === '/api/session-tags') {
  const input = validateSessionTags(await readJsonBody(req));
  const sessions = await listPublicSessions();
  if (!sessions.some((session) => session.name === input.sessionName)) return sendError(res, 404, '会话不存在');
  return sendJson(res, 200, { ok: true, preferences: publicPreferences(
    await preferencesStore.setSessionTags(input.sessionName, input.tagIds),
  ) });
}
```
- [ ] **Step 5: Pass the desktop `preferencesStore` through `createWebControl({ preferencesStore })`** so desktop IPC and phone requests share one serialized store instance.
- [ ] **Step 6: Re-run `node --test test/web-server.test.js test/preferences-store.test.js test/ipc-validation.test.js`** and confirm GREEN.

### Task 3: Pure mobile workspace selector

**Files:**
- Create: `src/webapp/mobile-session-model.js`
- Create: `test/webapp-mobile.test.js`

**Interfaces:**
- Produces: `mobileSessionsForView(sessions, preferences, view)` and `liveCountForView(...)`.
- Consumes: shared `sessionsForView()` for favorites and Tag semantics.

- [ ] **Step 1: Write failing model tests** proving all/favorites/Tag sorting, one-per-name deduplication, multi-Tag crossover and malformed payload tolerance:

```js
assert.deepEqual(mobileSessionsForView([api, newerApi, worker], preferences, { kind: 'all' })
  .map((session) => session.name), ['api', 'worker']);
assert.deepEqual(mobileSessionsForView([api, worker], preferences, { kind: 'tag', tagId: 'tag-a' })
  .map((session) => session.name), ['worker', 'api']);
assert.equal(liveCountForView([api, api], preferences, { kind: 'tag', tagId: 'tag-a' }), 1);
```
- [ ] **Step 2: Run `node --test test/webapp-mobile.test.js`** and confirm RED because the module does not exist.
- [ ] **Step 3: Implement the pure selector**; “全部” deduplicates and sorts live sessions, while favorites/Tag delegate to the existing selector:

```js
function mobileSessionsForView(sessions, preferences, view) {
  if (view?.kind !== 'all') return sessionsForView(sessions, preferences, view);
  const seen = new Set();
  return [...(Array.isArray(sessions) ? sessions : [])]
    .filter((session) => session && typeof session.name === 'string' && !seen.has(session.name) && seen.add(session.name))
    .sort(byRecentActivity);
}
```
- [ ] **Step 4: Re-run `node --test test/webapp-mobile.test.js`** and confirm GREEN.

### Task 4: Touch-first mobile Tag UI and single window picker

**Files:**
- Modify: `src/webapp/index.html`
- Modify: `src/webapp/styles.css`
- Modify: `src/webapp/app.js`
- Modify: `test/webapp-mobile.test.js`

**Interfaces:**
- Adds DOM ids `workspace-filters`, `session-tags-modal`, `session-tags-form`, `session-tags-list`, `window-picker`.
- Mobile state gains `sessions`, `preferences`, and `listView = { kind: 'all' }`.

- [ ] **Step 1: Extend the contract test first** to require workspace filters, Tag assignment sheet, 44px controls, dynamic viewport support and `window-picker`, and to reject `window-chips` / `window-chip`:

```js
for (const id of ['workspace-filters', 'session-tags-modal', 'session-tags-form', 'session-tags-list', 'window-picker']) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
}
assert.doesNotMatch(html + css + app, /window-chips|window-chip|renderWindowChips/);
assert.match(css, /height:\s*100dvh/);
assert.match(css, /min-height:\s*44px/);
assert.match(app, /window\.visualViewport/);
```
- [ ] **Step 2: Run `node --test test/webapp-mobile.test.js`** and confirm RED against the old page.
- [ ] **Step 3: Render filter buttons and Tag-decorated cards** from the server projection; keep the last successful list on refresh failure and reset a deleted selected Tag to all. Filter buttons use `data-view-kind` / `data-tag-id`, `aria-pressed`, a colored dot and `liveCountForView()`.
- [ ] **Step 4: Implement the Tag assignment sheet** with checkbox preservation on failure and a JSON `POST /api/session-tags`; stop its button events from opening the terminal:

```js
const body = await fetchJson(apiUrl('/api/session-tags'), {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionName, tagIds: checkedTagIds }),
});
state.preferences = body.preferences;
```

- [ ] **Step 5: Replace window chips with a single `<select id="window-picker">`** wired to the existing select-window API; options use tmux numeric `index` values and the `change` handler calls `selectWindow(Number(event.target.value))` before restoring terminal focus.
- [ ] **Step 6: Apply mobile viewport and accessibility CSS/JS** using `100dvh`, safe areas, initial `visualViewport` sync, internal sheet scrolling and 44px targets.
- [ ] **Step 7: Run `node --test test/webapp-mobile.test.js test/web-server.test.js` and `npm run build:webapp`** and confirm GREEN.

### Task 5: Documentation, version and completion verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.Codex/notes/INDEX.md`
- Modify/Rename: `.Codex/notes/features/tmux-desktop-manager__main-bak.md`

- [ ] **Step 1: Document mobile Tag filtering/assignment, the window picker, shared preference path and token/Tailscale boundary** in `README.md` under “手机 / Web 版（远程访问）”.
- [ ] **Step 2: Bump the combined desktop + external-device release to `0.3.0`** using `npm version 0.3.0 --no-git-tag-version` so both package manifests stay aligned.
- [ ] **Step 3: Run full verification:** `npm test`, `npm run test:integration`, `npm run build`, `git diff --check`, and a requirement-by-requirement static audit.
- [ ] **Step 4: Launch the loopback Web UI** with an isolated tmux socket/preferences file and verify a 375px phone-width layout plus Tag/filter/terminal controls; separately launch Electron and verify desktop Tag compact/all transitions.
- [ ] **Step 5: Build and verify packages:** `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac`, `hdiutil verify`, `unzip -t`, `codesign --verify --deep --strict`, `lipo -info`, `plutil`, ASAR marker checks and `shasum -a 256`.
- [ ] **Step 6: Update the code notebook with the new Web boundary, mobile flow, default path and concurrency gotchas.**
- [ ] **Step 7: Commit the verified implementation and artifacts metadata without installing or overwriting `/Applications/Tmux Desk.app`.**

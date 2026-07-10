# Tmux Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished, pure-local macOS Electron application for managing and attaching to existing tmux sessions from a Codex-style workspace.

**Architecture:** Electron's main process owns all tmux, filesystem, and PTY access behind a narrow preload API. A vanilla JavaScript renderer bundled with esbuild uses xterm.js for terminal rendering and CSS-variable themes for the Codex-style shell.

**Tech Stack:** Electron 43, electron-builder 26, Node.js 22, node-pty 1.1, @xterm/xterm 6, @xterm/addon-fit 0.11, esbuild 0.28, Node built-in test runner.

## Global Constraints

- macOS only for version 1; build arm64 by default and retain x64/universal scripts.
- All tmux interaction and preferences stay on the local Mac; no login, network, analytics, sync, or plugins.
- Light theme is the first-run default; dark and system themes are available.
- Renderer uses `contextIsolation: true`, `nodeIntegration: false`, and sandboxing.
- Control operations use `execFile` argument arrays; renderer never receives generic shell execution.
- Work stays under `/Users/liwei/Documents/tools/terminal-cli` because the parent repository has unrelated dirty changes.

---

### Task 1: Project scaffold and tmux control service

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `scripts/build-renderer.js`
- Create: `src/main/tmux-service.js`
- Test: `test/tmux-service.test.js`

**Interfaces:**
- Produces: `TmuxService({ tmuxPath, execFileImpl, socketName })`.
- Produces: `resolveTmuxPath()`, `getStatus()`, `listSessions()`, `getSessionDetail(target)`, `createSession(input)`, `renameSession(target, name)`, `killSession(target)`, `selectWindow(target)`, and `selectPane(target)`.
- Session result: `{ id, name, attached, windows, activity, path, paneCount, activeCommand }`.

- [ ] **Step 1: Write parser and argument-construction tests**

```js
test('listSessions parses unicode session names without invoking a shell', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: '$3\t☸️ k8s-uat\t1\t2\t100\t/Users/liwei/work\n', stderr: '' };
    },
  });
  assert.deepEqual(await service.listSessions(), [{
    id: '$3', name: '☸️ k8s-uat', attached: true, windows: 2,
    activity: 100, path: '/Users/liwei/work', paneCount: 0, activeCommand: '',
  }]);
  assert.equal(calls[0].file, '/opt/homebrew/bin/tmux');
  assert.equal(calls[0].args.includes('-F'), true);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/tmux-service.test.js`
Expected: FAIL because `src/main/tmux-service.js` does not exist.

- [ ] **Step 3: Implement the minimal tmux service**

Implement exact binary candidate order, tab-delimited parser helpers, `execFile` promisification, no-server error normalization, name/path validation, and command argument arrays. `socketName` prepends `-L <name>` before every tmux subcommand so integration tests can use an isolated server.

- [ ] **Step 4: Run the unit test and verify GREEN**

Run: `node --test test/tmux-service.test.js`
Expected: all tmux service unit tests pass.

- [ ] **Step 5: Add package scripts and renderer build entry**

`package.json` must expose `start`, `build`, `build:renderer`, `test`, `test:integration`, `package:mac`, `package:mac:x64`, and `package:mac:universal`; electron-builder files include only `src`, `renderer-dist`, `package.json`, and required production modules, with node-pty unpacked from ASAR.

### Task 2: Local preferences and pure renderer state

**Files:**
- Create: `src/main/preferences-store.js`
- Create: `src/shared/session-model.js`
- Create: `src/renderer/theme.js`
- Test: `test/preferences-store.test.js`
- Test: `test/session-model.test.js`
- Test: `test/theme.test.js`

**Interfaces:**
- Produces: `PreferencesStore({ filePath, fsImpl })` with `load()`, `save(patch)`, `toggleFavorite(name)`, and `renameFavorite(oldName, newName)`.
- Produces: `filterAndGroupSessions(sessions, favorites, query, favoritesOnly)`.
- Produces: `resolveTheme(theme, systemDark)` and `applyTheme(documentElement, resolvedTheme)`.

- [ ] **Step 1: Write failing tests for defaults, corrupted JSON, atomic save, grouping, filtering, and theme resolution**

```js
test('first run defaults to light theme', async () => {
  const store = new PreferencesStore({ filePath: join(tempDir, 'preferences.json') });
  assert.equal((await store.load()).theme, 'light');
});

test('favorites are grouped before other sessions', () => {
  const result = filterAndGroupSessions([{ name: 'api' }, { name: 'db' }], ['db'], '', false);
  assert.deepEqual(result.favorites.map((item) => item.name), ['db']);
  assert.deepEqual(result.sessions.map((item) => item.name), ['api']);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/preferences-store.test.js test/session-model.test.js test/theme.test.js`
Expected: FAIL because the three modules do not exist.

- [ ] **Step 3: Implement defaults, normalized persistence, pure grouping, and theme helpers**

Use `{ theme: 'light', favorites: [], lastSession: null, windowBounds: null }` as defaults. Save to `<file>.tmp`, then rename. Treat malformed JSON and invalid fields as defaults without throwing.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/preferences-store.test.js test/session-model.test.js test/theme.test.js`
Expected: all preference/state tests pass.

### Task 3: PTY lifecycle manager

**Files:**
- Create: `src/main/terminal-manager.js`
- Test: `test/terminal-manager.test.js`

**Interfaces:**
- Consumes: resolved tmux path from `TmuxService`.
- Produces: `TerminalManager({ ptyModule, sendEvent, tmuxPath, socketName })`.
- Produces: `attach({ sessionId, cols, rows }) -> { terminalId }`, `write({ terminalId, data })`, `resize({ terminalId, cols, rows })`, and `dispose()`.

- [ ] **Step 1: Write failing PTY lifecycle tests**

```js
test('attaching a new session disposes only the previous attach client', () => {
  const first = createFakePty();
  const second = createFakePty();
  const manager = new TerminalManager({ ptyModule: spawnSequence(first, second), sendEvent() {} });
  manager.attach({ sessionId: '$1', cols: 100, rows: 30 });
  manager.attach({ sessionId: '$2', cols: 100, rows: 30 });
  assert.equal(first.killed, true);
  assert.equal(second.killed, false);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/terminal-manager.test.js`
Expected: FAIL because `TerminalManager` is missing.

- [ ] **Step 3: Implement a single-active-PTY manager**

Spawn `tmux [optional -L socket] attach-session -t <sessionId>` with `TERM=xterm-256color` and `COLORTERM=truecolor`; generate monotonically increasing terminal ids; ignore stale write/resize calls; emit `terminal:data` and `terminal:exit` events tagged with id; kill only the attach client during switching or disposal.

- [ ] **Step 4: Run test and verify GREEN**

Run: `node --test test/terminal-manager.test.js`
Expected: all PTY lifecycle tests pass.

### Task 4: Secure Electron main process and preload API

**Files:**
- Create: `src/main/ipc.js`
- Create: `src/main/main.js`
- Create: `src/preload.js`
- Test: `test/ipc-validation.test.js`

**Interfaces:**
- Consumes: `TmuxService`, `TerminalManager`, and `PreferencesStore`.
- Produces renderer API methods for status, session CRUD, window/pane selection, preferences, attach/write/resize/detach, and event subscriptions.

- [ ] **Step 1: Write failing validation tests**

```js
test('rejects malformed tmux targets before reaching the service', () => {
  assert.throws(() => validateTarget('api; rm -rf ~'), /目标无效/);
  assert.equal(validateTarget('$12'), '$12');
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/ipc-validation.test.js`
Expected: FAIL because validators do not exist.

- [ ] **Step 3: Implement validation, IPC registration, preload, and window lifecycle**

The BrowserWindow is `1280x820`, minimum `960x620`, `titleBarStyle: 'hiddenInset'`, light background, context isolation, sandbox, and no Node integration. Restore validated saved bounds. Build a local-only CSP and persist bounds on close.

- [ ] **Step 4: Run test and verify GREEN**

Run: `node --test test/ipc-validation.test.js`
Expected: validation tests pass.

### Task 5: Codex-style renderer and terminal experience

**Files:**
- Create: `src/renderer/index.html`
- Create: `src/renderer/styles.css`
- Create: `src/renderer/icons.js`
- Create: `src/renderer/terminal-view.js`
- Create: `src/renderer/command-palette.js`
- Create: `src/renderer/app.js`
- Test: `test/command-palette.test.js`

**Interfaces:**
- Consumes: `window.tmuxDesk` preload API.
- Produces: light-first app shell, session list, window tabs, pane selector, xterm terminal, dialogs, toasts, command palette, and keyboard shortcuts.

- [ ] **Step 1: Write failing command search tests**

```js
test('command search matches title and shortcut labels', () => {
  const commands = [{ id: 'new', title: '新建会话', shortcut: '⌘N' }];
  assert.deepEqual(searchCommands(commands, 'cmd n').map((item) => item.id), ['new']);
  assert.deepEqual(searchCommands(commands, '新建').map((item) => item.id), ['new']);
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test test/command-palette.test.js`
Expected: FAIL because the command palette module does not exist.

- [ ] **Step 3: Implement the renderer in focused modules**

Use CSS variables for light/dark palettes, no remote fonts or assets, semantic buttons, visible focus rings, reduced-motion support, responsive sidebar collapse below 1050 px, and inline SVG icons. Session selection attaches xterm; FitAddon resize uses `ResizeObserver`; app polling pauses on `visibilitychange`.

- [ ] **Step 4: Build renderer and run all unit tests**

Run: `npm run build:renderer && npm test`
Expected: esbuild exits 0 and every unit test passes.

### Task 6: Isolated tmux integration, desktop QA, and packaging

**Files:**
- Create: `test/tmux-integration.test.js`
- Create: `README.md`
- Create: `build/icon.svg`
- Create: `.Codex/notes/INDEX.md`
- Create: `.Codex/notes/features/tmux-desktop-manager__main-bak.md`

**Interfaces:**
- Consumes all production modules.
- Produces a runnable macOS app and arm64 DMG/zip in `dist/`.

- [ ] **Step 1: Write isolated real-tmux integration test**

Use a unique socket name `tmux-desk-test-<pid>`, create `alpha`, add a window and pane, assert service metadata, rename to `beta`, then kill the test server in `after()` regardless of result.

- [ ] **Step 2: Run integration test and verify it passes**

Run: `npm run test:integration`
Expected: PASS without changing the output of `tmux list-sessions` on the default user socket.

- [ ] **Step 3: Launch and visually inspect the real Electron app**

Run: `npm start`
Expected: app opens in light theme, lists current sessions, can attach to the isolated manual QA session, accepts keyboard input, resizes, switches windows, opens command palette, toggles theme, and closes without killing the tmux session.

- [ ] **Step 4: Build production artifacts**

Run: `npm run build && CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac`
Expected: renderer build succeeds and electron-builder creates an arm64 `.app`, `.dmg`, and `.zip` under `dist/`.

- [ ] **Step 5: Run final verification**

Run: `npm test && npm run test:integration && npm run build`
Expected: every command exits 0 with no test failures.

- [ ] **Step 6: Document use and durable project knowledge**

README must cover prerequisites (`brew install tmux`), install/run/build commands, shortcuts, local-only privacy, preference path, troubleshooting, and App Store sandbox caveat. Notebook notes must point to real entry files and record the single-active-PTY and isolated-socket test invariants.

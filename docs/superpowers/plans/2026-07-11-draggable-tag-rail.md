# Draggable Tag Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent desktop drag handle for the expanded Tag rail, with a 180–420px range and double-click reset, and smoothly animate clicked Tags into recent-use order while keeping collapsed and mobile layouts unchanged.

**Architecture:** Store an optional `tagRailWidth` beside `tagRailExpanded`, validate it through the existing IPC/store layers, and project it into the existing `--activity-rail-expanded-width` CSS variable. Add a dedicated grid-track resizer between the activity rail and subsequent content; mousemove updates only CSS, while mouseup persists once.

**Tech Stack:** Electron renderer (CommonJS), HTML/CSS Grid, Node.js `node:test`, existing JSON preferences/IPC, esbuild, electron-builder.

## Global Constraints

- Expanded default width is 240px, with the existing 220px default at `max-width: 1050px`.
- Custom width is clamped to 180–420px and shared by all desktop views.
- Collapsed rail remains fixed-width and has no active Tag resizer.
- Double-click clears the custom width instead of persisting a default number.
- Mobile Web source and touch layout must not gain a resizer or horizontal overflow.
- Recent-use animation runs only for user-clicked Tag reorders, lasts 180ms, and respects `prefers-reduced-motion`.
- Application version becomes 0.3.2.
- Preserve all unrelated user changes in the main working tree.

---

### Task 1: Persist and validate the custom Tag rail width

**Files:**
- Modify: `test/preferences-store.test.js`
- Modify: `test/ipc-validation.test.js`
- Modify: `src/main/preferences-store.js`
- Modify: `src/main/ipc.js`

**Interfaces:**
- Consumes: existing `PreferencesStore.save(patch)` and `validatePreferencesPatch(value)`.
- Produces: normalized preference `tagRailWidth: number | null` and accepted renderer patch `{ tagRailWidth }`.

- [ ] **Step 1: Write failing preference tests**

Add `tagRailWidth: null` to exact default expectations and add a test that saves `239.6`, `80`, `900`, and `null`, expecting `240`, `180`, `420`, and `null` respectively.

- [ ] **Step 2: Write failing IPC tests**

Assert that `{ tagRailWidth: 260 }` and `{ tagRailWidth: null }` pass; strings, values below 100, and values above 1000 throw `Tag 栏宽度无效`.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
node --test test/preferences-store.test.js test/ipc-validation.test.js
```

Expected: failures because `tagRailWidth` is absent or rejected.

- [ ] **Step 4: Implement store normalization**

Add:

```js
const TAG_RAIL_WIDTH_RANGE = Object.freeze({ min: 180, max: 420 });

function normalizeTagRailWidth(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(TAG_RAIL_WIDTH_RANGE.max, Math.max(TAG_RAIL_WIDTH_RANGE.min, value)));
}
```

Include `tagRailWidth: null` in `DEFAULT_PREFERENCES` and `tagRailWidth: normalizeTagRailWidth(value.tagRailWidth)` in `normalizePreferences()`.

- [ ] **Step 5: Implement IPC validation**

Allow `tagRailWidth` in `validatePreferencesPatch()`. Accept `null`; otherwise require a finite number between 100 and 1000, round it, and emit `Tag 栏宽度无效` on invalid input.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/preferences-store.test.js test/ipc-validation.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/main/preferences-store.js src/main/ipc.js test/preferences-store.test.js test/ipc-validation.test.js
git commit -m "feat(tmux-desk): persist tag rail width"
```

---

### Task 2: Add the desktop Tag rail resizer

**Files:**
- Modify: `test/tag-ui-contract.test.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: `preferences.tagRailWidth`, `api.savePreferences()`, existing `tagRailExpanded` state, and `--activity-rail-expanded-width`.
- Produces: `#tagRailResizer`, `clampTagRailWidth(value)`, `applyTagRailWidth()`, and `bindTagRailResizer()`.

- [ ] **Step 1: Write failing renderer contract tests**

Require `#tagRailResizer`, `--tag-rail-resizer-width`, the six-track normal grid and four-track compact grid, expanded-only resizer display, body drag state, `tagRailWidth`, clamp constants 180/420, `bindTagRailResizer()`, one `savePreferences({ tagRailWidth: width })` on mouseup, and `savePreferences({ tagRailWidth: null })` on double-click. Also require a `tagRailPositions()` map, Web Animations API usage with `duration: 180`, and a `prefers-reduced-motion` guard. Continue rejecting direct `style.gridTemplateColumns` writes.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
node --test test/tag-ui-contract.test.js
```

Expected: failures for missing element, CSS tracks, and controller functions.

- [ ] **Step 3: Add the HTML grid item**

Insert immediately after `.activity-rail`:

```html
<div class="tag-rail-resizer no-drag" id="tagRailResizer" aria-hidden="true"></div>
```

Add `tagRailResizer` to `cacheElements()`.

- [ ] **Step 4: Implement CSS layout and interaction states**

Use:

```css
--tag-rail-resizer-width: 0px;
grid-template-columns: var(--activity-rail-width) var(--tag-rail-resizer-width) var(--session-sidebar-width) 0 minmax(0, 1fr) auto;
.app-shell.tag-rail-expanded { --tag-rail-resizer-width: 5px; }
.app-shell.compact-view { grid-template-columns: var(--activity-rail-width) var(--tag-rail-resizer-width) minmax(0, 1fr) auto; }
```

Style `.tag-rail-resizer` like the existing sidebar resizer, but hide pointer interaction when the rail is collapsed. Add `body.tag-rail-resizing` cursor and selection rules.

- [ ] **Step 5: Implement renderer width application and drag binding**

Add 180/420 clamp constants. `applyTagRailWidth()` sets or removes only `--activity-rail-expanded-width`. `bindTagRailResizer()` ignores non-left clicks or collapsed state, tracks `.activity-rail` width, updates the CSS variable during mousemove, saves once on mouseup, restores persisted state on failure, and clears the value on double-click. Call `bindTagRailResizer()` with the existing resizer binding and `applyTagRailWidth()` during initialization.

Add `tagRailPositions()` to map mounted `data-tag-id` buttons to their top positions. Let `renderTagRail(previousPositions)` animate only ids whose top changed, using:

```js
button.animate(
  [{ transform: `translateY(${previousTop - nextTop}px)` }, { transform: 'translateY(0)' }],
  { duration: 180, easing: 'cubic-bezier(.2, .8, .2, 1)' },
);
```

Skip when `prefers-reduced-motion: reduce` matches or `button.animate` is unavailable. In `activateTag()`, capture positions immediately before the optimistic reorder and pass them only to that render call; touch success/error calibration renders remain static.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
node --test test/tag-ui-contract.test.js
npm test
npm run test:integration
npm run build
git diff --check
```

Expected: all tests and builds pass; Web source remains unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/index.html src/renderer/styles.css src/renderer/app.js test/tag-ui-contract.test.js
git commit -m "feat(tmux-desk): resize expanded tag rail"
```

---

### Task 3: Release, review, merge, and deploy 0.3.2

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `.Codex/notes/features/tmux-desktop-manager__main.md` (local notebook, not committed)

**Interfaces:**
- Consumes: completed resizer implementation and existing `scripts/deploy.sh --force`.
- Produces: main branch at version 0.3.2 and a verified `/Applications/Tmux Desk.app` deployment.

- [ ] **Step 1: Add release metadata**

Run `npm version 0.3.2 --no-git-tag-version`, update README behavior/version notes, and ensure lockfile root version matches.

- [ ] **Step 2: Run final branch verification**

Run:

```bash
npm test
npm run test:integration
npm run build
bash -n scripts/deploy.sh
git diff --check
```

Expected: all automated checks pass and the worktree is clean after committing generated tracked artifacts.

- [ ] **Step 3: Commit release metadata**

```bash
git add package.json package-lock.json README.md webapp-dist
git commit -m "chore(tmux-desk): release 0.3.2"
```

- [ ] **Step 4: Request final code review**

Review `main..HEAD` for Critical/Important issues, focusing on grid-track correctness, preference races, responsive behavior, and preservation of mobile/Web code. Fix any validated blockers and re-run verification.

- [ ] **Step 5: Preserve user working-tree changes and merge**

Temporarily stash only the unrelated dirty main files, fast-forward merge the feature branch, reapply the stash, and verify the user files still contain the same patch.

- [ ] **Step 6: Verify and deploy from main**

Run the full tests/build again from main, then:

```bash
./scripts/deploy.sh --force
```

Filter token-bearing output. Verify deep code signature, running app process, authenticated localhost mobile API, ASAR version 0.3.2, bundled dependency presence, and source/build hashes against main.

- [ ] **Step 7: Update the code notebook and clean the owned worktree**

Record `tagRailWidth`, the dedicated grid resizer, 0.3.2 behavior, tests, deployment details, and final verified commit. Remove the merged `.worktrees/draggable-tag-rail` worktree and delete its branch only after merge/deploy succeeds.

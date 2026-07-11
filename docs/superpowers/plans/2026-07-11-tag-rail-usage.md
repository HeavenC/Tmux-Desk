# Tag Rail Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面 Tag 列铺满可用高度、按最近使用顺序排列，并可持久化展开显示完整 Tag 名称。

**Architecture:** 复用 `preferences.tags` 的数组顺序表示最近使用顺序，通过受限 `tags:touch` IPC 原子地移动 Tag；新增 `tagRailExpanded` 桌面偏好。renderer 只切换 app-shell class 和渲染两套可访问文本，网格宽度与紧凑/响应式兼容全部由 CSS 变量控制。

**Tech Stack:** Electron、CommonJS、原生 DOM/CSS、Node.js `node:test`、electron-builder。

## Global Constraints

- 一个会话仍可关联多个 Tag，同一 Tag 内会话不重复。
- 只有“全部”显示中间会话栏，收藏/Tag 继续使用单层会话页签。
- 新建 Tag 与最近点击使用的 Tag 排在首位，顺序跨重启保持。
- 展开态显示完整 Tag 名称；手机 Web 保持现有触控布局。
- 设置弹窗不得超过视口，Tag 列表增多时中央内容滚动，头部和完成按钮保持可见。
- 不安装或覆盖 `/Applications`；产物保持 arm64、ad-hoc 签名、未公证。

---

### Task 1: 持久化最近使用顺序和展开偏好

**Files:**
- Modify: `test/preferences-store.test.js`
- Modify: `test/ipc-validation.test.js`
- Modify: `src/main/preferences-store.js`
- Modify: `src/main/ipc.js`
- Modify: `src/preload.js`

**Interfaces:**
- Produces: `PreferencesStore.touchTag(id): Promise<Preferences>`。
- Produces: IPC `tags:touch`，preload `touchTag(id)`。
- Produces: `preferences.tagRailExpanded: boolean`，默认 `false`。

- [ ] **Step 1: 写偏好层失败测试**

在 `test/preferences-store.test.js` 断言新建 Tag 前插、touch 移到首位、重复 touch 幂等、未知 id 抛出，并在默认与损坏配置断言中加入 `tagRailExpanded: false`：

```js
test('new and recently used tags move to the front', async () => {
  const ids = ['one', 'two', 'three'];
  await withStore(async (store) => {
    await store.createTag('DMS');
    await store.createTag('K8S');
    let preferences = await store.createTag('PROD');
    assert.deepEqual(preferences.tags.map((tag) => tag.name), ['PROD', 'K8S', 'DMS']);
    preferences = await store.touchTag('tag-one');
    assert.deepEqual(preferences.tags.map((tag) => tag.name), ['DMS', 'PROD', 'K8S']);
    assert.deepEqual((await store.touchTag('tag-one')).tags, preferences.tags);
    await assert.rejects(() => store.touchTag('tag-missing'), /Tag 不存在/);
  }, { createId: () => ids.shift() });
});
```

- [ ] **Step 2: 运行偏好测试确认 RED**

Run: `node --test test/preferences-store.test.js`

Expected: FAIL，原因是新 Tag 仍追加且 `touchTag` 不存在。

- [ ] **Step 3: 最小实现偏好行为**

在默认值与 normalization 中加入布尔值，在 store 中前插与移动：

```js
tagRailExpanded: false,

tagRailExpanded: typeof value.tagRailExpanded === 'boolean'
  ? value.tagRailExpanded
  : DEFAULT_PREFERENCES.tagRailExpanded,

const tag = { id, name, color: TAG_COLORS[current.tags.length % TAG_COLORS.length] };
return { tags: [tag, ...current.tags] };

async touchTag(id) {
  const tagId = normalizeTagId(id);
  return this.update((current) => {
    const tag = current.tags.find((item) => item.id === tagId);
    if (!tag) throw new Error('Tag 不存在');
    if (current.tags[0]?.id === tagId) return {};
    return { tags: [tag, ...current.tags.filter((item) => item.id !== tagId)] };
  });
}
```

- [ ] **Step 4: 写 IPC/preload 失败测试**

扩展 `test/ipc-validation.test.js`：

```js
assert.deepEqual(
  validatePreferencesPatch({ tagRailExpanded: true }),
  { tagRailExpanded: true },
);
assert.throws(() => validatePreferencesPatch({ tagRailExpanded: 'yes' }), /Tag 栏展开状态/);
assert.equal(typeof exposed.touchTag, 'function');
```

注册处理器测试的 fake store 增加 `touchTag`，并断言 `handlers.get('tags:touch')(null, 'tag-one')` 调用它。

- [ ] **Step 5: 运行 IPC 测试确认 RED**

Run: `node --test test/ipc-validation.test.js`

Expected: FAIL，原因是白名单、处理器和 preload 方法尚不存在。

- [ ] **Step 6: 实现受限 IPC 与 preload**

`validatePreferencesPatch()` 允许并验证 `tagRailExpanded`；IPC handler 增加：

```js
'tags:touch': (_event, id) => preferencesStore.touchTag(validateTagMutation('delete', id)),
```

preload 增加：

```js
touchTag: (id) => ipcRenderer.invoke('tags:touch', id),
```

- [ ] **Step 7: 运行 Task 1 测试并提交**

Run: `node --test test/preferences-store.test.js test/ipc-validation.test.js`

Expected: PASS。

Commit:

```bash
git add test/preferences-store.test.js test/ipc-validation.test.js src/main/preferences-store.js src/main/ipc.js src/preload.js
git commit -m "feat(tmux-desk): persist recent tag order"
```

---

### Task 2: 铺满 Tag 区并增加展开 toggle

**Files:**
- Modify: `test/tag-ui-contract.test.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/app.js`

**Interfaces:**
- Consumes: `api.touchTag(id)` 与 `preferences.tagRailExpanded`。
- Produces: DOM `#tagRailToggleButton`。
- Produces: DOM `#settingsScroll`。
- Produces: class `.tag-rail-expanded` 和完整名称节点 `.tag-name`。

- [ ] **Step 1: 写 renderer 结构失败测试**

在 `test/tag-ui-contract.test.js` 增加断言：

```js
assert.match(html, /id=["']tagRailToggleButton["']/);
assert.match(css, /--activity-rail-width:\s*62px/);
assert.match(css, /\.app-shell\.tag-rail-expanded/);
assert.match(css, /\.tag-name\s*\{/);
assert.doesNotMatch(css, /\.rail-spacer\s*\{[^}]*flex:\s*1/s);
assert.match(app, /api\.touchTag\(/);
assert.match(app, /tagRailExpanded/);
assert.match(html, /id=["']settingsScroll["']/);
assert.match(css, /\.settings-modal\s*\{[^}]*max-height:/s);
assert.match(css, /\.settings-scroll\s*\{[^}]*overflow-y:\s*auto/s);
```

- [ ] **Step 2: 运行 renderer 测试确认 RED**

Run: `node --test test/tag-ui-contract.test.js`

Expected: FAIL，原因是 toggle、展开 class、文本节点和 touch 尚未实现。

- [ ] **Step 3: 添加可访问 toggle 和名称节点**

在 activity rail 底部工具区之前加入：

```html
<button class="rail-button rail-toggle no-drag" id="tagRailToggleButton"
  aria-label="展开 Tag 栏" aria-expanded="false" title="展开 Tag 栏"></button>
```

`cacheElements()` 和 `installIcons()` 纳入该按钮。`renderTagRail()` 为每个按钮同时创建 `.tag-initial`、`.tag-name`、`.tag-count`；折叠/展开显示由 CSS 控制，不在 DOM 中复制按钮。

- [ ] **Step 4: 改造 CSS 网格和纵向空间**

使用变量：

```css
.app-shell {
  --activity-rail-width: 62px;
  --activity-rail-expanded-width: 240px;
  grid-template-columns: var(--activity-rail-width) var(--session-sidebar-width) 0 minmax(0, 1fr) auto;
}
.app-shell.tag-rail-expanded { --activity-rail-width: var(--activity-rail-expanded-width); }
.app-shell.compact-view { grid-template-columns: var(--activity-rail-width) minmax(0, 1fr) auto; }
.rail-spacer { flex: none; }
.tag-name { display: none; overflow-wrap: anywhere; }
.tag-rail-expanded .tag-name { display: block; }
```

展开态把 rail/button 改为横向、Tag 名称允许换行且不省略；计数改为普通右侧文本。1050px media query 只覆盖折叠宽度，不重写展开宽度和完整网格。

- [ ] **Step 5: 实现 toggle 与最近使用即时反馈**

增加：

```js
function applyTagRailExpanded() {
  const expanded = state.preferences.tagRailExpanded === true;
  refs.appShell.classList.toggle('tag-rail-expanded', expanded);
  refs.tagRailToggleButton.setAttribute('aria-expanded', String(expanded));
  refs.tagRailToggleButton.setAttribute('aria-label', expanded ? '收起 Tag 栏' : '展开 Tag 栏');
  refs.tagRailToggleButton.title = expanded ? '收起 Tag 栏' : '展开 Tag 栏';
}
```

toggle 点击时先更新 UI，再 `savePreferences({ tagRailExpanded })`。Tag 点击时把目标本地移到首位、重绘并调用 `api.touchTag(tag.id)`，成功后用返回偏好校准并进入 Tag；失败则重新读取偏好并 toast。

设置弹窗把三个 section 包进 `#settingsScroll.settings-scroll`。`.settings-modal` 使用纵向 flex、`max-height: min(760px, calc(100vh - 56px))` 和 `overflow: hidden`；`.settings-scroll` 使用 `min-height: 0; overflow-y: auto; overscroll-behavior: contain`，header/footer 留在滚动区外。

- [ ] **Step 6: 运行 renderer 与相关偏好测试并提交**

Run: `node --test test/tag-ui-contract.test.js test/preferences-store.test.js test/ipc-validation.test.js`

Expected: PASS。

Commit:

```bash
git add test/tag-ui-contract.test.js src/renderer/index.html src/renderer/styles.css src/renderer/app.js
git commit -m "feat(tmux-desk): expand and fill tag rail"
```

---

### Task 3: 验证 Web 顺序兼容并升级 0.3.1

**Files:**
- Modify: `test/web-server.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `preferences.tags` 当前顺序。
- Produces: `/api/sessions` 中按最近使用顺序排列的 `tags`。

- [ ] **Step 1: 写 Web 顺序回归测试并确认 RED/GREEN 边界**

在现有 Web API 测试完成两个 Tag 创建后调用：

```js
preferences = await store.touchTag(first.id);
```

随后断言 API 返回：

```js
assert.deepEqual(payload.tags.map((tag) => tag.id), [first.id, second.id]);
```

Run: `node --test test/web-server.test.js`

Expected: PASS，因为服务器应无额外排序地投影 store 顺序；若失败，最小修复投影代码，禁止在 Web 层按名称或创建时间重新排序。

- [ ] **Step 2: 升级版本与发布说明**

把 `package.json`、`package-lock.json` 版本升为 `0.3.1`；README 的功能说明加入 Tag 最近使用排序、铺满与展开栏，移动端说明保持不变。

- [ ] **Step 3: 全量自动化验证并提交**

Run:

```bash
npm test
npm run test:integration
npm run build
```

Expected: 0 failures，三个命令退出码均为 0。

Commit:

```bash
git add test/web-server.test.js package.json package-lock.json README.md
git commit -m "docs(tmux-desk): prepare 0.3.1 release"
```

---

### Task 4: 真实桌面验收、打包与笔记

**Files:**
- Modify: `.Codex/notes/features/tmux-desktop-manager__main.md`（Git ignored）

**Interfaces:**
- Produces: `dist/Tmux Desk-0.3.1-arm64.dmg`。
- Produces: `dist/Tmux Desk-0.3.1-arm64-mac.zip`。

- [ ] **Step 1: 隔离 Electron 验收**

使用临时 `TMUX_TMPDIR`、独立 tmux socket 与临时 Electron `userData` 启动应用。创建至少三个 Tag，其中一个使用超过一行的长名称，验证：

1. Tag 区一直延伸到新增按钮，超出后只在 Tag 区滚动。
2. toggle 展开后完整名称与计数可见，收起后恢复首字符图标。
3. 点击最末 Tag 后它移到首位；重启临时应用后顺序仍保持。
4. 展开状态重启后保持。
5. “全部”仍显示中间栏；Tag/收藏仍收起中间栏并只有一层会话页签。
6. 1050px 以下窗口无横向溢出，手机 Web 375×812 与 812×375 无回归。

- [ ] **Step 2: 构建 arm64 安装包**

Run: `npm run dist:mac`

Expected: 生成 0.3.1 DMG 与 ZIP，命令退出码为 0。

- [ ] **Step 3: 校验产物**

Run:

```bash
hdiutil verify "dist/Tmux Desk-0.3.1-arm64.dmg"
unzip -tq "dist/Tmux Desk-0.3.1-arm64-mac.zip"
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Tmux Desk.app"
shasum -a 256 "dist/Tmux Desk-0.3.1-arm64.dmg" "dist/Tmux Desk-0.3.1-arm64-mac.zip"
```

Expected: DMG VALID、ZIP 无错误、签名验证通过并输出两个 SHA-256。

- [ ] **Step 4: 更新代码笔记并最终审计**

更新 feature note 的 Overview、Key Files、Change History、Gotchas、`last_verified_commit`，并运行：

```bash
git status --short
git diff --check
```

Expected: Git 工作区干净；`.Codex` 笔记指向最终提交。

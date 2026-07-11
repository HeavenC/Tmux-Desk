# Tag Rail 空间、最近使用排序与展开设计

## 目标

改进桌面端左侧 activity rail：Tag 列使用全部可用垂直空间；Tag 按最近使用顺序展示；整列可在紧凑图标态与完整名称态之间切换。手机 Web 保持现有触控布局，并继续使用同一组 Tag 顺序。

## 已确认交互

- Tag 列独占“新建 Tag”按钮上方的全部剩余高度，不再与空白 spacer 平分空间；Tag 超出高度后在该区域内滚动。
- 点击进入 Tag 即视为一次使用，该 Tag 移到首位；新建 Tag 默认位于首位。
- 最近使用顺序持久化，重启后保持；Web API 继续按持久化顺序投影 Tag，因此其他设备读取到相同顺序。
- 左侧列提供明确的 toggle。折叠态保持当前图标式导航；展开态显示主导航文字，以及每个 Tag 的完整名称和会话数。
- 展开状态只属于桌面 UI 偏好并持久化，不进入手机 Web 的公开偏好投影。
- 设置弹窗总高度不超过 760px，也不超过视口减 56px；头部和底部固定，中央内容独立滚动。

## 数据模型

`preferences.tags` 的数组顺序直接作为最近使用顺序，不新增时间戳或第二套排序字段：

1. `createTag(name)` 将新 Tag 插到数组首位。
2. `touchTag(id)` 校验 Tag 存在后，把目标移到数组首位；已经位于首位时保持幂等。
3. 删除、重命名与会话关联继续沿用现有逻辑。
4. `normalizeTags()` 保持输入顺序，因此旧偏好无需迁移，首次升级沿用原有顺序。

桌面展开状态新增布尔偏好 `tagRailExpanded`，默认 `false`。它由现有受限 `preferences:save` 通道保存，并在 normalization 与 IPC 校验中只接受布尔值。

桌面 App 与外部 Web 守护进程可能同时写同一偏好文件。每次完整读改写都必须先获取同路径的原子文件锁，跨 `PreferencesStore` 实例和跨进程串行执行；锁异常退出后按超时清理，写入完成后立即释放。

## 桌面结构与样式

- activity rail 的宽度改由 CSS 变量控制；折叠态沿用 62px（窄窗口 56px），展开态使用能够容纳完整 Tag 文本的宽栏。
- toggle 是原生 `<button>`，具有动态 `aria-label`、`title` 和 `aria-expanded`。
- Tag 按钮继续保留原生 button 语义。折叠态显示首字符与角标；展开态显示颜色标记、允许换行的完整名称和独立计数。
- `.tag-rail` 保持 `flex: 1; min-height: 0; overflow-y: auto`；`.rail-spacer` 不再消耗剩余高度。
- `compact-view` 只收起中间会话栏，不影响 activity rail 的展开状态；响应式网格仍由 CSS 变量控制，不能在 JavaScript 中内联整个 `grid-template-columns`。
- 设置弹窗使用 header / `.settings-scroll` / footer 三段式 flex 布局，避免 Tag 增多时整个弹窗被视口裁切。

## 事件与同步

桌面点击 Tag 时先立即更新本地顺序并重绘，让 UI 无等待地反馈；随后通过 `tags:touch` 串行持久化。touch 响应只合并 `tags`，不能用完整快照覆盖更晚完成的主题、展开状态或上次会话；递增 activation token 负责忽略快速连续点击产生的过期响应。持久化失败时提示错误并只重新校准 Tag 顺序。

新建 Tag 的 store 返回值已经把新 Tag 放在首位；现有创建后自动进入该 Tag 的流程不需要二次 touch。

手机端读取 `/api/sessions` 时按服务器返回的 `tags` 顺序展示。此次不增加移动端展开控件；移动端保持可横向滚动的单行文本筛选器，过长名称继续省略以保护小屏宽度。

## 验证

- Store 单测覆盖新建 Tag 首位、touch 后移到首位、重复 touch 幂等和未知 id 拒绝。
- 双 `PreferencesStore` 单测覆盖桌面 touch 与 Web 会话关联交错写入，验证无拒绝、无丢更新。
- IPC 与 preload 契约测试覆盖 `tags:touch` 及 `tagRailExpanded` 白名单。
- renderer 静态契约覆盖 toggle、展开 class、完整名称节点、基于 CSS 变量的网格以及 spacer 不再争抢空间。
- 设置弹窗契约覆盖视口内最大高度、中央滚动容器以及固定在滚动区外的头尾操作区。
- 全量单元测试、隔离 tmux 集成测试和 renderer/Web 构建必须通过。
- 真实 Electron 验收折叠/展开、长 Tag 完整显示、点击后的顺序变化、重启后展开状态与顺序保持，并检查 1050px 以下窗口没有横向布局破坏。

## 发布

版本提升为 `0.3.1`，重新生成 arm64 DMG 与 ZIP。产物保持 ad-hoc 签名、不安装或覆盖 `/Applications`。

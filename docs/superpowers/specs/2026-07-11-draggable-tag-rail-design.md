# 可拖动 Tag 栏设计

## 目标

让桌面端展开后的 Tag 导航栏可以从右边界水平拖动调整宽度，同时保留现有折叠、最近使用排序、会话页签、桌面响应式和手机 Web 行为。

## 范围

- 展开态 Tag 栏默认宽度保持 240px。
- 用户可以把展开态宽度拖到 180–420px。
- 拖动结束后持久化宽度，应用重启后恢复。
- 双击分隔线清除自定义值，恢复当前响应式断点的默认宽度。
- 折叠态继续使用固定窄栏，分隔线不显示且不响应拖动。
- “全部 / 收藏 / Tag”三个桌面视图共享同一展开宽度。
- 手机 Web 不增加分隔线，不修改现有横向 Tag 筛选和触控布局。
- 应用版本由 0.3.1 升至 0.3.2。

## 布局与交互

在 `.activity-rail` 与后续内容之间新增独立 `#tagRailResizer` 元素。桌面网格从五个轨道扩展为六个轨道：Tag rail、Tag resizer、会话侧栏、会话侧栏 resizer、工作区、文件栏。紧凑视图保留 Tag rail、Tag resizer、工作区、文件栏。

`--activity-rail-expanded-width` 继续控制展开宽度；新增 `--tag-rail-resizer-width`，折叠态为 0，展开态为 5px。分隔线使用 `col-resize` 光标，悬停和拖动时显示 accent 高亮。拖动期间给 `body` 增加专用 class，统一锁定文本选择和光标；mouseup 时解除事件监听和状态。

拖动从 `.activity-rail.getBoundingClientRect().width` 开始，用鼠标水平位移计算新宽度并经过 180–420px clamp。mousemove 只更新 CSS 变量，mouseup 才写偏好，避免每个像素都触发 IPC/磁盘写入。双击写入 `null` 并移除内联 CSS 变量，从而重新使用 240px 或窄窗口下的 220px 默认值。

## 偏好与数据流

新增可空偏好 `tagRailWidth`：

1. `PreferencesStore.DEFAULT_PREFERENCES` 默认 `null`。
2. 归一化只接受有限数字，四舍五入并 clamp 到 180–420；其他值回退为 `null`。
3. `validatePreferencesPatch()` 只接受 `null` 或 100–1000 范围的有限数字，再由 store 做最终产品范围归一化。这与现有 `sidebarWidth` IPC/store 分层一致。
4. renderer 初始化加载偏好后调用 `applyTagRailWidth()`；拖动完成调用 `savePreferences({ tagRailWidth })`。
5. 保存失败时显示现有 toast，并重新应用当前内存偏好，避免 UI 留在未持久化的临时宽度。

`tagRailExpanded` 与 `tagRailWidth` 独立：收起不清除宽度，再展开时恢复；双击才清除自定义宽度。

## 响应式与兼容

- Electron 窗口最小宽度为 960px，420px 上限仍为会话侧栏和工作区保留可用空间。
- `@media (max-width: 1050px)` 的默认展开宽度仍为 220px；只有存在持久化自定义值时才由元素级 CSS 变量覆盖。
- 紧凑视图不显示会话侧栏 resizer，但展开态仍显示 Tag resizer。
- 折叠态和手机 Web 均无新增可拖动控件，因此移动触摸、viewport 和横向滚动行为不变。
- 分隔线沿用现有桌面 `mousedown/mousemove/mouseup` 模型，不引入新依赖。

## 测试与验收

自动化测试覆盖：

- 偏好默认值、非法值回退、180–420 clamp、保存与重启恢复。
- IPC 接受 `tagRailWidth` 的有限数字/null，拒绝字符串和越界输入。
- HTML 包含独立 resizer；CSS 网格、展开/折叠可见性、hover/drag 状态符合契约。
- renderer 绑定拖动、clamp、持久化和双击复位，且不以内联 `gridTemplateColumns` 覆盖响应式规则。
- 现有 Tag 最近顺序、`tabOrders`、设置滚动、手机 Web 和真实 tmux 集成测试全部继续通过。

桌面验收至少覆盖默认宽度、拖到最小/最大、三种视图共享宽度、收起/展开恢复、双击复位和重启恢复。部署后校验 ASAR 内版本 0.3.2、关键源码/构建产物与 `main` 一致、签名有效、应用进程和手机 API 可用。

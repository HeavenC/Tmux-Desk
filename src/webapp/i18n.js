// Minimal i18n layer for the mobile webapp: a flat key -> string table per
// locale, detected from navigator.language (system default) and optionally
// overridden by the user. Chinese is always the fallback/default.
const MESSAGES = {
  zh: {
    'common.loading': '加载中…',
    'common.retry': '重试',
    'common.reconnect': '重连',
    'common.back': '返回',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.saving': '保存中…',
    'common.delete': '删除',
    'common.add': '添加',
    'common.done': '完成',
    'common.close': '关闭',
    'common.selectAllCopy': '全选复制',

    'theme.toggle': '切换主题',

    'fullscreen.enter': '全屏',
    'fullscreen.exit': '退出全屏',

    'list.refresh': '刷新',
    'list.workspaceAria': '会话工作区',
    'list.emptyAll': '暂无 tmux 会话',
    'list.emptyShared': '共享会话暂不可用',
    'list.emptyFiltered': '{label}中暂无会话',
    'list.tagsAssociatedAria': '已关联 Tag',
    'list.manageTagsAria': '管理 {name} 的 Tag',
    'list.sessionSub': '{windows} 窗口 · {panes} 面板 · {cmd}',

    'share.badge': '共享会话',

    'filter.all': '全部',
    'filter.favorites': '收藏',
    'filter.titleCount': '{label}（{count}）',

    'time.justNow': '刚刚',
    'time.minutesAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.yesterday': '昨天',
    'time.daysAgo': '{n} 天前',

    'term.windowAria': 'tmux 窗口',

    'quick.keyboard': '键盘',
    'quick.copy': '复制',
    'quick.edit': '编辑',
    'quick.ballAria': '快捷键',
    'quick.editTitle': '编辑快捷栏',
    'quick.editHint': '点按下方按键添加，或自定义文本；已添加的可删除。',
    'quick.presetSectionTitle': '常用按键 / 组合键',
    'quick.customSectionTitle': '自定义文本（如 /usage、!、任意命令）',
    'quick.labelPlaceholder': '按钮名',
    'quick.textPlaceholder': '发送文本',
    'quick.enterLabel': '回车',
    'quick.currentSectionTitle': '当前快捷键',
    'quick.resetDefault': '恢复默认',
    'quick.empty': '快捷栏为空。',
    'quick.dragHandleAria': '拖动排序',
    'quick.keyTypeMeta': '按键',

    'sheet.manageTagTitle': '管理 Tag',
    'sheet.noTagsHint': '还没有 Tag，请先在 Mac 桌面端创建。',
    'sheet.copyTitle': '选择并复制',

    'reconnect.disconnected': '连接已断开',
    'reconnect.progress': '连接已断开，正在重连…（{n}/{max}）',

    'toast.tagSaved': 'Tag 已保存',
    'toast.tagSaveFailed': 'Tag 保存失败',
    'toast.copied': '已复制到剪贴板',
    'toast.copyManual': '无法自动复制，已为你选中内容，请手动复制',
    'toast.sessionEnded': '会话已结束',
    'toast.genericError': '发生错误',
    'toast.fillLabelAndText': '请填写按钮名和发送文本',
    'toast.fullscreenDenied': '全屏被浏览器拒绝',
    'toast.fullscreenSafariHint': '在 Safari 中点击分享 → 添加到主屏幕，即可全屏使用',

    'error.badResponse': '服务器响应格式错误',
    'error.requestFailed': '请求失败',
    'error.loadFailed': '加载失败',
    'error.loadWindowsFailed': '获取窗口失败',
    'error.switchWindowFailed': '切换窗口失败',
    'error.missingCredential': '缺少访问凭据，请通过正确链接访问',
  },
  en: {
    'common.loading': 'Loading…',
    'common.retry': 'Retry',
    'common.reconnect': 'Reconnect',
    'common.back': 'Back',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.delete': 'Delete',
    'common.add': 'Add',
    'common.done': 'Done',
    'common.close': 'Close',
    'common.selectAllCopy': 'Select All & Copy',

    'theme.toggle': 'Toggle theme',

    'fullscreen.enter': 'Fullscreen',
    'fullscreen.exit': 'Exit fullscreen',

    'list.refresh': 'Refresh',
    'list.workspaceAria': 'Session workspaces',
    'list.emptyAll': 'No tmux sessions',
    'list.emptyShared': 'The shared session is unavailable',
    'list.emptyFiltered': 'No sessions in {label}',
    'list.tagsAssociatedAria': 'Associated tags',
    'list.manageTagsAria': 'Manage tags for {name}',
    'list.sessionSub': '{windows} windows · {panes} panes · {cmd}',

    'share.badge': 'Shared session',

    'filter.all': 'All',
    'filter.favorites': 'Favorites',
    'filter.titleCount': '{label} ({count})',

    'time.justNow': 'just now',
    'time.minutesAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'time.yesterday': 'yesterday',
    'time.daysAgo': '{n}d ago',

    'term.windowAria': 'tmux window',

    'quick.keyboard': 'Keyboard',
    'quick.copy': 'Copy',
    'quick.edit': 'Edit',
    'quick.ballAria': 'Quick keys',
    'quick.editTitle': 'Edit Quick Bar',
    'quick.editHint': 'Tap a key below to add it, or add custom text; added keys can be removed.',
    'quick.presetSectionTitle': 'Common keys / combos',
    'quick.customSectionTitle': 'Custom text (e.g. /usage, !, any command)',
    'quick.labelPlaceholder': 'Button name',
    'quick.textPlaceholder': 'Text to send',
    'quick.enterLabel': 'Enter',
    'quick.currentSectionTitle': 'Current quick keys',
    'quick.resetDefault': 'Reset to default',
    'quick.empty': 'Quick bar is empty.',
    'quick.dragHandleAria': 'Drag to reorder',
    'quick.keyTypeMeta': 'Key',

    'sheet.manageTagTitle': 'Manage Tags',
    'sheet.noTagsHint': 'No tags yet — create one on the Mac desktop app first.',
    'sheet.copyTitle': 'Select & Copy',

    'reconnect.disconnected': 'Disconnected',
    'reconnect.progress': 'Disconnected, reconnecting… ({n}/{max})',

    'toast.tagSaved': 'Tags saved',
    'toast.tagSaveFailed': 'Failed to save tags',
    'toast.copied': 'Copied to clipboard',
    'toast.copyManual': "Couldn't copy automatically — text is selected, please copy manually",
    'toast.sessionEnded': 'Session ended',
    'toast.genericError': 'An error occurred',
    'toast.fillLabelAndText': 'Please fill in a button name and text to send',
    'toast.fullscreenDenied': 'Fullscreen was denied by the browser',
    'toast.fullscreenSafariHint': 'In Safari, tap Share → Add to Home Screen to use fullscreen',

    'error.badResponse': 'Malformed server response',
    'error.requestFailed': 'Request failed',
    'error.loadFailed': 'Failed to load',
    'error.loadWindowsFailed': 'Failed to load windows',
    'error.switchWindowFailed': 'Failed to switch window',
    'error.missingCredential': 'Missing access credentials — please use a valid link',
  },
};

function detectLocale() {
  const lang = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage) || '').toLowerCase();
  if (!lang) return 'zh';
  return lang.startsWith('en') ? 'en' : 'zh';
}

let locale = detectLocale();

function t(key, params) {
  const table = MESSAGES[locale] || MESSAGES.zh;
  let s = key in table ? table[key] : (key in MESSAGES.zh ? MESSAGES.zh[key] : key);
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ''));
  return s;
}

function getLocale() { return locale; }
function setLocale(l) { if (l === 'zh' || l === 'en') locale = l; }

function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
}

module.exports = { t, getLocale, setLocale, applyStaticI18n, detectLocale, MESSAGES };

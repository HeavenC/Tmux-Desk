// Labels for the native application menu (main process). Electron auto-localizes
// role-based items (about/quit/copy/…); these are the custom labels we control.
// The renderer pushes the effective locale over IPC so this follows the same
// language preference as the rest of the UI.

const MENU_MESSAGES = {
  zh: {
    file: '文件',
    edit: '编辑',
    view: '显示',
    newSession: '新建会话',
    commandPalette: '命令面板',
    importSessions: '会话导入',
    importClaude: '从 Claude Code 导入…',
    importCodex: '从 Codex 导入…',
    importIdea: '从 IntelliJ IDEA 导入…',
    importVscode: '从 VS Code 导入…',
    refresh: '刷新会话',
    search: '搜索会话',
    splitVertical: '垂直分割',
    splitHorizontal: '水平分割',
  },
  en: {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    newSession: 'New Session',
    commandPalette: 'Command Palette',
    importSessions: 'Import Sessions',
    importClaude: 'From Claude Code…',
    importCodex: 'From Codex…',
    importIdea: 'From IntelliJ IDEA…',
    importVscode: 'From VS Code…',
    refresh: 'Refresh Sessions',
    search: 'Search Sessions',
    splitVertical: 'Split Vertically',
    splitHorizontal: 'Split Horizontally',
  },
};

function menuText(locale) {
  return MENU_MESSAGES[locale === 'en' ? 'en' : 'zh'];
}

// Map a full system locale (e.g. app.getLocale() -> "en-US") to zh/en.
function normalizeMenuLocale(locale) {
  return String(locale || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

module.exports = { menuText, normalizeMenuLocale, MENU_MESSAGES };

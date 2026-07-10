const assert = require('node:assert/strict');
const test = require('node:test');

const { searchCommands } = require('../src/renderer/command-palette');

const commands = [
  { id: 'new', title: '新建会话', subtitle: '创建本地 tmux session', shortcut: '⌘N', keywords: ['create'] },
  { id: 'refresh', title: '刷新会话', subtitle: '重新读取 tmux', shortcut: '⌘R' },
  { id: 'theme', title: '切换主题', subtitle: '亮色、暗色、跟随系统', shortcut: '⌘⇧T', keywords: ['dark', 'light'] },
];

test('command search matches title and shortcut labels', () => {
  assert.deepEqual(searchCommands(commands, 'cmd n').map((item) => item.id), ['new']);
  assert.deepEqual(searchCommands(commands, '新建').map((item) => item.id), ['new']);
});

test('command search matches subtitle and keywords case-insensitively', () => {
  assert.deepEqual(searchCommands(commands, 'TMUX').map((item) => item.id), ['new', 'refresh']);
  assert.deepEqual(searchCommands(commands, 'DARK').map((item) => item.id), ['theme']);
});

test('empty search preserves command order and does not mutate input', () => {
  const original = commands.map((item) => item.id);
  assert.deepEqual(searchCommands(commands, '').map((item) => item.id), original);
  assert.deepEqual(commands.map((item) => item.id), original);
});

test('all whitespace-separated tokens must match', () => {
  assert.deepEqual(searchCommands(commands, 'cmd shift t').map((item) => item.id), ['theme']);
  assert.deepEqual(searchCommands(commands, 'cmd n refresh'), []);
});

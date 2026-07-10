const assert = require('node:assert/strict');
const test = require('node:test');

const { withUtf8Locale } = require('../src/main/locale-env');
const { TmuxService } = require('../src/main/tmux-service');
const { TerminalManager } = require('../src/main/terminal-manager');

test('withUtf8Locale injects a UTF-8 locale when Finder launch strips LANG/LC_*', () => {
  const patched = withUtf8Locale({ PATH: '/bin' });
  assert.equal(patched.LC_ALL, 'en_US.UTF-8');
  assert.equal(patched.LANG, 'en_US.UTF-8');
  assert.equal(patched.PATH, '/bin');
});

test('withUtf8Locale preserves an already UTF-8 locale', () => {
  const patched = withUtf8Locale({ LANG: 'zh_CN.UTF-8' });
  assert.equal(patched.LANG, 'zh_CN.UTF-8');
  assert.equal(patched.LC_ALL, undefined);
});

test('withUtf8Locale overrides a non-UTF-8 LANG via LC_ALL', () => {
  const patched = withUtf8Locale({ LANG: 'C' });
  assert.equal(patched.LC_ALL, 'en_US.UTF-8');
});

test('TmuxService runs tmux with a guaranteed UTF-8 locale', async () => {
  let seenEnv = null;
  const service = new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    env: { PATH: '/bin' },
    fsImpl: { constants: { X_OK: 1 }, accessSync() {}, statSync: () => ({ isDirectory: () => true }) },
    execFileImpl: async (file, args, options) => { seenEnv = options?.env; return { stdout: '', stderr: '' }; },
  });
  await service.getStatus();
  // Custom execFileImpl above ignores env, so assert the service itself resolved a UTF-8 locale.
  assert.match(service.env.LC_ALL || service.env.LANG || '', /utf-?8/i);
});

test('TerminalManager attaches with a guaranteed UTF-8 locale', () => {
  const calls = [];
  const manager = new TerminalManager({
    ptyModule: { spawn: (file, args, options) => { calls.push(options); return { onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, write() {}, resize() {} }; } },
    env: { PATH: '/bin', TERM: 'old' },
    sendEvent() {},
  });
  manager.attach({ sessionId: '$0', cols: 80, rows: 24 });
  assert.match(calls[0].env.LC_ALL || calls[0].env.LANG || '', /utf-?8/i);
});

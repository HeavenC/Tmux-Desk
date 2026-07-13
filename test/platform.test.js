const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTmuxInvocation,
  toWslPath,
  toWindowsPath,
  wslConfig,
  resolveWslDistro,
  resetWslDistroCache,
  withTmuxDirOnPath,
} = require('../src/main/platform');

test('buildTmuxInvocation runs the tmux binary directly off Windows', () => {
  const { file, args } = buildTmuxInvocation(
    { platform: 'darwin', tmuxPath: '/opt/homebrew/bin/tmux', env: {} },
    ['list-sessions', '-F', '#{session_id}'],
  );
  assert.equal(file, '/opt/homebrew/bin/tmux');
  assert.deepEqual(args, ['list-sessions', '-F', '#{session_id}']);
});

test('buildTmuxInvocation wraps tmux in wsl.exe on Windows', () => {
  const { file, args } = buildTmuxInvocation(
    { platform: 'win32', tmuxPath: 'tmux', env: {} },
    ['-V'],
  );
  assert.equal(file, 'wsl.exe');
  assert.deepEqual(args, ['-e', 'tmux', '-V']);
});

test('buildTmuxInvocation honours a pinned distro and tmux command', () => {
  const { file, args } = buildTmuxInvocation(
    { platform: 'win32', tmuxPath: '/usr/bin/tmux', env: { TMUX_DESK_WSL_DISTRO: 'Ubuntu' } },
    ['kill-session', '-t', '$1'],
  );
  assert.equal(file, 'wsl.exe');
  assert.deepEqual(args, ['-d', 'Ubuntu', '-e', '/usr/bin/tmux', 'kill-session', '-t', '$1']);
});

test('toWslPath maps Windows drive and UNC paths into WSL', () => {
  assert.equal(toWslPath('C:\\Users\\me\\proj'), '/mnt/c/Users/me/proj');
  assert.equal(toWslPath('D:\\'), '/mnt/d');
  assert.equal(toWslPath('\\\\wsl$\\Ubuntu\\home\\me\\proj'), '/home/me/proj');
  assert.equal(toWslPath('\\\\wsl.localhost\\Debian\\root\\x'), '/root/x');
  assert.equal(toWslPath('/already/posix'), '/already/posix');
});

test('toWindowsPath maps /mnt purely and native paths via the distro UNC', () => {
  assert.equal(toWindowsPath('/mnt/c/Users/me/proj'), 'C:\\Users\\me\\proj');
  assert.equal(toWindowsPath('/mnt/d'), 'D:\\');
  assert.equal(toWindowsPath('/home/me/proj', 'Ubuntu'), '\\\\wsl$\\Ubuntu\\home\\me\\proj');
  assert.equal(toWindowsPath('/home/me/proj', null), null);
  assert.equal(toWindowsPath('C:\\already', 'Ubuntu'), 'C:\\already');
});

test('translations round-trip for drive-backed paths', () => {
  assert.equal(toWslPath(toWindowsPath('/mnt/c/Users/me')), '/mnt/c/Users/me');
  assert.equal(toWindowsPath(toWslPath('C:\\Users\\me')), 'C:\\Users\\me');
});

test('wslConfig reads the pinned env vars', () => {
  assert.deepEqual(wslConfig({ TMUX_DESK_WSL_DISTRO: ' Ubuntu ', TMUX_DESK_WSL_TMUX: ' tmux ' }), {
    distro: 'Ubuntu',
    tmux: 'tmux',
  });
  assert.deepEqual(wslConfig({}), { distro: null, tmux: 'tmux' });
});

test('resolveWslDistro prefers the env var, else decodes UTF-16 wsl -l output', async () => {
  resetWslDistroCache();
  assert.equal(await resolveWslDistro({ env: { TMUX_DESK_WSL_DISTRO: 'Pinned' }, execFileImpl: async () => {
    throw new Error('should not be called when pinned');
  } }), 'Pinned');

  resetWslDistroCache();
  // wsl.exe emits UTF-16LE: ASCII bytes interleaved with NULs.
  const utf16 = 'Ubuntu\nDebian\n'.split('').map((c) => c + '\0').join('');
  const distro = await resolveWslDistro({ env: {}, execFileImpl: async () => ({ stdout: utf16 }) });
  assert.equal(distro, 'Ubuntu');

  resetWslDistroCache();
  const missing = await resolveWslDistro({ env: {}, execFileImpl: async () => { throw new Error('no wsl'); } });
  assert.equal(missing, null);
});

test('withTmuxDirOnPath prepends the tmux directory exactly once', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/Users/x' };
  const patched = withTmuxDirOnPath(env, '/opt/homebrew/bin/tmux', 'darwin');
  assert.equal(patched.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
  assert.equal(patched.HOME, '/Users/x');
  // Already on PATH → the same env object comes back untouched.
  assert.equal(withTmuxDirOnPath(patched, '/opt/homebrew/bin/tmux', 'darwin'), patched);
  assert.equal(withTmuxDirOnPath(env, '/usr/bin/tmux', 'darwin'), env);
});

test('withTmuxDirOnPath is a no-op for relative commands, Windows, and missing PATH survives', () => {
  const env = { PATH: '/usr/bin' };
  assert.equal(withTmuxDirOnPath(env, 'tmux', 'darwin'), env);
  assert.equal(withTmuxDirOnPath(env, null, 'darwin'), env);
  // On Windows tmux runs inside WSL; the Windows PATH is irrelevant to it.
  assert.equal(withTmuxDirOnPath(env, '/usr/bin/tmux', 'win32'), env);
  assert.equal(withTmuxDirOnPath({}, '/opt/homebrew/bin/tmux', 'darwin').PATH, '/opt/homebrew/bin');
});

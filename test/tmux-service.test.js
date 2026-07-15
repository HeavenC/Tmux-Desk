const assert = require('node:assert/strict');
const test = require('node:test');

const { TmuxError, TmuxService } = require('../src/main/tmux-service');

function executableFs(paths = []) {
  const available = new Set(paths);
  return {
    constants: { X_OK: 1 },
    accessSync(path) {
      if (!available.has(path)) throw new Error(`not executable: ${path}`);
    },
    statSync(path) {
      return { isDirectory: () => path === '/Users/liwei/work' };
    },
  };
}

test('listSessions parses unicode session names without invoking a shell', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    fsImpl: executableFs(['/opt/homebrew/bin/tmux']),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (args.includes('list-panes')) return { stdout: '$3\t%1\t1\tkubectl\n', stderr: '' };
      return { stdout: '$3\t☸️ k8s-uat\t1\t2\t100\t/Users/liwei/work\n', stderr: '' };
    },
  });

  assert.deepEqual(await service.listSessions(), [{
    id: '$3', name: '☸️ k8s-uat', attached: true, windows: 2,
    activity: 100, path: '/Users/liwei/work', paneCount: 1, activeCommand: 'kubectl',
  }]);
  assert.equal(calls[0].file, '/opt/homebrew/bin/tmux');
  assert.equal(calls[0].args.includes('-F'), true);
  assert.equal(calls[0].args.includes('list-sessions'), true);
});

test('listSessions prefixes every tmux call with the configured socket name', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    socketName: 'task-one-test',
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  await service.listSessions();

  assert.deepEqual(calls.map(({ args }) => args.slice(0, 3)), [
    ['-L', 'task-one-test', 'list-sessions'],
    ['-L', 'task-one-test', 'list-panes'],
  ]);
});

test('resolveTmuxPath uses the configured override then the exact candidates and which', async () => {
  const calls = [];
  const service = new TmuxService({
    fsImpl: executableFs(['/usr/bin/tmux']),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: '/custom/tmux\n', stderr: '' };
    },
  });

  assert.equal(await service.resolveTmuxPath(), '/usr/bin/tmux');
  assert.deepEqual(calls, []);

  const fallback = new TmuxService({
    fsImpl: executableFs(),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: '/custom/tmux\n', stderr: '' };
    },
  });
  assert.equal(await fallback.resolveTmuxPath(), '/custom/tmux');
  assert.deepEqual(calls.at(-1), { file: '/usr/bin/which', args: ['tmux'] });
});

test('resolveTmuxPath skips a non-executable configured override', async () => {
  const checks = [];
  const service = new TmuxService({
    tmuxPath: '/stale/tmux',
    fsImpl: {
      constants: { X_OK: 1 },
      accessSync(candidate, mode) {
        checks.push([candidate, mode]);
        if (candidate !== '/opt/homebrew/bin/tmux') throw new Error('not executable');
      },
    },
    execFileImpl: async () => {
      throw new Error('which should not be called');
    },
  });

  assert.equal(await service.resolveTmuxPath(), '/opt/homebrew/bin/tmux');
  assert.deepEqual(checks, [
    ['/stale/tmux', 1],
    ['/opt/homebrew/bin/tmux', 1],
  ]);
});

test('getStatus reports a missing binary and a trimmed tmux version', async () => {
  const missing = new TmuxService({ fsImpl: executableFs(), execFileImpl: async () => ({ stdout: '', stderr: '' }) });
  assert.deepEqual(await missing.getStatus(), { installed: false, path: null, version: null });

  const installed = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async () => ({ stdout: 'tmux 3.5\n', stderr: '' }),
  });
  assert.deepEqual(await installed.getStatus(), { installed: true, path: '/tmp/tmux', version: 'tmux 3.5' });
});

test('getSessionDetail parses windows and panes with typed fields', async () => {
  const service = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async (file, args) => {
      if (args.includes('list-windows')) {
        return { stdout: '@1\t0\teditor\t1\t2\n', stderr: '' };
      }
      return { stdout: '%1\t@1\t0\t0\t1\t/Users/liwei/work\tnvim\tmain\t0\t0\t120\t40\n', stderr: '' };
    },
  });

  assert.deepEqual(await service.getSessionDetail('$3'), {
    windows: [{ id: '@1', index: 0, name: 'editor', active: true, panes: 2 }],
    panes: [{ id: '%1', windowId: '@1', windowIndex: 0, index: 0, active: true,
      path: '/Users/liwei/work', command: 'nvim', title: 'main',
      left: 0, top: 0, width: 120, height: 40 }],
  });
});

test('createSession validates input and sends a literal startup command to its new session', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: args.includes('new-session') ? '$9\n' : '', stderr: '' };
    },
  });

  assert.deepEqual(await service.createSession({ name: '  my/project  ', cwd: '/Users/liwei/work', startupCommand: 'npm run dev' }), { id: '$9', name: 'my/project' });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'my/project', '-c', '/Users/liwei/work'],
    ['send-keys', '-t', '$9', '-l', '--', 'npm run dev'],
    ['send-keys', '-t', '$9', 'Enter'],
  ]);
  await assert.rejects(() => service.createSession({ name: '.', cwd: '/Users/liwei/work' }), /会话名称/);
  await assert.rejects(() => service.createSession({ name: 'release.1', cwd: '/Users/liwei/work' }), /会话名称/);
  await assert.rejects(() => service.createSession({ name: 'valid', cwd: 'relative' }), /绝对路径/);
  await assert.rejects(() => service.createSession({ name: 'valid', cwd: '/Users/liwei/work', startupCommand: 'one\ntwo' }), /换行/);
});

test('duplicateSession forks a new session mirroring the source windows and directories', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async (file, args) => {
      calls.push(args);
      if (args.includes('list-windows')) return { stdout: '@1\t0\teditor\t1\t1\n@2\t1\tserver\t0\t1\n', stderr: '' };
      if (args.includes('list-panes')) {
        return { stdout: '%1\t@1\t0\t0\t1\t/Users/liwei/work\tnvim\tmain\n%2\t@2\t1\t0\t1\t/Users/liwei/work\tnode\tsrv\n', stderr: '' };
      }
      if (args.includes('new-session')) return { stdout: '$9\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(await service.duplicateSession('$3', '  fork  '), { id: '$9', name: 'fork' });
  const mutations = calls.filter((args) => ['new-session', 'rename-window', 'new-window'].some((cmd) => args.includes(cmd)));
  assert.deepEqual(mutations, [
    ['new-session', '-d', '-P', '-F', '#{session_id}', '-s', 'fork', '-c', '/Users/liwei/work'],
    ['rename-window', '-t', '$9', 'editor'],
    ['new-window', '-t', '$9', '-c', '/Users/liwei/work', '-n', 'server'],
  ]);
  await assert.rejects(() => service.duplicateSession('nope', 'fork'), /会话/);
  await assert.rejects(() => service.duplicateSession('$3', '.'), /会话名称/);
});

test('session, window, and pane controls use validated exact argument arrays', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    socketName: 'isolated',
    execFileImpl: async (file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    },
  });

  await service.renameSession('$1', 'renamed');
  await service.killSession('$1');
  await service.selectWindow('@2');
  await service.selectPane('%3');
  await service.killPane('%3');
  assert.deepEqual(calls, [
    ['-L', 'isolated', 'rename-session', '-t', '$1', 'renamed'],
    ['-L', 'isolated', 'kill-session', '-t', '$1'],
    ['-L', 'isolated', 'select-window', '-t', '@2'],
    ['-L', 'isolated', 'select-pane', '-t', '%3'],
    ['-L', 'isolated', 'kill-pane', '-t', '%3'],
  ]);
  await assert.rejects(() => service.killSession('named-session'), /无效的 tmux 会话目标/);
  await assert.rejects(() => service.selectWindow('%3'), /无效的 tmux 窗口目标/);
  await assert.rejects(() => service.selectPane('@2'), /无效的 tmux 面板目标/);
  await assert.rejects(() => service.killPane('@2'), /无效的 tmux 面板目标/);
});

test('listSessions treats only no-server errors as an empty result', async () => {
  const noServer = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async () => Promise.reject({ stderr: 'no server running on /tmp/tmux' }),
  });
  assert.deepEqual(await noServer.listSessions(), []);

  const failed = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async () => Promise.reject({ stderr: "can't find session: $1" }),
  });
  await assert.rejects(() => failed.listSessions(), (error) => {
    assert.ok(error instanceof TmuxError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    assert.equal(error.message, 'tmux 会话不存在或已关闭');
    return true;
  });
});

test('tmux failures normalize to stable error codes and messages', async () => {
  const cases = [
    [{ code: 'ENOENT', stderr: '' }, 'TMUX_NOT_FOUND', '未找到 tmux，请先运行 brew install tmux'],
    [{ stderr: 'failed to connect to server' }, 'NO_SERVER', 'tmux 服务尚未启动'],
    [{ stderr: 'duplicate session: demo' }, 'SESSION_EXISTS', '已存在同名 tmux 会话'],
    [{ stderr: 'permission denied\n' }, 'COMMAND_FAILED', 'tmux 操作失败：permission denied'],
  ];

  for (const [failure, code, message] of cases) {
    const service = new TmuxService({
      tmuxPath: '/tmp/tmux',
      fsImpl: executableFs(['/tmp/tmux']),
      execFileImpl: async () => Promise.reject(failure),
    });
    await assert.rejects(() => service.killSession('$1'), (error) => {
      assert.ok(error instanceof TmuxError);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
      return true;
    });
  }
});

test('on Windows tmux runs inside WSL and cwd is translated to a WSL path', async () => {
  const calls = [];
  const service = new TmuxService({
    platform: 'win32',
    fsImpl: {
      constants: { X_OK: 1 },
      statSync: (p) => ({ isDirectory: () => p === 'C:\\Users\\me\\proj' }),
    },
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      return { stdout: '$7\n', stderr: '' };
    },
  });

  const created = await service.createSession({ name: 'proj', cwd: 'C:\\Users\\me\\proj' });
  assert.deepEqual(created, { id: '$7', name: 'proj' });
  assert.equal(calls[0].file, 'wsl.exe');
  // wsl.exe -e tmux new-session … -c /mnt/c/Users/me/proj
  assert.equal(calls[0].args[0], '-e');
  assert.equal(calls[0].args[1], 'tmux');
  assert.equal(calls[0].args.at(-1), '/mnt/c/Users/me/proj');
  assert.equal(calls[0].args.includes('new-session'), true);
});

test('getStatus reports WSL-missing vs tmux-missing reasons on Windows', async () => {
  const wslMissing = new TmuxService({
    platform: 'win32',
    execFileImpl: async () => Promise.reject({ code: 'ENOENT' }),
  });
  assert.deepEqual(await wslMissing.getStatus(), {
    installed: false, path: null, version: null, reason: 'WSL_NOT_FOUND',
  });

  const tmuxMissing = new TmuxService({
    platform: 'win32',
    execFileImpl: async () => Promise.reject({ stderr: 'bash: tmux: command not found' }),
  });
  assert.deepEqual(await tmuxMissing.getStatus(), {
    installed: false, path: null, version: null, reason: 'TMUX_NOT_FOUND',
  });

  const ok = new TmuxService({
    platform: 'win32',
    execFileImpl: async () => ({ stdout: 'tmux 3.4\n', stderr: '' }),
  });
  assert.deepEqual(await ok.getStatus(), { installed: true, path: 'WSL:tmux', version: 'tmux 3.4' });
});

test('splitPane maps orientation to tmux -h/-v and opens in the current dir', async () => {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    fsImpl: executableFs(['/opt/homebrew/bin/tmux']),
    execFileImpl: async (file, args) => { calls.push(args); return { stdout: '%9\n', stderr: '' }; },
  });

  const vertical = await service.splitPane('$3', 'vertical');
  assert.deepEqual(vertical, { id: '%9' });
  assert.deepEqual(calls[0], ['split-window', '-h', '-P', '-F', '#{pane_id}', '-t', '$3', '-c', '#{pane_current_path}']);

  await service.splitPane('$3', 'horizontal');
  assert.equal(calls[1][1], '-v');

  await assert.rejects(() => service.splitPane('nope', 'vertical'), /无效的 tmux/);
});

test('applySessionDefaults applies the managed iTerm-like profile and advanced options', async () => {
  const makeService = (calls) => new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    fsImpl: executableFs(['/opt/homebrew/bin/tmux']),
    execFileImpl: async (file, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  });

  const calls = [];
  assert.equal(await makeService(calls).applySessionDefaults('$4', {
    mouse: false,
    historyLimit: 90000,
    modeKeys: 'vi',
    status: true,
    extendedKeys: false,
    advancedConfig: "set -g status-left '#S'",
  }), true);
  assert.equal(calls.length, 36);
  for (const expected of [
    ['set-option', '-u', '-t', '$4', 'mouse'],
    ['set-option', '-g', 'mouse', 'off'],
    ['set-option', '-g', 'history-limit', '90000'],
    ['set-option', '-g', 'status', 'on'],
    ['set-option', '-s', 'escape-time', '10'],
    ['set-option', '-s', 'extended-keys', 'off'],
    ['set-option', '-s', 'default-terminal', 'tmux-256color'],
    ['set-window-option', '-g', 'mode-keys', 'vi'],
    ['bind-key', '-T', 'copy-mode', 'C-v', 'send-keys', '-X', 'cancel', '\\;', 'send-keys', 'C-v'],
    ['bind-key', '-T', 'copy-mode-vi', 'C-v', 'send-keys', '-X', 'cancel', '\\;', 'send-keys', 'C-v'],
    ['set', '-g', 'status-left', '#S'],
  ]) {
    assert.equal(calls.some((call) => JSON.stringify(call) === JSON.stringify(expected)), true, expected.join(' '));
  }

  const reset = [];
  await makeService(reset).applySessionDefaults('$4', {
    detachOnDestroy: true,
    remainOnExit: true,
    trueColor: false,
  });
  assert.equal(reset.some((call) => call.join(' ') === 'set-option -g detach-on-destroy on'), true);
  assert.equal(reset.some((call) => call.join(' ') === 'set-window-option -g remain-on-exit on'), true);
  assert.equal(reset.some((call) => call.join(' ') === 'set-option -s default-terminal screen-256color'), true);

  // Invalid targets are a programming error and still throw…
  await assert.rejects(() => makeService([]).applySessionDefaults('pwned; rm'), /无效的 tmux/);

  // …but a failing tmux (old version, race with a killed session) must not
  // break the attach that follows.
  const failing = new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    fsImpl: executableFs(['/opt/homebrew/bin/tmux']),
    execFileImpl: async () => { throw new Error('no server running'); },
  });
  assert.equal(await failing.applySessionDefaults('$4'), false);
});

test('execTmux exposes the tmux directory on PATH to spawned servers', async () => {
  let seenEnv = null;
  const service = new TmuxService({
    tmuxPath: '/opt/homebrew/bin/tmux',
    fsImpl: executableFs(['/opt/homebrew/bin/tmux']),
    env: { PATH: '/usr/bin:/bin', HOME: '/Users/x' },
  });
  service.execFileImpl = async () => { seenEnv = service.env; return { stdout: '', stderr: '' }; };

  await service.run(['start-server']);
  assert.equal(seenEnv.PATH.startsWith('/opt/homebrew/bin:'), true);
});

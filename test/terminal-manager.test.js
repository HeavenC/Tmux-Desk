const assert = require('node:assert/strict');
const test = require('node:test');

const { TerminalManager, TERMINAL_FEATURES } = require('../src/main/terminal-manager');

function createFakePty() {
  const listeners = { data: null, exit: null };
  return {
    killed: false,
    writes: [],
    resizes: [],
    disposedListeners: 0,
    onData(listener) {
      listeners.data = listener;
      return { dispose: () => { listeners.data = null; this.disposedListeners += 1; } };
    },
    onExit(listener) {
      listeners.exit = listener;
      return { dispose: () => { listeners.exit = null; this.disposedListeners += 1; } };
    },
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.resizes.push([cols, rows]); },
    kill() { this.killed = true; },
    emitData(data) { listeners.data?.(data); },
    emitExit(event) { listeners.exit?.(event); },
  };
}

function createPtyModule(processes, calls = []) {
  return {
    spawn(file, args, options) {
      calls.push({ file, args, options });
      const process = processes.shift();
      if (!process) throw new Error('no fake pty left');
      return process;
    },
  };
}

test('attaching a new session disposes only the previous attach client', () => {
  const first = createFakePty();
  const second = createFakePty();
  const manager = new TerminalManager({
    ptyModule: createPtyModule([first, second]),
    sendEvent() {},
    tmuxPath: '/opt/homebrew/bin/tmux',
  });
  assert.deepEqual(manager.attach({ sessionId: '$1', cols: 100, rows: 30 }), { terminalId: 1 });
  assert.deepEqual(manager.attach({ sessionId: '$2', cols: 120, rows: 40 }), { terminalId: 2 });
  assert.equal(first.killed, true);
  assert.equal(first.disposedListeners, 2);
  assert.equal(second.killed, false);
});

test('attach uses exact tmux socket arguments and terminal environment', () => {
  const calls = [];
  const manager = new TerminalManager({
    ptyModule: createPtyModule([createFakePty()], calls),
    sendEvent() {},
    tmuxPath: '/custom/tmux',
    socketName: 'isolated',
    env: { PATH: '/bin', TERM: 'old' },
  });
  manager.attach({ sessionId: '$7', cols: 90, rows: 28 });
  assert.deepEqual(calls[0].args, ['-L', 'isolated', '-T', TERMINAL_FEATURES, 'attach-session', '-t', '$7']);
  // xterm.js advertises none of these through its terminfo name, so every one
  // has to be declared here or tmux silently strips the capability.
  assert.deepEqual(TERMINAL_FEATURES.split(','), [
    'clipboard', 'RGB', 'extkeys', 'sync', 'usstyle', 'strikethrough', 'overline',
    'hyperlinks', 'osc7', 'focus', 'cstyle', 'ccolour',
  ]);
  assert.equal(calls[0].file, '/custom/tmux');
  assert.equal(calls[0].options.name, 'xterm-256color');
  assert.equal(calls[0].options.env.TERM, 'xterm-256color');
  assert.equal(calls[0].options.env.COLORTERM, 'truecolor');
  // A server daemonized by this client must find `tmux` on PATH so its plugins
  // (resurrect/continuum) work even when the app launched with a minimal PATH.
  assert.equal(calls[0].options.env.PATH, '/custom:/bin');
  assert.equal(calls[0].options.cols, 90);
  assert.equal(calls[0].options.rows, 28);
});

test('PTY output and exit events are tagged with the terminal id', () => {
  const events = [];
  const pty = createFakePty();
  const manager = new TerminalManager({
    ptyModule: createPtyModule([pty]),
    sendEvent: (channel, payload) => events.push({ channel, payload }),
  });
  manager.attach({ sessionId: '$1', cols: 80, rows: 24 });
  pty.emitData('hello');
  pty.emitExit({ exitCode: 0, signal: 15 });
  assert.deepEqual(events, [
    { channel: 'terminal:data', payload: { terminalId: 1, data: 'hello' } },
    { channel: 'terminal:exit', payload: { terminalId: 1, exitCode: 0, signal: 15 } },
  ]);
});

test('write and resize ignore stale terminal ids', () => {
  const pty = createFakePty();
  const manager = new TerminalManager({ ptyModule: createPtyModule([pty]), sendEvent() {} });
  manager.attach({ sessionId: '$1', cols: 80, rows: 24 });
  assert.equal(manager.write({ terminalId: 99, data: 'ignored' }), false);
  assert.equal(manager.resize({ terminalId: 99, cols: 120, rows: 40 }), false);
  assert.equal(manager.write({ terminalId: 1, data: 'ls\r' }), true);
  assert.equal(manager.resize({ terminalId: 1, cols: 120, rows: 40 }), true);
  assert.deepEqual(pty.writes, ['ls\r']);
  assert.deepEqual(pty.resizes, [[120, 40]]);
});

test('invalid targets, dimensions, and input are rejected', () => {
  const manager = new TerminalManager({ ptyModule: createPtyModule([createFakePty()]), sendEvent() {} });
  assert.throws(() => manager.attach({ sessionId: 'named', cols: 80, rows: 24 }), /会话目标/);
  assert.throws(() => manager.attach({ sessionId: '$1', cols: 0, rows: 24 }), /终端尺寸/);
  manager.attach({ sessionId: '$1', cols: 80, rows: 24 });
  assert.throws(() => manager.write({ terminalId: 1, data: 8 }), /终端输入/);
  assert.throws(() => manager.resize({ terminalId: 1, cols: 5000, rows: 24 }), /终端尺寸/);
});

test('dispose is idempotent and kills only the active attach process', () => {
  const pty = createFakePty();
  const manager = new TerminalManager({ ptyModule: createPtyModule([pty]), sendEvent() {} });
  manager.attach({ sessionId: '$1', cols: 80, rows: 24 });
  manager.dispose();
  manager.dispose();
  assert.equal(pty.killed, true);
  assert.equal(pty.disposedListeners, 2);
  assert.equal(manager.write({ terminalId: 1, data: 'ignored' }), false);
});

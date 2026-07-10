const assert = require('node:assert/strict');
const test = require('node:test');

class FakeTerminal {
  constructor() {
    this.cols = 80;
    this.rows = 24;
  }

  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler(handler) { this.customKeyHandler = handler; }
  onData(handler) { this.dataHandler = handler; return { dispose() {} }; }
  dispatchKeyEvent(event) {
    const handled = this.customKeyHandler(event);
    if (!event.defaultPrevented && event.type === 'keydown' && event.key === 'Enter') {
      this.dataHandler?.('\r');
    }
    return handled;
  }
  dispose() {}
}

class FakeFitAddon {
  fit() {}
}

function loadTerminalView() {
  const xtermPath = require.resolve('@xterm/xterm');
  const fitAddonPath = require.resolve('@xterm/addon-fit');
  const terminalViewPath = require.resolve('../src/renderer/terminal-view');
  const saved = new Map([
    [xtermPath, require.cache[xtermPath]],
    [fitAddonPath, require.cache[fitAddonPath]],
    [terminalViewPath, require.cache[terminalViewPath]],
  ]);

  require.cache[xtermPath] = { id: xtermPath, filename: xtermPath, loaded: true, exports: { Terminal: FakeTerminal } };
  require.cache[fitAddonPath] = { id: fitAddonPath, filename: fitAddonPath, loaded: true, exports: { FitAddon: FakeFitAddon } };
  delete require.cache[terminalViewPath];
  const loaded = require(terminalViewPath);

  for (const [modulePath, cachedModule] of saved) {
    if (cachedModule) require.cache[modulePath] = cachedModule;
    else delete require.cache[modulePath];
  }
  return loaded.TerminalView;
}

function createView() {
  const previousResizeObserver = global.ResizeObserver;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.cancelAnimationFrame = () => {};

  const writes = [];
  const TerminalView = loadTerminalView();
  const view = new TerminalView({
    container: {},
    api: {
      writeTerminal(payload) { writes.push(payload); return Promise.resolve(true); },
      onTerminalData() { return () => {}; },
      onTerminalExit() { return () => {}; },
    },
  });
  return {
    view,
    writes,
    dispose() {
      view.dispose();
      global.ResizeObserver = previousResizeObserver;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

function enterEvent(overrides = {}) {
  return {
    type: 'keydown',
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  };
}

test('Shift+Enter prevents the browser default and writes only one LF byte', () => {
  const { view, writes, dispose } = createView();
  try {
    view.terminalId = 7;
    const event = enterEvent({ shiftKey: true });
    const handled = view.terminal.dispatchKeyEvent(event);
    assert.equal(handled, false);
    assert.deepEqual(writes, [{ terminalId: 7, data: '\n' }]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  } finally {
    dispose();
  }
});

test('ordinary and additionally modified Enter events keep xterm default handling', () => {
  const { view, writes, dispose } = createView();
  try {
    view.terminalId = 7;
    const events = [
      enterEvent(),
      enterEvent({ shiftKey: true, altKey: true }),
      enterEvent({ shiftKey: true, ctrlKey: true }),
      enterEvent({ shiftKey: true, metaKey: true }),
    ];
    for (const event of events) {
      assert.equal(view.terminal.customKeyHandler(event), true);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
    }
    assert.deepEqual(writes, []);
  } finally {
    dispose();
  }
});

test('composing Shift+Enter remains under IME and xterm control', () => {
  const { view, writes, dispose } = createView();
  try {
    view.terminalId = 7;
    for (const event of [
      enterEvent({ shiftKey: true, isComposing: true }),
      enterEvent({ shiftKey: true, keyCode: 229 }),
    ]) {
      assert.equal(view.terminal.customKeyHandler(event), true);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.propagationStopped, false);
    }
    assert.deepEqual(writes, []);
  } finally {
    dispose();
  }
});

test('non-keydown Shift+Enter events are not intercepted', () => {
  const { view, writes, dispose } = createView();
  try {
    view.terminalId = 7;
    for (const event of [
      enterEvent({ type: 'keyup', shiftKey: true }),
      enterEvent({ type: 'keypress', shiftKey: true }),
    ]) {
      assert.equal(view.terminal.customKeyHandler(event), true);
      assert.equal(event.defaultPrevented, false);
    }
    assert.deepEqual(writes, []);
  } finally {
    dispose();
  }
});

test('detached Shift+Enter is consumed without writing to a stale terminal', () => {
  const { view, writes, dispose } = createView();
  try {
    assert.equal(view.terminal.dispatchKeyEvent(enterEvent({ shiftKey: true })), false);
    assert.deepEqual(writes, []);
  } finally {
    dispose();
  }
});

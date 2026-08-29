const assert = require('node:assert/strict');
const test = require('node:test');

class FakeTerminal {
  constructor() {
    this.cols = 80;
    this.rows = 24;
    this.selection = '';
  }

  loadAddon() {}
  open() {}
  attachCustomKeyEventHandler(handler) { this.customKeyHandler = handler; }
  onData(handler) { this.dataHandler = handler; return { dispose() {} }; }
  onSelectionChange(handler) { this.selectionChangeHandler = handler; return { dispose() { this.disposed = true; } }; }
  registerLinkProvider(provider) {
    this.linkProvider = provider;
    return { dispose: () => { this.linkProviderDisposed = true; } };
  }
  hasSelection() { return this.selection.length > 0; }
  getSelection() { return this.selection; }
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

class FakeClipboardAddon {}

class FakeWebglAddon {
  onContextLoss() { return { dispose() {} }; }
  dispose() {}
}

function loadTerminalView() {
  const xtermPath = require.resolve('@xterm/xterm');
  const fitAddonPath = require.resolve('@xterm/addon-fit');
  const clipboardAddonPath = require.resolve('@xterm/addon-clipboard');
  const webglAddonPath = require.resolve('@xterm/addon-webgl');
  const terminalViewPath = require.resolve('../src/renderer/terminal-view');
  const saved = new Map([
    [xtermPath, require.cache[xtermPath]],
    [fitAddonPath, require.cache[fitAddonPath]],
    [clipboardAddonPath, require.cache[clipboardAddonPath]],
    [webglAddonPath, require.cache[webglAddonPath]],
    [terminalViewPath, require.cache[terminalViewPath]],
  ]);

  require.cache[xtermPath] = { id: xtermPath, filename: xtermPath, loaded: true, exports: { Terminal: FakeTerminal } };
  require.cache[fitAddonPath] = { id: fitAddonPath, filename: fitAddonPath, loaded: true, exports: { FitAddon: FakeFitAddon } };
  require.cache[clipboardAddonPath] = {
    id: clipboardAddonPath, filename: clipboardAddonPath, loaded: true, exports: { ClipboardAddon: FakeClipboardAddon },
  };
  require.cache[webglAddonPath] = {
    id: webglAddonPath, filename: webglAddonPath, loaded: true, exports: { WebglAddon: FakeWebglAddon },
  };
  delete require.cache[terminalViewPath];
  const loaded = require(terminalViewPath);

  for (const [modulePath, cachedModule] of saved) {
    if (cachedModule) require.cache[modulePath] = cachedModule;
    else delete require.cache[modulePath];
  }
  return loaded.TerminalView;
}

function createView(apiOverrides = {}) {
  const previousResizeObserver = global.ResizeObserver;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.cancelAnimationFrame = () => {};

  const writes = [];
  const openedFiles = [];
  const TerminalView = loadTerminalView();
  const view = new TerminalView({
    container: { addEventListener() {}, removeEventListener() {} },
    api: {
      writeTerminal(payload) { writes.push(payload); return Promise.resolve(true); },
      onTerminalData() { return () => {}; },
      onTerminalExit() { return () => {}; },
      ...apiOverrides,
    },
    onOpenFile(reference) { openedFiles.push(reference); },
  });
  return {
    view,
    writes,
    openedFiles,
    dispose() {
      view.dispose();
      global.ResizeObserver = previousResizeObserver;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

function fakeBufferLine(text) {
  const cells = [];
  for (const char of Array.from(text)) {
    const width = /[^\u0000-\u00ff]/.test(char) ? 2 : 1;
    cells.push({ getWidth: () => width, getChars: () => char });
    if (width === 2) cells.push({ getWidth: () => 0, getChars: () => '' });
  }
  return {
    length: cells.length,
    getCell: (index) => cells[index],
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

test('Cmd+click opens a detected file reference while an ordinary click is inert', async () => {
  const { view, openedFiles, dispose } = createView();
  try {
    view.terminal.buffer = {
      active: { getLine: () => fakeBufferLine('中 src/app.js:12:3') },
    };
    const links = await new Promise((resolve) => view.terminal.linkProvider.provideLinks(1, resolve));
    assert.equal(links.length, 1);
    assert.equal(links[0].text, 'src/app.js:12:3');
    assert.deepEqual(links[0].range, {
      start: { x: 4, y: 1 },
      end: { x: 18, y: 1 },
    });
    assert.deepEqual(links[0].decorations, { pointerCursor: false, underline: false });

    links[0].activate({ metaKey: false, button: 0 });
    assert.deepEqual(openedFiles, []);

    const event = {
      metaKey: true,
      button: 0,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    links[0].activate(event);
    assert.deepEqual(openedFiles, ['src/app.js']);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);

    links[0].hover({ metaKey: true });
    await Promise.resolve();
    assert.deepEqual(links[0].decorations, { pointerCursor: true, underline: true });
  } finally {
    dispose();
  }
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('the first key after a wheel scroll leaves copy-mode before reaching the pane', async () => {
  const calls = [];
  const { view, writes, dispose } = createView({
    scrollTerminal(payload) { calls.push(['scroll', payload]); return Promise.resolve({ inCopyMode: true }); },
    cancelCopyMode(payload) { calls.push(['cancel', payload]); return Promise.resolve(true); },
  });
  try {
    view.terminalId = 7;
    view.sessionId = '$4';
    // Wheel up on a normal-screen pane: tmux answers that the pane is now
    // parked in copy-mode, where keys would be copy-mode commands, not input.
    view.onWheelCapture({ deltaMode: 1, deltaY: -3, preventDefault() {}, stopPropagation() {} });
    await tick(40);
    assert.equal(view.copyModeActive, true);

    view.sendInput('l');
    view.sendInput('s');
    // Both keys wait behind the cancel instead of being eaten by copy-mode.
    assert.deepEqual(writes, []);
    await tick();
    assert.deepEqual(calls, [
      ['scroll', { sessionId: '$4', lines: -3 }],
      ['cancel', { sessionId: '$4' }],
    ]);
    assert.deepEqual(writes, [{ terminalId: 7, data: 'l' }, { terminalId: 7, data: 's' }]);

    // Gate drained: later keys go straight out, and the mode is only cancelled
    // once per scroll, not per keystroke.
    view.sendInput('!');
    assert.equal(writes.length, 3);
    assert.equal(calls.filter(([kind]) => kind === 'cancel').length, 1);
  } finally {
    dispose();
  }
});

test('scrolling back to the live screen needs no copy-mode cancel', async () => {
  const calls = [];
  const { view, writes, dispose } = createView({
    scrollTerminal() { return Promise.resolve({ inCopyMode: false }); },
    cancelCopyMode(payload) { calls.push(payload); return Promise.resolve(true); },
  });
  try {
    view.terminalId = 7;
    view.sessionId = '$4';
    view.onWheelCapture({ deltaMode: 1, deltaY: 5, preventDefault() {}, stopPropagation() {} });
    await tick(40);
    assert.equal(view.copyModeActive, false);
    view.sendInput('x');
    assert.deepEqual(writes, [{ terminalId: 7, data: 'x' }]);
    assert.deepEqual(calls, []);
  } finally {
    dispose();
  }
});

test('a remote takeover answers scrolls with a bare boolean and never gates input', async () => {
  const { view, writes, dispose } = createView({
    scrollTerminal() { return Promise.resolve(true); },
  });
  try {
    view.terminalId = 7;
    view.sessionId = '$4';
    view.onWheelCapture({ deltaMode: 1, deltaY: -2, preventDefault() {}, stopPropagation() {} });
    await tick(40);
    assert.equal(view.copyModeActive, false);
    view.sendInput('x');
    assert.deepEqual(writes, [{ terminalId: 7, data: 'x' }]);
  } finally {
    dispose();
  }
});

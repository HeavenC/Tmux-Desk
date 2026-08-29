const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const test = require('node:test');

const { collectMatches, gotoLineFor, scanPaneCapture } = require('../src/shared/session-search');
const { TmuxService } = require('../src/main/tmux-service');
const { validateRevealInput, validateSearchOptions } = require('../src/main/ipc');

// Same separator capturePane appends to the capture within one tmux invocation.
const CAPTURE_META = '\u0001tmux-desk-capture-meta\u0001';
const TAB = '\t';

function executableFs(paths = []) {
  const available = new Set(paths);
  return {
    constants: { X_OK: 1 },
    accessSync(path) { if (!available.has(path)) throw new Error(`not executable: ${path}`); },
    statSync() { return { isDirectory: () => true }; },
  };
}

test('a pane capture is scanned newest line first, case-insensitively by default', () => {
  const text = ['boot NEEDLE zero', 'quiet', 'second needle here   ', 'tail'].join('\n');
  assert.deepEqual(scanPaneCapture(text, 'needle'), [
    { index: 2, column: 7, length: 6, preview: 'second needle here' },
    { index: 0, column: 5, length: 6, preview: 'boot NEEDLE zero' },
  ]);
  assert.deepEqual(scanPaneCapture(text, 'needle', { caseSensitive: true }).map((m) => m.index), [2]);
  assert.deepEqual(scanPaneCapture(text, 'needle', { maxPerPane: 1 }).map((m) => m.index), [2]);
  assert.deepEqual(scanPaneCapture(text, '   '), []);
});

test('goto-line offsets count from the start of the capture, never its length', () => {
  // Measured on tmux 3.7b: goto-line counts rows up from the live bottom, and
  // capture-pane drops a trailing row, so a length-based formula lands one off.
  const geometry = { historySize: 482, paneHeight: 24, requestedLines: 20000 };
  assert.equal(gotoLineFor(geometry, 503), 2);
  assert.equal(gotoLineFor(geometry, 505), 0);
  // History deeper than the requested window: the capture starts mid-history.
  assert.equal(gotoLineFor({ historySize: 50000, paneHeight: 24, requestedLines: 20000 }, 0), 20023);
  assert.equal(gotoLineFor(geometry, 99999), 0);
});

test('the global cap stops a broad query from dragging every match into the UI', () => {
  const panes = [
    { pane: { paneId: '%1' }, matches: [{ index: 1 }, { index: 2 }] },
    { pane: { paneId: '%2' }, matches: [{ index: 3 }, { index: 4 }] },
  ];
  assert.deepEqual(collectMatches(panes, { maxTotal: 3 }), {
    truncated: true,
    results: [
      { paneId: '%1', index: 1 }, { paneId: '%1', index: 2 }, { paneId: '%2', index: 3 },
    ],
  });
  assert.equal(collectMatches(panes, { maxTotal: 10 }).truncated, false);
});

function searchService(handler) {
  const calls = [];
  const service = new TmuxService({
    tmuxPath: '/tmp/tmux',
    fsImpl: executableFs(['/tmp/tmux']),
    execFileImpl: async (file, args) => {
      calls.push(args);
      return { stdout: handler(args) ?? '', stderr: '' };
    },
  });
  return { service, calls };
}

test('searchSessions captures each pane with its geometry in one invocation', async () => {
  const paneRecord = ['$1', 'api', '@2', '0', 'build', '%3', '1', '1', 'node', '482', '24'].join(TAB);
  const { service, calls } = searchService((args) => {
    if (args[0] === 'list-panes') return `${paneRecord}\n`;
    if (args[0] === 'capture-pane') {
      const lines = new Array(506).fill('quiet');
      lines[503] = 'boom: NEEDLE in the log';
      return `${lines.join('\n')}\n${CAPTURE_META}482${TAB}24`;
    }
    return '';
  });

  const found = await service.searchSessions('needle');
  assert.equal(found.panes, 1);
  assert.equal(found.truncated, false);
  assert.deepEqual(found.results, [{
    sessionId: '$1', sessionName: 'api', windowId: '@2', windowIndex: 0, windowName: 'build',
    paneId: '%3', paneIndex: 1, paneActive: true, command: 'node', historySize: 482, paneHeight: 24,
    column: 6, length: 6, preview: 'boom: NEEDLE in the log', gotoLine: 2,
  }]);
  const capture = calls.find((args) => args[0] === 'capture-pane');
  assert.deepEqual(capture.slice(0, 7), ['capture-pane', '-p', '-S', '-20000', '-t', '%3', ';']);
  assert.equal(capture.includes('-J'), false, 'joining wrapped lines would break the row mapping');
  assert.equal((await service.searchSessions('   ')).panes, 0);
});

test('revealMatch corrects for new output, snaps to the line, then highlights the query', async () => {
  const { service, calls } = searchService((args) => {
    if (args[0] === 'display-message' && args.includes('#{history_size}')) return '520\n';
    if (args[0] === 'display-message') return 'boom: NEEDLE in the log\n';
    return '';
  });

  const landed = await service.revealMatch({
    windowId: '@2', paneId: '%3', gotoLine: 2, historySize: 482,
    preview: 'boom: NEEDLE in the log', query: 'needle',
  });
  assert.deepEqual(landed, { cursorLine: 'boom: NEEDLE in the log', exact: true });
  assert.deepEqual(calls[1], ['select-window', '-t', '@2', ';', 'select-pane', '-t', '%3']);
  assert.deepEqual(calls.find((args) => args[0] === 'copy-mode'), [
    'copy-mode', '-e', '-t', '%3',
    // 2 + (520 - 482): the rows printed since the search pushed the match up.
    ';', 'send-keys', '-t', '%3', '-X', 'goto-line', '40',
    ';', 'send-keys', '-t', '%3', '-X', 'search-backward-text', '--', 'boom: NEEDLE in the log',
    ';', 'send-keys', '-t', '%3', '-X', 'search-forward-text', '--', 'needle',
  ]);
});

test('a row that no longer holds the query falls back to the newest match', async () => {
  const { service, calls } = searchService((args) => {
    if (args[0] === 'display-message' && args.includes('#{history_size}')) return '1000\n';
    if (args[0] === 'display-message') return 'something else entirely\n';
    return '';
  });

  const landed = await service.revealMatch({
    windowId: '@2', paneId: '%3', gotoLine: 2, historySize: 900, preview: 'gone', query: 'needle',
  });
  assert.equal(landed.exact, false);
  assert.deepEqual(calls.find((args) => args.includes('cancel')), ['send-keys', '-t', '%3', '-X', 'cancel']);
  assert.deepEqual(calls.at(-2), [
    'copy-mode', '-e', '-t', '%3', ';', 'send-keys', '-t', '%3', '-X', 'search-backward-text', '--', 'needle',
  ]);
});

test('search input is shape-checked before any tmux call', () => {
  assert.deepEqual(validateSearchOptions({ query: '  boom  ' }), {
    query: 'boom', caseSensitive: false, historyLines: 20000, maxPerPane: 20, maxTotal: 200,
  });
  assert.equal(validateSearchOptions({ query: 'x', historyLines: 5 }).historyLines, 100);
  assert.equal(validateSearchOptions({ query: 'x', maxTotal: 99999 }).maxTotal, 1000);
  assert.throws(() => validateSearchOptions({ query: '   ' }), /搜索内容无效/);
  assert.throws(() => validateSearchOptions({ query: 'x'.repeat(513) }), /搜索内容无效/);

  assert.deepEqual(validateRevealInput({
    windowId: '@2', paneId: '%3', gotoLine: 7, historySize: 12, query: 'boom', preview: 'a line',
  }), { windowId: '@2', paneId: '%3', gotoLine: 7, historySize: 12, query: 'boom', preview: 'a line' });
  assert.throws(() => validateRevealInput({ windowId: '@2', paneId: '$3', gotoLine: 1, query: 'x' }), /目标无效/);
  assert.throws(() => validateRevealInput({ windowId: '@2', paneId: '%3', gotoLine: -1, query: 'x' }), /搜索结果无效/);
});

test('the renderer ships the global search panel the shortcut opens', async () => {
  const html = await readFile(join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  for (const id of ['globalSearch', 'globalSearchInput', 'globalSearchResults', 'globalSearchStatus']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  const app = await readFile(join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  // Cmd+F belongs to the terminal search now; the session filter keeps Cmd+Shift+F.
  assert.match(app, /if \(event\.shiftKey \|\| isRemoteActive\(\)\) focusSessionSearch\(\);/);
  assert.match(app, /else openGlobalSearch\(\);/);
});

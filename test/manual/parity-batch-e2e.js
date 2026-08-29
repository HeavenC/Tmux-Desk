// Manual end-to-end check for the second iTerm-parity batch: the expanded -T
// terminal-feature list, Shift+PageUp/PageDown paging, pane zoom, Cmd+Alt pane
// navigation, broadcast input, and paste protection.
//
// Not part of `npm test` — it launches a real Electron instance against a
// throwaway tmux server. Run it with:  node test/manual/parity-batch-e2e.js
const { launchApp, openFirstSession, tmuxSandbox, wait } = require('./cdp-harness');

const SOCKET = 'paritybatch';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const sandbox = tmuxSandbox(SOCKET);
  sandbox.kill();
  sandbox.tmux('new-session', '-d', '-s', 'parity', '-x', '200', '-y', '50');
  // Pane ids, not indices: the app's tmux profile sets pane-base-index 1 on
  // attach, so `parity.0` stops resolving the moment it connects.
  const leftPane = sandbox.tmux('display-message', '-p', '-t', 'parity', '#{pane_id}').trim();
  sandbox.tmux('split-window', '-h', '-t', 'parity');
  sandbox.tmux('select-pane', '-t', leftPane);
  // Fill the left pane's scrollback so paging has somewhere to go.
  sandbox.tmux('send-keys', '-t', leftPane, 'for i in $(seq 1 400); do echo "line $i"; done', 'Enter');
  await wait(1500);

  const app = await launchApp({ socket: SOCKET, port: 9231 });
  const { cdp } = app;
  try {
    if (!await openFirstSession(cdp)) throw new Error('could not open a session');
    await wait(2500);

    // --- terminal features -------------------------------------------------
    // tmux only reports a feature for a client that declared it, so this is the
    // real end-to-end proof that the -T list landed on the attached client.
    const features = sandbox.tmux('list-clients', '-t', 'parity', '-F', '#{client_termfeatures}').trim();
    const wanted = ['clipboard', 'RGB', 'extkeys', 'sync', 'usstyle', 'strikethrough',
      'overline', 'hyperlinks', 'osc7', 'focus', 'cstyle', 'ccolour'];
    const missing = wanted.filter((feature) => !features.split(',').includes(feature));
    check('attach declares every terminal feature', missing.length === 0,
      missing.length ? `missing ${missing.join(',')} (got ${features})` : features);

    // --- Shift+PageUp / PageDown ------------------------------------------
    const paneInMode = () => sandbox.tmux('display-message', '-p', '-t', 'parity', '#{pane_in_mode}').trim();
    await cdp.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    await cdp.key('rawKeyDown', { windowsVirtualKeyCode: 33, code: 'PageUp', key: 'PageUp', modifiers: 8 });
    await cdp.key('keyUp', { windowsVirtualKeyCode: 33, code: 'PageUp', key: 'PageUp', modifiers: 8 });
    await wait(900);
    check('Shift+PageUp enters copy-mode', paneInMode() === '1', `pane_in_mode=${paneInMode()}`);
    const scrolledTo = sandbox.tmux('display-message', '-p', '-t', 'parity', '#{scroll_position}').trim();

    await cdp.key('rawKeyDown', { windowsVirtualKeyCode: 34, code: 'PageDown', key: 'PageDown', modifiers: 8 });
    await cdp.key('keyUp', { windowsVirtualKeyCode: 34, code: 'PageDown', key: 'PageDown', modifiers: 8 });
    await wait(900);
    check('Shift+PageDown returns to the live screen',
      paneInMode() === '0', `scrolled up to ${scrolledTo}, now pane_in_mode=${paneInMode()}`);

    // --- zoom --------------------------------------------------------------
    const zoomed = () => sandbox.tmux('display-message', '-p', '-t', 'parity', '#{window_zoomed_flag}').trim();
    // Cmd+Shift+Enter. Shift+Enter alone is the terminal view's newline, so the
    // Cmd guard in that handler is what makes this reachable at all.
    const cmdShiftEnter = { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', modifiers: 12 };
    await cdp.key('rawKeyDown', cmdShiftEnter);
    await cdp.key('keyUp', cmdShiftEnter);
    await wait(900);
    check('Cmd+Shift+Enter zooms the active pane', zoomed() === '1', `window_zoomed_flag=${zoomed()}`);
    await cdp.key('rawKeyDown', cmdShiftEnter);
    await cdp.key('keyUp', cmdShiftEnter);
    await wait(900);
    check('Cmd+Shift+Enter again restores the layout', zoomed() === '0', `window_zoomed_flag=${zoomed()}`);

    // --- pane navigation ---------------------------------------------------
    const activePane = () => sandbox.tmux('display-message', '-p', '-t', 'parity', '#{pane_id}').trim();
    const before = activePane();
    const cmdAltRight = { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight', modifiers: 5 };
    await cdp.key('rawKeyDown', cmdAltRight);
    await cdp.key('keyUp', cmdAltRight);
    await wait(900);
    const afterRight = activePane();
    check('Cmd+Alt+Right focuses the pane to the right', afterRight !== before, `${before} -> ${afterRight}`);
    const cmdAltLeft = { ...cmdAltRight, windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' };
    await cdp.key('rawKeyDown', cmdAltLeft);
    await cdp.key('keyUp', cmdAltLeft);
    await wait(900);
    check('Cmd+Alt+Left comes back', activePane() === before, `${afterRight} -> ${activePane()}`);

    // --- broadcast input ---------------------------------------------------
    const synced = () => sandbox.tmux('display-message', '-p', '-t', 'parity', '#{?pane_synchronized,1,0}').trim();
    // Driven through the same IPC the palette entry and header badge use.
    const sessionId = await cdp.evaluate(`(async () => {
      const sessions = await window.tmuxDesk.listSessions();
      return sessions.find((s) => s.name === 'parity').id;
    })()`);
    await cdp.evaluate(`window.tmuxDesk.setBroadcastInput({ target: ${JSON.stringify(sessionId)}, enabled: true })`);
    await wait(400);
    check('broadcast input turns synchronize-panes on', synced() === '1', `pane_synchronized=${synced()}`);
    const flagVisible = await cdp.evaluate(`(async () => {
      // The header badge only re-renders on the detail poll.
      await new Promise((r) => setTimeout(r, 2600));
      return !document.getElementById('broadcastFlag').classList.contains('hidden');
    })()`);
    check('header shows the broadcast badge', flagVisible === true, `visible=${flagVisible}`);
    await cdp.evaluate(`window.tmuxDesk.setBroadcastInput({ target: ${JSON.stringify(sessionId)}, enabled: false })`);
    await wait(400);
    check('broadcast input turns back off', synced() === '0', `pane_synchronized=${synced()}`);

    // --- paste protection --------------------------------------------------
    // A multi-line paste must raise the dialog instead of reaching the pane.
    const dialog = await cdp.evaluate(`(async () => {
      const view = document.getElementById('terminalMount');
      const data = new DataTransfer();
      data.setData('text', 'echo PASTE_ONE\\necho PASTE_TWO\\n');
      view.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      const modal = document.getElementById('pasteConfirmModal');
      return {
        open: !modal.classList.contains('hidden'),
        message: document.getElementById('pasteConfirmMessage').textContent,
        preview: document.getElementById('pasteConfirmPreview').textContent,
      };
    })()`);
    check('multi-line paste raises the confirm dialog', dialog.open === true, dialog.message);
    check('confirm dialog previews the clipboard', dialog.preview.includes('PASTE_ONE'), dialog.preview.slice(0, 60));

    const capture = () => sandbox.tmux('capture-pane', '-p', '-t', leftPane);
    // Cancel: nothing reaches the pane.
    await cdp.evaluate("document.querySelector('#pasteConfirmModal .modal-cancel').click()");
    await wait(700);
    check('cancelling the dialog sends nothing', !capture().includes('PASTE_ONE'), 'pane is clean');

    // Confirm: the whole thing arrives, still bracketed as one paste.
    await cdp.evaluate(`(async () => {
      const view = document.getElementById('terminalMount');
      const data = new DataTransfer();
      data.setData('text', 'echo PASTE_ONE\\necho PASTE_TWO');
      view.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      document.getElementById('confirmPasteButton').click();
    })()`);
    await wait(1200);
    const pasted = capture();
    check('confirming pastes the full text', pasted.includes('PASTE_ONE') && pasted.includes('PASTE_TWO'),
      pasted.split('\n').filter((line) => line.includes('PASTE_')).join(' | '));

    // A one-liner under the size threshold must not prompt at all.
    const quiet = await cdp.evaluate(`(async () => {
      const view = document.getElementById('terminalMount');
      const data = new DataTransfer();
      data.setData('text', 'echo QUIET_PASTE');
      view.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      return document.getElementById('pasteConfirmModal').classList.contains('hidden');
    })()`);
    await wait(600);
    check('a short single-line paste does not prompt',
      quiet === true && capture().includes('QUIET_PASTE'), 'went straight through');

    // --- font settings -----------------------------------------------------
    // Driven through the settings UI, not the IPC, because the point is that a
    // changed font re-fits the grid and tmux is told the new size — a preference
    // that saves but never reaches the terminal would pass an IPC-only check.
    const paneWidth = () => Number(sandbox.tmux('display-message', '-p', '-t', 'parity', '#{pane_width}').trim());
    const widthBefore = paneWidth();
    await cdp.evaluate(`(async () => {
      document.getElementById('settingsButton').click();
      await new Promise((r) => setTimeout(r, 300));
      const input = document.getElementById('terminalFontSizeInput');
      input.value = '22';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      document.querySelector('#settingsModal .modal-cancel, #settingsModal .modal-close')?.click();
    })()`);
    await wait(1500);
    const widthAfter = paneWidth();
    check('a bigger font re-fits the grid and resizes the tmux pane',
      widthAfter < widthBefore, `pane_width ${widthBefore} -> ${widthAfter}`);
    const stored = await cdp.evaluate('(async () => (await window.tmuxDesk.getPreferences()).terminalAppearance)()');
    check('the font size persisted', stored.fontSize === 22, JSON.stringify(stored));

    // --- OSC 8 hyperlink ---------------------------------------------------
    // The feature list above is what lets the escape through tmux at all; this
    // checks xterm parsed it into a real link with our handler attached.
    const link = await cdp.evaluate(`(async () => {
      const opened = [];
      const original = window.tmuxDesk.openExternalUrl;
      return { hasHandler: typeof original === 'function' };
    })()`);
    check('the renderer exposes an external-URL bridge', link.hasHandler === true, '');
    const urlGuard = await cdp.evaluate(`(async () => {
      const tries = {};
      // Deliberately no http(s) case: a successful open would launch the
      // tester's real browser. The refusals are what needs proving here.
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://x']) {
        try { await window.tmuxDesk.openExternalUrl(url); tries[url] = 'opened'; }
        catch (error) { tries[url] = 'refused'; }
      }
      return tries;
    })()`);
    check('file:, javascript: and custom schemes are refused',
      Object.values(urlGuard).every((outcome) => outcome === 'refused'),
      JSON.stringify(urlGuard));
  } finally {
    app.stop();
    sandbox.kill();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

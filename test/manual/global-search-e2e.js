// Manual end-to-end check of cross-session search (Cmd+F) in the REAL app:
//   node test/manual/global-search-e2e.js
//
// Checks:
//   1. the panel finds a line that lives in a session the app is NOT attached
//      to (the whole point of searching tmux rather than the visible terminal);
//   2. Enter switches to that session and parks copy-mode on that exact row;
//   3. the first keystroke afterwards leaves copy-mode instead of being eaten.
const { launchApp, openFirstSession, tmuxSandbox, wait } = require('./cdp-harness');

const SOCK = 'desksearch';
const { tmux, quiet, kill } = tmuxSandbox(SOCK);

const paneOf = (session) => tmux('display-message', '-p', '-t', session, '#{pane_id}').trim();
const settled = async (session, marker) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (tmux('capture-pane', '-p', '-t', session).split('\n').some((line) => line.trim() === marker)) return true;
    await wait(500);
  }
  return false;
};

(async () => {
  kill();
  tmux('new-session', '-d', '-s', 'first', '-x', '120', '-y', '30');
  tmux('new-session', '-d', '-s', 'second', '-x', '120', '-y', '30');
  await wait(1500); // send-keys before the shell is up is silently swallowed
  tmux('send-keys', '-t', 'first', 'clear; echo "first session is quiet"; echo SETTLED', 'Enter');
  tmux('send-keys', '-t', 'second',
    'clear; for i in $(seq 1 900); do echo "second row $i"; done; echo "PARITY_MARKER_42 buried here"; echo SETTLED', 'Enter');
  console.log('first settled:', await settled('first', 'SETTLED'));
  console.log('second settled:', await settled('second', 'SETTLED'));

  const { cdp, stop } = await launchApp({ socket: SOCK, port: 9224 });
  console.log('opened a session:', await openFirstSession(cdp));
  await wait(2500);
  const attached = await cdp.evaluate('document.querySelector(".session-item.active .session-name")?.textContent || ""');
  console.log('attached to:', JSON.stringify(attached));

  // 1. search for a line that only exists in the OTHER session
  await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }))');
  await wait(400);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('globalSearchInput');
    input.value = 'PARITY_MARKER_42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(1200);
  const rows = await cdp.evaluate(`[...document.querySelectorAll('.search-result')].map((row) => row.textContent.trim())`);
  console.log(`results: ${rows.length}`);
  for (const row of rows.slice(0, 3)) console.log(`  ${row.slice(0, 90)}`);
  console.log('status:', await cdp.evaluate('document.getElementById("globalSearchStatus").textContent'));

  // 2. Enter jumps: session switches, and copy-mode parks on the matched row
  await cdp.evaluate(`document.getElementById('globalSearchInput')
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(2500);
  const nowAttached = await cdp.evaluate('document.querySelector(".session-item.active .session-name")?.textContent || ""');
  const pane = paneOf('second');
  const cursor = tmux('display-message', '-p', '-t', pane, '#{pane_in_mode} #{copy_cursor_line}').trim();
  console.log('after Enter -> attached:', JSON.stringify(nowAttached));
  console.log('after Enter -> tmux:', JSON.stringify(cursor));
  console.log('landed on the match:', cursor.includes('PARITY_MARKER_42'));

  // 3. typing leaves copy-mode instead of being swallowed
  await cdp.evaluate(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await cdp.key('keyDown', { text: 'x', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
  await cdp.key('keyUp', { key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
  await wait(1200);
  console.log('after a keystroke -> pane_in_mode:',
    tmux('display-message', '-p', '-t', pane, '#{pane_in_mode}').trim(), '(0 = back to the live screen)');

  // 4. Cmd+K clears screen AND scrollback; right-click opens the terminal menu
  console.log('history before Cmd+K:', tmux('display-message', '-p', '-t', pane, '#{history_size}').trim());
  await cdp.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }))');
  await wait(1500);
  console.log('history after Cmd+K :', tmux('display-message', '-p', '-t', pane, '#{history_size}').trim(),
    '| non-empty screen rows:', tmux('capture-pane', '-p', '-t', pane).split('\n').filter((line) => line.trim()).length);

  const grid = await cdp.evaluate(`(() => {
    const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grid.x, y: grid.y, button: 'right', buttons: 2, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grid.x, y: grid.y, button: 'right', buttons: 0, clickCount: 1 });
  await wait(600);
  console.log('context menu:', await cdp.evaluate(`(() => {
    const menu = document.getElementById('contextMenu');
    if (!menu || menu.classList.contains('hidden')) return 'not shown';
    return [...menu.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | ');
  })()`));

  console.log('panes on the sandbox server:',
    tmux('list-panes', '-a', '-F', '#{session_name}:#{pane_id}').trim().split('\n').join(' '));
  stop();
  await wait(500);
  kill();
})().catch(async (error) => {
  console.error('FAILED', error);
  kill();
  process.exit(1);
});

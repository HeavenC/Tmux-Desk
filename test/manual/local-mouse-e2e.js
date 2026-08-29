// Manual end-to-end check of the localMouse profile in the REAL app (not part
// of `npm test` — it launches Electron and needs a display):
//   node test/manual/local-mouse-e2e.js
//
// Checks:
//   1. double-click selects a word locally (and copies it) instead of pushing
//      tmux into copy-mode;
//   2. clicking another split focuses it through select-pane;
//   3. dragging the split border resizes it through resize-pane.
// Runs against a throwaway tmux socket and preferences file.
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMUX = '/opt/homebrew/bin/tmux';
const SOCK = 'deskui';
const PORT = 9223;
const tmux = (...a) => execFileSync(TMUX, ['-L', SOCK, '-f', '/dev/null', ...a], { encoding: 'utf8' });
const quiet = (...a) => { try { return tmux(...a); } catch (e) { return 'ERR ' + (e.stderr || e.message); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b))); })
    .on('error', reject);
});

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.on('message', (raw) => {
    const msg = JSON.parse(raw); const p = this.pending.get(msg.id);
    if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  }
  mouse(type, x, y, extra = {}) {
    const idle = type === 'mouseMoved' && !extra.buttons;
    return this.send('Input.dispatchMouseEvent', {
      type, x, y, button: idle ? 'none' : 'left', buttons: idle ? 0 : 1, clickCount: 1, ...extra,
    });
  }
}

(async () => {
  quiet('kill-server');
  tmux('new-session', '-d', '-s', 'mouse-test', '-x', '180', '-y', '45');
  tmux('split-window', '-h', '-t', 'mouse-test');
  const panes = () => tmux('list-panes', '-t', 'mouse-test', '-F', '#{pane_id} #{pane_left} #{pane_width} #{pane_active}')
    .trim().split('\n').map((line) => line.split(' '));
  const leftPane = panes()[0][0];
  tmux('select-pane', '-t', leftPane);
  tmux('send-keys', '-t', leftPane, 'clear; printf "UNIQUEWORD12345 tail\\n"', 'Enter');
  await wait(500);

  const prefs = path.join(os.tmpdir(), `tmux-desk-e2e-${Date.now()}.json`);
  const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, TMUX_DESK_SOCKET: SOCK, TMUX_DESK_PREFERENCES_FILE: prefs },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => { const s = String(d); if (/Error|error/.test(s)) process.stderr.write(`[app] ${s}`); });

  let page = null;
  for (let i = 0; i < 40 && !page; i += 1) {
    await wait(500);
    try { page = (await getJson(`http://127.0.0.1:${PORT}/json`)).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch {}
  }
  if (!page) throw new Error('renderer page never appeared');
  const cdp = new Cdp(new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false }));
  await new Promise((resolve) => cdp.ws.on('open', resolve));
  await cdp.send('Runtime.enable');
  await cdp.send('Input.enable').catch(() => {});
  await wait(1500);

  let opened = 'no session row';
  for (let attempt = 0; attempt < 20 && opened !== 'clicked'; attempt += 1) {
    await wait(500);
    opened = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.session-item .session-main')][0];
      if (!row) return 'rows=' + document.querySelectorAll('.session-item').length
        + ' list=' + (document.getElementById('sessionList')?.textContent || '').slice(0, 80);
      row.click();
      return 'clicked';
    })()`);
  }
  console.log('open session:', opened);
  await wait(3000);

  const grid = await cdp.evaluate(`(() => {
    const el = document.querySelector('.xterm-screen');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const rows = document.querySelectorAll('.xterm-rows > div').length;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  if (!grid) throw new Error('terminal never rendered');
  const [cols, rows] = tmux('display-message', '-p', '-t', 'mouse-test', '#{window_width} #{window_height}').trim().split(' ').map(Number);
  const cellW = grid.width / cols;
  const cellH = grid.height / rows;
  console.log(`grid: ${cols}x${rows} cells of ${cellW.toFixed(2)}x${cellH.toFixed(2)}px`);

  // --- 1. double-click a word in the left pane ---
  const capture = tmux('capture-pane', '-p', '-t', leftPane).split('\n');
  const lineIndex = capture.findIndex((line) => line.includes('UNIQUEWORD12345'));
  const colIndex = capture[lineIndex].indexOf('UNIQUEWORD12345') + 5;
  const x = grid.left + (colIndex + 0.5) * cellW;
  const y = grid.top + (lineIndex + 0.5) * cellH;
  execFileSync('/bin/sh', ['-c', 'printf CLIPBOARD_UNSET | pbcopy']);
  await cdp.mouse('mousePressed', x, y, { clickCount: 1 });
  await cdp.mouse('mouseReleased', x, y, { clickCount: 1 });
  await cdp.mouse('mousePressed', x, y, { clickCount: 2 });
  await cdp.mouse('mouseReleased', x, y, { clickCount: 2 });
  await wait(900);
  const clip = execFileSync('/bin/sh', ['-c', 'pbpaste'], { encoding: 'utf8' });
  console.log('double-click -> clipboard:', JSON.stringify(clip));
  console.log('double-click -> tmux pane_in_mode:',
    tmux('display-message', '-p', '-t', 'mouse-test', '#{pane_in_mode}').trim(), '(0 = tmux never saw the mouse)');

  // --- 2. click the right split ---
  const right = panes().find((p) => Number(p[1]) > 0);
  const clickX = grid.left + (Number(right[1]) + 5) * cellW;
  const clickY = grid.top + 3.5 * cellH;
  await cdp.mouse('mousePressed', clickX, clickY, { clickCount: 1 });
  await cdp.mouse('mouseReleased', clickX, clickY, { clickCount: 1 });
  await wait(900);
  console.log('click right split -> active pane:',
    tmux('display-message', '-p', '-t', 'mouse-test', '#{pane_id}').trim(), `(expected ${right[0]})`);

  // --- 3. drag the divider left by 20 columns ---
  const before = tmux('list-panes', '-t', 'mouse-test', '-F', '#{pane_id}=#{pane_width}').trim().replace(/\n/g, ' ');
  const dividerX = grid.left + (Number(right[1]) - 0.5) * cellW;
  const dividerY = grid.top + 10 * cellH;
  await cdp.mouse('mouseMoved', dividerX, dividerY, { buttons: 0 });
  await wait(200);
  const cursor = await cdp.evaluate(`document.getElementById('terminalMount').style.cursor`);
  const synthetic = await cdp.evaluate(`(() => {
    const mount = document.getElementById('terminalMount');
    mount.dispatchEvent(new MouseEvent('mousemove', { clientX: ${dividerX}, clientY: ${dividerY}, bubbles: true }));
    return mount.style.cursor || '(empty)';
  })()`);
  console.log('synthetic mousemove on the divider -> cursor:', synthetic);
  await cdp.mouse('mousePressed', dividerX, dividerY);
  for (let step = 1; step <= 10; step += 1) {
    await cdp.mouse('mouseMoved', dividerX - step * 2 * cellW, dividerY, { buttons: 1 });
    await wait(60);
  }
  await cdp.mouse('mouseReleased', dividerX - 20 * cellW, dividerY);
  await wait(1200);
  const after = tmux('list-panes', '-t', 'mouse-test', '-F', '#{pane_id}=#{pane_width}').trim().replace(/\n/g, ' ');
  console.log(`divider hover cursor: ${JSON.stringify(cursor)}`);
  console.log(`pane widths: before [${before}] after [${after}]`);

  app.kill();
  await wait(500);
  quiet('kill-server');
  fs.rmSync(prefs, { force: true });
})().catch(async (error) => { console.error('FAILED', error); quiet('kill-server'); process.exit(1); });

// Shared plumbing for the manual end-to-end scripts in this directory: a
// throwaway tmux server, a real Electron instance pointed at it, and a thin CDP
// client to drive the renderer. Nothing here runs under `npm test` — these
// scripts need a display and a real tmux.
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const TMUX = '/opt/homebrew/bin/tmux';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

// -f /dev/null on every call: a server started without it reads the developer's
// own ~/.tmux.conf, and tmux-continuum then restores real sessions into the
// sandbox socket and breaks every count in the script.
function tmuxSandbox(socket) {
  const tmux = (...args) => execFileSync(TMUX, ['-L', socket, '-f', '/dev/null', ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const quiet = (...args) => { try { return tmux(...args); } catch (error) { return `ERR ${error.stderr || error.message}`; } };
  return { tmux, quiet, kill: () => quiet('kill-server') };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'eval failed');
    }
    return result.result.value;
  }

  // button:'none' matters for a plain hover — sending button:'left' with
  // buttons:0 delivers clicks and drags fine but never triggers mousemove
  // handlers, which reads as "my hover code is broken" when it is not.
  mouse(type, x, y, extra = {}) {
    const idle = type === 'mouseMoved' && !extra.buttons;
    return this.send('Input.dispatchMouseEvent', {
      type, x, y, button: idle ? 'none' : 'left', buttons: idle ? 0 : 1, clickCount: 1, ...extra,
    });
  }

  key(type, params = {}) {
    return this.send('Input.dispatchKeyEvent', { type, ...params });
  }
}

// Launch the app against the sandbox socket with a throwaway preferences file,
// then attach CDP to its renderer.
//
// The preferences file gets its own fresh directory on purpose: session-snapshot
// writes session-snapshot.json NEXT TO it, and a shared temp dir would let one
// run's snapshot be restored into the next run's sandbox — extra sessions appear
// out of nowhere and every count in the script is off.
// `preferences` (optional) seeds that file before launch — tags, saved remote
// hosts and so on — instead of starting from a blank profile.
async function launchApp({ socket, port = 9223, preferences: seed = null }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-e2e-'));
  const preferences = path.join(home, 'preferences.json');
  if (seed) fs.writeFileSync(preferences, JSON.stringify(seed));
  const app = spawn('npx', ['electron', '.', `--remote-debugging-port=${port}`], {
    env: { ...process.env, TMUX_DESK_SOCKET: socket, TMUX_DESK_PREFERENCES_FILE: preferences },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/Error|error/.test(text)) process.stderr.write(`[app] ${text}`);
  });

  let page = null;
  for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
    await wait(500);
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`);
      page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
    } catch {}
  }
  if (!page) {
    app.kill();
    throw new Error('renderer page never appeared');
  }
  const cdp = new Cdp(new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false }));
  await new Promise((resolve) => cdp.ws.on('open', resolve));
  await cdp.send('Runtime.enable');
  await cdp.send('Input.enable').catch(() => {});
  return {
    cdp,
    stop() {
      app.kill();
      fs.rmSync(home, { force: true, recursive: true });
    },
  };
}

// Click the first session row; the app opens with no lastSession preference, so
// the list needs a moment to arrive before it can be clicked.
async function openFirstSession(cdp) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(500);
    const state = await cdp.evaluate(`(() => {
      const row = document.querySelector('.session-item .session-main');
      if (!row) return 'waiting';
      row.click();
      return 'clicked';
    })()`);
    if (state === 'clicked') return true;
  }
  return false;
}

module.exports = { Cdp, TMUX, getJson, launchApp, openFirstSession, tmuxSandbox, wait };

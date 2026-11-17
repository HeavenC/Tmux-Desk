// The desktop file panel against a REMOTE source: the listing must come from
// the remote host (not this disk), a file must download into the downloads dir,
// and files dropped on a folder row / the panel must upload into that folder on
// the remote host. Then back on the local source, a drop is a plain copy.
//
// Run: node test/manual/remote-files-e2e.js   (starts a real Electron instance)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchApp, openFirstSession, tmuxSandbox, wait } = require('./cdp-harness');

const SOCKET = 'filesui';
const WEB_PORT = 8902;
const WEB_TOKEN = 'filestoken';

function startUpstream() {
  const server = spawn(process.execPath, ['src/server/index.js'], {
    env: {
      ...process.env,
      TMUX_DESK_SOCKET: SOCKET,
      TMUX_DESK_WEB_TOKEN: WEB_TOKEN,
      TMUX_DESK_WEB_PORT: String(WEB_PORT),
      TMUX_DESK_PREFERENCES_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-up-')), 'preferences.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (chunk) => process.stderr.write(`[upstream] ${chunk}`));
  return server;
}

async function rowPoint(cdp, selector) {
  return cdp.evaluate(`(() => {
    const el = ${selector};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
}

async function drop(cdp, point, files) {
  const data = { items: [], files, dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data });
  await wait(120);
  const hint = await cdp.evaluate(`document.getElementById('fbDropText').textContent`);
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data });
  return hint;
}

const treeNames = (cdp) => cdp.evaluate(`[...document.querySelectorAll('#fbTree > .fb-node > .fb-row .fb-name')].map((n) => n.textContent)`);

async function waitFor(cdp, expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await cdp.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-files-e2e-'));
  const project = path.join(scratch, 'remote-project');
  const downloads = path.join(scratch, 'downloads');
  const outside = path.join(scratch, 'from-this-mac');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(downloads);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'README.md'), '# remote readme\n');
  fs.writeFileSync(path.join(project, 'src', 'app.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(outside, 'drop on src.txt'), 'into-src');
  const big = Buffer.alloc(6 * 1024 * 1024, 9);
  fs.writeFileSync(path.join(outside, 'big.bin'), big);

  const sandbox = tmuxSandbox(SOCKET);
  sandbox.kill();
  sandbox.tmux('new-session', '-d', '-s', 'proj', '-c', project);
  process.env.TMUX_DESK_DOWNLOADS_DIR = downloads;

  const upstream = startUpstream();
  await wait(1500);
  const app = await launchApp({ socket: SOCKET, port: 9242 });
  const { cdp } = app;
  const results = [];
  const check = (label, actual, expected) => results.push([label, actual, expected]);
  try {
    await cdp.evaluate(`window.tmuxDesk.addRemote({ url: 'http://127.0.0.1:${WEB_PORT}', token: '${WEB_TOKEN}', label: 'peer' })`);
    await cdp.evaluate('location.reload()');
    await wait(3000);
    check('switched to the remote source', await cdp.evaluate(`(async () => {
      document.getElementById('sourceButton').click();
      await new Promise((r) => setTimeout(r, 300));
      const row = document.querySelector('.source-row[data-connection-id] .source-row-main');
      if (!row) return 'no remote row';
      row.click();
      return 'clicked';
    })()`), 'clicked');
    await wait(2000);
    if (!await openFirstSession(cdp)) throw new Error('no remote session row');
    await wait(1500);
    await cdp.evaluate(`document.getElementById('filesToggleButton').click()`);
    await waitFor(cdp, `document.querySelectorAll('#fbTree .fb-node').length > 0`);

    check('host badge names the remote', await cdp.evaluate(`document.getElementById('fbHost').classList.contains('hidden') ? '' : document.getElementById('fbHost').textContent`), 'peer');
    check('reveal-in-Finder hidden for remote', await cdp.evaluate(`document.getElementById('fbRevealButton').classList.contains('hidden')`), true);
    check('path label keeps ~/ at the front', await cdp.evaluate(`document.getElementById('fbPath').textContent.replace('\\u200E', '').startsWith('/') || document.getElementById('fbPath').textContent.includes('\\u200E')`), true);
    check('remote listing', JSON.stringify(await treeNames(cdp)), JSON.stringify(['src', 'README.md']));

    // Download through the context menu.
    const readme = await rowPoint(cdp, `[...document.querySelectorAll('.fb-node')].find((n) => n.dataset.path.endsWith('/README.md'))?.querySelector('.fb-row')`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: readme.x, y: readme.y, button: 'right', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: readme.x, y: readme.y, button: 'right', clickCount: 1 });
    await wait(200);
    const menu = await cdp.evaluate(`[...document.querySelectorAll('#contextMenu button')].map((b) => b.textContent.trim())`);
    check('remote file menu offers download / open / save as', ['下载到「下载」文件夹', '下载并打开', '另存为…'].every((label) => menu.includes(label)), true);
    await cdp.evaluate(`[...document.querySelectorAll('#contextMenu button')].find((b) => b.textContent.includes('下载到'))?.click()`);
    await waitFor(cdp, `document.querySelector('.fb-transfer[data-status="done"]') !== null`);
    check('downloaded bytes', fs.existsSync(path.join(downloads, 'README.md')) ? fs.readFileSync(path.join(downloads, 'README.md'), 'utf8') : 'missing', '# remote readme\n');
    check('transfer row says where it went', await cdp.evaluate(`document.querySelector('.fb-transfer[data-status="done"] .fb-transfer-meta')?.textContent || ''`), `已保存到 ${path.join(downloads, 'README.md').replace(/^\/Users\/[^/]+/, '~')}`);

    // Expand src, then drop a file onto the src row → uploads INTO src.
    await cdp.evaluate(`[...document.querySelectorAll('.fb-node')].find((n) => n.dataset.path.endsWith('/src')).querySelector('.fb-row').click()`);
    await waitFor(cdp, `[...document.querySelectorAll('.fb-name')].some((n) => n.textContent === 'app.js')`);
    const srcRow = await rowPoint(cdp, `[...document.querySelectorAll('.fb-node')].find((n) => n.dataset.path.endsWith('/src')).querySelector('.fb-row')`);
    const hint = await drop(cdp, srcRow, [path.join(outside, 'drop on src.txt')]);
    check('drop hint names host and folder', hint, '松开即上传到 peer 的 src');
    await waitFor(cdp, `[...document.querySelectorAll('.fb-name')].some((n) => n.textContent === 'drop on src.txt')`);
    check('uploaded into src on the remote', fs.existsSync(path.join(project, 'src', 'drop on src.txt')) ? fs.readFileSync(path.join(project, 'src', 'drop on src.txt'), 'utf8') : 'missing', 'into-src');
    check('src stayed expanded after the refresh', await cdp.evaluate(`[...document.querySelectorAll('.fb-node.open')].some((n) => n.dataset.path.endsWith('/src'))`), true);

    // Big file onto the empty area of the tree → root folder, with progress.
    const empty = await cdp.evaluate(`(() => { const r = document.getElementById('fbTree').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 20) }; })()`);
    await drop(cdp, empty, [path.join(outside, 'big.bin')]);
    await waitFor(cdp, `[...document.querySelectorAll('.fb-transfer')].some((row) => row.dataset.status === 'done' && row.textContent.includes('big.bin'))`, 15000);
    check('big upload complete on the remote', fs.existsSync(path.join(project, 'big.bin')) ? fs.statSync(path.join(project, 'big.bin')).size : 0, big.length);
    check('no partial files left on the remote', fs.readdirSync(project).filter((name) => name.endsWith('.tmux-desk-part')).length, 0);
    // The window is vibrancy-transparent; without an opaque backdrop a CDP
    // capture comes out as premultiplied mush.
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 236, g: 236, b: 236, a: 1 } }).catch(() => {});
    const remoteShot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (remoteShot) fs.writeFileSync(path.join(process.env.SHOTS_DIR || os.tmpdir(), 'remote-files-panel.png'), Buffer.from(remoteShot.data, 'base64'));

    // Back to the local source: same session, same dir — the panel must switch
    // over (badge gone), and a drop becomes a copy.
    await cdp.evaluate(`(async () => {
      document.getElementById('sourceButton').click();
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.source-row:not([data-connection-id]) .source-row-main, .source-row .source-row-main')?.click();
    })()`);
    await wait(2000);
    await openFirstSession(cdp);
    await waitFor(cdp, `document.getElementById('fbHost').classList.contains('hidden')`);
    check('local source hides the host badge', await cdp.evaluate(`document.getElementById('fbHost').classList.contains('hidden')`), true);
    fs.writeFileSync(path.join(outside, 'local copy.txt'), 'copied');
    const emptyLocal = await cdp.evaluate(`(() => { const r = document.getElementById('fbTree').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 20) }; })()`);
    check('local drop hint', await drop(cdp, emptyLocal, [path.join(outside, 'local copy.txt')]), '松开即拷贝到 remote-project');
    await wait(1200);
    check('local drop copied the file', fs.existsSync(path.join(project, 'local copy.txt')), true);
    check('the source file is untouched', fs.existsSync(path.join(outside, 'local copy.txt')), true);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot) fs.writeFileSync(path.join(os.tmpdir(), 'remote-files-e2e.png'), Buffer.from(shot.data, 'base64'));
  } finally {
    app.stop();
    upstream.kill();
    sandbox.kill();
    fs.rmSync(scratch, { force: true, recursive: true });
  }

  let failed = 0;
  for (const [label, actual, expected] of results) {
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? '✔' : '✘'} ${label}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });

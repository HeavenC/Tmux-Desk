// Drag & drop a real file onto the desktop terminal and assert the reference it
// types. Local sessions must use the file's OWN path (no upload, no copy), which
// is the half a synthetic DragEvent cannot exercise — only CDP's
// Input.dispatchDragEvent carries real filenames into the renderer.
//
// Run: node test/manual/file-drop-e2e.js   (starts a real Electron instance)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchApp, openFirstSession, tmuxSandbox, wait } = require('./cdp-harness');

const SOCKET = 'dropui';
const WEB_PORT = 8901;
const WEB_TOKEN = 'droptoken';

// Stands in for "another machine": the same web server a phone or a relayed
// desktop talks to, here pointed at the sandbox socket on this host.
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

async function main() {
  const sandbox = tmuxSandbox(SOCKET);
  sandbox.kill();
  sandbox.tmux('new-session', '-d', '-s', 'drop');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-drop-'));
  const file = path.join(scratch, 'dropped notes.md');
  fs.writeFileSync(file, '# hi\n');

  const app = await launchApp({ socket: SOCKET, port: 9224 });
  const { cdp } = app;
  const results = [];
  let upstream = null;
  try {
    if (!await openFirstSession(cdp)) throw new Error('no session row to click');
    await wait(1500);

    const stage = await cdp.evaluate(`(() => {
      const rect = document.getElementById('terminalStage').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: stage.x, y: stage.y, data });
    await wait(150);
    results.push(['overlay visible on dragenter',
      await cdp.evaluate(`!document.getElementById('terminalDrop').classList.contains('hidden')`), true]);
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: stage.x, y: stage.y, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: stage.x, y: stage.y, data });
    await wait(1200);
    results.push(['overlay hidden after drop',
      await cdp.evaluate(`document.getElementById('terminalDrop').classList.contains('hidden')`), true]);

    // -J joins the wrapped lines: a long path is split across rows by tmux and
    // would never match otherwise.
    const pane = sandbox.tmux('capture-pane', '-p', '-J', '-t', 'drop').replace(/\n/g, '').trim();
    // The space in the filename must arrive backslash-escaped, or the reference
    // ends at "dropped".
    results.push(['pane shows the escaped real path', pane.includes(`@${file.replace(' ', '\\ ')}`), true]);
    results.push(['file was not copied elsewhere', pane.includes('/Caches/tmux-desk/uploads/'), false]);

    // ---- Remote takeover: the session runs on "another machine", so the same
    // drop has to upload and then reference the path THAT host staged it at.
    upstream = startUpstream();
    await wait(2000);
    await cdp.evaluate(`window.tmuxDesk.addRemote({ url: 'http://127.0.0.1:${WEB_PORT}', token: '${WEB_TOKEN}', label: 'upstream' })`);
    await cdp.evaluate('location.reload()');
    await wait(3000);
    const switched = await cdp.evaluate(`(async () => {
      document.getElementById('sourceButton').click();
      await new Promise((r) => setTimeout(r, 300));
      const row = document.querySelector('.source-row[data-connection-id] .source-row-main');
      if (!row) return 'no remote row';
      row.click();
      return 'clicked';
    })()`);
    results.push(['remote source row appears', switched, 'clicked']);
    await wait(2500);
    if (!await openFirstSession(cdp)) throw new Error('no remote session row to click');
    await wait(2500);

    const remoteFile = path.join(scratch, 'remote payload.txt');
    fs.writeFileSync(remoteFile, 'remote-bytes');
    const remoteData = { items: [], files: [remoteFile], dragOperationsMask: 1 };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: stage.x, y: stage.y, data: remoteData });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: stage.x, y: stage.y, data: remoteData });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: stage.x, y: stage.y, data: remoteData });
    await wait(2500);

    const remotePane = sandbox.tmux('capture-pane', '-p', '-J', '-t', 'drop').replace(/\n/g, '').trim();
    const staged = remotePane.match(/@(\S*\/uploads\/remote_payload-[0-9a-f]{6}\.txt)/);
    results.push(['remote drop types the UPLOADED path', Boolean(staged), true]);
    results.push(['remote drop did not type the local path', remotePane.includes(scratch + '/remote'), false]);
    if (staged) {
      results.push(['uploaded bytes match', fs.readFileSync(staged[1], 'utf8'), 'remote-bytes']);
      fs.rmSync(staged[1], { force: true });
    }
  } finally {
    app.stop();
    if (upstream) upstream.kill();
    sandbox.kill();
    fs.rmSync(scratch, { force: true, recursive: true });
  }

  let failed = 0;
  for (const [label, actual, expected] of results) {
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? '✔' : '✘'} ${label}${ok ? '' : ` (got ${actual}, want ${expected})`}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });

// The browser files sheet, in a real (headless) Chrome at phone size: browse the
// session directory, download a file through the browser's download manager,
// upload through the picker — once with the full token and once through a
// single-session share link.
//
// Run: node test/manual/webapp-files-e2e.js   (needs Google Chrome + tmux)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const { Cdp, getJson, tmuxSandbox, wait } = require('./cdp-harness');
const { createSessionShareToken } = require('../../src/server/web-server');

const SOCKET = 'webfiles';
const WEB_PORT = 8903;
const WEB_TOKEN = 'webfilestoken';
const CDP_PORT = 9250;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS_DIR || os.tmpdir();

async function waitFor(cdp, expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await cdp.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

async function waitForFile(file, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fs.existsSync(file)) return true;
    await wait(150);
  }
  return false;
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
}

const rowNames = (cdp) => cdp.evaluate(`[...document.querySelectorAll('#files-list .file-row:not(.up) .file-row-name')].map((n) => n.textContent)`);
const clickRow = (cdp, name) => cdp.evaluate(`[...document.querySelectorAll('#files-list .file-row')].find((row) => row.querySelector('.file-row-name')?.textContent === ${JSON.stringify(name)})?.querySelector('.file-row-main').click()`);

async function pickFile(cdp, file) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#files-input' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-webfiles-'));
  const project = path.join(scratch, 'project');
  const other = path.join(scratch, 'other');
  const downloads = path.join(scratch, 'downloads');
  for (const dir of [path.join(project, 'src'), other, downloads]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, '说明.md'), '# 说明\n');
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(project, 'src', 'main.go'), 'package main\n');
  fs.writeFileSync(path.join(scratch, 'from phone.png'), Buffer.alloc(300 * 1024, 3));
  fs.writeFileSync(path.join(scratch, 'shared.txt'), 'via share link');

  const sandbox = tmuxSandbox(SOCKET);
  sandbox.kill();
  sandbox.tmux('new-session', '-d', '-s', 'proj', '-c', project);
  sandbox.tmux('new-session', '-d', '-s', 'other', '-c', other);

  const server = spawn(process.execPath, ['src/server/index.js'], {
    env: {
      ...process.env,
      TMUX_DESK_SOCKET: SOCKET,
      TMUX_DESK_WEB_TOKEN: WEB_TOKEN,
      TMUX_DESK_WEB_PORT: String(WEB_PORT),
      TMUX_DESK_PREFERENCES_FILE: path.join(scratch, 'prefs', 'preferences.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(scratch, 'chrome')}`,
    '--no-first-run', '--window-size=390,844', 'about:blank',
  ], { stdio: 'ignore' });

  const results = [];
  const check = (label, actual, expected) => results.push([label, actual, expected]);
  try {
    await wait(2000);
    let page = null;
    for (let attempt = 0; attempt < 20 && !page; attempt += 1) {
      try { page = (await getJson(`http://127.0.0.1:${CDP_PORT}/json`)).find((target) => target.type === 'page'); } catch {}
      if (!page) await wait(300);
    }
    const cdp = new Cdp(new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false }));
    await new Promise((resolve) => cdp.ws.on('open', resolve));
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    // ---- full token
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/?token=${WEB_TOKEN}` });
    await waitFor(cdp, `document.querySelectorAll('.session-card').length >= 2`);
    await cdp.evaluate(`[...document.querySelectorAll('.session-card')].find((card) => card.textContent.includes('proj')).click()`);
    await waitFor(cdp, `!document.getElementById('view-terminal').hidden`);
    await cdp.evaluate(`document.getElementById('files-btn').click()`);
    await waitFor(cdp, `document.querySelectorAll('#files-list .file-row').length > 0`);
    check('lists the session dir (hidden files tucked away)', JSON.stringify(await rowNames(cdp)), JSON.stringify(['src', '说明.md']));
    check('offers to show the hidden item', await cdp.evaluate(`document.querySelector('.files-hidden-toggle')?.textContent`), '显示 1 个隐藏项目');
    check('no "up" row at the session root', await cdp.evaluate(`!document.querySelector('#files-list .file-row.up')`), true);
    await shot(cdp, 'webapp-files-root.png');

    await clickRow(cdp, 'src');
    await waitFor(cdp, `document.getElementById('files-path').title.endsWith('/src')`);
    check('navigates into a folder', JSON.stringify(await rowNames(cdp)), JSON.stringify(['main.go']));
    check('up row leads back', await cdp.evaluate(`document.querySelector('#files-list .file-row.up .file-row-meta')?.textContent`), 'project');
    await cdp.evaluate(`document.querySelector('#files-list .file-row.up .file-row-main').click()`);
    await waitFor(cdp, `document.getElementById('files-path').title.endsWith('/project')`);

    await clickRow(cdp, '说明.md');
    await waitFor(cdp, `document.querySelector('.file-row.selected .file-row-actions') !== null`);
    check('file actions', JSON.stringify(await cdp.evaluate(`[...document.querySelectorAll('.file-row.selected .file-row-actions button')].map((b) => b.textContent)`)), JSON.stringify(['下载', '引用到终端', '复制路径']));
    await shot(cdp, 'webapp-files-actions.png');
    await cdp.evaluate(`document.querySelector('.file-row.selected .file-row-actions .btn.primary').click()`);
    check('download landed via the browser', await waitForFile(path.join(downloads, '说明.md')), true);
    if (fs.existsSync(path.join(downloads, '说明.md'))) check('download bytes', fs.readFileSync(path.join(downloads, '说明.md'), 'utf8'), '# 说明\n');

    await cdp.evaluate(`document.getElementById('files-path').title`);
    await pickFile(cdp, path.join(scratch, 'from phone.png'));
    await waitFor(cdp, `[...document.querySelectorAll('#files-list .file-row-name')].some((n) => n.textContent === 'from phone.png')`);
    check('picker upload lands in the folder', fs.existsSync(path.join(project, 'from phone.png')) ? fs.statSync(path.join(project, 'from phone.png')).size : 0, 300 * 1024);
    check('transfer row reports done', await cdp.evaluate(`document.querySelector('.file-transfer')?.dataset.status`), 'done');
    await shot(cdp, 'webapp-files-uploaded.png');

    // Reference a file: closes the sheet and types @path into the pane. Needs a
    // live terminal socket — when node-pty can't spawn here, say so instead of
    // reporting the feature as broken.
    const live = await cdp.evaluate(`document.getElementById('disconnect-banner').hidden`);
    if (!live) console.log('- skipped: @path reference (terminal attach failed in this environment)');
    if (live) await clickRow(cdp, '说明.md');
    if (live) {
      await cdp.evaluate(`[...document.querySelectorAll('.file-row.selected .file-row-actions button')].find((b) => b.textContent === '引用到终端').click()`);
      await wait(800);
      check('reference closes the sheet', await cdp.evaluate(`document.getElementById('files-modal').hidden`), true);
      const pane = sandbox.tmux('capture-pane', '-p', '-J', '-t', 'proj').replace(/\n/g, '');
      check('pane got the @path reference', pane.includes(`@${path.join(project, '说明.md')}`), true);
    }

    // ---- single-session share link
    const share = createSessionShareToken(WEB_TOKEN, 'proj');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/?share=${share}` });
    await waitFor(cdp, `!document.getElementById('view-terminal').hidden`);
    check('share link opens its session', await cdp.evaluate(`document.getElementById('term-title').textContent`), 'proj');
    check('files button available on a share link', await cdp.evaluate(`getComputedStyle(document.getElementById('files-btn')).display !== 'none'`), true);
    await cdp.evaluate(`document.getElementById('files-btn').click()`);
    await waitFor(cdp, `document.querySelectorAll('#files-list .file-row').length > 0`);
    check('share link lists the session dir', (await rowNames(cdp)).includes('说明.md'), true);
    await pickFile(cdp, path.join(scratch, 'shared.txt'));
    await waitFor(cdp, `[...document.querySelectorAll('#files-list .file-row-name')].some((n) => n.textContent === 'shared.txt')`);
    check('share link upload', fs.existsSync(path.join(project, 'shared.txt')) ? fs.readFileSync(path.join(project, 'shared.txt'), 'utf8') : 'missing', 'via share link');
    fs.rmSync(path.join(downloads, '说明.md'), { force: true });
    await clickRow(cdp, '说明.md');
    await cdp.evaluate(`document.querySelector('.file-row.selected .file-row-actions .btn.primary').click()`);
    check('share link download', await waitForFile(path.join(downloads, '说明.md')), true);
    const denied = await cdp.evaluate(`fetch('/api/files/list?share=${share}&session=' + encodeURIComponent('$2')).then((r) => r.status)`);
    check('share link cannot reach another session', denied, 403);

    await cdp.evaluate(`document.querySelector('#theme-btn-term').click()`);
    await wait(300);
    await shot(cdp, 'webapp-files-share-dark.png');
  } finally {
    chrome.kill();
    server.kill();
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

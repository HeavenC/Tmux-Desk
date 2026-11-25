// Switching sources (this machine ↔ remote hosts) lands on the session — and
// the all / favorites / tag view — the user was in when they last left that
// source, instead of "all" + the first session in the list.
//
// Also covers the two ways a switch used to end up with NOTHING selected:
//  - leaving a host whose listing is still in flight (an unreachable host holds
//    it for the whole request timeout) swallowed the new source's first refresh;
//  - a host that was unreachable at switch time and answered on a later poll.
//
// Sandboxes: a "remote" tmux + web server, a local tmux the app runs against,
// a black-hole TCP server (accepts, never answers) and a second web server
// that only starts mid-test. Not part of `npm test` — needs a display and tmux.
// Run `npm run build:renderer` first: the app loads renderer-dist/.
const net = require('node:net');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchApp, tmuxSandbox, wait } = require('./cdp-harness');

const REMOTE_SOCKET = 'srestore-remote';
const LOCAL_SOCKET = 'srestore-local';
const WEB_PORT = 8896;
const LATE_PORT = 8895;
const BLACKHOLE_PORT = 8894;
const TOKEN = 'srestore-e2e-token';
const CDP_PORT = 9242;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function poll(fn, { tries = 30, every = 200 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await fn();
    if (last) return last;
    await wait(every);
  }
  return last;
}

function startWebServer(port, home) {
  return spawn(process.execPath, ['src/server/index.js'], {
    env: {
      ...process.env,
      TMUX_DESK_SOCKET: REMOTE_SOCKET,
      TMUX_DESK_PREFERENCES_FILE: path.join(home, `preferences-${port}.json`),
      TMUX_DESK_WEB_TOKEN: TOKEN,
      TMUX_DESK_WEB_PORT: String(port),
      TMUX_DESK_WEB_HOST: '127.0.0.1',
    },
    stdio: 'ignore',
  });
}

function driver(cdp) {
  // The sidebar list in "all", the tab strip in favorites / tag views.
  const selected = () => cdp.evaluate(`document.querySelector(
    '.session-item.active .session-name, .session-tab.active .session-tab-name')?.textContent || null`);
  const listed = () => cdp.evaluate(`document.querySelectorAll('.session-item').length`);
  const clickSession = (name) => cdp.evaluate(`(() => {
    const target = [...document.querySelectorAll('.session-item .session-main, .session-tab')]
      .find((item) => item.querySelector('.session-name, .session-tab-name')?.textContent === ${JSON.stringify(name)});
    target?.click();
    return !!target;
  })()`);
  const view = () => cdp.evaluate(`(() => {
    const tag = document.querySelector('.tag-rail-button.active');
    const name = tag ? 'tag:' + tag.dataset.tagId : (document.querySelector('[data-view].active')?.dataset.view || null);
    return { name, compact: document.getElementById('appShell').classList.contains('compact-view') };
  })()`);
  const clickTag = (tagId) => poll(() => cdp.evaluate(`(() => {
    const button = document.querySelector('.tag-rail-button[data-tag-id="${tagId}"]');
    button?.click();
    return !!button;
  })()`));
  const waitView = (name, options) => poll(async () => {
    const current = await view();
    return current.name === name && current.compact === (name !== 'all') ? current : null;
  }, options);
  const switchTo = async (connectionId) => {
    await cdp.evaluate(`document.getElementById('sourceButton').click()`);
    await wait(250);
    await cdp.evaluate(connectionId
      ? `document.querySelector('.source-row[data-connection-id="${connectionId}"] .source-row-main').click()`
      : `document.querySelectorAll('.source-row .source-row-main')[0].click()`);
  };
  const waitSelected = (name, options) => poll(async () => ((await selected()) === name ? name : null), options);
  const waitBoth = async (viewName, session) => {
    const okView = await waitView(viewName);
    const okSession = await waitSelected(session);
    return { ok: !!(okView && okSession), detail: `${JSON.stringify(await view())} ${await selected()}` };
  };
  return { selected, listed, clickSession, switchTo, waitSelected, view, waitView, clickTag, waitBoth };
}

async function main() {
  const remote = tmuxSandbox(REMOTE_SOCKET);
  const local = tmuxSandbox(LOCAL_SOCKET);
  remote.kill();
  local.kill();
  for (const name of ['vm-1', 'vm-2', 'vm-3']) remote.tmux('new-session', '-d', '-s', name);
  for (const name of ['alpha', 'bravo', 'charlie']) local.tmux('new-session', '-d', '-s', name);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-srestore-'));
  fs.writeFileSync(path.join(home, `preferences-${WEB_PORT}.json`), JSON.stringify({
    tags: [{ id: 'tag-vmwork', name: 'vm-work', color: 'green' }],
    sessionTags: { 'vm-2': ['tag-vmwork'], 'vm-3': ['tag-vmwork'] },
  }));
  const server = startWebServer(WEB_PORT, home);
  let lateServer = null;
  const blackholeSockets = [];
  const blackhole = net.createServer((socket) => { blackholeSockets.push(socket); });
  await new Promise((resolve) => blackhole.listen(BLACKHOLE_PORT, '127.0.0.1', resolve));

  const connections = [
    { id: 'vm', base: `http://127.0.0.1:${WEB_PORT}`, token: TOKEN, label: 'VM' },
    { id: 'dead', base: `http://127.0.0.1:${BLACKHOLE_PORT}`, token: TOKEN, label: 'Dead' },
    { id: 'late', base: `http://127.0.0.1:${LATE_PORT}`, token: TOKEN, label: 'Late' },
  ];
  let app = null;
  try {
    await wait(1200);
    app = await launchApp({
      socket: LOCAL_SOCKET,
      port: CDP_PORT,
      preferences: {
        tags: [{ id: 'tag-lwork', name: 'local-work', color: 'blue' }],
        sessionTags: { bravo: ['tag-lwork'], charlie: ['tag-lwork'] },
        remoteConnections: connections,
        // Seeded so the "late" host has something to restore once it answers.
        remoteLastSessions: { late: { id: '$999', name: 'vm-2' } },
      },
    });
    let ui = driver(app.cdp);

    await poll(async () => ((await ui.listed()) === 3 ? true : null));
    await ui.clickSession('bravo');
    check('local: picked bravo', await ui.waitSelected('bravo'));

    await ui.switchTo('vm');
    const firstVisit = await poll(ui.selected);
    check('remote, first visit: falls back to the first session', firstVisit === 'vm-1', firstVisit);
    await ui.clickSession('vm-3');
    check('remote: picked vm-3', await ui.waitSelected('vm-3'));

    await ui.switchTo(null);
    check('back to local restores bravo', await ui.waitSelected('bravo'), await ui.selected());
    const localClient = await poll(() => {
      const clients = local.quiet('list-clients', '-F', '#{session_name}').trim();
      return clients === 'bravo' ? clients : null;
    });
    check('local tmux client is attached to bravo', localClient === 'bravo', localClient);

    await ui.switchTo('vm');
    check('back to remote restores vm-3', await ui.waitSelected('vm-3'), await ui.selected());

    // Leave a host while its listing hangs: the local list must come back (and
    // restore) right away, not after the black hole's request timeout.
    await ui.switchTo(null);
    await ui.waitSelected('bravo');
    await ui.switchTo('dead');
    await wait(600);
    const hung = await app.cdp.evaluate(`({
      status: document.getElementById('sourceStatusDot').dataset.status,
      label: document.getElementById('sourceLabel').textContent,
      rows: document.querySelectorAll('.session-item').length,
    })`);
    check('switched to the hung host (still connecting, no list)', hung.status === 'connecting' && hung.rows === 0, JSON.stringify(hung));
    const leftAt = Date.now();
    await ui.switchTo(null);
    const restored = await ui.waitSelected('bravo', { tries: 15, every: 200 });
    check('leaving a hung host still restores the local session promptly', restored,
      `${Date.now() - leftAt}ms, selected=${await ui.selected()}`);
    await wait(5500); // the abandoned request times out now; it must not mark local offline
    const dot = await app.cdp.evaluate(`document.getElementById('sourceStatusDot').dataset.status`);
    check('the abandoned host\'s failure does not mark local offline', dot === 'local', dot);

    // A host that is down when switched to, and comes up later.
    await ui.switchTo('late');
    await poll(async () => (await app.cdp.evaluate(`document.getElementById('sourceStatusDot').dataset.status`)) === 'offline' || null);
    lateServer = startWebServer(LATE_PORT, home);
    const lateSelected = await ui.waitSelected('vm-2', { tries: 80, every: 250 });
    check('a host that answers on a later poll restores its session (name match, stale id)', lateSelected, await ui.selected());

    // Persisted across a restart.
    const saved = await app.cdp.evaluate(`window.tmuxDesk.getPreferences()`);
    check('remote selections are persisted per host',
      saved.remoteLastSessions?.vm?.name === 'vm-3' && saved.remoteLastSessions?.late?.name === 'vm-2',
      JSON.stringify(saved.remoteLastSessions));
    app.stop();
    await wait(800);
    app = await launchApp({ socket: LOCAL_SOCKET, port: CDP_PORT, preferences: saved });
    ui = driver(app.cdp);
    check('after restart, local opens bravo', await ui.waitSelected('bravo', { tries: 40, every: 250 }), await ui.selected());
    await ui.switchTo('vm');
    check('after restart, the remote still restores vm-3', await ui.waitSelected('vm-3'), await ui.selected());

    // Views are per source too: each host comes back in its own tag view.
    await ui.clickTag('tag-vmwork');
    await ui.waitView('tag:tag-vmwork');
    await ui.clickSession('vm-2');
    check('remote: tag view vm-work, picked vm-2', await ui.waitSelected('vm-2'), await ui.selected());
    await ui.switchTo(null);
    let both = await ui.waitBoth('all', 'bravo');
    check('local comes back in "all" (the view it was left in)', both.ok, both.detail);
    await ui.clickTag('tag-lwork');
    await ui.waitView('tag:tag-lwork');
    await ui.clickSession('charlie');
    check('local: tag view local-work, picked charlie', await ui.waitSelected('charlie'), await ui.selected());
    await ui.switchTo('vm');
    both = await ui.waitBoth('tag:tag-vmwork', 'vm-2');
    check('remote comes back in its tag view on vm-2', both.ok, both.detail);
    await ui.switchTo(null);
    both = await ui.waitBoth('tag:tag-lwork', 'charlie');
    check('local comes back in its tag view on charlie', both.ok, both.detail);
    await ui.switchTo('dead');
    await wait(600);
    const loading = await ui.view();
    check('while a host loads it shows the plain "all" layout', loading.name === 'all' && !loading.compact, JSON.stringify(loading));
    await ui.switchTo(null);
    both = await ui.waitBoth('tag:tag-lwork', 'charlie');
    check('leaving a hung host restores local\'s tag view too', both.ok, both.detail);
  } finally {
    app?.stop();
    server.kill();
    lateServer?.kill();
    for (const socket of blackholeSockets) socket.destroy();
    blackhole.close();
    remote.kill();
    local.kill();
    fs.rmSync(home, { force: true, recursive: true });
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

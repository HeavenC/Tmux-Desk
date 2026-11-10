// Remote source + tag rail, end to end: this desktop takes over another host's
// sessions, and the tag rail must show THAT host's tags and filter its sessions
// with them. The bug this guards: the rail kept this machine's tags, whose
// sessionTags are keyed by this machine's session names, so clicking any tag on
// a remote source always produced an empty view.
//
// Two sandboxes: a "remote" tmux + web server (its own preferences with a tag),
// and a local tmux the desktop app runs against (different tags, plus the remote
// saved as a source). Not part of `npm test` — needs a display and real tmux.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchApp, tmuxSandbox, wait } = require('./cdp-harness');

const REMOTE_SOCKET = 'rtag-remote';
const LOCAL_SOCKET = 'rtag-local';
const WEB_PORT = 8897;
const TOKEN = 'rtag-e2e-token';
// Not the harness default 9223: that one is often already forwarded somewhere.
const CDP_PORT = 9241;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function poll(fn, { tries = 30, every = 300 } = {}) {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await fn();
    if (last) return last;
    await wait(every);
  }
  return last;
}

async function main() {
  const remote = tmuxSandbox(REMOTE_SOCKET);
  const local = tmuxSandbox(LOCAL_SOCKET);
  remote.kill();
  local.kill();
  for (const name of ['vm-api', 'vm-db', 'vm-scratch']) remote.tmux('new-session', '-d', '-s', name);
  local.tmux('new-session', '-d', '-s', 'host-only');

  const remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-desk-rtag-'));
  const remotePrefs = path.join(remoteHome, 'preferences.json');
  fs.writeFileSync(remotePrefs, JSON.stringify({
    tags: [{ id: 'tag-vmwork', name: 'vm-work', color: 'green' }],
    sessionTags: { 'vm-api': ['tag-vmwork'], 'vm-db': ['tag-vmwork'] },
    favorites: ['vm-scratch'],
  }));
  const server = spawn(process.execPath, ['src/server/index.js'], {
    env: {
      ...process.env,
      TMUX_DESK_SOCKET: REMOTE_SOCKET,
      TMUX_DESK_PREFERENCES_FILE: remotePrefs,
      TMUX_DESK_WEB_TOKEN: TOKEN,
      TMUX_DESK_WEB_PORT: String(WEB_PORT),
      TMUX_DESK_WEB_HOST: '127.0.0.1',
    },
    stdio: 'ignore',
  });

  let app = null;
  try {
    await wait(1200);
    app = await launchApp({
      socket: LOCAL_SOCKET,
      port: CDP_PORT,
      preferences: {
        tags: [{ id: 'tag-hostonly', name: 'host-tag', color: 'blue' }],
        sessionTags: { 'host-only': ['tag-hostonly'] },
        remoteConnections: [{ id: 'vm', base: `http://127.0.0.1:${WEB_PORT}`, token: TOKEN, label: 'VM' }],
      },
    });
    const { cdp } = app;
    const railTags = () => cdp.evaluate(`[...document.querySelectorAll('.tag-rail-button .tag-name')].map((n) => n.textContent)`);
    const tabs = () => cdp.evaluate(`[...document.querySelectorAll('.session-tab .session-tab-name')].map((n) => n.textContent)`);

    const localRail = await poll(async () => { const tags = await railTags(); return tags.length ? tags : null; });
    check('local source shows this machine\'s tags', JSON.stringify(localRail) === '["host-tag"]', JSON.stringify(localRail));

    await cdp.evaluate(`document.getElementById('sourceButton').click()`);
    await wait(300);
    await cdp.evaluate(`document.querySelector('.source-row[data-connection-id="vm"] .source-row-main').click()`);
    const remoteRail = await poll(async () => {
      const tags = await railTags();
      return tags.includes('vm-work') ? tags : null;
    });
    check('remote source swaps the rail to the remote host\'s tags', JSON.stringify(remoteRail) === '["vm-work"]', JSON.stringify(remoteRail));

    await cdp.evaluate(`document.querySelector('.tag-rail-button[data-tag-id="tag-vmwork"]').click()`);
    const tagTabs = await poll(async () => { const names = await tabs(); return names.length ? names : null; });
    check('clicking a remote tag lists that host\'s tagged sessions', JSON.stringify([...(tagTabs || [])].sort()) === '["vm-api","vm-db"]', JSON.stringify(tagTabs));

    await cdp.evaluate(`document.querySelector('[data-view="favorites"]').click()`);
    const favTabs = await poll(async () => {
      const names = await tabs();
      return names.length === 1 ? names : null;
    });
    check('favorites on a remote source come from that host', JSON.stringify(favTabs) === '["vm-scratch"]', JSON.stringify(favTabs));

    // Remote tags must not be written into this machine's preferences.
    const promoted = await cdp.evaluate(`window.tmuxDesk.getPreferences().then((p) => ({ tags: p.tags.map((t) => t.id), sessionTags: p.sessionTags }))`);
    check('local preferences untouched by remote tag clicks',
      JSON.stringify(promoted.tags) === '["tag-hostonly"]' && JSON.stringify(promoted.sessionTags) === '{"host-only":["tag-hostonly"]}',
      JSON.stringify(promoted));

    await cdp.evaluate(`document.getElementById('sourceButton').click()`);
    await wait(300);
    await cdp.evaluate(`document.querySelectorAll('.source-row .source-row-main')[0].click()`);
    const backRail = await poll(async () => {
      const tags = await railTags();
      return tags.includes('host-tag') ? tags : null;
    });
    check('switching back restores this machine\'s tags', JSON.stringify(backRail) === '["host-tag"]', JSON.stringify(backRail));
    await cdp.evaluate(`document.querySelector('.tag-rail-button[data-tag-id="tag-hostonly"]').click()`);
    const localTabs = await poll(async () => { const names = await tabs(); return names.length ? names : null; });
    check('local tag filter still works', JSON.stringify(localTabs) === '["host-only"]', JSON.stringify(localTabs));
  } finally {
    app?.stop();
    server.kill();
    remote.kill();
    local.kill();
    fs.rmSync(remoteHome, { force: true, recursive: true });
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

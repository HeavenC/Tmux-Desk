const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const { SessionSnapshotService, normalizeSessionRestore } = require('../src/main/session-snapshot');

const HOME = '/Users/demo';

// A tmux stand-in: `reply` maps a command verb to canned stdout, every call is
// recorded, and `dirs` decides which working directories still exist.
class FakeTmux {
  constructor({ reply = {}, dirs = [] } = {}) {
    this.reply = reply;
    this.dirs = new Set(dirs);
    this.calls = [];
    this.sessions = [];
  }

  async run(args) {
    this.calls.push(args);
    const key = args[0];
    const value = this.reply[key];
    const stdout = typeof value === 'function' ? value(args) : value;
    if (stdout instanceof Error) throw stdout;
    return { stdout: stdout == null ? '' : stdout };
  }

  async listSessions() {
    return this.sessions.map((name, index) => ({ id: `$${index}`, name }));
  }

  dirExists(dir) {
    return this.dirs.has(dir);
  }
}

async function withService(options, run) {
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-snapshot-'));
  const filePath = join(root, 'session-snapshot.json');
  const tmux = options.tmux || new FakeTmux();
  const service = new SessionSnapshotService({
    tmuxService: tmux,
    preferencesStore: {
      load: async () => ({ sessionRestore: normalizeSessionRestore(options.settings) }),
    },
    filePath,
    homeDir: HOME,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    settlePollMs: 1,
    settleTimeoutMs: 10,
    ...options.overrides,
  });
  try {
    await run({ service, tmux, filePath, root });
  } finally {
    service.dispose();
    // The log is written on a queue; let it drain before the directory goes.
    await service.logQueue.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

const LIST_SESSIONS = '$0\tapi\t/work/api\n$1\tweb\t/work/web\n$2\t_web_api\t/work/api\n';
const LIST_WINDOWS = [
  // session, window, index, name, active, automatic-rename, layout
  '$0\t@0\t1\tzsh\t1\t1\tabcd,80x24,0,0,0',
  '$0\t@1\t2\tbuild\t0\t0\tbeef,80x24,0,0[80x12,0,0,1,80x11,0,13,2]',
  '$1\t@2\t1\tzsh\t1\t1\tcafe,80x24,0,0,3',
  '$2\t@0\t1\tzsh\t1\t1\tabcd,80x24,0,0,0',
].join('\n') + '\n';
const LIST_PANES = [
  // session, window, pane index, active, path, command
  '$0\t@0\t1\t1\t/work/api\tzsh',
  '$0\t@1\t1\t1\t/work/api/build\tnpm',
  '$0\t@1\t2\t0\t/work/api\tzsh',
  '$1\t@2\t1\t1\t/work/web\tzsh',
  '$2\t@0\t1\t1\t/work/api\tzsh',
].join('\n') + '\n';

function captureTmux(extra = {}) {
  return new FakeTmux({
    reply: {
      'display-message': '4321\n',
      'list-sessions': LIST_SESSIONS,
      'list-windows': LIST_WINDOWS,
      'list-panes': LIST_PANES,
      ...extra,
    },
    dirs: ['/work/api', '/work/web', '/work/api/build'],
  });
}

test('capture records windows, panes and directories, and drops the web-grouped sessions', async () => {
  await withService({ tmux: captureTmux() }, async ({ service }) => {
    const snapshot = await service.capture();
    assert.deepEqual(snapshot.sessions.map((session) => session.name), ['api', 'web']);
    assert.equal(snapshot.serverPid, 4321);
    const api = snapshot.sessions[0];
    assert.equal(api.windows.length, 2);
    // An automatically renamed window must not have its name restored: doing so
    // would pin it (rename-window turns automatic-rename off).
    assert.equal(api.windows[0].name, null);
    assert.equal(api.windows[1].name, 'build');
    assert.deepEqual(api.windows[1].panes.map((pane) => pane.path), ['/work/api/build', '/work/api']);
    assert.equal(api.windows[1].layout, 'beef,80x24,0,0[80x12,0,0,1,80x11,0,13,2]');
  });
});

test('save writes the snapshot and logs the absolute path it wrote', async () => {
  await withService({ tmux: captureTmux() }, async ({ service, filePath }) => {
    const result = await service.save('test');
    assert.deepEqual(result, { ok: true, sessions: 2 });
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(stored.sessions.length, 2);
    const log = await readFile(service.logPath, 'utf8');
    assert.match(log, /快照已保存/);
    assert.ok(log.includes(filePath));
  });
});

test('an empty tmux never overwrites a snapshot that still has sessions', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service, filePath }) => {
    await service.save('first');
    tmux.reply['list-sessions'] = '';
    const result = await service.save('server-down');
    assert.deepEqual(result, { ok: false, skipped: 'empty' });
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(stored.sessions.length, 2, 'the good snapshot survives a tmux outage');
    const health = service.health();
    assert.ok(health.issues.some((issue) => issue.id === 'empty'));
  });
});

test('a write failure surfaces as an actionable issue instead of failing silently', async () => {
  await withService({
    tmux: captureTmux(),
    overrides: { filePath: '/proc/definitely-not-writable/session-snapshot.json' },
  }, async ({ service }) => {
    const result = await service.save('test');
    assert.equal(result.ok, false);
    const health = service.health();
    const issue = health.issues.find((item) => item.id === 'save');
    assert.ok(issue, 'a failed write must raise an issue');
    assert.equal(issue.level, 'error');
    assert.ok(issue.actions.includes('save'));
  });
});

test('startup restore recreates the sessions a reboot took, with their working directories', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service }) => {
    await service.save('before-reboot');

    // A reboot: new tmux server (different pid), no sessions left.
    const restored = new FakeTmux({
      reply: {
        'display-message': '9999\n',
        'new-session': '$7\t@70\t1\n',
        'new-window': '@71\n',
        'list-panes': '',
      },
      dirs: ['/work/api', '/work/web', '/work/api/build'],
    });
    service.tmux = restored;
    await service.runStartupRecovery();

    const newSessions = restored.calls.filter((args) => args[0] === 'new-session');
    assert.equal(newSessions.length, 2);
    // The first window's active pane directory is what the session opens in —
    // this is the "everything came back in ~" bug the snapshot exists to fix.
    assert.deepEqual(newSessions[0].slice(-4), ['-s', 'api', '-c', '/work/api']);
    const newWindows = restored.calls.filter((args) => args[0] === 'new-window');
    assert.equal(newWindows.length, 1, 'api has a second window');
    assert.ok(newWindows[0].includes('build'));
    assert.ok(newWindows[0].includes('/work/api/build'));
    const splits = restored.calls.filter((args) => args[0] === 'split-window');
    assert.deepEqual(splits[0].slice(-2), ['-c', '/work/api']);
    const layouts = restored.calls.filter((args) => args[0] === 'select-layout');
    assert.equal(layouts[0][3], 'beef,80x24,0,0[80x12,0,0,1,80x11,0,13,2]');
    assert.deepEqual(service.health().restore.restored, ['api', 'web']);
  });
});

test('the same tmux server keeps closed sessions closed', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service }) => {
    await service.save('before');
    // Same pid as the snapshot: "web" is missing because the user killed it.
    const live = captureTmux();
    live.sessions = ['api'];
    live.reply['list-sessions'] = '$0\tapi\t/work/api\n';
    live.reply['list-windows'] = '$0\t@0\t1\tzsh\t1\t1\tabcd,80x24,0,0,0\n';
    live.reply['list-panes'] = '$0\t@0\t1\t1\t/work/api\tzsh\n';
    service.tmux = live;
    await service.runStartupRecovery();
    assert.equal(live.calls.filter((args) => args[0] === 'new-session').length, 0);
  });
});

test('restore is skipped but reported when the user turned auto-restore off', async () => {
  const tmux = captureTmux();
  await withService({ tmux, settings: { autoRestore: false } }, async ({ service }) => {
    await service.save('before');
    const empty = new FakeTmux({ reply: { 'display-message': '9999\n' } });
    service.tmux = empty;
    await service.runStartupRecovery();
    assert.equal(empty.calls.filter((args) => args[0] === 'new-session').length, 0);
    const issue = service.health().issues.find((item) => item.id === 'restore-pending');
    assert.ok(issue);
    assert.equal(issue.count, 2);
    assert.ok(issue.actions.includes('restore'));
  });
});

test('panes resurrected into $HOME are detected and repaired with a cd, running programs excluded', async () => {
  const tmux = captureTmux();
  await withService({ tmux, settings: { repairCwd: false } }, async ({ service }) => {
    await service.save('before');
    const drifted = captureTmux();
    drifted.sessions = ['api', 'web'];
    // Some other restore plugin brought everything back in the home directory.
    drifted.reply['list-panes'] = [
      'api\t1\t1\t%10\t/Users/demo\tzsh',
      'api\t2\t1\t%11\t/Users/demo\tnpm',
      'api\t2\t2\t%12\t/Users/demo\t-zsh',
      'web\t1\t1\t%13\t/work/web\tzsh',
    ].join('\n') + '\n';
    // The repair reads the panes back, so the fake has to answer where they landed.
    drifted.reply['display-message'] = (args) => (
      args.includes('#{pane_current_path}') ? '/work/api\n' : '4321\n'
    );
    service.tmux = drifted;

    const drift = await service.findCwdDrift(await service.readSnapshot());
    assert.deepEqual(drift.map((item) => item.paneId), ['%10', '%11', '%12']);
    assert.deepEqual(drift.map((item) => item.repairable), [true, false, true]);

    const result = await service.repairCwd(drift);
    assert.equal(result.repaired, 2);
    const typed = drifted.calls.filter((args) => args[0] === 'send-keys' && args.includes('-l'));
    assert.deepEqual(typed.map((args) => args[4]), ["cd -- '/work/api'", "cd -- '/work/api'"]);
    assert.deepEqual(typed.map((args) => args[2]), ['%10', '%12']);
    // Leftover text at the prompt would otherwise be prefixed onto the command
    // (`cd cd -- '/x'` → "too many arguments"), so the line is cleared first.
    const cleared = drifted.calls.filter((args) => args[0] === 'send-keys' && args[3] === 'C-u');
    assert.deepEqual(cleared.map((args) => args[2]), ['%10', '%12']);
  });
});

// The shape actually seen in the field: a restore that could not apply the
// directory leaves the pane in the tmux server's own cwd, `/` — not $HOME.
test('panes left in / are detected as lost directories too', async () => {
  const tmux = captureTmux();
  await withService({ tmux, settings: { repairCwd: false } }, async ({ service }) => {
    await service.save('before');
    const rooted = captureTmux();
    rooted.reply['list-panes'] = [
      'api\t1\t1\t%10\t/\tzsh',
      'web\t1\t1\t%13\t/\tzsh',
    ].join('\n') + '\n';
    service.tmux = rooted;
    const drift = await service.findCwdDrift(await service.readSnapshot());
    assert.deepEqual(
      drift.map((item) => [item.sessionName, item.actual, item.expected, item.repairable]),
      [['api', '/', '/work/api', true], ['web', '/', '/work/web', true]],
    );
  });
});

// Without this the snapshot poisons itself: a bad restore drops a pane into `/`,
// the next periodic snapshot records `/`, and the real directory is gone within
// minutes — which is exactly what happened on the first reported reboot.
test('a pane sitting in / never overwrites the last known-good directory', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service, filePath }) => {
    await service.save('before-reboot');
    const rooted = captureTmux();
    rooted.reply['list-panes'] = [
      '$0\t@0\t1\t1\t/\tzsh',
      '$0\t@1\t1\t1\t/\tnpm',
      '$0\t@1\t2\t0\t/\tzsh',
      '$1\t@2\t1\t1\t/work/web\tzsh',
    ].join('\n') + '\n';
    service.tmux = rooted;

    await service.save('after-bad-restore');
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    const api = stored.sessions.find((session) => session.name === 'api');
    // The snapshot tells the truth about where the panes are…
    assert.equal(api.windows[0].panes[0].path, '/');
    // …while still remembering where they belong.
    assert.equal(api.windows[0].panes[0].lastGoodPath, '/work/api');
    assert.equal(api.windows[1].panes[0].lastGoodPath, '/work/api/build');
    // A pane that never drifted carries no stale copy.
    const web = stored.sessions.find((session) => session.name === 'web');
    assert.equal(web.windows[0].panes[0].lastGoodPath, undefined);

    // And a later restore from this snapshot opens in the real directory.
    const restored = new FakeTmux({
      reply: { 'display-message': '9999\n', 'new-session': '$7\t@70\t1\n', 'new-window': '@71\n', 'list-panes': '' },
      dirs: ['/work/api', '/work/web', '/work/api/build'],
    });
    service.tmux = restored;
    await service.runStartupRecovery();
    const created = restored.calls.filter((args) => args[0] === 'new-session');
    assert.deepEqual(created[0].slice(-4), ['-s', 'api', '-c', '/work/api']);
  });
});

test('a directory that exists but cannot be entered is reported as denied, not missing', async () => {
  const tmux = captureTmux();
  await withService({ tmux, settings: { repairCwd: false } }, async ({ service }) => {
    await service.save('before');
    const blocked = captureTmux();
    blocked.dirs = new Set(); // tmux cannot stat it either
    blocked.reply['list-panes'] = 'api\t1\t1\t%10\t/\tzsh\n';
    service.dirDenied = (dir) => dir === '/work/api';
    service.tmux = blocked;
    const drift = await service.findCwdDrift(await service.readSnapshot());
    assert.equal(drift[0].blockedBy, 'denied');
    assert.equal(drift[0].repairable, false);
    service.state.cwdIssues = drift;
    const issue = service.health().issues.find((item) => item.id === 'cwd-denied');
    assert.ok(issue, 'a permission problem is the one the user can actually fix');
    assert.equal(issue.level, 'error');
  });
});

test('a cd that does not take effect is reported instead of counted as fixed', async () => {
  const tmux = captureTmux();
  await withService({ tmux, settings: { repairCwd: false } }, async ({ service }) => {
    await service.save('before');
    const busy = captureTmux();
    busy.reply['list-panes'] = 'api\t1\t1\t%10\t/\tzsh\n';
    // The shell was busy: it never left `/`.
    busy.reply['display-message'] = (args) => (args.includes('#{pane_current_path}') ? '/\n' : '4321\n');
    service.tmux = busy;
    const result = await service.repairCwd(await service.findCwdDrift(await service.readSnapshot()));
    assert.equal(result.repaired, 0);
    assert.equal(result.failed[0].message, 'cd-failed');
    const issue = service.health().issues.find((item) => item.id === 'repair-stuck');
    assert.ok(issue);
  });
});

test('drift matching survives a base-index change between snapshot and restore', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service }) => {
    await service.save('before');
    const shifted = captureTmux();
    // Same tree, renumbered from 0 instead of 1 — an index-only match would
    // find nothing and silently report "no drift".
    shifted.reply['list-panes'] = [
      'api\t0\t0\t%10\t/Users/demo\tzsh',
      'api\t1\t0\t%11\t/Users/demo\tzsh',
      'api\t1\t1\t%12\t/Users/demo\tzsh',
    ].join('\n') + '\n';
    service.tmux = shifted;
    const drift = await service.findCwdDrift(await service.readSnapshot());
    assert.deepEqual(
      drift.map((item) => [item.paneId, item.expected]),
      [['%10', '/work/api'], ['%11', '/work/api/build'], ['%12', '/work/api']],
    );
  });
});

test('a pane the user simply cd\'d somewhere else is left alone', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service }) => {
    await service.save('before');
    const moved = captureTmux();
    moved.reply['list-panes'] = 'api\t1\t1\t%10\t/somewhere/else\tzsh\n';
    service.tmux = moved;
    const drift = await service.findCwdDrift(await service.readSnapshot());
    assert.deepEqual(drift, []);
  });
});

test('a first launch with no snapshot yet still writes one instead of waiting for the timer', async () => {
  await withService({ tmux: captureTmux() }, async ({ service, filePath }) => {
    await service.runStartupRecovery();
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(stored.sessions.map((session) => session.name), ['api', 'web']);
  });
});

test('health exposes the snapshot and log paths so a user can hand the log back', async () => {
  await withService({ tmux: captureTmux() }, async ({ service, filePath }) => {
    const health = service.health();
    assert.equal(health.snapshotPath, filePath);
    assert.equal(health.logPath, filePath.replace(/\.json$/, '.log'));
    assert.equal(health.level, 'info');
    assert.ok(health.issues.some((issue) => issue.id === 'no-snapshot'));
  });
});

test('a missing directory is reported rather than silently dropping the session into $HOME', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service }) => {
    await service.save('before');
    const restored = new FakeTmux({
      reply: { 'display-message': '9999\n', 'new-session': '$7\t@70\t1\n', 'new-window': '@71\n' },
      dirs: ['/work/web'], // /work/api was deleted (or its volume is unmounted)
    });
    service.tmux = restored;
    await service.runStartupRecovery();
    const issue = service.health().issues.find((item) => item.id === 'missing-dirs');
    assert.ok(issue);
    assert.ok(issue.detail.includes('/work/api'));
    const newSessions = restored.calls.filter((args) => args[0] === 'new-session');
    assert.ok(!newSessions[0].includes('-c'), 'no -c at all beats a bogus one');
  });
});

test('a corrupted primary snapshot falls back to the previous copy', async () => {
  const tmux = captureTmux();
  await withService({ tmux }, async ({ service, filePath }) => {
    await service.save('first');
    await service.save('second'); // rotates the good copy into .prev.json
    await writeFile(filePath, '{ truncated', 'utf8');
    const snapshot = await service.readSnapshot();
    assert.equal(snapshot.sessions.length, 2);
  });
});

test('session restore settings are clamped to a sane range', () => {
  assert.deepEqual(normalizeSessionRestore({ intervalMinutes: 9999 }).intervalMinutes, 60);
  assert.deepEqual(normalizeSessionRestore({ intervalMinutes: 0 }).intervalMinutes, 1);
  assert.deepEqual(normalizeSessionRestore({ intervalMinutes: 'x' }).intervalMinutes, 3);
  assert.equal(normalizeSessionRestore(null).enabled, true);
  assert.equal(normalizeSessionRestore({ enabled: false }).enabled, false);
});

test('the log rotates instead of growing without bound', async () => {
  await withService({ tmux: captureTmux() }, async ({ service, root }) => {
    await mkdir(root, { recursive: true });
    await writeFile(service.logPath, 'x'.repeat(600 * 1024), 'utf8');
    await service.log('info', 'after rotation');
    const current = await readFile(service.logPath, 'utf8');
    assert.ok(current.length < 1024);
    const rotated = await readFile(`${service.logPath}.1`, 'utf8');
    assert.equal(rotated.length, 600 * 1024);
  });
});

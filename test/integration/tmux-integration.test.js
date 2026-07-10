const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, realpath, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const { TmuxService } = require('../../src/main/tmux-service');

const execFileAsync = promisify(execFile);

test('real tmux lifecycle stays isolated on its own socket', { timeout: 15000 }, async (t) => {
  const probe = new TmuxService();
  const tmuxPath = await probe.resolveTmuxPath();
  if (!tmuxPath) return t.skip('tmux is not installed');

  const socketName = `tmux-desk-test-${process.pid}-${Date.now()}`;
  const root = await mkdtemp(join(tmpdir(), 'tmux-desk-integration-'));
  const canonicalRoot = await realpath(root);
  const globalArgs = ['-L', socketName];
  const service = new TmuxService({ tmuxPath, socketName });
  t.after(async () => {
    try { await execFileAsync(tmuxPath, [...globalArgs, 'kill-server']); } catch {}
    await rm(root, { recursive: true, force: true });
  });

  const created = await service.createSession({ name: 'alpha', cwd: root, startupCommand: '' });
  assert.match(created.id, /^\$\d+$/);
  const initialDetail = await service.getSessionDetail(created.id);
  assert.equal(initialDetail.windows.length, 1);
  await execFileAsync(tmuxPath, [...globalArgs, 'new-window', '-d', '-t', created.id, '-n', 'logs', '-c', root]);
  await execFileAsync(tmuxPath, [...globalArgs, 'split-window', '-d', '-t', initialDetail.windows[0].id, '-c', root]);

  const sessions = await service.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, 'alpha');
  assert.equal(sessions[0].windows, 2);
  assert.equal(sessions[0].paneCount, 3);

  const detail = await service.getSessionDetail(created.id);
  assert.equal(detail.windows.length, 2);
  assert.equal(detail.panes.length, 3);
  assert.equal(detail.panes.every((pane) => pane.path === canonicalRoot), true);
  await service.selectWindow(detail.windows[1].id);
  await service.selectPane(detail.panes[0].id);

  await service.renameSession(created.id, 'beta');
  assert.equal((await service.listSessions())[0].name, 'beta');
  await service.killSession(created.id);
  assert.deepEqual(await service.listSessions(), []);
});

const fs = require('node:fs/promises');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tmux Desk keeps its own session snapshot instead of relying on the user
// having tmux-resurrect/tmux-continuum installed. Two real-world failures drove
// this:
//   1. after a reboot every session was gone (no restore plugin at all — tags
//      survive because they live in preferences.json, which is why users report
//      "only the tags are left");
//   2. sessions came back but every pane sat in $HOME instead of its project
//      directory (a restore plugin recreated the windows without a usable cwd).
// So we snapshot name/window/pane/layout/cwd periodically, recreate whatever is
// missing when the tmux server comes back with a new pid, and can repair panes
// that were resurrected into $HOME. Everything it does is written to a log file
// whose absolute path is surfaced in the UI, so a user can hand it back.
const SNAPSHOT_VERSION = 1;
const WEB_SESSION_PREFIX = '_web_';
// Only a shell's stdin is safe to type a `cd` into; anything else is a running
// program (vim, an agent, a pager) whose input we must never touch.
const SHELL_COMMANDS = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'elvish', 'xonsh',
]);
const MAX_LOG_BYTES = 512 * 1024;
const MAX_SNAPSHOT_SESSIONS = 200;
const SAVE_DEBOUNCE_MS = 2500;
const SETTLE_POLL_MS = 400;
const SETTLE_TIMEOUT_MS = 10_000;
// A tmux server that is mid-restore right after a reboot can fail reads for a
// while ("no current target" while it has no session yet). Startup recovery
// retries instead of giving up for the whole app lifetime — giving up meant
// neither the restore nor the working-directory repair ever ran.
const RECOVERY_RETRIES = 4;
const RECOVERY_RETRY_MS = 5000;
// `/` is what a pane gets when nobody ever gave it a directory: it is the tmux
// server's own cwd, so a restore that could not apply a directory lands there.
// Nobody works in `/`, so it is never a real user choice — which is what makes
// it safe to treat as "directory lost" and to refuse to record over a good one.
const LOST_DIR = '/';

const DEFAULT_SESSION_RESTORE = Object.freeze({
  enabled: true,
  autoRestore: true,
  repairCwd: true,
  intervalMinutes: 3,
});

function parseRecords(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
}

function errorMessage(error) {
  const message = String((error && error.message) || error || '').trim();
  return message || 'unknown error';
}

function errorCode(error) {
  return (error && typeof error.code === 'string') ? error.code : null;
}

function isRealSession(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith(WEB_SESSION_PREFIX);
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// `cd` typed into a shell: single quotes are the only thing that needs care,
// and POSIX shells all understand the '\'' escape.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeSessionRestore(value) {
  const source = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
  const minutes = Number.isInteger(source.intervalMinutes)
    ? Math.min(60, Math.max(1, source.intervalMinutes))
    : DEFAULT_SESSION_RESTORE.intervalMinutes;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SESSION_RESTORE.enabled,
    autoRestore: typeof source.autoRestore === 'boolean' ? source.autoRestore : DEFAULT_SESSION_RESTORE.autoRestore,
    repairCwd: typeof source.repairCwd === 'boolean' ? source.repairCwd : DEFAULT_SESSION_RESTORE.repairCwd,
    intervalMinutes: minutes,
  };
}

// Fold the flat `list-sessions` / `list-windows -a` / `list-panes -a` records
// into the nested shape we persist.
function buildSnapshot({ sessionRows, windowRows, paneRows, serverPid, savedAt }) {
  const sessions = new Map();
  for (const [id, name, sessionPath] of sessionRows) {
    if (!isRealSession(name)) continue;
    sessions.set(id, { name, path: sessionPath || null, windows: [] });
  }
  // Keyed by session+window, never window alone: a grouped session (the `_web_*`
  // ones the web server derives) shares window ids with its source, so a plain
  // window-id key would file the grouped session's panes under the real one and
  // double every pane in the snapshot.
  const windows = new Map();
  for (const [sessionId, windowId, index, name, active, autoRename, layout] of windowRows) {
    const session = sessions.get(sessionId);
    if (!session) continue;
    const window = {
      index: toInt(index),
      // An automatically renamed window derives its name from the running
      // command; restoring that name would pin it (rename-window turns
      // automatic-rename off), so only manual names are worth keeping.
      name: autoRename === '1' ? null : (name || null),
      active: active === '1',
      layout: layout || null,
      panes: [],
    };
    session.windows.push(window);
    windows.set(`${sessionId}\t${windowId}`, window);
  }
  for (const [sessionId, windowId, index, active, panePath, command] of paneRows) {
    const window = windows.get(`${sessionId}\t${windowId}`);
    if (!window) continue;
    window.panes.push({
      index: toInt(index),
      active: active === '1',
      path: panePath || null,
      command: command || null,
    });
  }
  const list = [...sessions.values()].slice(0, MAX_SNAPSHOT_SESSIONS);
  for (const session of list) {
    session.windows.sort((left, right) => left.index - right.index);
    for (const window of session.windows) window.panes.sort((left, right) => left.index - right.index);
  }
  return {
    version: SNAPSHOT_VERSION,
    savedAt,
    host: os.hostname(),
    serverPid,
    sessions: list,
  };
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sessions)) return null;
  const sessions = [];
  for (const session of value.sessions) {
    if (!session || typeof session !== 'object' || !isRealSession(session.name)) continue;
    const windows = Array.isArray(session.windows) ? session.windows : [];
    sessions.push({
      name: session.name,
      path: typeof session.path === 'string' ? session.path : null,
      windows: windows.map((window) => ({
        index: toInt(window && window.index),
        name: typeof window?.name === 'string' && window.name ? window.name : null,
        active: window?.active === true,
        layout: typeof window?.layout === 'string' && window.layout ? window.layout : null,
        panes: (Array.isArray(window?.panes) ? window.panes : []).map((pane) => ({
          index: toInt(pane && pane.index),
          active: pane?.active === true,
          path: typeof pane?.path === 'string' && pane.path ? pane.path : null,
          // Survives restores that dropped the directory; see carryLastGoodPaths.
          ...(typeof pane?.lastGoodPath === 'string' && pane.lastGoodPath
            ? { lastGoodPath: pane.lastGoodPath }
            : {}),
          command: typeof pane?.command === 'string' && pane.command ? pane.command : null,
        })),
      })),
    });
  }
  return {
    version: toInt(value.version, SNAPSHOT_VERSION),
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
    host: typeof value.host === 'string' ? value.host : null,
    serverPid: Number.isFinite(value.serverPid) ? value.serverPid : null,
    sessions,
  };
}

// Pair snapshot children with live/previous ones. Indices are the truth when
// they all line up; otherwise fall back to position, but only when the counts
// match exactly — base-index / pane-base-index can differ between a snapshot
// and a restore, and mixing the two strategies maps several snapshot panes onto
// the same live pane.
function pairByIndexThenPosition(left, right) {
  const items = right || [];
  const byIndex = (item) => items.find((other) => other.index === item.index) || null;
  // Every index accounted for: indices are the mapping.
  if (left.every((item) => byIndex(item))) return left.map((item) => [item, byIndex(item)]);
  // Nothing lines up but the counts do: the whole thing was renumbered.
  if (left.length === items.length) return left.map((item, position) => [item, items[position]]);
  // Otherwise something was added or closed since the snapshot — match whatever
  // the indices still resolve, and leave the rest unpaired rather than guessing.
  return left.map((item) => [item, byIndex(item)]);
}

// The directory the snapshot should aim a repair at: the last one we ever saw
// this pane actually in, which survives any number of restores that dropped it.
function targetDir(pane) {
  return pane.lastGoodPath || pane.path || null;
}

// Carry a pane's last known-good directory forward. Without this the snapshot
// poisons itself: a restore drops a pane into `/`, the next periodic snapshot
// records `/`, and the real directory is gone within minutes — exactly what
// happened on the first reported reboot.
function carryLastGoodPaths(snapshot, previous) {
  if (!previous) return snapshot;
  const previousByName = new Map(previous.sessions.map((session) => [session.name, session]));
  for (const session of snapshot.sessions) {
    const before = previousByName.get(session.name);
    if (!before) continue;
    for (const [window, priorWindow] of pairByIndexThenPosition(session.windows, before.windows)) {
      if (!priorWindow) continue;
      for (const [pane, priorPane] of pairByIndexThenPosition(window.panes, priorWindow.panes)) {
        if (!priorPane || pane.path !== LOST_DIR) continue;
        const good = targetDir(priorPane);
        if (good && good !== LOST_DIR) pane.lastGoodPath = good;
      }
    }
  }
  return snapshot;
}

// The directory a window has to be *created* in is pane 1's, not the active
// pane's: new-window/new-session opens exactly one pane and the rest are split
// off it with their own -c. Using the active pane here silently gave every
// first pane whichever directory happened to be focused at snapshot time.
function windowOpenDir(window) {
  if (!window || !Array.isArray(window.panes) || !window.panes.length) return null;
  const ordered = [...window.panes].sort((left, right) => left.index - right.index);
  return targetDir(ordered[0]);
}

class SessionSnapshotService {
  constructor({
    tmuxService,
    preferencesStore,
    filePath,
    fsImpl,
    homeDir,
    now,
    onChange,
    settlePollMs,
    settleTimeoutMs,
  } = {}) {
    if (!tmuxService) throw new Error('缺少 tmux 服务');
    if (typeof filePath !== 'string' || !filePath) throw new Error('快照文件路径无效');
    this.tmux = tmuxService;
    this.preferencesStore = preferencesStore || null;
    this.fs = fsImpl || fs;
    this.filePath = filePath;
    this.previousPath = filePath.replace(/\.json$/i, '') + '.prev.json';
    this.logPath = filePath.replace(/\.json$/i, '') + '.log';
    this.home = homeDir || os.homedir();
    this.settlePollMs = settlePollMs || SETTLE_POLL_MS;
    this.settleTimeoutMs = settleTimeoutMs == null ? SETTLE_TIMEOUT_MS : settleTimeoutMs;
    this.now = now || (() => new Date());
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.saveTimer = null;
    this.intervalTimer = null;
    this.saveQueue = Promise.resolve();
    this.logQueue = Promise.resolve();
    this.recoveryAttempt = 0;
    this.state = {
      startedAt: null,
      settings: { ...DEFAULT_SESSION_RESTORE },
      lastSaveAt: null,
      lastSaveError: null,
      lastSaveSkipped: null,
      liveSessionCount: null,
      snapshotAt: null,
      snapshotSessionCount: 0,
      restore: null,
      cwdIssues: [],
      lastRepairAt: null,
      lastRepairFailures: [],
      lastReadError: null,
      tmuxError: null,
    };
  }

  // ---------------------------------------------------------------- logging

  log(level, message, detail) {
    const line = `${this.now().toISOString()} [${level}] ${message}${detail ? ` :: ${detail}` : ''}\n`;
    this.logQueue = this.logQueue
      .then(async () => {
        await this.fs.mkdir(path.dirname(this.logPath), { recursive: true });
        try {
          const stat = await this.fs.stat(this.logPath);
          // One rotation is enough: the log is a support artifact, not history.
          if (stat.size > MAX_LOG_BYTES) await this.fs.rename(this.logPath, `${this.logPath}.1`);
        } catch { /* no log yet */ }
        await this.fs.appendFile(this.logPath, line, 'utf8');
      })
      .catch(() => {});
    return this.logQueue;
  }

  // ------------------------------------------------------------- tmux reads

  async settings() {
    if (!this.preferencesStore) return { ...DEFAULT_SESSION_RESTORE };
    try {
      const preferences = await this.preferencesStore.load();
      return normalizeSessionRestore(preferences.sessionRestore);
    } catch {
      return { ...DEFAULT_SESSION_RESTORE };
    }
  }

  async serverPid() {
    try {
      const { stdout } = await this.tmux.run(['display-message', '-p', '#{pid}']);
      const pid = Number.parseInt(String(stdout || '').trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  // [] = the server is up and has no sessions; null = could not be read at all.
  // The difference matters at startup: a server that is mid-restore right after
  // a reboot answers "no current target" for a while, and treating that as
  // "no sessions" (or as fatal) is how a whole recovery gets skipped.
  async liveSessionNames() {
    try {
      const sessions = await this.tmux.listSessions();
      return sessions.filter((session) => isRealSession(session.name)).map((session) => session.name);
    } catch (error) {
      if (errorCode(error) === 'NO_SERVER') return [];
      this.state.lastReadError = errorMessage(error);
      return null;
    }
  }

  async capture() {
    const serverPid = await this.serverPid();
    let sessionRows = [];
    try {
      sessionRows = parseRecords((await this.tmux.run([
        'list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_path}',
      ])).stdout);
    } catch (error) {
      if (errorCode(error) !== 'NO_SERVER') throw error;
    }
    if (!sessionRows.length) {
      return buildSnapshot({
        sessionRows: [], windowRows: [], paneRows: [], serverPid, savedAt: this.now().toISOString(),
      });
    }
    const windowRows = parseRecords((await this.tmux.run([
      'list-windows', '-a', '-F',
      '#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{automatic-rename}\t#{window_layout}',
    ])).stdout);
    const paneRows = parseRecords((await this.tmux.run([
      'list-panes', '-a', '-F',
      '#{session_id}\t#{window_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}\t#{pane_current_command}',
    ])).stdout);
    return buildSnapshot({ sessionRows, windowRows, paneRows, serverPid, savedAt: this.now().toISOString() });
  }

  // -------------------------------------------------------------- snapshot IO

  async readSnapshot() {
    for (const candidate of [this.filePath, this.previousPath]) {
      try {
        const snapshot = normalizeSnapshot(JSON.parse(await this.fs.readFile(candidate, 'utf8')));
        if (snapshot) {
          if (candidate !== this.filePath) {
            this.log('warn', '主快照不可用，改用上一份快照', candidate);
          }
          return snapshot;
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          this.log('error', `读取快照失败 ${candidate}`, errorMessage(error));
        }
      }
    }
    return null;
  }

  async writeSnapshot(snapshot) {
    const temporaryPath = `${this.filePath}.tmp`;
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Keep the last good snapshot next to the new one: a half-written or
    // truncated primary must never be the only copy of the user's sessions.
    try { await this.fs.copyFile(this.filePath, this.previousPath); } catch { /* first run */ }
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      try { await this.fs.unlink(temporaryPath); } catch {}
      throw error;
    }
  }

  // --------------------------------------------------------------- saving

  scheduleSave(reason = 'change', delay = SAVE_DEBOUNCE_MS) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save(reason).catch(() => {});
    }, delay);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  save(reason = 'manual') {
    const operation = this.saveQueue.then(() => this.performSave(reason));
    this.saveQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async performSave(reason) {
    const settings = await this.settings();
    this.state.settings = settings;
    if (!settings.enabled) {
      this.state.lastSaveSkipped = 'disabled';
      this.emitChange();
      return { ok: false, skipped: 'disabled' };
    }
    let snapshot;
    try {
      snapshot = carryLastGoodPaths(await this.capture(), await this.readSnapshot());
    } catch (error) {
      this.state.lastSaveError = { message: errorMessage(error), code: errorCode(error) };
      this.state.tmuxError = this.state.lastSaveError;
      this.log('error', `快照失败（${reason}）`, errorMessage(error));
      this.emitChange();
      return { ok: false, error: this.state.lastSaveError };
    }
    this.state.tmuxError = null;
    this.state.liveSessionCount = snapshot.sessions.length;
    // The single most destructive thing this feature could do is overwrite a
    // good snapshot with an empty one because tmux happened to be down. An
    // empty capture is only ever written when the stored snapshot is empty too.
    if (!snapshot.sessions.length) {
      const stored = await this.readSnapshot();
      if (stored && stored.sessions.length) {
        this.state.lastSaveSkipped = 'empty';
        this.state.snapshotAt = stored.savedAt;
        this.state.snapshotSessionCount = stored.sessions.length;
        this.log('warn', `跳过写入：当前 0 个会话，保留已有快照（${stored.sessions.length} 个会话）`, reason);
        this.emitChange();
        return { ok: false, skipped: 'empty' };
      }
    }
    try {
      await this.writeSnapshot(snapshot);
    } catch (error) {
      this.state.lastSaveError = { message: errorMessage(error), code: errorCode(error) };
      this.log('error', `写入快照失败（${reason}）`, `${this.filePath} :: ${errorMessage(error)}`);
      this.emitChange();
      return { ok: false, error: this.state.lastSaveError };
    }
    this.state.lastSaveError = null;
    this.state.lastSaveSkipped = null;
    this.state.lastSaveAt = snapshot.savedAt;
    this.state.snapshotAt = snapshot.savedAt;
    this.state.snapshotSessionCount = snapshot.sessions.length;
    this.log('info', `快照已保存（${reason}）`, `${snapshot.sessions.length} 个会话 -> ${this.filePath}`);
    this.emitChange();
    return { ok: true, sessions: snapshot.sessions.length };
  }

  // -------------------------------------------------------------- restoring

  // A restore plugin (tmux-continuum) may still be repopulating the server we
  // just woke up. Wait until the session count stops moving before deciding
  // what is missing, otherwise we race it and create duplicates.
  async waitForServerToSettle() {
    const deadline = Date.now() + this.settleTimeoutMs;
    const pause = () => new Promise((resolve) => setTimeout(resolve, this.settlePollMs));
    let previous = await this.liveSessionNames();
    if (!previous || !previous.length) {
      // Nothing yet, or not readable yet — give the tmux server (and any
      // foreign restore plugin) its chance to come up.
      while (Date.now() < deadline) {
        await pause();
        const current = await this.liveSessionNames();
        if (current && current.length) { previous = current; break; }
        if (current && !previous) previous = current;
      }
      if (!previous || !previous.length) return previous;
    }
    // Sessions exist: wait for the count to hold still for one poll.
    while (Date.now() < deadline) {
      await pause();
      const current = await this.liveSessionNames();
      if (!current) continue;
      if (current.length === previous.length) return current;
      previous = current;
    }
    return previous;
  }

  async dirFor(candidate, fallback) {
    if (typeof candidate === 'string' && candidate && this.tmux.dirExists(candidate)) return candidate;
    if (typeof fallback === 'string' && fallback && this.tmux.dirExists(fallback)) return fallback;
    return null;
  }

  async restoreSession(session, report) {
    const windows = [...session.windows].sort((left, right) => left.index - right.index);
    const first = windows[0] || { index: 0, name: null, active: true, layout: null, panes: [] };
    const wanted = windowOpenDir(first) || session.path;
    const dir = await this.dirFor(wanted, session.path);
    if (wanted && !dir) {
      report.missingDirs.push({ session: session.name, path: wanted });
      this.log('warn', `工作目录不存在，改用默认目录：${session.name}`, wanted);
    }
    const created = parseRecords((await this.tmux.run([
      'new-session', '-d', '-P', '-F', '#{session_id}\t#{window_id}\t#{window_index}',
      '-s', session.name,
      ...(dir ? ['-c', dir] : []),
    ])).stdout)[0] || [];
    const [sessionId, firstWindowId, firstWindowIndex] = created;
    if (!sessionId || !firstWindowId) throw new Error('tmux 未返回新会话标识');
    if (toInt(firstWindowIndex, -1) !== first.index) {
      try {
        await this.tmux.run(['move-window', '-d', '-s', firstWindowId, '-t', `${sessionId}:${first.index}`]);
      } catch { /* index taken or renumber-windows on — order still holds */ }
    }
    if (first.name) {
      try { await this.tmux.run(['rename-window', '-t', firstWindowId, first.name]); } catch {}
    }
    await this.restoreWindowPanes(firstWindowId, first, session, report);

    for (const window of windows.slice(1)) {
      const wantedDir = windowOpenDir(window) || session.path;
      const windowDir = await this.dirFor(wantedDir, session.path);
      if (wantedDir && !windowDir) report.missingDirs.push({ session: session.name, path: wantedDir });
      const args = [
        '-d', '-P', '-F', '#{window_id}',
        ...(window.name ? ['-n', window.name] : []),
        ...(windowDir ? ['-c', windowDir] : []),
      ];
      let windowId = null;
      try {
        windowId = String((await this.tmux.run(['new-window', ...args, '-t', `${sessionId}:${window.index}`])).stdout || '').trim();
      } catch {
        // The index is taken (renumber-windows, or a gap the server closed) —
        // appending keeps the order, which is what actually matters.
        windowId = String((await this.tmux.run(['new-window', ...args, '-t', sessionId])).stdout || '').trim();
      }
      if (windowId) await this.restoreWindowPanes(windowId, window, session, report);
    }

    const activeWindow = windows.find((window) => window.active);
    if (activeWindow) {
      try {
        await this.tmux.run(['select-window', '-t', `${sessionId}:${activeWindow.index}`]);
      } catch { /* index may have shifted; leaving tmux's choice is fine */ }
    }
    return sessionId;
  }

  async restoreWindowPanes(windowId, window, session, report) {
    const panes = [...(window.panes || [])].sort((left, right) => left.index - right.index);
    for (const pane of panes.slice(1)) {
      const paneDir = await this.dirFor(pane.path, session.path);
      if (pane.path && !paneDir) report.missingDirs.push({ session: session.name, path: pane.path });
      try {
        await this.tmux.run([
          'split-window', '-d', '-t', windowId,
          ...(paneDir ? ['-c', paneDir] : []),
        ]);
      } catch (error) {
        this.log('warn', `恢复分屏失败：${session.name}`, errorMessage(error));
        break;
      }
    }
    if (window.layout && panes.length > 1) {
      try { await this.tmux.run(['select-layout', '-t', windowId, window.layout]); } catch {}
    }
    // Target by the recorded pane_index, not the array position: pane numbering
    // starts at pane-base-index (1 in the app's profile), so position 0 is
    // usually pane 1.
    const active = panes.find((pane) => pane.active);
    if (active && active !== panes[0]) {
      try { await this.tmux.run(['select-pane', '-t', `${windowId}.${active.index}`]); } catch {}
    }
  }

  async restoreMissing({ snapshot, existingNames, reason }) {
    const report = { reason, restored: [], failed: [], missingDirs: [], at: this.now().toISOString() };
    const existing = new Set(existingNames);
    for (const session of snapshot.sessions) {
      if (existing.has(session.name)) continue;
      try {
        await this.restoreSession(session, report);
        report.restored.push(session.name);
        this.log('info', `已恢复会话：${session.name}`, `${session.windows.length} 个窗口`);
      } catch (error) {
        report.failed.push({ name: session.name, message: errorMessage(error) });
        this.log('error', `恢复会话失败：${session.name}`, errorMessage(error));
      }
    }
    return report;
  }

  // ------------------------------------------------------- cwd drift repair

  // Panes a foreign restore plugin brought back in $HOME instead of the project
  // directory. Match by window index + pane index, which every restore plugin
  // preserves, and only ever touch an idle shell.
  async findCwdDrift(snapshot) {
    const drift = [];
    let paneRows = [];
    try {
      paneRows = parseRecords((await this.tmux.run([
        'list-panes', '-a', '-F',
        '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_path}\t#{pane_current_command}',
      ])).stdout);
    } catch (error) {
      if (errorCode(error) !== 'NO_SERVER') throw error;
      return drift;
    }
    // sessionName -> windowIndex -> ordered live panes
    const live = new Map();
    for (const [sessionName, windowIndex, paneIndex, paneId, panePath, command] of paneRows) {
      if (!live.has(sessionName)) live.set(sessionName, new Map());
      const windows = live.get(sessionName);
      const index = toInt(windowIndex);
      if (!windows.has(index)) windows.set(index, []);
      windows.get(index).push({ index: toInt(paneIndex), paneId, path: panePath, command });
    }

    for (const session of snapshot.sessions) {
      const windows = live.get(session.name);
      if (!windows) continue;
      const liveWindows = [...windows.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, panes]) => ({ index, panes }));
      for (const [window, liveWindow] of pairByIndexThenPosition(session.windows, liveWindows)) {
        if (!liveWindow) continue;
        const ordered = [...liveWindow.panes].sort((left, right) => left.index - right.index);
        for (const [pane, livePane] of pairByIndexThenPosition(window.panes, ordered)) {
          const expected = targetDir(pane);
          if (!livePane || !expected || expected === livePane.path) continue;
          // Two shapes count as "the restore lost this directory":
          //   `/`     — the tmux server's own cwd, what a pane gets when no
          //             directory could be applied (the shape actually seen in
          //             the field), and never somewhere a user works;
          //   $HOME   — the other common fallback.
          // Anything else is a directory the user chose, and is left alone.
          if (livePane.path !== this.home && livePane.path !== LOST_DIR) continue;
          if (expected === livePane.path) continue;
          const isShell = SHELL_COMMANDS.has(String(livePane.command || '').replace(/^-/, ''));
          drift.push({
            sessionName: session.name,
            paneId: livePane.paneId,
            windowIndex: liveWindow.index,
            paneIndex: livePane.index,
            expected,
            actual: livePane.path,
            command: livePane.command || null,
            // Why a pane cannot be fixed is worth as much as the fix: a busy
            // pane, a deleted directory and an unreadable one need different
            // things from the user, so the panel names which one it is.
            blockedBy: !this.tmux.dirExists(expected)
              ? (this.dirDenied(expected) ? 'denied' : 'missing')
              : (isShell ? null : 'busy'),
            repairable: isShell && this.tmux.dirExists(expected),
          });
        }
      }
    }
    return drift;
  }

  // Tell "the directory is gone" apart from "it exists but this process may not
  // enter it" (a protected or not-yet-unlocked location). They read the same to
  // a `cd`, but only one of them is something the user can grant.
  dirDenied(dir) {
    try {
      nodeFs.accessSync(dir, nodeFs.constants.X_OK);
      return false;
    } catch (error) {
      return errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM';
    }
  }

  async repairCwd(drift) {
    const all = drift || this.state.cwdIssues;
    const targets = all.filter((item) => item.repairable);
    const repaired = [];
    const failed = all.filter((item) => !item.repairable)
      .map((item) => ({ ...item, message: item.blockedBy || 'blocked' }));
    for (const item of targets) {
      try {
        // C-u first: anything already sitting at the prompt would otherwise be
        // prefixed onto our command (`cd cd -- '/x'` → "too many arguments",
        // seen in the field). These panes are freshly restored shells, so the
        // only thing C-u can discard is stale unexecuted text.
        await this.tmux.run(['send-keys', '-t', item.paneId, 'C-u']);
        await this.tmux.run(['send-keys', '-t', item.paneId, '-l', `cd -- ${shellQuote(item.expected)}`]);
        await this.tmux.run(['send-keys', '-t', item.paneId, 'Enter']);
        repaired.push(item);
      } catch (error) {
        failed.push({ ...item, message: errorMessage(error) });
        this.log('error', `修复工作目录失败：${item.sessionName}`, errorMessage(error));
      }
    }
    // Typing a `cd` is a request, not a result — the shell may have been busy,
    // or the directory may have become unreadable since the check. Read the
    // panes back so a failure is reported instead of silently assumed fixed.
    const landed = repaired.length ? await this.verifyRepaired(repaired) : { ok: [], stuck: [] };
    for (const item of landed.stuck) {
      failed.push({ ...item, message: 'cd-failed' });
      this.log('error', `修复未生效：${item.sessionName} ${item.windowIndex}.${item.paneIndex}`, item.expected);
    }
    for (const item of landed.ok) {
      this.log('info', `已修复工作目录：${item.sessionName} ${item.windowIndex}.${item.paneIndex}`, item.expected);
    }
    this.state.lastRepairAt = this.now().toISOString();
    this.state.lastRepairFailures = failed;
    const fixedIds = new Set(landed.ok.map((item) => item.paneId));
    this.state.cwdIssues = this.state.cwdIssues.filter((item) => !fixedIds.has(item.paneId));
    this.emitChange();
    return { repaired: landed.ok.length, failed };
  }

  async verifyRepaired(items, delayMs = 600) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const ok = [];
    const stuck = [];
    for (const item of items) {
      let current = null;
      try {
        current = String((await this.tmux.run([
          'display-message', '-p', '-t', item.paneId, '#{pane_current_path}',
        ])).stdout || '').trim();
      } catch { /* pane went away; treat as unverified */ }
      if (current === item.expected) ok.push(item);
      else stuck.push({ ...item, actual: current || item.actual });
    }
    return { ok, stuck };
  }

  // ---------------------------------------------------------------- startup

  // The whole reboot story in one pass: wait out any foreign restore plugin,
  // recreate what the snapshot says should exist but doesn't, then look for
  // panes that came back in the wrong directory.
  async runStartupRecovery() {
    const settings = await this.settings();
    this.state.settings = settings;
    this.state.startedAt = this.now().toISOString();
    if (!settings.enabled) {
      this.emitChange();
      return null;
    }
    const snapshot = await this.readSnapshot();
    this.state.snapshotAt = snapshot ? snapshot.savedAt : null;
    this.state.snapshotSessionCount = snapshot ? snapshot.sessions.length : 0;

    let live = null;
    try {
      live = await this.waitForServerToSettle();
    } catch (error) {
      this.state.lastReadError = errorMessage(error);
    }
    if (!live) {
      // Reading tmux failed for the whole settle window. Retrying matters more
      // than reporting: giving up here means neither the restore nor the
      // working-directory repair ever runs for this launch.
      this.state.tmuxError = { message: this.state.lastReadError || 'tmux 无响应', code: null };
      this.log('error', `启动检查暂时读不到 tmux 会话，${RECOVERY_RETRY_MS / 1000}s 后重试`, this.state.lastReadError);
      this.emitChange();
      if (this.recoveryAttempt < RECOVERY_RETRIES) {
        this.recoveryAttempt += 1;
        await new Promise((resolve) => setTimeout(resolve, RECOVERY_RETRY_MS));
        return this.runStartupRecovery();
      }
      this.log('error', '启动检查放弃重试', `已重试 ${RECOVERY_RETRIES} 次`);
      return null;
    }
    this.state.tmuxError = null;
    this.state.liveSessionCount = live.length;
    if (!snapshot || !snapshot.sessions.length) {
      // First launch (or a wiped snapshot): there is nothing to restore, but
      // there is something to save — waiting for the interval timer would leave
      // a fresh install unprotected for minutes, and unprotected entirely if
      // the app is closed before the first tick.
      this.log('info', '启动检查：还没有可用快照，先保存一份', `${live.length} 个在线会话`);
      await this.save('startup-first');
      return null;
    }

    const pid = await this.serverPid();
    const serverRestarted = !snapshot.serverPid || !pid || pid !== snapshot.serverPid;
    const missing = snapshot.sessions.filter((session) => !live.includes(session.name));
    this.log('info', '启动检查', [
      `在线 ${live.length}`,
      `快照 ${snapshot.sessions.length}（${snapshot.savedAt || '时间未知'}）`,
      `tmux server pid ${pid ?? '无'}（快照 ${snapshot.serverPid ?? '无'}）`,
      `缺失 ${missing.length}`,
    ].join(' / '));

    let report = null;
    if (missing.length && serverRestarted && settings.autoRestore) {
      report = await this.restoreMissing({ snapshot, existingNames: live, reason: 'startup' });
    } else if (missing.length && !serverRestarted) {
      // Same tmux server as the snapshot: those sessions were closed on
      // purpose, so re-creating them would fight the user.
      this.log('info', 'tmux server 未重启，跳过恢复', `缺失 ${missing.length} 个会话按“用户主动关闭”处理`);
    } else if (missing.length && !settings.autoRestore) {
      report = { reason: 'startup', restored: [], failed: [], missingDirs: [], pending: missing.map((s) => s.name), at: this.now().toISOString() };
      this.log('info', '自动恢复已关闭，等待手动恢复', missing.map((s) => s.name).join(', '));
    }
    this.state.restore = report;

    try {
      const drift = await this.findCwdDrift(snapshot);
      if (drift.length) {
        this.log('warn', `检测到 ${drift.length} 个面板停在 ${this.home}`, drift.map((item) => `${item.sessionName}:${item.windowIndex}.${item.paneIndex} -> ${item.expected}`).join(' | '));
      }
      this.state.cwdIssues = drift;
      if (drift.length && settings.repairCwd) {
        const result = await this.repairCwd(drift);
        this.log('info', `自动修复工作目录：${result.repaired} 个面板`, result.failed.length ? `${result.failed.length} 个失败` : '');
      }
    } catch (error) {
      this.log('error', '工作目录检查失败', errorMessage(error));
    }

    await this.save('startup');
    return this.state.restore;
  }

  async restoreNow() {
    const snapshot = await this.readSnapshot();
    if (!snapshot || !snapshot.sessions.length) throw new Error('还没有可用的会话快照');
    const live = await this.liveSessionNames();
    const report = await this.restoreMissing({ snapshot, existingNames: live, reason: 'manual' });
    this.state.restore = report;
    this.state.liveSessionCount = live.length + report.restored.length;
    this.emitChange();
    await this.save('after-restore');
    return report;
  }

  // Recovery first (it ends with its own save), then arm the periodic snapshot.
  start() {
    return this.runStartupRecovery()
      .catch((error) => {
        this.log('error', '启动恢复流程异常', errorMessage(error));
        return null;
      })
      .then(async (report) => {
        const settings = this.state.settings;
        if (settings.enabled) {
          this.intervalTimer = setInterval(() => {
            this.save('interval').catch(() => {});
          }, Math.max(1, settings.intervalMinutes) * 60_000);
          if (typeof this.intervalTimer.unref === 'function') this.intervalTimer.unref();
        }
        return report;
      });
  }

  // Settings changed: re-arm the interval on the new period and snapshot now so
  // switching the feature on has an immediate, visible effect.
  restart() {
    const settings = this.settings();
    return settings.then((next) => {
      this.state.settings = next;
      if (this.intervalTimer) clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      if (!next.enabled) { this.emitChange(); return null; }
      this.intervalTimer = setInterval(() => {
        this.save('interval').catch(() => {});
      }, Math.max(1, next.intervalMinutes) * 60_000);
      if (typeof this.intervalTimer.unref === 'function') this.intervalTimer.unref();
      return this.save('settings-changed');
    }).catch(() => null);
  }

  dispose() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null; }
  }

  emitChange() {
    try { this.onChange(this.health()); } catch { /* renderer may be gone */ }
  }

  // ------------------------------------------------------------------ health

  // What the "!" button in the workspace header renders. `issues` is the whole
  // contract: each one carries its own remediation text and the actions the UI
  // is allowed to offer.
  health() {
    const state = this.state;
    const issues = [];
    if (!state.settings.enabled) {
      issues.push({ id: 'disabled', level: 'warn', titleKey: 'snapshot.issue.disabled', actions: ['enable'] });
    }
    if (state.tmuxError) {
      issues.push({
        id: 'tmux',
        level: 'error',
        titleKey: state.tmuxError.code === 'TMUX_NOT_FOUND' ? 'snapshot.issue.tmuxMissing' : 'snapshot.issue.tmuxError',
        detail: state.tmuxError.message,
        actions: ['save'],
      });
    } else if (state.lastSaveError) {
      issues.push({
        id: 'save',
        level: 'error',
        titleKey: 'snapshot.issue.saveFailed',
        detail: state.lastSaveError.message,
        actions: ['save', 'reveal'],
      });
    }
    if (state.lastSaveSkipped === 'empty') {
      issues.push({ id: 'empty', level: 'warn', titleKey: 'snapshot.issue.emptySkipped', actions: ['restore'] });
    }
    const restore = state.restore;
    if (restore) {
      if (restore.failed.length) {
        issues.push({
          id: 'restore-failed',
          level: 'error',
          titleKey: 'snapshot.issue.restoreFailed',
          count: restore.failed.length,
          detail: restore.failed.map((item) => `${item.name}: ${item.message}`).join('\n'),
          actions: ['restore', 'reveal'],
        });
      }
      if (restore.pending && restore.pending.length) {
        issues.push({
          id: 'restore-pending',
          level: 'warn',
          titleKey: 'snapshot.issue.restorePending',
          count: restore.pending.length,
          detail: restore.pending.join('、'),
          actions: ['restore'],
        });
      }
      if (restore.missingDirs.length) {
        const paths = [...new Set(restore.missingDirs.map((item) => item.path))];
        issues.push({
          id: 'missing-dirs',
          level: 'warn',
          titleKey: 'snapshot.issue.missingDirs',
          count: paths.length,
          detail: paths.join('\n'),
        });
      }
    }
    const repairable = state.cwdIssues.filter((item) => item.repairable);
    if (state.cwdIssues.length) {
      issues.push({
        id: 'cwd-drift',
        level: 'warn',
        titleKey: 'snapshot.issue.cwdDrift',
        count: state.cwdIssues.length,
        detail: state.cwdIssues
          .map((item) => `${item.sessionName} · ${item.windowIndex}.${item.paneIndex} → ${item.expected}${item.blockedBy ? ` （${item.blockedBy}）` : ''}`)
          .join('\n'),
        actions: repairable.length ? ['repair'] : [],
      });
    }
    // A directory that exists but cannot be entered is the one failure the user
    // can actually resolve (grant the app access to that location), so it gets
    // its own entry rather than hiding inside the drift list.
    const denied = state.cwdIssues.filter((item) => item.blockedBy === 'denied');
    if (denied.length) {
      issues.push({
        id: 'cwd-denied',
        level: 'error',
        titleKey: 'snapshot.issue.cwdDenied',
        count: denied.length,
        detail: [...new Set(denied.map((item) => item.expected))].join('\n'),
        actions: ['repair'],
      });
    }
    const stuck = state.lastRepairFailures.filter((item) => item.message === 'cd-failed');
    if (stuck.length) {
      issues.push({
        id: 'repair-stuck',
        level: 'warn',
        titleKey: 'snapshot.issue.repairStuck',
        count: stuck.length,
        detail: stuck.map((item) => `${item.sessionName} · ${item.expected}`).join('\n'),
        actions: ['repair'],
      });
    }
    if (!state.snapshotSessionCount && state.settings.enabled && !state.lastSaveError) {
      issues.push({ id: 'no-snapshot', level: 'info', titleKey: 'snapshot.issue.noSnapshot', actions: ['save'] });
    }
    return {
      settings: state.settings,
      snapshotPath: this.filePath,
      previousPath: this.previousPath,
      logPath: this.logPath,
      startedAt: state.startedAt,
      lastSaveAt: state.lastSaveAt,
      lastSaveError: state.lastSaveError,
      lastSaveSkipped: state.lastSaveSkipped,
      snapshotAt: state.snapshotAt,
      snapshotSessionCount: state.snapshotSessionCount,
      liveSessionCount: state.liveSessionCount,
      restore: state.restore,
      cwdIssues: state.cwdIssues,
      lastRepairAt: state.lastRepairAt,
      issues,
      level: issues.some((issue) => issue.level === 'error')
        ? 'error'
        : (issues.some((issue) => issue.level === 'warn') ? 'warn' : (issues.length ? 'info' : 'ok')),
    };
  }
}

module.exports = {
  DEFAULT_SESSION_RESTORE,
  SessionSnapshotService,
  buildSnapshot,
  normalizeSessionRestore,
  normalizeSnapshot,
  shellQuote,
};

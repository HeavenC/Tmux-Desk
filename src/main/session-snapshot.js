const fs = require('node:fs/promises');
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
const SETTLE_TIMEOUT_MS = 6000;

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

// The directory a window has to be *created* in is pane 1's, not the active
// pane's: new-window/new-session opens exactly one pane and the rest are split
// off it with their own -c. Using the active pane here silently gave every
// first pane whichever directory happened to be focused at snapshot time.
function windowOpenDir(window) {
  if (!window || !Array.isArray(window.panes) || !window.panes.length) return null;
  const ordered = [...window.panes].sort((left, right) => left.index - right.index);
  return ordered[0].path || null;
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

  async liveSessionNames() {
    try {
      const sessions = await this.tmux.listSessions();
      return sessions.filter((session) => isRealSession(session.name)).map((session) => session.name);
    } catch (error) {
      if (errorCode(error) === 'NO_SERVER') return [];
      throw error;
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
      snapshot = await this.capture();
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
    if (!previous.length) {
      // Nothing yet — give a foreign restore plugin its chance to appear.
      while (Date.now() < deadline) {
        await pause();
        const current = await this.liveSessionNames();
        if (current.length) { previous = current; break; }
      }
      if (!previous.length) return previous;
    }
    // Sessions exist: wait for the count to hold still for one poll.
    while (Date.now() < deadline) {
      await pause();
      const current = await this.liveSessionNames();
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
      windows.get(index).push({ paneIndex: toInt(paneIndex), paneId, path: panePath, command });
    }

    for (const session of snapshot.sessions) {
      const windows = live.get(session.name);
      if (!windows) continue;
      const liveIndexes = [...windows.keys()].sort((left, right) => left - right);
      // Pick one matching strategy for the whole session. Indices are the truth
      // when they all line up; otherwise fall back to position, but only when
      // the counts match exactly — base-index / pane-base-index can differ
      // between the snapshot and the restore (a foreign plugin, or a changed
      // profile), and mixing the two strategies would map several snapshot
      // panes onto the same live pane.
      const byWindowIndex = session.windows.every((window) => windows.has(window.index));
      if (!byWindowIndex && session.windows.length !== liveIndexes.length) continue;
      session.windows.forEach((window, position) => {
        const liveIndex = byWindowIndex ? window.index : liveIndexes[position];
        const livePanes = windows.get(liveIndex);
        if (!livePanes) return;
        const ordered = [...livePanes].sort((left, right) => left.paneIndex - right.paneIndex);
        const byPaneIndex = window.panes.every((pane) => ordered.some((item) => item.paneIndex === pane.index));
        if (!byPaneIndex && window.panes.length !== ordered.length) return;
        window.panes.forEach((pane, paneSlot) => {
          const livePane = byPaneIndex
            ? ordered.find((item) => item.paneIndex === pane.index)
            : ordered[paneSlot];
          if (!livePane || !pane.path || pane.path === livePane.path) return;
          // Only the "fell back to $HOME" shape is a bug we can attribute to the
          // restore; a pane the user simply cd'd elsewhere must be left alone.
          if (livePane.path !== this.home || pane.path === this.home) return;
          drift.push({
            sessionName: session.name,
            paneId: livePane.paneId,
            windowIndex: liveIndex,
            paneIndex: livePane.paneIndex,
            expected: pane.path,
            actual: livePane.path,
            command: livePane.command || null,
            repairable: SHELL_COMMANDS.has(String(livePane.command || '').replace(/^-/, ''))
              && this.tmux.dirExists(pane.path),
          });
        });
      });
    }
    return drift;
  }

  async repairCwd(drift) {
    const targets = (drift || this.state.cwdIssues).filter((item) => item.repairable);
    const repaired = [];
    const failed = [];
    for (const item of targets) {
      try {
        await this.tmux.run(['send-keys', '-t', item.paneId, '-l', `cd -- ${shellQuote(item.expected)}`]);
        await this.tmux.run(['send-keys', '-t', item.paneId, 'Enter']);
        repaired.push(item);
        this.log('info', `已修复工作目录：${item.sessionName} ${item.windowIndex}.${item.paneIndex}`, item.expected);
      } catch (error) {
        failed.push({ ...item, message: errorMessage(error) });
        this.log('error', `修复工作目录失败：${item.sessionName}`, errorMessage(error));
      }
    }
    this.state.lastRepairAt = this.now().toISOString();
    const repairedIds = new Set(repaired.map((item) => item.paneId));
    this.state.cwdIssues = this.state.cwdIssues.filter((item) => !repairedIds.has(item.paneId));
    this.emitChange();
    return { repaired: repaired.length, failed };
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

    let live;
    try {
      live = await this.waitForServerToSettle();
    } catch (error) {
      this.state.tmuxError = { message: errorMessage(error), code: errorCode(error) };
      this.log('error', '启动检查失败：无法读取 tmux 会话', errorMessage(error));
      this.emitChange();
      return null;
    }
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
        detail: state.cwdIssues.map((item) => `${item.sessionName} · ${item.windowIndex}.${item.paneIndex} → ${item.expected}`).join('\n'),
        actions: repairable.length ? ['repair'] : [],
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

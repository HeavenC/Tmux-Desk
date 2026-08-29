const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { withUtf8Locale } = require('./locale-env');
const { isWindows, wslConfig, buildTmuxInvocation, toWslPath, toWindowsPath, withTmuxDirOnPath } = require('./platform');
const { buildTmuxSettingCommands } = require('../shared/tmux-settings');
const { collectMatches, gotoLineFor, normalizeQuery, scanPaneCapture } = require('../shared/session-search');

const execFileAsync = promisify(execFile);
// Separates capture-pane's payload from the geometry line appended to the same
// tmux invocation; \x01 cannot appear in tmux's plain-text capture output.
const CAPTURE_META = '\u0001tmux-desk-capture-meta\u0001';
const SESSION_TARGET = /^\$\d+$/;
const WINDOW_TARGET = /^@\d+$/;
const PANE_TARGET = /^%\d+$/;
const TMUX_CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
];

class TmuxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TmuxError';
    this.code = code;
  }
}

function parseRecords(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
}

function toNumber(value) {
  return Number(value);
}

function toBoolean(value) {
  return value === '1';
}

function errorFromTmux(error) {
  const stderr = String(error && error.stderr || '').trim();
  const message = stderr.toLowerCase();

  if (error && error.code === 'ENOENT') {
    return new TmuxError('TMUX_NOT_FOUND', '未找到 tmux，请先运行 brew install tmux');
  }
  if (message.includes('no server running on') || message.includes('failed to connect to server')) {
    return new TmuxError('NO_SERVER', 'tmux 服务尚未启动');
  }
  if (message.includes("can't find session")) {
    return new TmuxError('SESSION_NOT_FOUND', 'tmux 会话不存在或已关闭');
  }
  if (message.includes('duplicate session') || message.includes('session already exists')) {
    return new TmuxError('SESSION_EXISTS', '已存在同名 tmux 会话');
  }
  return new TmuxError('COMMAND_FAILED', `tmux 操作失败：${stderr || 'unknown error'}`);
}

function notFoundMessage(windows) {
  return windows
    ? '未找到 WSL 或其中的 tmux，请安装 WSL 并在其中运行 apt install tmux'
    : '未找到 tmux，请先运行 brew install tmux';
}

// On Windows, tell apart "WSL itself is missing" from "tmux is missing inside a
// working WSL" so the UI can point the user at the right fix.
function windowsFailureReason(error) {
  if (error && error.code === 'ENOENT') return 'WSL_NOT_FOUND';
  const stderr = String(error && error.stderr || '').toLowerCase();
  if (stderr.includes('command not found') || stderr.includes('not found') || stderr.includes('no such file')) {
    return 'TMUX_NOT_FOUND';
  }
  if (stderr.includes('wsl') || stderr.includes('distribution') || stderr.includes('no installed distributions')) {
    return 'WSL_NOT_FOUND';
  }
  return null;
}

function validateTarget(target, pattern, label) {
  if (typeof target !== 'string' || !pattern.test(target)) {
    throw new Error(`无效的 tmux ${label}目标`);
  }
  return target;
}

function validateName(name) {
  if (typeof name !== 'string') throw new Error('会话名称无效');
  const normalized = name.trim();
  if (!normalized || Array.from(normalized).length > 80 || /[.:\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error('会话名称无效');
  }
  return normalized;
}

class TmuxService {
  constructor({ tmuxPath, execFileImpl, socketName, fsImpl, env, platform } = {}) {
    this.platform = platform || process.platform;
    this.isWindows = isWindows(this.platform);
    // Select path semantics by target platform, not the ambient module, so cwd
    // validation is correct when a platform is injected (tests) or when tmux runs
    // under WSL: a WSL path like /home/x is absolute under both, a Windows path
    // like C:\x is only absolute under win32.
    this.pathLib = this.isWindows ? path.win32 : path.posix;
    this.tmuxPath = tmuxPath || null;
    this.env = withUtf8Locale(env || process.env);
    // maxBuffer: capture-pane can return a pane's whole scrollback (20k lines is
    // ~1.6 MB of text), and Node's 1 MiB default would turn cross-session search
    // into an ENOBUFS error on any busy pane.
    this.execFileImpl = execFileImpl
      || ((file, args) => execFileAsync(file, args, { env: this.env, maxBuffer: 64 * 1024 * 1024 }));
    this.socketName = socketName || null;
    this.fs = fsImpl || fs;
  }

  async resolveTmuxPath() {
    // On Windows the "tmux path" is the command name run inside WSL; there is no
    // Windows binary to probe. The WSL launcher (buildTmuxInvocation) prefixes it
    // with wsl.exe when a command actually runs.
    if (this.isWindows) {
      // Ignore this.tmuxPath here: it is meant for the bundled mac binary and
      // would be a Windows path that means nothing inside WSL.
      return wslConfig(this.env).tmux;
    }
    if (this.tmuxPath) {
      try {
        this.fs.accessSync(this.tmuxPath, this.fs.constants.X_OK);
        return this.tmuxPath;
      } catch {
        // Fall through to the standard Homebrew, system, and PATH candidates.
      }
    }

    for (const candidate of TMUX_CANDIDATES) {
      try {
        this.fs.accessSync(candidate, this.fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next standard Homebrew or system location.
      }
    }

    try {
      const { stdout } = await this.execFileImpl('/usr/bin/which', ['tmux']);
      return String(stdout || '').trim() || null;
    } catch {
      return null;
    }
  }

  async getStatus() {
    const tmuxPath = await this.resolveTmuxPath();
    if (!tmuxPath) return { installed: false, path: null, version: null };

    try {
      const { stdout } = await this.execTmux(['-V']);
      const version = String(stdout || '').trim() || null;
      return { installed: true, path: this.isWindows ? `WSL:${tmuxPath}` : tmuxPath, version };
    } catch (error) {
      if (this.isWindows) {
        const reason = windowsFailureReason(error);
        if (reason) return { installed: false, path: null, version: null, reason };
      }
      throw errorFromTmux(error);
    }
  }

  async listSessions() {
    try {
      const sessions = parseRecords((await this.run([
        'list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_activity}\t#{session_path}',
      ])).stdout).map(([id, name, attached, windows, activity, sessionPath]) => ({
        id,
        name,
        attached: toBoolean(attached),
        windows: toNumber(windows),
        activity: toNumber(activity),
        path: sessionPath,
        paneCount: 0,
        activeCommand: '',
      }));
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const panes = await this.run([
        'list-panes', '-a', '-F', '#{session_id}\t#{pane_id}\t#{pane_active}\t#{pane_current_command}',
      ]);

      for (const [sessionId, , active, command] of parseRecords(panes.stdout)) {
        const session = byId.get(sessionId);
        if (!session) continue;
        session.paneCount += 1;
        if (toBoolean(active) && !session.activeCommand) session.activeCommand = command;
      }
      return sessions;
    } catch (error) {
      const normalized = error instanceof TmuxError ? error : errorFromTmux(error);
      if (normalized.code === 'NO_SERVER') return [];
      throw normalized;
    }
  }

  async getSessionDetail(sessionTarget) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    const windows = parseRecords((await this.run([
      'list-windows', '-t', sessionTarget, '-F', '#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}',
    ])).stdout).map(([id, index, name, active, panes]) => ({
      id, index: toNumber(index), name, active: toBoolean(active), panes: toNumber(panes),
    }));
    const panes = parseRecords((await this.run([
      'list-panes', '-s', '-t', sessionTarget, '-F', '#{pane_id}\t#{window_id}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}',
    ])).stdout).map(([id, windowId, windowIndex, index, active, panePath, command, title, left, top, width, height]) => ({
      id,
      windowId,
      windowIndex: toNumber(windowIndex),
      index: toNumber(index),
      active: toBoolean(active),
      path: panePath,
      command,
      title,
      // Cell-grid geometry within the (client-sized) tmux window, so the
      // renderer can overlay a per-pane close button at the pane's top-right.
      left: toNumber(left),
      top: toNumber(top),
      width: toNumber(width),
      height: toNumber(height),
    }));
    return { windows, panes };
  }

  async createSession({ name, cwd, startupCommand = '' } = {}) {
    const validName = validateName(name);
    this.validateCwd(cwd);
    if (typeof startupCommand !== 'string' || startupCommand.length > 4096 || /[\x00\r\n]/.test(startupCommand)) {
      throw new Error('启动命令不能包含换行或 NUL 字符');
    }

    const { stdout } = await this.run([
      'new-session', '-d', '-P', '-F', '#{session_id}', '-s', validName, '-c', this.tmuxDir(cwd),
    ]);
    const id = String(stdout || '').trim();
    if (startupCommand) {
      await this.run(['send-keys', '-t', id, '-l', '--', startupCommand]);
      await this.run(['send-keys', '-t', id, 'Enter']);
    }
    return { id, name: validName };
  }

  // Fork a session the way `git checkout -b` forks a branch: a fresh session
  // that mirrors the source's windows (name + working directory), so you can
  // diverge from the current setup without disturbing the original.
  async duplicateSession(sourceTarget, name) {
    validateTarget(sourceTarget, SESSION_TARGET, '会话');
    const validName = validateName(name);
    const { windows, panes } = await this.getSessionDetail(sourceTarget);
    const ordered = [...windows].sort((left, right) => left.index - right.index);
    const cwdForWindow = (windowInfo) => {
      const windowPanes = panes.filter((pane) => pane.windowId === windowInfo.id);
      const chosen = windowPanes.find((pane) => pane.active) || windowPanes[0];
      return this.safeDir(chosen && chosen.path);
    };

    const first = ordered[0];
    const firstCwd = first ? cwdForWindow(first) : null;
    const { stdout } = await this.run([
      'new-session', '-d', '-P', '-F', '#{session_id}', '-s', validName,
      ...(firstCwd ? ['-c', firstCwd] : []),
    ]);
    const id = String(stdout || '').trim();

    if (first && first.name) {
      try { await this.run(['rename-window', '-t', id, first.name]); } catch { /* keep default name */ }
    }
    for (const windowInfo of ordered.slice(1)) {
      const cwd = cwdForWindow(windowInfo);
      await this.run([
        'new-window', '-t', id,
        ...(cwd ? ['-c', cwd] : []),
        ...(windowInfo.name ? ['-n', windowInfo.name] : []),
      ]);
    }
    return { id, name: validName };
  }

  async renameSession(sessionTarget, name) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    await this.run(['rename-session', '-t', sessionTarget, validateName(name)]);
  }

  async killSession(sessionTarget) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    await this.run(['kill-session', '-t', sessionTarget]);
  }

  // Apply the app-managed, iTerm-like profile. Session options target the
  // attached session; server/window-global options are necessarily shared by
  // every client on the same tmux socket. Commands are arrays, never shell text.
  // One unsupported option on an older tmux must not prevent terminal attach.
  async applySessionDefaults(sessionTarget, settings = {}, options) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    let allApplied = true;
    for (const args of buildTmuxSettingCommands(sessionTarget, settings, options)) {
      try { await this.run(args); } catch { allApplied = false; }
    }
    return allApplied;
  }

  // localMouseSession: the session this app's own terminal is attached to. Its
  // `mouse off` override is session-scoped, so re-applying the profile has to
  // re-assert it — the profile write starts by unsetting session-level options.
  async applySettingsToAllSessions(settings = {}, { localMouseSession = null } = {}) {
    const sessions = await this.listSessions();
    const results = [];
    // Global options are part of every profile application. Keep sessions
    // sequential so advanced overrides cannot race with another session's
    // built-in defaults.
    for (let index = 0; index < sessions.length; index += 1) {
      results.push(await this.applySessionDefaults(sessions[index].id, settings, {
        // Global/server/window options only need one write; every session still
        // drops stale per-session overrides left by older app versions.
        includeGlobal: index === 0,
        localMouse: sessions[index].id === localMouseSession,
      }));
    }
    return results.every(Boolean);
  }

  async selectWindow(windowTarget) {
    validateTarget(windowTarget, WINDOW_TARGET, '窗口');
    await this.run(['select-window', '-t', windowTarget]);
  }

  async selectPane(paneTarget) {
    validateTarget(paneTarget, PANE_TARGET, '面板');
    await this.run(['select-pane', '-t', paneTarget]);
  }

  // Resize one pane to an absolute cell size. Dragging a split divider in the UI
  // maps to this: with tmux's own mouse off (localMouse), tmux never sees the
  // drag, so the client has to translate pixels into a resize command.
  async resizePane(paneTarget, { x, y } = {}) {
    validateTarget(paneTarget, PANE_TARGET, '面板');
    const args = ['resize-pane', '-t', paneTarget];
    if (Number.isInteger(x)) args.push('-x', String(Math.min(1000, Math.max(1, x))));
    if (Number.isInteger(y)) args.push('-y', String(Math.min(500, Math.max(1, y))));
    if (args.length === 3) throw new TmuxError('COMMAND_FAILED', '缺少 pane 尺寸');
    await this.run(args);
  }

  // Every pane on the server, with the identifiers the UI needs to show a match
  // ("会话 › 窗口 › pane") and the targets needed to jump to it.
  async listAllPanes() {
    const format = [
      '#{session_id}', '#{session_name}', '#{window_id}', '#{window_index}', '#{window_name}',
      '#{pane_id}', '#{pane_index}', '#{pane_active}', '#{pane_current_command}',
      '#{history_size}', '#{pane_height}',
    ].join('\t');
    const { stdout } = await this.run(['list-panes', '-a', '-F', format]);
    return parseRecords(stdout).map(([sessionId, sessionName, windowId, windowIndex, windowName,
      paneId, paneIndex, paneActive, command, historySize, paneHeight]) => ({
      sessionId, sessionName, windowId, windowIndex: toNumber(windowIndex), windowName,
      paneId, paneIndex: toNumber(paneIndex), paneActive: toBoolean(paneActive), command,
      historySize: toNumber(historySize), paneHeight: toNumber(paneHeight),
    }));
  }

  // A pane's scrollback as plain text, oldest line first, together with the row
  // geometry captured in the SAME tmux invocation. That atomicity matters: tmux
  // runs a command list without processing pane output in between, so a busy
  // pane cannot grow between the capture and the history_size that indexes it —
  // read separately, every match in a running build lands on the wrong row.
  async capturePane(paneTarget, historyLines = 20000) {
    validateTarget(paneTarget, PANE_TARGET, '面板');
    const requestedLines = Math.min(200000, Math.max(100, historyLines));
    const { stdout } = await this.run([
      'capture-pane', '-p', '-S', `-${requestedLines}`, '-t', paneTarget,
      ';', 'display-message', '-p', '-t', paneTarget, `${CAPTURE_META}#{history_size}\t#{pane_height}`,
    ]);
    const text = String(stdout || '');
    const marker = text.lastIndexOf(CAPTURE_META);
    if (marker < 0) return { text, historySize: 0, paneHeight: 0, requestedLines };
    const [historySize, paneHeight] = text.slice(marker + CAPTURE_META.length).trim().split('\t');
    return {
      text: text.slice(0, marker).replace(/\n$/, ''),
      historySize: toNumber(historySize) || 0,
      paneHeight: toNumber(paneHeight) || 0,
      requestedLines,
    };
  }

  // Search every pane of every session at once — the thing a single terminal
  // emulator cannot do, and the reason Cmd+F here is not iTerm's per-pane find.
  // Panes are captured sequentially: measured at ~14 ms for three panes holding
  // 2k-20k lines each, so the round trips are not worth parallelising.
  async searchSessions(query, {
    historyLines = 20000, maxPerPane = 20, maxTotal = 200, caseSensitive = false,
  } = {}) {
    const needle = normalizeQuery(query);
    if (!needle) return { results: [], truncated: false, panes: 0 };
    const panes = await this.listAllPanes();
    const scanned = [];
    for (const pane of panes) {
      let capture;
      try {
        capture = await this.capturePane(pane.paneId, historyLines);
      } catch {
        continue; // a pane can die mid-search; the rest of the result is still good
      }
      // historySize travels with every match: the pane keeps producing output
      // after the capture, and each new row pushes the match one row further up
      // (revealMatch re-reads history_size and adds the difference).
      const matches = scanPaneCapture(capture.text, needle, { caseSensitive, maxPerPane })
        .map(({ index, ...match }) => ({
          ...match,
          gotoLine: gotoLineFor(capture, index),
          historySize: capture.historySize,
        }));
      if (matches.length) scanned.push({ pane, matches });
    }
    return { ...collectMatches(scanned, { maxTotal }), panes: panes.length };
  }

  // Jump to one search hit: focus its window and pane, then park copy-mode on
  // the matched row.
  //
  // Getting there exactly takes three tries stacked on each other, because the
  // pane keeps living after the search:
  //   1. goto-line with the captured row offset, corrected by however much the
  //      scrollback grew since. That correction is blind once a pane hits its
  //      history-limit — history_size stops growing while rows keep scrolling
  //      off — so it only gets us close.
  //   2. snap: search backward for the matched line's exact text. Drift always
  //      pushes a row further up, so the landing point is at or below it.
  //   3. search forward for the query itself, which stays on that line (a
  //      forward search starts at the cursor) and leaves the query as tmux's
  //      search string, so tmux highlights the matches in the viewport.
  // If the row still does not hold the query, fall back to the newest match in
  // the pane rather than leaving the user at an arbitrary line.
  async revealMatch({ windowId, paneId, gotoLine, historySize = null, query, preview = '' } = {}) {
    validateTarget(windowId, WINDOW_TARGET, '窗口');
    validateTarget(paneId, PANE_TARGET, '面板');
    const needle = normalizeQuery(query);
    const expected = typeof preview === 'string' ? preview.trim() : '';
    let line = Number.isInteger(gotoLine) ? Math.max(0, gotoLine) : 0;
    if (Number.isInteger(historySize)) {
      const { stdout } = await this.run(['display-message', '-p', '-t', paneId, '#{history_size}']);
      const live = toNumber(String(stdout || '').trim()) || 0;
      line += Math.max(0, live - historySize);
      // goto-line cannot climb higher than the scrollback itself.
      line = Math.min(line, live);
    }
    await this.run(['select-window', '-t', windowId, ';', 'select-pane', '-t', paneId]);
    const args = ['copy-mode', '-e', '-t', paneId,
      ';', 'send-keys', '-t', paneId, '-X', 'goto-line', String(line)];
    if (expected) args.push(';', 'send-keys', '-t', paneId, '-X', 'search-backward-text', '--', expected);
    if (needle) args.push(';', 'send-keys', '-t', paneId, '-X', 'search-forward-text', '--', needle);
    await this.run(args);
    let cursorLine = await this.copyCursorLine(paneId);
    const exact = !needle || cursorLine.toLowerCase().includes(needle.toLowerCase());
    if (!exact) {
      await this.cancelCopyMode(paneId);
      await this.run(['copy-mode', '-e', '-t', paneId,
        ';', 'send-keys', '-t', paneId, '-X', 'search-backward-text', '--', needle]);
      cursorLine = await this.copyCursorLine(paneId);
    }
    return { cursorLine, exact };
  }

  async copyCursorLine(paneTarget) {
    const { stdout } = await this.run(['display-message', '-p', '-t', paneTarget, '#{copy_cursor_line}']);
    return String(stdout || '').replace(/\n$/, '');
  }

  // Cmd+K, iTerm's "clear buffer": wipe the visible screen AND the scrollback.
  // Order matters. C-l first lets the foreground program repaint itself — zsh
  // keeps a half-typed command line, a TUI redraws — and that repaint pushes the
  // old screen into the scrollback; clearing the history first would leave those
  // rows behind (measured: history 185 -> 19 that way, and 0 in this order).
  // The pause is for the program to actually repaint before the history goes.
  async clearPane(sessionTarget, { redrawDelayMs = 120 } = {}) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    await this.cancelCopyMode(sessionTarget);
    await this.run(['send-keys', '-t', sessionTarget, 'C-l']);
    if (redrawDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, redrawDelayMs));
    await this.run(['clear-history', '-t', sessionTarget]);
    return true;
  }

  // Terminal find (Cmd+F). tmux owns the pane history, so "find in terminal"
  // means driving copy-mode's own search — which also highlights every visible
  // match (copy-mode-match-style) for free. The -text variants search for a
  // literal string: people type paths and error messages into a find bar, not
  // regular expressions. Returns the match bookkeeping plus inCopyMode, because
  // a search leaves the pane in copy-mode and the client must cancel that before
  // the next keystroke reaches the application.
  //   action 'search' — a new query, restarted from the live bottom
  //   action 'step'   — the next match in `direction` ('backward' = older)
  //   flip            — this step reverses the previous direction (see below)
  async findInSession(sessionTarget, { query, action = 'search', direction = 'backward', flip = false } = {}) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    if (typeof query !== 'string' || !query || query.length > 512) {
      throw new TmuxError('COMMAND_FAILED', '查找内容无效');
    }
    const report = ['display-message', '-p', '-t', sessionTarget,
      '#{search_present}\t#{search_count}\t#{search_count_partial}\t#{pane_in_mode}'];
    const search = (name) => ['send-keys', '-t', sessionTarget, '-X', name, '--', query];
    let args;
    if (action === 'search') {
      // Restart from the live bottom, or a changed query would keep drifting
      // further up from wherever the previous match left the cursor.
      await this.cancelCopyMode(sessionTarget);
      args = ['copy-mode', '-e', '-t', sessionTarget, ';', ...search('search-backward-text'), ';', ...report];
    } else {
      // A backward search leaves the cursor on the START of its match, a forward
      // one on the END. So the first step after changing direction only walks
      // across the match already under the cursor — it looks like a dead button.
      // Measured on tmux 3.7b: flipping costs exactly one such step, so spend it.
      const name = direction === 'forward' ? 'search-forward-text' : 'search-backward-text';
      args = flip
        ? [...search(name), ';', ...search(name), ';', ...report]
        : [...search(name), ';', ...report];
    }
    try {
      const [present, count, partial, inMode] = String((await this.run(args)).stdout || '')
        .trim().split('\n').pop().split('\t');
      return {
        inCopyMode: inMode === '1',
        present: present === '1',
        count: Number(count) || 0,
        partial: partial === '1',
      };
    } catch {
      // Stepping while the pane is no longer in copy-mode (it scrolled back to
      // the live screen) is the ordinary "nothing to step through" case.
      return { inCopyMode: false, present: false, count: 0, partial: false };
    }
  }

  // Leave copy-mode without sending anything to the pane's application. The
  // client calls this before the first keystroke that follows a wheel scroll:
  // scrolling a normal-screen pane necessarily enters copy-mode, where every
  // key is a copy-mode command instead of input ("typing does nothing until you
  // press Escape"). Erroring because the pane is not in a mode is the success
  // case, so it is swallowed.
  async cancelCopyMode(target) {
    // Session for the attached view, pane for a search hit somewhere else.
    if (!SESSION_TARGET.test(String(target)) && !PANE_TARGET.test(String(target))) {
      throw new TmuxError('COMMAND_FAILED', '无效的 tmux 目标');
    }
    try {
      await this.run(['send-keys', '-t', target, '-X', 'cancel']);
    } catch {}
    return true;
  }

  // Wheel scrolling for a tmux front-end. tmux drives the *alternate* screen of
  // the outer terminal (it emits \e[?1049h on attach), so xterm has no scrollback
  // of its own to move — scrolling has to be translated per pane state, mirroring
  // what tmux's own wheel bindings decide:
  //   1. Pane already in copy-mode → keep driving copy-mode.
  //   2. Alt-screen app that enabled mouse reporting (Claude Code) → forward the
  //      wheel as SGR mouse events; the app scrolls its own viewport. Copy-mode
  //      would be useless here: the alternate screen accumulates no history.
  //   3. Alt-screen app without mouse (pagers) → arrow-key emulation, same as
  //      tmux's built-in wheel fallback.
  //   4. Normal screen → copy-mode + history (history-limit 50000) from the
  //      command channel, which works even when a TUI grabbed mouse reporting
  //      but does NOT handle scrolling itself (the "can't scroll" agent case).
  // `copy-mode -e` makes scrolling back down past the newest line exit
  // copy-mode straight to the live screen, so the bottom is always reachable.
  // lines<0 = up (into history), lines>0 = down (toward live).
  // Returns { inCopyMode } so the client can cancel copy-mode before the next
  // keystroke instead of leaving the pane deaf to input.
  async scrollSession(sessionTarget, lines) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    if (!Number.isInteger(lines) || lines === 0) return { inCopyMode: false };
    const count = String(Math.min(500, Math.abs(lines)));
    try {
      const { stdout } = await this.run(['display-message', '-p', '-t', sessionTarget,
        '#{pane_in_mode} #{alternate_on} #{mouse_any_flag} #{pane_width} #{pane_height}']);
      const [inMode, altOn, mouseAny, paneWidth, paneHeight] =
        String(stdout || '').trim().split(/\s+/).map(Number);
      if (inMode !== 1 && altOn === 1) {
        if (mouseAny === 1) {
          // One SGR wheel event (64 = up, 65 = down) per line, at the pane
          // centre; capped — apps scroll a chunk per event anyway.
          const x = Math.max(1, Math.round(paneWidth / 2) || 1);
          const y = Math.max(1, Math.round(paneHeight / 2) || 1);
          const seq = `\u001b[<${lines < 0 ? 64 : 65};${x};${y}M`.repeat(Math.min(Number(count), 30));
          await this.run(['send-keys', '-t', sessionTarget, '-l', seq]);
        } else {
          await this.run(['send-keys', '-t', sessionTarget, '-N', count, lines < 0 ? 'Up' : 'Down']);
        }
        return { inCopyMode: false };
      }
      // The trailing display-message rides along in the same tmux invocation
      // (`;` separates commands), so the caller learns whether the pane is now
      // in copy-mode without a second round trip. It has to know: while in copy
      // mode the pane swallows keystrokes as copy-mode commands, and the client
      // cancels the mode before forwarding the next key.
      const report = ['display-message', '-p', '-t', sessionTarget, '#{pane_in_mode}'];
      let reported;
      if (lines < 0) {
        // Enter copy-mode (idempotent) and scroll up — one tmux call via `;`.
        ({ stdout: reported } = await this.run(['copy-mode', '-e', '-t', sessionTarget,
          ';', 'send-keys', '-t', sessionTarget, '-X', '-N', count, 'scroll-up',
          ';', ...report]));
      } else {
        // Only meaningful in copy-mode; a no-op error at the live bottom is fine.
        ({ stdout: reported } = await this.run(['send-keys', '-t', sessionTarget, '-X', '-N', count, 'scroll-down',
          ';', ...report]));
      }
      return { inCopyMode: String(reported || '').trim().split('\n').pop() === '1' };
    } catch {
      // scroll-down while already at the live bottom (not in copy-mode) throws
      // "not in a mode" — that just means we're already there, and the whole
      // invocation (including the report) is lost, so assume the live screen.
      return { inCopyMode: false };
    }
  }

  // Close a single split pane (the inverse of splitPane). Killing panes until
  // one is left restores the window to its unsplit state. The UI only offers
  // this while a window has >=2 panes, so it never kills the last pane.
  async killPane(paneTarget) {
    validateTarget(paneTarget, PANE_TARGET, '面板');
    await this.run(['kill-pane', '-t', paneTarget]);
  }

  // Split the session's active pane, iTerm-style. 'vertical' = side by side (a
  // vertical divider) = tmux -h; 'horizontal' = stacked = tmux -v. The new pane
  // opens in the current pane's directory. Splitting again just nests further.
  async splitPane(sessionTarget, orientation) {
    validateTarget(sessionTarget, SESSION_TARGET, '会话');
    const flag = orientation === 'horizontal' ? '-v' : '-h';
    const { stdout } = await this.run([
      'split-window', flag, '-P', '-F', '#{pane_id}', '-t', sessionTarget, '-c', '#{pane_current_path}',
    ]);
    return { id: String(stdout || '').trim() };
  }

  // Translate a directory into the form tmux expects for `-c`. On Windows tmux
  // runs inside WSL, so a Windows path (C:\… or \\wsl$\…) must become a WSL path;
  // paths already in WSL form pass through unchanged.
  tmuxDir(dir) {
    return this.isWindows ? toWslPath(dir) : dir;
  }

  // Is `dir` a real directory? On Windows the incoming path may be a WSL path
  // (from tmux) or a Windows path (from a dialog); check whichever form the
  // Windows fs can see, but never fabricate a distro-dependent UNC.
  dirExists(dir) {
    if (typeof dir !== 'string' || !dir) return false;
    let checkPath = dir;
    if (this.isWindows) {
      checkPath = /^[A-Za-z]:/.test(dir) || dir.startsWith('\\\\') ? dir : toWindowsPath(dir, null);
      if (!checkPath) return false; // native WSL path with unknown distro — cannot verify here
    }
    try {
      return this.fs.statSync(checkPath).isDirectory();
    } catch {
      return false;
    }
  }

  safeDir(dir) {
    if (typeof dir !== 'string' || !this.pathLib.isAbsolute(dir)) return null;
    if (this.dirExists(dir)) return dir;
    return null;
  }

  validateCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.length > 4096 || cwd.includes('\0') || !this.pathLib.isAbsolute(cwd)) {
      throw new Error('工作目录必须是绝对路径');
    }
    // On Windows a native WSL path (/home/…) can't be verified without the distro;
    // accept it and let tmux surface a bad directory. /mnt and Windows paths are
    // still verified below.
    if (this.isWindows && cwd.startsWith('/') && !cwd.startsWith('/mnt/')) return;
    if (!this.dirExists(cwd)) {
      throw new Error('工作目录必须是存在的目录');
    }
  }

  commandArgs(args) {
    return this.socketName ? ['-L', this.socketName, ...args] : args;
  }

  // Resolve tmux, then build the concrete invocation — the tmux binary directly
  // on mac/linux, or `wsl.exe -e tmux …` on Windows — and execute it.
  async execTmux(args) {
    const tmuxPath = await this.resolveTmuxPath();
    if (!tmuxPath) throw new TmuxError('TMUX_NOT_FOUND', notFoundMessage(this.isWindows));
    // A tmux server we daemonize inherits this env; make sure its plugins can
    // find `tmux` even when the app was launched from the Dock (minimal PATH).
    this.env = withTmuxDirOnPath(this.env, tmuxPath, this.platform);
    const invocation = buildTmuxInvocation(
      { platform: this.platform, tmuxPath, env: this.env },
      this.commandArgs(args),
    );
    return this.execFileImpl(invocation.file, invocation.args);
  }

  async run(args) {
    try {
      return await this.execTmux(args);
    } catch (error) {
      if (error instanceof TmuxError) throw error;
      throw errorFromTmux(error);
    }
  }
}

module.exports = { TmuxError, TmuxService };

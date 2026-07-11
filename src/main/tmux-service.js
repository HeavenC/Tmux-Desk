const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { withUtf8Locale } = require('./locale-env');
const { isWindows, wslConfig, buildTmuxInvocation, toWslPath, toWindowsPath } = require('./platform');

const execFileAsync = promisify(execFile);
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
    this.execFileImpl = execFileImpl || ((file, args) => execFileAsync(file, args, { env: this.env }));
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

  async selectWindow(windowTarget) {
    validateTarget(windowTarget, WINDOW_TARGET, '窗口');
    await this.run(['select-window', '-t', windowTarget]);
  }

  async selectPane(paneTarget) {
    validateTarget(paneTarget, PANE_TARGET, '面板');
    await this.run(['select-pane', '-t', paneTarget]);
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

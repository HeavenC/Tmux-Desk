const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { withUtf8Locale } = require('./locale-env');

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
  constructor({ tmuxPath, execFileImpl, socketName, fsImpl, env } = {}) {
    this.tmuxPath = tmuxPath || null;
    this.env = withUtf8Locale(env || process.env);
    this.execFileImpl = execFileImpl || ((file, args) => execFileAsync(file, args, { env: this.env }));
    this.socketName = socketName || null;
    this.fs = fsImpl || fs;
  }

  async resolveTmuxPath() {
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
      const { stdout } = await this.execFileImpl(tmuxPath, this.commandArgs(['-V']));
      return { installed: true, path: tmuxPath, version: String(stdout || '').trim() || null };
    } catch (error) {
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
      'list-panes', '-s', '-t', sessionTarget, '-F', '#{pane_id}\t#{window_id}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}',
    ])).stdout).map(([id, windowId, windowIndex, index, active, panePath, command, title]) => ({
      id,
      windowId,
      windowIndex: toNumber(windowIndex),
      index: toNumber(index),
      active: toBoolean(active),
      path: panePath,
      command,
      title,
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
      'new-session', '-d', '-P', '-F', '#{session_id}', '-s', validName, '-c', cwd,
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

  safeDir(dir) {
    try {
      if (typeof dir === 'string' && path.isAbsolute(dir) && this.fs.statSync(dir).isDirectory()) return dir;
    } catch { /* fall through to null so tmux uses its default directory */ }
    return null;
  }

  validateCwd(cwd) {
    if (typeof cwd !== 'string' || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
      throw new Error('工作目录必须是绝对路径');
    }
    try {
      if (!this.fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error('工作目录必须是存在的目录');
    }
  }

  commandArgs(args) {
    return this.socketName ? ['-L', this.socketName, ...args] : args;
  }

  async run(args) {
    const tmuxPath = await this.resolveTmuxPath();
    if (!tmuxPath) throw new TmuxError('TMUX_NOT_FOUND', '未找到 tmux，请先运行 brew install tmux');
    try {
      return await this.execFileImpl(tmuxPath, this.commandArgs(args));
    } catch (error) {
      throw errorFromTmux(error);
    }
  }
}

module.exports = { TmuxError, TmuxService };

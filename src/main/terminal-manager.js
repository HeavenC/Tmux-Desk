const os = require('node:os');
const { withUtf8Locale } = require('./locale-env');

const SESSION_TARGET = /^\$\d+$/;
const MAX_INPUT_LENGTH = 1024 * 1024;

function validateDimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 1 || rows > 500) {
    throw new Error('终端尺寸无效');
  }
}

class TerminalManager {
  constructor({ ptyModule, sendEvent, tmuxPath = 'tmux', socketName, env } = {}) {
    this.pty = ptyModule || require('node-pty');
    this.sendEvent = typeof sendEvent === 'function' ? sendEvent : () => {};
    this.tmuxPath = tmuxPath;
    this.socketName = socketName || null;
    this.env = withUtf8Locale(env || process.env);
    this.active = null;
    this.nextTerminalId = 1;
  }

  attach({ sessionId, cols, rows } = {}) {
    if (typeof sessionId !== 'string' || !SESSION_TARGET.test(sessionId)) {
      throw new Error('tmux 会话目标无效');
    }
    validateDimensions(cols, rows);
    this.disposeActive();

    const terminalId = this.nextTerminalId++;
    const args = [
      ...(this.socketName ? ['-L', this.socketName] : []),
      'attach-session', '-t', sessionId,
    ];
    const process = this.pty.spawn(this.tmuxPath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.env.HOME || os.homedir(),
      env: { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const active = { terminalId, process, disposables: [] };
    active.disposables.push(process.onData((data) => {
      this.sendEvent('terminal:data', { terminalId, data });
    }));
    active.disposables.push(process.onExit(({ exitCode, signal } = {}) => {
      this.sendEvent('terminal:exit', {
        terminalId,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: Number.isInteger(signal) ? signal : null,
      });
      if (this.active?.terminalId === terminalId) {
        this.disposeListeners(active);
        this.active = null;
      }
    }));
    this.active = active;
    return { terminalId };
  }

  write({ terminalId, data } = {}) {
    if (typeof data !== 'string' || data.length > MAX_INPUT_LENGTH) {
      throw new Error('终端输入无效');
    }
    if (!this.isActive(terminalId)) return false;
    this.active.process.write(data);
    return true;
  }

  resize({ terminalId, cols, rows } = {}) {
    validateDimensions(cols, rows);
    if (!this.isActive(terminalId)) return false;
    this.active.process.resize(cols, rows);
    return true;
  }

  isActive(terminalId) {
    return Number.isInteger(terminalId) && this.active?.terminalId === terminalId;
  }

  disposeListeners(active) {
    for (const disposable of active.disposables.splice(0)) {
      try { disposable?.dispose?.(); } catch {}
    }
  }

  disposeActive() {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    this.disposeListeners(active);
    try { active.process.kill(); } catch {}
  }

  dispose() {
    this.disposeActive();
  }
}

module.exports = { TerminalManager, validateDimensions };

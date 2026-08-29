const os = require('node:os');
const { withUtf8Locale } = require('./locale-env');
const { buildTmuxInvocation, withTmuxDirOnPath } = require('./platform');

// tmux only enables a capability for clients whose terminfo/terminal-features
// already claim it, and xterm.js identifies as "xterm-256color", which claims
// almost none — so the client declares them explicitly with -T. Everything
// listed here is implemented by @xterm/xterm 6:
//   clipboard      OSC 52 (with set-clipboard external, this is what makes a
//                  tmux copy land on the system clipboard)
//   RGB            24-bit SGR 38;2 / 48;2
//   extkeys        CSI u / modifyOtherKeys, so Shift+Enter, Ctrl+Shift+x and
//                  the phone quick-bar's combo keys survive the trip
//   sync           DECSET 2026 synchronized output — tmux batches a redraw into
//                  one atomic frame, which removes tearing on busy panes
//   usstyle        SGR 4:x underline styles + SGR 58 underline colour
//   strikethrough  SGR 9
//   overline       SGR 53
//   hyperlinks     OSC 8 (see linkHandler in terminal-view.js — without the
//                  feature tmux strips the escape and the link never arrives)
//   osc7           pane cwd reporting passthrough
//   focus          DECSET 1004 focus in/out reports
//   cstyle         DECSCUSR (CSI n SP q) cursor shape
//   ccolour        OSC 12 cursor colour
const TERMINAL_FEATURES = [
  'clipboard', 'RGB', 'extkeys', 'sync', 'usstyle', 'strikethrough', 'overline',
  'hyperlinks', 'osc7', 'focus', 'cstyle', 'ccolour',
].join(',');

const SESSION_TARGET = /^\$\d+$/;
const MAX_INPUT_LENGTH = 1024 * 1024;

function validateDimensions(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 1000 || rows < 1 || rows > 500) {
    throw new Error('终端尺寸无效');
  }
}

class TerminalManager {
  constructor({ ptyModule, sendEvent, tmuxPath = 'tmux', socketName, env, platform } = {}) {
    this.pty = ptyModule || require('node-pty');
    this.sendEvent = typeof sendEvent === 'function' ? sendEvent : () => {};
    this.tmuxPath = tmuxPath;
    this.socketName = socketName || null;
    this.env = withUtf8Locale(env || process.env);
    this.platform = platform || process.platform;
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
    const tmuxArgs = [
      ...(this.socketName ? ['-L', this.socketName] : []),
      '-T', TERMINAL_FEATURES,
      'attach-session', '-t', sessionId,
    ];
    // On Windows tmux runs inside WSL: spawn `wsl.exe -e tmux …` instead of a
    // native tmux binary. On mac/linux this is just the tmux binary + args.
    const { file, args } = buildTmuxInvocation(
      { platform: this.platform, tmuxPath: this.tmuxPath, env: this.env },
      tmuxArgs,
    );
    const process = this.pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.env.HOME || os.homedir(),
      // withTmuxDirOnPath: a server this client daemonizes must find `tmux` on
      // PATH for its plugins (resurrect/continuum) even when the app was
      // launched from the Dock with a minimal PATH.
      env: withTmuxDirOnPath(
        { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        this.tmuxPath,
        this.platform,
      ),
    });
    // sessionId is kept so callers can re-target session-scoped tmux options at
    // whatever this client is attached to (see localMouse in tmux-settings).
    const active = { terminalId, process, sessionId, disposables: [] };
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

  attachedSessionId() {
    return this.active?.sessionId || null;
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

module.exports = { TerminalManager, TERMINAL_FEATURES, validateDimensions };

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

const TERMINAL_THEMES = {
  light: {
    background: '#fbfbfc', foreground: '#20242c', cursor: '#1769e0', cursorAccent: '#ffffff',
    selectionBackground: '#b9d4ff99', black: '#20242c', red: '#c9343f', green: '#177245',
    yellow: '#8a6200', blue: '#1769e0', magenta: '#8750ad', cyan: '#087f8c', white: '#e8ebef',
    brightBlack: '#6f7785', brightRed: '#d84b56', brightGreen: '#268657', brightYellow: '#a77700',
    brightBlue: '#3281ee', brightMagenta: '#9b67be', brightCyan: '#1594a1', brightWhite: '#ffffff',
  },
  dark: {
    background: '#111318', foreground: '#d8dde7', cursor: '#8bb8ff', cursorAccent: '#111318',
    selectionBackground: '#31588a99', black: '#20242d', red: '#f06a74', green: '#68d391',
    yellow: '#e7b75d', blue: '#74a9f5', magenta: '#c495e8', cyan: '#67c6d2', white: '#d8dde7',
    brightBlack: '#727b8c', brightRed: '#ff7c86', brightGreen: '#7ae3a3', brightYellow: '#f4c76f',
    brightBlue: '#8bb8ff', brightMagenta: '#d5a8f3', brightCyan: '#7dd8e3', brightWhite: '#ffffff',
  },
};

class TerminalView {
  constructor({ container, api, onExit, onError }) {
    this.api = api;
    this.onExit = onExit;
    this.onError = onError;
    this.terminalId = null;
    this.attachRequest = 0;
    this.pendingData = new Map();
    this.terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: false,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      letterSpacing: 0,
      scrollback: 10000,
      theme: TERMINAL_THEMES.light,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(container);
    // Terminals send \r for both Enter and Shift+Enter, so a TUI can't tell them
    // apart. Cancel the hidden textarea's native Enter action, then send one bare
    // LF byte. Without preventDefault(), Chromium emits an extra CR after our LF,
    // which makes Claude Code submit the message immediately after adding a line.
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter'
        && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        event.stopPropagation();
        if (this.terminalId !== null) {
          this.api.writeTerminal({ terminalId: this.terminalId, data: '\n' }).catch((error) => this.onError?.(error));
        }
        return false;
      }
      return true;
    });
    this.dataDisposable = this.terminal.onData((data) => {
      if (this.terminalId === null) return;
      this.api.writeTerminal({ terminalId: this.terminalId, data }).catch((error) => this.onError?.(error));
    });
    this.unsubscribeData = api.onTerminalData((payload) => this.handleData(payload));
    this.unsubscribeExit = api.onTerminalExit((payload) => this.handleExit(payload));
    this.container = container;
    this.fitRetries = 0;
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(container);
    // Moving the window to a display with a different devicePixelRatio makes
    // xterm re-round its cell width, so the canvas can outgrow the container by
    // a column without any element resize — refit on every DPR change.
    this.watchDevicePixelRatio();
  }

  watchDevicePixelRatio() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.dprMedia?.removeEventListener('change', this.onDprChange);
    this.onDprChange = () => {
      this.scheduleFit();
      this.watchDevicePixelRatio();
    };
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMedia.addEventListener('change', this.onDprChange, { once: true });
  }

  async attach(sessionId) {
    const request = ++this.attachRequest;
    this.terminalId = null;
    this.pendingData.clear();
    this.terminal.reset();
    this.fitAddon.fit();
    const result = await this.api.attachTerminal({
      sessionId,
      cols: Math.max(2, this.terminal.cols),
      rows: Math.max(1, this.terminal.rows),
    });
    if (request !== this.attachRequest) return null;
    this.terminalId = result.terminalId;
    const pending = this.pendingData.get(this.terminalId);
    if (pending) this.terminal.write(pending);
    this.pendingData.clear();
    this.terminal.focus();
    this.scheduleFit();
    return result;
  }

  handleData({ terminalId, data } = {}) {
    if (terminalId === this.terminalId) {
      this.terminal.write(data);
      return;
    }
    if (this.terminalId === null && Number.isInteger(terminalId) && typeof data === 'string') {
      const buffered = `${this.pendingData.get(terminalId) || ''}${data}`;
      this.pendingData.set(terminalId, buffered.slice(-1024 * 1024));
    }
  }

  handleExit(payload = {}) {
    if (payload.terminalId !== this.terminalId) return;
    this.terminalId = null;
    this.onExit?.(payload);
  }

  setTheme(theme) {
    this.terminal.options.theme = TERMINAL_THEMES[theme] || TERMINAL_THEMES.light;
  }

  scheduleFit() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      try {
        this.fitAddon.fit();
        if (this.terminalId !== null) {
          this.api.resizeTerminal({
            terminalId: this.terminalId,
            cols: Math.max(2, this.terminal.cols),
            rows: Math.max(1, this.terminal.rows),
          }).catch((error) => this.onError?.(error));
        }
        if (this.gridOverflows() && this.fitRetries < 3) {
          this.fitRetries += 1;
          this.scheduleFit();
          return;
        }
        this.fitRetries = 0;
      } catch {
        // fit() can throw while the container is mid-transition or hidden; retry
        // once the layout settles instead of keeping a stale, oversized grid.
        if (this.fitRetries < 3) {
          this.fitRetries += 1;
          this.scheduleFit();
        } else {
          this.fitRetries = 0;
        }
      }
    });
  }

  gridOverflows() {
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    if (!screen) return false;
    return screen.getBoundingClientRect().right > this.container.getBoundingClientRect().right + 1;
  }

  focus() { this.terminal.focus(); }

  async detach() {
    this.attachRequest += 1;
    this.terminalId = null;
    this.pendingData.clear();
    await this.api.detachTerminal();
  }

  dispose() {
    cancelAnimationFrame(this.fitFrame);
    this.dprMedia?.removeEventListener('change', this.onDprChange);
    this.resizeObserver.disconnect();
    this.dataDisposable.dispose();
    this.unsubscribeData?.();
    this.unsubscribeExit?.();
    this.terminal.dispose();
  }
}

module.exports = { TerminalView };

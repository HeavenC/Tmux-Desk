const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { ClipboardAddon } = require('@xterm/addon-clipboard');
const { WebglAddon } = require('@xterm/addon-webgl');

const SELECTION_COPY_DEBOUNCE_MS = 200;

// "Tmux Desk Mono" is a composite @font-face defined in styles.css: Menlo for
// everything except the wide-CJK unicode ranges, which go to PingFang SC.
// Without it, Menlo's own half-width glyphs win for fullwidth punctuation
// （）。「」 and xterm pads them to two cells with ~9px of letter-spacing —
// the "中文标点特别宽" complaint. (A flat font list can't fix this: PingFang
// placed before Menlo would also capture Latin with proportional glyphs.)
const TERMINAL_FONT_FAMILY = '"Tmux Desk Mono", Menlo, Monaco, Consolas, monospace';

// tmux emits OSC52 with an EMPTY selection parameter (\e]52;;<base64>), but
// the addon's default BrowserClipboardProvider only acts on selection "c" and
// silently drops everything else — tmux copies never reached the clipboard.
class TmuxClipboardProvider {
  async readText(selection) {
    if (selection !== 'c' && selection !== '') return '';
    return navigator.clipboard.readText();
  }

  async writeText(selection, text) {
    if (selection !== 'c' && selection !== '' && selection !== 'p' && selection !== 's') return;
    return navigator.clipboard.writeText(text);
  }
}

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
  constructor({ container, api, onExit, onError, onResize }) {
    this.api = api;
    this.onExit = onExit;
    this.onError = onError;
    this.onResize = onResize;
    this.terminalId = null;
    this.attachRequest = 0;
    this.pendingData = new Map();
    this.terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: false,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.22,
      letterSpacing: 0,
      scrollback: 10000,
      theme: TERMINAL_THEMES.light,
      // iTerm habit: Option+drag always yields a local xterm.js selection even
      // while tmux mouse mode owns the drag, so it can be auto-copied below.
      macOptionClickForcesSelection: true,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    // Lets tmux's OSC52 (set-clipboard external, emitted because attach() now
    // requests the "clipboard" terminal feature) reach the system clipboard —
    // xterm.js otherwise ignores OSC52 entirely.
    this.clipboardAddon = new ClipboardAddon(undefined, new TmuxClipboardProvider());
    this.terminal.loadAddon(this.clipboardAddon);
    this.terminal.open(container);
    // WebGL renderer: besides speed, its canvas-based glyph measurement honors
    // the composite "Tmux Desk Mono" @font-face. Chromium's DOM layout path
    // ignores unicode-range on local() faces, so the DOM renderer would keep
    // Menlo's narrow fullwidth-punctuation glyphs plus ~9px letter-spacing.
    try {
      this.webglAddon = new WebglAddon();
      this.webglAddon.onContextLoss(() => {
        this.webglAddon?.dispose();
        this.webglAddon = null;
      });
      this.terminal.loadAddon(this.webglAddon);
    } catch {
      this.webglAddon = null; // DOM renderer fallback
    }
    this.setupCompositionShift();
    // The composite local() @font-face can finish loading after first paint,
    // and the DOM renderer caches each char's measured width forever — once
    // the font is definitely in, toggle fontFamily to drop xterm's WidthCache
    // and re-measure, or CJK punctuation keeps its pre-load Menlo width.
    if (typeof document !== 'undefined' && document.fonts?.load) {
      document.fonts.load('13px "Tmux Desk Mono"', 'Aa中。（）').then(() => {
        const family = this.terminal.options.fontFamily;
        this.terminal.options.fontFamily = 'monospace';
        this.terminal.options.fontFamily = family;
      }).catch(() => {});
    }
    // Terminals send \r for both Enter and Shift+Enter, so a TUI can't tell them
    // apart. Cancel the hidden textarea's native Enter action, then send one bare
    // LF byte. Without preventDefault(), Chromium emits an extra CR after our LF,
    // which makes some TUIs submit the message immediately after adding a line.
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
    // iTerm-style select-to-copy: debounced so a multi-cell drag doesn't fire a
    // clipboard write per row; covers Shift+drag / Option+drag local selections
    // that bypass tmux's own mouse-mode copy-on-release.
    this.selectionChangeTimer = null;
    this.selectionChangeDisposable = this.terminal.onSelectionChange(() => {
      clearTimeout(this.selectionChangeTimer);
      this.selectionChangeTimer = setTimeout(() => this.copySelectionToClipboard(), SELECTION_COPY_DEBOUNCE_MS);
    });
    // Electron's Cmd+C menu item is the `copy` role, which issues the DOM copy
    // command — but xterm.js keeps its selection off the DOM, so that command
    // finds nothing to copy. Intercept it and fill clipboardData ourselves.
    this.onCopyEvent = (event) => {
      if (!this.terminal.hasSelection()) return;
      const text = this.terminal.getSelection();
      if (!text) return;
      event.clipboardData?.setData('text/plain', text);
      event.preventDefault();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('copy', this.onCopyEvent);
    }
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
        // The grid settled at a new size; tmux reflows its panes to match, so
        // let the app re-place the per-pane close overlays against fresh cells.
        this.onResize?.();
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

  // Pixel geometry of the character grid, so callers can map tmux cell
  // coordinates (pane_left/top/width/height) onto screen pixels. Rect is in
  // viewport coordinates; divide by cols/rows for a single cell's size.
  getGridMetrics() {
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    if (!screen || !cols || !rows) return null;
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      left: rect.left,
      top: rect.top,
      cellWidth: rect.width / cols,
      cellHeight: rect.height / rows,
      cols,
      rows,
    };
  }

  gridOverflows() {
    const screen = this.terminal.element?.querySelector('.xterm-screen');
    if (!screen) return false;
    return screen.getBoundingClientRect().right > this.container.getBoundingClientRect().right + 1;
  }

  // xterm.js shows the IME preedit as an opaque box that simply covers whatever
  // sits after the cursor. Replace it with iTerm's presentation: the preedit is
  // drawn underlined at the cursor and the rest of the line is pushed to the
  // right while composing (the real buffer is untouched until the IME commits).
  setupCompositionShift() {
    const root = this.terminal.element;
    const view = root?.querySelector('.composition-view');
    const textarea = root?.querySelector('.xterm-helper-textarea');
    if (!view || !textarea || !view.parentElement) return;
    // Keep xterm's own composition view in the layout (its rect still anchors
    // the IME candidate window and tells us where the cursor is), just unseen.
    view.style.visibility = 'hidden';
    this.compositionView = view;
    this.compositionTextarea = textarea;
    const overlay = document.createElement('div');
    overlay.className = 'composition-shift';
    this.compositionPreedit = document.createElement('span');
    this.compositionPreedit.className = 'composition-shift-preedit';
    this.compositionTrail = document.createElement('span');
    overlay.append(this.compositionPreedit, this.compositionTrail);
    view.parentElement.append(overlay);
    this.compositionOverlay = overlay;
    this.onCompositionUpdate = (event) => this.renderCompositionShift(String(event.data ?? ''));
    this.onCompositionEnd = () => this.hideCompositionShift();
    textarea.addEventListener('compositionstart', this.onCompositionUpdate);
    textarea.addEventListener('compositionupdate', this.onCompositionUpdate);
    textarea.addEventListener('compositionend', this.onCompositionEnd);
    textarea.addEventListener('blur', this.onCompositionEnd);
  }

  renderCompositionShift(preedit) {
    if (!this.compositionOverlay) return;
    // xterm's CompositionHelper re-places .composition-view on a macrotask
    // after each composition event; defer the same way, then mirror it.
    clearTimeout(this.compositionShiftTimer);
    this.compositionShiftTimer = setTimeout(() => {
      const overlay = this.compositionOverlay;
      const root = this.terminal.element;
      if (!overlay || !root) return;
      const buffer = this.terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      const trail = line ? line.translateToString(true, buffer.cursorX) : '';
      const theme = this.terminal.options.theme || {};
      const row = root.querySelector('.xterm-rows > div');
      overlay.style.left = this.compositionView.style.left || '0px';
      overlay.style.top = this.compositionView.style.top || '0px';
      overlay.style.lineHeight = row ? getComputedStyle(row).height : 'normal';
      overlay.style.background = theme.background || '';
      overlay.style.color = theme.foreground || '';
      const screen = root.querySelector('.xterm-screen');
      if (screen) {
        overlay.style.maxWidth = `${Math.max(0, screen.clientWidth - (parseFloat(overlay.style.left) || 0))}px`;
      }
      this.compositionPreedit.textContent = preedit;
      this.compositionTrail.textContent = trail;
      overlay.classList.toggle('active', preedit.length > 0);
    }, 0);
  }

  hideCompositionShift() {
    clearTimeout(this.compositionShiftTimer);
    this.compositionOverlay?.classList.remove('active');
  }

  copySelectionToClipboard() {
    if (!this.terminal.hasSelection()) return;
    const text = this.terminal.getSelection();
    if (!text) return;
    // navigator.clipboard.writeText rejects (or throws in some engines) when
    // the window/document isn't focused — fail silently rather than surface
    // an error for what's meant to be an invisible convenience copy.
    try {
      navigator.clipboard?.writeText(text)?.catch(() => {});
    } catch {}
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
    clearTimeout(this.selectionChangeTimer);
    clearTimeout(this.compositionShiftTimer);
    if (this.compositionTextarea) {
      this.compositionTextarea.removeEventListener('compositionstart', this.onCompositionUpdate);
      this.compositionTextarea.removeEventListener('compositionupdate', this.onCompositionUpdate);
      this.compositionTextarea.removeEventListener('compositionend', this.onCompositionEnd);
      this.compositionTextarea.removeEventListener('blur', this.onCompositionEnd);
    }
    this.compositionOverlay?.remove();
    this.dprMedia?.removeEventListener('change', this.onDprChange);
    this.resizeObserver.disconnect();
    this.dataDisposable.dispose();
    this.selectionChangeDisposable?.dispose();
    if (typeof document !== 'undefined') {
      document.removeEventListener('copy', this.onCopyEvent);
    }
    this.unsubscribeData?.();
    this.unsubscribeExit?.();
    this.terminal.dispose();
  }
}

module.exports = { TerminalView };

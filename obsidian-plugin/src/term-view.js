// Agent terminal tab: xterm.js + a pseudo-terminal on system tools (pty.js).
// The tab state (agent kind, tab id, folder and command) is kept by Obsidian in the layout and
// handed back after a restart: the command runs again, and the tab script brings back its session
// from the registry. From outside the tab looks like a Terminal plugin tab (emulator.terminal,
// emulator.pseudoterminal.shell), so the Active view code works with both.
import { ItemView } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import * as os from "os";
import * as path from "path";
import { spawnPty } from "./pty";
import { AGENT_VIEW_TYPE } from "./constants";

const DEFAULT_SHELL = "/bin/zsh";

/** Fit only a visible tab. Obsidian shrinks a hidden one to zero: fitting it would report a tiny
 *  screen to the program, and on return Claude Code would redraw everything. */
const MIN_BOX_PX = 40;
const RESIZE_SETTLE_MS = 80;
function canFit(box) {
  return !!box && box.isConnected !== false && box.clientWidth >= MIN_BOX_PX && box.clientHeight >= MIN_BOX_PX;
}

/** Keys the terminal sends indistinguishably by default. Shift+Enter works as after
 *  `/terminal-setup` in iTerm2 and VS Code: ESC+Enter, which Claude Code reads as a new line. */
function specialKey(e) {
  if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return "\x1b\r";
  return null;
}
const RECLAIM_MS = 120000;

// Tab processes live in a window-wide registry: it survives a plugin reload (toggle, update), and
// the new copy picks up the process by tab id without cutting off the agent.
function registry() {
  if (!window.__sessionAtlasPtys) {
    window.__sessionAtlasPtys = new Map();
    // Quitting Obsidian ends them all: otherwise the tabs would start second processes on the next launch.
    window.addEventListener("beforeunload", () => {
      for (const { pty } of window.__sessionAtlasPtys.values()) pty.kill();
    });
  }
  return window.__sessionAtlasPtys;
}

/**
 * After a reload, keep every held process whose tab is still in the layout. Background tabs load
 * only when shown, so the reclaim timer would otherwise end their agents while nobody looks.
 * Output keeps going into the process's buffer until the tab opens. Returns the kept tab ids.
 */
function keepHeldTabs(workspace) {
  if (!workspace || typeof workspace.iterateAllLeaves !== "function") return [];
  // The saved view state, not the view: a leaf can hold a placeholder until it loads.
  const wanted = new Set();
  workspace.iterateAllLeaves((leaf) => {
    const state = leaf.getViewState && leaf.getViewState();
    if (state && state.type === AGENT_VIEW_TYPE && state.state && state.state.instance) wanted.add(state.state.instance);
  });
  const kept = [];
  for (const [key, held] of registry()) {
    if (!wanted.has(key) || !held.timer) continue;
    window.clearTimeout(held.timer);
    held.timer = null;
    kept.push(key);
  }
  return kept;
}

/** Terminal colours come from the Obsidian theme: light and dark without configuration. */
function themeFromCss(el) {
  const css = getComputedStyle(el);
  const v = (name, fallback) => (css.getPropertyValue(name) || "").trim() || fallback;
  return {
    background: v("--background-primary", "#1e1e1e"),
    foreground: v("--text-normal", "#dcddde"),
    cursor: v("--text-accent", "#7f6df2"),
    selectionBackground: v("--text-selection", "rgba(127,109,242,.35)"),
  };
}

/** Follows an Obsidian theme change (by hand, or with the system at nightfall) in the terminal colours.
 *  Returns true when the colours changed. */
function applyTheme(term, el) {
  if (!term) return false;
  const next = themeFromCss(el);
  const now = term.options.theme || {};
  if (Object.keys(next).every((k) => now[k] === next[k])) return false;
  term.options.theme = next;
  return true;
}

class AgentTerminalView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {};
    this.emulator = null;
  }

  getViewType() { return AGENT_VIEW_TYPE; }
  getDisplayText() { return this.state.title || "Terminal"; }

  /** Obsidian updates the tab label; the title above the content is ours to update. */
  refreshTitle() {
    if (this.leaf.updateHeader) this.leaf.updateHeader();
    if (this.titleEl && this.titleEl.setText) this.titleEl.setText(this.getDisplayText());
  }

  /** A title from the program (Claude Code sends the session name) becomes the tab name. */
  setLiveTitle(title) {
    const clean = String(title || "").trim();
    if (!clean || clean === this.state.title) return;
    this.state.title = clean;                     // in the view state: the same name after a restart
    this.refreshTitle();
    const workspace = this.app && this.app.workspace;
    if (workspace && workspace.requestSaveLayout) workspace.requestSaveLayout();
  }
  getIcon() { return this.state.kind === "codex" ? "codex-bot" : "bot"; }
  getState() { return Object.assign({}, this.state); }

  async setState(state, result) {
    this.state = Object.assign({}, state || {});
    if (super.setState) await super.setState(state, result);
    this.refreshTitle();
    if (!this.pty && this.state.command) this.start();
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("session-atlas-terminal");
    this.box = this.contentEl.createDiv({ cls: "session-atlas-terminal-box" });
  }

  start() {
    if (!this.box) this.box = this.contentEl.createDiv({ cls: "session-atlas-terminal-box" });
    const settings = this.plugin.settings || {};
    const term = new Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue("--font-monospace") || "Menlo, monospace",
      fontSize: Number(settings.terminalFontSize) || 13,
      theme: themeFromCss(document.body),
      scrollback: 10000,
      macOptionIsMeta: true,
      // Claude Code takes the mouse (modes 1000–1006): select with ⌥ held, as in iTerm2.
      macOptionClickForcesSelection: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri)));
    term.open(this.box);
    if (canFit(this.box)) { try { fit.fit(); } catch { /* the tab has no size yet */ } }
    // ⌘C with a selection copies; otherwise the key goes to the terminal as is.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      const special = specialKey(e);
      if (special) {
        if (e.type === "keydown" && this.pty) this.pty.write(special);
        return false;                    // both keydown and keypress: a plain Enter must not follow
      }
      return true;
    });

    const key = this.state.instance || null;
    const held = key ? registry().get(key) : null;
    let pty;
    if (held && !held.pty.exited) {
      // The plugin was reloaded and the process is alive: pick it up and show what was on screen.
      window.clearTimeout(held.timer);
      pty = held.pty;
      term.write(pty.recent());
      pty.resize(term.cols, term.rows);
    } else {
      const shell = settings.shellPath || process.env.SHELL || DEFAULT_SHELL;
      // The tab script reads extra agent arguments from this install's data folder.
      const env = Object.assign({}, process.env, { TERM: "xterm-256color", COLORTERM: "truecolor",
        OBS_AGENT_TERMINAL_ARGS_DIR: path.join(this.plugin.dataDir(), "agent-args") });
      if (!env.LANG) env.LANG = "en_US.UTF-8";      // launched from the Dock, Obsidian has no locale
      pty = spawnPty({ file: shell, args: ["-l", "-i", "-c", this.state.command],
                       cwd: this.state.cwd || os.homedir(), env, cols: term.cols, rows: term.rows });
    }
    if (key) registry().set(key, { pty, timer: null });
    this.pty = pty;
    this.term = term;
    pty.onData((data) => term.write(data));
    pty.onExit(() => term.write(`\r\n\x1b[2m[${this.plugin.t("terminal.exited")}]\x1b[0m\r\n`));
    term.onData((data) => pty.write(data));
    term.onTitleChange((title) => this.setLiveTitle(title));
    term.onResize(({ cols, rows }) => pty.resize(cols, rows));
    // Consecutive changes (dragging the window) make one fit: each fit makes the program redraw.
    let settle = null;
    this.resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (!canFit(this.box)) return;
        try { fit.fit(); } catch { /* the tab was closed */ }
      }, RESIZE_SETTLE_MS);
    });
    this.resizeObserver.observe(this.box);
    // Same shape as Terminal plugin tabs: the Active view reads the screen and types through it.
    const shellInfo = { pid: pty.pid, stdin: { write: (data) => pty.write(data) } };
    this.emulator = { terminal: term, pseudoterminal: Promise.resolve({ shell: Promise.resolve(shellInfo) }) };
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) term.focus();
    }));
    // Obsidian switches the theme with a class on body (theme-dark / theme-light) and fires css-change.
    this.registerEvent(this.app.workspace.on("css-change", () => applyTheme(term, document.body)));
    this.themeObserver = new MutationObserver(() => applyTheme(term, document.body));
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (this.state.focus !== false) term.focus();
  }

  /**
   * The tab was closed: the process ends. When the plugin itself unloads (Obsidian has already
   * cleared its _loaded), the process waits RECLAIM_MS for the new plugin copy and only then ends.
   */
  async onClose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.themeObserver) this.themeObserver.disconnect();
    const key = this.state.instance;
    if (this.pty) {
      const unloading = this.plugin && this.plugin._loaded === false;
      if (unloading && key && !this.pty.exited) {
        const pty = this.pty;
        pty.onData(null);
        registry().set(key, { pty, timer: window.setTimeout(() => { pty.kill(); registry().delete(key); }, RECLAIM_MS) });
      } else {
        this.pty.kill();
        if (key) registry().delete(key);
      }
    }
    if (this.term) this.term.dispose();
    this.pty = null;
  }
}

export { AgentTerminalView, specialKey, canFit, applyTheme, keepHeldTabs };

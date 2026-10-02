// Вкладка терминала агента: xterm.js + псевдотерминал на системных утилитах (pty.js).
// Состояние вкладки — вид агента, id вкладки, папка и команда: Obsidian хранит его в раскладке
// и после перезапуска отдаёт обратно, команда запускается снова, а скрипт вкладки по реестру
// возвращает её сессию. Снаружи вкладка выглядит как у плагина Terminal (emulator.terminal,
// emulator.pseudoterminal.shell) — код «Активных» работает с обоими.
const { ItemView } = require("obsidian");
const { spawnPty } = require("./pty");
const { AGENT_VIEW_TYPE } = require("./constants");

const DEFAULT_SHELL = "/bin/zsh";

/** Клавиши, которые терминал по умолчанию шлёт неотличимо. Shift+Enter — как после
 *  `/terminal-setup` в iTerm2 и VS Code: ESC+Enter, Claude Code читает это как новую строку. */
/** Подгонять размер только видимой вкладке. Скрытую Obsidian сжимает до нуля: подгонка
 *  сообщила бы программе крошечный экран, и при возврате Claude Code перерисовывал бы всё заново. */
const MIN_BOX_PX = 40;
const RESIZE_SETTLE_MS = 80;
function canFit(box) {
  return !!box && box.isConnected !== false && box.clientWidth >= MIN_BOX_PX && box.clientHeight >= MIN_BOX_PX;
}

function specialKey(e) {
  if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return "\x1b\r";
  return null;
}
const RECLAIM_MS = 120000;

// Процессы вкладок — в общем реестре окна: он переживает перезагрузку плагина (тумблер,
// обновление), и новая копия подхватывает процесс по id вкладки, не обрывая агента.
function registry() {
  if (!window.__sessionAtlasPtys) {
    window.__sessionAtlasPtys = new Map();
    // Выход из Obsidian — гасим всех: иначе после запуска вкладки подняли бы вторые процессы.
    window.addEventListener("beforeunload", () => {
      for (const { pty } of window.__sessionAtlasPtys.values()) pty.kill();
    });
  }
  return window.__sessionAtlasPtys;
}

/** Цвета терминала — из темы Obsidian: светлая и тёмная без настройки. */
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

/** Тема Obsidian сменилась (вручную или вслед за системой вечером) — цвета терминала следом.
 *  Возвращает true, если цвета поменялись. */
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

  /** Ярлык вкладки обновляет Obsidian, заголовок над содержимым — только мы. */
  refreshTitle() {
    if (this.leaf.updateHeader) this.leaf.updateHeader();
    if (this.titleEl && this.titleEl.setText) this.titleEl.setText(this.getDisplayText());
  }

  /** Заголовок от программы (Claude Code присылает имя сессии) — в название вкладки. */
  setLiveTitle(title) {
    const clean = String(title || "").trim();
    if (!clean || clean === this.state.title) return;
    this.state.title = clean;                     // в состоянии вида: после перезапуска то же имя
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
    // Лениво: xterm нужен только в Obsidian, а не в тестах моста.
    const { Terminal } = require("./xterm");
    const { FitAddon } = require("./xterm-fit");
    const { WebLinksAddon } = require("./xterm-links");
    const settings = this.plugin.settings || {};
    const term = new Terminal({
      fontFamily: getComputedStyle(document.body).getPropertyValue("--font-monospace") || "Menlo, monospace",
      fontSize: Number(settings.terminalFontSize) || 13,
      theme: themeFromCss(document.body),
      scrollback: 10000,
      macOptionIsMeta: true,
      // Claude Code забирает мышь себе (режимы 1000–1006): выделять — с зажатым ⌥, как в iTerm2.
      macOptionClickForcesSelection: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri)));
    term.open(this.box);
    if (canFit(this.box)) { try { fit.fit(); } catch (error) { /* вкладка ещё без размеров */ } }
    // ⌘C с выделением — копировать; иначе клавиша уходит в терминал как есть.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      const special = specialKey(e);
      if (special) {
        if (e.type === "keydown" && this.pty) this.pty.write(special);
        return false;                    // и keydown, и keypress: обычный Enter не уйдёт следом
      }
      return true;
    });

    const key = this.state.instance || null;
    const held = key ? registry().get(key) : null;
    let pty;
    if (held && !held.pty.exited) {
      // Плагин перезагрузили — процесс жив: подхватываем и показываем, что было на экране.
      clearTimeout(held.timer);
      pty = held.pty;
      term.write(pty.recent());
      pty.resize(term.cols, term.rows);
    } else {
      const shell = settings.shellPath || process.env.SHELL || DEFAULT_SHELL;
      const env = Object.assign({}, process.env, { TERM: "xterm-256color", COLORTERM: "truecolor" });
      if (!env.LANG) env.LANG = "en_US.UTF-8";      // из Dock Obsidian стартует без локали
      pty = spawnPty({ file: shell, args: ["-l", "-i", "-c", this.state.command],
                       cwd: this.state.cwd || process.env.HOME, env, cols: term.cols, rows: term.rows });
    }
    if (key) registry().set(key, { pty, timer: null });
    this.pty = pty;
    this.term = term;
    pty.onData((data) => term.write(data));
    pty.onExit(() => term.write(`\r\n\x1b[2m[${this.plugin.t("terminal.exited")}]\x1b[0m\r\n`));
    term.onData((data) => pty.write(data));
    term.onTitleChange((title) => this.setLiveTitle(title));
    term.onResize(({ cols, rows }) => pty.resize(cols, rows));
    // Подряд идущие изменения (тянут окно) — одна подгонка: каждая заставляет программу перерисоваться.
    let settle = null;
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (!canFit(this.box)) return;
        try { fit.fit(); } catch (error) { /* вкладку закрыли */ }
      }, RESIZE_SETTLE_MS);
    });
    this.resizeObserver.observe(this.box);
    // Тот же вид, что у вкладок плагина Terminal: по нему «Активные» читают экран и печатают.
    const shellInfo = { pid: pty.pid, stdin: { write: (data) => pty.write(data) } };
    this.emulator = { terminal: term, pseudoterminal: Promise.resolve({ shell: Promise.resolve(shellInfo) }) };
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf === this.leaf) term.focus();
    }));
    // Obsidian меняет тему классом на body (theme-dark / theme-light) и сообщает css-change.
    this.registerEvent(this.app.workspace.on("css-change", () => applyTheme(term, document.body)));
    this.themeObserver = new MutationObserver(() => applyTheme(term, document.body));
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (this.state.focus !== false) term.focus();
  }

  /**
   * Вкладку закрыли — процесс гасим. Выгружается сам плагин (Obsidian в этот момент уже
   * снял с него _loaded) — процесс ждёт новую копию плагина RECLAIM_MS и только потом гаснет.
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
        registry().set(key, { pty, timer: setTimeout(() => { pty.kill(); registry().delete(key); }, RECLAIM_MS) });
      } else {
        this.pty.kill();
        if (key) registry().delete(key);
      }
    }
    if (this.term) this.term.dispose();
    this.pty = null;
  }
}

module.exports = { AgentTerminalView, specialKey, canFit, applyTheme };

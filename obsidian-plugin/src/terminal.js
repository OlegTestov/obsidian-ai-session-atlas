// Вкладки плагина Terminal: поиск PTY, ввод, профиль запуска. Подмешивается в класс плагина.
const { Notice } = require("obsidian");
const childProcess = require("child_process");
const fsSync = require("fs");
const path = require("path");
const { parseLaunch } = require("./agents");
const {
  PTY_WAIT_MS,
  AGENT_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  SESSIONS_DIR,
  UPLOADS_DIR,
  IMAGE_EXT,
  MAX_IMAGES,
} = require("./constants");

class TerminalMethods {
  /**
   * PID прокси PTY, который плагин Terminal запускает на вкладку: процесс claude — его потомок.
   * Путь `view.emulator.pseudoterminal.shell` — геттер и поля плагина Terminal 3.x.
   */
  async ptyPidOf(leaf) {
    const wait = (promise) => Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => window.setTimeout(() => resolve(null), PTY_WAIT_MS)),
    ]);
    try {
      const emulator = leaf && leaf.view && leaf.view.emulator;
      const pty = emulator ? await wait(emulator.pseudoterminal) : null;
      const shell = pty ? await wait(pty.shell) : null;
      return shell && Number.isInteger(shell.pid) ? shell.pid : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Вкладки и исправность связи. Причина — словами для страницы: связь рвётся, когда плагин
   * Terminal выключен или его внутренности поменялись с обновлением (путь к PTY не наш API).
   */
  async terminalReport() {
    const leaves = this.terminalLeaves();
    const tabs = await this.terminalTabs();
    if (leaves.length && !tabs.length) {
      return { tabs, health: { ok: false,
        reason: this.t("health.noProcess") } };
    }
    if (tabs.length && !(await this.ptyInput(tabs[0].leaf))) {
      return { tabs, health: { ok: false, reason: this.t("input.noInput") } };
    }
    return { tabs, health: { ok: true, reason: tabs.length ? null : this.t("health.noTabs") } };
  }

  /** Свои вкладки агентов и оставшиеся вкладки плагина Terminal — у них одинаковый вид. */
  terminalLeaves() {
    const ws = this.app.workspace;
    return [...ws.getLeavesOfType(AGENT_VIEW_TYPE), ...ws.getLeavesOfType(TERMINAL_VIEW_TYPE)];
  }

  async terminalTabs() {
    const tabs = [];
    for (const leaf of this.terminalLeaves()) {
      const pid = await this.ptyPidOf(leaf);
      if (!pid) continue;
      const title = leaf.view && typeof leaf.view.getDisplayText === "function"
        ? leaf.view.getDisplayText() : "Terminal";
      tabs.push({ leaf, pid, title: title || "Terminal" });
    }
    return tabs;
  }

  /** Только свои загрузки: иначе страница могла бы подсунуть сессии любой файл диска. */
  checkImages(list) {
    if (list === undefined) return [];
    if (!Array.isArray(list) || list.length > MAX_IMAGES) return null;
    const root = path.resolve(UPLOADS_DIR) + path.sep;
    const out = [];
    for (const item of list) {
      if (typeof item !== "string") return null;
      const full = path.resolve(item);
      if (!full.startsWith(root) || !IMAGE_EXT.test(full) || !fsSync.existsSync(full)) return null;
      out.push(full);
    }
    return out;
  }

  /**
   * Видимый экран вкладки строками — как его рисует xterm плагина Terminal
   * (`emulator.terminal`, тот же объект, что держит PTY). Нижняя страница буфера — экран.
   */
  screenLines(leaf) {
    try {
      const term = leaf.view.emulator.terminal;
      const buffer = term.buffer.active;
      const lines = [];
      for (let i = buffer.baseY; i < buffer.baseY + term.rows; i++) {
        const line = buffer.getLine(i);
        lines.push(line ? line.translateToString(true) : "");
      }
      return lines;
    } catch (error) {
      return [];
    }
  }

  async ptyInput(leaf) {
    try {
      const emulator = leaf.view.emulator;
      const pty = await emulator.pseudoterminal;
      const shell = await pty.shell;
      return shell && shell.stdin && typeof shell.stdin.write === "function" ? shell.stdin : null;
    } catch (error) {
      return null;
    }
  }

  /** Состояние процесса Claude Code — из его файла, прямо перед вводом. */
  readSessionState(claudePid) {
    try {
      return JSON.parse(fsSync.readFileSync(path.join(SESSIONS_DIR, `${claudePid}.json`), "utf8"));
    } catch (error) {
      return null;
    }
  }

  isDescendant(pid, ancestor) {
    let current = pid;
    for (let i = 0; i < 32 && current > 1; i++) {
      if (current === ancestor) return true;
      current = this.parentPid(current);
    }
    return false;
  }

  parentPid(pid) {
    try {
      const out = childProcess.execFileSync("ps", ["-o", "ppid=", "-p", String(pid)],
                                            { encoding: "utf8", timeout: 2000 });
      return Number.parseInt(out.trim(), 10) || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Команда из каталога. Узнанную (продолжить, форк, новая) открываем через скрипт вкладок
   * агента — тогда после перезапуска Obsidian вкладка вернёт свою сессию. Остальное — как есть.
   */
  async openCommandInTerminal(command, cwd, label) {
    const launch = parseLaunch(command);
    if (launch && (await this.openAgent("claude", { cwd: launch.cwd, seed: launch, label }))) return;
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: AGENT_VIEW_TYPE,
        active: true,
        state: { kind: "shell", instance: null, cwd: cwd || this.getVaultPath(), title: label, command },
      });
      this.app.workspace.revealLeaf(leaf);
      new Notice(this.t("terminal.opened", { label }));
    } catch (error) {
      console.error(error);
      new Notice(this.t("terminal.failed", { error: error.message }));
    }
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  }
}

/**
 * Только печатный текст, переводы строк и табуляция. Управляющие символы из поля ответа
 * в терминал не проходят: Ctrl-C, Esc и escape-последовательности управляли бы сессией.
 */
function cleanInput(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

module.exports = { TerminalMethods, cleanInput };

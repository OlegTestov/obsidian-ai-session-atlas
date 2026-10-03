// Terminal tabs: PTY lookup, input, launch. Mixed into the plugin class.
import { Notice } from "obsidian";
import * as childProcess from "child_process";
import * as fsSync from "fs";
import * as path from "path";
import { parseLaunch } from "./agents";
import {
  PTY_WAIT_MS,
  AGENT_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  SESSIONS_DIR,
  UPLOADS_DIR,
  IMAGE_EXT,
  MAX_IMAGES,
} from "./constants";

class TerminalMethods {
  /**
   * PID of the PTY proxy started per terminal tab: the claude process descends from it.
   * The path `view.emulator.pseudoterminal.shell` is a getter and fields of Terminal plugin 3.x.
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
    } catch {
      return null;
    }
  }

  /**
   * Tabs and link health. The reason is in words for the page: the link breaks when the Terminal
   * plugin is disabled or its internals change in an update (the PTY path is not a public API).
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

  /** Our own agent tabs and any remaining Terminal plugin tabs: both have the same shape. */
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

  /** Only our own uploads: otherwise the page could hand the session any file on disk. */
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
   * The tab's visible screen as lines, as xterm draws it (`emulator.terminal`, the object that
   * holds the PTY). The bottom page of the buffer is the screen.
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
    } catch {
      return [];
    }
  }

  async ptyInput(leaf) {
    try {
      const emulator = leaf.view.emulator;
      const pty = await emulator.pseudoterminal;
      const shell = await pty.shell;
      return shell && shell.stdin && typeof shell.stdin.write === "function" ? shell.stdin : null;
    } catch {
      return null;
    }
  }

  /** State of the Claude Code process, read from its file right before input. */
  readSessionState(claudePid) {
    try {
      return JSON.parse(fsSync.readFileSync(path.join(SESSIONS_DIR, `${claudePid}.json`), "utf8"));
    } catch {
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
    } catch {
      return 0;
    }
  }

  /**
   * A command from the catalog. A recognized one (resume, fork, new) opens through the agent tab
   * script, so after an Obsidian restart the tab gets its session back. Anything else runs as is.
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
 * Printable text, line breaks and tabs only. Control characters from the reply field never reach
 * the terminal: Ctrl-C, Esc and escape sequences would control the session.
 */
function cleanInput(text) {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  return String(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export { TerminalMethods, cleanInput };

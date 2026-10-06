// Terminal tabs: PTY lookup, input, launch. Mixed into the plugin class.
import { Notice } from "obsidian";
import * as childProcess from "child_process";
import * as fsSync from "fs";
import * as path from "path";
import { parseLaunch } from "./agents";
import { attachedSessionState } from "./attach";
import { codexScreenState } from "./dialog-codex";
import {
  PTY_WAIT_MS,
  AGENT_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  SESSIONS_DIR,
  REGISTRY_FILE,
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
    const root = path.resolve(this.dataDir(), "uploads") + path.sep;
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

  /**
   * The agent's state right before input. Claude Code: its process file. Codex keeps no such file:
   * the session id comes from the rollout file the process holds open, the status from the screen.
   */
  readAgentState(pid, leaf) {
    // A tab attached to a background job: the job's file holds the session and its status.
    const claude = this.readSessionState(pid) || attachedSessionState(pid, SESSIONS_DIR);
    if (claude) return Object.assign({ agent: "claude", sessionIds: [claude.sessionId] }, claude);
    if (this.processName(pid) !== "codex") return null;
    const ids = this.codexSessionIds(pid);
    if (!ids.length) return null;
    return { agent: "codex", sessionIds: ids, sessionId: ids[0], status: codexScreenState(this.screenLines(leaf)) };
  }

  /** The executable's base name: "codex" for the native binary, also when npm's wrapper started it. */
  processName(pid) {
    try {
      const out = childProcess.execFileSync("ps", ["-o", "comm=", "-p", String(pid)],
                                            { encoding: "utf8", timeout: 2000 });
      return path.basename(out.trim());
    } catch {
      return "";
    }
  }

  /** Thread ids of the rollouts the Codex process has open (rollout-<time>-<id>.jsonl). */
  codexSessionIds(pid) {
    try {
      const out = childProcess.execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-Fn"],
                                            { encoding: "utf8", timeout: 3000 });
      const ids = [];
      for (const line of out.split("\n")) {
        const m = /^n.*\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(line);
        if (m && !ids.includes(m[1])) ids.push(m[1]);
      }
      return ids;
    } catch {
      return [];
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
    // The session already has a tab, maybe one Obsidian brought back but has not loaded yet: show it.
    // A second tab would start a second process on the same conversation once both are open.
    if (launch && launch.mode === "resume" && this.revealSessionTab(launch.sessionId)) return;
    if (launch && (await this.openAgent(launch.agent, { cwd: launch.cwd, seed: launch, label }))) return;
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

  /** The layout's agent tab (loaded or not) whose registry entry is this session; revealed if found. */
  revealSessionTab(sessionId) {
    const workspace = this.app && this.app.workspace;
    if (!workspace || typeof workspace.iterateAllLeaves !== "function") return false;
    const instances = tabInstancesOf(readRegistry(this.registryFile || REGISTRY_FILE), sessionId);
    if (!instances.size) return false;
    let found = null;
    workspace.iterateAllLeaves((leaf) => {
      const state = !found && leaf.getViewState && leaf.getViewState();
      if (state && state.type === AGENT_VIEW_TYPE && state.state && instances.has(state.state.instance)) found = leaf;
    });
    if (!found) return false;
    workspace.revealLeaf(found);
    return true;
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  }
}

/** The tab script's registry (agent-registry-lib.zsh): kind, instance, session id, vault, time per line. */
function readRegistry(file) {
  try {
    return fsSync.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Tab instances whose recorded session is this one (instance ids are random: no folder check). */
function tabInstancesOf(registry, sessionId) {
  const out = new Set();
  if (!sessionId) return out;
  for (const line of String(registry).split("\n")) {
    const [, instance, session] = line.split("\t");
    if (instance && session === sessionId) out.add(instance);
  }
  return out;
}

/**
 * Printable text, line breaks and tabs only. Control characters from the reply field never reach
 * the terminal: Ctrl-C, Esc and escape sequences would control the session.
 */
function cleanInput(text) {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  return String(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export { TerminalMethods, cleanInput, tabInstancesOf };

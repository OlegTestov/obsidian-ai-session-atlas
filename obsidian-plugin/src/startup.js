// Agents come back by themselves after Obsidian starts. Obsidian loads a background tab only when it
// is shown, so every agent tab is loaded here, one at a time and without taking the focus. Processes
// left by an Obsidian that ended without closing its tabs (a crash, a forced quit, older versions)
// are ended first: no window shows them any more, and they hold the sessions the tabs bring back.
// Mixed into the plugin class.
import * as childProcess from "child_process";
import * as path from "path";
import { AGENT_VIEW_TYPE } from "./constants";

// Each agent starts its MCP servers: one at a time keeps a start-up with many tabs bearable. The next
// tab waits for this one's agent to start (a login shell first): its script must see what runs where.
const LOAD_GAP_MS = 1500;
const AGENT_START_MS = 10000;
const AGENT = /(^|\/)(claude|codex)( |$)/;

/**
 * Processes of tab trees that belong to launchd (their Obsidian is gone) and run this install's tab
 * script. The top of a tree (`sh -c … atlas-pty`) leads its process group; `script` is left alone
 * when its top has already ended.
 */
function orphanTabProcesses(psText, scriptPath) {
  const out = [];
  for (const line of String(psText).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || m[2] !== "1" || !/ atlas-pty( |$)/.test(m[3]) || !m[3].includes(scriptPath)) continue;
    if (m[3].startsWith("/bin/sh -c ")) out.push({ pid: Number(m[1]), group: true });
    else if (m[3].startsWith("/usr/bin/script ")) out.push({ pid: Number(m[1]), group: false });
  }
  return out;
}

/** True when a process under root runs an agent (`claude …`, `codex …`), in a `ps` listing. */
function agentUnder(psText, root) {
  const children = new Map();
  const commands = new Map();
  for (const line of String(psText).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    commands.set(pid, m[3]);
    if (!children.has(Number(m[2]))) children.set(Number(m[2]), []);
    children.get(Number(m[2])).push(pid);
  }
  const queue = [...(children.get(root) || [])];
  while (queue.length) {
    const pid = queue.shift();
    if (AGENT.test(commands.get(pid) || "")) return true;
    queue.push(...(children.get(pid) || []));
  }
  return false;
}

/** Agent tabs Obsidian has restored but not loaded yet. */
function deferredAgentLeaves(workspace) {
  const out = [];
  if (!workspace || typeof workspace.iterateAllLeaves !== "function") return out;
  workspace.iterateAllLeaves((leaf) => {
    const st = leaf.getViewState && leaf.getViewState();
    const s = st && st.type === AGENT_VIEW_TYPE ? st.state || {} : null;
    if (s && leaf.isDeferred && typeof leaf.loadIfDeferred === "function"
        && (s.kind === "claude" || s.kind === "codex") && s.instance) out.push(leaf);
  });
  return out;
}

/** Agent tabs already loaded (the one in front, ones shown meanwhile). */
function loadedAgentLeaves(workspace) {
  const out = [];
  if (!workspace || typeof workspace.iterateAllLeaves !== "function") return out;
  workspace.iterateAllLeaves((leaf) => {
    const st = leaf.getViewState && leaf.getViewState();
    if (st && st.type === AGENT_VIEW_TYPE && !leaf.isDeferred && leaf.view && leaf.view.pty) out.push(leaf);
  });
  return out;
}

class StartupMethods {
  /** Ends what an earlier Obsidian left running; returns how many trees were ended. */
  endOrphanTabs() {
    let text;
    try {
      text = childProcess.execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="],
                                       { encoding: "utf8", timeout: 5000, maxBuffer: 64 << 20 });
    } catch {
      return 0;
    }
    let ended = 0;
    for (const { pid, group } of orphanTabProcesses(text, path.join(this.runtimeDir(), "scripts"))) {
      // SIGHUP, as closing a tab: Claude Code saves its session and quits.
      try { process.kill(group ? -pid : pid, "SIGHUP"); ended++; } catch { /* already gone */ }
    }
    return ended;
  }

  /** Until the tab's agent runs, or the time is up (the script may ask something or start nothing). */
  async waitForAgent(leaf, limitMs) {
    const end = Date.now() + limitMs;
    while (Date.now() < end) {
      // The view starts its terminal a moment after the tab loads.
      const pty = leaf.view && leaf.view.pty;
      if (pty && pty.exited) return false;
      let text = "";
      try {
        if (pty) text = childProcess.execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,command="],
                                                  { encoding: "utf8", timeout: 3000, maxBuffer: 64 << 20 });
      } catch { /* try again */ }
      if (pty && agentUnder(text, pty.pid)) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    return false;
  }

  /** Loads the restored agent tabs one by one; the tab in front stays in front. */
  async loadAgentTabs(gapMs = LOAD_GAP_MS) {
    if (this.loadingAgentTabs || (this.settings && this.settings.loadAgentTabs === false)) return 0;
    this.loadingAgentTabs = true;
    let loaded = 0;
    try {
      // The tab in front was loaded by Obsidian itself, at the same moment: its agent goes first.
      for (const leaf of loadedAgentLeaves(this.app && this.app.workspace)) {
        await this.waitForAgent(leaf, gapMs ? AGENT_START_MS : 0);
      }
      for (const leaf of deferredAgentLeaves(this.app && this.app.workspace)) {
        if (this._loaded === false) break;
        if (!leaf.isDeferred) continue;              // shown meanwhile: it loaded itself
        this.loadingInBackground = true;
        try {
          await leaf.loadIfDeferred();
          loaded++;
        } catch (error) {
          console.error("AI Session Atlas: could not load an agent tab", error);
        } finally {
          this.loadingInBackground = false;
        }
        await this.waitForAgent(leaf, gapMs ? AGENT_START_MS : 0);
        if (gapMs) await new Promise((resolve) => window.setTimeout(resolve, gapMs));
      }
    } finally {
      this.loadingAgentTabs = false;
    }
    return loaded;
  }
}

export { StartupMethods, orphanTabProcesses, deferredAgentLeaves, agentUnder, LOAD_GAP_MS };

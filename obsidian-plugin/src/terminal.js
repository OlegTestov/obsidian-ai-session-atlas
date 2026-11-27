// Terminal tabs: PTY lookup, input, launch. Mixed into the plugin class.
import { Notice } from "obsidian";
import * as childProcess from "child_process";
import * as fsSync from "fs";
import * as path from "path";
import { parseLaunch, supportsTerminal } from "./agents";
import { idPattern, UnknownAgent } from "./agent-registry";
import { openCodeLaunchEnded, readOpenCodeTab, waitForOpenCodeSession } from "./opencode-tab";
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

const CODEX_ID = idPattern("codex").slice(1, -1);
const CODEX_THREAD = new RegExp(`^${CODEX_ID}$`);
const CODEX_ROLLOUT = new RegExp(`^rollout-[^/]*-(${CODEX_ID})(?:_${CODEX_ID})?\\.jsonl$`);
const CODEX_BINARY = /^codex(?:-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-musl))?$/;
// Keep the options that consume the next argv word in sync with codex_procs._resume_id.
const CODEX_VALUE_FLAGS = new Set(["-m", "--model", "-c", "--config", "-C", "--cd", "-p", "--profile",
  "-s", "--sandbox", "-a", "--ask-for-approval", "-i", "--image", "--add-dir", "--enable", "--disable",
  "--local-provider", "--oss-provider", "--remote"]);
const CODEX_META_LIMIT = 4 * 1024 * 1024;

function codexMeta(file) {
  let fd;
  try {
    fd = fsSync.openSync(file, "r");
    const chunks = [];
    for (let offset = 0; offset < CODEX_META_LIMIT; offset += 4096) {
      const buffer = Buffer.alloc(4096);
      const data = buffer.subarray(0, fsSync.readSync(fd, buffer));
      if (!data.length) break;
      const end = data.indexOf(10);
      if (end >= 0) {
        chunks.push(data.subarray(0, end));
        const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return record.type === "session_meta" ? record.payload || {} : {};
      }
      chunks.push(data);
    }
    return {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fsSync.closeSync(fd);
  }
}

function codexRollout(file) {
  const id = CODEX_ROLLOUT.exec(path.basename(file))?.[1];
  if (!id) return null;
  const meta = codexMeta(file);
  const source = meta.source;
  const subagent = meta.thread_source === "subagent"
    || (source != null && typeof source === "object" && Object.hasOwn(source, "subagent"));
  const parent = meta.parent_thread_id ?? source?.subagent?.thread_spawn?.parent_thread_id;
  return { id, subagent, parent: typeof parent === "string" && CODEX_THREAD.test(parent) ? parent : null };
}

function codexThreadFile(home, id) {
  let found = null;
  function scan(folder, ancestors) {
    let entries, real;
    try {
      real = fsSync.realpathSync(folder);
      if (ancestors.has(real)) return;
      entries = fsSync.readdirSync(folder, { withFileTypes: true });
    } catch { return; }
    const seen = new Set([...ancestors, real]);
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { scan(file, seen); continue; }
      const matching = CODEX_ROLLOUT.exec(entry.name)?.[1] === id;
      if (!matching && !entry.isSymbolicLink()) continue;
      try {
        const stat = fsSync.statSync(file, { bigint: true });
        if (stat.isDirectory()) scan(file, seen);
        else if (stat.isFile() && matching
            && (!found || stat.mtimeNs > found.mtime || (stat.mtimeNs === found.mtime && file > found.file))) {
          found = { file, mtime: stat.mtimeNs };
        }
      } catch { /* the file was moved during the scan */ }
    }
  }
  scan(path.join(home, "sessions"), new Set());
  scan(path.join(home, "archived_sessions"), new Set());
  return found ? codexRollout(found.file) : null;
}

function codexRoot(home, rollout, byId) {
  const seen = new Set();
  while (rollout?.subagent && rollout.parent && !seen.has(rollout.id)) {
    seen.add(rollout.id);
    rollout = byId.get(rollout.parent) || codexThreadFile(home, rollout.parent);
  }
  if (!rollout || rollout.subagent) return null;
  // The backend requires a human root on disk when only its descendants are open.
  const root = codexThreadFile(home, rollout.id);
  return root && !root.subagent ? root.id : null;
}

function codexResumeId(pid) {
  try {
    const argv = childProcess.execFileSync("ps", ["-o", "command=", "-p", String(pid)],
                                           { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/);
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i];
      if (!word.startsWith("-")) return word === "resume" && CODEX_THREAD.test(argv[i + 1]) ? argv[i + 1] : null;
      if (CODEX_VALUE_FLAGS.has(word)) i++;
    }
  } catch { /* the command is an optional hint */ }
  return null;
}

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

  emptyAgentPrompt(leaf, agent) {
    if (!supportsTerminal(agent) || agent === "opencode") return false;
    try {
      const terminal = leaf.view.emulator.terminal;
      const buffer = terminal.buffer.active;
      if (buffer.viewportY !== buffer.baseY) return false;
      const lines = this.screenLines(leaf);
      const y = buffer.cursorY;
      const row = lines[y] || "";
      const marker = agent === "codex" ? "›" : "❯";
      if (buffer.cursorX !== 2 || !row.startsWith(marker)) return false;
      if (agent === "claude") {
        // Claude puts the session name in the upper rule after /rename.
        const topRule = /^─{5,}(?: .+ ─+)?$/;
        if (!topRule.test(lines[y - 1]?.trim()) || !/^─{5,}$/.test(lines[y + 1]?.trim())) return false;
      } else if (agent === "codex") {
        if (codexScreenState(lines) !== "idle" || lines[y + 1]?.trim() !== "") return false;
      } else return false;
      if (!row.slice(1).trim()) return true;
      if (row[1] !== " " && row[1] !== "\u00a0") return false;
      // Both TUIs show hints in dim cells while their empty composer has the cursor at its start.
      const line = buffer.getLine(buffer.baseY + y);
      for (let x = 2; x < row.length && x < terminal.cols; x++) {
        const cell = line?.getCell(x);
        if (!cell || (cell.getChars().trim() && !cell.isDim())) return false;
      }
      return true;
    } catch {
      return false;
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
    if (!CODEX_BINARY.test(this.processName(pid))) return null;
    const ids = this.codexSessionIds(pid);
    if (!ids.length) return null;
    return { agent: "codex", sessionIds: ids, sessionId: ids[0], status: codexScreenState(this.screenLines(leaf)) };
  }

  /** A card can type into its new Codex tab before that process has a thread id. */
  readPendingState(pid, id, leaf) {
    if (this.tabAgent(leaf) !== "codex") return null;
    let fields;
    try {
      fields = childProcess.execFileSync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
        encoding: "utf8", timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      }).trim().split(/\s+/);
    } catch {
      return null;
    }
    const binary = path.basename(fields.slice(5).join(" "));
    if (!CODEX_BINARY.test(binary)
        || id !== `pending-codex-${pid}-${fields.slice(0, 5).join("-")}`) return null;
    // The id binds this exact process, so its card keeps working once the first message created
    // the thread, until the page swaps in the real card.
    return { pending: true, agent: "codex", sessionIds: [id], status: codexScreenState(this.screenLines(leaf)) };
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

  /** The single human thread selected by the same open-file rules as the server. */
  codexSessionIds(pid) {
    try {
      const home = fsSync.realpathSync(this.codexHome());
      const out = childProcess.execFileSync("/usr/sbin/lsof", ["-w", "-n", "-P", "-F", "pfna", "-p", String(pid)],
                                            { encoding: "utf8", timeout: 3000 });
      const opened = new Map();
      let writable = false;
      for (const line of out.split("\n")) {
        if (line.startsWith("f") || line.startsWith("p")) writable = false;
        else if (line.startsWith("a")) writable = line === "aw" || line === "au";
        else if (line.startsWith("n/")) {
          const file = line.slice(1);
          if (!CODEX_ROLLOUT.test(path.basename(file))) continue;
          const previous = opened.get(file);
          if (previous) {
            previous.writable ||= writable;
            continue;
          }
          try {
            const relative = path.relative(home, fsSync.realpathSync(file));
            if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
            const stat = fsSync.statSync(file, { bigint: true });
            if (stat.isFile()) opened.set(file, { ...codexRollout(file), file, writable, mtime: stat.mtimeNs });
          } catch { /* ignore a closed or moved rollout */ }
        }
      }
      const rollouts = [...opened.values()];
      const human = rollouts.filter(rollout => !rollout.subagent);
      const byWrite = (a, b) => Number(b.writable) - Number(a.writable);
      const byTime = (a, b) => a.mtime === b.mtime ? 0 : a.mtime > b.mtime ? -1 : 1;
      if (human.length) {
        const resume = human.length > 1 ? codexResumeId(pid) : null;
        const byResume = (a, b) => Number(b.id === resume) - Number(a.id === resume);
        human.sort((a, b) => byWrite(a, b) || (!a.writable && byResume(a, b))
          || byTime(a, b) || byResume(a, b) || (a.file > b.file ? -1 : 1));
        return [human[0].id];
      }
      const byId = new Map(rollouts.map(rollout => [rollout.id, rollout]));
      for (const rollout of rollouts.sort((a, b) => byWrite(a, b) || byTime(a, b))) {
        const id = codexRoot(home, rollout, byId);
        if (id) return [id];
      }
      return [];
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
  async openCommandInTerminal(command, cwd, label, onOpened) {
    let launch;
    try {
      launch = parseLaunch(command);
    } catch (error) {
      if (!(error instanceof UnknownAgent)) throw error;
      new Notice(this.t("terminal.failed", { error: error.message }));
      return;
    }
    const openCatalog = () => {
      if (launch?.agent !== "opencode") return this.openCatalogCommand(command, cwd, label, launch, onOpened);
      // An OpenCode leaf can be reused only after its current route is confirmed.
      const existing = launch.mode === "resume" && this.revealOpenCodeSession(launch.sessionId);
      if (existing) {
        return waitForOpenCodeSession(this.dataDir(), existing.leaf, existing.instance, launch.sessionId,
                                      this.app.workspace);
      }
      return this.openAgent(launch.agent, { cwd: launch.cwd, seed: launch, label, onOpened });
    };
    if (launch?.mode === "resume") {
      if (launch.agent !== "opencode" && this.revealSessionTab(launch.sessionId)) return true;
      // A second handoff can arrive before the launcher writes the session to the tab registry.
      const workspace = this.app?.workspace || this;
      const workspaces = window.__sessionAtlasPendingResumes ??= new WeakMap();
      if (!workspaces.has(workspace)) workspaces.set(workspace, new Map());
      const resumes = workspaces.get(workspace);
      const key = `${launch.agent}:${launch.sessionId}`;
      const pending = resumes.get(key);
      if (pending) return pending;
      const opening = Promise.resolve().then(openCatalog);
      resumes.set(key, opening);
      try {
        return await opening;
      } finally {
        resumes.delete(key);
      }
    }
    // A background job already shown in a tab: that tab, not a second view of the same conversation.
    if (launch && launch.mode === "attach" && (await this.revealJobTab(launch.sessionId))) return true;
    return openCatalog();
  }

  async openCatalogCommand(command, cwd, label, launch, onOpened) {
    if (launch) {
      const opened = await this.openAgent(launch.agent, { cwd: launch.cwd, seed: launch, label, onOpened });
      // A partial managed launch can already have started a process. Its failure owns the cleanup.
      if (opened !== false) return opened === true;
    }
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: AGENT_VIEW_TYPE,
        active: true,
        state: { kind: "shell", instance: null, cwd: cwd || this.getVaultPath(), title: label, command },
      });
      this.app.workspace.revealLeaf(leaf);
      new Notice(this.t("terminal.opened", { label }));
      return true;
    } catch (error) {
      console.error(error);
      new Notice(this.t("terminal.failed", { error: error.message }));
      return false;
    }
  }

  /** The layout's agent tab (loaded or not) whose registry entry is this session; revealed if found. */
  revealSessionTab(sessionId) {
    const workspace = this.app && this.app.workspace;
    if (!workspace || typeof workspace.iterateAllLeaves !== "function") return false;
    const instances = tabInstancesOf(readRegistry(this.registryFile || REGISTRY_FILE), sessionId);
    let found = null;
    workspace.iterateAllLeaves((leaf) => {
      const state = !found && leaf.getViewState && leaf.getViewState();
      if (state?.type !== AGENT_VIEW_TYPE || !state.state) return;
      const data = state.state;
      if (instances.has(data.instance)) found = leaf;
    });
    if (!found) return false;
    workspace.revealLeaf(found);
    return true;
  }

  revealOpenCodeSession(sessionId) {
    const workspace = this.app.workspace;
    let found;
    const exited = [];
    workspace?.iterateAllLeaves?.(leaf => {
      const state = leaf.getViewState?.();
      if (state?.type !== AGENT_VIEW_TYPE || state.state?.kind !== "opencode") return;
      const { instance, seedId } = state.state;
      const record = readOpenCodeTab(this.dataDir(), instance);
      const pty = leaf.view?.pty;
      const sid = pty && record?.verified ? record.current : record?.last || seedId;
      if (sid !== sessionId) return;
      if (openCodeLaunchEnded(this.dataDir(), instance, pty)) exited.push(leaf);
      else if (!found) found = { leaf, instance };
    });
    exited.forEach(leaf => leaf.detach?.());
    if (found) workspace.revealLeaf(found.leaf);
    return found;
  }

  /** The tab showing this background job (`claude attach <job>` in its tree), loaded or restored. */
  async revealJobTab(jobId) {
    const workspace = this.app && this.app.workspace;
    if (!workspace || !/^[0-9a-f]{8}$/.test(jobId || "")) return false;
    const viewers = attachProcesses(listProcesses(), jobId);
    for (const tab of viewers.length ? await this.terminalTabs() : []) {
      if (viewers.some((pid) => this.isDescendant(pid, tab.pid))) {
        workspace.revealLeaf(tab.leaf);
        return true;
      }
    }
    // A restored tab not loaded yet: its registry entry is the job's session (the job id starts it).
    const registry = readRegistry(this.registryFile || REGISTRY_FILE);
    const sessions = new Set(String(registry).split("\n").map((l) => l.split("\t")[2])
      .filter((sid) => sid && sid.startsWith(`${jobId}-`)));
    for (const sid of sessions) if (this.revealSessionTab(sid)) return true;
    return false;
  }

  /** A tab the tab script found to duplicate another one: closed, with a word about it. */
  closeDuplicateTab(leaf, title) {
    if (!leaf || typeof leaf.detach !== "function") return;
    leaf.detach();
    new Notice(this.t("terminal.duplicateClosed", { title: title || "Claude Code" }));
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

/** pid → command of every process, as `ps` prints them. */
function listProcesses() {
  try {
    return childProcess.execFileSync("/bin/ps", ["-A", "-o", "pid=,command="],
                                     { encoding: "utf8", timeout: 3000, maxBuffer: 64 << 20 });
  } catch {
    return "";
  }
}

/** Pids of `claude attach <job>` processes in a `ps` listing. */
function attachProcesses(psText, jobId) {
  const out = [];
  for (const line of String(psText).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && new RegExp(`(^|/)claude attach ${jobId}$`).test(m[2].trim())) out.push(Number(m[1]));
  }
  return out;
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

export { TerminalMethods, cleanInput, tabInstancesOf, attachProcesses };

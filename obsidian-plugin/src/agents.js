// Agent tabs: the Claude Code and Codex ribbon buttons and sessions launched from the catalog.
// Every agent tab opens through one script (agent-resume-terminal.zsh): the tab has its own id,
// the script remembers which session ran in it and brings it back after an Obsidian restart.
// Mixed into the plugin class.
import { waitForOpenCodeSession } from "./opencode-tab";
import { Notice } from "obsidian";
import * as path from "path";
import * as fsSync from "fs";
import { AGENT_VIEW_TYPE } from "./constants";
import { AGENT_ICONS, registerAgentIcons } from "./agent-icons";
import { agentKinds, getAgent, UnknownAgent, validId } from "./agent-registry";

const SCRIPT_NAME = "agent-resume-terminal.zsh";
const AGENTS = Object.freeze(Object.fromEntries(agentKinds.map(kind => [kind, getAgent(kind).label])));

const TERMINALS = new Map([
  ["claude", { paletteId: "open-claude-code-terminal", icon: AGENT_ICONS.claude, parse: claudeLaunch }],
  ["codex", { paletteId: "open-codex-terminal", icon: AGENT_ICONS.codex, parse: codexLaunch }],
  ["opencode", { paletteId: "new-opencode-session", icon: AGENT_ICONS.opencode, parse: openCodeLaunch }],
]);

function terminalAgent(kind) {
  getAgent(kind);
  if (!TERMINALS.has(kind)) throw new UnknownAgent(`Agent ${kind} does not support terminal tabs`);
  return TERMINALS.get(kind);
}

function supportsTerminal(kind) {
  return TERMINALS.has(kind);
}

function restoreAgent(kind) {
  try {
    terminalAgent(kind);
    return true;
  } catch (error) {
    console.error("AI Session Atlas: could not restore an agent tab", error);
    return false;
  }
}
// A Claude Code background job, as `claude attach` takes it (the first 8 hex digits of its session).
const JOB_ID = /^[0-9a-f]{8}$/;
const AND = Symbol("&&");

/** POSIX quoting, the same as shlex.quote on the server. */
function shellQuote(text) {
  const s = String(text);
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Command words in shlex.quote format: '…', "'" inside, safe characters and "&&".
 * Anything else (;, |, $, backticks, \) gives null: such a command is not parsed.
 */
function shellWords(text) {
  const out = [];
  let cur = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " ") {
      if (cur !== null) { out.push(cur); cur = null; }
      i++;
    } else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return null;
      cur = (cur || "") + text.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const j = text.indexOf('"', i + 1);
      if (j < 0) return null;
      const inner = text.slice(i + 1, j);
      if (/[\\$`]/.test(inner)) return null;
      cur = (cur || "") + inner;
      i = j + 1;
    } else if (c === "&" && cur === null && text.slice(i, i + 3) === "&& ") {
      out.push(AND);
      i += 2;
    } else if (/[A-Za-z0-9@%+=:,./_-]/.test(c)) {
      cur = (cur || "") + c;
      i++;
    } else {
      return null;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * A first prompt the agent reads as a prompt only: the catalog puts a space before a "-x" and
 * before a single word (a Codex or Claude subcommand such as "resume" or "update").
 */
function plainPrompt(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return text.startsWith(" ") || (!text.startsWith("-") && text.trim().split(/\s+/).length >= 2);
}

/**
 * Catalog command → tab start. The catalog sends exactly these:
 *   cd '<folder>' && claude --resume <id> [--fork-session]
 *   cd '<folder>' && claude --session-id <id> ['<first prompt>']
 *   cd '<folder>' && claude attach <job id>          (a session running in a background job)
 *   cd '<folder>' && codex resume <id>
 *   cd '<folder>' && codex fork <id>               (a copy: Codex picks the copy's id itself)
 *   cd '<folder>' && codex ['<first prompt>']      (Codex picks the thread id itself)
 * {agent, cwd, mode: resume | resume-fork | new | attach, sessionId (the job id for attach), prompt} or null.
 */
function parseLaunch(command) {
  const w = shellWords(String(command || ""));
  if (!w || w.length < 4 || w[0] !== "cd" || typeof w[1] !== "string" || !w[1].startsWith("/")
      || w[2] !== AND || typeof w[3] !== "string" || w.slice(4).some((x) => typeof x !== "string")) return null;
  const args = w.slice(4);
  const start = (mode, id, prompt) => ({ agent: w[3], cwd: w[1], mode, sessionId: id, prompt: prompt || "" });
  const result = terminalAgent(w[3]).parse(args, start);
  if (!result && w[3] === "opencode") throw new UnknownAgent("Invalid OpenCode tab launch");
  return result;
}

function openCodeLaunch(args, start) {
  const [directory, flag, value] = args;
  if (directory !== start("new", "").cwd) return null;
  if (args.length === 1) return start("new", "");
  if (args.length !== 3) return null;
  if (flag === "--session" && validId("opencode", value)) return start("resume", value);
  if (flag === "--prompt" && value.trim()) return start("new", "", value);
  return null;
}

function codexLaunch(args, start) {
  if (args.length === 0) return start("new", "");
  if (args.length === 1 && plainPrompt(args[0])) return start("new", "", args[0]);
  if (args.length !== 2 || !validId("codex", args[1])) return null;
  if (args[0] === "resume") return start("resume", args[1]);
  return args[0] === "fork" ? start("resume-fork", args[1]) : null;
}

function claudeLaunch(args, start) {
  const [flag, id, ...rest] = args;
  if (flag === "attach") return rest.length === 0 && JOB_ID.test(id || "") ? start("attach", id) : null;
  if (!validId("claude", id)) return null;
  if (flag === "--resume" && rest.length === 0) return start("resume", id);
  if (flag === "--resume" && rest.length === 1 && rest[0] === "--fork-session") return start("resume-fork", id);
  if (flag === "--session-id" && rest.length === 0) return start("new", id);
  if (flag === "--session-id" && rest.length === 1 && plainPrompt(rest[0])) return start("new", id, rest[0]);
  return null;
}

/** Terminal arguments: script, agent kind, tab id, and the start when there is one. */
function agentArgs(scriptPath, kind, instance, seed) {
  terminalAgent(kind);
  const parts = ["exec", shellQuote(scriptPath), kind, instance];
  if (seed) {
    // A new Codex thread has no id yet: an empty word keeps the prompt in its place.
    parts.push(seed.mode, seed.sessionId ? shellQuote(seed.sessionId) : "''");
    if (seed.prompt && kind !== "opencode") parts.push(shellQuote(seed.prompt));
  }
  // -l -i: the user's profile is needed, otherwise claude is not on PATH.
  return ["-l", "-i", "-c", parts.join(" ")];
}

/** Where the tab script finds the extra arguments and the Agent Mail flags of this install. */
function agentTabEnv(dataDir) {
  return { OBS_AGENT_TERMINAL_ARGS_DIR: path.join(dataDir, "agent-args"),
           OBS_AGENT_MAIL_ARGS_DIR: path.join(dataDir, "agent-mail-args") };
}

function newInstanceId(kind) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2, 12);
  return `${kind}-${Date.now().toString(36)}-${random}`;
}

class AgentMethods {
  addAgentButtons() {
    registerAgentIcons();
    this.agentRibbons = {};
    // A disabled agent has no button and no palette command; enabling applies at once, without a restart.
    for (const kind of agentKinds) {
      if (!supportsTerminal(kind)) continue;
      const { icon, paletteId } = terminalAgent(kind);
      this.agentRibbons[kind] = this.addRibbonIcon(icon, this.t(`agent.${kind}`), () => this.openAgent(kind));
      this.addCommand({ id: paletteId,
                        name: this.t(`agent.${kind}.command`),
                        checkCallback: (checking) => {
                          if (!this.agentEnabled(kind)) return false;
                          if (!checking) this.openAgent(kind);
                          return true;
                        } });
    }
    this.refreshAgentButtons();
  }

  /** The user's own choice wins; otherwise what the last check found. Nothing found keeps Claude Code:
   *  its button stays and the environment check in the settings says what is missing. */
  agentEnabled(kind) {
    getAgent(kind);
    const chosen = (this.settings && this.settings.agents) || {};
    if (typeof chosen[kind] === "boolean") return chosen[kind];
    const found = this.settings && this.settings.agentsFound;
    if (!found) return kind === "claude";
    if (kind === "claude" && !agentKinds.some(id => found[id])) return true;
    return found[kind] === true;
  }

  refreshAgentButtons() {
    for (const [kind, el] of Object.entries(this.agentRibbons || {})) {
      if (el && typeof el.toggle === "function") el.toggle(this.agentEnabled(kind));
    }
  }

  /** First start with these settings: arguments already in the files move into the settings
   *  instead of being overwritten with empty ones. Returns true when something was taken. */
  adoptAgentArgs() {
    const dir = path.join(this.dataDir(), "agent-args");
    const found = {};
    for (const kind of agentKinds) {
      try { found[kind] = fsSync.readFileSync(path.join(dir, kind), "utf8").trim(); } catch { found[kind] = ""; }
    }
    this.settings.agentArgs = found;
    return Object.values(found).some(Boolean);
  }

  /** The extra-arguments line goes to the file the tab script reads. */
  writeAgentArgs() {
    const dir = path.join(this.dataDir(), "agent-args");
    fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const args = (this.settings && this.settings.agentArgs) || {};
    for (const kind of agentKinds) {
      fsSync.writeFileSync(path.join(dir, kind), String(args[kind] || "").replace(/[\r\n]+/g, " ").trim() + "\n");
    }
  }

  /** Every start: an agent installed after the plugin gets its button. A failed probe changes nothing. */
  async detectAgents() {
    const shell = await this.shellProbe();
    if (!shell || !shell.PATH) return this.settings.agentsFound || null;
    const found = Object.fromEntries(agentKinds.map(kind => [kind, !!shell[kind]]));
    // Up to 2.9.0 the first start saved Codex's probe result as if you had chosen it: drop it once.
    const chosen = this.settings.agents;
    if (!this.settings.agentsFound && chosen && typeof chosen.codex === "boolean") {
      this.settings.agents = Object.assign({}, chosen);
      delete this.settings.agents.codex;
    }
    if (JSON.stringify(found) !== JSON.stringify(this.settings.agentsFound || null)) {
      this.settings.agentsFound = found;
      await this.saveData(this.settings);
    }
    this.refreshAgentButtons();
    return found;
  }

  /** The script from the extracted build; for an install from the repository, the copy in the vault. */
  agentScriptPath() {
    const bundled = path.join(this.runtimeDir(), "scripts", SCRIPT_NAME);
    if (fsSync.existsSync(bundled)) return bundled;
    const vault = this.getVaultPath();
    return vault ? path.join(vault, this.app.vault.configDir, "scripts", SCRIPT_NAME) : "";
  }

  /**
   * An agent tab. Without opts it is the ribbon button: "Claude Code"/"Codex" title, vault folder.
   * opts: {cwd, seed, label} is a session from the catalog, labeled with its title; {group} puts the tab
   * into that session group.
   */
  async openAgent(kind, opts = {}) {
    let leaf, started = false;
    try {
      terminalAgent(kind);
      const script = this.agentScriptPath();
      if (!script || !fsSync.existsSync(script)) {
        new Notice(this.t("agent.noScript", { path: script || SCRIPT_NAME }));
        return false;
      }
      const instance = newInstanceId(kind);
      leaf = this.app.workspace.getLeaf("tab");
      if (!opts.group) this.placeOutsideGroup(leaf);
      const openCode = kind === "opencode" ? { firstPrompt: opts.seed?.prompt || "", seedId: opts.seed?.sessionId || "" } : {};
      await leaf.setViewState({
        type: AGENT_VIEW_TYPE,
        active: true,
        state: { kind, instance, cwd: opts.cwd || this.getVaultPath(), title: opts.label || getAgent(kind).label,
                 command: agentArgs(script, kind, instance, opts.seed || null)[3], ...openCode },
      });
      started = true;
      if (opts.group) this.joinGroup(leaf, opts.group);
      this.app.workspace.revealLeaf(leaf);
      if (kind === "opencode") {
        this.saveOpenCodeLayout?.();
        if (opts.seed?.mode === "resume"
            && !await waitForOpenCodeSession(
              this.dataDir(), leaf, instance, opts.seed.sessionId, this.app.workspace)) return false;
      }
      if (opts.label) new Notice(this.t("terminal.opened", { label: opts.label }));
      opts.onOpened?.(instance);
      return true;
    } catch (error) {
      if (!started) leaf?.detach?.();
      console.error(error);
      new Notice(this.t("terminal.failed", { error: error.message }));
      // A catalog launch may use a shell fallback only if no managed leaf was allocated.
      return leaf ? null : false;
    }
  }
}

export { AgentMethods, parseLaunch, agentArgs, agentTabEnv, shellQuote, shellWords, AGENTS, SCRIPT_NAME, terminalAgent, supportsTerminal, restoreAgent };

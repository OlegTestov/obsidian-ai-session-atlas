// Agent tabs: the Claude Code and Codex ribbon buttons and sessions launched from the catalog.
// Every agent tab opens through one script (agent-resume-terminal.zsh): the tab has its own id,
// the script remembers which session ran in it and brings it back after an Obsidian restart.
// Mixed into the plugin class.
import { Notice, addIcon } from "obsidian";
import * as path from "path";
import * as fsSync from "fs";
import { AGENT_VIEW_TYPE } from "./constants";

const SCRIPT_NAME = "agent-resume-terminal.zsh";
const AGENTS = { claude: "Claude Code", codex: "Codex" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A Claude Code background job, as `claude attach` takes it (the first 8 hex digits of its session).
const JOB_ID = /^[0-9a-f]{8}$/;
const AND = Symbol("&&");
const CODEX_ICON =
  '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M50 24V12" /><path d="M38 12h24" /><rect x="20" y="28" width="60" height="50" rx="10" />'
  + '<path d="M10 45v16" /><path d="M90 45v16" />'
  + '<circle cx="38" cy="50" r="4" fill="currentColor" stroke="none" />'
  + '<circle cx="62" cy="50" r="4" fill="currentColor" stroke="none" />'
  + '<path d="M38 62c6 8 18 8 24 0" /></g>';

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
 *   cd '<folder>' && codex ['<first prompt>']      (Codex picks the thread id itself)
 * {agent, cwd, mode: resume | resume-fork | new | attach, sessionId (the job id for attach), prompt} or null.
 */
function parseLaunch(command) {
  const w = shellWords(String(command || ""));
  if (!w || w.length < 4 || w[0] !== "cd" || typeof w[1] !== "string" || !w[1].startsWith("/")
      || w[2] !== AND || !AGENTS[w[3]] || w.slice(4).some((x) => typeof x !== "string")) return null;
  const args = w.slice(4);
  const start = (mode, id, prompt) => ({ agent: w[3], cwd: w[1], mode, sessionId: id, prompt: prompt || "" });
  if (w[3] === "codex") {
    if (args.length === 0) return start("new", "");
    if (args.length === 1 && plainPrompt(args[0])) return start("new", "", args[0]);
    return args.length === 2 && args[0] === "resume" && UUID.test(args[1]) ? start("resume", args[1]) : null;
  }
  const [flag, id, ...rest] = args;
  if (flag === "attach") return rest.length === 0 && JOB_ID.test(id || "") ? start("attach", id) : null;
  if (!UUID.test(id || "")) return null;
  if (flag === "--resume" && rest.length === 0) return start("resume", id);
  if (flag === "--resume" && rest.length === 1 && rest[0] === "--fork-session") return start("resume-fork", id);
  if (flag === "--session-id" && rest.length === 0) return start("new", id);
  if (flag === "--session-id" && rest.length === 1 && plainPrompt(rest[0])) return start("new", id, rest[0]);
  return null;
}

/** Terminal arguments: script, agent kind, tab id, and the start when there is one. */
function agentArgs(scriptPath, kind, instance, seed) {
  const parts = ["exec", shellQuote(scriptPath), kind, instance];
  if (seed) {
    // A new Codex thread has no id yet: an empty word keeps the prompt in its place.
    parts.push(seed.mode, seed.sessionId ? shellQuote(seed.sessionId) : "''");
    if (seed.prompt) parts.push(shellQuote(seed.prompt));
  }
  // -l -i: the user's profile is needed, otherwise claude is not on PATH.
  return ["-l", "-i", "-c", parts.join(" ")];
}

function newInstanceId(kind) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2, 12);
  return `${kind}-${Date.now().toString(36)}-${random}`;
}

class AgentMethods {
  addAgentButtons() {
    addIcon("codex-bot", CODEX_ICON);
    this.agentRibbons = {
      claude: this.addRibbonIcon("bot", this.t("agent.claude"), () => this.openAgent("claude")),
      codex: this.addRibbonIcon("codex-bot", this.t("agent.codex"), () => this.openAgent("codex")),
    };
    // A disabled agent has no button and no palette command; enabling applies at once, without a restart.
    for (const kind of Object.keys(AGENTS)) {
      this.addCommand({ id: kind === "claude" ? "open-claude-code-terminal" : "open-codex-terminal",
                        name: this.t(`agent.${kind}.command`),
                        checkCallback: (checking) => {
                          if (!this.agentEnabled(kind)) return false;
                          if (!checking) this.openAgent(kind);
                          return true;
                        } });
    }
    this.refreshAgentButtons();
  }

  agentEnabled(kind) {
    const agents = (this.settings && this.settings.agents) || {};
    return kind === "claude" ? agents.claude !== false : agents.codex === true;
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
    for (const kind of Object.keys(AGENTS)) {
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
    for (const kind of Object.keys(AGENTS)) {
      fsSync.writeFileSync(path.join(dir, kind), String(args[kind] || "").replace(/[\r\n]+/g, " ").trim() + "\n");
    }
  }

  /** Codex is on by default only when it is installed. */
  async detectAgents() {
    if (!this.settings.agents) this.settings.agents = {};
    if (this.settings.agents.codex !== undefined) return;
    const shell = await this.shellProbe();
    this.settings.agents.codex = !!shell.codex;
    await this.saveData(this.settings);
    this.refreshAgentButtons();
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
   * opts: {cwd, seed, label} is a session from the catalog, labeled with its title.
   */
  async openAgent(kind, opts = {}) {
    try {
      const script = this.agentScriptPath();
      if (!script || !fsSync.existsSync(script)) {
        new Notice(this.t("agent.noScript", { path: script || SCRIPT_NAME }));
        return false;
      }
      const instance = newInstanceId(kind);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: AGENT_VIEW_TYPE,
        active: true,
        state: { kind, instance, cwd: opts.cwd || this.getVaultPath(), title: opts.label || AGENTS[kind],
                 command: agentArgs(script, kind, instance, opts.seed || null)[3] },
      });
      this.app.workspace.revealLeaf(leaf);
      if (opts.label) new Notice(this.t("terminal.opened", { label: opts.label }));
      return true;
    } catch (error) {
      console.error(error);
      new Notice(this.t("terminal.failed", { error: error.message }));
      return false;
    }
  }
}

export { AgentMethods, parseLaunch, agentArgs, shellQuote, shellWords, AGENTS, SCRIPT_NAME };

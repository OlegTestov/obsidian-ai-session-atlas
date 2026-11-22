// Agent Mail without setup: every agent tab Atlas starts gets the bundled MCP server through launch
// flags, so the user's own Claude Code and Codex config files are never touched.
// Mixed into the plugin class; the tab script reads the line from agent-mail-args/<kind>.
import * as path from "path";
import * as fsSync from "fs";
import { shellQuote, supportsTerminal } from "./agents";
import { agentKinds } from "./agent-registry";
import { mailRoot } from "./mail-nudge";

const SERVER = "agent-mail";
const TOOLS = ["mail_send", "mail_inbox", "mail_register", "mail_peers"];
// A managed policy can forbid launch-time MCP configs; Claude Code then refuses to start at all.
const CLAUDE_MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";

function sideloadBlocked(file = CLAUDE_MANAGED) {
  try {
    return JSON.parse(fsSync.readFileSync(file, "utf8")).disableSideloadFlags === true;
  } catch {
    return false;
  }
}

/** The flag words that give one agent the mail server; [] for an unknown kind. */
function mailLaunchWords(kind, { python, script, root }) {
  const env = { AGENT_MAIL_NAME: kind, AGENT_MAIL_HOME: root };
  if (kind === "claude") {
    // --flag=value: both flags are variadic and would swallow the words after them.
    const config = { mcpServers: { [SERVER]: { type: "stdio", command: python, args: [script], env } } };
    return [`--mcp-config=${JSON.stringify(config)}`,
            `--allowedTools=${TOOLS.map(tool => `mcp__${SERVER}__${tool}`).join(",")}`];
  }
  if (kind === "codex") {
    const table = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",");
    const set = (key, value) => ["-c", `mcp_servers.${SERVER}.${key}=${value}`];
    return [...set("command", JSON.stringify(python)), ...set("args", `[${JSON.stringify(script)}]`),
            ...set("env", `{${table}}`), ...set("default_tools_approval_mode", '"approve"')];
  }
  return [];
}

class MailLaunchMethods {
  /** Writes the shell-quoted words per agent; an empty line when mail is off or something is missing. */
  async writeMailArgs() {
    const ticket = this.mailArgsTicket = (this.mailArgsTicket || 0) + 1;
    try {
      let input = null;
      if (this.settings && this.settings.wakeOnMail) {
        const root = mailRoot(this.settings);
        const python = await this.findPython();
        // An instance unloaded meanwhile (an update) must not write over the new one's runtime and flags.
        if (this._loaded === false) return;
        const payload = this.embeddedPayload();
        const script = path.join(payload ? this.extractRuntime(payload) : this.runtimeDir(), "atlas", "agent_mail.py");
        if (root && python && fsSync.existsSync(script)) input = { python: python.path, script, root };
      }
      if (ticket !== this.mailArgsTicket) return;      // a newer call is already writing
      const dir = path.join(this.dataDir(), "agent-mail-args");
      fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const blocked = sideloadBlocked(this.claudeManagedSettings);
      for (const kind of agentKinds.filter(kind => kind !== "opencode" && supportsTerminal(kind))) {
        const words = input && !(kind === "claude" && blocked) ? mailLaunchWords(kind, input) : [];
        fsSync.writeFileSync(path.join(dir, kind), words.map(shellQuote).join(" ") + "\n");
      }
    } catch (error) {
      console.error("AI Session Atlas: could not prepare the Agent Mail launch flags", error);
    }
  }
}

export { MailLaunchMethods, mailLaunchWords, sideloadBlocked };

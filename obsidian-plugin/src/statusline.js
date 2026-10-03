// Subscription limits: Claude Code hands them only to the status line script, so our script goes
// into ~/.claude/settings.json, only via the toggle and never over someone else's.
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";

// Claude Code runs the command through sh; single quotes keep the space in "Application Support".
const quote = (text) => "'" + String(text).replace(/'/g, "'\"'\"'") + "'";

const SCRIPT_REL = path.join("atlas", "statusline.py");
const BACKUP_SUFFIX = ".session-atlas.bak";

/** The command is ours when it calls this plugin's statusline.py, from the build or from the repository. */
function isOurStatusLine(command) {
  return /session-atlas/.test(String(command || "")) && /statusline\.py/.test(String(command || ""));
}

function statusLineCommand(python, runtimeDir) {
  return `${quote(python)} ${quote(path.join(runtimeDir, SCRIPT_REL))}`;
}

class StatusLineMethods {
  claudeSettingsPath() {
    const dir = this.claudeDirOverride || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return path.join(dir, "settings.json");
  }

  /** {state: "off" | "ours" | "foreign" | "broken", command} */
  statusLineState() {
    let data;
    try {
      data = JSON.parse(fsSync.readFileSync(this.claudeSettingsPath(), "utf8"));
    } catch (error) {
      return { state: error.code === "ENOENT" ? "off" : "broken", command: null };
    }
    const line = data && data.statusLine;
    const command = line && typeof line === "object" ? line.command : null;
    if (!command) return { state: "off", command: null };
    return { state: isOurStatusLine(command) ? "ours" : "foreign", command };
  }

  /** Turns our line on or off. A foreign line and an unreadable file are left alone: {ok, reason}. */
  async setStatusLine(on) {
    const { state } = this.statusLineState();
    if (state === "broken" || state === "foreign") return { ok: false, reason: state };
    if (!on && state === "off") return { ok: true };
    const file = this.claudeSettingsPath();
    let data = {};
    try { data = JSON.parse(fsSync.readFileSync(file, "utf8")); } catch { /* no file */ }
    if (on) {
      const python = await this.findPython();
      if (!python) return { ok: false, reason: "python" };
      const payload = this.embeddedPayload();
      const runtime = payload ? this.extractRuntime(payload) : this.runtimeDir();
      data.statusLine = { type: "command", command: statusLineCommand(python.path, runtime) };
    } else {
      delete data.statusLine;
    }
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    if (fsSync.existsSync(file) && !fsSync.existsSync(file + BACKUP_SUFFIX)) {
      fsSync.copyFileSync(file, file + BACKUP_SUFFIX);        // the first edit keeps a copy alongside
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fsSync.renameSync(tmp, file);
    return { ok: true };
  }
}

export { StatusLineMethods, isOurStatusLine, statusLineCommand, BACKUP_SUFFIX };

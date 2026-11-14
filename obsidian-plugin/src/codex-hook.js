// "Waiting for you" for Codex sessions outside Atlas tabs: Codex writes no approval prompt into its
// rollout, so a PermissionRequest hook marks the wait (atlas/codex_hook.py). The hook goes into Codex's
// own hooks file ($CODEX_HOME/hooks.json) only via the toggle, with a copy of the file kept next to it,
// and only Atlas's entry is ever added or removed. Codex asks to trust a new hook before it runs it, and
// keys that trust by the hook's position: Atlas's entry is removed only while it is the last one, so no
// hook of the user's moves. Otherwise turning it off leaves the entry in place and makes it do nothing
// (OFF_FLAG in Atlas's data folder, read by codex_hook.py); turning it on again reuses that entry.
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { BACKUP_SUFFIX } from "./statusline";

const quote = (text) => "'" + String(text).replace(/'/g, "'\"'\"'") + "'";
const EVENT = "PermissionRequest";
const SCRIPT_REL = path.join("atlas", "codex_hook.py");
const TIMEOUT_S = 5;
const OFF_FLAG = "codex-hook-off";        // kept in step with atlas/codex_hook.py

/** The hook is ours when it calls this plugin's codex_hook.py, from the build or from the repository. */
function isOurCodexHook(command) {
  return /session-atlas/.test(String(command || "")) && /codex_hook\.py/.test(String(command || ""));
}

function codexHookCommand(python, runtimeDir, dataDir) {
  return `${quote(python)} ${quote(path.join(runtimeDir, SCRIPT_REL))} ${quote(dataDir)}`;
}

const handlers = (group) => (group && Array.isArray(group.hooks) ? group.hooks : []);

/** The hooks file without Atlas's handlers; groups left empty by that go too. Pure. */
function withoutOurHook(data) {
  const out = JSON.parse(JSON.stringify(data || {}));
  const hooks = out.hooks && typeof out.hooks === "object" ? out.hooks : null;
  if (!hooks || !Array.isArray(hooks[EVENT])) return out;
  hooks[EVENT] = hooks[EVENT].map((group) => {
    const kept = handlers(group).filter((h) => !isOurCodexHook(h && h.command));
    return kept.length === handlers(group).length ? group : { ...group, hooks: kept };
  }).filter((group) => handlers(group).length > 0 || !Array.isArray(group && group.hooks));
  if (!hooks[EVENT].length) delete hooks[EVENT];
  return out;
}

const ourGroup = (group) => handlers(group).length === 1 && isOurCodexHook(handlers(group)[0].command);

/** Whether Atlas's hook can leave the file without moving a hook of the user's: its own group is the last
 *  PermissionRequest group and no other handler of Atlas's is left elsewhere. Pure. */
function removableHook(data) {
  const groups = data && data.hooks && Array.isArray(data.hooks[EVENT]) ? data.hooks[EVENT] : [];
  const ours = groups.filter((g) => handlers(g).some((h) => isOurCodexHook(h && h.command)));
  return ours.length === 1 && groups[groups.length - 1] === ours[0] && ourGroup(ours[0]);
}

/** The hooks file with Atlas's handler as the last PermissionRequest group: Codex keys trust by position,
 *  so the user's own hooks keep theirs. Pure. */
function withOurHook(data, command) {
  const out = withoutOurHook(data);
  if (!out.hooks || typeof out.hooks !== "object" || Array.isArray(out.hooks)) out.hooks = {};
  out.hooks[EVENT] = (out.hooks[EVENT] || []).concat([{ hooks: [{ type: "command", command, timeout: TIMEOUT_S }] }]);
  return out;
}

class CodexHookMethods {
  codexHooksPath() {
    const dir = this.codexDirOverride || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    return path.join(dir, "hooks.json");
  }

  codexHookOffFlag() {
    return path.join(this.dataDir(), OFF_FLAG);
  }

  /** {state: "off" | "ours" | "broken", present}: present = Atlas's entry is in the file (maybe inert). */
  codexHookState() {
    let data;
    try {
      data = JSON.parse(fsSync.readFileSync(this.codexHooksPath(), "utf8"));
    } catch (error) {
      return { state: error.code === "ENOENT" ? "off" : "broken" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)
        || (data.hooks !== undefined && (typeof data.hooks !== "object" || Array.isArray(data.hooks)))) {
      return { state: "broken" };
    }
    const groups = data && data.hooks && Array.isArray(data.hooks[EVENT]) ? data.hooks[EVENT] : [];
    const present = groups.some((g) => handlers(g).some((h) => isOurCodexHook(h && h.command)));
    return { state: present && !fsSync.existsSync(this.codexHookOffFlag()) ? "ours" : "off", present };
  }

  /** Adds or removes Atlas's hook. An unreadable file is left alone: {ok, reason}. */
  async setCodexHook(on) {
    const { state, present } = this.codexHookState();
    if (state === "broken") return { ok: false, reason: "broken" };
    const flag = this.codexHookOffFlag();
    if (on && present) {                        // the entry is still there: it works again, nothing moves
      fsSync.rmSync(flag, { force: true });
      return { ok: true };
    }
    if (!on && !present) return { ok: true };
    const file = this.codexHooksPath();
    const existed = fsSync.existsSync(file);
    let data = {};
    if (existed) data = JSON.parse(fsSync.readFileSync(file, "utf8"));
    if (!on && !removableHook(data)) {          // a user's hook after ours would lose its trust
      fsSync.mkdirSync(path.dirname(flag), { recursive: true });
      fsSync.writeFileSync(flag, "Atlas's Codex hook is off; its entry stays in hooks.json so no hook moves\n");
      return { ok: true, inert: true };
    }
    fsSync.rmSync(flag, { force: true });
    if (on) {
      const python = await this.findPython();
      if (!python) return { ok: false, reason: "python" };
      const payload = this.embeddedPayload();
      const runtime = payload ? this.extractRuntime(payload) : this.runtimeDir();
      data = withOurHook(data, codexHookCommand(python.path, runtime, this.dataDir()));
    } else {
      data = withoutOurHook(data);
    }
    const copied = fsSync.existsSync(file + BACKUP_SUFFIX);
    // No copy means the file did not exist before our first edit: left empty, it was only ever ours.
    const empty = !on && Object.keys(data).length === 1 && data.hooks && !Object.keys(data.hooks).length;
    if (empty && !copied) {
      fsSync.unlinkSync(file);
      return { ok: true };
    }
    if (existed && !copied) fsSync.copyFileSync(file, file + BACKUP_SUFFIX);   // the first edit keeps a copy
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fsSync.renameSync(tmp, file);
    return { ok: true };
  }
}

export { CodexHookMethods, OFF_FLAG, isOurCodexHook, codexHookCommand, removableHook, withOurHook, withoutOurHook };

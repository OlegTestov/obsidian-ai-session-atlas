// Opening a local path clicked in an agent tab, as `open` in a shell does: a note of this vault opens
// in Obsidian, another file in its default app, a folder in Finder. A file no app takes is shown
// selected in its Finder folder. Mixed into the plugin class.
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TFile } from "obsidian";
import { agentPidUnder } from "./startup";

const OPEN = "/usr/bin/open";
const CWD_TTL_MS = 5000;
// `open` would run these, not show them: apps, scripts, installers, links to elsewhere. Shown in Finder.
const LAUNCHES = new Set([".app", ".command", ".tool", ".terminal", ".workflow", ".action", ".pkg", ".mpkg",
  ".jar", ".webloc", ".fileloc", ".inetloc", ".prefpane", ".saver", ".qlgenerator", ".shortcut"]);

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(file, args, { timeout: 10000, encoding: "utf8", maxBuffer: 64 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** `~/x`, `/x` or a path relative to `cwd`, as an absolute path; null when it does not exist. */
function resolvePath(raw, cwd, home = os.homedir(), exists = (p) => fs.existsSync(p)) {
  if (!raw || raw === "~" || raw === "/" || raw === "." || raw === "..") return null;
  let full;
  if (raw.startsWith("~/")) full = path.join(home, raw.slice(2));
  else if (raw.startsWith("/")) full = raw;
  else if (cwd) full = path.resolve(cwd, raw);
  else return null;
  full = path.normalize(full).replace(/(.)\/+$/, "$1");     // `docs/` is the folder docs
  return exists(full) ? full : null;
}

/** True when `open` would run the path rather than show it: a launchable kind, or an executable file. */
function launches(full, stat = fs.statSync) {
  if (LAUNCHES.has(path.extname(full).toLowerCase())) return true;
  try {
    const st = stat(full);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return true;                                // unknown: the safe side
  }
}

/** A file of this vault that Obsidian shows itself (a note, a canvas, a PDF…), or null. */
function vaultFile(app, full) {
  const adapter = app && app.vault && app.vault.adapter;
  const base = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  if (!base) return null;
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  // The vault keys names in NFC; a path from `ls` may come decomposed (NFD «й»), the disk takes both.
  const key = rel.split(path.sep).join("/");
  const file = app.vault.getAbstractFileByPath(key.normalize("NFC")) || app.vault.getAbstractFileByPath(key);
  if (!(file instanceof TFile)) return null;
  const views = app.viewRegistry;
  return views && typeof views.isExtensionRegistered === "function" && views.isExtensionRegistered(file.extension)
    ? file : null;
}

/** The working folder of the agent running under a tab's process, from `ps` and `lsof`; null if none. */
async function agentCwd(rootPid, exec = execFileText) {
  const pid = agentPidUnder(await exec("/bin/ps", ["-A", "-o", "pid=,ppid=,command="]), rootPid);
  if (!pid) return null;
  const out = await exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = out.split("\n").find((l) => l.startsWith("n/"));
  return line ? line.slice(1) : null;
}

class OpenPathMethods {
  /** Opens a path; `reveal` shows it selected in Finder instead. */
  async openLocalPath(full, { reveal = false } = {}, exec = execFileText, stat = fs.statSync) {
    const file = !reveal && vaultFile(this.app, full);
    if (file) return this.openExplorerFile(file, true);
    if (reveal || launches(full, stat)) return exec(OPEN, ["-R", full]);
    try {
      await exec(OPEN, [full]);
    } catch {
      await exec(OPEN, ["-R", full]);           // no app for this kind of file
    }
    return undefined;
  }

  /** The folder relative paths in a tab are read from: its agent's, else the tab's own. Cached briefly. */
  async tabCwd(view, exec = execFileText) {
    const now = Date.now();
    const cache = view.cwdCache;
    if (cache && now - cache.at < CWD_TTL_MS) return cache.dir;
    // One lookup at a time: rows hovered meanwhile wait for it instead of starting their own.
    const lookup = (async () => {
      let dir = null;
      try {
        if (view.pty && !view.pty.exited) dir = await agentCwd(view.pty.pid, exec);
      } catch { /* ps or lsof failed: the tab's folder */ }
      return dir || (view.state && view.state.cwd) || os.homedir();
    })();
    view.cwdCache = { at: now, dir: lookup };
    return lookup;
  }
}

export { OpenPathMethods, resolvePath, vaultFile, agentCwd, launches };

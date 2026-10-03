// The catalog server lives inside the plugin. The Obsidian community directory installs only
// main.js, so the server (Python), the page and the tab scripts are embedded in the build and
// extracted into the data folder on start. The server is a child process on the system python3
// from Xcode Command Line Tools. Mixed into the plugin class.
import * as childProcess from "child_process";
import * as fsSync from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import EMBEDDED_PAYLOAD from "./payload";

const DATA_DIR = path.join(os.homedir(), "Library/Application Support/session-atlas");
const DEV_DATA_DIR = path.join(os.homedir(), "Library/Application Support/session-atlas-dev");
const RUNTIME_SUBDIR = "runtime";         // no version in the name: hooks of live sessions point here
const MANAGED_DIRS = ["atlas", "web", "scripts"];
const MIN_PYTHON = [3, 8];    // 3.8 is the python3 of Command Line Tools 13 (macOS 12)
const SERVER_WAIT_MS = 20000;
const SHELL_TIMEOUT_MS = 8000;
// Probe: the version and what the index cannot do without, FTS5 and the trigram tokenizer in SQLite.
const PYTHON_PROBE = [
  "import sys, sqlite3",
  "db = sqlite3.connect(':memory:')",
  "db.execute(\"CREATE VIRTUAL TABLE t USING fts5(a, tokenize='trigram')\")",
  "print('%d.%d' % sys.version_info[:2])",
].join("\n");
// /usr/bin/python3 is a stub until Command Line Tools are installed: running it opens the installer.
const PYTHON_CANDIDATES = ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, Object.assign({ timeout: SHELL_TIMEOUT_MS, encoding: "utf8" }, options),
      (error, stdout, stderr) => resolve({ ok: !error, code: error ? error.code : 0, stdout: stdout || "",
                                           stderr: stderr || "" }));
  });
}

/** "3.9" → [3, 9]; compared with the minimum. */
function versionOk(text) {
  const m = /^(\d+)\.(\d+)/.exec(String(text || "").trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

/** Login shell output: an interactive profile may print anything, so only lines after the marker count. */
function parseShellProbe(stdout) {
  const out = {};
  const marker = String(stdout || "").split("\n__ATLAS__").slice(1).join("\n");
  for (const line of marker.split("\n")) {
    const m = /^(PATH|claude|codex)=(.*)$/.exec(line.trim());
    if (m && m[2] && !out[m[1]]) out[m[1]] = m[2];
  }
  return out;
}

class RuntimeMethods {
  dataDir() { return this.dataDirOverride || (this.isDevInstall() ? DEV_DATA_DIR : DATA_DIR); }
  runtimeDir() { return path.join(this.dataDir(), RUNTIME_SUBDIR); }

  embeddedPayload() {
    if (this.payload === undefined) this.payload = EMBEDDED_PAYLOAD;
    return this.payload;
  }

  /** Extracts the embedded files when the version differs and removes leftovers of other versions. */
  extractRuntime(payload) {
    const dir = this.runtimeDir();
    const marker = path.join(dir, ".version");
    try {
      if (fsSync.readFileSync(marker, "utf8") === payload.version) return dir;
    } catch { /* first extraction */ }
    const keep = new Set(Object.keys(payload.files));
    for (const sub of MANAGED_DIRS) {
      const root = path.join(dir, sub);
      if (!fsSync.existsSync(root)) continue;
      for (const rel of walk(root)) {
        if (!keep.has(path.join(sub, rel))) fsSync.rmSync(path.join(root, rel), { force: true });
      }
    }
    for (const [rel, text] of Object.entries(payload.files)) {
      const full = path.join(dir, rel);
      fsSync.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      // Write aside, then rename: a page or a hook reading the file never sees half of it.
      const tmp = `${full}.tmp-${process.pid}`;
      fsSync.writeFileSync(tmp, text, { encoding: "utf8", mode: rel.endsWith(".zsh") ? 0o755 : 0o644 });
      fsSync.renameSync(tmp, full);
    }
    fsSync.writeFileSync(marker, payload.version);
    return dir;
  }

  /** PATH and the claude/codex paths from the login shell: Obsidian launched from the Dock sees only the system PATH. */
  async shellProbe() {
    if (this.shellInfo) return this.shellInfo;
    const shell = process.env.SHELL && /\/(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const script = 'printf "\\n__ATLAS__\\nPATH=%s\\nclaude=%s\\ncodex=%s\\n" "$PATH" '
      + '"$(command -v claude 2>/dev/null)" "$(command -v codex 2>/dev/null)"';
    const r = await run(shell, ["-l", "-i", "-c", script], { env: Object.assign({}, process.env, { TERM: "dumb" }) });
    this.shellInfo = parseShellProbe(r.stdout);
    return this.shellInfo;
  }

  async macosVersion() {
    const r = await run("/usr/bin/sw_vers", ["-productVersion"]);
    return r.ok ? r.stdout.trim() : null;
  }

  /** A request to our own server with the same CSRF token the page gets. {status, data}. */
  atlasRequest(method, pathname, body = null, timeout = 5000) {
    let token = "";
    try { token = fsSync.readFileSync(path.join(this.dataDir(), "csrf.token"), "utf8").trim(); } catch { /* no token yet */ }
    const origin = `http://127.0.0.1:${this.atlasPort()}`;
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve) => {
      const request = http.request({ host: "127.0.0.1", port: this.atlasPort(), path: pathname, method, timeout,
        headers: Object.assign({ Origin: origin, "X-Atlas-Token": token, "X-Atlas-Lang": this.lang() },
                               payload ? { "Content-Type": "application/json" } : {}) }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => {
          let data = null;
          try { data = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: response.statusCode, data });
        });
      });
      request.on("timeout", () => { request.destroy(); resolve({ status: 0, data: null }); });
      request.on("error", () => resolve({ status: 0, data: null }));
      if (payload) request.write(payload);
      request.end();
    });
  }

  async commandLineToolsInstalled() {
    return (await run("/usr/bin/xcode-select", ["-p"])).ok;
  }

  /** The first usable python3: ≥ 3.8, SQLite with FTS5 and trigram. null when none fits;
   *  this.pythonRejected then lists the candidates and why each was rejected. */
  async findPython() {
    const clt = await this.commandLineToolsInstalled();
    const configured = this.settings && this.settings.pythonPath;
    const candidates = [configured, ...PYTHON_CANDIDATES].filter(Boolean)
      .filter((p) => p !== "/usr/bin/python3" || clt);
    this.pythonRejected = [];
    for (const candidate of candidates) {
      if (!fsSync.existsSync(candidate)) continue;
      const r = await run(candidate, ["-c", PYTHON_PROBE]);
      if (r.ok && versionOk(r.stdout)) return { path: candidate, version: r.stdout.trim() };
      const why = r.ok ? `python ${r.stdout.trim()}` : (r.stderr.trim().split("\n").pop() || "error");
      this.pythonRejected.push(`${candidate}: ${why}`);
    }
    return null;
  }

  configPath() { return path.join(this.dataDir(), "config.json"); }

  readServerConfig() {
    try {
      return JSON.parse(fsSync.readFileSync(this.configPath(), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * The server's config.json. Without a file, creates one with this vault's folder and Obsidian's
   * language. With one, changes only what changes by itself (the claude path) and what is passed
   * explicitly (from the settings).
   */
  writeServerConfig(changes = {}) {
    const current = this.readServerConfig();
    const next = current ? Object.assign({}, current) : {
      language: this.lang(),
      vaults: this.getVaultPath() ? [{ path: this.getVaultPath(), id: this.app.vault.getName() }] : [],
    };
    Object.assign(next, changes);
    if (this.shellInfo && this.shellInfo.claude) next.claude_bin = this.shellInfo.claude;
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    fsSync.mkdirSync(this.dataDir(), { recursive: true, mode: 0o700 });
    const tmp = this.configPath() + ".tmp";
    fsSync.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    fsSync.renameSync(tmp, this.configPath());   // the server never reads a half-written file
    return next;
  }

  /**
   * Starts the server. One already running is reused (e.g. started by hand); a foreign program on
   * the port is reported as such; otherwise ours is extracted and started. {ok, reason}.
   */
  async startServer() {
    const health = await this.healthInfo();
    const payload = this.embeddedPayload();
    if (health && health.app === "session-atlas") {
      // A server from another build (left by an earlier plugin version) is stopped and replaced by ours.
      const stale = payload && health.version && health.version !== payload.version;
      if (!stale) return { ok: true, reason: null };
      await this.atlasRequest("POST", "/api/shutdown", {});
      for (let waited = 0; waited < 5000 && await this.healthInfo(500); waited += 250) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (await this.healthInfo(500)) return { ok: false, reason: this.t("server.portBusy") };
    } else if (health) {
      return { ok: false, reason: this.t("server.portBusy") };
    }
    if (!payload) return { ok: false, reason: this.t("server.noPayload") };
    const python = await this.findPython();
    if (!python) {
      this.setupProblem = "python";
      return { ok: false, reason: this.t("server.noPython") };
    }
    const dir = this.extractRuntime(payload);
    const shell = await this.shellProbe();
    this.writeServerConfig();
    const log = fsSync.openSync(path.join(this.dataDir(), "server.log"), "a");
    const env = Object.assign({}, process.env, { PYTHONPATH: dir, PYTHONDONTWRITEBYTECODE: "1",
                                                 ATLAS_HOME: this.dataDir() }, this.serverEnvExtra || {});
    if (shell.PATH) env.PATH = shell.PATH;
    this.serverProcess = childProcess.spawn(python.path, ["-m", "atlas.cli", "serve", "--port", String(this.atlasPort())],
                                            { cwd: dir, env, stdio: ["ignore", log, log] });
    this.serverProcess.on("exit", () => { this.serverProcess = null; });
    fsSync.closeSync(log);
    for (let waited = 0; waited < SERVER_WAIT_MS; waited += 250) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const h = await this.healthInfo(1000);
      if (h && h.app === "session-atlas") return { ok: true, reason: null };
      if (!this.serverProcess) break;               // crashed on start: the reason is in server.log
    }
    return { ok: false, reason: this.t("server.failedLog", { log: path.join(this.dataDir(), "server.log") }) };
  }

  stopServer() {
    if (this.serverProcess) {
      this.serverProcess.kill("SIGTERM");
      this.serverProcess = null;
    }
  }
}

function walk(root, prefix = "") {
  const out = [];
  for (const entry of fsSync.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

export { RuntimeMethods, versionOk, parseShellProbe, PYTHON_PROBE, DATA_DIR, DEV_DATA_DIR };

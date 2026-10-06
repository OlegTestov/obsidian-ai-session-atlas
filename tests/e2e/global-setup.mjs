// Global setup: a fixture corpus in a temp dir, two live agent processes and the server on a free port.
// Every agent folder the server reads is redirected into the temp dir, HOME included, so a run
// never sees (or deletes from) the real ~/.claude and ~/.codex.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IDS, writeCorpus } from "./corpus.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.E2E_PYTHON || "python3";
const RESERVED = new Set([8787, 8788]);      // the real catalog and the dev install

/**
 * Where the temp corpus goes. atlas/resolve.py folds /tmp into /private/tmp, as on macOS (the only
 * supported system); on Linux /tmp is a real folder, so the corpus must live elsewhere there.
 */
function tempBase() {
  const tmp = fs.realpathSync(os.tmpdir());
  if (process.platform === "darwin" || !(tmp === "/tmp" || tmp.startsWith("/tmp/"))) return tmp;
  const base = process.env.RUNNER_TEMP || path.join(os.homedir(), ".cache");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
    if (!RESERVED.has(port)) return port;
  }
}

/**
 * A stand-in agent process: `bash` (the "terminal tab") runs a `sleep` whose argv[0] is the agent
 * name, so `ps` lists it as `codex 3600` / `claude 3600`. Codex's one also holds its rollout open
 * read-only, which is how the server maps a live `codex` to its thread (lsof).
 */
function startAgent(name, holdOpen) {
  const script = holdOpen ? `(exec -a ${name} sleep 3600 < "$1") & echo $!; wait`
    : `(exec -a ${name} sleep 3600) & echo $!; wait`;
  const shell = spawn("/bin/bash", ["-c", script, "agent", holdOpen || ""],
                      { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    shell.stdout.on("data", d => {
      out += d;
      const m = out.match(/^(\d+)\n/);
      if (m) resolve({ shell: shell.pid, pid: Number(m[1]) });
    });
    shell.on("error", reject);
    shell.on("exit", code => reject(new Error(`${name} stand-in exited early (${code})`)));
  });
}

/** `ps` start time in UTC, the same text Claude Code writes as procStart. */
function procStart(pid) {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)],
                      { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).toString().trim();
}

/**
 * A stand-in `codex` for the usage read: speaks the app server's JSON-RPC on stdio like codex 0.160.0
 * and answers `account/rateLimits/read` with a spent 5-hour window. Each method asked is logged, so a
 * spec can check that nothing but the usage read happens. The real codex is never run.
 */
function writeCodexStandIn(root) {
  const bin = path.join(root, "codex-standin");
  const log = path.join(root, "codex-standin.log");
  const resets = Math.round(Date.now() / 1000);
  const result = { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300,
    resetsAt: resets + 2 * 3600 }, secondary: { usedPercent: 68, windowDurationMins: 10080, resetsAt: resets + 6 * 86400 } },
    rateLimitsByLimitId: { codex: null } };
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("fs");
let buf = "";
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(log)}, req.method + "\\n");
    if (req.method === "initialize") out({ id: req.id, result: { userAgent: "standin" } });
    else if (req.method === "account/rateLimits/read") out({ id: req.id, result: ${JSON.stringify(result)} });
  }
});
`, { mode: 0o755 });
  return { bin, log };
}

async function waitFor(fn, what, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? ": " + last.message : ""}`);
}

export default async function globalSetup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempBase(), "atlas-e2e-")));
  let corpus;
  try {
    corpus = writeCorpus(root, PYTHON);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
  const codexStandIn = writeCodexStandIn(root);
  const env = {
    ...process.env,
    ATLAS_CODEX_BIN: codexStandIn.bin,
    HOME: corpus.home,
    ATLAS_HOME: corpus.atlasHome,
    ATLAS_PROJECTS_ROOT: corpus.projects,
    ATLAS_CLAUDE_SESSIONS: path.join(corpus.claudeDir, "sessions"),
    CLAUDE_CONFIG_DIR: corpus.claudeDir,
    ATLAS_CODEX_HOME: corpus.codexHome,
    CODEX_HOME: corpus.codexHome,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: REPO,
  };
  const cleanup = [];
  const teardown = async () => {
    for (const fn of cleanup.reverse()) {
      try { await fn(); } catch { /* already gone */ }
    }
    if (!process.env.E2E_KEEP) fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    // Live sessions: a Claude Code process with its sessions/<pid>.json, a Codex one holding its rollout.
    const claudeProc = await startAgent("claude");
    cleanup.push(() => process.kill(-claudeProc.shell, "SIGKILL"));
    const codexProc = await startAgent("codex", corpus.files.codexLive);
    cleanup.push(() => process.kill(-codexProc.shell, "SIGKILL"));
    fs.writeFileSync(path.join(corpus.claudeDir, "sessions", `${claudeProc.pid}.json`), JSON.stringify({
      pid: claudeProc.pid, sessionId: IDS.claudeLive, cwd: corpus.cwds.demo,
      startedAt: Date.now() - 30 * 60e3, procStart: procStart(claudeProc.pid),
      kind: "interactive", entrypoint: "cli", status: "idle", name: "login retry" }));

    // Index synchronously first: the specs start on a complete catalog.
    execFileSync(PYTHON, ["-m", "atlas.cli", "index"], { cwd: REPO, env, stdio: ["ignore", "ignore", "inherit"] });

    const port = await freePort();
    const log = fs.openSync(path.join(root, "server.log"), "a");
    const server = spawn(PYTHON, ["-m", "atlas.cli", "serve", "--port", String(port)],
                         { cwd: REPO, env, stdio: ["ignore", log, log], detached: true });
    cleanup.push(() => process.kill(-server.pid, "SIGTERM"));
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(base + "/health")).ok, "the server");

    // Isolation: the catalog holds exactly the fixture sessions, nothing from the real home.
    const status = await (await fetch(base + "/api/index-status")).json();
    if (status.sessions !== corpus.sessionCount) {
      throw new Error(`expected ${corpus.sessionCount} fixture sessions, the server sees ${status.sessions}`);
    }
    // Both live sessions are found by process before any spec runs.
    await waitFor(async () => {
      const live = await (await fetch(base + "/api/active")).json();
      const ids = live.sessions.map(s => s.session_id);
      return ids.includes(IDS.claudeLive) && ids.includes(IDS.codexLive) && live.count === 2;
    }, "both live sessions in /api/active", 15000);

    // Codex's own usage read runs in the background: warm it, so specs see the live numbers.
    await waitFor(async () => {
      const live = await (await fetch(base + "/api/active?codex_usage=1")).json();
      return live.codex_limits && live.codex_limits.source === "live";
    }, "Codex limits read from the stand-in app server", 15000);

    const state = { base, port, root, corpus, ids: IDS, pids: { claude: claudeProc, codex: codexProc },
                    codexStandInLog: codexStandIn.log };
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
    process.env.E2E_STATE = path.join(root, "state.json");
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}

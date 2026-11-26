import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { setTimeout as delay } from "node:timers/promises";
import { validId } from "./agent-registry";

const INSTANCE = /^[A-Za-z0-9_.-]{1,96}$/;

function openCodeChildEnv(env = process.env) {
  const clean = { ...env };
  delete clean.OPENCODE_PASSWORD;
  delete clean.OPENCODE_SERVER_PASSWORD;
  return clean;
}

function read(file) {
  try {
    if (fs.statSync(file).size > 8192) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

function readOpenCodeTab(dataDir, instance, maxAge = 8000) {
  if (typeof instance !== "string" || !INSTANCE.test(instance)) return null;
  const base = path.join(dataDir, "opencode-tabs", instance);
  const launch = read(base + ".json");
  if (!launch || !/^[a-f0-9]{32}$/.test(launch.nonce || "")) return null;
  const route = read(`${base}.${launch.nonce}.route`);
  const matching = route && route.nonce === launch.nonce && route.pid === launch.pid;
  const session = id => validId("opencode", id) ? id : null;
  const age = matching && Number.isFinite(route.at) ? Date.now() - route.at : Infinity;
  const verified = age >= 0 && age <= maxAge && (route.route === "home"
    || (route.route === "session" && session(route.current)));
  return { current: verified ? session(route.current) : null, verified: Boolean(verified),
           last: session(matching ? route.last : null) || session(launch.last), cwd: launch.cwd,
           attempt: launch.attempt };
}

function openCodeLaunchEnded(dataDir, instance, pty) {
  if (pty?.exited) return true;
  if (!pty?.openCodeAttempt || !INSTANCE.test(instance || "")) return false;
  const file = path.join(dataDir, "opencode-tabs", instance + ".exited");
  try {
    return fs.statSync(file).size === 32 && fs.readFileSync(file, "utf8") === pty.openCodeAttempt;
  } catch { return false; }
}

async function waitForOpenCodeSession(dataDir, leaf, instance, sid, workspace) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (typeof workspace?.iterateAllLeaves === "function") {
      let attached = false;
      workspace.iterateAllLeaves(candidate => { if (candidate === leaf) attached = true; });
      if (!attached) return false;
    }
    const pty = leaf.view?.pty;
    if (openCodeLaunchEnded(dataDir, instance, pty)) return false;
    const record = pty && readOpenCodeTab(dataDir, instance);
    if (record?.current === sid && (!pty.openCodeAttempt || record.attempt === pty.openCodeAttempt)) return true;
    await delay(120);
  }
  return false;
}

function openCodePromptReady(lines) {
  if (lines.some(line => /what['’]s new/i.test(line))) return false;
  const row = lines.findIndex(line => /^\s*┃\s+Ask anything(?:…|\.\.\.)(?:\s|$)/.test(line));
  if (row < 0) return false;
  const edge = lines.findIndex((line, i) => i > row && /^\s*╹▀/.test(line));
  return edge > row && lines.slice(row + 1, edge).every(line => /^\s*┃/.test(line))
    && lines.slice(row + 1, edge).some(line => /^\s*┃\s+\S.+\S/.test(line));
}

function sendOpenCodeFirstPrompt(view, pty, previouslyResumed) {
  const { instance, firstPrompt } = view.state;
  if (previouslyResumed || !firstPrompt || typeof instance !== "string" || !INSTANCE.test(instance)) return;
  const marker = path.join(view.plugin.dataDir(), "opencode-tabs", instance + ".sent");
  const prompt = Array.from(firstPrompt, c => c === "\n" || c === "\t" || (c >= " " && c !== "\x7f")
    ? c : "").join("").trim();
  if (!prompt || fs.existsSync(marker)) return;
  const wait = window.setInterval(() => {
    if (view.pty !== pty || pty.exited) { window.clearInterval(wait); return; }
    if (!openCodePromptReady(view.plugin.screenLines(view.leaf))) return;
    window.clearInterval(wait);
    try {
      fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
    } catch { return; }
    const paste = prompt.includes("\n") ? `\x1b[200~${prompt}\x1b[201~` : prompt;
    pty.write(paste);
    window.setTimeout(() => { if (view.pty === pty && !pty.exited) pty.write("\r"); }, 150);
  }, 180);
  view.register(() => window.clearInterval(wait));
}

function watchOpenCodeLayout(plugin) {
  const workspace = plugin.app.workspace;
  if (typeof workspace.iterateAllLeaves !== "function") return;
  const dir = path.join(plugin.dataDir(), "opencode-tabs");
  const file = path.join(dir, `layout-${process.pid}.json`);
  let start = "";
  try { start = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="],
    { encoding: "utf8", timeout: 1000, env: { ...openCodeChildEnv(), LC_ALL: "C", TZ: "UTC" } }).trim(); }
  catch { /* PID still guards the record */ }
  let previous;
  const save = () => {
    const tabs = [];
    workspace.iterateAllLeaves(leaf => {
      const state = leaf.getViewState?.();
      if (state?.state?.kind === "opencode" && INSTANCE.test(state.state.instance || "")) {
        const { instance } = state.state;
        const pty = leaf.view?.pty;
        const starting = leaf.view?.openCodeLaunching;
        const attempt = starting || (!pty?.exited && pty?.openCodeAttempt);
        if (attempt) {
          const startedAt = starting ? leaf.view.openCodeLaunchAt : pty.openCodeLaunchAt;
          tabs.push({ instance, attempt, launching: true, startedAt, ptyPid: starting ? null : pty.pid });
        }
      }
    });
    const next = JSON.stringify({ pid: process.pid, start, tabs });
    if (next === previous) return;
    try {
      if (tabs.length) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file + ".tmp", next, { mode: 0o600 });
        fs.renameSync(file + ".tmp", file);
      } else fs.rmSync(file, { force: true });
      previous = next;
    } catch { /* a started OpenCode process has its own reservation */ }
  };
  plugin.saveOpenCodeLayout = save;
  save();
  plugin.registerEvent(workspace.on("layout-change", save));
  plugin.register(() => {
    delete plugin.saveOpenCodeLayout;
    try { fs.rmSync(file, { force: true }); } catch { /* the host is quitting */ }
  });
}

export { openCodeChildEnv, openCodeLaunchEnded, openCodePromptReady, readOpenCodeTab,
  sendOpenCodeFirstPrompt, waitForOpenCodeSession, watchOpenCodeLayout };

// A tab whose Claude Code session runs in a background job (obsidian-plugin/src/bg-session.js): the
// job is found under the tab's process, the tab gets a mark, and its close can stop the job.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadSrc } from "./helpers/load-src.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bg-"));
process.env.HOME = TMP;                 // SESSIONS_DIR is ~/.claude/sessions, read at load time
const SESSIONS = path.join(TMP, ".claude", "sessions");
fs.mkdirSync(SESSIONS, { recursive: true });
const realLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === "obsidian" ? { Notice: class {}, Modal: class {}, View: class {}, addIcon: () => {} } : realLoad(request, parent, isMain);
globalThis.window = globalThis.window || { setInterval: () => 0, setTimeout };
const bg = loadSrc("bg-session");
const { tabJob, BackgroundTabMethods } = bg;

const JOB = "ab12cd34";
const OTHER = "ffee0011";
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// A tab (pid 100) running the tab script (101) and under it the agent (102); the job's own process
// (900) runs under Claude Code's service, not under the tab. Start times as `TZ=UTC ps -o lstart=`.
const T = "Thu Nov  5 14:56:35 2026";
const ps = (agent, extra = "") => [
  `  100     1 ${T}     /bin/sh -c atlas-pty`,
  `  101   100 ${T}     /bin/zsh -l -i -c exec agent-resume-terminal.zsh`,
  `  102   101 Thu Nov  5 15:01:02 2026     ${agent}`,
  `  900     1 Thu Nov  5 09:00:00 2026     /Users/u/.local/share/claude/versions/2.1.318 --session-id 11111111-2222`,
  `  901     1 ${T}     /Users/u/.local/share/claude/versions/2.1.318 --session-id 66666666-2222`,
  extra,
].join("\n");
const jobFile = (job = JOB, more = {}) => Object.assign({ pid: 900, jobId: job, kind: "bg",
  procStart: "Thu Nov  5 09:00:00 2026", sessionId: "11111111-2222-3333-4444-555555555555" }, more);

describe("tabJob: the background job a tab shows", () => {
  it("an attach client under the tab, of a running job", () => {
    assert.equal(tabJob(ps(`/Users/u/.local/bin/claude attach ${JOB}`), [jobFile()], 100), JOB);
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [jobFile()], 100), JOB);
  });
  it("found deeper in the tree, not only among the children", () => {
    const text = ps("/bin/zsh -i", `  103   102 ${T} claude attach ${JOB}`);
    assert.equal(tabJob(text, [jobFile()], 100), JOB);
  });
  it("a parked session: the tab's own Claude Code process names a running job", () => {
    const files = [jobFile(), { pid: 102, sessionId: "aaaaaaaa-2222-3333-4444-555555555555", parkedJobId: JOB }];
    assert.equal(tabJob(ps("claude --resume aaaaaaaa"), files, 100), JOB);
    files[1].procStart = "Thu Nov  5 15:01:02 2026";
    assert.equal(tabJob(ps("claude --resume aaaaaaaa"), files, 100), JOB);
  });
  // A file left by a killed process, its pid taken by another: the start time tells them apart.
  it("a reused pid: the job's file of another process start is not a running job", () => {
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [jobFile(JOB, { procStart: "Wed Nov  4 09:00:00 2026" })], 100), null);
  });
  it("a reused pid: a stale parked file under the tab names no job", () => {
    const files = [jobFile(), { pid: 102, parkedJobId: JOB, procStart: "Tue Nov  3 10:00:00 2026" }];
    assert.equal(tabJob(ps("/bin/zsh -i"), files, 100), null);
  });
  it("a file without a start time still counts (older Claude Code)", () => {
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [jobFile(JOB, { procStart: undefined })], 100), JOB);
  });
  it("nothing for an ordinary session", () => {
    const files = [jobFile(), { pid: 102, sessionId: "aaaaaaaa-2222-3333-4444-555555555555" }];
    assert.equal(tabJob(ps("claude --resume aaaaaaaa"), files, 100), null);
  });
  it("nothing when the job's process is gone (stopped), for both kinds", () => {
    const gone = jobFile(JOB, { pid: 777 });
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [gone], 100), null);
    const files = [gone, { pid: 102, parkedJobId: JOB }];
    assert.equal(tabJob(ps("claude"), files, 100), null);
    // Another job runs meanwhile: the stopped one still does not count.
    files.push(jobFile(OTHER, { pid: 901, procStart: undefined }));
    assert.equal(tabJob(ps("claude"), files, 100), null);
    assert.equal(tabJob(ps(`claude attach ${JOB}`), files, 100), null);
  });
  it("nothing without the job's file, or with a spare one", () => {
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [], 100), null);
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [jobFile(JOB, { spare: true })], 100), null);
  });
  it("another job's file does not count for this attach client", () => {
    assert.equal(tabJob(ps(`claude attach ${JOB}`), [jobFile(OTHER, { pid: 901 })], 100), null);
  });
  it("an attach client in another tab is not this tab's", () => {
    const text = ps("claude --resume x", `  300     1 ${T} /bin/sh -c atlas-pty\n  301   300 ${T} claude attach ${JOB}`);
    assert.equal(tabJob(text, [jobFile()], 100), null);
    assert.equal(tabJob(text, [jobFile()], 300), JOB);
  });
  it("only an attach command line: text that mentions it is not one", () => {
    for (const cmd of [`grep claude attach ${JOB}`, `claude attach ${JOB} --verbose`, `claude attach ${JOB.toUpperCase()}`,
                       `xclaude attach ${JOB}`, `claude attach ${JOB}0`]) {
      assert.equal(tabJob(ps(cmd), [jobFile(), jobFile(JOB.toUpperCase())], 100), null, cmd);
    }
  });
  it("a job id must be eight hex digits; a broken file is skipped", () => {
    const files = [null, { pid: 900, jobId: 12345678 }, { pid: "900", jobId: JOB }, { pid: 102, parkedJobId: "../x" }];
    assert.equal(tabJob(ps(`claude attach ${JOB}`), files, 100), null);
  });
});

describe("the plugin side", () => {
  const plugin = Object.create(BackgroundTabMethods.prototype);
  const shells = [];
  const live = [];
  after(() => { for (const p of [...live, ...shells]) try { p.kill("SIGKILL"); } catch { /* gone */ } });

  // A real process tree: zsh (the tab's root) → a script named claude, run as `claude attach <job>`.
  const bin = path.join(TMP, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  async function attachTree(job) {
    const shell = childProcess.spawn("/bin/zsh", ["-f", "-c", `'${bin}/claude' attach ${job}; true`], { stdio: "ignore" });
    shells.push(shell);
    for (let i = 0; i < 50; i++) {
      const out = childProcess.execFileSync("/bin/ps", ["-A", "-o", "ppid=,command="], { encoding: "utf8" });
      if (out.split("\n").some((l) => l.trim() === `${shell.pid} /bin/sh ${bin}/claude attach ${job}`)) return shell.pid;
      await delay(50);
    }
    throw new Error("the attach stand-in did not start");
  }
  const jobProcess = () => {
    const p = childProcess.spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    live.push(p);
    return p.pid;
  };
  const view = (pid, kind = "claude", exited = false) => ({
    state: { kind }, pty: { pid, exited }, marks: [],
    setBackgroundJob(job) { this.marks.push(job); },
  });

  it("backgroundJobOf: a real tree and a running job's file → the job, and the tab is marked", async () => {
    const root = await attachTree(JOB);
    fs.writeFileSync(path.join(SESSIONS, "1.json"), JSON.stringify(jobFile(JOB, { pid: jobProcess(), procStart: undefined })));
    const v = view(root);
    assert.equal(plugin.backgroundJobOf({ view: v }), JOB);
    assert.deepEqual(v.marks, [JOB]);
  });
  it("backgroundJobOf: the job file's start time in UTC matches; another start time does not", async () => {
    const root = await attachTree(JOB);
    const pid = jobProcess();
    const utc = childProcess.execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)],
                                          { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim();
    for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f));
    fs.writeFileSync(path.join(SESSIONS, "4.json"), JSON.stringify(jobFile(JOB, { pid, procStart: utc })));
    assert.equal(plugin.backgroundJobOf({ view: view(root) }), JOB);
    fs.writeFileSync(path.join(SESSIONS, "4.json"), JSON.stringify(jobFile(JOB, { pid, procStart: utc.replace(/\d{4}$/, "1999") })));
    assert.equal(plugin.backgroundJobOf({ view: view(root) }), null);
    fs.writeFileSync(path.join(SESSIONS, "4.json"), JSON.stringify(jobFile(JOB, { pid, procStart: utc })));
  });
  it("backgroundJobsOf: one answer per tab, in order", async () => {
    const root = await attachTree(JOB);
    const quiet = jobProcess();
    assert.deepEqual(plugin.backgroundJobsOf([{ view: view(root) }, { view: view(quiet) }, null,
                                              { view: view(root, "codex") }]), [JOB, null, null, null]);
  });
  it("no process listing: the tab's last mark stands", () => {
    const real = childProcess.execFileSync;
    const v = Object.assign(view(1), { backgroundJob: JOB });
    try {
      childProcess.execFileSync = () => { throw new Error("ps timed out"); };
      assert.equal(plugin.backgroundJobOf({ view: v }), JOB);
      v.backgroundJob = null;
      assert.equal(plugin.backgroundJobOf({ view: v }), null);
    } finally {
      childProcess.execFileSync = real;
    }
  });
  it("backgroundJobOf: no job for Codex, an exited tab or no tab view", async () => {
    const root = await attachTree(JOB);
    assert.equal(plugin.backgroundJobOf({ view: view(root, "codex") }), null);
    assert.equal(plugin.backgroundJobOf({ view: view(root, "claude", true) }), null);
    assert.equal(plugin.backgroundJobOf({ view: null }), null);
    assert.equal(plugin.backgroundJobOf(null), null);
  });
  it("backgroundJobOf: the job ended → no job, and the mark goes", async () => {
    const root = await attachTree(OTHER);
    const p = childProcess.spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    fs.writeFileSync(path.join(SESSIONS, "2.json"), JSON.stringify(jobFile(OTHER, { pid: p.pid, procStart: undefined })));
    const v = view(root);
    assert.equal(plugin.backgroundJobOf({ view: v }), OTHER);
    p.kill("SIGKILL");
    await new Promise((resolve) => p.on("exit", resolve));
    assert.equal(plugin.backgroundJobOf({ view: v }), null);
    assert.deepEqual(v.marks, [OTHER, null]);
  });
  it("refreshBackgroundMarks: Claude Code tabs are marked, an exited one unmarked, Codex left alone", async () => {
    const root = await attachTree(JOB);
    fs.writeFileSync(path.join(SESSIONS, "3.json"), JSON.stringify(jobFile(JOB, { pid: jobProcess(), procStart: undefined })));
    const marked = view(root);
    const codex = view(root, "codex");
    const exited = view(root, "claude", true);
    const plain = view(jobProcess());        // a process with nothing under it
    plugin.app = { workspace: { getLeavesOfType: () => [marked, codex, exited, plain].map((v) => ({ view: v })) } };
    await plugin.refreshBackgroundMarks();
    assert.deepEqual(marked.marks, [JOB]);
    assert.deepEqual(plain.marks, [null]);
    assert.deepEqual(codex.marks, []);
    assert.deepEqual(exited.marks, [null]);
  });

  it("refreshBackgroundMarks: no process listing → the marks stay as they were", async () => {
    const real = childProcess.execFile;
    const v = Object.assign(view(1), { backgroundJob: JOB });
    plugin.app = { workspace: { getLeavesOfType: () => [{ view: v }] } };
    try {
      childProcess.execFile = (file, args, opts, cb) => cb(new Error("ps timed out"), "", "");
      await plugin.refreshBackgroundMarks();
    } finally {
      childProcess.execFile = real;
    }
    assert.deepEqual(v.marks, []);
  });

  // `claude stop <job>` through the claude the login shell finds.
  const fakeClaude = (body) => {
    const file = path.join(TMP, `claude-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  it("stopBackgroundJob: runs `claude stop <job>` and reports success", async () => {
    const log = path.join(TMP, "stop.log");
    plugin.shellProbe = async () => ({ claude: fakeClaude(`echo "$@" > '${log}'; echo stopped $2`), PATH: "/usr/bin:/bin" });
    assert.deepEqual(await plugin.stopBackgroundJob(JOB), { ok: true });
    assert.equal(fs.readFileSync(log, "utf8").trim(), `stop ${JOB}`);
  });
  it("stopBackgroundJob: a failure carries the program's last line", async () => {
    plugin.shellProbe = async () => ({ claude: fakeClaude('echo "first" >&2; echo "no such session" >&2; exit 1') });
    assert.deepEqual(await plugin.stopBackgroundJob(JOB), { ok: false, error: "no such session" });
  });
  it("stopBackgroundJob: the login shell probe failed → a failure, not a throw", async () => {
    plugin.shellProbe = async () => { throw new Error("no shell"); };
    assert.deepEqual(await plugin.stopBackgroundJob(JOB), { ok: false, error: "no shell" });
  });
  it("stopBackgroundJob: a bad job id never reaches the program", async () => {
    let probed = false;
    plugin.shellProbe = async () => { probed = true; return {}; };
    for (const bad of ["", null, "AB12CD34", `${JOB} x`, "--help", "../ab12cd3"]) {
      assert.equal((await plugin.stopBackgroundJob(bad)).ok, false, String(bad));
    }
    assert.equal(probed, false);
  });
});

describe("return a background conversation to an ordinary tab", () => {
  function setup(extra = {}) {
    const calls = [];
    const data = { jobId: JOB, sessionId: "11111111-2222-3333-4444-555555555555", cwd: "/tmp/project", status: "idle" };
    const old = { id: "old", view: { pty: {} }, detach() { calls.push("detach"); } };
    const parent = { children: [old] }; old.parent = parent;
    const next = { parent };
    const p = Object.assign(Object.create(BackgroundTabMethods.prototype), {
      t: k => k, resumeIdentityOf: d => (/^[0-9a-f-]{36}$/.test(d.sessionId) ? d.sessionId : null),
      runningJob: async () => data, claudeTabLeaves: () => [old], tabsShowingJob: async () => [old],
      groups: { members: { old: "group1" } },
      app: { workspace: { setActiveLeaf: () => calls.push("focus"), getMostRecentLeaf: () => next } },
      stopJob: async () => { calls.push("stop"); return true; },
      openAgent: async (kind, opts) => { calls.push([kind, opts]); return true; },
      moveLeafTo: (leaf, i) => calls.push(["move", leaf === next, i]),
    }, extra);
    return { p, calls, data, old };
  }
  it("stops first, resumes the same conversation, retains group and position, then closes the old viewer", async () => {
    const { p, calls, data } = setup();
    assert.equal(await p.bringBackJob(JOB), true);
    assert.equal(calls[0], "stop");
    assert.deepEqual(calls[2], ["claude", { cwd: data.cwd, seed: { agent: "claude", cwd: data.cwd,
      mode: "resume", sessionId: data.sessionId, prompt: "" }, label: "background.session", group: "group1" }]);
    assert.deepEqual(calls.slice(3), [["move", true, 0], "detach"]);
    assert.equal(p.busyJobs.size, 0);
  });
  it("prefers history materialized during shutdown over the parent chosen before stopping", async () => {
    let stopped = false;
    const parent = "aaaaaaaa-1111-2222-3333-444444444444";
    const { p, calls, data } = setup({
      stopJob: async () => { stopped = true; return true; },
      resumeIdentityOf: d => stopped ? d.sessionId : parent,
    });
    assert.equal(await p.bringBackJob(JOB), true);
    assert.equal(calls.find(c => Array.isArray(c) && c[0] === "claude")[1].seed.sessionId, data.sessionId);
  });
  it("no history to resume: the job keeps running, nothing opens", async () => {
    const { p, calls } = setup({ resumeIdentityOf: () => null });
    assert.equal(await p.bringBackJob(JOB), false);
    assert.deepEqual(calls, []);
  });
  it("history unreadable after the stop: the conversation found before is opened, not lost", async () => {
    let stopped = false;
    const parent = "aaaaaaaa-1111-2222-3333-444444444444";
    const { p, calls } = setup({
      stopJob: async () => { stopped = true; return true; },
      resumeIdentityOf: () => (stopped ? null : parent),
    });
    assert.equal(await p.bringBackJob(JOB), true);
    assert.equal(calls.find(c => Array.isArray(c) && c[0] === "claude")[1].seed.sessionId, parent);
  });
  it("a job no tab shows opens in a new tab and closes nothing", async () => {
    const { p, calls } = setup({ tabsShowingJob: async () => [] });
    assert.equal(await p.bringBackJob(JOB), true);
    assert.ok(!calls.includes("detach") && !calls.includes("focus"));
    assert.equal(calls.find(c => Array.isArray(c) && c[0] === "claude")[1].group, undefined);
  });
  it("a viewer repurposed during shutdown is never detached", async () => {
    const { p, calls, old } = setup();
    p.stopJob = async () => { old.view = { state: { kind: "claude" }, pty: {} }; return true; };
    assert.equal(await p.bringBackJob(JOB), true);
    assert.ok(!calls.includes("detach"));
  });
  it("a failed stop leaves the viewer and starts no second process", async () => {
    const { p, calls } = setup({ stopJob: async () => false });
    assert.equal(await p.bringBackJob(JOB), false);
    assert.deepEqual(calls, []);
  });
  it("a failed open retains the old tab for recovery", async () => {
    const { p, calls } = setup({ openAgent: async () => false });
    assert.equal(await p.bringBackJob(JOB), false);
    assert.ok(!calls.includes("detach"));
  });
  it("a second click while confirming cannot start a second transfer or stop", async () => {
    let answer;
    const { p, calls } = setup({ confirmInterrupt: () => new Promise(resolve => { answer = resolve; }) });
    const first = p.bringBackJob(JOB);
    const bounded = promise => Promise.race([promise, delay(100).then(() => "duplicate action waited")]);
    assert.equal(await bounded(p.bringBackJob(JOB)), false);
    assert.equal(await bounded(p.stopJobFromPage(JOB)), false);
    answer(false);
    assert.equal(await first, false);
    assert.deepEqual(calls, []);
  });
  it("invalid session identity and invalid job ids never reach stop", async () => {
    const { p, data, calls } = setup();
    data.sessionId = "--help";
    assert.equal(await p.bringBackJob(JOB), false);
    assert.equal(await p.bringBackJob("--help"), false);
    assert.deepEqual(calls, []);
  });
  it("a process check failure is not interpreted as a stopped job", async () => {
    const { p, calls } = setup({ runningJob: async () => { throw new Error("ps failed"); } });
    assert.equal(await p.bringBackJob(JOB), false);
    assert.equal(await p.stopJobFromPage(JOB), false);
    assert.deepEqual(calls, []);
    assert.equal(p.busyJobs.size, 0);
  });
  it("Stop waits for termination and never resumes a conversation", async () => {
    const { p, calls } = setup();
    assert.equal(await p.stopJobFromPage(JOB), true);
    assert.deepEqual(calls, ["stop"]);
  });
  it("a failed process probe throws instead of declaring a job absent, and never blocks", async () => {
    const realSync = childProcess.execFileSync;
    const real = childProcess.execFile;
    const p = Object.assign(Object.create(BackgroundTabMethods.prototype), { t: k => k });
    childProcess.execFileSync = () => { throw new Error("a synchronous ps blocks Obsidian"); };
    try {
      childProcess.execFile = (file, args, opts, cb) => cb(new Error("ps unavailable"), "", "");
      await assert.rejects(p.runningJob(JOB), /checkFailed/);
      childProcess.execFile = (file, args, opts, cb) => cb(null, ps("claude"));
      assert.equal(await p.runningJob(OTHER), null);
    } finally { childProcess.execFileSync = realSync; childProcess.execFile = real; }
  });
});

it("termination waits on the captured process identity even without its session JSON", async () => {
  const p = Object.assign(Object.create(BackgroundTabMethods.prototype), { t: k => k });
  const real = childProcess.execFile;
  try {
    childProcess.execFile = (file, args, opts, cb) => cb(null, ps("claude"));
    const identity = jobFile();
    assert.equal(await p.waitJobGone(identity, 0), false);
    assert.equal(await p.waitJobGone({ ...identity, procStart: T }, 0), true);
    assert.equal(await p.waitJobGone(null, 0), true);
    childProcess.execFile = (file, args, opts, cb) => cb(new Error("failed"), "");
    await assert.rejects(p.waitJobGone(identity, 0), /checkFailed/);
    // One failed listing while the job ends is not the end of the wait.
    let calls = 0;
    childProcess.execFile = (file, args, opts, cb) => (++calls === 1 ? cb(new Error("busy"), "")
      : cb(null, ps("claude").replace(/^\s*900 .*$/m, "")));
    assert.equal(await p.waitJobGone(identity, 2000), true);
    assert.equal(calls, 2);
  } finally { childProcess.execFile = real; }
});

it("a newly parked job without a transcript resumes its parent's history, never an empty conversation", () => {
  const { resumeIdentity } = loadSrc("bg-transcript");
  const root = path.join(TMP, "transcripts");
  const cwd = "/tmp/recorder";
  const dir = path.join(root, "-tmp-recorder");
  fs.mkdirSync(dir, { recursive: true });
  const parent = "aaaaaaaa-1111-2222-3333-444444444444";
  const data = { sessionId: "bbbbbbbb-1111-2222-3333-444444444444", cwd };
  assert.equal(resumeIdentity(data, root), null);
  fs.writeFileSync(path.join(dir, parent + ".jsonl"), JSON.stringify({ type: "continued-in",
    continuedInSessionId: data.sessionId }) + "\n");
  assert.equal(resumeIdentity(data, root), parent);
  // Another transcript of the folder, newer and unrelated, does not hide the parent.
  fs.writeFileSync(path.join(dir, "cccccccc-1111-2222-3333-444444444444.jsonl"), '{"type":"user"}\n');
  assert.equal(resumeIdentity(data, root), parent);
  assert.equal(resumeIdentity({ ...data, cwd: "/tmp/elsewhere" }, root), null);
  fs.writeFileSync(path.join(dir, data.sessionId + ".jsonl"), '{"type":"user"}\n');
  assert.equal(resumeIdentity(data, root), data.sessionId);
  assert.equal(resumeIdentity({ ...data, sessionId: "../../bad" }, root), null);
});

it("refresh ignores a leaf whose view was replaced while ps ran", async () => {
  const real = childProcess.execFile;
  const marks = [];
  const leaf = { view: { state: { kind: "claude" }, pty: { pid: 100 }, setBackgroundJob: j => marks.push(j) } };
  const p = Object.assign(Object.create(BackgroundTabMethods.prototype), {
    app: { workspace: { getLeavesOfType: () => [leaf] } },
  });
  try {
    childProcess.execFile = (file, args, opts, cb) => { leaf.view = { pty: {} }; cb(null, ps("claude")); };
    await p.refreshBackgroundMarks();
    assert.deepEqual(marks, []);
  } finally { childProcess.execFile = real; }
});

it("tabs showing a job: found from one listing that does not block, other tabs left alone", async () => {
  const real = childProcess.execFile;
  const realSync = childProcess.execFileSync;
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f));
  fs.writeFileSync(path.join(SESSIONS, "9.json"), JSON.stringify(jobFile()));
  const tab = (pid) => ({ view: { state: { kind: "claude" }, pty: { pid } } });
  const shown = tab(100);
  const other = tab(300);
  const p = Object.assign(Object.create(BackgroundTabMethods.prototype), { t: k => k,
    app: { workspace: { getLeavesOfType: () => [shown, other] } } });
  try {
    childProcess.execFileSync = () => { throw new Error("a synchronous ps blocks Obsidian"); };
    childProcess.execFile = (file, args, opts, cb) => cb(null, ps(`claude attach ${JOB}`, `  300     1 ${T} /bin/sh -c atlas-pty`));
    assert.deepEqual(await p.tabsShowingJob(JOB), [shown]);
    assert.deepEqual(await p.tabsShowingJob(OTHER), []);
    // A tab closed or reused while the listing ran is skipped, not read.
    childProcess.execFile = (file, args, opts, cb) => { shown.view = { pty: undefined }; cb(null, ps(`claude attach ${JOB}`)); };
    assert.deepEqual(await p.tabsShowingJob(JOB), []);
    shown.view = { state: { kind: "claude" }, pty: { pid: 100 } };
    childProcess.execFile = (file, args, opts, cb) => cb(new Error("ps failed"), "", "");
    await assert.rejects(p.tabsShowingJob(JOB), /checkFailed/);
  } finally {
    childProcess.execFile = real;
    childProcess.execFileSync = realSync;
    fs.rmSync(path.join(SESSIONS, "9.json"));
  }
});

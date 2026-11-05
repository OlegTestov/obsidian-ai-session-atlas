// A Claude Code session can run in a background job of Claude Code's own service, apart from the tab:
// the tab shows it with `claude attach <job>`, or keeps an idle process whose work was parked in a job
// (the ← key on an empty prompt, /background). Closing such a tab leaves the job running, so the tab
// is marked and its close dialog offers to stop the job. Mixed into the plugin class.
import * as childProcess from "child_process";
import * as fsSync from "fs";
import * as path from "path";
import { Notice } from "obsidian";
import { AGENT_VIEW_TYPE, SESSIONS_DIR } from "./constants";
import { ConfirmCloseModal } from "./guard";
import { resumeIdentity } from "./bg-transcript";

const JOB_ID = /^[0-9a-f]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GONE_WAIT_MS = 15000;             // `claude stop` returns before the job's process has gone
const GONE_POLL_MS = 300;
const ATTACH = /(?:^|\/)claude attach ([0-9a-f]{8})$/;
const REFRESH_MS = 10000;               // as the activity poll; a close checks afresh anyway
const STOP_TIMEOUT_MS = 30000;
// Start times in UTC: Claude Code writes `procStart` in UTC, in the form `ps -o lstart=` prints.
const PS_ARGS = ["-A", "-o", "pid=,ppid=,lstart=,command="];
const PS_ENV = Object.assign({}, process.env, { TZ: "UTC", LC_ALL: "C" });
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/;

const oneSpaced = (text) => String(text).trim().split(/\s+/).join(" ");

/** Children, commands and start times by pid from `ps -A -o pid=,ppid=,lstart=,command=`. */
function processTree(psText) {
  const children = new Map();
  const commands = new Map();
  const starts = new Map();
  for (const line of String(psText).split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const parent = Number(m[2]);
    starts.set(pid, oneSpaced(m[3]));
    commands.set(pid, m[4].trim());
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  return { children, commands, starts };
}

/** The file's process still runs and is the one that wrote it: PIDs get reused. */
function fileAlive(data, tree) {
  if (!Number.isInteger(data.pid) || !tree.commands.has(data.pid)) return false;
  return !data.procStart || tree.starts.get(data.pid) === oneSpaced(data.procStart);
}

/** Running background jobs by id: a process file with a job id whose process still runs. */
function liveJobs(files, tree) {
  const jobs = new Map();
  for (const data of files) {
    const job = data && typeof data.jobId === "string" ? data.jobId : "";
    if (JOB_ID.test(job) && data.spare !== true && fileAlive(data, tree)) jobs.set(job, data);
  }
  return jobs;
}

/**
 * The background job a tab shows, or null: under the tab's process, an attach client of a running
 * job, or a Claude Code process whose own file says its work was parked in a running job.
 */
function tabJob(psText, files, root) {
  const tree = processTree(psText);
  const { children, commands } = tree;
  const jobs = liveJobs(files, tree);
  if (!jobs.size) return null;
  const byPid = new Map(files.filter((d) => d && fileAlive(d, tree)).map((d) => [d.pid, d]));
  const queue = [...(children.get(root) || [])];
  const seen = new Set(queue);
  while (queue.length) {
    const pid = queue.shift();
    const attach = ATTACH.exec(commands.get(pid) || "");
    if (attach && jobs.has(attach[1])) return attach[1];
    const parked = byPid.get(pid) && byPid.get(pid).parkedJobId;
    if (parked && jobs.has(String(parked))) return String(parked);
    for (const child of children.get(pid) || []) {
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return null;
}

/** Claude Code's process files (~/.claude/sessions/<pid>.json); unreadable ones are skipped. */
function readSessionFiles(dir = SESSIONS_DIR) {
  let names = [];
  try { names = fsSync.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const name of names) {
    try { out.push(JSON.parse(fsSync.readFileSync(path.join(dir, name), "utf8"))); } catch { /* being rewritten */ }
  }
  return out;
}

function listTree() {
  return new Promise((resolve) => {
    childProcess.execFile("/bin/ps", PS_ARGS, { env: PS_ENV, encoding: "utf8", timeout: 3000, maxBuffer: 64 << 20 },
                          (error, stdout) => resolve(error ? "" : stdout));
  });
}

class BackgroundTabMethods {
  /** Loaded Claude Code tabs with a process (an exited one too: its mark has to go). */
  claudeTabLeaves() {
    const out = [];
    const ws = this.app && this.app.workspace;
    if (!ws || typeof ws.getLeavesOfType !== "function") return out;
    for (const leaf of ws.getLeavesOfType(AGENT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view && view.state && view.state.kind === "claude" && view.pty) out.push(leaf);
    }
    return out;
  }

  startBackgroundMarks() {
    this.registerInterval(window.setInterval(() => this.refreshBackgroundMarks(), REFRESH_MS));
    this.refreshBackgroundMarks();
  }

  /** Marks the tabs that show a background job and unmarks the rest. */
  async refreshBackgroundMarks() {
    const leaves = this.claudeTabLeaves().filter((leaf) => typeof leaf.view.setBackgroundJob === "function");
    for (const leaf of leaves) if (leaf.view.pty.exited) leaf.view.setBackgroundJob(null);
    const running = leaves.filter((leaf) => !leaf.view.pty.exited)
      .map(leaf => ({ leaf, view: leaf.view, pty: leaf.view.pty }));
    if (!running.length) return;
    const text = await listTree();
    if (!text) return;                       // ps failed: the marks stay as they were
    const files = readSessionFiles();
    for (const { leaf, view, pty } of running) {
      if (leaf.view === view && view.pty === pty && !pty.exited) {
        view.setBackgroundJob(tabJob(text, files, pty.pid));
      }
    }
  }

  /** The job the tab shows right now (checked afresh: the mark may be a few seconds old), or null. */
  backgroundJobOf(leaf) {
    return this.backgroundJobsOf([leaf])[0];
  }

  /** The same for several tabs, with one process listing (closing a group). */
  backgroundJobsOf(leaves) {
    const views = leaves.map((leaf) => {
      const view = leaf && leaf.view;
      return view && view.state && view.state.kind === "claude" && view.pty && !view.pty.exited ? view : null;
    });
    if (!views.some(Boolean)) return views.map(() => null);
    let text = "";
    try {
      text = childProcess.execFileSync("/bin/ps", PS_ARGS, { env: PS_ENV, encoding: "utf8", timeout: 3000,
                                                             maxBuffer: 64 << 20 });
    } catch {
      text = "";
    }
    // No listing: the last mark stands, rather than a dialog saying the session ends with the tab.
    if (!text) return views.map((view) => (view && view.backgroundJob) || null);
    const files = readSessionFiles();
    return views.map((view) => {
      if (!view) return null;
      const job = tabJob(text, files, view.pty.pid);
      if (typeof view.setBackgroundJob === "function") view.setBackgroundJob(job);
      return job;
    });
  }

  /** A running job's process file, read afresh, or null (ended, or not a job). */
  runningJob(job) {
    if (!JOB_ID.test(job || "")) return null;
    let text = "";
    try {
      text = childProcess.execFileSync("/bin/ps", PS_ARGS, { env: PS_ENV, encoding: "utf8", timeout: 3000,
                                                             maxBuffer: 64 << 20 });
    } catch {
      throw new Error(this.t("background.checkFailed"));
    }
    const tree = processTree(text);
    const data = liveJobs(readSessionFiles(), tree).get(job);
    return data ? Object.assign({}, data, { procStart: tree.starts.get(data.pid) }) : null;
  }

  async waitJobGone(job, limitMs = GONE_WAIT_MS, identity = this.runningJob(job)) {
    if (!identity) return true;
    const end = Date.now() + limitMs;
    while (true) {
      const text = await listTree();
      if (!text) throw new Error(this.t("background.checkFailed"));
      if (!fileAlive(identity, processTree(text))) return true;
      if (Date.now() >= end) return false;
      await new Promise((resolve) => window.setTimeout(resolve, GONE_POLL_MS));
    }
  }

  /** A busy job's reply would be cut off: asked first. Resolves true to go on. */
  confirmInterrupt(data, action) {
    if (data.status !== "busy") return Promise.resolve(true);
    return new Promise((resolve) => {
      let answered = false;
      new ConfirmCloseModal(this.app, {
        title: this.t(`background.${action}.busyTitle`),
        text: this.t("background.busyText", { label: data.name || data.jobId }),
        keep: this.t("background.wait"),
        close: this.t(`background.${action}.now`),
        onConfirm: () => { answered = true; resolve(true); },
        onDismiss: () => { if (!answered) resolve(false); },
      }).open();
    });
  }

  /**
   * The job's conversation in an ordinary tab: the job stops (Claude Code has no way back to the
   * foreground), then `claude --resume` of its session opens where its tab stood, in its group.
   */
  backgroundResumeIdentity(data) {
    const id = resumeIdentity(data);
    if (!id) new Notice(this.t("background.historyMissing"));
    return id;
  }

  async bringBackJob(job) {
    return this.withBackgroundJob(job, async (data) => {
      let sessionId = this.backgroundResumeIdentity(data);
      if (!UUID.test(sessionId || "") || typeof data.cwd !== "string" || !data.cwd.startsWith("/")) return false;
      if (!(await this.confirmInterrupt(data, "bringBack"))) return false;
      const leaves = this.claudeTabLeaves().filter((leaf) => !leaf.view.pty.exited);
      const shown = this.backgroundJobsOf(leaves);
      const tabs = leaves.filter((leaf, i) => shown[i] === job);
      const identities = tabs.map(leaf => ({ leaf, view: leaf.view, pty: leaf.view.pty }));
      const stillSame = item => this.claudeTabLeaves().includes(item.leaf)
        && item.leaf.view === item.view && item.view.pty === item.pty;
      let old = tabs[0];
      const parent = old && old.parent;
      const index = parent && parent.children ? parent.children.indexOf(old) : -1;
      const group = old && this.groups ? this.groups.members[old.id] : null;
      if (!(await this.stopJob(job))) return false;
      sessionId = this.backgroundResumeIdentity(data);
      if (!UUID.test(sessionId || "")) return false;
      if (old && !stillSame(identities[0])) old = null;
      if (old) this.app.workspace.setActiveLeaf(old, { focus: false });
      const label = data.name || this.t("background.session");
      const seed = { agent: "claude", cwd: data.cwd, mode: "resume", sessionId, prompt: "" };
      const opened = await this.openAgent("claude", Object.assign({ cwd: data.cwd, seed, label }, group ? { group } : {}));
      if (opened) {
        const next = this.app.workspace.getMostRecentLeaf();
        if (next && next.parent === parent && index >= 0) this.moveLeafTo(next, index);
        for (const item of identities) if (stillSame(item)) item.leaf.detach();
      }
      return opened;
    });
  }

  /** Stop from the catalog's row: asked first only when it would cut a reply off. */
  async stopJobFromPage(job) {
    return this.withBackgroundJob(job, async (data) => {
      if (!(await this.confirmInterrupt(data, "stop"))) return false;
      const done = await this.stopJob(job);
      if (done) new Notice(this.t("background.stopped", { label: data.name || job }));
      return done;
    });
  }

  /** Lock before the confirmation opens: repeated clicks must not create competing transfers. */
  async withBackgroundJob(job, action) {
    if (!JOB_ID.test(job || "")) return false;
    if (!this.busyJobs) this.busyJobs = new Set();
    if (this.busyJobs.has(job)) return false;
    this.busyJobs.add(job);
    try {
      const data = this.runningJob(job);
      if (!data) { new Notice(this.t("background.gone")); return false; }
      return await action(data);
    } catch (error) {
      new Notice(String(error.message || error));
      return false;
    } finally {
      this.busyJobs.delete(job);
    }
  }

  /** `claude stop` and the wait for the job's process to go; a notice when it does not. */
  async stopJob(job) {
    const identity = this.runningJob(job);
    if (!identity) return true;
    const result = await this.stopBackgroundJob(job);
    if (!result.ok && !(await this.waitJobGone(job, 0, identity))) {
      new Notice(this.t("close.background.stopFailed", { job, error: result.error || "?" }));
      return false;
    }
    if (await this.waitJobGone(job, GONE_WAIT_MS, identity)) return true;
    new Notice(this.t("close.background.stopFailed", { job, error: this.t("background.stillRunning") }));
    return false;
  }

  /** A marked tab's menu: its session back into an ordinary tab, in the same place. */
  addBackgroundItems(menu, leaf) {
    const job = leaf && leaf.view && leaf.view.backgroundJob;
    if (!menu || !job) return;
    if (!this.backgroundMenus) this.backgroundMenus = new WeakSet();
    if (this.backgroundMenus.has(menu)) return;        // the tab's own menu and Obsidian's leaf-menu
    this.backgroundMenus.add(menu);
    menu.addItem((item) => item.setSection("action").setTitle(this.t("background.menu.bringBack"))
      .setIcon("log-in").onClick(() => this.bringBackJob(job)));
  }

  /** `claude stop <job>`: the job ends, its conversation is kept. {ok, error}. */
  async stopBackgroundJob(job) {
    if (!JOB_ID.test(job || "")) return { ok: false, error: "bad job id" };
    let info;
    try {
      info = (await this.shellProbe()) || {};
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
    const env = Object.assign({}, process.env, info.PATH ? { PATH: info.PATH } : {});
    return new Promise((resolve) => {
      childProcess.execFile(info.claude || "claude", ["stop", job], { env, encoding: "utf8", timeout: STOP_TIMEOUT_MS },
        (error, stdout, stderr) => resolve(error
          ? { ok: false, error: String(stderr || stdout || error.message).trim().split("\n").pop() }
          : { ok: true }));
    });
  }
}

export { BackgroundTabMethods, tabJob, liveJobs, processTree, readSessionFiles, REFRESH_MS, PS_ARGS };

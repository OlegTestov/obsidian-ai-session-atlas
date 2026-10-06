// A session running in a Claude Code background job: the catalog sends `claude attach <job>`, the tab
// opens through the tab script's attach start, and input from the Active view reaches the job through
// the tab's attach client (obsidian-plugin/src/attach.js). The tab script itself: tests/test_agent_script_sessions.py.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { SRC, loadSrc } from "./helpers/load-src.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-attach-"));
process.env.HOME = TMP;                 // the plugin's ~/.claude/sessions, read at load time
const realLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === "obsidian" ? { Notice: class {}, addIcon: () => {} } : realLoad(request, parent, isMain);
const agents = loadSrc("agents");
const attach = loadSrc("attach");
const { TerminalMethods } = loadSrc("terminal");

const JOB = "ee545d7a";
const SID = "ee545d7a-77da-4b02-9be9-27abe1715c48";
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("attach: the catalog command", () => {
  const P = agents.parseLaunch;
  it("parsed as the attach start, the job id in place of the session id", () => {
    assert.deepEqual(P(`cd '/Users/u/it'"'"'s work' && claude attach ${JOB}`),
                     { agent: "claude", cwd: "/Users/u/it's work", mode: "attach", sessionId: JOB, prompt: "" });
  });
  for (const bad of [`cd /x && claude attach ${SID}`, `cd /x && claude attach ${JOB.toUpperCase()}`,
                     `cd /x && claude attach ${JOB}0`, `cd /x && claude attach ${JOB.slice(1)}`,
                     `cd /x && claude attach ${JOB} --fork-session`, `cd /x && claude attach`,
                     `cd /x && claude attach ${JOB}; id`, `cd /x && claude attach '../${JOB}'`,
                     `cd /x && codex attach ${JOB}`, `cd /x && claude attach -h`]) {
    it(`rejects: ${bad}`, () => assert.equal(P(bad), null));
  }
  it("tab arguments carry the attach start to the tab script", () => {
    const args = agents.agentArgs("/s/a b.zsh", "claude", "claude-x-1", P(`cd /x && claude attach ${JOB}`));
    assert.deepEqual(agents.shellWords(args[3]), ["exec", "/s/a b.zsh", "claude", "claude-x-1", "attach", JOB]);
  });
  it("the tab script refuses an attach start that is not a job id", () => {
    const script = path.join(SRC, "..", "scripts", "agent-resume-terminal.zsh");
    for (const bad of [SID, "--help", "../x"]) {
      const r = childProcess.spawnSync("zsh", [script, "claude", "tab-1", "attach", bad], {
        cwd: TMP, timeout: 20000, encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: TMP, OBS_AGENT_TERMINAL_STATE_DIR: path.join(TMP, "state"),
               OBS_AGENT_TERMINAL_NO_SHELL: "1" } });
      assert.equal(r.status, 64, bad);
    }
  });
});

describe("attach: input from the Active view", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "sessions-"));
  const write = (pid, data) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify(data));
  // The job's process: this test process stands in, so it is alive.
  write(process.pid, { pid: process.pid, sessionId: SID, kind: "bg", jobId: JOB, status: "idle" });
  write(12345, { pid: process.pid, sessionId: "11111111-2222-4333-8444-555555555555", kind: "bg",
                 jobId: "11111111", spare: true, status: "idle" });

  it("the attach client's command names the job", () => {
    assert.equal(attach.attachedJobId(`claude attach ${JOB}`), JOB);
    assert.equal(attach.attachedJobId(`/Users/u/.local/bin/claude attach ${JOB}`), JOB);
    for (const other of [`claude --resume ${SID}`, `claude attach ${JOB} x`, `claude attach ${SID}`,
                         `notclaude attach ${JOB}`, "claude", ""]) {
      assert.equal(attach.attachedJobId(other), null, other);
    }
  });
  it("an attach client reads as the job's session, with the job's status", () => {
    const state = attach.attachedSessionState(4242, dir, () => `claude attach ${JOB}`);
    assert.equal(state.sessionId, SID);
    assert.equal(state.status, "idle");
  });
  it("not an attach client, a spare or a job that ended: no session", () => {
    assert.equal(attach.attachedSessionState(4242, dir, () => `claude --resume ${SID}`), null);
    assert.equal(attach.attachedSessionState(4242, dir, () => "claude attach 11111111"), null);
    write(999999, { pid: 999999, sessionId: SID, kind: "bg", jobId: "22222222", status: "idle" });
    assert.equal(attach.attachedSessionState(4242, dir, () => "claude attach 22222222"), null);
  });
});

describe("attach: the plugin's check before input", () => {
  it("a tab's attach client is the job's session; without the job it is nobody's", async () => {
    const sessions = path.join(TMP, ".claude", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    // An attach client as ps shows it: "claude attach <job>".
    const client = childProcess.spawn(process.execPath,
                                      ["-e", `process.title = "claude attach ${JOB}"; setTimeout(() => {}, 30000)`]);
    after(() => client.kill());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const self = { readSessionState: (pid) => TerminalMethods.prototype.readSessionState.call(self, pid),
                   processName: () => "claude" };
    const read = () => TerminalMethods.prototype.readAgentState.call(self, client.pid, null);
    assert.equal(read(), null);
    fs.writeFileSync(path.join(sessions, "4243.json"),
                     JSON.stringify({ pid: process.pid, sessionId: SID, kind: "bg", jobId: JOB, status: "busy" }));
    const state = read();
    assert.equal(state.agent, "claude");
    assert.deepEqual(state.sessionIds, [SID]);
    assert.equal(state.status, "busy");
  });
});

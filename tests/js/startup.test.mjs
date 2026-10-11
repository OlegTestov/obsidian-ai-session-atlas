// After Obsidian starts: processes an earlier Obsidian left behind are ended, and every restored agent
// tab is loaded one by one without taking the focus.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setGlobal } from "./helpers/globals.mjs";
import { loadSrc } from "./helpers/load-src.mjs";

setGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
const { StartupMethods, orphanTabProcesses, deferredAgentLeaves, agentUnder } = loadSrc("startup");
const childProcess = createRequire(import.meta.url)("child_process");

const SCRIPTS = "/Users/u/Library/Application Support/session-atlas/runtime/scripts";
const tab = (script, instance = "claude-1") => `/bin/zsh -l -i -c exec '${script}/agent-resume-terminal.zsh' claude ${instance}`;
const ROOT = (rest) => `/bin/sh -c { cat; kill -HUP 0; } | exec /usr/bin/script -q /dev/null "$@" atlas-pty /bin/sh -c stty x atlas-pty 73 257 ${rest}`;
const OLD_ROOT = (rest) => `/bin/sh -c cat | exec /usr/bin/script -q /dev/null "$@" atlas-pty /bin/sh -c stty x atlas-pty 73 257 ${rest}`;

describe("processes left by an Obsidian that is gone", () => {
  const ps = [
    `  100     1 ${OLD_ROOT(tab(SCRIPTS))}`,                       // a tree of an older version, orphaned
    `  110     1 ${ROOT(tab(SCRIPTS, "claude-2"))}`,                // this version's, orphaned
    `  120   900 ${ROOT(tab(SCRIPTS, "claude-3"))}`,                // a tab of a running Obsidian
    `  130     1 ${ROOT(tab("/tmp/other-install/runtime/scripts"))}`, // another install (a test Obsidian)
    `  140     1 /usr/bin/script -q /dev/null /bin/sh -c stty x atlas-pty 73 257 ${tab(SCRIPTS, "claude-4")}`,
    `  150     1 /bin/sh -c sleep 5`,                                // anything else of launchd's
    `  160     1 ${ROOT("/bin/zsh -f")}`,                            // a plain shell tab: not an agent's
  ].join("\n");

  it("are the tops of this install's agent trees that launchd holds", () => {
    assert.deepEqual(orphanTabProcesses(ps, SCRIPTS),
                     [{ pid: 100, group: true }, { pid: 110, group: true }, { pid: 140, group: false }]);
  });

  it("are ended as a closed tab: SIGHUP to the tree", () => {
    const killed = [];
    const realKill = process.kill;
    process.kill = (pid, sig) => { killed.push([pid, sig]); };
    try {
      const realExec = childProcess.execFileSync;
      childProcess.execFileSync = () => ps;
      try {
        const n = StartupMethods.prototype.endOrphanTabs.call({ runtimeDir: () => SCRIPTS.replace(/\/scripts$/, "") });
        assert.equal(n, 3);
      } finally {
        childProcess.execFileSync = realExec;
      }
    } finally {
      process.kill = realKill;
    }
    assert.deepEqual(killed, [[-100, "SIGHUP"], [-110, "SIGHUP"], [140, "SIGHUP"]]);
  });
});

function leaf(kind, instance, deferred = true) {
  const l = {
    isDeferred: deferred, loads: 0, focusAtLoad: null,
    getViewState: () => ({ type: "session-atlas-terminal", state: { kind, instance } }),
    async loadIfDeferred() { l.loads++; l.isDeferred = false; l.focusAtLoad = host.loadingInBackground; },
  };
  return l;
}
let host;

describe("restored agent tabs load without being shown", () => {
  it("every deferred agent tab, one at a time, marked as a background load", async () => {
    const a = leaf("claude", "claude-a");
    const b = leaf("codex", "codex-b");
    const shown = leaf("claude", "claude-c", false);           // already loaded (the tab in front)
    const shell = leaf("shell", null);                          // a plain command tab: not re-run unseen
    const other = { isDeferred: true, getViewState: () => ({ type: "markdown", state: {} }), loadIfDeferred() { throw new Error("no"); } };
    host = Object.assign(Object.create(StartupMethods.prototype), { settings: {}, app: { workspace: { iterateAllLeaves: (fn) => [a, other, shown, b, shell].forEach(fn) } } });
    const n = await StartupMethods.prototype.loadAgentTabs.call(host, 0);
    assert.equal(n, 2);
    assert.deepEqual([a.loads, b.loads, shown.loads, shell.loads], [1, 1, 0, 0]);
    assert.equal(a.focusAtLoad, true);                          // the view does not take the keyboard
    assert.equal(host.loadingInBackground, false);
  });

  it("the tab Obsidian loaded itself is waited for before the others", async () => {
    const order = [];
    const front = Object.assign(leaf("claude", "claude-front", false), { view: { pty: { pid: 7 } } });
    const a = leaf("claude", "claude-a");
    a.loadIfDeferred = async () => { order.push("load a"); a.isDeferred = false; };
    host = Object.assign(Object.create(StartupMethods.prototype), { settings: {},
      app: { workspace: { iterateAllLeaves: (fn) => [a, front].forEach(fn) } },
      waitForAgent: async (l) => { order.push(`wait ${l.getViewState().state.instance}`); return true; } });
    await StartupMethods.prototype.loadAgentTabs.call(host, 0);
    assert.deepEqual(order, ["wait claude-front", "load a", "wait claude-a"]);
  });

  it("a tab shown meanwhile is not loaded twice; the setting turns it off", async () => {
    const a = leaf("claude", "claude-a");
    const b = leaf("claude", "claude-b");
    a.loadIfDeferred = async () => { a.loads++; a.isDeferred = false; b.isDeferred = false; };
    host = Object.assign(Object.create(StartupMethods.prototype), { settings: {}, app: { workspace: { iterateAllLeaves: (fn) => [a, b].forEach(fn) } } });
    assert.equal(await StartupMethods.prototype.loadAgentTabs.call(host, 0), 1);
    const c = leaf("claude", "claude-c");
    host = Object.assign(Object.create(StartupMethods.prototype), { settings: { loadAgentTabs: false }, app: { workspace: { iterateAllLeaves: (fn) => [c].forEach(fn) } } });
    assert.equal(await StartupMethods.prototype.loadAgentTabs.call(host, 0), 0);
    assert.equal(c.loads, 0);
  });

  it("only agent tabs with an id count as restorable", () => {
    const ws = { iterateAllLeaves: (fn) => [leaf("claude", "x"), leaf("claude", ""), leaf("shell", "y")].forEach(fn) };
    assert.equal(deferredAgentLeaves(ws).length, 1);
  });
});

describe("the next tab waits for this one's agent", () => {
  const ps = ["  10     1 /bin/sh -c { cat; kill -HUP 0; } | exec /usr/bin/script atlas-pty",
              "  11    10 /usr/bin/script -q /dev/null atlas-pty",
              "  12    11 /bin/zsh /x/agent-resume-terminal.zsh claude claude-1",
              "  13    12 claude attach abcdef12",
              "  20     1 /bin/sh -c { cat; kill -HUP 0; } | exec /usr/bin/script atlas-pty",
              "  21    20 /bin/zsh -l -i -c exec '/x/agent-resume-terminal.zsh' claude claude-2",
              "  30     1 /Users/u/.local/bin/claude --resume x"].join("\n");

  it("an agent under the tab's process counts; a login shell still starting does not", () => {
    assert.equal(agentUnder(ps, 10), true);
    assert.equal(agentUnder(ps, 20), false);
    assert.equal(agentUnder(ps, 99), false);
  });

  it("loading goes on when the tab's agent runs, or when its process has ended", async () => {
    const realExec = childProcess.execFileSync;
    childProcess.execFileSync = () => ps;
    try {
      const host = Object.create(StartupMethods.prototype);
      assert.equal(await host.waitForAgent({ view: { pty: { pid: 10, exited: false } } }, 2000), true);
      assert.equal(await host.waitForAgent({ view: { pty: { pid: 20, exited: false } } }, 400), false);
      assert.equal(await host.waitForAgent({ view: { pty: { pid: 10, exited: true } } }, 2000), false);
      // The terminal appears a moment after the tab loads: waited for.
      const late = { view: {} };
      setTimeout(() => { late.view.pty = { pid: 10, exited: false }; }, 500);
      assert.equal(await host.waitForAgent(late, 3000), true);
    } finally {
      childProcess.execFileSync = realExec;
    }
  });
});

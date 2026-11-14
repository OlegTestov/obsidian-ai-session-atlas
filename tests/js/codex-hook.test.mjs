// The Codex "waiting for you" hook in $CODEX_HOME/hooks.json: added and removed only by the toggle, only
// Atlas's own entry, the user's hooks and keys intact, a copy of the file kept next to it.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSrc, ROOT } from "./helpers/load-src.mjs";

const H = loadSrc("codex-hook");
const { BACKUP_SUFFIX } = loadSrc("statusline");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-codex-hook-"));
// A space and an apostrophe in the path: the command must survive both in sh.
const dataDir = path.join(tmp, "Application Support", "it's session-atlas");
const runtime = path.join(dataDir, "runtime");
fs.mkdirSync(path.join(runtime, "atlas"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "atlas", "codex_hook.py"), path.join(runtime, "atlas", "codex_hook.py"));
const codexDir = path.join(tmp, "codex");
const file = path.join(codexDir, "hooks.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makePlugin() {
  const p = { codexDirOverride: codexDir, runtimeDir: () => runtime, dataDir: () => dataDir,
              embeddedPayload: () => null, findPython: async () => ({ path: "/usr/bin/python3", version: "3.9" }) };
  for (const name of Object.getOwnPropertyNames(H.CodexHookMethods.prototype)) {
    if (name !== "constructor") p[name] = H.CodexHookMethods.prototype[name].bind(p);
  }
  return p;
}
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const p = makePlugin();
const USER = { hooks: { PermissionRequest: [{ matcher: "exec", hooks: [{ type: "command", command: "/usr/local/bin/notify" }] }],
                        Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
               note: "the user's own key" };
const SID = "019e0000-aaaa-7000-8000-00000000000a";

describe("Codex hook in hooks.json", () => {
  it("no file: off; turning on creates it with only our entry, turning off removes the file", async () => {
    assert.equal(p.codexHookState().state, "off");
    assert.ok((await p.setCodexHook(true)).ok);
    assert.equal(p.codexHookState().state, "ours");
    const groups = read().hooks.PermissionRequest;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks[0].type, "command");
    assert.ok(!fs.existsSync(file + BACKUP_SUFFIX), "no file before: nothing to copy");
    assert.ok((await p.setCodexHook(false)).ok);
    assert.ok(!fs.existsSync(file), "a file that only ever held our hook goes away");
  });

  it("the user's hooks file: ours goes last, everything else intact, a copy alongside", async () => {
    fs.writeFileSync(file, JSON.stringify(USER));
    assert.ok((await p.setCodexHook(true)).ok);
    const data = read();
    assert.equal(data.note, USER.note);
    assert.deepEqual(data.hooks.Stop, USER.hooks.Stop);
    assert.deepEqual(data.hooks.PermissionRequest[0], USER.hooks.PermissionRequest[0]);
    assert.equal(data.hooks.PermissionRequest.length, 2);
    assert.ok(H.isOurCodexHook(data.hooks.PermissionRequest[1].hooks[0].command));
    assert.deepEqual(JSON.parse(fs.readFileSync(file + BACKUP_SUFFIX, "utf8")), USER);
    assert.ok((await p.setCodexHook(true)).ok, "turning on twice keeps one entry");
    assert.equal(read().hooks.PermissionRequest.length, 2);
  });

  it("the command runs through sh and writes the wait mark into the data folder", () => {
    const command = read().hooks.PermissionRequest[1].hooks[0].command;
    const out = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: SID, tool_name: "exec_command",
                              cwd: "/tmp", model: "m", permission_mode: "default", tool_input: {},
                              transcript_path: null, turn_id: "t" }) });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "", "no output: Codex shows its usual prompt");
    const mark = JSON.parse(fs.readFileSync(path.join(dataDir, "codex-waits", SID + ".json"), "utf8"));
    assert.equal(mark.session_id, SID);
    assert.match(mark.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("turning off removes only our entry", async () => {
    assert.ok((await p.setCodexHook(false)).ok);
    assert.deepEqual(read(), USER);
    assert.equal(p.codexHookState().state, "off");
  });

  it("a mixed group keeps the user's handler", () => {
    const ours = H.codexHookCommand("/usr/bin/python3", runtime, dataDir);
    const mixed = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "x" }, { type: "command", command: ours }] }] } };
    assert.deepEqual(H.withoutOurHook(mixed), { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "x" }] }] } });
  });

  it("another tool's codex_hook.py is not ours", async () => {
    const foreign = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "python3 /opt/other/codex_hook.py" }] }] } };
    fs.writeFileSync(file, JSON.stringify(foreign));
    assert.equal(p.codexHookState().state, "off");
    assert.ok((await p.setCodexHook(true)).ok);
    assert.ok((await p.setCodexHook(false)).ok);
    assert.deepEqual(read(), foreign);
  });

  it("a user's hook added after ours keeps its position: off makes ours inert, on reuses it", async () => {
    // Codex trusts a hook by its position (<file>:permission_request:<i>:0): removing ours would move
    // the user's later hook from 2 to 1 and drop its trust.
    fs.writeFileSync(file, JSON.stringify(USER));
    assert.ok((await p.setCodexHook(true)).ok);
    const later = { hooks: [{ type: "command", command: "/usr/local/bin/log-approvals" }] };
    const withLater = read();
    withLater.hooks.PermissionRequest.push(later);
    fs.writeFileSync(file, JSON.stringify(withLater));
    const flag = path.join(dataDir, H.OFF_FLAG);
    assert.deepEqual(await p.setCodexHook(false), { ok: true, inert: true });
    assert.deepEqual(read(), withLater, "nothing moved");
    assert.equal(p.codexHookState().state, "off");
    assert.ok(fs.existsSync(flag));
    const command = withLater.hooks.PermissionRequest[1].hooks[0].command;
    const sid = "019e0000-bbbb-7000-8000-00000000000b";
    const out = childProcess.spawnSync("/bin/sh", ["-c", command], { encoding: "utf8",
      input: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: sid }) });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!fs.existsSync(path.join(dataDir, "codex-waits", sid + ".json")), "an inert hook marks nothing");
    assert.ok((await p.setCodexHook(true)).ok);
    assert.deepEqual(read(), withLater, "on again: the same entry, not a new one at the end");
    assert.equal(p.codexHookState().state, "ours");
    assert.ok(!fs.existsSync(flag));
    // Once the user's later hook is gone, ours is last again and leaves the file for real.
    const back = read();
    back.hooks.PermissionRequest.pop();
    fs.writeFileSync(file, JSON.stringify(back));
    assert.ok((await p.setCodexHook(false)).ok);
    assert.deepEqual(read(), USER);
    assert.ok(!fs.existsSync(flag));
  });

  it("removable only while Atlas's own group is the last one", () => {
    const ours = { hooks: [{ type: "command", command: H.codexHookCommand("/usr/bin/python3", runtime, dataDir) }] };
    const user = { hooks: [{ type: "command", command: "x" }] };
    const of = (...groups) => ({ hooks: { PermissionRequest: groups } });
    assert.equal(H.removableHook(of(user, ours)), true);
    assert.equal(H.removableHook(of(ours, user)), false);
    assert.equal(H.removableHook(of({ hooks: [user.hooks[0], ours.hooks[0]] })), false, "shared with the user's");
  });

  it("an unreadable or odd file is left alone", async () => {
    for (const text of ["{not json", "[1, 2]", '{"hooks": []}']) {
      fs.writeFileSync(file, text);
      assert.equal(p.codexHookState().state, "broken");
      assert.deepEqual(await p.setCodexHook(true), { ok: false, reason: "broken" });
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
  });
});

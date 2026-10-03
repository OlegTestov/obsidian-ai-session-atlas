// Status line in ~/.claude/settings.json: ours is added and removed, a foreign one is left alone.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadSrc, ROOT } from "./helpers/load-src.mjs";

const S = loadSrc("statusline");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-statusline-"));
// A space in the path, as in "Application Support": the command must survive it.
const runtime = path.join(tmp, "Application Support", "session-atlas", "runtime");
fs.mkdirSync(path.join(runtime, "atlas"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "atlas", "statusline.py"), path.join(runtime, "atlas", "statusline.py"));
const claudeDir = path.join(tmp, "claude");
const file = path.join(claudeDir, "settings.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makePlugin() {
  const p = { claudeDirOverride: claudeDir, runtimeDir: () => runtime, embeddedPayload: () => null,
              findPython: async () => ({ path: "/usr/bin/python3", version: "3.9" }) };
  for (const name of Object.getOwnPropertyNames(S.StatusLineMethods.prototype)) {
    if (name !== "constructor") p[name] = S.StatusLineMethods.prototype[name].bind(p);
  }
  return p;
}
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const p = makePlugin();
let cfg = null;

describe("status line in Claude Code settings", () => {
  it("no file: off", () => {
    assert.equal(p.statusLineState().state, "off");
  });

  it("turning on: our line, other keys intact", async () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [] } }));
    const r = await p.setStatusLine(true);
    cfg = read();
    assert.ok(r.ok);
    assert.equal(p.statusLineState().state, "ours");
    assert.equal(cfg.model, "opus");
    assert.ok(cfg.hooks);
    assert.equal(cfg.statusLine.type, "command");
  });

  it("keeps a copy of the original file alongside", () => {
    const backup = JSON.parse(fs.readFileSync(file + S.BACKUP_SUFFIX, "utf8"));
    assert.equal(backup.model, "opus");
    assert.ok(!("statusLine" in backup));
  });

  it("the command runs through sh and survives a space in the path", () => {
    const home = path.join(tmp, "atlas-home");
    const out = childProcess.spawnSync("/bin/sh", ["-c", cfg.statusLine.command], {
      input: JSON.stringify({ model: { display_name: "Opus" },
                              rate_limits: { seven_day: { used_percentage: 12, resets_at: 1790548575 } } }),
      env: Object.assign({}, process.env, { ATLAS_HOME: home }), encoding: "utf8" });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.ok(out.stdout.startsWith("Opus · week 12%"), out.stdout);
    assert.ok(fs.existsSync(path.join(home, "rate-limits.json")));
  });

  it("turning off: no line, the rest intact", async () => {
    const r = await p.setStatusLine(false);
    assert.ok(r.ok);
    assert.ok(!("statusLine" in read()));
    assert.equal(read().model, "opus");
  });

  it("a foreign line is left alone", async () => {
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: "~/bin/my-line.sh" } }));
    const r = await p.setStatusLine(true);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "foreign");
    assert.equal(read().statusLine.command, "~/bin/my-line.sh");
  });

  it("turning off does not remove a foreign line either", async () => {
    const r = await p.setStatusLine(false);
    assert.equal(r.ok, false);
    assert.equal(read().statusLine.command, "~/bin/my-line.sh");
  });

  it("a broken file is left alone", async () => {
    fs.writeFileSync(file, "{ not json");
    const r = await p.setStatusLine(true);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "broken");
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  });

  it("a line run from the repository is ours too", () => {
    assert.ok(S.isOurStatusLine("python3.11 ~/Code/session-atlas/tools/statusline.py"));
    assert.ok(!S.isOurStatusLine("python3 ~/statusline.py"));
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { loadSrc } from "./helpers/load-src.mjs";

const { RuntimeMethods, orphanIndexers } = loadSrc("runtime");

test("cleanup selects only orphaned Atlas indexers holding this data folder's lock", () => {
  const rows = [
    "101 1 /usr/bin/python3 -m atlas.cli index",
    "102 50 /usr/bin/python3 -m atlas.cli index",
    "103 1 /usr/bin/python3 -m atlas.cli serve --port 8787",
    "104 1 claude --resume abc",
    "105 1 /usr/bin/python3 -m atlas.cli index",
    "106 1 /usr/bin/python3 -m atlas.cli index-other",
    "bad input",
  ].join("\n");
  assert.deepEqual(orphanIndexers(rows, new Set([101, 102, 103, 104, 106])), [101]);
});

test("an upgrade reaps a legacy orphan indexer before opening the database", async () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-legacy-indexer-"));
  const module = path.join(root, "atlas");
  fs.mkdirSync(module);
  fs.writeFileSync(path.join(module, "__init__.py"), "");
  const ready = path.join(root, "ready");
  const lock = path.join(root, "index.lock");
  fs.writeFileSync(path.join(module, "cli.py"), [
    "import fcntl,time",
    `f=open(${JSON.stringify(lock)},'w')`,
    "fcntl.flock(f,fcntl.LOCK_EX)",
    `open(${JSON.stringify(ready)},'w').write('ready')`,
    "time.sleep(60)",
  ].join("\n"));
  // The short-lived launcher reproduces the older server's missing child cleanup.
  const launcher = `const p=require('child_process').spawn('/usr/bin/python3',['-m','atlas.cli','index'],` +
    `{env:{...process.env,PYTHONPATH:${JSON.stringify(root)}},cwd:${JSON.stringify(root)},` +
    `detached:true,stdio:'ignore'});console.log(p.pid);p.unref();`;
  const pid = Number(childProcess.execFileSync(process.execPath, ["-e", launcher], { encoding: "utf8" }).trim());
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await delay(20);
    assert.ok(fs.existsSync(ready));
    assert.equal(Number(childProcess.execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="],
                                                 { encoding: "utf8" }).trim()), 1);
    const runtime = new RuntimeMethods();
    runtime.dataDirOverride = root;
    await runtime.reapOrphanIndexers();
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await delay(20); } catch { alive = false; }
    }
    assert.equal(alive, false, "the orphan must release the DB before migration");
  } finally {
    try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Pseudo-terminal on system tools: a real tty, size, Ctrl-C, UTF-8, exit, close.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { setGlobal } from "./helpers/globals.mjs";
import { loadSrc } from "./helpers/load-src.mjs";

// pty.js uses the window timers of Obsidian's renderer.
setGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
const { spawnPty } = loadSrc("pty");

const sleep = (ms) => delay(ms);
// eslint-disable-next-line no-control-regex -- terminal output is cleaned of escape sequences
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const env = Object.assign({}, process.env, { TERM: "xterm-256color", LANG: "en_US.UTF-8", PS1: "$ " });
const spawned = [];
const spawn = (opts) => {
  const pty = spawnPty(opts);
  spawned.push(pty);
  return pty;
};
after(() => { for (const pty of spawned) pty.kill(); });

describe("pseudo-terminal: one shell session", () => {
  let pty;
  let out = "";
  let exitCode;
  let tty;

  it("is a real tty", async () => {
    pty = spawn({ file: "/bin/sh", args: [], cwd: "/tmp", env, cols: 132, rows: 40 });
    pty.onData((d) => { out += d; });
    pty.onExit((c) => { exitCode = c; });
    await sleep(500);
    pty.write("tty; stty size; echo 'Привет, мир'\r");
    await sleep(600);
    tty = await pty.tty();
    assert.ok(tty && /^\/dev\/ttys\d+$/.test(tty.tty), JSON.stringify(tty));
    assert.ok(clean(out).includes(tty.tty));
  });

  it("sets the initial size before the program starts", () => {
    assert.ok(clean(out).includes("40 132"), clean(out).slice(-200));
  });

  it("passes UTF-8 both ways", () => {
    assert.ok(clean(out).includes("Привет, мир"));
  });

  it("joins a UTF-8 character split across chunks without broken characters", async () => {
    // A letter and a box-drawing line arrive in halves in separate output chunks.
    pty.write("printf '\\320'; sleep 0.3; printf '\\277\\342\\224'; sleep 0.3; printf '\\200\\n'\r");
    await sleep(1200);
    assert.ok(clean(out).includes("п─"), clean(out).slice(-80));
    assert.ok(!out.includes("�"));
  });

  it("changes size from outside", async () => {
    await pty.resize(100, 30);
    pty.write("stty size\r");
    await sleep(500);
    assert.ok(clean(out).includes("30 100"), clean(out).slice(-100));
  });

  it("interrupts the program on Ctrl-C", async () => {
    pty.write("sleep 30 && echo NOT-INTERRUPTED\r");
    await sleep(400);
    pty.write("\x03");
    await sleep(400);
    pty.write("echo AFTER\r");
    await sleep(500);
    assert.ok(clean(out).includes("AFTER"), clean(out).slice(-300));
    // NOT-INTERRUPTED appears once, in the echo of the typed command; a second one would be its output.
    assert.equal(clean(out).split("NOT-INTERRUPTED").length, 2, clean(out).slice(-300));
  });

  it("reports the program's exit to the tab", async () => {
    pty.write("exit\r");
    for (let i = 0; i < 30 && exitCode === undefined; i++) await sleep(200);
    assert.notEqual(exitCode, undefined);
  });
});

describe("pseudo-terminal: pick-up by a new tab", () => {
  // A new tab gets the output tail and further output; the old one gets nothing more.
  let long;
  let first = "";
  let second = "";

  it("gives the output tail to a new tab", async () => {
    long = spawn({ file: "/bin/sh", args: [], cwd: "/tmp", env, cols: 80, rows: 24 });
    long.onData((d) => { first += d; });
    await sleep(400);
    long.write("echo BEFORE-RELOAD\r");
    await sleep(400);
    long.onData((d) => { second += d; });
    assert.ok(clean(long.recent()).includes("BEFORE-RELOAD"));
  });

  it("sends further output to the new tab, not the old one", async () => {
    long.write("echo AFTER-RELOAD\r");
    await sleep(400);
    long.kill();
    assert.ok(clean(second).includes("AFTER-RELOAD"));
    assert.ok(!clean(first).includes("AFTER-RELOAD"));
  });
});

describe("pseudo-terminal: closing", () => {
  it("ends the program inside, even a busy one", async () => {
    const busy = spawn({ file: "/bin/sh", args: ["-c", "sleep 60"], cwd: "/tmp", env, cols: 80, rows: 24 });
    await sleep(500);
    const inner = await busy.tty();
    busy.kill();
    await sleep(500);
    assert.ok(inner, "no tty child found");
    let alive = true;
    try { process.kill(inner.pid, 0); } catch { alive = false; }
    assert.equal(alive, false);
  });
});

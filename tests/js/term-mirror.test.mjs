// The card's terminal mirror: the plugin side that hands a card the tab's PTY over a MessagePort.
// Built with a stub for the serializer and driven with a term that orders writes like xterm's WriteBuffer.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import esbuild from "esbuild";
import { ROOT, SRC } from "./helpers/load-src.mjs";
import { fakeTerm } from "./helpers/fake-term.mjs";

const built = await esbuild.build({
  entryPoints: [path.join(SRC, "term-mirror.js")], bundle: true, format: "esm", write: false, platform: "node",
  alias: { "@xterm/addon-serialize": path.join(ROOT, "tests", "js", "helpers", "serialize-stub.mjs") },
});
// eslint-disable-next-line no-unsanitized/method -- the bundle is built from our own source above
const { openTerminalMirror } = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));

const ports = [];
after(() => ports.forEach(p => p.close()));

// A tab with a PTY and a catalog page that asks for a mirror; `front` and `size` are what the tests vary.
function setup({ front = true, dataDir } = {}) {
  const term = fakeTerm();
  const writes = [], fits = [], got = [];
  const pty = { exited: false, write: text => writes.push(text) };
  const view = { pty, term, mirrorSubscribers: new Set(), fitMirror: (cols, rows) => fits.push([cols, rows]) };
  // The tab's output path, as in term-view.js
  const output = text => { term.write(text); view.mirrorSubscribers.forEach(send => send({ type: "data", text })); };
  const state = { front, port: null, target: true, touched: 0 };
  let opened;
  const source = { postMessage(msg, origin, transfer) {
    const port = transfer[0];
    if (port) {
      ports.push(port);
      state.port = port;
      port.onmessage = ({ data }) => got.push(data);
    }
    opened();
  } };
  const atlasView = { frame: { isConnected: true, contentWindow: source }, terminalMirrors: new Set() };
  const plugin = { app: { workspace: { getLeavesOfType: () => [{ view: atlasView }] } }, atlasOrigin: () => "x",
    atlasInFront: () => state.front, touchInput: () => { state.touched++; },
    dataDir: () => dataDir, terminalTabs: async () => [{ pid: 42, leaf: { view } }],
    checkTarget: async () => { if (state.gate) await state.gate; return (state.target ? { tab: { leaf: { view } } } : { error: "gone" }); } };
  const open = (target = {}) => new Promise(resolve => {
    opened = resolve;
    openTerminalMirror(plugin, { source }, { request: "r", ...target });
  });
  return { term, writes, fits, got, view, output, state, open, pty, atlasView };
}
const screen = got => got.map(m => (m.type === "start" ? m.text : m.type === "data" ? m.text : "")).join("");

describe("terminal mirror", () => {
  it("loses no output between the snapshot call and the live stream", async () => {
    const t = setup();
    t.term.write("BEFORE|");
    const opening = t.open();
    await Promise.resolve(); await Promise.resolve();   // checkTarget resolved: the snapshot write is queued
    t.output("D1|");                                     // arrives before the write buffer runs
    await opening;
    t.output("D2|");
    await delay(20);
    assert.equal(screen(t.got), t.term.screen);
    assert.equal(t.got[0].type, "start");
  });

  it("a size change reaches the PTY owner while Atlas is not in front", async () => {
    const t = setup({ front: false });
    await t.open();
    t.state.port.postMessage({ type: "size", cols: 100, rows: 30 });
    t.state.port.postMessage({ type: "input", text: "x" });
    await delay(20);
    assert.deepEqual(t.fits, [[100, 30]]);
    assert.deepEqual(t.writes, []);
  });

  it("input goes to the PTY while Atlas is in front", async () => {
    const t = setup();
    await t.open();
    t.state.port.postMessage({ type: "input", text: "ls\r" });
    await delay(20);
    assert.deepEqual(t.writes, ["ls\r"]);
  });

  it("theme and exit messages of the tab reach the card, and exit ends the session", async () => {
    const t = setup();
    await t.open();
    t.view.mirrorSubscribers.forEach(send => send({ type: "theme", theme: { background: "#000" } }));
    t.view.mirrorSubscribers.forEach(send => send({ type: "exit" }));
    await delay(20);
    assert.deepEqual(t.got.slice(-2), [{ type: "theme", theme: { background: "#000" } }, { type: "exit" }]);
    assert.equal(t.view.mirrorSubscribers.size, 0);
  });

  it("card typing counts as input for the mail nudge's quiet window", async () => {
    const t = setup();
    await t.open();
    t.state.port.postMessage({ type: "input", text: "x" });
    await delay(20);
    assert.deepEqual(t.writes, ["x"]);
    assert.equal(t.state.touched, 1);
  });

  it("card input waiting for its check counts as pending for the tab, and no longer after it is written", async () => {
    const t = setup();
    await t.open();
    await delay(1100);
    let release;
    t.state.gate = new Promise(resolve => { release = resolve; });
    t.state.port.postMessage({ type: "input", text: "x" });
    await delay(20);
    assert.equal(t.view.pendingMirrorInput, 1);
    assert.deepEqual(t.writes, []);
    release();
    await delay(20);
    assert.equal(t.view.pendingMirrorInput, 0);
    assert.deepEqual(t.writes, ["x"]);
  });

  it("input is refused and the card told once the tab no longer holds the agent", async () => {
    const t = setup();
    await t.open();
    await delay(1100);                       // the verification from opening is stale now
    t.state.target = false;
    t.state.port.postMessage({ type: "input", text: "x" });
    await delay(30);
    assert.deepEqual(t.writes, []);
    assert.deepEqual(t.got.at(-1), { type: "exit" });
    assert.equal(t.view.mirrorSubscribers.size, 0);
  });

  it("input is refused when the tab now runs another PTY", async () => {
    const t = setup();
    await t.open();
    await delay(1100);
    t.view.pty = { exited: false, write: text => t.writes.push(text) };
    t.state.port.postMessage({ type: "input", text: "x" });
    await delay(30);
    assert.deepEqual(t.writes, []);
  });

  for (const stale of [false, true]) it(stale
    ? "OpenCode refuses mirror input with a stale heartbeat for the same route"
    : "an OpenCode tab changing its recorded route ends a silent mirror", async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-route-mirror-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const m = setup({ dataDir });
    const instance = "fixture";
    const nonce = "a".repeat(32);
    const attempt = "b".repeat(32);
    const sid = "ses_" + "c".repeat(26);
    const pid = 43;
    const dir = path.join(dataDir, "opencode-tabs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, instance + ".json"), JSON.stringify({ pid, nonce, attempt }));
    const setRoute = (current, age = 0) => fs.writeFileSync(path.join(dir, `${instance}.${nonce}.route`),
      JSON.stringify({ pid, nonce, route: "session", current, at: Date.now() - age }));
    setRoute(sid);
    m.view.state = { kind: "opencode", instance };
    m.pty.openCodeAttempt = attempt;
    const originalWindow = globalThis.window;
    globalThis.window = { setInterval, clearInterval };
    t.after(() => {
      for (const end of m.atlasView.terminalMirrors) end();
      m.state.port?.close();
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    });
    await m.open({ agent: "opencode", ptyPid: 42, claudePid: 42, sessionId: sid });
    assert.ok(m.state.port);
    if (stale) {
      m.state.port.postMessage({ type: "input", text: "fresh" });
      await delay(20);
      setRoute(sid, 2100);
      m.state.port.postMessage({ type: "input", text: "stale" });
      await delay(20);
      assert.deepEqual(m.writes, ["fresh"]);
    } else {
      setRoute("ses_" + "d".repeat(26));
      await delay(550);
    }
    assert.equal(m.view.mirrorSubscribers.size, 0);
    assert.deepEqual(m.got.at(-1), stale ? { type: "exit", unavailable: true } : { type: "exit" });
  });

  for (const unlinkFails of [false, true]) it(`the TUI ${unlinkFails ? "stops the stale route heartbeat" : "removes the old route"} when publishing fails`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-route-publish-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "tab.route");
    const sid = letter => "ses_" + letter.repeat(26);
    let current = sid("a");
    let publish;
    let tick;
    const code = fs.readFileSync(path.join(ROOT, "obsidian-plugin/opencode-tab/tui.mjs"), "utf8");
    const { code: compiled } = esbuild.transformSync(code, { format: "cjs" });
    const context = { module: { exports: {} }, require: name => ({
      "node:fs": { ...fs, unlinkSync: unlinkFails ? () => { throw new Error("fixture unlink failure"); } : fs.unlinkSync },
      "@opencode/plugin/tui": { Plugin: { define: value => value } },
      "solid-js": { createEffect: callback => { publish = callback; } },
    })[name], setInterval: callback => { tick = callback; return 1; }, clearInterval: () => { tick = null; } };
    vm.runInNewContext(compiled, context);
    context.module.exports.default.setup({ options: { file, nonce: "fixture", pid: 10 },
      ui: { router: { current: () => ({ type: "session", sessionID: current }) },
        slot: ({ render }) => { render(); return {}; } } });
    const oldRoute = fs.readFileSync(file, "utf8");
    assert.equal(JSON.parse(oldRoute).current, sid("a"));
    fs.mkdirSync(file + ".tmp");
    current = sid("b");
    tick();
    if (unlinkFails) {
      assert.equal(tick, null);
      assert.equal(fs.readFileSync(file, "utf8"), oldRoute);
    } else {
      assert.equal(fs.existsSync(file), false);
    }
    fs.rmdirSync(file + ".tmp");
    current = sid("a");
    publish();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).current, sid("a"));
    assert.equal(typeof tick, "function");
  });

  it("a snapshot that throws leaves no subscription and no open card, and frees the serializer", async () => {
    const t = setup();
    t.term.failSerialize = true;
    await t.open();
    assert.equal(t.view.mirrorSubscribers.size, 0);
    assert.equal(t.state.port, null);
    assert.equal(t.term.disposedSerializers, 1);
  });
});

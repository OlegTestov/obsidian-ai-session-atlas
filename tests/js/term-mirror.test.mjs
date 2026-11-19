// The card's terminal mirror: the plugin side that hands a card the tab's PTY over a MessagePort.
// Built with a stub for the serializer and driven with a term that orders writes like xterm's WriteBuffer.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
function setup({ front = true } = {}) {
  const term = fakeTerm();
  const writes = [], fits = [], got = [];
  const pty = { exited: false, write: text => writes.push(text) };
  const view = { pty, term, mirrorSubscribers: new Set(), fitMirror: (cols, rows) => fits.push([cols, rows]) };
  // The tab's output path, as in term-view.js
  const output = text => { term.write(text); view.mirrorSubscribers.forEach(send => send({ type: "data", text })); };
  const state = { front, port: null, target: true, touched: 0 };
  const source = { postMessage(msg, origin, transfer) {
    const port = transfer[0];
    if (!port) return;
    ports.push(port);
    state.port = port;
    port.onmessage = ({ data }) => got.push(data);
  } };
  const atlasView = { frame: { isConnected: true, contentWindow: source }, terminalMirrors: new Set() };
  const plugin = { app: { workspace: { getLeavesOfType: () => [{ view: atlasView }] } }, atlasOrigin: () => "x",
    atlasInFront: () => state.front, touchInput: () => { state.touched++; },
    checkTarget: async () => { if (state.gate) await state.gate; return (state.target ? { tab: { leaf: { view } } } : { error: "gone" }); } };
  const open = async () => {
    openTerminalMirror(plugin, { source }, { request: "r" });
    await delay(5);
  };
  return { term, writes, fits, got, view, output, state, open, pty };
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

  it("a snapshot that throws leaves no subscription and no open card, and frees the serializer", async () => {
    const t = setup();
    t.term.failSerialize = true;
    await t.open();
    assert.equal(t.view.mirrorSubscribers.size, 0);
    assert.equal(t.state.port, null);
    assert.equal(t.term.disposedSerializers, 1);
  });
});

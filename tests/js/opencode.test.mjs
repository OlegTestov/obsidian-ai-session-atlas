// OpenCode catalog request lifecycle and the plugin's live layout boundary.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { loadSrc } from "./helpers/load-src.mjs";
import { compileScript } from "./helpers/page.mjs";

const source = { session_id: "ses_" + "s".repeat(26), title: "Source" };
const copy = { session_id: "ses_" + "c".repeat(26), command: "opencode /project --session copy" };
const storageKey = "atlas.opencode.copy." + source.session_id;
const element = () => ({ classList: { add() {} }, append() {}, addEventListener() {}, focus() {},
  isConnected: true, getClientRects: () => [1] });

function page({ embedded = true, storage = new Map(), responses = [], acknowledgements = [] } = {}) {
  const nodes = new Map([["#modal", { open: false }]]);
  const $ = key => {
    if (!nodes.has(key)) nodes.set(key, element());
    return nodes.get(key);
  };
  const requests = [];
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  const parent = {};
  const window = {
    parent, setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(_type, fn) { this.listener = fn; },
    removeEventListener() { this.listener = null; },
  };
  let requestCounter = 0;
  const document = { hidden: false };
  const ctx = vm.createContext({
    window, document, $, EMBEDDED: embedded, HOST_SOURCE: "atlas-host",
    i18n: key => key, el: element, activeSessions: [],
    crypto: { randomUUID: () => "fixture-request-" + ++requestCounter },
    store: (key, value) => storage.set(key, value),
    loadStored: (key, fallback) => storage.get(key) ?? fallback,
    modal(_title, note, body, label, run) {
      $("#modal").open = true;
      Object.assign($("#m-ok"), { onclick: run, textContent: label, disabled: false });
      $("#m-note").textContent = note;
      $("#m-body").textContent = body;
    },
    closeAfterHandOff() { $("#modal").open = false; },
    tellHost(_type, data) {
      sent.push(data);
      window.listener({ source: parent, data: { source: "atlas-host", type: "launch-result",
        request: data.launchRequest, ok: acknowledgements.shift() } });
    },
    async api(route, body) {
      requests.push({ route, body });
      const next = responses.shift();
      const response = typeof next === "function" ? await next(body) : next;
      if (response instanceof Error) throw response;
      return response;
    },
  });
  compileScript("launch-host.js").runInContext(ctx);
  compileScript("opencode.js").runInContext(ctx);
  return { ctx, $, document, requests, sent, timers, storage };
}

for (const [label, reload, confirmation] of [
  ["in place", false, false], ["after reload", true, false], ["after explicit confirmation", false, true],
]) {
  test(`a lost Copy response reuses the committed request ${label}`, async () => {
    const committed = new Map();
    const fork = ({ request_id }) => {
      if (!committed.has(request_id)) committed.set(request_id, copy);
      if (!lost) {
        lost = true;
        throw new Error("Connection lost after commit");
      }
      return committed.get(request_id);
    };
    let lost = false;
    const responses = [fork, fork];
    if (confirmation) responses.unshift({ status: "unknown", candidates: [], confirmation_id: "earlier-request" });
    const first = page({ responses, acknowledgements: [true] });
    await first.ctx.openCodeLaunch(source, true);
    if (confirmation) await first.$("#m-ok").onclick();
    await first.$("#m-ok").onclick();
    assert.equal(first.$("#m-note").textContent, "Connection lost after commit");
    const retry = reload ? page({ storage: first.storage, responses: [fork], acknowledgements: [true] }) : first;
    retry.ctx.crypto.randomUUID = () => "fresh-after-loss";
    if (reload) await retry.ctx.openCodeLaunch(source, true);
    await retry.$("#m-ok").onclick();
    assert.equal(committed.size, 1);
    assert.equal(retry.sent[0].session_id, copy.session_id);
    assert.equal(retry.storage.get(storageKey), null);
  });
}

for (const [label, embedded, lateOutcome] of [
  ["standalone handoff", false, copy],
  ["Obsidian acknowledgement", true, copy],
  ["unknown status", false, { status: "unknown", candidates: [], confirmation_id: null }],
  ["missing session", false, Object.assign(new Error("The saved copy is missing"), { state: "session_missing" })],
]) {
  test(`a late Copy reply preserves a newer request after ${label}`, async () => {
    const committed = new Map();
    const fork = ({ request_id }) => {
      if (!committed.has(request_id)) committed.set(request_id, copy);
      return committed.get(request_id);
    };
    let releaseReply;
    const reply = new Promise(resolve => { releaseReply = resolve; });
    const first = page({ embedded, responses: [body => { fork(body); return reply; }],
      acknowledgements: [true] });
    await first.ctx.openCodeLaunch(source, true);
    const late = first.$("#m-ok").onclick();
    const original = first.storage.get(storageKey);

    const second = page({ embedded, storage: first.storage, responses: [fork, body => {
      fork(body);
      return new Error("Connection lost after commit");
    }], acknowledgements: [true] });
    second.ctx.crypto.randomUUID = () => "second-copy";
    await second.ctx.openCodeLaunch(source, true);
    await second.$("#m-ok").onclick();
    assert.equal(second.requests[0].body.request_id, original);
    assert.equal(committed.size, 1);
    await second.ctx.openCodeLaunch(source, true);
    await second.$("#m-ok").onclick();
    assert.equal(second.$("#m-note").textContent, "Connection lost after commit");
    assert.equal(second.storage.get(storageKey), "second-copy");

    releaseReply(lateOutcome);
    await late;
    const reloaded = page({ embedded, storage: second.storage, responses: [fork], acknowledgements: [true] });
    reloaded.ctx.crypto.randomUUID = () => "duplicate-after-reload";
    await reloaded.ctx.openCodeLaunch(source, true);
    await reloaded.$("#m-ok").onclick();
    assert.equal(committed.size, 2, "two intended copies create exactly two forks");
    assert.equal(reloaded.requests[0].body.request_id, "second-copy");
  });
}

test("a known copy retries across reload until acknowledged, then the next copy uses a fresh request", async () => {
  const first = page({ responses: [copy], acknowledgements: [false] });
  await first.ctx.openCodeLaunch(source, true);
  await first.$("#m-ok").onclick();
  const saved = first.requests[0].body.request_id;
  assert.equal(first.storage.get(storageKey), saved);
  assert.equal(first.$("#m-ok").textContent, "actions.openInObsidian");

  const second = page({ storage: first.storage, responses: [copy, copy], acknowledgements: [true, true] });
  // The new page needs a different UUID from the original page.
  second.ctx.crypto.randomUUID = () => "fresh-after-reload";
  await second.ctx.openCodeLaunch(source, true);
  await second.$("#m-ok").onclick();
  assert.equal(second.requests[0].body.request_id, saved);
  assert.equal(second.storage.get(storageKey), null);
  assert.equal(second.$("#modal").open, false);
  await second.ctx.openCodeLaunch(source, true);
  await second.$("#m-ok").onclick();
  assert.notEqual(second.requests[1].body.request_id, saved);
});

test("showing a standalone copy command hands it off and clears the request", async () => {
  const p = page({ embedded: false, responses: [copy, copy] });
  await p.ctx.openCodeLaunch(source, true);
  await p.$("#m-ok").onclick();
  assert.equal(p.$("#m-body").textContent, copy.command);
  assert.equal(p.storage.get(storageKey), null);
  await p.ctx.openCodeLaunch(source, true);
  await p.$("#m-ok").onclick();
  assert.notEqual(p.requests[1].body.request_id, p.requests[0].body.request_id);
});

for (const [name, outcome] of [
  ["deleted", Object.assign(new Error("The saved copy is missing"), { state: "session_missing" })],
  ["superseded", { status: "unknown", candidates: [], confirmation_id: null }],
  ["unknown", { status: "unknown", candidates: [], confirmation_id: "old-known-request" }],
]) {
  test(`a ${name} copy request can be replaced from the current dialog`, async () => {
    const p = page({ storage: new Map([[storageKey, "old-known-request"]]), responses: [outcome, copy],
      acknowledgements: [true] });
    await p.ctx.openCodeLaunch(source, true);
    await p.$("#m-ok").onclick();
    assert.equal(p.requests[0].body.request_id, "old-known-request");
    assert.equal(p.storage.get(storageKey), null);
    if (name === "deleted") assert.equal(p.$("#m-note").textContent, outcome.message);
    assert.equal(p.$("#m-ok").textContent, name === "unknown" ? "opencode.createAnother" : "opencode.createCopy");
    await p.$("#m-ok").onclick();
    assert.notEqual(p.requests[1].body.request_id, "old-known-request");
    assert.equal(p.requests[1].body.confirm_unknown, name === "unknown" ? "old-known-request" : null);
  });
}

test("passive Delete checks run only for a visible card and are at least 15 seconds apart", async () => {
  const eligible = { disabled_reason: null };
  const p = page({ responses: [eligible, eligible] });
  p.document.hidden = true;
  p.ctx.facets = {};
  const bar = element();
  p.ctx.openCodeActionBar(bar, source);
  async function tick() {
    const [id, timer] = p.timers.entries().next().value;
    p.timers.delete(id);
    await timer.fn();
    return timer.ms;
  }
  await tick();
  assert.equal(p.requests.length, 0);
  p.document.hidden = false;
  assert.ok(await tick() >= 15000);
  assert.equal(p.requests[0].body.passive, true);
  bar.getClientRects = () => [];
  assert.ok(await tick() >= 15000);
  assert.equal(p.requests.length, 1);
  bar.isConnected = false;
  await tick();
  assert.equal(p.timers.size, 0);
});

test("the OpenCode layout helper scrubs both password variables and distinguishes a deferred leaf", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-opencode-layout-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"];
  for (const key of keys) {
    const previous = process.env[key];
    process.env[key] = "fixture-password";
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let helperEnv;
  t.mock.method(childProcess, "execFileSync", (_file, _args, { env }) => {
    helperEnv = env;
    return "start";
  });
  const { watchOpenCodeLayout } = loadSrc("opencode-tab");
  const leaf = { getViewState: () => ({ state: { kind: "opencode", instance: "opencode-1" } }), view: {} };
  const plugin = { dataDir: () => root, registerEvent() {}, register() {},
    app: { workspace: { on() {}, iterateAllLeaves(fn) { fn(leaf); } } } };
  const layout = path.join(root, "opencode-tabs", `layout-${process.pid}.json`);
  const entries = () => fs.existsSync(layout) ? JSON.parse(fs.readFileSync(layout, "utf8")).tabs : [];
  watchOpenCodeLayout(plugin);
  for (const key of keys) assert.equal(helperEnv[key], undefined);
  assert.deepEqual(entries(), []);
  leaf.view.openCodeLaunching = "a".repeat(32);
  plugin.saveOpenCodeLayout();
  assert.deepEqual(entries(), [{ instance: "opencode-1", attempt: "a".repeat(32), launching: true, ptyPid: null }]);
  delete leaf.view.openCodeLaunching;
  leaf.view.pty = { openCodeAttempt: "a".repeat(32), exited: true };
  plugin.saveOpenCodeLayout();
  assert.deepEqual(entries(), []);
});

function terminalView(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-opencode-view-"));
  const noop = () => {};
  const subscription = () => ({ dispose: noop });
  const events = new EventTarget();
  events.ownerDocument = { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame: noop } };
  const globals = { window: { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop },
    document: { body: {} }, getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} } };
  const oldGlobals = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  const oldZdotdir = process.env.ZDOTDIR;
  process.env.ZDOTDIR = root;
  let view;
  t.after(async () => {
    view?.pty?.kill();
    for (let tries = 0; view?.pty && !view.pty.exited && tries < 50; tries++) await delay(20);
    Object.assign(globalThis, oldGlobals);
    if (oldZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = oldZdotdir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  class Terminal {
    cols = 80;
    rows = 24;
    element = events;
    parser = { registerOscHandler: noop };
    buffer = { onBufferChange: subscription };
    onWriteParsed = subscription;
    onScroll = subscription;
    onResize = subscription;
    loadAddon() {}
    open() {}
    registerLinkProvider() {}
    attachCustomKeyEventHandler() {}
    onData() {}
    onTitleChange() {}
    write() {}
    dispose() {}
  }
  const load = Module._load;
  const stub = t.mock.method(Module, "_load", (id, ...args) => {
    if (id === "obsidian") return { ItemView: class { constructor(leaf) { this.leaf = leaf; } } };
    if (id === "@xterm/xterm") return { Terminal };
    return load(id, ...args);
  });
  const { AgentTerminalView } = loadSrc("term-view");
  stub.mock.restore();
  const leaf = { getViewState: () => ({ state: leaf.view.getState() }) };
  const workspace = { on() {}, iterateAllLeaves(visit) { visit(leaf); } };
  const plugin = { app: { workspace }, settings: { shellPath: "/bin/zsh" },
    dataDir: () => root, runtimeDir: () => root, lang: () => "en", t: key => key,
    register: noop, registerEvent: noop };
  view = new AgentTerminalView(leaf, plugin);
  leaf.view = view;
  Object.assign(view, { app: plugin.app, box: {}, containerEl: {}, registerDomEvent: noop, registerEvent: noop });
  const file = path.join(root, "opencode-tabs", `layout-${process.pid}.json`);
  return { view, plugin, file, root };
}

test("the terminal view publishes its OpenCode attempt before and after spawning the PTY", async t => {
  const { view, plugin, file, root } = terminalView(t);
  const { watchOpenCodeLayout } = loadSrc("opencode-tab");
  watchOpenCodeLayout(plugin);
  const save = plugin.saveOpenCodeLayout;
  const publications = [];
  plugin.saveOpenCodeLayout = () => {
    save();
    publications.push(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).tabs[0] : null);
  };
  const instance = "opencode-crash";
  await view.setState({ instance, kind: "opencode", focus: false, cwd: root,
    command: "exec /bin/sh -c 'kill -KILL $$'" });
  assert.equal(publications.length, 2);
  const [before, after] = publications;
  assert.equal(before.instance, instance);
  assert.equal(before.launching, true);
  assert.match(before.attempt, /^[a-f0-9]{32}$/);
  assert.equal(after.attempt, before.attempt);
  assert.equal(before.ptyPid, null);
  assert.equal(after.ptyPid, view.pty.pid);
  assert.equal(after.startedAt, before.startedAt);
  assert.ok(Math.abs(after.startedAt - Date.now()) < 5000);
  for (let tries = 0; fs.existsSync(file) && tries < 120; tries++) await delay(50);
  assert.equal(fs.existsSync(file), false, "the launch child died without leaving an exit marker");
});

test("an adopted legacy OpenCode attempt expires only after its TUI dies", async t => {
  let pty;
  t.after(() => { if (pty && !pty.exited) pty.kill(); });
  const { view, plugin, file, root } = terminalView(t);
  const instance = "opencode-legacy-crash";
  const attempt = "a".repeat(32);
  const ready = path.join(root, "child-ready");
  const stopped = path.join(root, "child-stopped");
  const { spawnPty } = loadSrc("pty");
  pty = spawnPty({ file: "/bin/bash", cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" },
    args: ["-c", '(exec -a opencode2 /bin/sleep 60) & child=$!; : > "$1"; read -r stop; '
      + 'kill "$child"; wait "$child"; : > "$2"; read -r hold', "fixture", ready, stopped] });
  const waitForMarker = async marker => {
    for (let tries = 0; !fs.existsSync(marker) && tries < 100; tries++) await delay(25);
    assert.ok(fs.existsSync(marker), path.basename(marker));
  };
  await waitForMarker(ready);
  assert.ok(await pty.tty(), "the legacy wrapper has a terminal");
  pty.openCodeAttempt = attempt;
  window.__sessionAtlasPtys = new Map([[instance, { pty, timer: null, held: true }]]);

  const adoptedAt = Date.now();
  await view.setState({ instance, kind: "opencode", focus: false, cwd: root, command: "exit 1" });
  assert.equal(view.pty, pty);
  const { watchOpenCodeLayout } = loadSrc("opencode-tab");
  watchOpenCodeLayout(plugin);
  const entry = JSON.parse(fs.readFileSync(file, "utf8")).tabs[0];
  assert.equal(entry.ptyPid, pty.pid);
  assert.equal(entry.attempt, attempt);

  const blockedAt = ms => childProcess.execFileSync("/usr/bin/python3", ["-c",
    "from atlas import opencode_tabs as t; import sys; t.time.time = lambda: int(sys.argv[1])/1000; print(t.open_tabs()[1])",
    String(ms)], { encoding: "utf8", timeout: 5000, env: { HOME: root, ATLAS_HOME: root,
      ATLAS_OPENCODE_BIN: "", XDG_STATE_HOME: root, XDG_DATA_HOME: root, PYTHONDONTWRITEBYTECODE: "1" } }).trim();
  const fresh = Date.now();
  const expired = fresh + 121_000;
  assert.equal(blockedAt(fresh), "True");
  assert.equal(blockedAt(expired), "True", "an old attempt with a live child still blocks Delete");
  pty.write("stop\n");
  await waitForMarker(stopped);
  assert.equal(pty.exited, false, "the legacy PTY wrapper outlives its child");
  assert.equal(blockedAt(fresh), "True", "a fresh attempt still blocks Delete after the child dies");
  assert.equal(blockedAt(expired), "False", "an old attempt with a dead child releases Delete");
  assert.ok(entry.startedAt >= adoptedAt && entry.startedAt <= fresh);
});

test("a closed OpenCode leaf releases the launch wait on the next tick", async () => {
  const { waitForOpenCodeSession } = loadSrc("opencode-tab");
  const leaf = {};
  let attached = true;
  const workspace = { iterateAllLeaves(visit) { if (attached) visit(leaf); } };
  const launched = waitForOpenCodeSession("/fixture", leaf, "opencode-test", source.session_id, workspace);
  attached = false;
  assert.equal(await Promise.race([launched, delay(1500, "still waiting", { ref: false })]), false);
});

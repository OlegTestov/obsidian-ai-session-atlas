import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { compileScript, loadPage, pageOrder } from "./helpers/page.mjs";

const claude = { live: true, windows: [
  { key: "five_hour", label: "5 hours", used_percentage: 27.1 },
  { key: "seven_day", label: "week", used_percentage: 3 },
] };
const codex = { live: true, windows: [{ key: "seven_day", label: "week", used_percentage: 42 }] };
const payload = { limits: claude, codex_limits: codex };
const text = parts => parts.map(part => part.text).join(" · ");

function page() {
  return loadPage(pageOrder().filter(file => file !== "init.js"));
}

test("header chooses the widest version that fits, including exact fits and no space", () => {
  const p = page();
  const widths = [237.5, 107, 38];
  for (const [available, expected] of [[400, 0], [237.5, 0], [237.49, 1], [107, 1], [106, 2], [38, 2], [37, -1]]) {
    assert.equal(p.pickHeaderLimits(widths, available), expected);
  }
});

test("header variants keep both agents, localize the full text and select the highest window", () => {
  const p = page();
  vm.runInContext('agentPick.active = ["claude"]', p);
  let model = p.headerLimitsModel(payload, true);
  assert.deepEqual(Array.from(model.variants, text), [
    "Claude 5h 27% · wk 3% · Codex wk 42%", "Claude 27% · Codex 42%", "Codex 42%",
  ]);
  assert.equal(model.label, text(model.variants[0]));
  assert.match(model.title, /^Claude 5h 27% · wk 3% · Codex wk 42%\n/);
  p.I18N.setLang("ru");
  model = p.headerLimitsModel(payload, true);
  assert.deepEqual(Array.from(model.variants, text), [
    "Claude 5ч 27% · нед 3% · Codex нед 42%", "Claude 27% · Codex 42%", "Codex 42%",
  ]);
  assert.match(model.title, /Лимиты Codex/);

  assert.deepEqual(Array.from(p.headerLimitsModel({ codex_limits: codex }, false).variants, text), [
    "лимиты — · Codex нед 42%", "Codex 42%", "Codex 42%",
  ]);
  assert.doesNotMatch(p.headerLimitsModel({}, false).title, /settings\.json/);
  assert.match(p.headerLimitsModel({}, true).title, /settings\.json/);
});

test("compact variants use the highest raw usage for each agent and keep its tone", () => {
  const p = page();
  const usage = (first, second) => ({ ...claude, windows: claude.windows.map((window, i) => ({
    ...window, used_percentage: i === 0 ? first : second,
  })) });
  const spent = p.headerLimitsModel({ limits: usage(3, 78), codex_limits: usage(42, 100) }, true);
  assert.equal(text(spent.variants[1]), "Claude 78% · Codex 100%");
  assert.deepEqual(Array.from(spent.variants[1], part => part.tone), ["mid", "warn"]);
  assert.equal(text(spent.variants[2]), "Codex 100%");
  assert.equal(spent.variants[2][0].tone, "warn");
  assert.match(spent.label, /Codex 5h 42% · wk 100%, used up/);

  const sameDisplay = p.headerLimitsModel({ limits: usage(80.1, 3), codex_limits: usage(80.2, 42) }, true);
  assert.equal(text(sameDisplay.variants[2]), "Codex 80%");
  const tied = p.headerLimitsModel({ limits: usage(80, 3), codex_limits: usage(80, 42) }, true);
  assert.equal(text(tied.variants[2]), "Claude 80%");
});

const ACTIVE = "/api/active?codex_usage=1";
const LIGHT = "/api/limits";
const session = { session_id: "first", agent: "claude", title: "First session" };
const activeData = { ...payload, limits: null, sessions: [session] };
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (json, ok = true) => ({ ok, json: async () => json });

function polling({ start = "search", hidden = false, embedded = false, active = () => response(activeData) } = {}) {
  const paths = [];
  const shown = [];
  const timers = new Map();
  const events = new Map();
  const listeners = new Map();
  let id = 0;
  let now = 0;
  const on = (key, fn) => events.set(key, [...(events.get(key) || []), fn]);
  const emit = (key, event) => {
    for (const fn of events.get(key) || []) fn(event);
  };
  const p = loadPage(pageOrder().filter(file => file !== "init.js"), { setup(ctx) {
    const query = ctx.document.querySelector;
    ctx.document.querySelector = selector => {
      if (!listeners.has(selector)) {
        const node = query(selector);
        node.addEventListener = (event, fn) => on(selector + event, fn);
        listeners.set(selector, node);
      }
      return listeners.get(selector);
    };
    ctx.document.addEventListener = (event, fn) => on("document:" + event, fn);
    ctx.addEventListener = (event, fn) => on("window:" + event, fn);
    ctx.document.hidden = hidden;
    ctx.location.hash = "#view=" + start;
    if (embedded) {
      ctx.parent = { postMessage() {} };
      ctx.location.search = "?host_visibility=1";
    }
  } });
  p.renderedLimits = shown;
  p.testNow = () => now;
  vm.runInContext(`Date.now = window.testNow;
    renderHeaderLimits = data => renderedLimits.push(data);
    renderActive = () => {};
  `, p);
  p.fetch = async (path, options) => {
    if (path !== ACTIVE && path !== LIGHT) return new Promise(() => {});
    paths.push(path);
    return path === ACTIVE ? active() : response(payload, !options.signal.aborted);
  };
  p.setTimeout = (fn, delay) => {
    timers.set(++id, { fn, at: now + delay });
    return id;
  };
  p.clearTimeout = key => timers.delete(key);
  async function tick(at) {
    await flush();
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= at).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [key, timer] = next;
      timers.delete(key);
      now = timer.at;
      timer.fn();
      await flush();
    }
    now = at;
  }
  const view = name => emit("#view-" + name + "click");
  const visibility = visible => {
    p.document.hidden = !visible;
    emit("document:visibilitychange");
  };
  const pane = (visible, source = p.parent) => emit("window:message", {
    source, data: { source: "session-atlas-host", type: "pane-visibility", visible },
  });
  compileScript("init.js").runInContext(p);
  return { p, paths, shown, tick, view, visibility, pane };
}

test("Active feeds the header, then Search and Statistics share a minute", async () => {
  const { p, paths, shown, tick, view } = polling({ start: "active" });
  vm.runInContext('agentPick.active = ["claude"]', p);
  await tick(5000);
  assert.deepEqual(paths, [ACTIVE, ACTIVE]);
  assert.equal(shown.at(-1).limits, null);
  assert.equal(shown.at(-1).codex_limits, codex);
  view("search");
  await tick(64999);
  assert.deepEqual(paths, [ACTIVE, ACTIVE]);
  await tick(65000);
  assert.deepEqual(paths, [ACTIVE, ACTIVE, LIGHT]);
  assert.equal(shown.at(-1).limits, claude);
  view("stats");
  await tick(124999);
  assert.equal(paths.length, 3);
  await tick(125000);
  assert.equal(paths.at(-1), LIGHT);
  assert.equal(paths.length, 4);
});

test("document visibility pauses requests and restarts due limits and Active polling", async () => {
  const { p, paths, shown, tick, view, visibility } = polling();
  await tick(0);
  assert.deepEqual(paths, [ACTIVE]);
  visibility(false);
  await tick(120000);
  assert.deepEqual(paths, [ACTIVE]);
  visibility(true);
  await tick(120000);
  assert.deepEqual(paths, [ACTIVE, LIGHT]);
  assert.equal(shown.at(-1).limits, claude);

  visibility(false);
  view("active");
  await tick(180000);
  assert.equal(paths.length, 2);
  visibility(true);
  await tick(180000);
  assert.deepEqual(paths, [ACTIVE, LIGHT, ACTIVE]);
  assert.equal(shown.at(-1).limits, null);
  assert.equal(p.document.hidden, false);
});

test("host pane visibility pauses both pollers while the iframe document is visible", async () => {
  const { p, paths, shown, tick, view, pane } = polling({ embedded: true });
  pane(true, {});                                // a message from outside the host cannot resume polling
  await tick(120000);
  assert.deepEqual(paths, []);
  pane(true);
  await tick(120000);
  assert.deepEqual(paths, [ACTIVE]);
  assert.equal(shown.at(-1).limits, null);
  pane(false);
  assert.equal(p.document.hidden, false);
  await tick(240000);
  assert.deepEqual(paths, [ACTIVE]);
  pane(true);
  await tick(240000);
  assert.deepEqual(paths, [ACTIVE, LIGHT]);
  assert.equal(shown.at(-1).limits, claude);

  view("active");
  await tick(240000);
  assert.deepEqual(paths, [ACTIVE, LIGHT, ACTIVE]);
  pane(false);
  await tick(360000);
  assert.equal(paths.length, 3);
  pane(true);
  await tick(365000);
  assert.deepEqual(paths, [ACTIVE, LIGHT, ACTIVE, ACTIVE, ACTIVE]);
});

function assertSnapshot(p) {
  assert.equal(p.document.querySelector("#active-count").textContent, "1");
  assert.deepEqual(Array.from(p.jumpSources(), item => item.title), ["First session"]);
}

for (const start of ["search", "stats"]) {
  test(`a hidden ${start} startup retries its one-off Active snapshot on return`, async () => {
    let attempts = 0;
    const { p, paths, tick, visibility } = polling({ start, hidden: true,
      active: () => ++attempts === 1 ? response({ error: "try again" }, false) : response(activeData),
    });
    await tick(10000);
    assert.deepEqual(paths, []);
    visibility(true);
    await tick(10000);
    assert.equal(paths.filter(path => path === ACTIVE).length, 1);
    assert.equal(p.jumpSources().length, 0);
    await tick(15000);
    assertSnapshot(p);
    await tick(28000);
    assert.equal(paths.filter(path => path === ACTIVE).length, 2);
  });
}

test("the first Active response still fills the counter and Quick Jump after switching to Search", async () => {
  let reply;
  const { p, paths, shown, tick, view } = polling({ start: "active",
    active: () => new Promise(resolve => { reply = resolve; }),
  });
  view("search");
  reply(response(activeData));
  await tick(5000);
  assertSnapshot(p);
  assert.deepEqual(paths, [ACTIVE]);
  assert.equal(shown.at(-1).codex_limits, codex);
});

test("a stalled Active request cannot overwrite the newer light response or lose the first snapshot", async () => {
  let reply;
  const { p, paths, shown, tick, view } = polling({ start: "active",
    active: () => new Promise(resolve => { reply = resolve; }),
  });
  view("search");
  await tick(60000);
  assert.deepEqual(paths, [ACTIVE, LIGHT]);
  assert.equal(shown.at(-1).limits, claude);
  const results = shown.length;
  reply(response(activeData));
  await tick(60000);
  assert.equal(shown.length, results);
  assertSnapshot(p);
});

test("the last applied header snapshot is ordered by request start across both sources", () => {
  const { p, shown } = polling({ hidden: true });
  const full = p.markLimitsRequested();
  const light = p.markLimitsRequested();
  // The valid full snapshot can be shown while the later light response is still pending.
  p.updateHeaderLimits(activeData, full);
  assert.equal(shown.at(-1).limits, null);
  p.updateHeaderLimits(payload, light);
  assert.equal(shown.at(-1).limits, claude);
  const newerFull = p.markLimitsRequested();
  p.updateHeaderLimits(activeData, newerFull);
  const results = shown.length;
  p.updateHeaderLimits(payload, light);
  assert.equal(shown.length, results);
  assert.equal(shown.at(-1).limits, null);
});

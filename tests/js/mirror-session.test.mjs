// The pure session behind a card's terminal mirror: input verification and limits, snapshot tail.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers/load-src.mjs";
import { fakeTerm } from "./helpers/fake-term.mjs";

const { MirrorSession } = loadSrc("mirror-session");
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function make(extra = {}) {
  const clock = { t: 10000 };
  const writes = [], posted = [], verifies = [];
  const state = { front: true, ok: true, gate: null };
  const subscribers = new Set();
  const session = new MirrorSession({
    term: fakeTerm(), serialize: term => ({ text: term.screen }), subscribers,
    post: m => posted.push(m), connected: () => true, alive: () => true,
    front: () => state.front, writeInput: text => writes.push(text), fit: () => {}, onEnd: () => {},
    now: () => clock.t,
    verify: async () => { verifies.push(clock.t); if (state.gate) await state.gate; return state.ok; },
    ...extra,
  });
  return { session, clock, writes, posted, verifies, state, subscribers };
}
async function started(extra) {
  const m = make(extra);
  await new Promise(resolve => m.session.start(resolve));
  return m;
}

describe("input verification", () => {
  it("a fresh verification lets input through without verifying again", async () => {
    const m = await started();
    m.clock.t += 500;
    m.session.command({ type: "input", text: "a" });
    m.session.command({ type: "input", text: "b" });
    await tick();
    assert.deepEqual(m.writes, ["a", "b"]);
    assert.deepEqual(m.verifies, []);
  });

  it("stale input is queued, verified once, then written in order", async () => {
    const m = await started();
    m.clock.t += 1500;
    let release;
    m.state.gate = new Promise(resolve => { release = resolve; });
    m.session.command({ type: "input", text: "a" });
    m.session.command({ type: "input", text: "b" });
    await tick();
    assert.deepEqual(m.writes, []);
    assert.equal(m.verifies.length, 1);
    release();
    await tick();
    m.session.command({ type: "input", text: "c" });
    assert.deepEqual(m.writes, ["a", "b", "c"]);
    assert.equal(m.verifies.length, 1);
  });

  it("a failed verification writes nothing and ends the session with an exit message", async () => {
    let ended = 0;
    const m = await started({ onEnd: () => { ended++; } });
    m.clock.t += 1500;
    m.state.ok = false;
    m.session.command({ type: "input", text: "rm -rf" });
    await tick();
    assert.deepEqual(m.writes, []);
    assert.equal(ended, 1);
    assert.deepEqual(m.posted.at(-1), { type: "exit" });
    m.session.command({ type: "input", text: "more" });
    await tick();
    assert.deepEqual(m.writes, []);
  });

  it("a throwing verification counts as a failure", async () => {
    const m = await started({ verify: async () => { throw new Error("gone"); } });
    m.clock.t += 1500;
    m.session.command({ type: "input", text: "x" });
    await tick();
    assert.deepEqual(m.writes, []);
    assert.deepEqual(m.posted.at(-1), { type: "exit" });
  });

  it("verifies at most once a second however many keys arrive", async () => {
    const m = await started();
    m.clock.t += 1500;
    for (let i = 0; i < 20; i++) m.session.command({ type: "input", text: "k" });
    await tick();
    for (let i = 0; i < 20; i++) { m.clock.t += 20; m.session.command({ type: "input", text: "k" }); }
    assert.equal(m.verifies.length, 1);
    assert.equal(m.writes.length, 40);
  });
});

describe("input limits", () => {
  it("one input message may carry up to 1 MiB; a larger one is dropped whole", async () => {
    const m = await started();
    assert.equal(loadSrc("mirror-session").MAX_INPUT, 1048576);
    m.session.command({ type: "input", text: "x".repeat(1048576) });
    m.session.command({ type: "input", text: "y".repeat(1048577) });
    assert.deepEqual(m.writes.map(w => w.length), [1048576]);
  });

  it("input needs Atlas in front when it is received", async () => {
    const m = await started();
    m.state.front = false;
    m.session.command({ type: "input", text: "a" });
    assert.deepEqual(m.writes, []);
  });
});

describe("queued input", () => {
  const stale = async extra => { const m = await started(extra); m.clock.t += 1500; return m; };
  const gated = m => { let release; m.state.gate = new Promise(resolve => { release = resolve; }); return release; };

  it("Atlas leaving the front while the check runs drops the queue", async () => {
    const m = await stale();
    const release = gated(m);
    m.session.command({ type: "input", text: "a" });
    m.state.front = false;
    release();
    await tick();
    assert.deepEqual(m.writes, []);
    assert.equal(m.session.ended, false);
    m.state.front = true;
    m.session.command({ type: "input", text: "b" });      // later input is checked again and goes through
    await tick();
    assert.deepEqual(m.writes, ["b"]);
  });

  it("a check that does not answer within the deadline drops the queue and ends the mirror; a late answer is ignored", async () => {
    let ended = 0;
    const m = await stale({ verifyTimeoutMs: 20, onEnd: () => { ended++; } });
    const release = gated(m);
    m.session.command({ type: "input", text: "a" });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(m.posted.at(-1), { type: "exit" });
    assert.equal(ended, 1);
    release();
    await tick();
    assert.deepEqual(m.writes, []);
    assert.equal(ended, 1);
  });

  it("a deadline timer does not fire after an answer", async () => {
    const m = await stale({ verifyTimeoutMs: 30 });
    m.session.command({ type: "input", text: "a" });
    await tick();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(m.writes, ["a"]);
    assert.equal(m.session.ended, false);
    assert.notDeepEqual(m.posted.at(-1), { type: "exit" });
  });

  it("the queue holds at most 1 MiB; beyond that new input is dropped", async () => {
    const m = await stale();
    const release = gated(m);
    m.session.command({ type: "input", text: "a".repeat(1048576) });
    m.session.command({ type: "input", text: "b" });
    release();
    await tick();
    assert.deepEqual(m.writes.map(w => w.length), [1048576]);
  });

  it("the pending flag is set while input is queued and cleared when it is written, dropped or ended", async () => {
    const calls = [];
    const m = await stale({ pending: on => calls.push(on) });
    let release = gated(m);
    m.session.command({ type: "input", text: "a" });
    m.session.command({ type: "input", text: "b" });
    assert.deepEqual(calls, [true]);
    release();
    await tick();
    assert.deepEqual(calls, [true, false]);
    m.clock.t += 1500;
    m.state.ok = false;
    m.session.command({ type: "input", text: "c" });
    await tick();
    assert.deepEqual(calls, [true, false, true, false]);
  });

  it("ending while input is queued clears the pending flag", async () => {
    const calls = [];
    const m = await stale({ pending: on => calls.push(on) });
    gated(m);
    m.session.command({ type: "input", text: "a" });
    m.session.command({ type: "close" });
    assert.deepEqual(calls, [true, false]);
  });
});

describe("snapshot tail", () => {
  it("an escape sequence the snapshot cannot hold goes first in the live stream", async () => {
    const m = make({ serialize: () => ({ text: "A" }), tail: () => "\x1b[3" });
    const done = new Promise(resolve => m.session.start(resolve));
    m.session.accept({ type: "data", text: "1mB" });   // buffered before the snapshot
    await done;
    const stream = m.posted.map(x => x.text).join("");
    assert.equal(stream, "A\x1b[31mB");
    assert.equal(m.posted[0].type, "start");
  });
  it("no tail, no extra message", async () => {
    const m = await started({ tail: () => "" });
    assert.deepEqual(m.posted.map(x => x.type), ["start"]);
  });
});

describe("snapshot failure", () => {
  it("a throwing serialize ends the session, unsubscribes and reports not ready", async () => {
    let ended = 0;
    const m = make({ serialize: () => { throw new Error("boom"); }, onEnd: () => { ended++; } });
    const ready = await new Promise(resolve => m.session.start(resolve));
    assert.equal(ready, false);
    assert.equal(ended, 1);
    assert.equal(m.subscribers.size, 0);
    assert.deepEqual(m.posted, []);
  });
});

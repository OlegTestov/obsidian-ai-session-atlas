// Several questions at once (obsidian-plugin/src/multi-parse.js, multi-answer.js): screens recorded on
// Claude Code 2.1.319 (tools/live/capture_multi.mjs → tools/fixtures/claude-multi-question.json), the
// questions from the transcript, and answers given key by key against a stand-in of the tab.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { FIXTURES, loadSrc } from "./helpers/load-src.mjs";

const realLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === "obsidian" ? { Notice: class {}, Modal: class {}, View: class {}, addIcon: () => {} } : realLoad(request, parent, isMain);
globalThis.window = globalThis.window || {};
globalThis.window.setTimeout = globalThis.window.setTimeout || setTimeout;

const parse = loadSrc("multi-parse");
const { MultiQuestionMethods, checkAnswers } = loadSrc("multi-answer");
const { parseDialog } = loadSrc("dialog");
const SCREENS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "claude-multi-question.json"), "utf8"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-multi-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SID = "11111111-2222-4333-8444-555555555555";
const QUESTIONS = [
  { question: "Which colour should the badge be?", header: "Colour", multiSelect: false, options: [
    { label: "Red", description: "Warm and loud" }, { label: "Green", description: "Calm" }, { label: "Blue", description: "Neutral" }] },
  { question: "Which fruits go in the basket?", header: "Fruits", multiSelect: true, options: [
    { label: "Apple", description: "Crunchy" }, { label: "Pear", description: "Soft" }, { label: "Plum", description: "Sour" }] },
  { question: "Who reviews it?", header: "Reviewer", multiSelect: false, options: [
    { label: "Alice", description: "Owns the module" }, { label: "Bob", description: "Knows the UI" }] }];
const ask = (id, questions = QUESTIONS) => JSON.stringify({ type: "assistant", message: { content: [
  { type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] } });
const result = (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x" }] } });

describe("the screen of several questions", () => {
  it("the first question: four tabs, nothing answered, its options", () => {
    const s = parse.parseMultiScreen(SCREENS.start);
    assert.deepEqual(s.tabs, [{ name: "Colour", done: false }, { name: "Fruits", done: false }, { name: "Reviewer", done: false }]);
    assert.equal(s.review, null);
    assert.equal(s.question, "Which colour should the badge be?");
    assert.deepEqual(s.options.map((o) => [o.n, o.text, o.selected]),
      [[1, "Red", true], [2, "Green", false], [3, "Blue", false], [4, "Type something.", false], [5, "Chat about this", false]]);
  });
  it("checkboxes: which are ticked, and the answered tab", () => {
    const s = parse.parseMultiScreen(SCREENS.fruits_apple_plum);
    assert.deepEqual(s.tabs.map((t) => t.done), [true, true, false]);
    assert.equal(s.question, "Which fruits go in the basket?");
    assert.deepEqual(s.options.filter((o) => o.checked).map((o) => o.text), ["Apple", "Plum"]);
  });
  it("a typed answer replaces the label in its line", () => {
    const s = parse.parseMultiScreen(SCREENS.reviewer_typed);
    assert.deepEqual(s.options.find((o) => o.n === 3), { n: 3, text: "Carol", more: [], checked: false, selected: true });
  });
  it("the Submit tab: the answers listed, and its Submit option", () => {
    const s = parse.parseMultiScreen(SCREENS.review_typed);
    assert.deepEqual(s.review.map((r) => r.answer), ["Red", "Pear, Apple", "Carol"]);
    assert.deepEqual(s.options, [{ n: 1, text: "Submit answers", more: [], checked: false, selected: true }]);
  });
  it("after sending: no dialog; parseDialog sees the question screens as several questions", () => {
    assert.equal(parse.parseMultiScreen(SCREENS.submitted), null);
    assert.equal(parseDialog(SCREENS.start).reason, "dialog.multi");
    assert.equal(parseDialog(SCREENS.fruits_fresh).reason, "dialog.multi");
  });
});

describe("the questions from the transcript", () => {
  it("the last question call without an answer", () => {
    const text = [ask("toolu_a"), result("toolu_a"), ask("toolu_b"), "{cut"].join("\n");
    assert.equal(parse.pendingQuestions(text).id, "toolu_b");
    assert.equal(parse.pendingQuestions([ask("toolu_b"), result("toolu_b")].join("\n")), null);
  });
  it("read from the session's own file in any project folder", () => {
    const dir = path.join(TMP, "-some-project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), ask("toolu_c") + "\n");
    assert.equal(parse.readPending(SID, TMP).questions.length, 3);
    assert.equal(parse.readPending("not-a-session", TMP), null);
  });
  it("matched with the screen: the card's dialog; only a fresh one is answerable", () => {
    const pending = { id: "toolu_c", questions: QUESTIONS };
    const d = parse.multiDialog(pending, parse.parseMultiScreen(SCREENS.start));
    assert.equal(d.kind, "multi");
    assert.equal(d.title, "Colour · Fruits · Reviewer");
    assert.deepEqual(d.questions.map((q) => [q.multi, q.typed]), [[false, 4], [true, null], [false, 3]]);
    assert.equal(d.answerable, true);
    const half = parse.multiDialog(pending, parse.parseMultiScreen(SCREENS.fruits_fresh));
    assert.equal(half.answerable, false);
    assert.equal(half.reason, "dialog.multiStarted");
    assert.equal(parse.multiDialog({ id: "x", questions: QUESTIONS.slice(0, 2) }, parse.parseMultiScreen(SCREENS.start)), null,
      "other questions than the screen's tabs");
    const previews = QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o, preview: "p" })) }));
    const withPreviews = parse.multiDialog({ id: "p", questions: previews }, parse.parseMultiScreen(SCREENS.start));
    assert.deepEqual([withPreviews.answerable, withPreviews.reason], [false, "dialog.multiPreview"]);
    const renamed = QUESTIONS.map((q, i) => (i === 1 ? { ...q, header: "Veg" } : q));
    assert.equal(parse.multiDialog({ id: "r", questions: renamed }, parse.parseMultiScreen(SCREENS.start)), null,
      "the same number of tabs, another name");
  });
});

// A stand-in of Claude Code's tab: the same key protocol and drawing as the recorded screens.
function standIn(questions, quirks = {}) {
  const st = { tab: 0, answers: questions.map(() => null), checks: questions.map(() => new Set()), typing: null,
               typed: "", submitted: false, keys: [] };
  const typedN = (q) => q.options.length + 1;
  const rows = () => {
    const out = screen();
    // Someone answers the second question in the tab right after the plugin has seen it.
    if (quirks.intrude && st.tab === 1 && !st.intruded) {
      st.intruded = true;
      st.answers[1] = questions[1].options[questions[1].options.length - 1].label;
      st.tab = questions.length;
    }
    return out;
  };
  const screen = () => {
    if (st.submitted) return ["⏺ User answered Claude's questions:", "❯ "];
    const tabs = "←  " + questions.map((q, i) => `${st.answers[i] !== null || st.checks[i].size ? "☒" : "☐"} ${q.header}`).join("  ")
      + "  ✔ Submit  →";
    if (st.tab >= questions.length) {
      const out = ["─".repeat(40), tabs, "", "Review your answers", ""];
      questions.forEach((q, i) => out.push(` ● ${q.question}`, `   → ${quirks.review ? "Something else" : st.answers[i] ?? [...st.checks[i]].map((n) => q.options[n - 1].label).join(", ")}`));
      return out.concat(["", "Ready to submit your answers?", "", "❯ 1. Submit answers", "  2. Cancel"]);
    }
    const q = questions[st.tab];
    const out = ["─".repeat(40), tabs, "", q.question, ""];
    q.options.forEach((o, i) => {
      const n = i + 1;
      const box = q.multiSelect ? `[${st.checks[st.tab].has(n) ? "✔" : " "}] ` : "";
      out.push(`${st.typing === null && n === 1 ? "❯" : " "} ${n}. ${box}${o.label}`, `     ${o.description}`);
    });
    if (!q.multiSelect) {
      const text = st.typing !== null && st.typed ? st.typed : "Type something.";
      const rowsOf = quirks.wrap ? text.match(/.{1,30}/g) : [text];      // a long text wraps under its line
      out.push(`${st.typing !== null ? "❯" : " "} ${typedN(q)}. ${rowsOf[0]}`, ...rowsOf.slice(1).map((r) => `     ${r}`));
    }
    return out.concat(["─".repeat(40), `  ${typedN(q) + 1}. Chat about this`, "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"]);
  };
  let moving = false;
  const moveOn = () => {
    if (!quirks.slow) { st.tab++; return; }
    moving = true;
    setTimeout(() => { st.tab++; moving = false; }, 250);
  };
  const write = (key) => {
    st.keys.push(key);
    if (st.submitted || moving) return;
    if (st.tab >= questions.length) { if (key === "1") st.submitted = true; return; }
    const q = questions[st.tab];
    if (st.typing !== null) {
      if (key === "\r") { st.answers[st.tab] = st.typed; st.typing = null; st.typed = ""; moveOn(); }
      else st.typed += quirks.dropTyped ? "" : key;
      return;
    }
    if (/^\d$/.test(key)) {
      const n = Number(key);
      if (q.multiSelect) { if (n <= q.options.length && !quirks.noToggle) { const c = st.checks[st.tab]; if (c.has(n)) c.delete(n); else c.add(n); } return; }
      if (n === typedN(q)) { st.typing = st.tab; return; }
      if (n <= q.options.length) { st.answers[st.tab] = q.options[n - 1].label; moveOn(); }
      return;
    }
    if (key === "\x1b[C" && q.multiSelect) moveOn();
  };
  return { st, rows, write };
}

function plugin(tui, pending = { id: "toolu_m", questions: QUESTIONS }, sessionFile = true) {
  const dir = path.join(TMP, "-p");
  fs.mkdirSync(dir, { recursive: true });
  if (sessionFile) fs.writeFileSync(path.join(dir, `${SID}.jsonl`), ask(pending.id, pending.questions) + "\n");
  const p = Object.create(MultiQuestionMethods.prototype);
  p.transcriptsRoot = TMP;
  const sent = [];
  p.t = (k) => k;
  p.answerPage = (target, m) => sent.push(m);
  p.checkTarget = async () => ({ tab: { leaf: {} }, state: { status: "waiting", agent: "claude" } });
  p.screenLines = () => tui.rows();
  p.ptyInput = async () => ({ write: tui.write });
  return { p, sent };
}

describe("answering from the card", () => {
  const answers = [{ options: [2] }, { options: [3, 1] }, { typed: "Carol" }];

  it("key by key, each checked on screen, then the Submit tab's 1", async () => {
    const tui = standIn(QUESTIONS);
    const { p, sent } = plugin(tui);
    await p.answerMulti({}, { sessionId: SID, nonce: "n1", id: "toolu_m", answers });
    assert.deepEqual(sent, [{ type: "answered", ok: true, reason: null, sessionId: SID, nonce: "n1" }]);
    assert.deepEqual(tui.st.keys, ["2", "1", "3", "\x1b[C", "3", "Carol", "\r", "1"]);
    assert.equal(tui.st.submitted, true);
  });
  it("a tab that takes a while to move on: the next key waits for the next question", async () => {
    const tui = standIn(QUESTIONS, { slow: true });
    const { p, sent } = plugin(tui);
    await p.answerMulti({}, { sessionId: SID, nonce: "n6", id: "toolu_m", answers });
    assert.equal(sent[0].ok, true);
    assert.equal(tui.st.submitted, true);
  });
  it("a long typed text that wraps under its line still matches", async () => {
    const tui = standIn(QUESTIONS, { wrap: true });
    const { p, sent } = plugin(tui);
    const long = "Carol, and Dave when Carol is away for longer than a week";
    await p.answerMulti({}, { sessionId: SID, nonce: "n7", id: "toolu_m", answers: [answers[0], answers[1], { typed: long }] });
    assert.equal(sent[0].ok, true);
    assert.equal(tui.st.answers[2], long);
  });
  it("a question answered in the tab meanwhile: stopped, the Submit tab's 1 is not pressed", async () => {
    const two = [QUESTIONS[0], QUESTIONS[2]];
    const tui = standIn(two, { intrude: true });
    const { p, sent } = plugin(tui, { id: "toolu_m", questions: two });
    await p.answerMulti({}, { sessionId: SID, nonce: "n8", id: "toolu_m", answers: [{ options: [2] }, { options: [1] }] });
    assert.equal(sent[0].reason, "input.multiStopped");
    assert.deepEqual(tui.st.keys, ["2"]);
    assert.equal(tui.st.submitted, false);
  });
  it("a second run for the same session while one types: refused, the first goes on", async () => {
    const tui = standIn(QUESTIONS, { slow: true });
    const { p, sent } = plugin(tui);
    const first = p.answerMulti({}, { sessionId: SID, nonce: "a", id: "toolu_m", answers });
    await new Promise((r) => setTimeout(r, 50));
    await p.answerMulti({}, { sessionId: SID, nonce: "b", id: "toolu_m", answers });
    await first;
    assert.deepEqual(sent.map((m) => [m.nonce, m.ok, m.reason]), [["b", false, "input.multiBusy"], ["a", true, null]]);
    assert.equal(tui.st.submitted, true);
  });
  it("a tab that breaks mid-way: a reply that says so, and the next run may start", async () => {
    const tui = standIn(QUESTIONS);
    const { p, sent } = plugin(tui);
    let reads = 0;
    const rows = p.screenLines;
    p.screenLines = (leaf) => { if (++reads > 3) throw new Error("tab closed"); return rows(leaf); };
    await p.answerMulti({}, { sessionId: SID, nonce: "n9", id: "toolu_m", answers });
    assert.equal(sent[0].reason, "input.multiStopped");
    assert.equal(p.multiRunning.size, 0);
  });
  it("a typed text that does not show in its line: stopped before Enter, nothing sent", async () => {
    const tui = standIn(QUESTIONS, { dropTyped: true });
    const { p, sent } = plugin(tui);
    await p.answerMulti({}, { sessionId: SID, nonce: "n2", id: "toolu_m", answers });
    assert.equal(sent[0].ok, false);
    assert.equal(sent[0].reason, "input.multiStopped");
    assert.ok(!tui.st.keys.includes("\r"));
    assert.equal(tui.st.submitted, false);
  });
  it("a checkbox that does not tick: stopped, the tab is not left", async () => {
    const tui = standIn(QUESTIONS, { noToggle: true });
    const { p, sent } = plugin(tui);
    await p.answerMulti({}, { sessionId: SID, nonce: "n3", id: "toolu_m", answers });
    assert.equal(sent[0].reason, "input.multiStopped");
    assert.ok(!tui.st.keys.includes("\x1b[C"));
  });
  it("the Submit tab lists other answers: not sent", async () => {
    const tui = standIn(QUESTIONS, { review: true });
    const { p, sent } = plugin(tui);
    await p.answerMulti({}, { sessionId: SID, nonce: "n4", id: "toolu_m", answers });
    assert.equal(sent[0].reason, "input.multiMismatch");
    assert.equal(tui.st.submitted, false);
  });
  it("another question call, a half-answered dialog or malformed answers: no key at all", async () => {
    for (const [tui, data] of [
      [standIn(QUESTIONS), { id: "toolu_other", answers }],
      [(() => { const t = standIn(QUESTIONS); t.write("1"); t.st.keys = []; return t; })(), { id: "toolu_m", answers }],
      [standIn(QUESTIONS), { id: "toolu_m", answers: answers.slice(0, 2) }],
      [standIn(QUESTIONS), { id: "toolu_m", answers: [{ options: [1, 2] }, answers[1], answers[2]] }],
      [standIn(QUESTIONS), { id: "toolu_m", answers: [answers[0], { typed: "x" }, answers[2]] }],
    ]) {
      const { p, sent } = plugin(tui);
      await p.answerMulti({}, { sessionId: SID, nonce: "n5", ...data });
      assert.equal(sent[0].ok, false);
      assert.deepEqual(tui.st.keys, []);
    }
  });
  it("the answers as the page sends them are checked against the questions", () => {
    const qs = parse.multiDialog({ id: "t", questions: QUESTIONS }, parse.parseMultiScreen(SCREENS.start)).questions;
    assert.deepEqual(checkAnswers(qs, [{ options: [2] }, { options: [3, 1, 3] }, { typed: "  Carol  " }]),
      [{ options: [2] }, { options: [1, 3] }, { typed: "Carol" }]);
    assert.equal(checkAnswers(qs, [{ options: [4] }, { options: [1] }, { options: [1] }]), null);
    assert.equal(checkAnswers(qs, [{ options: [] }, { options: [1] }, { options: [1] }]), null);
    assert.equal(parse.expectedAnswer(qs[1], { options: [1, 3] }), "Apple, Plum");
  });
});

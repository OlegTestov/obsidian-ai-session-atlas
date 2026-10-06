// Codex cards on the Active page: which Claude-only controls they lose, and the Codex limits line.
//   node --test tests/js/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadPage, pageOrder, readScript } from "./helpers/page.mjs";

const upTo = (name) => pageOrder().slice(0, pageOrder().indexOf(name) + 1);

describe("Codex cards", () => {
  const p = loadPage(upTo("agent-filter.js"));

  test("slash-command hints and the plan dialog are Claude Code's only", () => {
    assert.deepEqual({ ...p.agentControls({ agent: "codex" }) }, { commands: false, plan: false });
    assert.deepEqual({ ...p.agentControls({ agent: "claude" }) }, { commands: true, plan: true });
    assert.deepEqual({ ...p.agentControls({}) }, { commands: true, plan: true });  // older rows
  });

  test("the reply author is Codex", () => {
    p.I18N.setLang("en");
    assert.equal(p.agentShort({ agent: "codex" }), "Codex");
  });

  test("the card wires the controls through agentControls", () => {
    const cards = readScript("active-cards.js");
    assert.match(cards, /enhanceComposer\(area, sid, submit, controls\)/);
    assert.match(cards, /controls\.commands && argChoices\(text\)/);
    assert.match(readScript("active-dialog.js"), /d\.kind === "plan" && agentControls\(s\)\.plan/);
    assert.match(readScript("active-compose.js"), /if \(!hints\) return;/);
  });
});

describe("Codex tab screen: waiting for you", () => {
  const p = loadPage(upTo("agent-filter.js"));
  const codex = { session_id: "c", agent: "codex", status: "busy", activity: "busy", waiting_for: null };

  test("a waiting screen makes a Codex card wait, like a Claude dialog", () => {
    const s = p.withTabScreen(codex, "waiting");
    assert.equal(s.status, "waiting");
    assert.equal(s.activity, "waiting");
    assert.equal(s.waiting_for, "permission prompt");
    assert.equal(codex.status, "busy", "the server row is not changed");
  });
  test("other screens, no screen and Claude sessions keep the server's state", () => {
    assert.equal(p.withTabScreen(codex, "idle"), codex);
    assert.equal(p.withTabScreen(codex, null), codex);
    const claude = { session_id: "a", agent: "claude", status: "busy" };
    assert.equal(p.withTabScreen(claude, "waiting"), claude);
  });

  test("the whole page: the tab's screen reaches the card and the dialog is read only then", () => {
    const page = loadPage();
    const run = (code) => vm.runInContext(code, page);
    run(`var sent = []; tellTabHost = (type, body) => sent.push([type, body.sessionId]);
         activeRaw = [{ session_id: "c", agent: "codex", status: "busy", activity: "busy", pid: 9, ancestors: [7] },
                      { session_id: "a", agent: "claude", status: "busy", activity: "busy", pid: 8, ancestors: [6] }];
         hostTabs = new Map([[7, "codex"], [6, "claude"]]);
         hostScreens = new Map([[7, "busy"]]);
         activeSessions = screenSessions(); requestDialogs();`);
    assert.equal(run("sent.length"), 0, "a working Codex tab is not asked for a dialog");
    run(`hostScreens = new Map([[7, "waiting"]]); activeSessions = screenSessions(); requestDialogs();`);
    assert.equal(run("JSON.stringify(sent)"), '[["read-dialog","c"]]');
    assert.equal(run("activeSessions.find(s => s.session_id === 'c').activity"), "waiting");
    assert.equal(run("activeSessions.find(s => s.session_id === 'a').activity"), "busy");
  });

  test("edit and choice dialogs from the Codex parser render in the card", () => {
    const page = loadPage();
    const run = (code) => vm.runInContext(code, page);
    run(`hostReady = true;
         var waitingCodex = { session_id: "c", agent: "codex", status: "waiting", activity: "waiting", pid: 9 };`);
    const shapes = {
      edit: { kind: "edit", title: "Would you like to make the following edits?", details: ["src/app.py (+2 -1)"],
              question: null, options: [{ n: 1, text: "Yes, proceed", detail: "", selected: true },
                                        { n: 2, text: "No, and tell Codex what to do differently", detail: "" }],
              answerable: true, reason: null, feedback: { n: 2, label: "No", selected: false, typed: "" } },
      choice: { kind: "choice", title: "Pick a plan", question: "Which one?",
                options: [{ n: 1, text: "Fast" }, { n: 2, text: "Safe" }], answerable: true, reason: null, feedback: null },
      unreadable: { kind: "question", title: "Several questions", answerable: false, reason: "only in the tab" },
    };
    for (const [name, dialog] of Object.entries(shapes)) {
      run(`dialogs.set("c", { dialog: ${JSON.stringify(dialog)}, reason: null });`);
      assert.ok(run("dialogBlock(waitingCodex, 7, true)"), name);
      assert.ok(run("dialogBlock(waitingCodex, 7, false)"), name);
    }
  });
});

describe("Codex limits and cost texts", () => {
  const p = loadPage(pageOrder().filter((f) => f === "i18n.js" || f === "logic.js" || f.startsWith("lang-")));
  const codex = { age_seconds: 60, windows: [
    { key: "five_hour", label: "5 hours", used_percentage: 98.4, resets_at: "x" },
    { key: "seven_day", label: "week", used_percentage: 31, resets_at: "y" }] };

  test("the server's codex_limits read like Claude's limits", () => {
    const t = p.AtlasLogic.limitsText(codex, (v) => (v === "x" ? "21:40" : "10.10"));
    assert.equal(t.tone, "warn");
    assert.match(t.text, /5 hours 98% until 21:40 · week 31% until 10\.10/);
  });

  test("strings in both languages", () => {
    for (const lang of ["en", "ru"]) {
      p.I18N.setLang(lang);
      assert.equal(p.I18N.i18n("active.limitsCodex", { limits: "5h 98%" }), "Codex 5h 98%");
      assert.match(p.I18N.i18n("active.costCodex", { cost: "1.20" }), /Codex.*\$1\.20/);
      assert.match(p.I18N.i18n("active.costCodexNone"), /Codex/);
      assert.match(p.I18N.i18n("active.limitsCodexLive", { limits: "z", time: "16:07" }), /Codex.*z.*\/status.*16:07/);
      assert.match(p.I18N.i18n("active.limitsCodexRun", { limits: "z", time: "13:06" }), /Codex.*z.*13:06/);
      assert.match(p.I18N.i18n("active.limitReached", { label: "5h", until: " x" }), /^5h 100%, \S+.* x$/);
    }
  });
});

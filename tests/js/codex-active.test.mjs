// Codex cards on the Active page: which Claude-only controls they lose, and the Codex limits line.
//   node --test tests/js/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadPage, pageOrder, readScript } from "./helpers/page.mjs";

const upTo = (name) => pageOrder().slice(0, pageOrder().indexOf(name) + 1);

describe("pending Codex cards", () => {
  const started = "2026-09-01T10:00:00+00:00";
  const pending = { agent: "codex", session_id: "pending-example", pending: true, pid: 101, ancestors: [7],
    process_started_at: started, started_at: started, status: "idle", cwd: "/tmp/project with spaces" };

  for (const [locale, title, waiting, go, close, terminal] of [
    ["en", "New Codex session", "waiting for the first message", "Go", "Close", "Terminal"],
    ["ru", "Новая сессия Codex", "ждёт первого сообщения", "Перейти", "Закрыть", "Терминал"],
  ]) {
    test(`the ${locale} pending card renders process details and tab actions only`, () => {
      const page = loadPage();
      page.I18N.setLang(locale);
      page.document.createElement = tag => ({
        tag, children: [], dataset: {}, attrs: {},
        classList: { add() {} },
        append(...nodes) { this.children.push(...nodes); },
        prepend(...nodes) { this.children.unshift(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        replaceChildren(...nodes) { this.children = nodes; },
        setAttribute(key, value) { this.attrs[key] = value; },
        addEventListener() {},
      });
      const run = code => vm.runInContext(code, page);
      run(`var pending = ${JSON.stringify(pending)}; svgIcon = () => "";
           answerForm = () => el("textarea", "answer"); hostTabs = new Map([[7, "Codex"]]);`);
      const nodes = node => typeof node === "object" ? [node, ...node.children.flatMap(nodes)] : [];
      const compact = nodes(run("activeCard(pending)"));
      assert.equal(compact.find(n => n.className === "t").textContent, title);
      const meta = compact.find(n => n.className?.startsWith("info"));
      assert.equal(meta.children[0].className, "state");
      assert.ok(meta.children[0].children.includes(waiting));
      assert.equal(compact.find(n => n.className === "d").textContent, pending.cwd);
      assert.match(meta.textContent, /\d/);
      assert.deepEqual(compact.filter(n => n.tag === "button").map(n => n.textContent), [go, close]);
      const full = nodes(run('activeMode = "full"; hostInlineTabs.add(7); activeCard(pending)'));
      assert.deepEqual(full.filter(n => n.tag === "button").map(n => n.attrs["aria-label"] || n.textContent),
                       [terminal, go, close]);
      assert.equal(full.filter(n => n.tag === "textarea").length, 1);
      assert.equal(run('hostTabs.clear(); activeCard(pending)').children.flatMap(nodes)
        .filter(n => n.tag === "button" || n.tag === "textarea").length, 0);
    });
  }

  test("the first rollout inherits the frozen slot and section of its exact process", () => {
    const page = loadPage();
    const run = code => vm.runInContext(code, page);
    run(`var pending = ${JSON.stringify(pending)};
         var a = { session_id: "a", status: "idle" }, b = { session_id: "b", status: "idle" };
         var real = { ...pending, pending: false, session_id: "real", status: "busy" };
         frozenOrder = ["a", pending.session_id, "b"];
         selectedCard = pending.session_id;
         cardViews.set(pending.session_id, "terminal");
         replacePendingSlots([a, pending, b], [b, a, real]);`);
    assert.deepEqual(Array.from(run("AtlasLogic.applyFrozenOrder([b, a, real], frozenOrder).frozen")), ["a", "real", "b"]);
    assert.equal(run("sectionActivity(real)"), "idle");
    assert.equal(run("selectedCard"), "real");
    assert.equal(run("cardViewMode('real')"), "terminal");
    assert.equal(run("cardViewMode(pending.session_id)"), "turns");
    assert.equal(run("sectionActivity({ ...real, status: 'waiting' })"), "waiting");
    run(`drafts.set(pending.session_id, "half-typed"); attachments.set(pending.session_id, [{ path: "/a.png" }]);
         sendState.set(pending.session_id, { note: "x" }); var real2 = { ...real, session_id: "real2" };
         replacePendingSlots([pending], [real2]);`);
    assert.equal(run("drafts.get('real2')"), "half-typed");
    assert.equal(run("attachments.get('real2').length"), 1);
    assert.equal(run("sendState.get('real2').note"), "x");
    assert.equal(run("drafts.has(pending.session_id) || attachments.has(pending.session_id) || sendState.has(pending.session_id)"), false);
    assert.equal(run(`frozenOrder = [pending.session_id];
       replacePendingSlots([pending], [{ ...real, process_started_at: "different" }]); frozenOrder[0]`),
       pending.session_id);
  });

  test("pending waits for its first message even if the tab screen has a prompt or queue", () => {
    const page = loadPage(upTo("agent-filter.js"));
    assert.equal(page.withTabScreen(pending, { state: "waiting", queued: ["x"] }), pending);
    assert.equal(page.agentControls(pending).commands, false);
  });
});

describe("Codex cards", () => {
  const p = loadPage(upTo("agent-filter.js"));

  test("each agent gets its own slash commands; the plan dialog is Claude Code's only", () => {
    assert.deepEqual({ ...p.agentControls({ agent: "codex" }) }, { commands: true, plan: false, agent: "codex" });
    assert.deepEqual({ ...p.agentControls({ agent: "claude" }) }, { commands: true, plan: true, agent: "claude" });
    assert.deepEqual({ ...p.agentControls({}) }, { commands: true, plan: true, agent: "claude" });  // older rows
  });

  test("the reply author is Codex", () => {
    p.I18N.setLang("en");
    assert.equal(p.agentShort({ agent: "codex" }), "Codex");
  });

  test("the card wires the controls through agentControls", () => {
    const cards = readScript("active-cards.js");
    assert.match(cards, /enhanceComposer\(area, sid, submit, controls\)/);
    assert.match(cards, /controls\.commands && argChoices\(text, controls\.agent\)/);
    assert.match(cards, /argChooser\(area, submit, controls\.agent\)/);
    assert.match(readScript("active-dialog.js"), /d\.kind === "plan" && agentControls\(s\)\.plan/);
    assert.match(readScript("active-compose.js"), /if \(!hints\) return;/);
  });
});

describe("Codex pickers on the card", () => {
  const order = pageOrder();
  const last = order[Math.max(order.indexOf("active-commands.js"), order.indexOf("active-compose.js"))];
  const p = loadPage(upTo(last));
  p.I18N.setLang("en");
  const models = [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "high"] },
                  { slug: "gpt-6-luna", name: "GPT-6-Luna", efforts: [] }];
  vm.runInContext("commandLists.codex = { commands: [], models: " + JSON.stringify(models) + " };", p);
  const texts = (pick) => Array.from(pick.items, (i) => i.text);        // an array of this realm

  test("/model lists Codex's models; a model with efforts leads to them", () => {
    const pick = p.argChoices("/model", "codex");
    assert.deepEqual(texts(pick), ["/model gpt-6.1-sol", "/model gpt-6-luna"]);
    assert.deepEqual(Array.from(pick.items, (i) => i.next), [true, false]);
    assert.ok(!pick.optional, "bare /model would open the tab's own list: the card picks instead");
  });
  test("/model <slug> offers that model's efforts as --reasoning, and may be sent as is", () => {
    const pick = p.argChoices("/model gpt-6.1-sol", "codex");
    assert.deepEqual(texts(pick), ["/model gpt-6.1-sol --reasoning=low", "/model gpt-6.1-sol --reasoning=high"]);
    assert.equal(pick.optional, true);
    assert.equal(p.argChoices("/model gpt-6-luna", "codex"), null);
    assert.equal(p.argChoices("/model unknown", "codex"), null);
  });
  test("Claude Code's /effort is not a Codex command; Claude keeps its own pickers", () => {
    assert.equal(p.argChoices("/effort", "codex"), null);
    assert.deepEqual(texts(p.argChoices("/effort", "claude")).slice(0, 2), ["/effort low", "/effort medium"]);
    assert.ok(texts(p.argChoices("/model", "claude")).includes("/model opus"));
  });
  test("no models in Codex's cache: no picker, /model goes to the tab", () => {
    vm.runInContext("commandLists.codex = { commands: [], models: [] };", p);
    assert.equal(p.argChoices("/model", "codex"), null);
  });
});

describe("Codex tab screen: waiting for you", () => {
  const p = loadPage(upTo("agent-filter.js"));
  const codex = { session_id: "c", agent: "codex", status: "busy", activity: "busy", waiting_for: null };

  test("a waiting screen makes a Codex card wait, like a Claude dialog", () => {
    const s = p.withTabScreen(codex, { state: "waiting", queued: [] });
    assert.equal(s.status, "waiting");
    assert.equal(s.activity, "waiting");
    assert.equal(s.waiting_for, "permission prompt");
    assert.equal(codex.status, "busy", "the server row is not changed");
  });
  test("other screens, no screen and Claude sessions keep the server's state", () => {
    assert.equal(p.withTabScreen(codex, { state: "idle", queued: [] }), codex);
    assert.equal(p.withTabScreen(codex, null), codex);
    const claude = { session_id: "a", agent: "claude", status: "busy" };
    assert.equal(p.withTabScreen(claude, { state: "waiting", queued: ["x"] }), claude);
  });
  test("messages queued in the terminal UI show as the card's queue; the server's queue wins", () => {
    const s = p.withTabScreen(codex, { state: "busy", queued: ["also check b.md", "then run the tests"] });
    assert.deepEqual(Array.from(s.queued, (q) => q.text), ["also check b.md", "then run the tests"]);
    assert.equal(s.status, "busy");
    const served = Object.assign({}, codex, { queued: [{ text: "from the app", at: null }] });
    assert.equal(p.withTabScreen(served, { state: "busy", queued: ["typed"] }), served);
  });

  test("the plugin's tab list: each Codex tab's screen state and queued messages", () => {
    const page = loadPage();
    const screens = vm.runInContext(`tabScreens([
      { ptyPid: 7, agent: "codex", screen: "busy", queued: ["also check b.md", 3, "then run the tests"] },
      { ptyPid: 8, agent: "codex", screen: 5 },
      { ptyPid: 6, title: "claude", screen: "waiting", queued: ["x"] }, null])`, page);
    assert.deepEqual([...screens.keys()], [7, 8]);
    assert.deepEqual(JSON.parse(JSON.stringify(screens.get(7))),
                     { state: "busy", queued: ["also check b.md", "then run the tests"] });
    assert.deepEqual(JSON.parse(JSON.stringify(screens.get(8))), { state: null, queued: [] });
  });

  test("the whole page: the tab's screen reaches the card and the dialog is read only then", () => {
    const page = loadPage();
    const run = (code) => vm.runInContext(code, page);
    run(`var sent = []; tellTabHost = (type, body) => sent.push([type, body.sessionId]);
         activeRaw = [{ session_id: "c", agent: "codex", status: "busy", activity: "busy", pid: 9, ancestors: [7] },
                      { session_id: "a", agent: "claude", status: "busy", activity: "busy", pid: 8, ancestors: [6] }];
         hostTabs = new Map([[7, "codex"], [6, "claude"]]);
         hostScreens = new Map([[7, { state: "busy", queued: [] }]]);
         activeSessions = screenSessions(); requestDialogs();`);
    assert.equal(run("sent.length"), 0, "a working Codex tab is not asked for a dialog");
    run(`hostScreens = new Map([[7, { state: "waiting", queued: [] }]]); activeSessions = screenSessions(); requestDialogs();`);
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
    assert.match(t.text, /5 hours 98%, resets 21:40 · week 31%, resets 10\.10/);
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

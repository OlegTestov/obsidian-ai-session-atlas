// Pure page logic without a browser: Markdown parsing, the Active tab, Statistics, and the shared
// global scope of the classic page scripts.
//   node --test tests/js/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JS, WEB, compileScript, loadPage, pageOrder, readScript } from "./helpers/page.mjs";

// Only the scripts with pure logic, in index.html order; page strings come from the dictionaries.
const LOGIC = new Set(["i18n.js", "markdown.js", "logic.js", "stats-logic.js"]);
const page = loadPage(pageOrder().filter((f) => LOGIC.has(f) || f.startsWith("lang-")));
const I18N = page.I18N;
const L = page.AtlasLogic;
const SL = page.StatsLogic;
const md = { parseMarkdown: page.parseMarkdown, parseInline: page.parseInline, SAFE_URL: page.SAFE_URL };
// The checks below compare Russian text.
I18N.setLang("ru");

const json = (v) => JSON.stringify(v);
const types = (blocks) => blocks.map((b) => b.t);
const inlineTypes = (items) => items.map((i) => i.t);
const nb = (s) => s.replace(/\u00a0/g, " ");

describe("markdown", () => {
  const b = md.parseMarkdown("## Итог\n\nСделано **три** и *одна*; `код` и snake_case_name, 2 * 3 * 4.");
  test("heading and paragraph", () => assert.equal(json(types(b)), '["h","p"]'));
  test("## becomes h5 (card scale)", () => assert.equal(b[0].level, 5));
  test("bold, italic and inline code", () => {
    const kinds = inlineTypes(b[1].lines[0]);
    assert.ok(kinds.includes("strong") && kinds.includes("em") && kinds.includes("code"), json(kinds));
  });
  test("snake_case and 2 * 3 * 4 are not italic", () => {
    const text = json(b[1]);
    assert.ok(text.includes("snake_case_name") && text.includes("2 * 3 * 4"));
  });

  const inl = md.parseInline("[MR](https://x.y/1) и [клик](javascript:alert(1)) и https://example.com/a.");
  const links = inl.filter((i) => i.t === "link");
  test("links are parsed", () => assert.equal(links.length, 3, json(links.map((l) => l.href))));
  test("a period after a URL is not part of the link", () => assert.equal(links[2].href, "https://example.com/a"));
  test("javascript: fails the safety check", () => {
    assert.ok(!md.SAFE_URL.test(links[1].href) && md.SAFE_URL.test(links[0].href));
  });
  test("HTML stays text", () => {
    const html = md.parseInline("<img src=x onerror=alert(1)>");
    assert.ok(html.length === 1 && html[0].t === "text");
  });

  const lists = md.parseMarkdown("- раз\n- два\n  - вложенный\n1. нумерованный\n2. второй");
  test("bulleted and numbered make two lists", () => {
    assert.equal(json(lists.map((x) => [x.t, x.ordered])), '[["list",false],["list",true]]');
  });
  test("nested list inside an item", () => {
    assert.ok(lists[0].items[1].sub.length === 1 && lists[0].items[1].sub[0].items.length === 1);
  });

  const blocks = md.parseMarkdown("| A | B |\n|---|---|\n| 1 | **2** |\n| 3 | 4 |\n\n> цитата\n\n```py\nprint('**нет**')\n```\n\n---");
  test("table, quote, code, rule", () => assert.equal(json(types(blocks)), '["table","quote","pre","hr"]'));
  test("table rows", () => assert.ok(blocks[0].rows.length === 2 && blocks[0].head.length === 2));
  test("markup inside code is not parsed", () => assert.equal(blocks[2].text, "print('**нет**')"));
  test("an unclosed code block does not break parsing", () => {
    const open = md.parseMarkdown("```\nобрезанный код без закрытия");
    assert.ok(open.length === 1 && open[0].t === "pre");
  });
});

describe("active logic", () => {
  const now = new Date("2026-09-27T12:00:00");
  test("period: within an hour", () => assert.equal(L.periodOf("2026-09-27T11:30:00", now), "hour"));
  test("period: today", () => assert.equal(L.periodOf("2026-09-27T08:00:00", now), "today"));
  test("period: yesterday", () => assert.equal(L.periodOf("2026-09-26T23:00:00", now), "yesterday"));
  test("period: week", () => assert.equal(L.periodOf("2026-09-22T10:00:00", now), "week"));
  test("period: older", () => assert.equal(L.periodOf("2026-09-01T10:00:00", now), "older"));

  const sessions = [
    { domains: ["hired-work"], projects: ["a"], topic: "x", last_message_at: "2026-09-27T11:50:00" },
    { domains: ["personal"], projects: ["b"], topic: "y", last_message_at: "2026-09-20T10:00:00" },
    { domains: ["hired-work"], projects: ["b"], topic: "y", last_message_at: "2026-09-26T10:00:00" },
  ];
  const filters = { domain: new Set(["hired-work"]), project: new Set(), topic: new Set(), period: new Set() };
  const passing = () => sessions.filter((s) => L.passes(s, filters, null, now)).length;
  test("domain filter", () => assert.equal(passing(), 2));
  test("two values in one list are OR", () => {
    filters.domain.add("personal");
    assert.equal(passing(), 3);
  });
  test("different lists are AND", () => {
    filters.project.add("b");
    assert.equal(passing(), 2);
  });
  test("a value's count ignores its own filter", () => {
    const opts = L.filterOptions(sessions, filters, "domain", now);
    assert.equal(json(opts.map((o) => [o.value, o.count])), '[["hired-work",1],["personal",1]]');
  });
  test("an own filter does not hide the other values of its list", () => {
    const only = { domain: new Set(["hired-work"]), project: new Set(), topic: new Set(), period: new Set() };
    const own = L.filterOptions(sessions, only, "domain", now);
    assert.equal(json(own.map((o) => [o.value, o.count])), '[["hired-work",2],["personal",1]]');
  });
  test("only non-empty periods, in order", () => {
    const empty = { domain: new Set(), project: new Set(), topic: new Set(), period: new Set() };
    const per = L.filterOptions(sessions, empty, "period", now);
    assert.equal(json(per.map((p) => p.value)), '["hour","yesterday","week"]');
  });

  test("layout from the address", () => assert.equal(json(L.parseLayout("3x2", 4)), '{"c":3,"r":2}'));
  test("a layout over the limit is dropped", () => {
    assert.ok(L.parseLayout("5x5", 4) === null && L.parseLayout("5x5", 5) !== null);
  });
  test("garbage in the address is dropped", () => {
    assert.ok(L.parseLayout("9x1", 5) === null && L.parseLayout("", 5) === null);
  });

  test("background reasons in words", () => {
    assert.equal(json(L.backgroundReasons({ shells: 1, agents: 2, wake_at: "T", crons: 1 }, () => "16:35")),
      '["команда в фоне","2 агента","проснётся в 16:35","по расписанию"]');
  });
});

describe("unanswered prompt and delivery", () => {
  const s = { reply_at: "2026-09-27T10:00:00Z", prompt: "сделай", prompt_at: "2026-09-27T10:05:00Z" };
  test("unanswered prompt from the transcript", () => assert.equal(L.unansweredPrompt(s, null).prompt.text, "сделай"));
  test("an interrupted prompt is marked", () => {
    const cut = L.unansweredPrompt({ ...s, interrupted_at: "2026-09-27T10:05:30Z" }, null).prompt;
    assert.ok(cut && cut.interrupted === true);
  });
  test("an interruption before the prompt is not about it", () => {
    assert.equal(L.unansweredPrompt({ ...s, interrupted_at: "2026-09-27T10:01:00Z" }, null).prompt.interrupted, false);
  });
  test("an answered prompt is not shown", () => {
    assert.equal(L.unansweredPrompt({ ...s, reply_at: "2026-09-27T10:06:00Z" }, null).prompt, null);
  });
  const sent = { text: "только что", images: 0, at: "2026-09-27T10:10:00Z" };
  test("a just-sent message shows before the transcript", () => {
    assert.equal(L.unansweredPrompt(s, sent).prompt.text, "только что");
  });
  test("once the transcript catches up, the sent message is dropped", () => {
    const caught = L.unansweredPrompt({ ...s, prompt_at: "2026-09-27T10:10:01Z", prompt: "только что" }, sent);
    assert.ok(caught.dropSent && caught.prompt.text === "только что");
  });

  const msg = { text: "проверь тесты и почини", at: "2026-09-27T10:00:00Z" };
  const t0 = new Date(msg.at).getTime();
  test("delivery: just sent is in transit", () => assert.equal(L.deliveryState({}, msg, t0 + 3000), "sending"));
  test("delivery: queued, matched by text", () => {
    assert.equal(L.deliveryState({ queued: [{ text: "  проверь тесты и почини, а потом" }] }, msg, t0 + 20000), "queued");
  });
  test("delivery: 15 s without a trace is lost", () => {
    assert.equal(L.deliveryState({ queued: [] }, msg, t0 + 16000), "lost");
  });
  test("delivery: someone else's text in the queue is not ours", () => {
    assert.equal(L.deliveryState({ queued: [{ text: "другое" }] }, msg, t0 + 16000), "lost");
  });
  test("delivery: an image-only message does not alarm", () => {
    assert.equal(L.deliveryState({}, { text: "", at: msg.at }, t0 + 60000), "sending");
  });
  test("delivery: nothing sent means no state", () => assert.equal(L.deliveryState({}, null, t0), null));
});

describe("command hints and history", () => {
  const cmds = [{ name: "goal" }, { name: "compact" }, { name: "clear" }, { name: "context" },
                { name: "context-save" }, { name: "obsidian-log" }, { name: "log-x" }];
  const names = (t) => L.commandMatches(cmds, t).map((c) => c.name).join(",");
  test("hints: \"/\" lists all in order", () => {
    assert.equal(names("/"), "goal,compact,clear,context,context-save,obsidian-log,log-x");
  });
  test("hints: prefix matches first", () => assert.equal(names("/lo"), "log-x,obsidian-log"));
  test("hints: case does not matter", () => assert.equal(names("/COMP"), "compact"));
  test("hints: none after a space", () => assert.ok(names("/goal сделай") === "" && names("привет /g") === ""));
  test("hints: all matches, no truncation", () => {
    assert.equal(L.commandMatches(Array.from({ length: 200 }, (_, i) => ({ name: "c" + i })), "/c").length, 200);
  });

  const h = ["первое", "второе", "третье"];
  let st = null;
  test("history: up gives the latest", () => {
    st = L.historyStep(h, -1, "up");
    assert.ok(st.index === 0 && st.text === "третье");
  });
  test("history: stops at the oldest", () => {
    st = L.historyStep(h, st.index, "up"); st = L.historyStep(h, st.index, "up"); st = L.historyStep(h, st.index, "up");
    assert.ok(st.index === 2 && st.text === "первое");
  });
  test("history: down from the latest returns to the draft", () => {
    st = L.historyStep(h, 0, "down");
    assert.ok(st.index === -1 && st.text === null);
  });
  test("history: empty", () => assert.equal(L.historyStep([], -1, "up").text, null));
});

describe("context and limits", () => {
  test("context: no data, no badge", () => assert.equal(L.contextLevel({}), null));
  test("context: 87% is alarming", () => {
    const c = L.contextLevel({ context_tokens: 870094, context_window: 1000000 });
    assert.ok(c.pct === 87 && c.tone === "warn" && /компактация/.test(c.hint), json(c));
  });
  test("context: 61% is middle", () => {
    assert.equal(L.contextLevel({ context_tokens: 122000, context_window: 200000 }).tone, "mid");
  });
  test("context: 22% is calm", () => {
    assert.equal(L.contextLevel({ context_tokens: 222018, context_window: 1000000 }).tone, "ok");
  });
  const lim = { age_seconds: 60, windows: [{ label: "5 часов", used_percentage: 41.6, resets_at: "x" },
                                           { label: "неделя", used_percentage: 87.2, resets_at: "y" }] };
  test("limits: the line", () => {
    const t = L.limitsText(lim, (v) => (v === "y" ? "01.10" : "00:36"));
    assert.equal(t.text, "лимиты: 5 часов 42% до 00:36 · неделя 87% до 01.10");
    assert.equal(t.tone, "mid");
  });
  test("limits: stale data is marked", () => assert.equal(L.limitsText({ ...lim, age_seconds: 7 * 3600 }).stale, true));
  test("limits: 90% is alarming", () => {
    assert.equal(L.limitsText({ windows: [{ label: "неделя", used_percentage: 93 }] }).tone, "warn");
  });
  test("limits: no file, no line", () => assert.equal(L.limitsText(null), null));
});

describe("card order and hiding", () => {
  const mk = (id, started, last) => ({ session_id: id, process_started_at: started, last_message_at: last });
  const list = [mk("a", "2026-09-27T08:00:00Z", "2026-09-27T12:00:00Z"),
                mk("b", "2026-09-27T10:00:00Z", "2026-09-27T09:00:00Z"),
                mk("c", "2026-09-27T09:00:00Z", "2026-09-27T11:00:00Z")];
  const ids = (r) => r.visible.map((s) => s.session_id).join("");
  test("order: by start, newest on top", () => assert.equal(ids(L.arrangeSessions(list, [], {})), "bca"));
  test("order: a new message does not move the card", () => {
    const fresher = list.map((s) => (s.session_id === "a" ? { ...s, last_message_at: "2026-09-27T13:00:00Z" } : s));
    assert.equal(ids(L.arrangeSessions(fresher, [], {})), "bca");
  });
  test("order: pinned first, in pin order", () => assert.equal(ids(L.arrangeSessions(list, ["a", "c"], {})), "acb"));
  const hid = { c: "2026-09-27T11:00:00Z", gone: "x" };
  const r = L.arrangeSessions(list, [], hid);
  test("hide: until the next message", () => assert.ok(ids(r) === "ba" && r.hiddenCount === 1));
  test("hide: records of departed sessions go to removal", () => assert.equal(json(r.stale), '["gone"]'));
  test("hide: a new message brings the card back", () => {
    const back = L.arrangeSessions(list.map((s) => (s.session_id === "c"
      ? { ...s, last_message_at: "2026-09-27T14:00:00Z" } : s)), [], hid);
    assert.ok(ids(back) === "bca" && back.stale.includes("c"));
  });
});

describe("card line", () => {
  test("card line: short", () => {
    const s = { started_at: "x", last_message_at: "y", human_turns: 396, cost_now: 832.06, cost_usd: 700,
                context_tokens: 605574, context_window: 1000000 };
    const p = L.infoParts(s, () => "12 ч назад", () => "26.08 16:36");
    assert.equal([...p.when, ...p.nums, p.context.text].join(" · "),
      "26.08 16:36 · 12 ч назад · 396 ходов · ≈$832 · 606k/1M");
  });
  test("line: a recorded sum has no ≈, a small one shows cents", () => {
    assert.equal(L.infoParts({ cost_usd: 5.1, cost_now: 5.1 }, () => "", () => "").nums.join(), "$5.10");
  });
  test("line: a 200k window", () => {
    assert.equal(L.infoParts({ context_tokens: 130020, context_window: 200000 }, () => "", () => "").context.text,
      "130k/200k");
  });
  test("line: no data, empty", () => {
    assert.equal(json(L.infoParts({}, () => "", () => "")), '{"when":[],"nums":[],"context":null}');
  });
  test("tokens: 1.5M", () => assert.ok(L.shortTokens(1500000) === "1.5M" && L.shortTokens(1000000) === "1M"));
});

describe("keyboard navigation", () => {
  test("navigation: right", () => assert.equal(L.nextCard(["a", "b", "c", "d"], "a", "ArrowRight", 2), "b"));
  test("navigation: down by a row", () => assert.equal(L.nextCard(["a", "b", "c", "d"], "a", "ArrowDown", 2), "c"));
  test("navigation: j/k", () => {
    assert.ok(L.nextCard(["a", "b"], "b", "k", 2) === "a" && L.nextCard(["a", "b"], "a", "j", 2) === "b");
  });
  test("navigation: the edge does not wrap", () => assert.equal(L.nextCard(["a", "b"], "b", "ArrowRight", 2), "b"));
  test("navigation: no selection picks the first", () => assert.equal(L.nextCard(["a", "b"], null, "j", 2), "a"));
});

describe("terminal link, cost and plurals", () => {
  const ts = L.terminalStatus;
  test("link: outside Obsidian there is none", () => {
    assert.ok(ts(false, null, null, 0).ok === false && /не в Obsidian/.test(ts(false, null, null, 0).reason));
  });
  test("link: waiting for the plugin's answer", () => assert.equal(ts(true, null, 1000, 2000).ok, null));
  test("link: a silent plugin means none, with a reason", () => {
    assert.ok(ts(true, null, 1000, 5000).ok === false && /не отвечает/.test(ts(true, null, 1000, 5000).reason));
  });
  test("link: the reason comes from the plugin", () => {
    assert.equal(ts(true, { ok: false, reason: "плагин Terminal выключен" }, null, 0).reason, "плагин Terminal выключен");
  });
  test("link: present", () => assert.equal(ts(true, { ok: true, reason: null }, null, 0).ok, true));

  test("cost: current estimate", () => assert.equal(L.costText({ cost_usd: 10, cost_now: 12.5 }), "≈ $12.50"));
  test("cost: no growth shows the recorded date", () => {
    assert.equal(L.costText({ cost_usd: 10, cost_now: 10, cost_recorded_at: "x" }, () => "25.09"), "$10.00 на 25.09");
  });
  test("cost: unknown", () => assert.equal(L.costText({}), "$ —"));
  test("Russian plurals", () => {
    assert.ok(L.pluralRu(1, "ход", "хода", "ходов") === "ход" && L.pluralRu(3, "ход", "хода", "ходов") === "хода"
      && L.pluralRu(11, "ход", "хода", "ходов") === "ходов" && L.pluralRu(22, "ход", "хода", "ходов") === "хода");
  });
});

describe("agent tasks on the card", () => {
  const t = L.tasksSummary({ total: 4, done: 1, active: ["Проверяю дифф"],
    items: [{ subject: "а", status: "completed" }, { subject: "б", status: "in_progress" },
            { subject: "в", status: "pending" }, { subject: "г", status: "pending" }] });
  test("tasks: count and current", () => {
    assert.ok(t.count === "1/4" && t.current === "Проверяю дифф" && t.pct === 25 && !t.finished, json(t));
  });
  test("tasks: the tooltip lists them with marks", () => assert.equal(t.hint, "✓ а\n▶ б\n○ в\n○ г"));
  test("tasks: none, show nothing", () => {
    assert.ok(L.tasksSummary(null) === null && L.tasksSummary({ total: 0 }) === null);
  });
  test("tasks: all done", () => {
    assert.equal(L.tasksSummary({ total: 2, done: 2, active: [], items: [] }).finished, true);
  });
});

describe("feed: steps and files", () => {
  test("step duration", () => {
    assert.ok(L.durationText(0.84) === "0,8 с" && L.durationText(42.4) === "42 с"
      && L.durationText(180) === "3 мин" && L.durationText(3900) === "1 ч 05 мин" && L.durationText(null) === "",
    json([L.durationText(0.84), L.durationText(3900)]));
  });
  test("step filter", () => {
    assert.ok(L.stepPasses({ kind: "bash", status: "error" }, "error")
      && !L.stepPasses({ kind: "bash", status: "ok" }, "error") && L.stepPasses({ kind: "edit", status: "ok" }, "edit")
      && !L.stepPasses({ kind: "text", status: "ok" }, "agent") && L.stepPasses({ kind: "text", status: "ok" }, "all"));
  });
  test("file path relative to the session folder", () => {
    assert.ok(L.relPath("/u/Code/p/a/b.py", "/u/Code/p", "/u") === "a/b.py"
      && L.relPath("/u/Code/q/c.py", "/u/Code/p", "/u") === "~/Code/q/c.py"
      && L.relPath("/u/Code/pp/c.py", "/u/Code/p", null) === "/u/Code/pp/c.py");
  });
});

describe("quick jump and frozen order", () => {
  const items = [{ kind: "closed", id: "c", title: "Session Atlas старый", sub: "" },
                 { kind: "live", id: "a", title: "Верстка лендинга", sub: "landing-site personal" },
                 { kind: "live", id: "b", title: "Session Atlas плагин", sub: "session-atlas" },
                 { kind: "live", id: "d", title: "Новый Session Atlas", sub: "" },
                 { kind: "live", id: "e", title: "Atlas отчёт", sub: "" }];
  const hist = [{ role: "you", at: "10:00" }, { role: "claude", at: "10:01" }, { role: "you", at: "10:02" },
                { role: "claude", at: "10:03" }];
  test("detailed card: history is everything before the last reply, at most N − 1", () => {
    const at = (r) => r.map((m) => m.at).join();
    assert.ok(at(L.cardHistory({ history: hist, reply_at: "10:03" }, null, 10)) === "10:00,10:01,10:02"
      && at(L.cardHistory({ history: hist, reply_at: "10:03" }, null, 3)) === "10:01,10:02"
      && at(L.cardHistory({ history: hist, reply_at: "10:01" }, { at: "10:02" }, 10)) === "10:00,10:01"
      && L.cardHistory({ history: hist, reply_at: "10:03" }, null, 1).length === 0);
  });
  const S = (id) => ({ session_id: id });
  const first = L.applyFrozenOrder([S("a"), S("b"), S("c")], null);
  test("order: the first time sorts fresh and remembers it", () => {
    assert.ok(first.list.map((s) => s.session_id).join() === "a,b,c" && first.frozen.join() === "a,b,c");
  });
  test("order: on the tab, old cards keep places, a new one goes last, a departed one drops", () => {
    const later = L.applyFrozenOrder([S("d"), S("c"), S("a")], first.frozen);
    assert.ok(later.list.map((s) => s.session_id).join() === "a,c,d" && later.frozen.join() === "a,c,d",
      json(later.frozen));
  });
  const notes = new Map([["gone", { text: "opening…", pending: true, at: 0 }],
                         ["waiting", { text: "opening…", pending: true, at: 1000 }],
                         ["old", { text: "opening…", pending: true, at: 0 }],
                         ["failed", { text: "failed", pending: false, at: 0 }]]);
  test("closed: opened drops the note, waiting keeps it, an error stays", () => {
    L.pruneClosedNotes(notes, ["waiting", "old", "failed"], 1000 + 5000, 60000);
    assert.equal([...notes.keys()].join(), "waiting,old,failed");
  });
  test("closed: \"opening…\" longer than a minute is dropped", () => {
    L.pruneClosedNotes(notes, ["waiting", "old", "failed"], 61000 + 5, 60000);
    assert.equal([...notes.keys()].join(), "failed");
  });
  const ids = (q, n) => L.jumpMatches(items, q, n).map((i) => i.id).join();
  test("jump: all words, live above closed", () => assert.equal(ids("atlas session"), "b,d,c"));
  test("jump: a title prefix ranks above the middle", () => {
    assert.ok(ids("atlas") === "e,b,d,c" && ids("нов") === "d", ids("atlas"));
  });
  test("jump: the subtitle is searched too, case does not matter", () => assert.equal(ids("PERSONAL"), "a"));
  test("jump: an empty query lists everything, live on top, with a limit", () => assert.equal(ids("", 3), "a,b,d"));
});

describe("statistics", () => {
  test("tokens: billions", () => assert.equal(nb(SL.bigNum(18895000000)), "18,9 млрд"));
  test("tokens: millions and thousands", () => {
    assert.ok(nb(SL.bigNum(401700000)) === "402 млн" && nb(SL.bigNum(12400)) === "12 тыс" && SL.bigNum(540) === "540",
      json([SL.bigNum(401700000), SL.bigNum(12400)]));
  });
  test("time: hours and minutes", () => {
    assert.ok(nb(SL.hoursText(16200)) === "4 ч 30 мин" && nb(SL.hoursText(3900)) === "1 ч 05 мин"
      && nb(SL.hoursText(47100)) === "13 ч", json([SL.hoursText(16200), SL.hoursText(47100)]));
  });
  test("time: under an hour in minutes, many in hours", () => {
    assert.ok(nb(SL.hoursText(1500)) === "25 мин" && nb(SL.hoursText(3600 * 1234)) === "1 234 ч",
      json([SL.hoursText(1500), SL.hoursText(3600 * 1234)]));
  });
  test("money", () => {
    assert.ok(nb(SL.money(3367.52)) === "$3 368" && SL.money(12.4) === "$12,40", json([SL.money(3367.52), SL.money(12.4)]));
  });
  test("comparison: growth and drop", () => {
    assert.ok(SL.delta(112, 100).text === "+12%" && SL.delta(112, 100).dir === "up"
      && SL.delta(50, 100).text === "−50%" && SL.delta(50, 100).dir === "down");
  });
  test("comparison: nothing to compare with", () => assert.ok(SL.delta(5, 0) === null && SL.delta(5, null) === null));
  test("bar label", () => {
    assert.ok(SL.pointLabel("2026-09-28", "day") === "28.09" && SL.pointLabel("2026-09-28 14", "hour") === "14:00");
  });
  test("labels do not overlap", () => assert.ok(SL.labelStep(90, 14) === 7 && SL.labelStep(10, 14) === 1));
  test("share of the maximum", () => assert.ok(SL.share(50, 200) === 25 && SL.share(0, 200) === 0 && SL.share(5, 0) === 0));
  test("rhythm level", () => {
    assert.ok(SL.heatLevel(0, 10) === 0 && SL.heatLevel(1, 10) === 1 && SL.heatLevel(10, 10) === 4
      && SL.heatLevel(6, 10) === 3);
  });
  test("breakdown sorts by the chosen measure", () => {
    const items = [{ name: "a", cost: 1, tokens: 9 }, { name: "b", cost: 5, tokens: 1 }, { name: "c", cost: 0, tokens: 3 }];
    assert.ok(SL.ranked(items, "cost").map((i) => i.name).join() === "b,a"
      && SL.ranked(items, "tokens", 2).map((i) => i.name).join() === "a,c");
  });
});

describe("English: the same functions after switching the language", () => {
  test("en: big numbers", () => {
    I18N.setLang("en");
    assert.ok(SL.bigNum(18895000000) === "18.9B" && SL.bigNum(401700000) === "402M"
      && SL.bigNum(12400) === "12k" && SL.bigNum(1234) === "1,234", json([SL.bigNum(18895000000), SL.bigNum(1234)]));
  });
  test("en: hours and minutes", () => {
    assert.ok(nb(SL.hoursText(47100)) === "13 h" && nb(SL.hoursText(1500)) === "25 min"
      && nb(SL.hoursText(3900)) === "1 h 05 min" && nb(SL.hoursText(3600 * 1234)) === "1,234 h",
    json([SL.hoursText(47100), SL.hoursText(3600 * 1234)]));
  });
  test("en: money", () => {
    assert.ok(SL.money(3367.52) === "$3,368" && SL.money(12.4) === "$12.40", json([SL.money(3367.52), SL.money(12.4)]));
  });
  test("en: period labels", () => assert.ok(SL.PERIODS[0].label === "Today" && L.PERIODS[2].label === "yesterday"));
  test("en: step duration", () => {
    assert.ok(L.durationText(0.84) === "0.8 s" && L.durationText(42.4) === "42 s"
      && L.durationText(180) === "3 min" && L.durationText(3900) === "1 h 05 min",
    json([L.durationText(0.84), L.durationText(3900)]));
  });
  test("en: tasks, count and tooltip", () => {
    const t = L.tasksSummary({ total: 4, done: 1, active: ["Checking the diff"],
      items: [{ subject: "a", status: "completed" }, { subject: "b", status: "in_progress" }] });
    assert.ok(t.count === "1/4" && t.current === "Checking the diff" && t.hint === "✓ a\n▶ b", json(t));
  });
  test("en: turn plurals instead of pluralRu", () => {
    const p = L.infoParts({ human_turns: 1 }, () => "", () => "");
    assert.ok(p.nums[0] === "1 turn"
      && L.infoParts({ human_turns: 396 }, () => "", () => "").nums[0] === "396 turns", json(p.nums));
  });
  test("en: background reasons", () => {
    assert.equal(json(L.backgroundReasons({ shells: 2, agents: 1, crons: 1 })),
      '["background commands: 2","1 agent","scheduled"]');
  });
  test("ru again after en", () => {
    I18N.setLang("ru");
    assert.ok(nb(SL.bigNum(18895000000)) === "18,9 млрд" && L.durationText(0.84) === "0,8 с");
  });
});

// Page scripts are classic: a same-named function in another file silently replaces the first
// (a Statistics button once broke search highlighting that way). A top-level name lives in exactly one file.
describe("shared global scope", () => {
  test("page global names are not repeated", () => {
    const owners = {};
    for (const f of fs.readdirSync(JS).filter((name) => name.endsWith(".js"))) {
      const src = readScript(f);
      for (const m of src.matchAll(/^(?:async )?function (\w+)|^(?:const|let|var) (\w+)/gm)) {
        const name = m[1] || m[2];
        (owners[name] = owners[name] || []).push(f);
      }
    }
    assert.deepEqual(Object.entries(owners).filter(([, files]) => files.length > 1), []);
  });

  // A top-level call runs at load time: the function must be declared already, in this file or one
  // loaded earlier (order from index.html). Otherwise the whole file fails.
  test("top level does not call functions from later files", () => {
    const order = [...fs.readFileSync(path.join(WEB, "index.html"), "utf8")
      .matchAll(/src="\/static\/([\w-]+\.js)"/g)].map((m) => m[1]);
    const definedIn = {};
    order.forEach((f, i) => {
      for (const m of readScript(f).matchAll(/^(?:async )?function (\w+)/gm)) definedIn[m[1]] = i;
    });
    const late = [];
    order.forEach((f, i) => {
      for (const m of readScript(f).matchAll(/^(?:(?:let|const|var) \w+ = )?(\w+)\(/gm)) {
        if (m[1] in definedIn && definedIn[m[1]] > i) late.push(`${f}: ${m[1]} (from ${order[definedIn[m[1]]]})`);
      }
    });
    assert.deepEqual(late, []);
  });

  test("every page script compiles as a classic script", () => {
    for (const f of fs.readdirSync(JS).filter((name) => name.endsWith(".js"))) {
      assert.doesNotThrow(() => compileScript(f), f);
    }
  });

  test("all page scripts load in index.html order without throwing", () => {
    const ctx = loadPage();
    assert.equal(typeof ctx.AtlasLogic, "object");
    assert.equal(typeof ctx.renderMarkdown, "function");
  });

  test("chat in a card: at the bottom within a few pixels, unknown while hidden", () => {
    const { nearBottom, stickChats } = loadPage();
    assert.equal(typeof stickChats, "function");
    assert.equal(nearBottom(900, 1300, 400), true);          // exactly at the bottom
    assert.equal(nearBottom(880, 1300, 400), true);          // a few pixels short still counts
    assert.equal(nearBottom(700, 1300, 400), false);         // scrolled up to read
    assert.equal(nearBottom(0, 0, 0), null);                 // hidden tab: no layout to judge
  });
});

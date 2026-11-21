// Unread marks on Active cards: which sessions get one, what clears it, and what the page may send.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { getGlobal, setGlobal } from "./helpers/globals.mjs";
import { loadSrc } from "./helpers/load-src.mjs";

const realLoad = Module._load;
let notices = 0;
Module._load = (request, parent, isMain) =>
  request === "obsidian" ? { Notice: class { constructor() { notices += 1; } }, View: class {} }
    : request === "electron" ? {} : realLoad(request, parent, isMain);
const { UnreadMethods, nextUnread, seenAfterEnd, seenFromPage } = loadSrc("unread");
if (!getGlobal("window")) setGlobal("window", {});
const { NotifyMethods, waitingTransitions } = loadSrc("notify");

const A_ID = "11111111-1111-1111-1111-111111111111";
const B_ID = "22222222-2222-2222-2222-222222222222";
const S = (id, activity, ancestors = [], at = null) => ({ session_id: id, activity, ancestors, last_message_at: at });
const ids = (set) => [...set].sort();

describe("nextUnread", () => {
  it("a session that finished its turn unseen gets a mark", () => {
    const prev = new Map([[A_ID, "busy"], [B_ID, "busy"]]);
    const now = [S(A_ID, "idle"), S(B_ID, "busy")];
    const { started } = waitingTransitions(prev, now);
    assert.deepEqual(ids(nextUnread(new Set(), now, started, new Set())), [A_ID]);
  });

  it("a dialog counts as finished too", () => {
    const prev = new Map([[A_ID, "idle"]]);
    const now = [S(A_ID, "waiting")];
    const { started } = waitingTransitions(prev, now);
    assert.deepEqual(ids(nextUnread(new Set(), now, started, new Set())), [A_ID]);
  });

  it("no mark when you were looking at it", () => {
    const now = [S(A_ID, "idle")];
    assert.deepEqual(ids(nextUnread(new Set(), now, now, new Set([A_ID]))), []);
  });

  it("the mark goes when the session works again", () => {
    assert.deepEqual(ids(nextUnread(new Set([A_ID]), [S(A_ID, "busy")], [], new Set())), []);
    assert.deepEqual(ids(nextUnread(new Set([A_ID]), [S(A_ID, "background")], [], new Set())), []);
  });

  it("the mark goes when the session closes", () => {
    assert.deepEqual(ids(nextUnread(new Set([A_ID, B_ID]), [S(B_ID, "idle")], [], new Set())), [B_ID]);
  });

  it("an existing mark stays while the session keeps waiting", () => {
    assert.deepEqual(ids(nextUnread(new Set([A_ID]), [S(A_ID, "waiting")], [], new Set())), [A_ID]);
  });

  it("an idle session that did nothing new gets no mark", () => {
    assert.deepEqual(ids(nextUnread(new Set(), [S(A_ID, "idle")], [], new Set())), []);
  });

  it("status works when activity is missing", () => {
    const s = { session_id: A_ID, status: "busy" };
    assert.deepEqual(ids(nextUnread(new Set([A_ID]), [s], [], new Set())), []);
  });
});

describe("seenFromPage", () => {
  it("keeps only id-shaped strings, at most 200", () => {
    assert.deepEqual(seenFromPage([A_ID, "ab-1", 5, "../x", "", "a b", null]), [A_ID]);
    const uuids = Array.from({ length: 300 }, (_, i) => "12345678-1234-1234-1234-" + String(i).padStart(12, "0"));
    assert.equal(seenFromPage(uuids).length, 200);
    assert.deepEqual(seenFromPage(A_ID), []);
    assert.deepEqual(seenFromPage([A_ID + "\n", A_ID.toUpperCase()]), [A_ID]);
  });
});

describe("seenAfterEnd", () => {
  const s = { last_message_at: "2026-11-09T10:00:00.000Z" };
  const end = Date.parse(s.last_message_at);
  it("seen at or after the last message counts; before it does not", () => {
    assert.equal(seenAfterEnd(end, s, 0, 0), true);
    assert.equal(seenAfterEnd(end - 1, s, 0, 0), false);
    assert.equal(seenAfterEnd(undefined, s, 0, 0), false);
  });
  it("a dialog ends at its status change: it opens from a tool call, not a message", () => {
    const d = { activity: "waiting", last_message_at: "2026-11-09T10:00:00.000Z", status_at: "2026-11-09T10:01:00.000Z" };
    assert.equal(seenAfterEnd(Date.parse(d.status_at) - 1, d, 0, 0), false);
    assert.equal(seenAfterEnd(Date.parse(d.status_at), d, 0, 0), true);
  });
  it("a finished turn ignores status flips without a message (auto-compaction)", () => {
    const d = { activity: "idle", last_message_at: "2026-11-09T10:00:00.000Z", status_at: "2026-11-09T10:01:00.000Z" };
    assert.equal(seenAfterEnd(Date.parse(d.last_message_at), d, 0, 0), true);
  });
  it("a dialog without a status time counts as seen only when in view at this poll", () => {
    const d = { activity: "waiting", last_message_at: "2026-11-09T10:00:00.000Z" };
    const since = Date.parse(d.last_message_at) + 60000, now = since + 10000;
    assert.equal(seenAfterEnd(now - 1, d, since, now), false, "seen after the previous poll is not enough");
    assert.equal(seenAfterEnd(now, d, since, now), true);
    assert.equal(seenAfterEnd(since, { ...d, activity: "idle" }, since, now), true, "a finished turn keeps its message time");
  });
  it("without a time the previous poll is the bound", () => {
    assert.equal(seenAfterEnd(500, {}, 500, 900), true);
    assert.equal(seenAfterEnd(499, { last_message_at: "bad" }, 500, 900), false);
  });
});

// A plugin stand-in with the methods mixed in: tabs by PTY pid, leaves with their own window's focus.
const leaf = (name, focused = () => true) =>
  ({ name, view: { containerEl: { ownerDocument: { hasFocus: focused } } } });

function host() {
  const plugin = Object.create(UnreadMethods.prototype);
  plugin.tabs = [];                              // {leaf, pid}
  plugin.current = null;
  plugin.handlers = {};
  plugin.windows = [];
  plugin.app = { workspace: { on: (name, fn) => { plugin.handlers[name] = fn; return name; } } };
  plugin.registerEvent = () => {};
  plugin.registerDomEvent = (target, name, fn) => { plugin.windows.push(target); plugin.handlers["dom:" + name] = fn; };
  plugin.activeLeaf = () => plugin.current;
  plugin.terminalTabs = async () => plugin.tabs;
  plugin.watchUnread();
  return plugin;
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();

describe("UnreadMethods", () => {
  it("marks a finished session whose tab is in the background", async () => {
    const p = host();
    const A = leaf("A"), B = leaf("B");
    p.tabs = [{ leaf: A, pid: 11 }, { leaf: B, pid: 12 }];
    p.current = B;
    const now = [S(A_ID, "idle", [11], ago(0))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("no mark when its tab is in front of its focused window", async () => {
    const p = host();
    const A = leaf("A");
    p.tabs = [{ leaf: A, pid: 11 }];
    p.current = A;
    const now = [S(A_ID, "idle", [11], ago(0))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), []);
  });

  it("a mark when its tab is in front but its window has no focus", async () => {
    const p = host();
    const A = leaf("A", () => false);
    p.tabs = [{ leaf: A, pid: 11 }];
    p.current = A;
    const now = [S(A_ID, "idle", [11], ago(0))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("a tab in a focused popout counts as looked at, whatever the main window", async () => {
    const p = host();
    const doc = getGlobal("document");
    setGlobal("document", { hasFocus: () => false });
    try {
      const A = leaf("A", () => true);
      p.tabs = [{ leaf: A, pid: 11 }];
      p.current = A;
      const now = [S(A_ID, "idle", [11], ago(0))];
      await p.updateUnread(now, now);
      assert.deepEqual(p.unreadIds(), []);
    } finally { setGlobal("document", doc); }
  });

  it("a turn you watched end and then left before the poll is not marked", async () => {
    const p = host();
    const A = leaf("A"), B = leaf("B");
    p.tabs = [{ leaf: A, pid: 11 }, { leaf: B, pid: 12 }];
    p.current = A;
    await p.updateUnread([S(A_ID, "busy", [11])], []);    // the poll knows which leaf holds a
    p.frontChanged(A);
    await new Promise((r) => setTimeout(r, 5));          // the turn ends after you came to the tab
    const endedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    p.current = B;
    p.frontChanged(B);                                   // left a after its last message
    const now = [S(A_ID, "idle", [11], endedAt)];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), []);
  });

  it("a turn that ended after you left is marked", async () => {
    const p = host();
    const A = leaf("A"), B = leaf("B");
    p.tabs = [{ leaf: A, pid: 11 }, { leaf: B, pid: 12 }];
    p.current = A;
    await p.updateUnread([S(A_ID, "busy", [11])], []);
    p.frontChanged(A);
    p.current = B;
    p.frontChanged(B);
    await new Promise((r) => setTimeout(r, 5));
    const now = [S(A_ID, "idle", [11], new Date().toISOString())];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("a session without a tab is marked", async () => {
    const p = host();
    const now = [S(A_ID, "idle", [99], ago(0))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("bringing its tab to the front clears only that mark", async () => {
    const p = host();
    const A = leaf("A"), B = leaf("B");
    p.tabs = [{ leaf: A, pid: 11 }, { leaf: B, pid: 12 }];
    const now = [S(A_ID, "idle", [11], ago(0)), S(B_ID, "idle", [12], ago(0))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds().sort(), [A_ID, B_ID]);
    p.handlers["active-leaf-change"](A);
    assert.deepEqual(p.unreadIds(), [B_ID]);
  });

  it("a tab brought forward in an unfocused window clears nothing; focusing the window does", async () => {
    const p = host();
    let focused = false;
    const A = leaf("A", () => focused);
    p.tabs = [{ leaf: A, pid: 11 }];
    const now = [S(A_ID, "idle", [11], ago(0))];
    await p.updateUnread(now, now);
    p.handlers["active-leaf-change"](A);
    assert.deepEqual(p.unreadIds(), [A_ID]);
    focused = true;
    p.current = A;
    p.handlers["dom:focus"]();
    assert.deepEqual(p.unreadIds(), []);
  });

  it("popout windows get the focus listeners too", () => {
    const p = host();
    const popout = { name: "popout" };
    p.handlers["window-open"]({ win: popout });
    assert.ok(p.windows.includes(popout));
  });

  it("the page marks cards seen, even before the plugin marked them; foreign ids are ignored", async () => {
    const p = host();
    const t0 = ago(0);
    await new Promise((r) => setTimeout(r, 5));
    p.markSeen({ ids: [A_ID, "b c"] });
    const now = [S(A_ID, "idle", [], t0), S("b c", "idle", [], t0)];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), ["b c"]);
    p.markSeen({ all: true });
    assert.deepEqual(p.unreadIds(), ["b c"], "only ids clear marks");
  });
});

describe("UnreadMethods: the cases the second review found", () => {
  it("a dialog that opened after you left is marked though its last message is old", async () => {
    const p = host();
    const A = leaf("A"), B = leaf("B");
    p.tabs = [{ leaf: A, pid: 11 }, { leaf: B, pid: 12 }];
    const sent = ago(60000);
    p.current = A;
    await p.updateUnread([S(A_ID, "busy", [11], sent)], []);
    p.current = B;
    p.frontChanged(B);
    await new Promise((r) => setTimeout(r, 5));
    const now = [{ ...S(A_ID, "waiting", [11], sent), status_at: new Date().toISOString() }];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("the window losing focus credits the tab you were watching", async () => {
    const p = host();
    let focused = true;
    const A = leaf("A", () => focused);
    p.tabs = [{ leaf: A, pid: 11 }];
    p.current = A;
    await p.updateUnread([S(A_ID, "busy", [11])], []);
    p.frontChanged(A);
    await new Promise((r) => setTimeout(r, 5));
    const endedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    p.handlers["dom:blur"]();                            // you watched it end, then left Obsidian
    focused = false;
    const now = [S(A_ID, "idle", [11], endedAt)];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), []);
  });

  it("a session without times is judged by the previous poll", async () => {
    const p = host();
    p.markSeen({ ids: [A_ID] });
    await new Promise((r) => setTimeout(r, 5));
    await p.updateUnread([S(A_ID, "busy")], []);          // a poll after you saw it
    const now = [S(A_ID, "idle")];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID], "seen before the previous poll does not cover this turn");
  });

  it("closed sessions leave the seen times", async () => {
    const p = host();
    p.markSeen({ ids: [A_ID, B_ID] });
    await p.updateUnread([S(B_ID, "idle")], []);
    assert.deepEqual([...p.seenAt.keys()], [B_ID]);
  });

  it("markSeen says whether a mark went", async () => {
    const p = host();
    const now = [S(A_ID, "idle", [], ago(0))];
    await p.updateUnread(now, now);
    assert.equal(p.markSeen({ ids: [B_ID] }), false);
    assert.equal(p.markSeen({ ids: [A_ID] }), true);
    assert.equal(p.markSeen({ ids: [A_ID] }), false);
  });

  it("the Atlas tab in front of its focused window counts as in view", () => {
    const p = host();
    let focused = true;
    const win = {};
    const atlas = { view: { getViewType: () => "session-atlas", frame: { contentWindow: win },
                            containerEl: { ownerDocument: { hasFocus: () => focused } } } };
    p.current = atlas;
    assert.equal(p.atlasInFront(win), true);
    focused = false;
    assert.equal(p.atlasInFront(win), false);
    p.current = { view: { getViewType: () => "markdown", frame: { contentWindow: win },
                          containerEl: { ownerDocument: { hasFocus: () => true } } } };
    assert.equal(p.atlasInFront(win), false);
    p.current = null;
    assert.equal(p.atlasInFront(win), false);
  });

  it("no notification for a tab in front of a focused popout", async () => {
    const p = host();
    Object.assign(p, Object.fromEntries(Object.getOwnPropertyNames(NotifyMethods.prototype)
      .filter((n) => n !== "constructor").map((n) => [n, NotifyMethods.prototype[n]])));
    const A = leaf("A", () => true);
    p.current = A;
    p.tabForSession = async () => ({ leaf: A, pid: 11 });
    p.t = (key) => key;
    p.settings = {};
    const doc = getGlobal("document");
    setGlobal("document", { hasFocus: () => false });
    try {
      const before = notices;
      await p.notifyWaiting(S(A_ID, "idle", [11]));
      assert.equal(notices, before);
      p.current = leaf("other");
      await p.notifyWaiting(S(A_ID, "idle", [11]));
      assert.equal(notices, before + 1, "another tab in front: notified");
    } finally { setGlobal("document", doc); }
  });
});

describe("the notification poll keeps the marks", () => {
  it("startWatch sets the marks up and pollActive feeds them", async () => {
    const p = host();
    Object.assign(p, Object.fromEntries(Object.getOwnPropertyNames(NotifyMethods.prototype)
      .filter((n) => n !== "constructor").map((n) => [n, NotifyMethods.prototype[n]])));
    p.unread = null;
    const replies = [{ sessions: [S(A_ID, "busy", [11])] }, { sessions: [S(A_ID, "idle", [11], ago(0))] }];
    p.fetchActive = async () => replies.shift();
    p.offerHeldTabs = () => {};
    p.trackOpenSessions = async () => {};
    p.setWaitingCount = () => {};
    p.registerInterval = () => {};
    p.settings = { notify: false };
    const win = getGlobal("window");
    setGlobal("window", { setInterval: () => 0 });
    try {
      p.startWatch();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(p.unread instanceof Set, "startWatch sets the marks up");
      await p.pollActive();
      assert.deepEqual(p.unreadIds(), [A_ID]);
    } finally { setGlobal("window", win); }
  });
});

describe("UnreadMethods: the cases the third review found", () => {
  const away = () => {
    const p = host();
    const A = leaf("A"), B = leaf("B");
    p.tabs = [{ leaf: A, pid: 11 }, { leaf: B, pid: 12 }];
    p.current = B;
    return { p, A, B };
  };

  it("a click made before the turn ended does not clear its mark", async () => {
    const { p } = away();
    const now = [S(A_ID, "idle", [11], ago(1000))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
    assert.equal(p.markSeen({ ids: [A_ID], at: Date.now() - 2000 }), false, "the held click came before the end");
    assert.deepEqual(p.unreadIds(), [A_ID]);
    assert.equal(p.markSeen({ ids: [A_ID], at: Date.now() }), true);
    assert.deepEqual(p.unreadIds(), []);
  });

  it("a held click that arrives before the poll does not cover a turn that ended after it", async () => {
    const { p } = away();
    await p.updateUnread([S(A_ID, "busy", [11])], []);
    p.markSeen({ ids: [A_ID], at: Date.now() - 2000 });
    const now = [S(A_ID, "idle", [11], ago(1000))];
    await p.updateUnread(now, now);
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("a click time from the future, too old or not a number is the arrival time", () => {
    const { p } = away();
    for (const at of [Date.now() + 60_000, Date.now() - 10 * 60_000, "1", NaN, null]) {
      const before = Date.now();
      p.markSeen({ ids: [A_ID], at });
      assert.ok(p.seenAt.get(A_ID) >= before, String(at));
      assert.ok(p.seenAt.get(A_ID) <= Date.now(), "never ahead of now: " + String(at));
    }
  });

  it("a second dialog that opened between two polls while you were away is marked", async () => {
    const { p, A, B } = away();
    p.current = A;
    const first = [{ ...S(A_ID, "waiting", [11], ago(60_000)), status_at: ago(20_000) }];
    await p.updateUnread(first, first);
    assert.deepEqual(p.unreadIds(), [], "you were in its tab");
    p.current = B;
    p.frontChanged(B);
    await new Promise((r) => setTimeout(r, 5));
    const second = [{ ...S(A_ID, "waiting", [11], ago(60_000)), status_at: new Date().toISOString() }];
    await p.updateUnread(second, []);                   // waiting → waiting: no transition
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("a short turn between two polls while you were away is marked", async () => {
    const { p } = away();
    await p.updateUnread([S(A_ID, "idle", [11], ago(60_000))], []);
    assert.deepEqual(p.unreadIds(), [], "the first poll knows no earlier stop");
    await p.updateUnread([S(A_ID, "idle", [11], ago(0))], []);   // idle → idle: no transition
    assert.deepEqual(p.unreadIds(), [A_ID]);
  });

  it("a short turn in the tab you are watching is not marked", async () => {
    const { p, A } = away();
    p.current = A;
    await p.updateUnread([S(A_ID, "idle", [11], ago(60_000))], []);
    await p.updateUnread([S(A_ID, "idle", [11], ago(0))], []);
    assert.deepEqual(p.unreadIds(), []);
  });

  it("the same stop seen again adds no mark after you cleared it", async () => {
    const { p } = away();
    const now = [S(A_ID, "idle", [11], ago(1000))];
    await p.updateUnread([S(A_ID, "idle", [11], ago(60_000))], []);
    await p.updateUnread(now, []);
    p.markSeen({ ids: [A_ID] });
    await p.updateUnread(now, []);
    assert.deepEqual(p.unreadIds(), []);
  });

  it("the Atlas tab is in front only for the page that asks from it", () => {
    const p = host();
    const mine = {}, other = {};
    p.current = { view: { getViewType: () => "session-atlas", frame: { contentWindow: mine },
                          containerEl: { ownerDocument: { hasFocus: () => true } } } };
    assert.equal(p.atlasInFront(mine), true);
    assert.equal(p.atlasInFront(other), false);
  });
});

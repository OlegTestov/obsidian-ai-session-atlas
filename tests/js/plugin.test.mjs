// The Obsidian plugin bridge without Obsidian.
//
// The key property: commands run only on messages from the catalog. The catalog page shows text from
// other sessions, and a foreign origin must not be able to start anything.
//
// The sources are tested by default; ATLAS_PLUGIN_BUNDLE=<built main.js> runs the same checks on the
// build (bundle.test.mjs does that).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { getGlobal, setGlobal } from "./helpers/globals.mjs";
import { FIXTURES, SRC, loadSrc, pluginClass } from "./helpers/load-src.mjs";

const require = Module.createRequire(import.meta.url);

// Everything the plugin writes lands in a temp folder: its data folder, the uploads folder under
// HOME, test vaults. HOME is set before the sources load, since constants read it at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-plugin-test-"));
process.env.HOME = path.join(TMP, "home");
fs.mkdirSync(process.env.HOME);
const TEST_DATA = path.join(TMP, "data");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Stand-ins for what the plugin takes from Obsidian.
const views = {};
const intervals = [];
class FakeBase {
  constructor() {}
  registerView(type, factory) { views[type] = factory; }
  addRibbonIcon(icon, title) { (this.ribbons = this.ribbons || []).push({ icon, title }); }
  addCommand(c) { (this.commands = this.commands || []).push(c); }
  addSettingTab(tab) { this.settingTab = tab; }
  registerEvent() {}
  register() {}
  registerInterval(id) { intervals.push(id); return id; }
  registerDomEvent(target, type, fn, options) {
    (this.domEvents = this.domEvents || []).push({ target, type, fn, options });
  }
  async loadData() { return this.stored || null; }
  async saveData(data) { this.stored = data; }
}
const modals = [];
const notices = [];
const noticeObjects = [];
const lastNotice = () => noticeObjects[noticeObjects.length - 1];
// Obsidian's interface language, as getLanguage() reports it.
let obsidianLanguage = "ru";
// Real timers except the 10 s activity poll: tests never reach a live catalog server.
const window = { setTimeout, clearTimeout, clearInterval,
                      setInterval: (fn, ms) => (ms >= 10000 ? 0 : setInterval(fn, ms)),
                      addEventListener() {}, removeEventListener() {},
                      localStorage: { getItem: (k) => (k === "language" ? obsidianLanguage : null) } };
setGlobal("window", window);
let focusedWindow = true;
setGlobal("document", { addEventListener() {}, hasFocus: () => focusedWindow });
const systemNotes = [];
class FakeNotification {
  constructor(title, options) { this.title = title; this.body = options.body; systemNotes.push(this); }
}
FakeNotification.permission = "granted";
window.Notification = FakeNotification;
let windowFocusCalls = 0;
window.focus = () => { windowFocusCalls++; };
const stubs = {
  obsidian: {
    Plugin: FakeBase,
    ItemView: class { constructor(leaf) { this.leaf = leaf; } },
    View: class {},
    Modal: class {
      constructor(app) {
        this.app = app;
        const el = { empty() {}, setText() {}, createEl: () => el, createDiv: () => el,
                     addEventListener() {} };
        this.titleEl = el;
        this.contentEl = el;
      }
      open() { modals.push(this); }
      close() { this.onClose(); }
    },
    Notice: class {
      constructor(msg) {
        this.msg = msg;
        notices.push(msg);
        this.noticeEl = { listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
        noticeObjects.push(this);
      }
    },
    PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
    addIcon: () => {},
    getLanguage: () => obsidianLanguage,
    TFile: class { constructor(path) { this.path = path; } },
    Setting: class {},
  },
  electron: { remote: null },
};
const realLoad = Module._load;
Module._load = (request, parent, isMain) =>
  stubs[request] ? stubs[request] : realLoad(request, parent, isMain);

const BUNDLE = process.env.ATLAS_PLUGIN_BUNDLE ? path.resolve(process.env.ATLAS_PLUGIN_BUNDLE) : null;
const SessionAtlasPlugin = pluginClass(BUNDLE ? require(BUNDLE) : loadSrc("main"));
// Pure helpers come from the sources, also under the stand-ins (the build exports only the class).
const agents = loadSrc("agents");
const i18n = loadSrc("i18n");
const { AgentTerminalView, specialKey, canFit, applyTheme } = loadSrc("term-view");
Module._load = realLoad;
// No plugin instance in these tests writes to the real data folder.
SessionAtlasPlugin.prototype.dataDirOverride = TEST_DATA;

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const settle = (ms = 50) => delay(ms);
const sleep = settle;
const EVIL = "https://evil.example";

const plugin = new SessionAtlasPlugin();
const opened = [];
plugin.openCommandInTerminal = (command, cwd, label) => opened.push({ command, cwd, label });

const good = {
  origin: "http://127.0.0.1:8787",
  data: { source: "session-atlas", type: "resume", command: "cd '/x' && claude --resume 1",
          cwd: "/x", title: "Test" },
};

describe("catalog commands run only from the catalog", () => {
  const cases = [
    ["foreign origin", { ...good, origin: EVIL }, false],
    ["same port but https", { ...good, origin: "https://127.0.0.1:8787" }, false],
    ["no source", { ...good, data: { ...good.data, source: undefined } }, false],
    ["foreign source", { ...good, data: { ...good.data, source: "other" } }, false],
    ["unknown type", { ...good, data: { ...good.data, type: "exec" } }, false],
    ["empty command", { ...good, data: { ...good.data, command: "" } }, false],
    ["command is not a string", { ...good, data: { ...good.data, command: { toString: () => "rm" } } }, false],
    ["empty message", { origin: good.origin, data: null }, false],
    ["own resume", good, true],
    ["own new-session", { ...good, data: { ...good.data, type: "new-session" } }, true],
  ];
  for (const [name, event, shouldRun] of cases) {
    it(`${name}: ${shouldRun ? "runs" : "is rejected"}`, () => {
      const before = opened.length;
      plugin.handleMessage(event);
      assert.equal(opened.length > before, shouldRun);
    });
  }

  it("passes the command unchanged", () => {
    assert.equal(opened[0].command, good.data.command);
  });

  it("passes the working folder", () => {
    assert.equal(opened[0].cwd, "/x");
  });
});

describe("plugin sources", () => {
  // The embedded page may use fetch; only the plugin's own sources are checked.
  const source = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");

  it("the health probe goes through node http, not fetch", () => {
    // From Obsidian a fetch is cross-origin (app:// scheme), and the server rejects it by Origin.
    assert.ok(!/fetch\(/.test(source), "the health probe must use node http, not fetch");
    assert.ok(/from "http"/.test(source), "the plugin must use node http");
  });

  it("the catalog tab has no extra scrollbar", () => {
    // An inline iframe adds an outer 4 px scrollbar (measured: 304 vs 300).
    const css = fs.readFileSync(path.join(SRC, "..", "styles.css"), "utf8");
    assert.ok(/\.session-atlas-frame \{[^}]*display: block/.test(css), "the catalog iframe is a block");
    assert.ok(/\.session-atlas-view \{[^}]*overflow: hidden/.test(css), "the container does not scroll");
    assert.ok(/"session-atlas-frame"/.test(source) && /"session-atlas-view"/.test(source), "the classes are set on the elements");
  });

  it("rendering is guarded against overlap", () => {
    // Two overlapping async renders would each draw an error block.
    assert.ok(/this\.rendering/.test(source));
  });
});

// --- the Active view: terminal tab list, focusing and closing with confirmation ---

const terminalLeaf = (pid, title) => ({
  view: {
    emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({ pid, stdin: { write() {} } }) }) },
    getDisplayText: () => title,
  },
  detached: false,
  detach() { this.detached = true; },
});
const hungLeaf = { view: { emulator: { pseudoterminal: new Promise(() => {}) },
                           getDisplayText: () => "hung" }, detach() {} };
const leafA = terminalLeaf(5001, "Claude A");
const leafB = terminalLeaf(5002, "Claude B");
const otherLeaf = { view: { getDisplayText: () => "Note" }, detach() {} };
let leaves = [leafA, hungLeaf, leafB];
const workspace = { active: null, revealed: null };
plugin.app = {
  plugins: { enabledPlugins: new Set(["terminal"]) },
  workspace: {
    getLeavesOfType: (type) => (type === "terminal:terminal" ? leaves
      : type === "session-atlas-terminal" ? [] : [otherLeaf]),
    setActiveLeaf: (leaf) => { workspace.active = leaf; },
    revealLeaf: (leaf) => { workspace.revealed = leaf; },
    // Stands in for Obsidian: the active view's leaf is whatever a test sets as activeLeaf.
    getActiveViewOfType() { return this.activeLeaf ? { leaf: this.activeLeaf } : null; },
  },
};
plugin.pendingCloseConfirms = new WeakSet();

const replies = [];
const frame = { postMessage: (msg, origin) => replies.push({ msg, origin }) };
const msg = (data, origin = good.origin) =>
  ({ origin, source: frame, data: { source: "session-atlas", ...data } });
const lastReply = () => replies[replies.length - 1].msg;
const healthOf = async () => (await plugin.terminalReport()).health;

describe("Active view: terminal tabs", () => {
  it("lists only terminals with a live PTY", async () => {
    plugin.handleMessage(msg({ type: "list-tabs" }));
    await settle(1200);   // a hung tab drops out by timeout instead of blocking the reply
    const tabs = replies.length ? replies[0].msg.tabs : [];
    assert.deepEqual(tabs.map((t) => t.ptyPid), [5001, 5002]);
  });

  it("replies only to the catalog origin", () => {
    assert.equal(replies[0] && replies[0].origin, good.origin);
  });

  it("marks the reply with the host source", () => {
    assert.equal(replies[0] && replies[0].msg.source, "session-atlas-host");
  });

  it("reports the terminal link as working", () => {
    const health = replies[0] && replies[0].msg.health;
    assert.ok(health);
    assert.equal(health.ok, true);
    assert.equal(health.reason, null);
  });

  // The link breaks for a clear reason, and the page shows it.
  it("link: the Terminal plugin is not required", async () => {
    leaves = [leafA, leafB];
    plugin.app.plugins.enabledPlugins.delete("terminal");
    const h = await healthOf();
    plugin.app.plugins.enabledPlugins.add("terminal");
    assert.ok(h.ok, JSON.stringify(h));
  });

  it("link: tabs without a process", async () => {
    leaves = [hungLeaf];
    const h = await healthOf();
    assert.equal(h.ok, false);
    assert.match(h.reason, /не отдают процесс/);
  });

  it("link: a terminal without input", async () => {
    const mute = { view: { emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({ pid: 5003 }) }) },
                           getDisplayText: () => "no input" } };
    leaves = [mute];
    const h = await healthOf();
    assert.equal(h.ok, false);
    assert.match(h.reason, /не принимает ввод/);
  });

  it("link: no tabs still means a working link", async () => {
    leaves = [];
    const h = await healthOf();
    assert.ok(h.ok);
    assert.match(h.reason, /вкладок терминала нет/);
  });

  it("link: the reason is in English when Obsidian is English", async () => {
    // The reason is in the plugin's language: the page shows it as is.
    obsidianLanguage = "en";
    const h = await healthOf();
    obsidianLanguage = "ru";
    leaves = [leafA, leafB];
    assert.ok(h.ok);
    assert.equal(h.reason, "no terminal tabs");
  });

  it("a foreign origin gets no tab list", async () => {
    plugin.handleMessage(msg({ type: "list-tabs" }, EVIL));
    await settle();
    assert.equal(replies.length, 1);
  });

  it("Go to opens the right tab", async () => {
    plugin.handleMessage(msg({ type: "focus-tab", ptyPid: 5002 }));
    await settle();
    assert.equal(workspace.active, leafB);
    assert.equal(workspace.revealed, leafB);
  });

  it("a non-numeric or system PID is ignored", async () => {
    workspace.active = null;
    plugin.handleMessage(msg({ type: "focus-tab", ptyPid: "5002" }));
    plugin.handleMessage(msg({ type: "focus-tab", ptyPid: 1 }));
    await settle();
    assert.equal(workspace.active, null);
  });

  it("Close asks first", async () => {
    plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5001, title: "Session A" }));
    await settle();
    assert.equal(modals.length, 1);
    assert.equal(leafA.detached, false);
  });

  it("a second click opens no second dialog", async () => {
    plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5001, title: "Session A" }));
    await settle();
    assert.equal(modals.length, 1);
  });

  it("the dialog names the session", () => {
    assert.match(modals[0].text, /Session A/);
  });

  it("Keep leaves the tab open", () => {
    modals[0].close();
    assert.equal(leafA.detached, false);
  });

  it("the dialog opens again after Keep", async () => {
    plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5001, title: "Session A" }));
    await settle();
    assert.equal(modals.length, 2);
  });

  it("confirming closes exactly this tab", () => {
    modals[1].confirmed = true;
    modals[1].close();
    assert.equal(leafA.detached, true);
    assert.equal(leafB.detached, false);
  });

  it("a PID without our tab: no dialog, no close", async () => {
    plugin.handleMessage(msg({ type: "close-tab", ptyPid: 4242, title: "foreign" }));
    await settle();
    assert.equal(modals.length, 2);
    assert.ok(notices.some((n) => /уже закрыта/.test(n)), JSON.stringify(notices));
  });

  it("a foreign origin cannot close", async () => {
    plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5002 }, EVIL));
    await settle();
    assert.equal(modals.length, 2);
    assert.equal(leafB.detached, false);
  });
});

// --- quick reply: text is typed into the tab as if by hand ---

const typed = [];
const typingLeaf = {
  view: {
    emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({
      pid: 6001, stdin: { write: (chunk) => typed.push(chunk) } }) }) },
    getDisplayText: () => "Claude C",
  },
  detach() {},
};
let onType = null;                 // the tab's screen reacts to key presses, like a live CLI
// A tab with an open dialog accepts input too: the refusal must come from the status, not the tab.
const dialogLeaf = {
  view: {
    emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({
      pid: 6002, stdin: { write: (chunk) => { typed.push(chunk); if (onType) onType(chunk); } } }) }) },
    getDisplayText: () => "Claude D",
  },
  detach() {},
};
const parents = { 7001: 7000, 7000: 6001, 6001: 900, 8001: 6002, 6002: 900, 9001: 5002 };
const sessionStates = { 7001: { sessionId: "sess-c", status: "idle" },
                        8001: { sessionId: "sess-b", status: "waiting", waitingFor: "input needed" },
                        9001: { sessionId: "sess-e", status: "idle" } };
const sendMsg = (extra, origin) => msg(Object.assign({ type: "send-text", ptyPid: 6001,
  claudePid: 7001, sessionId: "sess-c", text: "проверь тесты", nonce: "n" }, extra), origin);

/** Sends a message and reports what came back and what was typed into the tab. */
async function exchange(message, wait) {
  typed.length = 0;
  const before = replies.length;
  plugin.handleMessage(message);
  await settle(wait);
  return { reply: replies.length > before ? lastReply() : null, typed: typed.slice() };
}
/** A reply of this type with this verdict, and exactly these keys typed. */
function expectReply(r, type, ok, keys) {
  assert.ok(r.reply, "no reply");
  if (type) assert.equal(r.reply.type, type);
  assert.equal(r.reply.ok, ok, r.reply.reason);
  assert.deepEqual(r.typed, keys);
}
/** A foreign origin: no reply and nothing typed. */
function expectSilence(r) {
  assert.equal(r.reply, null);
  assert.deepEqual(r.typed, []);
}

describe("quick reply", () => {
  before(() => {
    leaves = [typingLeaf, dialogLeaf, leafB];
    plugin.parentPid = (pid) => parents[pid] || 0;
    plugin.readSessionState = (pid) => sessionStates[pid] || null;
  });
  // Enter follows the paste after a pause.
  const send = (extra, origin) => exchange(sendMsg(extra, origin), 650);
  const cases = [
    ["one line: text, then Enter", {}, true, ["проверь тесты", "\r"]],
    ["multi-line: as a paste, then Enter", { text: "раз\nдва" }, true, ["\x1b[200~раз\nдва\x1b[201~", "\r"]],
    ["control characters are stripped", { text: "\x03стоп\x1b[2J" }, true, ["стоп[2J", "\r"]],
    ["dialog open (waiting): refused", { ptyPid: 6002, claudePid: 8001, sessionId: "sess-b" }, false, []],
    ["process not from this tab: refused", { claudePid: 9001, sessionId: "sess-e" }, false, []],
    ["another session in the process file: refused", { sessionId: "other" }, false, []],
    ["empty message: refused", { text: "   " }, false, []],
    ["too long: refused", { text: "я".repeat(20001) }, false, []],
    ["no such tab: refused", { ptyPid: 4242 }, false, []],
    ["PID as a string: refused", { claudePid: "7001" }, false, []],
  ];
  for (const [name, extra, ok, keys] of cases) {
    it(name, async () => expectReply(await send(extra), null, ok, keys));
  }
  it("foreign origin: no reply, no input", async () => expectSilence(await send({}, EVIL)));

  it("the reply carries the request nonce", () => {
    assert.equal(lastReply().nonce, "n");
  });

  // Images: only from the catalog's uploads folder and only existing files.
  describe("images", () => {
    const uploads = path.join(plugin.dataDir(), "uploads");
    const pic = path.join(uploads, "test-plugin-bridge.png");
    const outside = path.join(TMP, "outside.png");
    before(() => {
      assert.ok(uploads.startsWith(TMP), "the uploads folder must be inside the temp folder");
      fs.mkdirSync(uploads, { recursive: true });
      fs.writeFileSync(pic, "png");
      fs.writeFileSync(outside, "png");
    });
    const imageCases = [
      ["image: path as a separate paste, then the text", () => ({ images: [pic], text: "что тут?" }), true,
       () => ["\x1b[200~" + pic + "\x1b[201~ ", "что тут?", "\r"]],
      ["image only, no text", () => ({ images: [pic], text: "" }), true, () => ["\x1b[200~" + pic + "\x1b[201~ ", "\r"]],
      ["image outside the uploads folder: refused", () => ({ images: [outside] }), false, () => []],
      ["escaping the folder with ..: refused",
       () => ({ images: [path.join(uploads, "..", "..", "outside.png")] }), false, () => []],
      ["missing image: refused", () => ({ images: [path.join(uploads, "missing.png")] }), false, () => []],
      ["not an image by extension: refused", () => ({ images: [pic.replace(".png", ".sh")] }), false, () => []],
      ["more than five images: refused", () => ({ images: Array(6).fill(pic) }), false, () => []],
    ];
    for (const [name, extra, ok, keys] of imageCases) {
      it(name, async () => expectReply(await send(extra()), null, ok, keys()));
    }
  });
});

// --- answering a dialog from the card: the tab's screens are real snapshots of a live Claude Code ---

const screens = readJson("dialog_screens.json");
let screen = screens.bash;
const dialogMsg = (type, extra, origin) => msg(Object.assign({ type, ptyPid: 6002,
  claudePid: 8001, sessionId: "sess-b", nonce: "d" }, extra), origin);
const ask = async (extra) => (await exchange(dialogMsg("read-dialog", extra), 50)).reply;
const press = (extra, origin) => exchange(dialogMsg("answer-dialog", extra, origin), 50);
const note = "Используй printf вместо echo, а файл положи в /tmp/claude-501/probe2 — и добавь проверку, "
  + "что он создан, командой test -f; это длинное замечание";

/** Plan feedback: the screen changes in response to typed keys as listed in reactions. */
async function feedback(reactions, expectOk, extra) {
  screen = screens.plan;
  onType = (chunk) => { if (reactions[chunk] !== undefined) screen = reactions[chunk]; };
  const r = await exchange(dialogMsg("answer-dialog", Object.assign({ option: 3, text: "Tell Claude what to change",
                                                                      feedback: note }, extra)),
                           expectOk ? 400 : 3500);
  onType = null;
  return r;
}

describe("dialog answers", () => {
  before(() => {
    dialogLeaf.view.emulator.terminal = {
      get rows() { return screen.length; },
      buffer: { active: { baseY: 0, getLine: (i) => ({ translateToString: () => screen[i] }) } },
    };
  });

  it("Bash dialog: title, command, three options", async () => {
    const seen = await ask();
    assert.equal(seen && seen.type, "dialog");
    assert.equal(seen.dialog.title, "Bash command");
    assert.equal(seen.dialog.details[0], "touch /tmp/claude-501/probeA");
    assert.equal(seen.dialog.options.map((o) => o.text).join("|"),
                 "Yes|Yes, and always allow access to /tmp/claude-501 from this project|No");
  });
  it("Yes: one digit, no Enter", async () => expectReply(await press({ option: 1, text: "Yes" }), "answered", true, ["1"]));
  it("No: digit 3", async () => expectReply(await press({ option: 3, text: "No" }), "answered", true, ["3"]));
  it("label mismatch: refused", async () =>
    expectReply(await press({ option: 1, text: "Yes, and always" }), "answered", false, []));
  it("number not on screen: refused", async () =>
    expectReply(await press({ option: 4, text: "No" }), "answered", false, []));
  it("number as a string: refused", async () =>
    expectReply(await press({ option: "1", text: "Yes" }), "answered", false, []));
  it("foreign origin: no reply, no key press", async () =>
    expectSilence(await press({ option: 1, text: "Yes" }, EVIL)));
  it("another session id: refused", async () =>
    expectReply(await press({ option: 1, text: "Yes", sessionId: "other" }), "answered", false, []));
  it("edit dialog: No is digit 3 too", async () => {
    screen = screens.edit;
    expectReply(await press({ option: 3, text: "No" }), "answered", true, ["3"]);
  });
  it("edit dialog option 2: the full wrapped label", async () => {
    const text = "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)";
    expectReply(await press({ option: 2, text }), "answered", true, ["2"]);
  });
  it("Bash option 2 on the edit screen: refused", async () => {
    const text = "Yes, and always allow access to /tmp/claude-501 from this project";
    expectReply(await press({ option: 2, text }), "answered", false, []);
  });
  it("question: options without Type something and Chat about this", async () => {
    screen = screens.question;
    const seen = await ask();
    assert.equal(seen.dialog.kind, "question");
    assert.equal(seen.dialog.title, "Colour");
    assert.equal(seen.dialog.question, "Which colour do you prefer?");
    assert.equal(seen.dialog.options.map((o) => o.text).join("|"), "Red|Blue");
    assert.equal(seen.dialog.options[1].detail, "Cool, calm, serene");
  });
  it("question: Blue is digit 2", async () =>
    expectReply(await press({ option: 2, text: "Blue" }), "answered", true, ["2"]));
  it("several questions: answered only in the tab", async () => {
    screen = screens.multi;
    const seen = await ask();
    assert.ok(seen.dialog);
    assert.equal(seen.dialog.answerable, false);
    assert.equal(seen.dialog.title, "Colour · Fruits");
    assert.match(seen.dialog.reason, /^(Несколько вопросов разом|Several questions at once)/);
  });
  it("several questions: key press refused", async () =>
    expectReply(await press({ option: 1, text: "Red" }), "answered", false, []));

  // Leaving plan mode, real screens: the dialog, the cursor in the feedback field, the typed text.
  it("plan: approval by buttons, the feedback field apart, the plan path", async () => {
    screen = screens.plan;
    const seen = await ask();
    assert.equal(seen.dialog.kind, "plan");
    assert.match(seen.dialog.title, /^(План готов|Plan ready)$/);
    assert.equal(seen.dialog.options.map((o) => o.text).join("|"), "Yes, auto-accept edits|Yes, manually approve edits");
    assert.equal(seen.dialog.feedback.n, 3);
    assert.equal(seen.dialog.feedback.typed, "");
    assert.ok(!seen.dialog.feedback.selected);
    assert.match(seen.dialog.planPath, /^~\/\.claude\/plans\/plan-how-to-create-[\w-]+\.md$/);
  });
  it("plan: proceed is digit 1", async () =>
    expectReply(await press({ option: 1, text: "Yes, auto-accept edits" }), "answered", true, ["1"]));
  it("plan feedback: digit, text, screen check, Enter", async () =>
    expectReply(await feedback({ 3: screens.plan_selected, [note]: screens.plan_typed }, true), null, true,
                ["3", note, "\r"]));
  it("plan feedback: the field did not open, the text is not typed", async () =>
    expectReply(await feedback({}, false), null, false, ["3"]));
  it("plan feedback: other text on screen, Enter is not pressed", async () =>
    expectReply(await feedback({ 3: screens.plan_selected }, false), null, false, ["3", note]));
  it("plan feedback for another option number: refused", async () =>
    expectReply(await feedback({}, false, { option: 1 }), null, false, []));
  it("plan feedback: line breaks become one line", async () =>
    expectReply(await feedback({ 3: screens.plan_selected, [note]: screens.plan_typed }, true,
                               { feedback: note.replace(", а файл", ",\nа файл") }), null, true, ["3", note, "\r"]));

  // A numbered list in Claude's answer under the rule is not a dialog without the "Esc to cancel" footer.
  it("a list without the dialog footer is not a dialog", async () => {
    screen = screens.question.filter((l) => !/Esc to cancel/.test(l)).concat(["❯ ", "? for shortcuts"]);
    const seen = await ask();
    assert.equal(seen.dialog, null);
  });
  it("no dialog on screen: an honest reason", async () => {
    screen = ["❯ ", "? for shortcuts"];
    const seen = await ask();
    assert.equal(seen.dialog, null);
    assert.match(seen.reason, /не разобран/);
  });
  it("session not waiting: no dialog", async () => {
    sessionStates[8001].status = "idle";
    screen = screens.bash;
    const seen = await ask();
    assert.equal(seen.dialog, null);
    assert.match(seen.reason, /диалога нет/);
  });
  it("session not waiting: the reason in English", async () => {
    obsidianLanguage = "en";
    const seen = await ask();
    obsidianLanguage = "ru";
    assert.equal(seen.dialog, null);
    assert.equal(seen.reason, "no dialog");
  });
  it("session not waiting: key press refused", async () => {
    const r = await press({ option: 1, text: "Yes" });
    sessionStates[8001].status = "waiting";
    expectReply(r, "answered", false, []);
  });
});

// --- quick commands: Claude Code shows their answer on screen, not in the transcript ---

describe("quick commands", () => {
  const cmdScreens = readJson("command_screens.json");
  let typingScreen = cmdScreens.context;
  before(() => {
    typingLeaf.view.emulator.terminal = {
      get rows() { return typingScreen.length; },
      buffer: { active: { baseY: 0, getLine: (i) => ({ translateToString: () => typingScreen[i] }) } },
    };
  });
  /** Sends a slash command; returns the command-output reply, if any. */
  const run = async (text, nonce, shown) => {
    if (shown) typingScreen = shown;
    const before = replies.length;
    plugin.handleMessage(sendMsg({ text, nonce }));
    await settle(2100);                   // Enter plus time for the command to answer
    return replies.slice(before).find((r) => r.msg.type === "command-output") || null;
  };
  const expectOutput = (out, nonce) => {
    assert.ok(out, "no command-output reply");
    assert.equal(out.origin, good.origin);
    assert.equal(out.msg.nonce, nonce);
  };

  it("/context: the report from the screen", async () => {
    const out = await run("/context", "c-context", cmdScreens.context);
    expectOutput(out, "c-context");
    assert.ok(!out.msg.panel);
    assert.match(out.msg.text, /Memory files/);
    assert.doesNotMatch(out.msg.text, /❯/);
  });
  it("/usage: a panel", async () => {
    const out = await run("/usage", "c-usage", cmdScreens.usage);
    expectOutput(out, "c-usage");
    assert.ok(out.msg.panel);
    assert.match(out.msg.text, /Total cost/);
  });
  it("/effort low: the answer without the ⎿ mark", async () => {
    const out = await run("/effort low", "c-effort-low", cmdScreens["effort-low"]);
    expectOutput(out, "c-effort-low");
    assert.match(out.msg.text, /^Set effort level to low/);
  });
  it("/goal: the No goal set panel", async () => {
    const out = await run("/goal", "c-goal", cmdScreens.goal);
    expectOutput(out, "c-goal");
    assert.ok(out.msg.panel);
    assert.match(out.msg.text, /No goal set/);
  });
  it("a plain message does not read the screen", async () => {
    typed.length = 0;
    assert.equal(await run("обычный запрос", "plain"), null);
  });
  it("/compact: the answer is in the transcript, the screen is not read", async () => {
    assert.equal(await run("/compact", "cmp"), null);
  });

  // A panel open in the tab goes to the card as text; Esc closes it.
  it("/effort panel: as text, without option buttons", async () => {
    screen = cmdScreens.effort;
    const seen = await ask();
    screen = screens.bash;
    assert.ok(seen.dialog);
    assert.equal(seen.dialog.kind, "panel");
    assert.match(seen.dialog.panel, /Faster/);
    assert.equal(seen.dialog.answerable, false);
  });
});

// --- Stop: exactly one Esc, only for a working session or one waiting in a dialog ---

describe("stop", () => {
  const stop = (extra, origin) => exchange(msg(Object.assign({ type: "interrupt", ptyPid: 6001, claudePid: 7001,
    sessionId: "sess-c", nonce: "s" }, extra), origin), 50);
  const withStatus = async (status, fn) => {
    sessionStates[7001].status = status;
    try { return await fn(); } finally { sessionStates[7001].status = "idle"; }
  };

  it("working: one Esc", async () =>
    expectReply(await withStatus("busy", () => stop({})), "stopped", true, ["\x1b"]));
  it("running a command: one Esc", async () =>
    expectReply(await withStatus("shell", () => stop({})), "stopped", true, ["\x1b"]));
  it("idle: refused (a second Esc would open rewind)", async () =>
    expectReply(await withStatus("idle", () => stop({})), "stopped", false, []));
  it("dialog: Esc closes it", async () =>
    expectReply(await stop({ ptyPid: 6002, claudePid: 8001, sessionId: "sess-b" }), "stopped", true, ["\x1b"]));
  it("another session id: refused", async () =>
    expectReply(await withStatus("busy", () => stop({ sessionId: "other" })), "stopped", false, []));
  it("process not from this tab: refused", async () =>
    expectReply(await withStatus("busy", () => stop({ claudePid: 9001, sessionId: "sess-e" })), "stopped", false, []));
  it("foreign origin: no reply, no Esc", async () =>
    expectSilence(await withStatus("busy", () => stop({}, EVIL))));
});

// --- notifications: a session finished its turn and waits for you ---

describe("notifications", () => {
  const ses = (id, activity, extra) => Object.assign({ session_id: id, title: "Сессия " + id,
    activity, ancestors: [] }, extra);
  let served = null;
  const headers = [];
  const poll = async (sessions) => { served = { sessions }; notices.length = 0; await plugin.pollActive(); };
  before(() => {
    leaves = [leafA, leafB];
    plugin.fetchActive = async () => served;
    plugin.settings = { notify: true };
    plugin.lastActivity = null;
    const atlasLeaf = { updateHeader() { headers.push(plugin.waitingCount); } };
    const baseLeaves = plugin.app.workspace.getLeavesOfType;
    plugin.app.workspace.getLeavesOfType = (type) =>
      (type === "session-atlas" ? [atlasLeaf] : baseLeaves(type));
  });
  const busyThenIdle = async () => {
    await poll([ses("a", "busy", { ancestors: [5001] })]);
    await poll([ses("a", "idle", { ancestors: [5001] })]);
  };

  it("the first poll is silent; the counter counts waiting sessions", async () => {
    await poll([ses("a", "busy"), ses("b", "idle"), ses("c", "background")]);
    assert.equal(notices.length, 0);
    assert.equal(plugin.waitingCount, 1);
  });
  it("the counter goes to the catalog tab title", () => {
    assert.equal(headers[headers.length - 1], 1);
  });
  it("working → waiting: a notification", async () => {
    await poll([ses("a", "idle", { ancestors: [4000, 5001] }), ses("b", "idle"), ses("c", "busy")]);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Сессия a/);
    assert.match(notices[0], /перейти/);
  });
  it("the counter is recalculated", () => {
    assert.equal(plugin.waitingCount, 2);
  });
  it("clicking the notification opens the session's tab", async () => {
    workspace.active = null;
    lastNotice().noticeEl.listeners.forEach((fn) => fn());
    await settle();
    assert.equal(workspace.active, leafA);
  });
  it("a dialog notifies; a new session (even in a dialog) does not", async () => {
    await poll([ses("a", "idle"), ses("b", "idle"), ses("c", "waiting"), ses("d", "waiting")]);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /диалоге/);
  });
  it("no changes: no notifications", async () => {
    await poll([ses("a", "idle"), ses("b", "idle"), ses("c", "waiting"), ses("d", "waiting")]);
    assert.equal(notices.length, 0);
  });
  it("notifications off: silent, the counter still works", async () => {
    plugin.settings.notify = false;
    await poll([ses("a", "busy"), ses("b", "idle"), ses("c", "waiting"), ses("d", "idle")]);
    await poll([ses("a", "idle"), ses("b", "idle"), ses("c", "waiting"), ses("d", "idle")]);
    plugin.settings.notify = true;
    assert.equal(notices.length, 0);
    assert.equal(plugin.waitingCount, 4);
  });
  it("the server did not answer: the counter is kept", async () => {
    served = null;
    await plugin.pollActive();
    assert.equal(plugin.waitingCount, 4);
  });
  it("looking at this tab: no notification", async () => {
    workspace.active = null;
    plugin.app.workspace.activeLeaf = leafA;
    await busyThenIdle();
    plugin.app.workspace.activeLeaf = null;
    assert.equal(notices.length, 0);
  });

  // The Obsidian window is not in front: a notice inside it goes unseen, so macOS shows one too.
  it("window in front: only the Obsidian notice", async () => {
    plugin.settings.systemNotify = true;
    focusedWindow = true;
    systemNotes.length = 0;
    await busyThenIdle();
    assert.equal(notices.length, 1);
    assert.equal(systemNotes.length, 0);
  });
  it("window not in front: a macOS notification too", async () => {
    focusedWindow = false;
    await busyThenIdle();
    assert.equal(systemNotes.length, 1);
    assert.match(systemNotes[0].body, /Сессия a/);
    assert.doesNotMatch(systemNotes[0].body, /^Session Atlas:/);
  });
  it("clicking the macOS notification: the window and the session's tab", async () => {
    workspace.active = null;
    systemNotes[0].onclick();
    await settle();
    assert.ok(windowFocusCalls > 0);
    assert.equal(workspace.active, leafA);
  });
  it("window not in front: notifies even when the tab is active", async () => {
    plugin.app.workspace.activeLeaf = leafA;
    await busyThenIdle();
    plugin.app.workspace.activeLeaf = null;
    assert.equal(systemNotes.length, 2);
  });
  it("system notifications off: only Obsidian's", async () => {
    plugin.settings.systemNotify = false;
    await busyThenIdle();
    plugin.settings.systemNotify = true;
    assert.equal(systemNotes.length, 2);
    assert.equal(notices.length, 1);
  });
  it("macOS denied notifications: no error", async () => {
    FakeNotification.permission = "denied";
    try {
      await busyThenIdle();
    } finally {
      FakeNotification.permission = "granted";
      focusedWindow = true;
    }
    assert.equal(systemNotes.length, 2);
    assert.equal(notices.length, 1);
  });
});

// --- starting the server from the page ---

describe("start server from the page", () => {
  const raised = [];
  let ensureCalls = 0;
  let ensureResult = true;
  const raiseFrame = { postMessage: (m, origin) => raised.push({ m, origin }) };
  const raiseMsg = (origin = good.origin) => plugin.handleMessage({ origin, source: raiseFrame,
    data: { source: "session-atlas", type: "ensure-server" } });
  before(() => {
    plugin.ensureServer = async () => { ensureCalls++; await settle(30); return ensureResult; };
  });

  it("one start on a double click", async () => {
    raiseMsg();
    raiseMsg();
    await settle(80);
    assert.equal(ensureCalls, 1);
  });
  it("replies to the catalog", () => {
    assert.equal(raised.length, 1);
    assert.equal(raised[0].m.type, "server-ensured");
    assert.equal(raised[0].m.ok, true);
    assert.equal(raised[0].origin, good.origin);
  });
  it("a failure comes with a reason", async () => {
    ensureResult = false;
    raiseMsg();
    await settle(80);
    assert.equal(raised[1].m.ok, false);
    assert.match(raised[1].m.reason, /не поднял/);
  });
  it("a foreign origin starts nothing", async () => {
    raiseMsg(EVIL);
    await settle(80);
    assert.equal(ensureCalls, 2);
    assert.equal(raised.length, 2);
  });
});

// --- after an Obsidian restart: bring back sessions that were open in tabs ---

describe("restore after restart", () => {
  const restoring = new SessionAtlasPlugin();
  const restoreReplies = [];
  const restoreFrame = { postMessage: (m, origin) => restoreReplies.push({ m, origin }) };
  const listRestorable = (origin) => restoring.handleMessage({ origin, source: restoreFrame,
    data: { source: "session-atlas", type: "list-restorable" } });
  before(async () => {
    const stamp = Date.now();
    restoring.stored = { openSessions: [
      { session_id: "r1", title: "Ремонт сборки", at: stamp - 60e3 },
      { session_id: "r2", title: "Жива и сейчас", at: stamp - 60e3 },
      { session_id: "r3", title: "Давняя", at: stamp - 5 * 24 * 3600e3 }] };
    restoring.app = { workspace: { on: () => null, onLayoutReady: () => {},
      getLeavesOfType: (type) => (type === "terminal:terminal" ? [leafA] : []) } };
    await restoring.onload();
  });

  it("for the first 20 s the list is not ready: tabs bring their sessions back themselves", async () => {
    const alive = [{ session_id: "r2", title: "Жива и сейчас", ancestors: [5001] },
                   { session_id: "r9", title: "Не во вкладке", ancestors: [] }];
    restoring.fetchActive = async () => ({ sessions: alive });
    await restoring.pollActive();
    const graceReplies = [];
    restoring.replyRestorable({ postMessage: (m) => graceReplies.push(m) });
    assert.ok(graceReplies[0]);
    assert.equal(graceReplies[0].ready, false);
  });
  it("closed sessions are offered; live and old ones are not", () => {
    restoring.loadedAt = Date.now() - 30000;
    assert.deepEqual(restoring.restorable.map((x) => x.session_id), ["r1"]);
  });
  it("currently open sessions are remembered", () => {
    assert.deepEqual(restoring.stored.openSessions.map((x) => x.session_id), ["r2"]);
  });
  it("the list goes only to the catalog", () => {
    listRestorable(good.origin);
    assert.equal(restoreReplies.length, 1);
    assert.equal(restoreReplies[0].origin, good.origin);
    assert.equal(restoreReplies[0].m.type, "restorable");
    assert.equal(restoreReplies[0].m.ready, true);
    assert.equal(restoreReplies[0].m.sessions[0].title, "Ремонт сборки");
  });
  it("a foreign origin gets no list", () => {
    listRestorable(EVIL);
    assert.equal(restoreReplies.length, 1);
  });
  it("a session closed by hand is not remembered", async () => {
    // Closed while Obsidian was running: nothing to restore after a restart.
    restoring.fetchActive = async () => ({ sessions: [] });
    await restoring.pollActive();
    assert.equal(restoring.stored.openSessions.length, 0);
  });
  it("not needed: forget it", () => {
    restoring.handleMessage({ origin: good.origin, source: restoreFrame,
      data: { source: "session-atlas", type: "forget-restorable", sessionIds: ["r1"] } });
    assert.equal(restoring.restorable.length, 0);
    assert.equal(restoreReplies[restoreReplies.length - 1].m.sessions.length, 0);
  });
});

// Loading the plugin: settings, the settings tab, polling after layout, the tab title.
describe("plugin load", () => {
  const fresh = new SessionAtlasPlugin();
  let layoutReady = null;
  let view = null;
  before(async () => {
    fresh.stored = { notify: false };
    fresh.app = { workspace: { on: () => null, onLayoutReady: (fn) => { layoutReady = fn; },
                               getLeavesOfType: () => [] } };
    fresh.fetchActive = async () => null;
    await fresh.onload();
  });

  it("settings are read from data.json", () => {
    assert.equal(fresh.settings.notify, false);
  });
  it("system notifications are on by default", () => {
    assert.equal(fresh.settings.systemNotify, true);
  });
  it("has a settings tab", () => {
    assert.ok(fresh.settingTab);
  });
  it("polling starts after layout", () => {
    assert.equal(typeof layoutReady, "function");
  });
  it("polling is registered as a plugin interval", () => {
    layoutReady();
    assert.equal(intervals.length, 1);
  });
  it("tab title: Session Atlas (3)", () => {
    view = views["session-atlas"]({}, fresh);
    fresh.waitingCount = 3;
    assert.equal(view.getDisplayText(), "Session Atlas (3)");
  });
  it("no waiting sessions: plain Session Atlas", () => {
    fresh.waitingCount = 0;
    assert.equal(view.getDisplayText(), "Session Atlas");
  });
});

// --- agent tabs, close guard, file explorer, languages ---

describe("catalog command parsing", () => {
  const ID = "6e4043ad-81c1-49a2-87f4-47c469933cf3";
  // Strings exactly as shlex.quote prints them on the server (atlas/actions.py, atlas/launch.py).
  const P = agents.parseLaunch;
  it("resume", () => {
    assert.deepEqual(P(`cd '/Users/u/Library/Mobile Documents/iCloud~md~obsidian' && claude --resume ${ID}`),
                     { cwd: "/Users/u/Library/Mobile Documents/iCloud~md~obsidian", mode: "resume", sessionId: ID, prompt: "" });
  });
  it("fork", () => {
    assert.equal(P(`cd /x && claude --resume ${ID} --fork-session`).mode, "resume-fork");
  });
  it("new with a prompt; an apostrophe and $ inside quotes", () => {
    const withQuote = P(`cd /x && claude --session-id ${ID} 'it'"'"'s «новый» $HOME'`);
    assert.ok(withQuote);
    assert.equal(withQuote.mode, "new");
    assert.equal(withQuote.prompt, "it's «новый» $HOME");
  });
  it("a prompt starting with - keeps the leading space, as the server sends it", () => {
    assert.equal(P(`cd /x && claude --session-id ${ID} ' -v'`).prompt, " -v");
  });
  for (const bad of [`cd /x && claude --resume ${ID}; rm -rf ~`, `cd /x && claude --resume ${ID} && rm x`,
                     `cd /x && claude --resume $(id)`, `cd x && claude --resume ${ID}`,
                     `cd /x && claude --resume 1`, `cd /x && claude --resume ${ID} --dangerously-skip-permissions`,
                     `cd /x && codex resume ${ID}`, `cd /x '&&' claude --resume ${ID}`,
                     `cd '/x && claude --resume ${ID}`, `cd /x && claude --session-id ${ID} "a$b"`,
                     `cd /x;id && claude --resume ${ID}`, `cd /x|id && claude --resume ${ID}`]) {
    it(`rejects a foreign command: ${bad}`, () => {
      assert.equal(P(bad), null);
    });
  }
  it("tab arguments: script, agent, tab id, start, prompt, without shell expansion", () => {
    const args = agents.agentArgs("/v/config/scripts/a b.zsh", "claude", "claude-x-1",
                                  { mode: "new", sessionId: ID, prompt: "it's $HOME" });
    assert.equal(args.slice(0, 3).join(" "), "-l -i -c");
    assert.deepEqual(agents.shellWords(args[3]),
                     ["exec", "/v/config/scripts/a b.zsh", "claude", "claude-x-1", "new", ID, "it's $HOME"]);
  });
});

// Catalog → tab through the script; an unrecognized command opens directly.
describe("agent tabs", () => {
  const ID = "6e4043ad-81c1-49a2-87f4-47c469933cf3";
  const vault = path.join(TMP, "vault");
  // The vault's config folder has a custom name: the plugin must follow vault.configDir.
  const scriptPath = path.join(vault, "config", "scripts", agents.SCRIPT_NAME);
  const agentPlugin = new SessionAtlasPlugin();
  const viewStates = [];
  before(() => {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "#!/bin/zsh\n");
    agentPlugin.settings = { language: "ru" };
    agentPlugin.dataDirOverride = path.join(vault, "no-runtime");   // no extracted build: the vault copy is used
    agentPlugin.app = {
      plugins: { enabledPlugins: new Set() },                      // own terminal: Terminal is not needed
      vault: { configDir: "config", adapter: { getBasePath: () => vault } },
      workspace: { getLeaf: () => ({ setViewState: async (st) => viewStates.push(st) }),
                   getLeavesOfType: () => [], setActiveLeaf() {}, revealLeaf() {} },
    };
  });

  it("catalog: own tab through the script; session folder, label, resume start", async () => {
    await agentPlugin.openCommandInTerminal(`cd '/Users/u/Code/p' && claude --resume ${ID}`, "/Users/u/Code/p", "Demo");
    const st = viewStates.pop();
    assert.ok(st && st.state, JSON.stringify(st));
    const term = st.state;
    const w = agents.shellWords(term.command);
    assert.equal(st.type, "session-atlas-terminal");
    assert.equal(term.cwd, "/Users/u/Code/p");
    assert.equal(term.title, "Demo");
    assert.equal(term.kind, "claude");
    assert.equal(w[1], scriptPath);
    assert.equal(w[2], "claude");
    assert.equal(w[3], term.instance);
    assert.match(w[3], /^claude-/);
    assert.equal(w[4], "resume");
    assert.equal(w[5], ID);
  });
  it("catalog: an unrecognized command opens in the tab as is", async () => {
    const before = viewStates.length;
    await agentPlugin.openCommandInTerminal("cd '/x' && claude --resume 1", "/x", "old");
    const st = viewStates[viewStates.length - 1];
    assert.equal(viewStates.length, before + 1);
    assert.equal(st.type, "session-atlas-terminal");
    assert.equal(st.state.command, "cd '/x' && claude --resume 1");
    assert.equal(st.state.instance, null);
  });
  it("Codex button: Codex title, vault folder, no start", async () => {
    await agentPlugin.openAgent("codex");
    const term = viewStates[viewStates.length - 1].state;
    const w = agents.shellWords(term.command);
    assert.equal(term.title, "Codex");
    assert.equal(term.cwd, vault);
    assert.equal(term.kind, "codex");
    assert.equal(w[2], "codex");
    assert.equal(w.length, 4);
  });
  it("no script: nothing opens, and the notice says how to fix it", async () => {
    fs.rmSync(scriptPath);
    notices.length = 0;
    const openedNoScript = await agentPlugin.openAgent("claude");
    assert.equal(openedNoScript, false);
    assert.ok(notices.some((n) => /переустанови плагин|reinstall the plugin/.test(n)), JSON.stringify(notices));
  });
});

// Close guard: the close button, a middle click and ⌘W open a dialog; notes close as usual.
describe("close guard", () => {
  const guard = new SessionAtlasPlugin();
  const header = {};
  const tLeaf = { tabHeaderEl: header, view: { getViewType: () => "terminal:terminal", getDisplayText: () => "Claude" },
                  getViewState: () => ({ state: { "terminal:terminal": { profile: { name: "Claude Code" } } } }),
                  detach() { this.detached = true; } };
  const aLeaf = { tabHeaderEl: {}, view: { getViewType: () => "session-atlas" }, detach() {} };
  const nLeaf = { tabHeaderEl: {}, view: { getViewType: () => "markdown" }, detach() { this.detached = true; } };
  let active = tLeaf;
  const closeCommand = { checkCallback(checking) { if (!checking) active.detach(); return true; } };
  const ev = (headerEl, extra) => Object.assign({
    target: { closest: (sel) => (sel === ".workspace-tab-header-inner-close-button"
      ? { closest: () => headerEl } : headerEl) },
    button: 0, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {},
    stopImmediatePropagation() {} }, extra);
  const lastModal = () => modals[modals.length - 1];
  let m0 = 0;
  before(() => {
    guard.settings = { language: "ru" };
    guard.pendingCloseConfirms = new WeakSet();
    guard.app = { plugins: { enabledPlugins: new Set() }, commands: { commands: { "workspace:close": closeCommand } },
                  workspace: { iterateAllLeaves: (fn) => [tLeaf, aLeaf, nLeaf].forEach(fn), activeLeaf: null,
                               getActiveViewOfType() { return this.activeLeaf ? { leaf: this.activeLeaf } : null; },
                               getMostRecentLeaf: () => active } };
    m0 = modals.length;
  });

  it("guards terminals and the catalog, not notes", () => {
    assert.equal(guard.guardKind(tLeaf), "terminal");
    assert.equal(guard.guardKind(aLeaf), "atlas");
    assert.equal(guard.guardKind(nLeaf), null);
  });
  it("close button: pointerdown is suppressed, no dialog yet", () => {
    const down = ev(header);
    guard.onCloseButton(down, false);
    assert.ok(down.prevented);
    assert.equal(modals.length, m0);
  });
  it("close button: click opens the dialog in Russian with the profile name", () => {
    guard.onCloseButton(ev(header), true);
    const shown = lastModal();
    assert.equal(modals.length, m0 + 1);
    assert.equal(shown.title, "Закрыть вкладку с сессией?");
    assert.match(shown.text, /«Claude Code»/);
    assert.equal(shown.keepLabel, "Оставить");
  });
  it("Keep: the tab stays", () => {
    lastModal().close();
    assert.ok(!tLeaf.detached);
  });
  it("a middle click on the header opens the same dialog", () => {
    guard.onMiddleClick(ev(header, { button: 1 }));
    const count = modals.length;
    lastModal().close();
    assert.equal(count, m0 + 2);
  });
  it("⌘W on a terminal: a dialog, not a close", () => {
    guard.register = () => {};
    guard.patchCloseTabCommand();
    closeCommand.checkCallback(false);
    assert.equal(modals.length, m0 + 3);
    assert.ok(!tLeaf.detached);
  });
  it("confirmed: closed", () => {
    lastModal().confirmed = true;
    lastModal().close();
    assert.ok(tLeaf.detached);
  });
  it("⌘W on a note closes it at once", () => {
    active = nLeaf;
    closeCommand.checkCallback(false);
    assert.ok(nLeaf.detached);
    assert.equal(modals.length, m0 + 3);
  });
  it("English: the catalog dialog", () => {
    guard.settings.language = "en";
    guard.confirmClose(aLeaf);
    const shown = lastModal();
    shown.close();
    assert.equal(shown.title, "Close the Session Atlas tab?");
    assert.equal(shown.keepLabel, "Keep open");
  });
});

// File explorer: left click opens a new tab, middle the current one, an open file is focused.
describe("file explorer clicks", () => {
  const { TFile } = stubs.obsidian;
  const ex = new SessionAtlasPlugin();
  const openedFiles = [];
  let focusedLeaf = null;
  const fileLeaf = (where) => ({ openFile: async (f) => openedFiles.push([where, f.path]) });
  const openLeaf = { getViewState: () => ({ state: { file: "open.md" } }) };
  const click = (p, extra) => Object.assign({ button: 0, prevented: false,
    target: { closest: () => ({ getAttribute: () => p }) },
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} }, extra);
  before(() => {
    ex.settings = { explorerClicks: true };
    ex.app = { plugins: { enabledPlugins: new Set() },
               vault: { getAbstractFileByPath: (p) => (p.endsWith(".md") ? new TFile(p) : { path: p }) },
               workspace: { getLeaf: () => fileLeaf("new"), getMostRecentLeaf: () => fileLeaf("current"),
                            iterateAllLeaves: (fn) => [openLeaf].forEach(fn),
                            setActiveLeaf: (l) => { focusedLeaf = l; }, revealLeaf() {} } };
  });

  it("left click opens a new tab, middle click the current one", async () => {
    ex.onExplorerClick(click("a.md"), true);
    ex.onExplorerClick(click("b.md", { button: 1 }), false);
    await settle();
    assert.deepEqual(openedFiles, [["new", "a.md"], ["current", "b.md"]]);
  });
  it("an open file is not duplicated: its tab is focused", async () => {
    ex.onExplorerClick(click("open.md"), true);
    await settle();
    assert.equal(focusedLeaf, openLeaf);
    assert.equal(openedFiles.length, 2);
  });
  it("a folder and a ⌘-click behave as in Obsidian", () => {
    const folder = click("folder");
    ex.onExplorerClick(folder, true);
    const withCmd = click("c.md", { metaKey: true });
    ex.onExplorerClick(withCmd, true);
    assert.ok(!folder.prevented);
    assert.ok(!withCmd.prevented);
  });
  it("turned off: no interference", () => {
    ex.settings.explorerClicks = false;
    const off = click("d.md");
    ex.onExplorerClick(off, true);
    ex.settings.explorerClicks = true;
    assert.ok(!off.prevented);
  });
});

describe("languages", () => {
  it("the settings choice wins over Obsidian's language", () => {
    assert.equal(i18n.resolveLanguage("en", "ru"), "en");
    assert.equal(i18n.resolveLanguage("auto", "ru"), "ru");
    assert.equal(i18n.resolveLanguage("auto", "de"), "en");
  });
  it("translation: substitution and the English fallback", () => {
    assert.equal(i18n.translate("ru", "terminal.opened", { label: "X" }), "Открыто: X");
    assert.equal(i18n.translate("de", "close.keep"), "Keep open");
    assert.equal(i18n.translate("ru", "no.such.key"), "no.such.key");
  });
  it("Russian and English have the same keys", () => {
    assert.deepEqual(Object.keys(i18n.STRINGS.ru).sort(), Object.keys(i18n.STRINGS.en).sort());
  });
});

// Agents: toggles, arguments in a file for the script, Codex only when installed.
const alone = new SessionAtlasPlugin();
describe("agent settings", () => {
  const ag = new SessionAtlasPlugin();
  const argsFile = () => fs.readFileSync(path.join(TEST_DATA, "agent-args", "claude"), "utf8");
  before(async () => {
    ag.app = { plugins: { enabledPlugins: new Set() },
               workspace: { on: () => null, onLayoutReady: () => {}, getLeavesOfType: () => [] } };
    await ag.onload();
  });

  it("Codex not installed: off and its button hidden", async () => {
    // Obsidian's HTMLElement.toggle shows or hides through the display style.
    const ribbon = (i) => ({ style: {}, i, toggle(show) { this.style.display = show ? "" : "none"; } });
    ag.agentRibbons = { claude: ribbon(1), codex: ribbon(2) };
    ag.shellProbe = async () => ({ claude: "/x/claude" });          // codex is not found
    await ag.detectAgents();
    assert.equal(ag.settings.agents.codex, false);
    assert.equal(ag.agentRibbons.codex.style.display, "none");
    assert.equal(ag.agentRibbons.claude.style.display, "");
  });
  it("Codex turned on: the button and the command appear at once", () => {
    ag.settings.agents.codex = true;
    ag.refreshAgentButtons();
    const codexCommand = ag.commands.find((c) => c.id === "open-codex-terminal");
    assert.equal(ag.agentRibbons.codex.style.display, "");
    assert.equal(codexCommand.checkCallback(true), true);
  });
  it("Claude Code turned off: no palette command", () => {
    ag.settings.agents.claude = false;
    assert.equal(ag.commands.find((c) => c.id === "open-claude-code-terminal").checkCallback(true), false);
  });
  it("arguments go to the script's file as one line", () => {
    ag.settings.agentArgs = { claude: "--chrome\n--channels x", codex: "" };
    ag.writeAgentArgs();
    assert.equal(argsFile(), "--chrome --channels x\n");
  });
  it("first start: arguments from the file move into the settings, the file is kept", async () => {
    alone.app = { plugins: { enabledPlugins: new Set() },
                  workspace: { on: () => null, onLayoutReady: () => {}, getLeavesOfType: () => [] } };
    await alone.onload();
    assert.equal(alone.settings.agentArgs.claude, "--chrome --channels x");
    assert.equal(argsFile(), "--chrome --channels x\n");
  });
  it("arguments cleared in the settings: the file is emptied and they do not come back", async () => {
    alone.settings.agentArgs = { claude: "", codex: "" };
    await alone.saveData(alone.settings);
    const again = new SessionAtlasPlugin();
    again.app = alone.app;
    again.loadData = async () => ({ agentArgs: { claude: "", codex: "" } });
    await again.onload();
    assert.equal(again.settings.agentArgs.claude, "");
    assert.equal(argsFile(), "\n");
  });
});

// Reload without closing tabs: a quiet unload (not "disabled by the user") and a load.
describe("reload in place", () => {
  let reloadOther = null;
  it("quiet unload and load, without the user flag, once", async () => {
    const calls = [];
    const rp = new SessionAtlasPlugin();
    rp.manifest = { id: "session-atlas", dir: "plug" };
    rp.app = { plugins: { plugins: {}, disablePlugin: async (id, user) => { calls.push(["off", id, user]); },
                          enablePlugin: async (id) => { calls.push(["on", id]); } } };
    rp.app.plugins.plugins["session-atlas"] = rp;
    const first = rp.reloadInPlace();
    const second = rp.reloadInPlace();
    await sleep(150);
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(calls.length, 2, JSON.stringify(calls));
    assert.equal(calls[0][0], "off");
    assert.notEqual(calls[0][2], true);
    assert.equal(calls[1][0], "on");

    // Kept inside this test: it needs the same app as the instance above.
    const other = new SessionAtlasPlugin();
    other.manifest = rp.manifest;
    other.app = rp.app;
    reloadOther = () => other.reloadInPlace();
  });
  it("not the current instance: no reload", () => {
    assert.equal(reloadOther(), false);
  });

  // A new build on disk: the plugin reloads itself.
  const vaultDir = path.join(TMP, "reload-vault");
  const mainJs = path.join(vaultDir, "plug", "main.js");
  before(() => {
    fs.mkdirSync(path.join(vaultDir, "plug"), { recursive: true });
    fs.writeFileSync(mainJs, "old");
  });
  it("installed from the community directory (no .hotreload): the build is not watched", () => {
    const plain = new SessionAtlasPlugin();
    plain.manifest = { id: "session-atlas", dir: "plug" };
    plain.app = { vault: { adapter: { getBasePath: () => vaultDir } } };
    plain.register = () => { throw new Error("watching without .hotreload"); };
    assert.doesNotThrow(() => plain.watchOwnBuild());
  });
  it("a new build on disk: reloads by itself, once", async () => {
    fs.writeFileSync(path.join(vaultDir, "plug", ".hotreload"), "");
    const wp = new SessionAtlasPlugin();
    wp.manifest = { id: "session-atlas", dir: "plug" };
    wp.app = { vault: { adapter: { getBasePath: () => vaultDir } } };
    let reloads = 0;
    wp.reloadInPlace = () => { reloads++; return true; };
    wp.watchOwnBuild();
    try {
      await sleep(300);
      fs.writeFileSync(mainJs, "new build, longer");
      await sleep(4500);
    } finally {
      fs.unwatchFile(mainJs);
    }
    assert.equal(reloads, 1);
  });
});

describe("agent terminal view", () => {
  it("Shift+Enter sends ESC+Enter (a new line in Claude Code), other Enter keys as is", () => {
    assert.equal(specialKey({ key: "Enter", shiftKey: true }), "\x1b\r");
    assert.equal(specialKey({ key: "Enter" }), null);
    assert.equal(specialKey({ key: "Enter", shiftKey: true, metaKey: true }), null);
    assert.equal(specialKey({ key: "a", shiftKey: true }), null);
  });
  it("an Obsidian theme change recolours the open terminal without extra redraws", () => {
    const palette = { light: { "--background-primary": "#ffffff", "--text-normal": "#222222" },
                      dark: { "--background-primary": "#1e1e1e", "--text-normal": "#dddddd" } };
    let current = palette.light;
    const realStyle = getGlobal("getComputedStyle");
    setGlobal("getComputedStyle", () => ({ getPropertyValue: (n) => current[n] || "" }));
    const term = { options: { theme: {} } };
    let first, switched, again;
    try {
      first = applyTheme(term, {});
      current = palette.dark;
      switched = applyTheme(term, {});
      again = applyTheme(term, {});
    } finally {
      setGlobal("getComputedStyle", realStyle);
    }
    assert.equal(first, true);
    assert.equal(switched, true);
    assert.equal(again, false);
    assert.equal(term.options.theme.background, "#1e1e1e");
    assert.equal(term.options.theme.foreground, "#dddddd");
  });
  it("a hidden tab (zero size) is not fitted, so the program does not redraw", () => {
    assert.ok(canFit({ isConnected: true, clientWidth: 900, clientHeight: 600 }));
    assert.ok(!canFit({ isConnected: true, clientWidth: 0, clientHeight: 0 }));
    assert.ok(!canFit({ isConnected: false, clientWidth: 900, clientHeight: 600 }));
    assert.ok(!canFit(null));
  });
  // The agent tab's name comes from the title the program sends (OSC 0/2).
  it("the program's title goes to the tab name and its state", () => {
    let headerUpdates = 0;
    let layoutSaves = 0;
    const tv = new AgentTerminalView({ updateHeader: () => { headerUpdates++; } }, alone);
    tv.app = { workspace: { requestSaveLayout: () => { layoutSaves++; } } };
    let headerText = "";
    tv.titleEl = { setText: (t) => { headerText = t; } };
    tv.state = { kind: "claude", instance: "claude-x", title: "Claude Code" };
    tv.setLiveTitle("◑ Claude Code Reviewer с LiteLLM");
    tv.setLiveTitle("   ");
    assert.equal(tv.getDisplayText(), "◑ Claude Code Reviewer с LiteLLM");
    assert.equal(tv.getState().title, tv.getDisplayText());
    assert.equal(headerUpdates, 1);
    assert.equal(layoutSaves, 1);
    assert.equal(headerText, tv.getDisplayText());
  });
});

describe("plugin start-up", () => {
  it("starts the server on plugin load, not only from the catalog tab", async () => {
    const boot = new SessionAtlasPlugin();
    const ready = [];
    boot.app = { plugins: { enabledPlugins: new Set() },
                 workspace: { on: () => null, onLayoutReady: (fn) => ready.push(fn), getLeavesOfType: () => [] } };
    let started = 0;
    boot.ensureServer = async () => { started++; return true; };
    boot.watchOwnBuild = () => {};
    boot.detectAgents = async () => {};
    boot.startWatch = () => {};
    await boot.onload();
    ready.forEach((fn) => fn());
    assert.equal(started, 1);
  });
  it("one plugin: catalog, Claude Code and Codex buttons; default settings", () => {
    assert.equal(alone.ribbons.map((r) => r.icon).join(), "library,bot,codex-bot");
    assert.equal(alone.settings.explorerClicks, false);   // changes core explorer clicks: opt-in
    assert.equal(alone.settings.language, "en");
  });
});

describe("development install", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-dev-vault-"));
  after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const install = (marker) => {
    const dir = path.join(vault, marker ? "dev" : "plain");
    fs.mkdirSync(dir, { recursive: true });
    if (marker) fs.writeFileSync(path.join(dir, ".dev"), "");
    const p = new SessionAtlasPlugin();
    p.app = { vault: { adapter: { getBasePath: () => vault } } };
    p.manifest = { id: "session-atlas", dir: path.basename(dir) };
    p.dataDirOverride = undefined;           // the suite points every plugin at a temp folder
    return p;
  };
  it("a regular install talks to port 8787 and keeps its data in session-atlas", () => {
    const p = install(false);
    assert.equal(p.atlasPort(), 8787);
    assert.equal(p.atlasOrigin(), "http://127.0.0.1:8787");
    assert.match(p.dataDir(), /Application Support\/session-atlas$/);
  });
  it("a .dev install runs apart: port 8788 and session-atlas-dev", () => {
    const p = install(true);
    assert.equal(p.atlasPort(), 8788);
    assert.equal(p.atlasOrigin(), "http://127.0.0.1:8788");
    assert.match(p.dataDir(), /Application Support\/session-atlas-dev$/);
  });
});

describe("plugin reload keeps agents in background tabs", () => {
  const { keepHeldTabs } = loadSrc("term-view");
  const fakePty = () => ({ killed: false, exited: false, kill() { this.killed = true; } });
  const leaf = (type, instance) => ({ getViewState: () => ({ type, state: { instance } }) });

  it("a tab still in the layout keeps its process; a closed one is still reclaimed", async () => {
    const win = getGlobal("window");
    const registry = win.__sessionAtlasPtys || (win.__sessionAtlasPtys = new Map());
    const inTab = fakePty();
    const orphan = fakePty();
    registry.set("claude-bg-1", { pty: inTab, timer: win.setTimeout(() => inTab.kill(), 50) });
    registry.set("claude-gone-2", { pty: orphan, timer: win.setTimeout(() => orphan.kill(), 50) });
    const workspace = { iterateAllLeaves: (fn) => [leaf("session-atlas-terminal", "claude-bg-1"),
                                                   leaf("markdown", "claude-gone-2")].forEach(fn) };
    assert.deepEqual(keepHeldTabs(workspace), ["claude-bg-1"]);
    await delay(120);
    assert.equal(inTab.killed, false);
    assert.equal(orphan.killed, true);
    registry.delete("claude-bg-1");
    registry.delete("claude-gone-2");
  });

  it("no workspace API yet: nothing happens", () => {
    assert.deepEqual(keepHeldTabs({}), []);
  });
});

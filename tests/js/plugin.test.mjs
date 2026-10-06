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
const menus = [];
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
      constructor(msg, duration) {
        this.msg = msg;
        this.duration = duration;
        this.hidden = false;
        notices.push(msg);
        const control = (tag, opts) => ({ tag, ...opts, attrs: {}, listeners: [],
          setAttribute(k, v) { this.attrs[k] = v; },
          addEventListener(type, fn) { this.listeners.push(fn); } });
        this.containerEl = { listeners: [], classes: [], children: [], isConnected: true,
          addEventListener(type, fn) { this.listeners.push(fn); },
          addClass(c) { this.classes.push(c); },
          createEl(tag, opts) { const el = control(tag, opts); this.children.push(el); return el; } };
        noticeObjects.push(this);
      }
      hide() { this.hidden = true; this.containerEl.isConnected = false; }
    },
    PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
    Menu: class {
      constructor() { this.items = []; menus.push(this); }
      addItem(fn) {
        const item = { setTitle(t) { this.title = t; return this; }, setIcon(i) { this.icon = i; return this; },
                       setDisabled(d) { this.disabled = d; return this; }, onClick(f) { this.click = f; return this; } };
        fn(item);
        this.items.push(item);
        return this;
      }
      showAtMouseEvent(e) { this.shownAt = e; }
    },
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
  it("question: the text field and Chat about this are options too", async () => {
    screen = screens.question;
    const seen = await ask();
    assert.equal(seen.dialog.kind, "question");
    assert.equal(seen.dialog.title, "Colour");
    assert.equal(seen.dialog.question, "Which colour do you prefer?");
    assert.equal(seen.dialog.options.map((o) => o.text).join("|"), "Red|Blue|Type something.|Chat about this");
    assert.equal(seen.dialog.options[1].detail, "Cool, calm, serene");
    assert.deepEqual(seen.dialog.options[2], { n: 3, text: "Type something.", detail: "", freeText: true,
                                               selected: false, typed: "" });
    assert.ok(!seen.dialog.options[3].freeText);
  });
  it("question: Blue is digit 2", async () =>
    expectReply(await press({ option: 2, text: "Blue" }), "answered", true, ["2"]));
  it("question: Chat about this is its digit, at once", async () =>
    expectReply(await press({ option: 4, text: "Chat about this" }), "answered", true, ["4"]));
  it("question: the text field's digit alone is refused (it only moves the cursor)", async () =>
    expectReply(await press({ option: 3, text: "Type something." }), "answered", false, []));

  // Own answer, real screens of a fresh session: the question drawn at the top, empty rows below.
  const own = "green please";
  const freeText = async (reactions, expectOk, extra) => {
    screen = screens.free_question;
    onType = (chunk) => { if (reactions[chunk] !== undefined) screen = reactions[chunk]; };
    const r = await exchange(dialogMsg("answer-dialog", Object.assign({ option: 3, text: "Type something.",
                                                                        feedback: own }, extra)),
                             expectOk ? 400 : 3500);
    onType = null;
    return r;
  };
  it("own answer: the screens parse (fresh session, field selected, text typed)", async () => {
    screen = screens.free_question;
    const q = (await ask()).dialog;
    assert.equal(q.title, "Preference");
    assert.equal(q.question, "Which color do you prefer?");
    assert.equal(q.options.map((o) => `${o.n}.${o.text}`).join("|"), "1.Red|2.Blue|3.Type something.|4.Chat about this");
    assert.match(q.options[0].detail, /^A warm, energetic color/);
    screen = screens.free_selected;
    const sel = (await ask()).dialog.options[2];
    assert.deepEqual([sel.freeText, sel.selected, sel.typed], [true, true, ""]);
    screen = screens.free_typed;
    const typed = (await ask()).dialog.options[2];
    assert.deepEqual([typed.text, typed.selected, typed.typed], ["Type something.", true, own]);
  });
  it("own answer: the answered and declined screens are not dialogs", async () => {
    for (const name of ["free_answered", "chat_declined"]) {
      screen = screens[name];
      assert.equal((await ask()).dialog, null, name);
    }
  });
  it("own answer: digit, field selected, text, screen check, Enter", async () =>
    expectReply(await freeText({ 3: screens.free_selected, [own]: screens.free_typed }, true), null, true,
                ["3", own, "\r"]));
  it("own answer: the field did not take the cursor, nothing typed", async () =>
    expectReply(await freeText({}, false), null, false, ["3"]));
  it("own answer: other text on screen, Enter is not pressed", async () =>
    expectReply(await freeText({ 3: screens.free_selected, [own]: screens.free_selected }, false), null, false,
                ["3", own]));
  it("own answer: the option moved to another number, refused", async () =>
    expectReply(await freeText({}, false, { option: 2 }), null, false, []));
  it("own answer through a plain option label: refused", async () =>
    expectReply(await freeText({}, false, { text: "Red" }), null, false, []));
  it("own answer: text already typed in the tab, refused", async () => {
    const r = await (async () => {
      onType = null;
      screen = screens.free_typed;
      return exchange(dialogMsg("answer-dialog", { option: 3, text: "Type something.", feedback: own }), 400);
    })();
    expectReply(r, null, false, []);
  });
  it("own answer: the dialog became a plan, refused", async () =>
    expectReply(await freeText({ 3: screens.plan_selected }, false), null, false, ["3"]));
  it("own answer: line breaks become one line", async () =>
    expectReply(await freeText({ 3: screens.free_selected, [own]: screens.free_typed }, true,
                               { feedback: "green\n  please" }), null, true, ["3", own, "\r"]));
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

  // A question with previews (Claude Code 2.1.291): a digit only moves the highlight, Enter answers it.
  const DOWN = "\x1b[B";
  const previewPress = async (start, reactions, extra, type = "answer-dialog", expectOk = true) => {
    screen = screens[start];
    onType = (chunk) => { if (reactions[chunk] !== undefined) screen = screens[reactions[chunk]]; };
    const r = await exchange(dialogMsg(type, extra), expectOk ? 400 : 3500);
    onType = null;
    return r;
  };
  it("preview question: options from the left column, the preview from the frame, notes and chat", async () => {
    screen = screens.preview_narrow;
    const d = (await ask()).dialog;
    assert.equal(d.pick, "enter");
    assert.deepEqual(d.options.map((o) => o.text), ["Yes, all 5", "Yes, with changes", "Not now"]);
    assert.equal(d.highlighted, 1);
    assert.equal(d.preview.n, 1);
    assert.ok(d.preview.lines.some((l) => l.includes("Answer in the language of the")));
    assert.ok(!JSON.stringify(d).match(/[┌┐└┘│]/), "no frame characters");
    assert.deepEqual(d.notes, { editing: false, text: "" });
    assert.deepEqual(d.chat, { selected: false });
    screen = screens.preview_notes_typed;
    assert.deepEqual((await ask()).dialog.notes, { editing: true, text: "keep it short" });
  });
  it("preview question: digit, highlight checked on screen, Enter", async () =>
    expectReply(await previewPress("preview_wide", { 3: "preview_digit_moved" }, { option: 3, text: "Not now" }),
                "answered", true, ["3", "\r"]));
  it("preview question: the highlight did not move, Enter is not pressed", async () =>
    expectReply(await previewPress("preview_wide", {}, { option: 3, text: "Not now" }, "answer-dialog", false),
                "answered", false, ["3"]));
  it("preview question: another option under that digit is refused before any key", async () =>
    expectReply(await previewPress("preview_wide", {}, { option: 3, text: "Yes, all 5" }, "answer-dialog", false),
                "answered", false, []));
  it("preview question: a note goes with the option (digit, n, text, check, Enter)", async () =>
    expectReply(await previewPress("preview_narrow", { n: "preview_notes", "keep it short": "preview_notes_typed" },
                                   { option: 1, text: "Yes, all 5", note: "keep it short" }),
                "answered", true, ["1", "n", "keep it short", "\r"]));
  it("preview question: the note on screen differs, Enter is not pressed", async () =>
    expectReply(await previewPress("preview_narrow", { n: "preview_notes" },
                                   { option: 1, text: "Yes, all 5", note: "keep it short" }, "answer-dialog", false),
                "answered", false, ["1", "n", "keep it short"]));
  it("preview question: Chat about this is reached with arrows and answered with Enter", async () =>
    expectReply(await previewPress("preview_wide", { [DOWN.repeat(3)]: "preview_chat_selected" }, { chat: true }),
                "answered", true, [DOWN.repeat(3), "\r"]));
  it("preview question: the highlight did not reach Chat about this, Enter is not pressed", async () =>
    expectReply(await previewPress("preview_wide", {}, { chat: true }, "answer-dialog", false),
                "answered", false, [DOWN.repeat(3)]));
  it("Chat about this by name on an ordinary question is refused (there it is a numbered option)", async () =>
    expectReply(await previewPress("question", {}, { chat: true }, "answer-dialog", false), "answered", false, []));
  it("preview question: 👁 moves the highlight only and returns the new screen", async () => {
    const r = await previewPress("preview_wide", { 2: "preview_wide_down" }, { option: 2, text: "Yes, with changes" },
                                 "preview-option");
    assert.equal(r.reply.type, "dialog");
    assert.equal(r.reply.dialog.highlighted, 2);
    assert.ok(r.reply.dialog.preview.lines.join(" ").includes("PREVIEW-TWO"));
    assert.deepEqual(r.typed, ["2"]);
  });
  it("preview question: 👁 while a note is open types nothing", async () => {
    const r = await previewPress("preview_notes", {}, { option: 2, text: "Yes, with changes" }, "preview-option");
    assert.match(r.reply.reason, /заметка/);
    assert.deepEqual(r.typed, []);
  });

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
    lastNotice().containerEl.listeners.forEach((fn) => fn());
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
    assert.doesNotMatch(systemNotes[0].body, /^AI Session Atlas:/);
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

  // How long a notice stays, one notice per session, a stack of at most five, and stale ones go.
  const shown = () => noticeObjects.filter((n) => !n.hidden);
  const resetNotices = () => {
    noticeObjects.forEach((n) => n.hide());
    noticeObjects.length = 0;
    plugin.openNotices = new Map();
  };
  it("default: the notice hides after 10 seconds", async () => {
    resetNotices();
    await busyThenIdle();
    assert.equal(lastNotice().duration, 10000);
  });
  it("30 s, 1 min and sticky: Obsidian gets 30000, 60000 and 0", async () => {
    for (const [hold, ms] of [["30", 30000], ["60", 60000], ["sticky", 0], ["bogus", 10000]]) {
      plugin.settings.noticeHold = hold;
      await busyThenIdle();
      assert.equal(lastNotice().duration, ms, hold);
    }
    plugin.settings.noticeHold = "sticky";
  });
  it("a close button: it hides the notice and does not open the tab", async () => {
    resetNotices();
    await busyThenIdle();
    const notice = lastNotice();
    assert.ok(notice.containerEl.classes.includes("session-atlas-notice"));
    const close = notice.containerEl.children.find((c) => c.cls === "session-atlas-notice-close");
    assert.ok(close && close.attrs["aria-label"], "close button with a label");
    workspace.active = null;
    let stopped = false;
    close.listeners.forEach((fn) => fn({ stopPropagation: () => { stopped = true; } }));
    await settle();
    assert.ok(stopped, "the click does not reach the notice");
    assert.ok(notice.hidden);
    assert.equal(workspace.active, null);
    assert.equal(plugin.openNotices.size, 0);
  });
  it("the same session again: the new notice replaces the old one", async () => {
    resetNotices();
    await busyThenIdle();                  // "finished and waits for you"
    await poll([ses("a", "waiting", { ancestors: [5001] })]);   // then a dialog, with no work between
    assert.equal(noticeObjects.length, 2);
    assert.equal(shown().length, 1);
    assert.equal(shown()[0], lastNotice());
  });
  it("the session works again: its sticky notice goes", async () => {
    resetNotices();
    await busyThenIdle();
    await poll([ses("a", "busy", { ancestors: [5001] })]);
    assert.equal(shown().length, 0);
  });
  it("the session closed: its sticky notice goes", async () => {
    resetNotices();
    await busyThenIdle();
    await poll([]);
    assert.equal(shown().length, 0);
  });
  it("sticky notices stack, one per session, at most five: the oldest goes", async () => {
    resetNotices();
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"];
    await poll(ids.map((id) => ses(id, "busy")));
    await poll(ids.map((id) => ses(id, "idle")));
    assert.equal(noticeObjects.length, 7);
    assert.equal(shown().length, 5);
    assert.deepEqual(shown().map((n) => n.msg.match(/Сессия (s\d)/)[1]), ["s3", "s4", "s5", "s6", "s7"]);
  });
  it("a notice clicked away does not count toward the five", async () => {
    resetNotices();
    await poll([ses("x1", "busy"), ses("x2", "busy")]);
    await poll([ses("x1", "idle"), ses("x2", "idle")]);
    lastNotice().hide();                   // x2 clicked: Obsidian hides a clicked notice by itself
    const ids = ["y1", "y2", "y3", "y4"];
    await poll([ses("x1", "idle"), ses("x2", "idle"), ...ids.map((id) => ses(id, "busy"))]);
    await poll([ses("x1", "idle"), ses("x2", "idle"), ...ids.map((id) => ses(id, "idle"))]);
    assert.equal(shown().length, 5, "x1 and four new ones");
    assert.match(shown()[0].msg, /Сессия x1/);
    plugin.settings.noticeHold = undefined;
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
  it("tab title: AI Session Atlas (3)", () => {
    view = views["session-atlas"]({}, fresh);
    fresh.waitingCount = 3;
    assert.equal(view.getDisplayText(), "AI Session Atlas (3)");
  });
  it("no waiting sessions: plain AI Session Atlas", () => {
    fresh.waitingCount = 0;
    assert.equal(view.getDisplayText(), "AI Session Atlas");
  });
});

// --- agent tabs, close guard, file explorer, languages ---

describe("catalog command parsing", () => {
  const ID = "6e4043ad-81c1-49a2-87f4-47c469933cf3";
  // Strings exactly as shlex.quote prints them on the server (atlas/actions.py, atlas/launch.py).
  const P = agents.parseLaunch;
  it("resume", () => {
    assert.deepEqual(P(`cd '/Users/u/Library/Mobile Documents/iCloud~md~obsidian' && claude --resume ${ID}`),
                     { agent: "claude", cwd: "/Users/u/Library/Mobile Documents/iCloud~md~obsidian", mode: "resume",
                       sessionId: ID, prompt: "" });
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
                     `cd /x && codex resume ${ID} --yolo`, `cd /x && codex fork ${ID}`,
                     `cd /x && codex --resume ${ID}`, `cd /x '&&' claude --resume ${ID}`,
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
    agentPlugin.registryFile = path.join(vault, "no-registry.tsv"); // never the real tab registry
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
  it("catalog: Resume of a session whose tab is in the layout (even not loaded yet) shows that tab", async () => {
    const registry = path.join(vault, "resume.tsv");
    fs.writeFileSync(registry, `claude\tclaude-other-1\tsome-other-session\t/w\t1\nclaude\tclaude-old-1\t${ID}\t/w\t2\n`);
    const deferred = { getViewState: () => ({ type: "session-atlas-terminal", state: { instance: "claude-old-1" } }) };
    const other = { getViewState: () => ({ type: "session-atlas-terminal", state: { instance: "claude-other-1" } }) };
    let revealed = null;
    const ws = agentPlugin.app.workspace;
    agentPlugin.registryFile = registry;
    agentPlugin.app.workspace = Object.assign({}, ws, { iterateAllLeaves: (fn) => [other, deferred].forEach(fn),
                                                        revealLeaf: (leaf) => { revealed = leaf; } });
    const before = viewStates.length;
    try {
      await agentPlugin.openCommandInTerminal(`cd '/Users/u/Code/p' && claude --resume ${ID}`, "/Users/u/Code/p", "Demo");
      assert.equal(revealed, deferred);
      assert.equal(viewStates.length, before, "no second tab");
      // A fork is a new session: it always gets its own tab.
      await agentPlugin.openCommandInTerminal(`cd '/Users/u/Code/p' && claude --resume ${ID} --fork-session`, "/p", "Fork");
      assert.equal(viewStates.length, before + 1);
      // No tab of this session in the layout: a new one.
      fs.writeFileSync(registry, "");
      await agentPlugin.openCommandInTerminal(`cd '/Users/u/Code/p' && claude --resume ${ID}`, "/Users/u/Code/p", "Demo");
      assert.equal(viewStates.length, before + 2);
    } finally {
      agentPlugin.app.workspace = ws;
      agentPlugin.registryFile = path.join(vault, "no-registry.tsv");
    }
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
    assert.equal(shown.title, "Close the AI Session Atlas tab?");
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
    assert.equal(alone.settings.terminalFontSize, 12);
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

// --- Codex in the plugin's own tabs: the screens are live codex-cli 0.160.0 snapshots ---

const cx = readJson("codex_screens.json");
const codexSrc = loadSrc("dialog-codex");
const claudeDialog = loadSrc("dialog");
const CODEX_ID = "019a0000-0000-7000-8000-000000000001";

describe("Codex screens", () => {
  const states = { idle: "idle", idle_draft: "idle", idle_after_turn: "idle", interrupted: "idle", esc_idle: "idle",
                   status: "idle", busy: "busy", busy_queued: "busy", exec: "waiting", exec_moved: "waiting",
                   exec_long: "waiting", edit: "waiting", question: "waiting", question_multi: "waiting",
                   plan_implement: "waiting", rate_limit: "waiting" };
  it("every captured screen is in the test", () => {
    assert.deepEqual(Object.keys(cx).sort(), Object.keys(states).sort());
  });
  for (const [name, state] of Object.entries(states)) {
    it(`${name}: ${state}`, () => assert.equal(codexSrc.codexScreenState(cx[name]), state));
  }
  const P = codexSrc.parseCodexDialog;
  it("command approval: kind, question, details, options without key hints", () => {
    const d = P(cx.exec);
    assert.equal(d.kind, "permission");
    assert.equal(d.title, "Shell command");
    assert.equal(d.question, "Would you like to run the following command?");
    assert.deepEqual(d.details, ["Environment: local", "Reason: Do you want to create hello.txt in this folder?",
                                 "$ touch hello.txt"]);
    assert.deepEqual(d.options.map((o) => [o.n, o.text, o.key]), [
      [1, "Yes, proceed", "y"], [2, "Yes, and don't ask again for commands that start with `touch`", "p"],
      [3, "No, and tell Codex what to do differently", "esc"]]);
    assert.deepEqual(d.feedback, { n: 3, label: "No, and tell Codex what to do differently", selected: false,
                                   typed: "" });
    assert.ok(d.answerable);
  });
  it("the highlight moved: the same options", () => {
    assert.deepEqual(P(cx.exec_moved).options, P(cx.exec).options);
  });
  it("a long command: the wrapped option label is one line", () => {
    const o = P(cx.exec_long).options[1];
    assert.match(o.text, /^Yes, and don't ask again for commands that start with `mkdir -p build\/output\/reports/);
    assert.match(o.text, /the report\\n' > build\/output\/reports\/summary-of-the-current-folder-contents\.txt/);
    assert.equal(o.key, "p");
    assert.equal(P(cx.exec_long).options.length, 3);
  });
  it("edit approval: kind edit, the destination", () => {
    const d = P(cx.edit);
    assert.equal(d.kind, "edit");
    assert.equal(d.question, "Would you like to make the following edits?");
    assert.ok(d.details.includes("/tmp/probe/work/hello.txt"));
    assert.equal(d.options[1].text, "Yes, and don't ask again for these files");
  });
  it("question: the description column apart from the label", () => {
    const d = P(cx.question);
    assert.equal(d.kind, "question");
    assert.equal(d.question, "Which format should the notes file use?");
    assert.deepEqual(d.options.map((o) => o.text), ["Markdown (Recommended)", "Plain text", "None of the above"]);
    assert.equal(d.options[0].detail, "Readable in Obsidian and on GitHub.");
    assert.equal(d.feedback, null);
  });
  it("two questions: answered only in the tab", () => {
    const d = P(cx.question_multi);
    assert.equal(d.answerable, false);
    assert.equal(d.reason, "dialog.multi");
  });
  it("plan prompt: a choice; the plan's own numbered list is not taken for options", () => {
    const d = P(cx.plan_implement);
    assert.equal(d.kind, "choice");
    assert.equal(d.title, "Implement this plan?");
    assert.deepEqual(d.options.map((o) => o.text), ["Yes, implement this plan", "Yes, clear context and implement",
                                                    "No, stay in Plan mode"]);
  });
  it("model switch prompt: title and question", () => {
    const d = P(cx.rate_limit);
    assert.equal(d.title, "Approaching rate limits");
    assert.equal(d.question, "Switch to gpt-6-luna for lower credit usage?");
    assert.equal(d.options[1].text, "Keep current model");
  });
  it("no footer, no dialog: the same options without the hint line are text", () => {
    assert.equal(P(cx.exec.map((l) => l.replace(/Press enter to confirm or esc to cancel/, ""))), null);
  });
  it("composer text and /status output", () => {
    assert.equal(codexSrc.composerText(cx.idle_draft), "a draft I have not sent yet");
    const out = codexSrc.extractCodexCommandOutput(cx.status, "/status");
    assert.match(out.text, /^>_ OpenAI Codex/);
    assert.match(out.text, /Collaboration mode: {2}Default/);
    assert.doesNotMatch(out.text, /›|Ask Codex/);
  });
  it("Claude Code screens are not Codex dialogs, and Codex screens are not Claude ones", () => {
    const claude = { ...readJson("dialog_screens.json"), ...readJson("command_screens.json") };
    for (const [name, lines] of Object.entries(claude)) {
      assert.equal(P(lines), null, `Claude ${name}`);
    }
    for (const [name, lines] of Object.entries(cx)) {
      assert.equal(claudeDialog.parseDialog(lines), null, `Codex ${name}`);
      const out = claudeDialog.extractCommandOutput(lines, "");
      assert.ok(!out || !out.panel, `Codex ${name} as a Claude panel`);
    }
  });
});

describe("Codex tab: answers, reply, stop", () => {
  let cscreen = cx.idle;
  let ids = [CODEX_ID];
  const codexLeaf = {
    view: {
      state: { kind: "codex" },
      emulator: {
        pseudoterminal: Promise.resolve({ shell: Promise.resolve({
          pid: 6003, stdin: { write: (chunk) => { typed.push(chunk); if (onType) onType(chunk); } } }) }),
        terminal: { get rows() { return cscreen.length; },
                    buffer: { active: { baseY: 0, getLine: (i) => ({ translateToString: () => cscreen[i] }) } } },
      },
      getDisplayText: () => "Codex",
    },
    detach() {},
  };
  const base = { ptyPid: 6003, claudePid: 7101, sessionId: CODEX_ID, nonce: "x" };
  const send = (type, extra, wait = 50) => exchange(msg(Object.assign({ type }, base, extra)), wait);
  const on = (lines, fn) => { cscreen = lines; return fn(); };
  const withComposer = (text) => cx.interrupted.map((l) => (l.startsWith("› Ask Codex") ? "› " + text : l));
  before(() => {
    leaves = [typingLeaf, codexLeaf, leafB];
    parents[7101] = 6003;
    parents[6003] = 900;
    plugin.parentPid = (pid) => parents[pid] || 0;
    plugin.processName = (pid) => (pid === 7101 ? "codex" : "zsh");
    plugin.codexSessionIds = (pid) => (pid === 7101 ? ids : []);
  });

  it("read: the approval in the card's shape", async () => {
    const r = await on(cx.exec, () => send("read-dialog"));
    assert.equal(r.reply.type, "dialog");
    assert.equal(r.reply.dialog.kind, "permission");
    assert.equal(r.reply.dialog.options[0].text, "Yes, proceed");
  });
  it("read: two questions carry a translated reason", async () => {
    const r = await on(cx.question_multi, () => send("read-dialog"));
    assert.match(r.reply.dialog.reason, /^(Несколько вопросов разом|Several questions at once)/);
  });
  it("read: an idle composer has no dialog", async () => {
    const r = await on(cx.idle, () => send("read-dialog"));
    assert.equal(r.reply.dialog, null);
    assert.match(r.reply.reason, /диалога нет/);
  });
  it("approve: one digit, no Enter", async () =>
    expectReply(await on(cx.exec, () => send("answer-dialog", { option: 1, text: "Yes, proceed" })),
                "answered", true, ["1"]));
  it("decline: its digit", async () =>
    expectReply(await on(cx.exec, () => send("answer-dialog",
      { option: 3, text: "No, and tell Codex what to do differently" })), "answered", true, ["3"]));
  it("the dialog changed before the press: refused", async () =>
    expectReply(await on(cx.edit, () => send("answer-dialog",
      { option: 2, text: "Yes, and don't ask again for commands that start with `touch`" })), "answered", false, []));
  it("question: the option's digit", async () =>
    expectReply(await on(cx.question, () => send("answer-dialog", { option: 2, text: "Plain text" })),
                "answered", true, ["2"]));
  it("two questions: refused", async () =>
    expectReply(await on(cx.question_multi, () => send("answer-dialog", { option: 1, text: "Markdown (Recommended)" })),
                "answered", false, []));
  it("idle: no dialog to answer", async () =>
    expectReply(await on(cx.idle, () => send("answer-dialog", { option: 1, text: "Yes, proceed" })),
                "answered", false, []));
  it("another session in the process: refused", async () =>
    expectReply(await on(cx.exec, () => send("answer-dialog", { option: 1, text: "Yes, proceed",
                                                                 sessionId: "019a0000-0000-7000-8000-00000000000f" })),
                "answered", false, []));
  it("the process is not Codex: refused", async () => {
    plugin.processName = () => "zsh";
    const r = await on(cx.exec, () => send("answer-dialog", { option: 1, text: "Yes, proceed" }));
    plugin.processName = (pid) => (pid === 7101 ? "codex" : "zsh");
    expectReply(r, "answered", false, []);
  });

  // "No, and tell Codex what to do differently": decline, then the text in the composer, then Enter.
  const tell = "Use printf instead of echo and keep the file in this folder";
  const feedback = async (reactions, ok, extra) => {
    cscreen = cx.exec;
    onType = (chunk) => { if (reactions[chunk] !== undefined) cscreen = reactions[chunk]; };
    const r = await send("answer-dialog", Object.assign({ option: 3, text: "No, and tell Codex what to do differently",
                                                          feedback: tell }, extra), ok ? 700 : 3500);
    onType = null;
    return r;
  };
  it("feedback: decline, the composer, the text, Enter", async () =>
    expectReply(await feedback({ 3: cx.interrupted, [tell]: withComposer(tell) }, true), null, true, ["3", tell, "\r"]));
  it("feedback: the dialog did not close, nothing typed", async () =>
    expectReply(await feedback({}, false), null, false, ["3"]));
  it("feedback: other text in the composer, Enter not pressed", async () =>
    expectReply(await feedback({ 3: cx.interrupted, [tell]: withComposer("something else") }, false), null, false,
                ["3", tell]));
  it("feedback through an approving option: refused", async () =>
    expectReply(await feedback({}, false, { option: 1, text: "Yes, proceed" }), null, false, []));

  it("reply when idle: text, then Enter", async () =>
    expectReply(await on(cx.idle, () => send("send-text", { text: "list the files" }, 400)), null, true,
                ["list the files", "\r"]));
  it("reply while busy: Codex queues it", async () =>
    expectReply(await on(cx.busy, () => send("send-text", { text: "also check b.md" }, 400)), null, true,
                ["also check b.md", "\r"]));
  it("reply during an approval: refused", async () =>
    expectReply(await on(cx.exec, () => send("send-text", { text: "y" }, 400)), null, false, []));
  it("reply on an unknown screen: refused", async () => {
    const r = await on(["", "Some full-screen view", ""], () => send("send-text", { text: "hello" }, 400));
    expectReply(r, null, false, []);
    assert.match(r.reply.reason, /экран Codex|Codex screen/);
  });
  it("/status: the output from the screen", async () => {
    cscreen = cx.status;
    const before = replies.length;
    await send("send-text", { text: "/status", nonce: "cx-status" }, 2100);
    const out = replies.slice(before).find((x) => x.msg.type === "command-output");
    assert.ok(out, "no command-output");
    assert.match(out.msg.text, /Collaboration mode/);
  });
  it("a Claude-only command is not read from a Codex screen", async () => {
    cscreen = cx.idle;
    const before = replies.length;
    await send("send-text", { text: "/context", nonce: "cx-ctx" }, 2100);
    assert.equal(replies.slice(before).find((x) => x.msg.type === "command-output"), undefined);
  });

  it("stop while busy: one Esc", async () =>
    expectReply(await on(cx.busy, () => send("interrupt")), "stopped", true, ["\x1b"]));
  it("stop in an approval: one Esc", async () =>
    expectReply(await on(cx.edit, () => send("interrupt")), "stopped", true, ["\x1b"]));
  it("stop when idle: refused (Esc edits the last message, Ctrl-C would quit)", async () =>
    expectReply(await on(cx.idle, () => send("interrupt")), "stopped", false, []));

  it("tab list: a Codex tab carries its screen state", async () => {
    cscreen = cx.question;
    const before = replies.length;
    plugin.handleMessage(msg({ type: "list-tabs" }));
    await settle(300);
    const tabs = replies.slice(before).find((x) => x.msg.type === "tabs").msg.tabs;
    assert.deepEqual(tabs.find((t) => t.ptyPid === 6003), { ptyPid: 6003, title: "Codex", agent: "codex",
                                                            screen: "waiting" });
    assert.equal(tabs.find((t) => t.ptyPid === 6001).agent, undefined);
  });

  it("notification: the server sees busy, the tab shows an approval", async () => {
    const codexSession = (activity) => ({ session_id: CODEX_ID, title: "Codex probe", agent: "codex",
                                          activity, status: activity, ancestors: [7101, 6003] });
    plugin.settings = { notify: true };
    plugin.lastActivity = null;
    cscreen = cx.busy;
    plugin.fetchActive = async () => ({ sessions: [codexSession("busy")] });
    await plugin.pollActive();
    notices.length = 0;
    cscreen = cx.exec;
    await plugin.pollActive();
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Codex probe/);
    assert.match(notices[0], /диалоге/);
    assert.equal(plugin.stored.openSessions[0].agent, "codex");
  });
  it("notification: a session not marked codex keeps the server's status", async () => {
    notices.length = 0;
    plugin.fetchActive = async () => ({ sessions: [{ session_id: "c1", activity: "busy", ancestors: [6003] }] });
    await plugin.pollActive();
    assert.equal(plugin.lastActivity.get("c1"), "busy");
  });
});

describe("Codex resume from the catalog and after a restart", () => {
  const ID = "019a1026-ef90-7e02-8a9d-3472664a8e96";
  const SCRIPT = path.join(SRC, "..", "scripts", "agent-resume-terminal.zsh");
  it("parsed: codex resume <id>", () => {
    assert.deepEqual(agents.parseLaunch(`cd '/Users/u/Code/p' && codex resume ${ID}`),
                     { agent: "codex", cwd: "/Users/u/Code/p", mode: "resume", sessionId: ID, prompt: "" });
  });
  it("opens a Codex tab with the resume start", async () => {
    const p = new SessionAtlasPlugin();
    const states = [];
    p.agentScriptPath = () => SCRIPT;
    p.app = { vault: { configDir: "c", adapter: { getBasePath: () => TMP } },
              workspace: { getLeaf: () => ({ setViewState: async (st) => states.push(st) }), revealLeaf() {} } };
    p.settings = { language: "en" };
    await p.openCommandInTerminal(`cd '/Users/u/Code/p' && codex resume ${ID}`, "/Users/u/Code/p", "Probe");
    const w = agents.shellWords(states[0].state.command);
    assert.equal(states[0].state.kind, "codex");
    assert.deepEqual(w.slice(2, 3).concat(w.slice(4)), ["codex", "resume", ID]);
  });

  // The tab script with a stand-in codex: the start is recorded, so the tab gets it back later.
  const run = (dir, instance, ...seed) => {
    const work = path.join(dir, "work");
    const r = require("node:child_process").spawnSync("zsh", [SCRIPT, "codex", instance, ...seed], {
      cwd: work, timeout: 20000, encoding: "utf8",
      env: { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, HOME: dir, PWD: work, CALLS: path.join(dir, "calls"),
             OBS_AGENT_TERMINAL_STATE_DIR: path.join(dir, "state"), OBS_AGENT_TERMINAL_NO_SHELL: "1",
             OBS_AGENT_TERMINAL_CODEX_SESSIONS_DIR: path.join(dir, "sessions"),
             OBS_AGENT_TERMINAL_ARGS_DIR: path.join(dir, "args") } });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").pop();
  };
  it("script: a seed resumes the session and the registry keeps it", () => {
    const dir = fs.mkdtempSync(path.join(TMP, "codex-script-"));
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "codex"), '#!/bin/zsh\nprint -r -- "$*" >> "$CALLS"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, "sessions", "2026", "10", "03"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sessions", "2026", "10", "03", `rollout-2026-10-03T17-40-56-${ID}.jsonl`),
                     JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: ID, cwd: work } }) + "\n");
    assert.equal(run(dir, "codex-1", "resume", ID), `resume ${ID}`);
    // After a restart the tab runs without a seed, or with another one: the registry wins.
    assert.equal(run(dir, "codex-1"), `resume ${ID}`);
    assert.equal(run(dir, "codex-1", "resume", "019a0000-0000-7000-8000-00000000000f"), `resume ${ID}`);
  });
});

describe("Codex new sessions from the catalog", () => {
  const ID = "6e4043ad-81c1-49a2-87f4-47c469933cf3";
  const P = agents.parseLaunch;
  // Strings exactly as shlex.quote prints them on the server (atlas/actions.py agent_command).
  it("codex with a handoff prompt: a new thread without an id", () => {
    assert.deepEqual(P(`cd '/Users/u/it'"'"'s' && codex 'Read /h/launch-019e0000-0123456789ab.md and continue the work.'`),
                     { agent: "codex", cwd: "/Users/u/it's", mode: "new", sessionId: "",
                       prompt: "Read /h/launch-019e0000-0123456789ab.md and continue the work." });
  });
  it("bare codex and guarded one-word or flag-like prompts", () => {
    assert.deepEqual(P("cd /x && codex"), { agent: "codex", cwd: "/x", mode: "new", sessionId: "", prompt: "" });
    assert.equal(P("cd /x && codex ' resume'").prompt, " resume");
    assert.equal(P("cd /x && codex ' --yolo'").prompt, " --yolo");
    assert.equal(P(`cd /x && claude --session-id ${ID} ' update'`).prompt, " update");
  });
  for (const bad of ["cd /x && codex resume", "cd /x && codex exec", "cd /x && codex --yolo",
                     "cd /x && codex '--yolo now'", "cd /x && codex -m o3 'do it'", "cd /x && codex 'a b' 'c d'",
                     "cd /x && codex 'do it' --yolo", "cd /x && codex ''", "cd /x && codex '   '",
                     "cd /x && codex 'a b'; id", "cd /x && codex \"a $(id)\"", "cd x && codex 'a b'",
                     `cd /x && codex fork ${ID}`, `cd /x && codex resume ${ID} 'a b'`,
                     `cd /x && claude --session-id ${ID} update`, `cd /x && claude --session-id ${ID} '-v x'`,
                     `cd /x && claude 'a b'`, "cd /x && claude"]) {
    it(`rejects: ${bad}`, () => assert.equal(P(bad), null));
  }
  it("tab arguments: an empty id keeps the prompt in its place", () => {
    const args = agents.agentArgs("/s/a.zsh", "codex", "codex-x-1", { mode: "new", sessionId: "", prompt: "it's $HOME" });
    assert.deepEqual(agents.shellWords(args[3]), ["exec", "/s/a.zsh", "codex", "codex-x-1", "new", "", "it's $HOME"]);
    const bare = agents.agentArgs("/s/a.zsh", "codex", "codex-x-2", { mode: "new", sessionId: "", prompt: "" });
    assert.deepEqual(agents.shellWords(bare[3]), ["exec", "/s/a.zsh", "codex", "codex-x-2", "new", ""]);
  });
  it("opens a Codex tab with the new start and the prompt", async () => {
    const p = new SessionAtlasPlugin();
    const states = [];
    p.agentScriptPath = () => path.join(SRC, "..", "scripts", "agent-resume-terminal.zsh");
    p.app = { vault: { configDir: "c", adapter: { getBasePath: () => TMP } },
              workspace: { getLeaf: () => ({ setViewState: async (st) => states.push(st) }), revealLeaf() {} } };
    p.settings = { language: "en" };
    await p.openCommandInTerminal("cd '/Users/u/Code/p' && codex 'сделай отчёт'", "/Users/u/Code/p", "Probe");
    assert.equal(states[0].state.kind, "codex");
    assert.equal(states[0].state.cwd, "/Users/u/Code/p");
    assert.deepEqual(agents.shellWords(states[0].state.command).slice(4), ["new", "", "сделай отчёт"]);
  });
  it("the tabs reply tells the page which agents are on", async () => {
    const p = new SessionAtlasPlugin();
    p.terminalReport = async () => ({ tabs: [], health: { ok: true } });
    const sent = [];
    const target = { postMessage: (msg, origin) => sent.push([msg, origin]) };
    p.settings = { agents: { codex: true } };
    await p.replyTabs(target);
    p.settings = { agents: { claude: true } };
    await p.replyTabs(target);
    assert.deepEqual(sent.map(([m]) => m.agents), [{ claude: true, codex: true }, { claude: true, codex: false }]);
    assert.ok(sent.every(([m, origin]) => m.type === "tabs" && m.source === "session-atlas-host" && origin === p.atlasOrigin()));
  });
});

describe("Resume with: the converted session opens in the target agent's tab", () => {
  // Commands exactly as atlas/convert.py returns them (actions.resume_command, shlex.quote).
  const CODEX_ID = "01a10ad8-a38c-7395-aae0-0f2def2075ab";       // a UUID v7 the server made
  const CLAUDE_ID = "9ceb5b95-bc2e-42d9-be43-aaa4eba3fcd7";
  const CWD = "/Users/u/it's work";
  const Q = `'/Users/u/it'"'"'s work'`;
  const P = agents.parseLaunch;
  it("parsed as the target agent's ordinary resume", () => {
    assert.deepEqual(P(`cd ${Q} && codex resume ${CODEX_ID}`),
                     { agent: "codex", cwd: CWD, mode: "resume", sessionId: CODEX_ID, prompt: "" });
    assert.deepEqual(P(`cd ${Q} && claude --resume ${CLAUDE_ID}`),
                     { agent: "claude", cwd: CWD, mode: "resume", sessionId: CLAUDE_ID, prompt: "" });
  });
  for (const bad of [`cd /x && codex --resume ${CODEX_ID}`, `cd /x && claude resume ${CLAUDE_ID}`,
                     `cd /x && codex resume ${CODEX_ID.toUpperCase()}`, `cd /x && codex resume ${CODEX_ID}; id`]) {
    it(`rejects: ${bad}`, () => assert.equal(P(bad), null));
  }
  for (const [agent, command, id] of [["codex", `cd ${Q} && codex resume ${CODEX_ID}`, CODEX_ID],
                                      ["claude", `cd ${Q} && claude --resume ${CLAUDE_ID}`, CLAUDE_ID]]) {
    it(`opens a ${agent} tab through the tab script with the resume start`, async () => {
      const p = new SessionAtlasPlugin();
      const states = [];
      p.agentScriptPath = () => path.join(SRC, "..", "scripts", "agent-resume-terminal.zsh");
      p.app = { vault: { configDir: "c", adapter: { getBasePath: () => TMP } },
                workspace: { getLeaf: () => ({ setViewState: async (st) => states.push(st) }), revealLeaf() {} } };
      p.settings = { language: "en", agents: { claude: true, codex: true } };
      await p.openCommandInTerminal(command, CWD, "Lighthouse lamp");
      assert.equal(states.length, 1);
      assert.equal(states[0].state.kind, agent);
      assert.equal(states[0].state.cwd, CWD);
      assert.equal(states[0].state.title, "Lighthouse lamp");
      const w = agents.shellWords(states[0].state.command);
      assert.equal(w[2], agent);
      assert.deepEqual(w.slice(4), ["resume", id]);
    });
  }
});


// --- the close guard after a plugin reload ---

describe("close guard survives a plugin reload", () => {
  const GUARD_EVENTS = ["auxclick", "click", "mousedown", "pointerdown"];
  const guardedOn = (p, doc) => (p.domEvents || []).filter((e) => e.target === doc).map((e) => e.type).sort();

  it("the next plugin copy guards the same document again (disable/enable, hot reload)", () => {
    const doc = {};
    const before = new SessionAtlasPlugin();
    before.installCloseGuard(doc);
    // Unloading removed the first copy's listeners; the second copy must put its own.
    const after = new SessionAtlasPlugin();
    after.installCloseGuard(doc);
    assert.deepEqual(guardedOn(after, doc), GUARD_EVENTS);
  });
  it("one copy installs once per document", () => {
    const doc = {};
    const p = new SessionAtlasPlugin();
    p.installCloseGuard(doc);
    p.installCloseGuard(doc);
    assert.deepEqual(guardedOn(p, doc), GUARD_EVENTS);
  });
  it("popout windows already open at load are guarded too", () => {
    const popout = {};
    const p = new SessionAtlasPlugin();
    p.app = { workspace: { iterateAllLeaves: (fn) => [{ view: { containerEl: { ownerDocument: popout } } }, {}].forEach(fn) } };
    p.installCloseGuards();
    assert.deepEqual(guardedOn(p, popout), GUARD_EVENTS);
  });
  it("a tab opened after the guard was installed asks before closing", () => {
    const p = new SessionAtlasPlugin();
    const header = {};
    const later = [];
    p.settings = { language: "en" };
    p.pendingCloseConfirms = new WeakSet();
    p.app = { workspace: { iterateAllLeaves: (fn) => later.forEach(fn) } };
    p.installCloseGuard({});
    later.push({ tabHeaderEl: header, view: { getViewType: () => "session-atlas-terminal", getDisplayText: () => "New" },
                 getViewState: () => ({}), detach() { this.detached = true; } });
    const count = modals.length;
    const target = { closest: (sel) => (sel === ".workspace-tab-header-inner-close-button" ? { closest: () => header } : header) };
    const click = { target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    p.onCloseButton(click, true);
    assert.equal(modals.length, count + 1);
    modals[modals.length - 1].close();
    assert.ok(!later[0].detached);
  });
});

// --- copying from the agent terminal ---

describe("terminal copy", () => {
  const copy = loadSrc("term-copy");
  const key = (extra) => Object.assign({ type: "keydown", metaKey: true, key: "c", code: "KeyC" }, extra);

  it("⌘C copies, also on a Cyrillic layout; other keys do not", () => {
    assert.ok(copy.isCopyKey(key()));
    assert.ok(copy.isCopyKey(key({ key: "с" })), "Russian layout: the key is «с», its place is KeyC");
    assert.ok(copy.isCopyKey(key({ key: "C" })));
    assert.ok(!copy.isCopyKey(key({ metaKey: false })));
    assert.ok(!copy.isCopyKey(key({ type: "keyup" })));
    assert.ok(!copy.isCopyKey(key({ shiftKey: true })));
    assert.ok(!copy.isCopyKey(key({ ctrlKey: true })), "Ctrl+C belongs to the program");
    assert.ok(!copy.isCopyKey(key({ key: "v", code: "KeyV" })));
    assert.ok(!copy.isCopyKey(key({ key: "j", code: "KeyC" })), "a Latin layout goes by the letter");
  });

  // ⌘C or Edit → Copy while the keyboard is not in the terminal arrives as the page's "copy" event.
  it("a page-wide Copy takes the active agent tab's selection, never a text field's", () => {
    const leaf = {};
    const term = (sel) => ({ hasSelection: () => !!sel, getSelection: () => sel });
    const ev = (target) => ({ clipboardData: {}, target });
    const body = { tagName: "BODY", classList: { contains: () => false } };
    const helper = { tagName: "TEXTAREA", classList: { contains: (c) => c === "xterm-helper-textarea" } };
    const field = { tagName: "INPUT", classList: { contains: () => false } };
    const editable = { tagName: "DIV", isContentEditable: true, classList: { contains: () => false } };
    assert.ok(copy.copyTarget(ev(body), leaf, leaf, term("abc")));
    assert.ok(copy.copyTarget(ev(helper), leaf, leaf, term("abc")), "the terminal's own input field");
    assert.ok(!copy.copyTarget(ev(body), leaf, {}, term("abc")), "another tab is active");
    assert.ok(!copy.copyTarget(ev(body), leaf, leaf, term("")), "nothing selected: the page copies as usual");
    assert.ok(!copy.copyTarget(ev(field), leaf, leaf, term("abc")), "a text field copies its own text");
    assert.ok(!copy.copyTarget(ev(editable), leaf, leaf, term("abc")), "a note being edited copies its own text");
    assert.ok(!copy.copyTarget({ target: body }, leaf, leaf, term("abc")), "no clipboard data to fill");
  });

  // xterm inside Obsidian believes it runs in Node (process.title), not on macOS, so its own ⌥ rule is off.
  it("⌥ or Shift held selects although the program holds the mouse; ⌥ does not make a block", () => {
    const service = { shouldForceSelection: (e) => !!e.shiftKey && false, shouldColumnSelect: (e) => !!e.altKey };
    const term = { _core: { _selectionService: service } };
    assert.equal(copy.selectWithModifier(term), true);
    assert.equal(service.shouldForceSelection({ altKey: true }), true);
    assert.equal(service.shouldForceSelection({ shiftKey: true }), true);
    assert.equal(service.shouldForceSelection({}), false);
    assert.equal(service.shouldColumnSelect({ altKey: true }), false);
    assert.equal(copy.selectWithModifier({}), false, "no hook: reported, not thrown");
  });

  it("copying writes the selection to the clipboard; nothing selected, nothing written", async () => {
    const written = [];
    const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true,
      value: { clipboard: { writeText: async (t) => { written.push(t); } } } });
    try {
      assert.equal(copy.copySelection({ hasSelection: () => true, getSelection: () => "picked text" }), true);
      assert.equal(copy.copySelection({ hasSelection: () => false, getSelection: () => "" }), false);
      await settle(10);
    } finally {
      if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
      else delete globalThis.navigator;
    }
    assert.deepEqual(written, ["picked text"]);
  });

  it("the async clipboard refused: the hidden field and copy command take over", async () => {
    const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true,
      value: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
    const area = { removed: false, select() {}, remove() { this.removed = true; } };
    const commands = [];
    const doc = { createElement: () => area, body: { appendChild() {} },
                  execCommand: (c) => { commands.push([c, area.value]); return true; } };
    try {
      assert.equal(await copy.writeClipboard("fallback text", doc), true);
    } finally {
      if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
      else delete globalThis.navigator;
    }
    assert.deepEqual(commands, [["copy", "fallback text"]]);
    assert.ok(area.removed);
  });

  it("the right-click menu: Copy only with a selection, Paste always", () => {
    const tv = new AgentTerminalView({}, alone);
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    const menu = tv.showMenu(event, { hasSelection: () => false });
    assert.ok(prevented, "the native menu is replaced");
    assert.deepEqual(menu.items.map((i) => [i.title, i.disabled]), [["Copy", true], ["Paste", false]]);
    assert.equal(menu.shownAt, event);
    const withSelection = tv.showMenu(event, { hasSelection: () => true });
    assert.equal(withSelection.items[0].disabled, false);
  });
});

// --- processes held when the plugin is turned off and on ---

describe("tabs closed with the plugin: the agents are offered back", () => {
  const held = loadSrc("held");
  const reg = () => getGlobal("window").__sessionAtlasPtys || new Map();
  const fakePty = (pid) => ({ pid, killed: false, exited: false, kill() { this.killed = true; },
                              onData() {}, onExit() {} });
  const agentLeaf = (instance) => ({ getViewState: () => ({ type: "session-atlas-terminal", state: { instance } }) });
  let layout = [];
  const opened = [];
  const hp = new SessionAtlasPlugin();
  hp.settings = { language: "en", openSessions: [] };
  hp.app = { workspace: {
    iterateAllLeaves: (fn) => layout.forEach(fn),
    getLeavesOfType: () => [],
    getLeaf: () => ({ setViewState: async (st) => { opened.push(st); } }),
    revealLeaf() {}, setActiveLeaf() {},
  } };
  const delays = [];
  const win = getGlobal("window");
  const realSetTimeout = win.setTimeout;
  before(() => { win.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); }; });
  after(() => {
    win.setTimeout = realSetTimeout;
    for (const key of ["claude-h1", "claude-h2", "claude-h3", "claude-h4"]) reg().delete(key);
  });

  it("a tab closed by the unload holds its process for the reclaim time", () => {
    const pty = fakePty(7101);
    held.holdForReclaim("claude-h1", pty, { kind: "claude", instance: "claude-h1", title: "Fix the build", command: "x" });
    assert.equal(delays.pop(), held.RECLAIM_MS);
    assert.equal(reg().get("claude-h1").held, true);
    assert.equal(pty.killed, false);
  });
  it("no tab in the layout: offered and held for the answer, not the two minutes", () => {
    const tabs = hp.heldTabs();
    assert.deepEqual(tabs.map((t) => [t.ptyPid, t.title, t.agent]), [[7101, "Fix the build", "claude"]]);
    assert.equal(delays.pop(), held.OFFER_HOLD_MS);
    hp.heldTabs();
    assert.equal(delays.length, 0, "an open offer is not restarted on every poll");
  });
  // Updating from a version before 2.2 (or toggling it): its unload left {pty, timer} entries only.
  it("an entry left by an older version is offered too, as its kind, and held past its old timer", () => {
    const old = { pty: fakePty(7105), timer: 12345 };
    reg().set("codex-h5", old);
    reg().set("pty-h6", { pty: fakePty(7106), timer: null });          // attached to a live tab: not held
    const tabs = hp.heldTabs().filter((t) => [7105, 7106].includes(t.ptyPid));
    assert.deepEqual(tabs.map((t) => [t.ptyPid, t.title, t.agent]), [[7105, "Codex", "codex"]]);
    assert.equal(old.held, true);
    assert.deepEqual(old.state, { kind: "codex", instance: "codex-h5", title: "Codex" });
    assert.ok(delays.includes(held.OFFER_HOLD_MS));
    delays.length = 0;
    reg().delete("codex-h5");
    reg().delete("pty-h6");
  });
  it("a held process whose tab is still in the layout (quiet reload) is not offered", () => {
    held.holdForReclaim("claude-h2", fakePty(7102), { kind: "claude", instance: "claude-h2", title: "Background" });
    delays.length = 0;
    layout = [agentLeaf("claude-h2")];
    assert.deepEqual(held.keepHeldTabs(hp.app.workspace), ["claude-h2"]);
    assert.deepEqual(hp.heldTabs().map((t) => t.ptyPid), [7101]);
    layout = [];
  });
  it("the page gets the held tabs with the terminal tabs", async () => {
    const out = [];
    hp.terminalReport = async () => ({ tabs: [], health: { ok: true, reason: null } });
    await hp.replyTabs({ postMessage: (m) => out.push(m) });
    assert.deepEqual(out[0].held.map((h) => h.ptyPid).sort(), [7101, 7102]);
  });
  it("a notice offers them once, not on every poll", () => {
    noticeObjects.length = 0;
    hp.heldNoticed = new Set();
    hp.offerHeldTabs();
    hp.offerHeldTabs();
    assert.equal(noticeObjects.length, 1);
    assert.match(noticeObjects[0].msg, /tabs: 2/);
  });
  it("a held session counts as open: an Obsidian restart offers it back", async () => {
    hp.terminalTabs = async () => [];
    await hp.trackOpenSessions([{ session_id: "s-held", title: "Fix the build", ancestors: [9, 7101] },
                                { session_id: "s-elsewhere", title: "iTerm", ancestors: [9] }]);
    assert.deepEqual(hp.settings.openSessions.map((x) => x.session_id), ["s-held"]);
  });
  it("Go to on its card opens a tab on the same process", async () => {
    opened.length = 0;
    await hp.actOnTab("focus-tab", 7101, "Fix the build");
    assert.equal(opened.length, 1);
    assert.equal(opened[0].type, "session-atlas-terminal");
    assert.equal(opened[0].state.instance, "claude-h1");
    assert.equal(opened[0].state.command, "x");
    assert.equal(reg().get("claude-h1").pty.killed, false);
  });
  it("the banner's Bring back: only held pids from the catalog", async () => {
    opened.length = 0;
    hp.handleMessage({ origin: EVIL, source: frame, data: { source: "session-atlas", type: "reattach-held", ptyPids: [7102] } });
    hp.handleMessage({ origin: good.origin, source: frame, data: { source: "session-atlas", type: "reattach-held", ptyPids: ["7102", 1] } });
    await settle(20);
    assert.equal(opened.length, 0);
    hp.handleMessage({ origin: good.origin, source: frame, data: { source: "session-atlas", type: "reattach-held", ptyPids: [7102, 4242] } });
    await settle(20);
    assert.deepEqual(opened.map((o) => o.state.instance), ["claude-h2"]);
  });
  it("End: the held process ends; an attached one is not touched", () => {
    const attached = fakePty(7104);
    reg().set("claude-h4", { pty: attached, timer: null, held: false });
    const pty = fakePty(7103);
    held.holdForReclaim("claude-h3", pty, { kind: "codex", instance: "claude-h3", title: "Codex" });
    assert.equal(hp.releaseHeldTabs([7103, 7104]), 1);
    assert.equal(held.releaseHeld("claude-h4"), false, "a process in a tab is the tab's to end");
    assert.equal(pty.killed, true);
    assert.equal(attached.killed, false);
    assert.ok(!reg().has("claude-h3"));
  });
  it("a held process that exited by itself is forgotten", () => {
    reg().get("claude-h1").pty.exited = true;
    assert.ok(!hp.heldTabs().some((t) => t.ptyPid === 7101));
    assert.ok(!reg().has("claude-h1"));
  });
});

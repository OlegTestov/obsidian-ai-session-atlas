import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSrc, ROOT } from "./helpers/load-src.mjs";

const realLoad = Module._load;
const notices = [];
Module._load = (name, ...args) => name === "obsidian"
  ? { Notice: class { constructor(...a) { notices.push(a); } } } : realLoad(name, ...args);
const { MailNudger, scanMail } = loadSrc("mail-nudge");
const { TerminalMethods } = loadSrc("terminal");
const { InputMethods } = loadSrc("input");
const { PASTE_START, PASTE_END } = loadSrc("constants");
Module._load = realLoad;

const SID = { claude: "claude-session", codex: "codex-session" };
const fixture = path.join(ROOT, "tools", "fixtures", "codex_screens.json");
const codexScreens = JSON.parse(fs.readFileSync(fixture, "utf8"));

function fakeTab(agent, pid) {
  const tab = { pid, status: "idle", writes: [], draft: false, dialog: false };
  const visible = () => {
    if (tab.rows) return tab.rows;
    if (agent === "codex") return tab.draft ? codexScreens.idle_draft : codexScreens.idle;
    return ["──────", tab.draft ? "❯ draft" : "❯ Try something", "──────", ""];
  };
  const buffer = {
    baseY: 0, viewportY: 0, get cursorX() { return tab.cursorX ?? 2; },
    get cursorY() { return visible().findLastIndex(row => row.startsWith(agent === "codex" ? "›" : "❯")); },
    getLine(y) {
      const row = visible()[y] || "";
      return {
        translateToString: () => row,
        getCell: x => ({ getChars: () => row[x] || "", isDim: () => !tab.draft }),
      };
    },
  };
  tab.leaf = { view: { emulator: {
    terminal: { cols: 120, get rows() { return visible().length; }, buffer: { active: buffer } },
    pseudoterminal: Promise.resolve({ shell: { stdin: { write: text => tab.writes.push(text) } } }),
  } } };
  return tab;
}

test("mail delivery wakes both kinds of tab through the plugin input path", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mail-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The standalone CLI uses this same layout. Tests ship with the plugin, so keep them independent
  // of the user's private installation and emulate its atomic rename.
  const bind = (name, sid) => {
    fs.mkdirSync(path.join(root, name, "inbox"), { recursive: true });
    if (sid) fs.writeFileSync(path.join(root, name, "session"), sid + "\n");
  };
  let serial = 0;
  const mail = (recipient, sender) => {
    const dir = path.join(root, recipient, "inbox");
    const file = `1700000000000-${(++serial).toString(16).padStart(12, "0")}.json`;
    const tmp = path.join(dir, "." + file);
    fs.writeFileSync(tmp, JSON.stringify({ from: sender, text: "private body\r/quit" }));
    fs.renameSync(tmp, path.join(dir, file));
  };
  bind("claude", SID.claude);
  bind("codex", SID.codex);
  bind("unbound");
  bind("closed", "closed-session");
  mail("codex", "claude");
  mail("claude", "codex");
  mail("unbound", "claude");
  mail("closed", "codex");
  fs.symlinkSync(path.join(root, "claude"), path.join(root, "linked"));
  assert.deepEqual(scanMail(root).map(batch => batch.name).sort(), ["claude", "closed", "codex"]);

  const claude = fakeTab("claude", 10);
  const codex = fakeTab("codex", 20);
  codex.status = "busy";
  claude.dialog = true;
  const tabs = [claude, codex];
  const terminal = TerminalMethods.prototype;
  const input = InputMethods.prototype;
  const plugin = {
    settings: { wakeOnMail: false, agentMailRoot: root },
    t: key => key,
    checkImages: () => [],
    screenLines: terminal.screenLines,
    emptyAgentPrompt: terminal.emptyAgentPrompt,
    ptyInput: terminal.ptyInput,
    fetchActive: async () => ({ sessions: [
      { session_id: SID.claude, status: "idle", pid: 11, ancestors: [10] },
      { session_id: SID.codex, status: codex.status, pid: 21, ancestors: [20] },
      { session_id: "closed-session", status: "idle", pid: 31, ancestors: [30] },
    ] }),
    tabForSession: async session => tabs.find(tab => session.ancestors.includes(tab.pid)),
    terminalTabs: async () => tabs,
    isDescendant: (child, parent) => child === parent + 1,
    readAgentState: (_pid, leaf) => {
      const tab = tabs.find(tab => tab.leaf === leaf);
      const agent = tab === claude ? "claude" : "codex";
      return { agent, sessionIds: [SID[agent]], status: tab.dialog ? "waiting" : tab.status };
    },
    answerPage: () => {},
    checkTarget: input.checkTarget,
    sendText: input.sendText,
  };
  let now = 0;
  const nudger = new MailNudger(plugin, () => now);
  t.after(() => nudger.watcher?.close());
  await nudger.poll();
  assert.equal(nudger.watcher, null);
  plugin.settings.wakeOnMail = true;
  await nudger.poll();
  assert.deepEqual([claude.writes, codex.writes], [[], []]);

  codex.status = "idle";
  claude.dialog = false;
  claude.draft = true;
  codex.draft = true;
  await nudger.poll();
  assert.deepEqual([claude.writes, codex.writes], [[], []]);

  claude.draft = false;
  codex.draft = false;
  await nudger.poll();
  for (const [tab, sender] of [[claude, "codex"], [codex, "claude"]]) {
    assert.equal(tab.writes.length, 1);
    assert.ok(tab.writes[0].startsWith(PASTE_START + `You have 1 new message from ${sender}.`));
    assert.ok(tab.writes[0].endsWith(PASTE_END + "\r"));
    assert.doesNotMatch(tab.writes[0], /private body/);
  }
  await nudger.poll();
  mail("codex", "unsafe\r/quit");
  now = 59999;
  await nudger.poll();
  assert.equal(codex.writes.length, 1);
  now = 60000;
  await nudger.poll();
  assert.equal(claude.writes.length, 1);
  assert.equal(codex.writes.length, 2);
  assert.doesNotMatch(codex.writes[1], /unsafe|\/quit/);
});

function rig(t, { tabless = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mail-rig-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = fakeTab("claude", 10);
  const codex = fakeTab("codex", 20);
  const tabs = tabless ? [] : [claude, codex];
  const active = { claude: "idle", codex: "idle" };
  const terminal = TerminalMethods.prototype;
  const input = InputMethods.prototype;
  const plugin = {
    settings: { wakeOnMail: true, agentMailRoot: root },
    t: key => key, checkImages: () => [],
    screenLines: terminal.screenLines, emptyAgentPrompt: terminal.emptyAgentPrompt, ptyInput: terminal.ptyInput,
    fetchActive: async () => ({ sessions: [
      { session_id: SID.claude, status: active.claude, pid: 11, ancestors: [10] },
      { session_id: SID.codex, status: active.codex, pid: 21, ancestors: [20] },
    ] }),
    tabForSession: async session => tabs.find(tab => session.ancestors.includes(tab.pid)),
    terminalTabs: async () => tabs,
    isDescendant: (child, parent) => child === parent + 1,
    readAgentState: (_pid, leaf) => {
      const tab = tabs.find(tab => tab.leaf === leaf);
      const agent = tab === claude ? "claude" : "codex";
      return { agent, sessionIds: tab.sessionIds || [SID[agent]], status: tab.dialog ? "waiting" : tab.status };
    },
    answerPage: () => {}, checkTarget: input.checkTarget, sendText: input.sendText,
  };
  const clock = { now: 1e6 };
  const nudger = new MailNudger(plugin, () => clock.now);
  t.after(() => nudger.watcher?.close());
  let serial = 0;
  const box = (name, sid) => {
    fs.mkdirSync(path.join(root, name, "inbox"), { recursive: true });
    if (sid !== undefined) fs.writeFileSync(path.join(root, name, "session"), sid + "\n");
  };
  const mail = (to, from, text = "hi") => {
    const dir = path.join(root, to, "inbox");
    const file = `${1700000000000 + (++serial)}-${serial.toString(16).padStart(12, "0")}.json`;
    fs.writeFileSync(path.join(dir, "." + file), JSON.stringify({ from, text }));
    fs.renameSync(path.join(dir, "." + file), path.join(dir, file));
  };
  box("claude", SID.claude);
  box("codex", SID.codex);
  return { root, claude, codex, active, plugin, clock, nudger, box, mail, poll: () => nudger.poll() };
}

const LINE = (n, from, name) => PASTE_START + `You have ${n} new ${n === 1 ? "message" : "messages"}${from ? " from " + from : ""}. Read with mail_inbox (as: ${name})` + PASTE_END + "\r";

test("the notice names the mailbox and stays 4 s", async t => {
  const r = rig(t);
  r.plugin.t = (key, vars) => key + JSON.stringify(vars);
  notices.length = 0;
  r.mail("codex", "claude");
  await r.poll();
  assert.deepEqual(notices, [['mail.sent{"name":"codex"}', 4000]]);
});

test("the root is watched recursively and a change triggers a check", async t => {
  const r = rig(t);
  const real = fs.watch;
  const calls = [];
  fs.watch = (...args) => { calls.push(args); return { close() {}, on() {} }; };
  t.after(() => { fs.watch = real; });
  await r.poll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], r.root);
  assert.equal(calls[0][1].recursive, true);
  r.mail("codex", "claude");
  calls[0][2]();
  await new Promise(resolve => setImmediate(resolve));
  await r.nudger.poll();
  assert.equal(r.codex.writes.length, 1);
});

test("busy by Active status: nothing is typed, then one nudge once idle", async t => {
  const r = rig(t);
  r.mail("codex", "claude");
  r.active.codex = "busy";
  await r.poll();
  assert.deepEqual(r.codex.writes, []);
  r.active.codex = "idle";
  await r.poll();
  assert.deepEqual(r.codex.writes, [LINE(1, "claude", "codex")]);
});

test("busy by live state while Active still says idle: nothing, then one nudge", async t => {
  const r = rig(t);
  r.mail("claude", "codex");
  r.claude.status = "busy";
  await r.poll();
  assert.deepEqual(r.claude.writes, []);
  r.claude.status = "idle";
  await r.poll();
  assert.deepEqual(r.claude.writes, [LINE(1, "codex", "claude")]);
});

test("a dialog (waiting) gets nothing, in Active and in the live state", async t => {
  const r = rig(t);
  r.mail("claude", "codex");
  r.active.claude = "waiting";
  await r.poll();
  r.active.claude = "idle";
  r.claude.dialog = true;
  await r.poll();
  assert.deepEqual(r.claude.writes, []);
  r.claude.dialog = false;
  await r.poll();
  assert.equal(r.claude.writes.length, 1);
});

for (const agent of ["claude", "codex"]) {
  test(`${agent}: typed text in the prompt blocks the nudge, a dim hint does not`, async t => {
    const r = rig(t);
    r.mail(agent, "other");
    r[agent].draft = true;
    await r.poll();
    assert.deepEqual(r[agent].writes, []);
    r[agent].draft = false;
    await r.poll();
    assert.equal(r[agent].writes.length, 1);
  });
}

test("unknown screens count as not empty", async t => {
  const r = rig(t);
  r.mail("claude", "codex");
  r.mail("codex", "claude");
  r.claude.rows = ["❯ Try something"];
  r.codex.cursorX = 5;
  await r.poll();
  assert.deepEqual([r.claude.writes, r.codex.writes], [[], []]);
  r.claude.rows = null;
  r.claude.cursorX = 3;
  await r.poll();
  assert.deepEqual(r.claude.writes, []);
});

test("an unbound mailbox (no or invalid session file) gets nothing", async t => {
  const r = rig(t);
  r.box("nobody");
  r.box("short", "abc");
  r.box("bad", "id with spaces and ../");
  for (const name of ["nobody", "short", "bad"]) r.mail(name, "claude");
  fs.symlinkSync(path.join(r.root, "claude"), path.join(r.root, "linked"));
  assert.deepEqual(scanMail(r.root), []);
  await r.poll();
  assert.deepEqual([r.claude.writes, r.codex.writes], [[], []]);
});

test("a bound session with no tab gets nothing", async t => {
  const r = rig(t, { tabless: true });
  r.mail("codex", "claude");
  await r.poll();
  assert.deepEqual(r.codex.writes, []);
});

test("a tab that does not hold the bound session id gets nothing", async t => {
  const r = rig(t);
  r.mail("codex", "claude");
  r.codex.sessionIds = ["another-session"];
  await r.poll();
  assert.deepEqual(r.codex.writes, []);
});

test("a session swapped in the tab while the input opens gets nothing", async t => {
  const r = rig(t);
  r.mail("codex", "claude");
  const open = r.plugin.ptyInput;
  r.plugin.ptyInput = async leaf => {
    const stdin = await open.call(r.plugin, leaf);
    r.codex.sessionIds = ["another-session"];
    return stdin;
  };
  await r.poll();
  assert.deepEqual(r.codex.writes, []);
});

test("the same files twice give exactly one nudge", async t => {
  const r = rig(t);
  r.mail("codex", "claude");
  await r.poll();
  await r.poll();
  r.clock.now += 3600000;
  await r.poll();
  assert.equal(r.codex.writes.length, 1);
});

test("a newer file waits for the 60 s window, then gets one more nudge", async t => {
  const r = rig(t);
  r.mail("codex", "claude");
  await r.poll();
  r.mail("codex", "claude");
  r.clock.now += 59999;
  await r.poll();
  assert.equal(r.codex.writes.length, 1);
  r.clock.now += 1;
  await r.poll();
  assert.deepEqual(r.codex.writes, [LINE(1, "claude", "codex"), LINE(2, "claude", "codex")]);
});

test("message bodies are never typed", async t => {
  const r = rig(t);
  r.mail("codex", "claude", "SECRET-BODY\x1b[2J\n/quit\r\x03");
  await r.poll();
  assert.equal(r.codex.writes.length, 1);
  assert.doesNotMatch(r.codex.writes[0], /SECRET|quit/);
  assert.ok(!r.codex.writes[0].includes("\x1b[2J") && !r.codex.writes[0].includes("\x03"));
  assert.deepEqual(r.codex.writes, [LINE(1, "claude", "codex")]);
});

test("senders failing the name pattern are dropped and the list is deduped", async t => {
  const r = rig(t);
  r.mail("codex", "claude");
  r.mail("codex", "Bad Name\r/quit");
  r.mail("codex", "other");
  r.mail("codex", "claude");
  r.mail("codex", 5);
  await r.poll();
  assert.deepEqual(r.codex.writes, [LINE(5, "claude, other", "codex")]);
});

test("one paste-wrapped write with the Enter inside it, no timers", async t => {
  const r = rig(t);
  r.mail("claude", "codex");
  await r.poll();
  assert.equal(r.claude.writes.length, 1);
  assert.ok(r.claude.writes[0].startsWith(PASTE_START) && r.claude.writes[0].endsWith(PASTE_END + "\r"));
  assert.equal(r.claude.writes[0].split("\r").length, 2);
});

test("the installed mailbox CLI can exchange letters in isolation", t => {
  const script = path.join(ROOT, "atlas", "agent_mail.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mail-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = (...args) => execFileSync("python3", [script, ...args], {
    encoding: "utf8", env: { ...process.env, AGENT_MAIL_HOME: root },
  });
  cli("register", "claude", SID.claude);
  cli("register", "codex", SID.codex);
  cli("send", "claude", "codex", "request");
  assert.equal(scanMail(root)[0].id, SID.codex);
  assert.match(cli("inbox", "codex"), /from claude[\s\S]*request/);
  cli("send", "codex", "claude", "reply");
  assert.equal(scanMail(root)[0].id, SID.claude);
  assert.match(cli("inbox", "claude"), /from codex[\s\S]*reply/);
  assert.deepEqual(scanMail(root), []);
});

test("open tab titles create session-specific routes without registration", async t => {
  const r = rig(t);
  const sid = "10000000-0000-0000-0000-000000000001";
  const automatic = "atlas-x-" + sid.replaceAll("-", "");
  r.codex.title = "Сверка заметок";
  r.codex.sessionIds = [sid];
  let sessions = [{ session_id: sid, agent: "codex", status: "busy", pid: 21, ancestors: [20] },
    { session_id: "10000000-0000-0000-0000-000000000002", agent: "claude", status: "idle", ancestors: [] }];
  r.plugin.fetchActive = async () => ({ sessions });
  await r.poll();

  const directory = path.join(r.root, ".atlas-tabs");
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const routes = () => JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(routes(), [{ mailbox: automatic, title: r.codex.title, id: sid, agent: "codex" }]);
  r.box(automatic);
  r.mail(automatic, "claude");
  await r.poll();
  assert.deepEqual(r.codex.writes, []);

  r.codex.title = "Сверка заметок (2)";
  sessions[0].status = "idle";
  await r.poll();
  assert.equal(routes()[0].title, r.codex.title);
  assert.deepEqual(r.codex.writes, [LINE(1, "claude", automatic)]);
  assert.deepEqual(r.claude.writes, []);
  assert.equal(fs.existsSync(path.join(r.root, automatic, "session")), false);

  sessions = [];
  await r.poll();
  assert.equal(fs.existsSync(file), false);
});

test("a renamed Claude Code session still needs an empty prompt", async t => {
  const r = rig(t);
  const upper = "──────── Проверка отчёта ─";
  r.mail("claude", "codex");
  r.claude.draft = true;
  r.claude.rows = [upper, "❯\u00a0draft", "────────", ""];
  await r.poll();
  assert.deepEqual(r.claude.writes, []);

  r.claude.draft = false;
  r.claude.rows = [upper, "❯\u00a0 ", "────────", ""];
  await r.poll();
  assert.deepEqual(r.claude.writes, [LINE(1, "codex", "claude")]);
});

test("a fresh Claude or Codex limit is visible to Agent Mail and keeps mail queued", async t => {
  const r = rig(t);
  const claudeId = "10000000-0000-0000-0000-000000000001";
  const codexId = "10000000-0000-0000-0000-000000000002";
  const claudeBox = "atlas-c-" + claudeId.replaceAll("-", "");
  const codexBox = "atlas-x-" + codexId.replaceAll("-", "");
  r.claude.title = "Review";
  r.codex.title = "Build";
  r.claude.sessionIds = [claudeId];
  r.codex.sessionIds = [codexId];
  r.clock.now = Date.now();
  const future = new Date(r.clock.now + 30 * 60 * 1000).toISOString().slice(11, 16);
  r.plugin.fetchActive = async () => ({ sessions: [
    { session_id: claudeId, agent: "claude", status: "idle", pid: 11, ancestors: [10] },
    { session_id: codexId, agent: "codex", status: "idle", pid: 21, ancestors: [20] },
  ] });
  const script = path.join(ROOT, "atlas", "agent_mail.py");
  const cli = (...args) => execFileSync("python3", [script, ...args], {
    encoding: "utf8", env: { ...process.env, AGENT_MAIL_HOME: r.root },
  });
  await r.poll();
  const claudeRequest = cli("send-title", "codex", "Review", "test request").trim();
  await r.poll();
  assert.equal(r.claude.writes.length, 1);
  // Claude only reported the limit after Atlas prompted it to read the mail.
  r.claude.rows = ["You've hit your 5-hour limit · resets " + future + " (UTC)",
    "────────", "❯", "────────", "⏺ Usage limit reached · esc to cancel"];
  r.codex.rows = ["■ You’ve hit your usage limit. Try again at " + future + " (UTC).",
    "", "› Ask Codex to do anything", ""];
  await r.poll();
  for (const name of [claudeBox, codexBox]) {
    const peer = JSON.parse(cli("peers")).find(row => row.name === name);
    assert.equal(peer.status.kind, "usage_limit");
    assert.equal(peer.status.reset_text, future + " (UTC)");
  }
  assert.ok(fs.readdirSync(path.join(r.root, claudeBox, "inbox")).some(file => file.includes(claudeRequest)));
  const codexRequest = cli("send-title", "claude", "Build", "test reply").trim();
  await r.poll();
  assert.equal(r.claude.writes.length, 1);
  assert.ok(fs.readdirSync(path.join(r.root, codexBox, "inbox")).some(file => file.includes(codexRequest)));
  assert.deepEqual(r.codex.writes, []);
  r.codex.rows = null;
  await r.poll();
  assert.equal(r.codex.writes.length, 1);
  assert.equal(JSON.parse(cli("peers")).find(row => row.name === codexBox).status, undefined);
});

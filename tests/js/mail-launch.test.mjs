import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { loadSrc } from "./helpers/load-src.mjs";

const realLoad = Module._load;
Module._load = (name, ...args) => name === "obsidian"
  ? { Notice: class {}, addIcon() {}, PluginSettingTab: class {}, Setting: class {} }
  : name === "electron" ? {} : realLoad(name, ...args);
const { mailLaunchWords, MailLaunchMethods, sideloadBlocked } = loadSrc("mail-launch");
const { shellQuote, agentTabEnv } = loadSrc("agents");
const { DEFAULT_SETTINGS } = loadSrc("settings");
const { STRINGS } = loadSrc("i18n");
Module._load = realLoad;

const PYTHON = "/A path/bin/python3";
const SCRIPT = "/Users/me/Library/Application Support/session-atlas/runtime/atlas/agent_mail.py";
const ROOT = "/Mail/it's root";
const input = { python: PYTHON, script: SCRIPT, root: ROOT };
const TOOLS = ["mail_send", "mail_inbox", "mail_register", "mail_peers"].map(t => `mcp__agent-mail__${t}`).join(",");

test("Claude gets one --mcp-config word and one --allowedTools word, both in the = form", () => {
  const words = mailLaunchWords("claude", input);
  assert.equal(words.length, 2);
  assert.equal(words[0].startsWith("--mcp-config="), true);
  assert.deepEqual(JSON.parse(words[0].slice("--mcp-config=".length)), { mcpServers: { "agent-mail": {
    type: "stdio", command: PYTHON, args: [SCRIPT], env: { AGENT_MAIL_NAME: "claude", AGENT_MAIL_HOME: ROOT } } } });
  assert.equal(words[1], `--allowedTools=${TOOLS}`);
});

test("Codex gets -c pairs: command, args, env with its own name, and approval without prompts", () => {
  assert.deepEqual(mailLaunchWords("codex", input), [
    "-c", `mcp_servers.agent-mail.command=${JSON.stringify(PYTHON)}`,
    "-c", `mcp_servers.agent-mail.args=[${JSON.stringify(SCRIPT)}]`,
    "-c", `mcp_servers.agent-mail.env={AGENT_MAIL_NAME="codex",AGENT_MAIL_HOME=${JSON.stringify(ROOT)}}`,
    "-c", 'mcp_servers.agent-mail.default_tools_approval_mode="approve"',
  ]);
  assert.deepEqual(mailLaunchWords("other", input), []);
});

test("the shell-quoted line splits back into the same words with paths that have spaces and quotes", () => {
  for (const kind of ["claude", "codex"]) {
    const words = mailLaunchWords(kind, input);
    const line = words.map(shellQuote).join(" ");
    const out = execFileSync("/bin/zsh", ["-c", 'print -rN -- "${(@Q)${(z)1}}"', "x", line], { encoding: "utf8" });
    assert.deepEqual(out.split("\0").slice(0, -1), words, kind);
  }
});

function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mail-launch-"));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(path.join(runtime, "atlas"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "atlas", "agent_mail.py"), "");
  const plugin = Object.assign(Object.create(MailLaunchMethods.prototype), {
    settings: { wakeOnMail: true, agentMailRoot: "/Mail/root" },
    dataDir: () => dir, runtimeDir: () => runtime,
    embeddedPayload: () => ({ version: "1", files: {} }), extractRuntime: () => runtime,
    findPython: async () => ({ path: "/usr/bin/python3" }),
  }, over);
  const file = kind => path.join(dir, "agent-mail-args", kind);
  return { plugin, file, runtime };
}

test("writeMailArgs writes one line per agent with the bundled server and the mail root", async () => {
  const { plugin, file, runtime } = fixture();
  await plugin.writeMailArgs();
  for (const kind of ["claude", "codex"]) {
    const text = fs.readFileSync(file(kind), "utf8");
    assert.equal(text.endsWith("\n") && text.indexOf("\n") === text.length - 1, true, kind);
    assert.equal(text, mailLaunchWords(kind, { python: "/usr/bin/python3", root: "/Mail/root",
      script: path.join(runtime, "atlas", "agent_mail.py") }).map(shellQuote).join(" ") + "\n");
  }
});

test("writeMailArgs writes empty lines when mail is off, python is missing, or the server file is missing", async () => {
  for (const over of [{ settings: { wakeOnMail: false, agentMailRoot: "/Mail/root" } },
                      { findPython: async () => null },
                      { embeddedPayload: () => null, runtimeDir: () => "/nonexistent/runtime" }]) {
    const { plugin, file } = fixture(over);
    await plugin.writeMailArgs();
    for (const kind of ["claude", "codex"]) assert.equal(fs.readFileSync(file(kind), "utf8").trim(), "");
  }
});

test("writeMailArgs rewrites the files when a setting changes, and a failure is logged, not thrown", async () => {
  const { plugin, file } = fixture();
  await plugin.writeMailArgs();
  assert.match(fs.readFileSync(file("claude"), "utf8"), /Mail\/root/);
  plugin.settings.agentMailRoot = "/Other/root";
  await plugin.writeMailArgs();
  assert.match(fs.readFileSync(file("codex"), "utf8"), /Other\/root/);
  plugin.settings.wakeOnMail = false;
  await plugin.writeMailArgs();
  assert.equal(fs.readFileSync(file("claude"), "utf8").trim(), "");
  const errors = [], realError = console.error;
  console.error = (...a) => errors.push(a);
  plugin.settings.wakeOnMail = true;
  try {
    plugin.findPython = async () => { throw new Error("boom"); };
    await plugin.writeMailArgs();
  } finally { console.error = realError; }
  assert.equal(errors.length, 1);
});

test("a slow older write never overwrites a newer one", async () => {
  const { plugin, file } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const find = plugin.findPython;
  plugin.findPython = async () => { await gate; return find(); };
  const slow = plugin.writeMailArgs();
  plugin.findPython = async () => null;
  await plugin.writeMailArgs();
  release();
  await slow;
  assert.equal(fs.readFileSync(file("claude"), "utf8").trim(), "");
});

test("an instance unloaded while Python was looked up writes nothing", async () => {
  const { plugin, file } = fixture();
  await plugin.writeMailArgs();
  const before = fs.readFileSync(file("claude"), "utf8");
  let extracted = 0;
  plugin.extractRuntime = () => { extracted++; return plugin.runtimeDir(); };
  plugin.settings.agentMailRoot = "/Other/root";
  plugin.findPython = async () => { plugin._loaded = false; return { path: "/usr/bin/python3" }; };
  await plugin.writeMailArgs();
  assert.equal(fs.readFileSync(file("claude"), "utf8"), before);
  assert.equal(extracted, 0);
});

test("a managed Claude Code policy against launch-time MCP configs leaves Claude without the flags", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-"));
  const managed = path.join(dir, "managed-settings.json");
  assert.equal(sideloadBlocked(managed), false);                      // no file
  fs.writeFileSync(managed, "{not json");
  assert.equal(sideloadBlocked(managed), false);
  fs.writeFileSync(managed, JSON.stringify({ disableSideloadFlags: false }));
  assert.equal(sideloadBlocked(managed), false);
  fs.writeFileSync(managed, JSON.stringify({ disableSideloadFlags: true }));
  assert.equal(sideloadBlocked(managed), true);
  const { plugin, file } = fixture({ claudeManagedSettings: managed });
  await plugin.writeMailArgs();
  assert.equal(fs.readFileSync(file("claude"), "utf8").trim(), "");
  assert.match(fs.readFileSync(file("codex"), "utf8"), /agent-mail/);
});

test("mail is on by default for new installs", () => {
  assert.equal(DEFAULT_SETTINGS.wakeOnMail, true);
});

test("the mail folder setting says a custom folder is created when its parent exists, in both languages", () => {
  for (const [lang, text] of Object.entries({ en: STRINGS.en["mail.root.desc"], ru: STRINGS.ru["mail.root.desc"] })) {
    assert.doesNotMatch(text, /must already exist|должна уже существовать/, lang);
  }
  assert.match(STRINGS.en["mail.root.desc"], /created if the folder it sits in exists/);
  assert.match(STRINGS.ru["mail.root.desc"], /создаётся, если существует папка, в которой она лежит/);
});

test("the manual setup rows and texts are gone in both languages", () => {
  for (const lang of ["en", "ru"]) assert.deepEqual(Object.keys(STRINGS[lang]).filter(k => k.startsWith("mail.setup")), []);
});

test("a tab's shell is told where this install keeps the mail flags and the extra arguments", () => {
  assert.deepEqual(agentTabEnv("/Data dir"), { OBS_AGENT_TERMINAL_ARGS_DIR: "/Data dir/agent-args",
                                               OBS_AGENT_MAIL_ARGS_DIR: "/Data dir/agent-mail-args" });
});

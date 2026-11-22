import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setGlobal } from "./helpers/globals.mjs";
import { loadSrc, ROOT } from "./helpers/load-src.mjs";
import { loadPage } from "./helpers/page.mjs";
import { payload } from "../../esbuild.config.mjs";
import { shellRegistry } from "../../tools/agent_registry.mjs";

const notices = [];
const realLoad = Module._load;
Module._load = (id, ...args) => id === "obsidian" ? {
  addIcon() {},
  Notice: class { constructor(message) { notices.push(message); } },
  ItemView: class { constructor(leaf) { this.leaf = leaf; } },
  PluginSettingTab: class {},
} : id === "electron" ? {} : realLoad(id, ...args);

const real = JSON.parse(fs.readFileSync(path.join(ROOT, "atlas/agents.json")));
const fake = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/js/helpers/fake-agent.json")));
const load = name => loadSrc(name, [fake]);
const UUID = "01234567-89AB-cdef-0123-456789abcdef";
const ID = "fk_ab12cd34";

test("the plugin payload contains the production registry and launcher modules", () => {
  const { files } = payload();
  assert.deepEqual(JSON.parse(files["atlas/agents.json"]), real);
  for (const id of ["claude", "codex"]) {
    assert.equal(files[`scripts/agent-${id}.zsh`],
                 fs.readFileSync(path.join(ROOT, `obsidian-plugin/scripts/agent-${id}.zsh`), "utf8"));
  }
  assert.deepEqual(real.map(row => row.id), ["claude", "codex", "opencode"]);
  assert.match(files["scripts/agent-opencode.zsh"], /atlas\.opencode_tabs/);
  assert.equal(JSON.parse(files["opencode-tab/package.json"]).exports["./tui"], "./tui.mjs");
});

test("Python, the plugin and generated zsh agree on every session ID grammar", t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-registry-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const rows = [...real, fake];
  const registry = path.join(tmp, "agents.json");
  const generated = path.join(tmp, "agent-kinds.zsh");
  const lib = path.join(tmp, "agent-sessions-lib.zsh");
  fs.writeFileSync(registry, JSON.stringify(rows));
  fs.writeFileSync(generated, shellRegistry(rows));
  fs.copyFileSync(path.join(ROOT, "obsidian-plugin/scripts/agent-sessions-lib.zsh"), lib);
  assert.equal(fs.readFileSync(path.join(ROOT, "obsidian-plugin/scripts/agent-kinds.zsh"), "utf8"),
               payload().files["scripts/agent-kinds.zsh"]);
  const { agentKinds, idPattern, getAgent, validId } = load("agent-registry");
  assert.deepEqual(agentKinds, rows.map(row => row.id));
  const ids = [UUID, UUID.toLowerCase(), UUID + "\n", "-".repeat(36), ID, ID.toUpperCase(), ID + "-", "ses_" + "Ab01".repeat(6) + "x2", "ses_short", ""];
  const python = execFileSync("/usr/bin/python3", ["-c", [
    "import json, sys",
    "from pathlib import Path",
    "from atlas.agents import _load",
    "_, patterns = _load(Path(sys.argv[1]))",
    "print(json.dumps({k: [p.pattern, [p.fullmatch(s) is not None for s in sys.argv[2:]]]",
    "                  for k, p in patterns.items()}))",
  ].join("\n"), registry, ...ids], { cwd: ROOT, encoding: "utf8" });
  const checked = JSON.parse(python);
  for (const row of rows) {
    const { id, mailPrefix } = row;
    const args = ["-uc", [
      'source "$1"; load_agent_patterns || exit 1; shift',
      'kind="$1"; shift; print -r -- "$ATLAS_MAIL_PREFIXES[$kind]"',
      'for sid in "$@"; do if valid_id "$kind" "$sid"; then print yes; else print no; fi; done',
    ].join("\n"), "grammar", lib, id, ...ids];
    const [prefix, ...valid] = execFileSync("/bin/zsh", args, { encoding: "utf8" }).trim().split("\n");
    assert.equal(prefix, mailPrefix);
    assert.equal(checked[id][0], idPattern(id));
    assert.deepEqual(checked[id][1], ids.map(sid => validId(id, sid)));
    assert.deepEqual(checked[id][1], valid.map(value => value === "yes"));
  }
  assert.equal(getAgent("fake").short, "Fake");
  assert.equal(validId("fake", ID), true);
  assert.equal(validId("fake", UUID), false);
  assert.equal(validId("claude", ID), false);
  assert.equal(validId("codex", UUID), true);
  assert.equal(validId("codex", UUID + "\n"), false);
  assert.throws(() => validId("unknown", UUID), /Unknown agent/);
  const { seenFromPage } = load("unread");
  assert.deepEqual(seenFromPage([ID, UUID], new Map([[ID, "fake"], [UUID, "fake"]])), [ID]);
});

test("a registered fake appears in settings without inheriting terminal dispatch", async () => {
  const { AtlasSettingTab } = load("settings");
  const plugin = {
    t: key => key, settings: {}, dataDir: () => "/tmp", readServerConfig: () => ({}),
    codexHooksPath: () => "/tmp/hooks.json",
  };
  const settings = new AtlasSettingTab({}, plugin);
  const definitions = settings.getSettingDefinitions();
  const group = definitions.find(def => def.heading === "settings.agentsHeading");
  assert.deepEqual(group.items.find(item => item.name === fake.label)?.name, fake.label);
  const { AgentMethods, parseLaunch, agentArgs } = load("agents");
  for (const words of [`fake resume ${ID}`, `fake --resume ${ID}`]) {
    assert.throws(() => parseLaunch("cd /tmp && " + words), /fake does not support terminal tabs/);
  }
  assert.equal(parseLaunch(`cd /tmp && claude --resume ${ID}`), null);
  assert.throws(() => agentArgs("/script", "fake", "fake-tab"), /fake does not support terminal tabs/);
  const { TerminalMethods } = load("terminal");
  const noTab = () => assert.fail("an unsupported agent tried to open a tab");
  const host = Object.assign(Object.create(TerminalMethods.prototype), { openAgent: noTab, t: (key, vars) => vars.error });
  await host.openCommandInTerminal(`cd /tmp && fake resume ${ID}`, "/tmp", "Fake");
  assert.match(notices.at(-1), /fake does not support terminal tabs/);

  const ribbons = [];
  const installed = {
    t: key => key, addRibbonIcon: icon => ribbons.push(icon), addCommand() {}, refreshAgentButtons() {},
  };
  const palette = [];
  installed.addCommand = cmd => palette.push(cmd.id);
  AgentMethods.prototype.addAgentButtons.call(installed);
  assert.deepEqual(ribbons, ["atlas-claude", "atlas-codex", "atlas-opencode"]);
  assert.deepEqual(palette, ["open-claude-code-terminal", "open-codex-terminal", "new-opencode-session"]);
});

test("restore, held tabs and startup refuse fake without rewriting its kind", async t => {
  const errors = t.mock.method(console, "error", () => {});
  const { RestoreMethods } = load("restore");
  const openSessions = [{ agent: "fake", session_id: ID }, { session_id: UUID }];
  const host = Object.assign(Object.create(RestoreMethods.prototype), {
    settings: { openSessions },
    tabForSession: async () => true,
    heldForSession: () => false,
    saveData: async () => {},
  });
  host.initRestore();
  assert.deepEqual(host.restorable, [openSessions[1]]);
  await host.trackOpenSessions(openSessions);
  assert.deepEqual(host.settings.openSessions.map(row => [row.agent, row.session_id]), [["claude", UUID]]);
  const { HeldMethods, registry } = load("held");
  setGlobal("window", { addEventListener() {} });
  try {
    registry().set("fake-tab", { held: true, pty: { pid: 12 }, state: { kind: "fake" } });
    const workspace = { iterateAllLeaves() {} };
    assert.deepEqual(HeldMethods.prototype.heldTabs.call({ app: { workspace } }), []);
    assert.equal(registry().get("fake-tab").state.kind, "fake");
    const leaf = { isDeferred: true, loadIfDeferred() {}, getViewState: () => ({
      type: load("constants").AGENT_VIEW_TYPE, state: { kind: "fake", instance: "fake-tab" },
    }) };
    assert.deepEqual(load("startup").deferredAgentLeaves({ iterateAllLeaves: visit => visit(leaf) }), []);
    assert.equal(leaf.getViewState().state.kind, "fake");
    const View = load("term-view").AgentTerminalView;
    const view = new View({}, {});
    view.start = () => assert.fail("an unsupported agent started a PTY");
    await view.setState({ kind: "fake", command: "fake" });
    assert.notEqual(view.getIcon(), "atlas-claude");
    assert.notEqual(view.getIcon(), "atlas-codex");
    assert.ok(errors.mock.calls.length >= 4);
  } finally {
    setGlobal("window", undefined);
  }
});

test("input and dialog entry points refuse a verified fake session", async () => {
  const { InputMethods } = load("input");
  const responses = [];
  const plugin = Object.assign(Object.create(InputMethods.prototype), {
    t: key => key,
    terminalTabs: async () => [{ pid: 22, leaf: {} }],
    isDescendant: () => true,
    readAgentState: () => ({ agent: "fake", sessionIds: [ID], status: "waiting" }),
    answerPage: (target, response) => responses.push(response),
    checkImages: () => [],
    ptyInput: () => assert.fail("an unsupported agent reached PTY input"),
  });
  const request = { ptyPid: 22, claudePid: 33, sessionId: ID, text: "hello", option: 1 };
  for (const method of ["sendText", "readDialog", "answerDialog", "previewOption", "interrupt"]) {
    assert.match((await plugin.checkTarget(request)).error, /fake does not support terminal tabs/);
    await plugin[method]({}, request);
    assert.match(responses.at(-1).reason, /fake does not support terminal tabs/);
  }
  assert.equal(await plugin.typeNudge(request, () => true), false);
});

test("the page keeps legacy all, displays fake labels and rejects native fallbacks", async () => {
  const storage = { "atlas.agents": JSON.stringify({
    search: ["codex", "claude"],
    active: { selected: ["claude", "codex"] },
    stats: { selected: ["fake"] },
  }) };
  const page = loadPage(undefined, { agents: [...real, fake], storage });
  assert.deepEqual(Array.from(page.AtlasLogic.AGENTS), ["claude", "codex", "opencode", "fake"]);
  assert.equal(page.agentQuery("search"), "");
  assert.equal(page.agentQuery("active"), "claude,codex");
  assert.equal(JSON.stringify(page.AtlasLogic.storedAgentSelection(["claude", "codex"])),
               JSON.stringify({ selected: ["claude", "codex"] }));
  assert.equal(page.AtlasLogic.storedAgentSelection(page.AtlasLogic.AGENTS), null);
  assert.equal(page.agentQuery("stats"), "fake");
  assert.equal(page.agentPassesView("search", { agent: "unknown" }), false);
  assert.equal(page.agentPassesView("search", { agent: "fake" }), true);
  assert.equal(page.agentName("fake"), fake.label);
  assert.equal(page.agentShort({ agent: "fake" }), fake.short);
  await assert.rejects(page.ensureCommands("fake"), /fake does not support command catalog/);
  assert.throws(() => page.argChoices("/model", "fake"), /fake does not support command arguments/);
  assert.throws(() => page.activeCard({ agent: "fake", session_id: ID, status: "idle" }), /fake does not support live cost/);
});

test("OpenCode launches in Atlas without enabling cross-agent or live-input features", () => {
  const page = loadPage();
  page.setOpenCodeAvailable(true);
  const sid = "ses_" + "ab".repeat(13);
  assert.equal(page.AtlasLogic.getAgent("opencode").mailPrefix, "o");
  assert.equal(page.agentPassesView("search", { agent: "opencode" }), true);
  assert.equal(page.agentPassesView("active", { agent: "opencode" }), true);
  assert.equal(page.ResumeWith.choices("claude", { opencode: true }, true).some(r => r.agent === "opencode"), false);
  assert.equal(page.AtlasLogic.newSessionAgents({ opencode: true }).includes("opencode"), true);
  const { parseLaunch } = load("agents");
  assert.equal(parseLaunch(`cd /tmp && opencode /tmp --session ${sid}`).sessionId, sid);
  assert.throws(() => parseLaunch(`cd /tmp && opencode /wrong --session ${sid}`), /Invalid OpenCode/);
  for (const [lang, label] of [["en", "Archive"], ["ru", "Архивировать"]]) {
    page.I18N.setLang(lang);
    assert.equal(page.i18n("opencode.archive"), label);
    assert.equal(page.agentBadge({ agent: "opencode" }).textContent, "OpenCode");
  }
});

test("a newer agent row leaves the Active list and catalog rendering usable", () => {
  const page = loadPage();
  const unknown = { agent: "newer-agent", session_id: ID, status: "idle" };
  const legacy = { agent: "", session_id: UUID, status: "idle" };
  assert.equal(page.AtlasLogic.agentOf(legacy), "claude");
  assert.equal(page.agentShort(legacy), "Claude");
  assert.equal(page.agentPassesView("active", legacy), true);
  assert.equal(page.agentName("newer-agent"), page.i18n("agent.unknown"));
  assert.equal(page.agentShort(unknown), page.i18n("agent.unknown"));
  assert.doesNotThrow(() => page.agentBadge(unknown));
  assert.doesNotThrow(() => page.activeCard(unknown));
  assert.equal(page.agentPassesView("active", unknown), false);
  assert.throws(() => page.agentControls(unknown), /Unknown agent: newer-agent/);
});

test("a list response after initial facets reveals OpenCode to Search and Statistics", async () => {
  const page = loadPage();
  assert.equal(page.agentPassesView("search", { agent: "opencode" }), false);
  assert.equal(page.agentPassesView("stats", { agent: "opencode" }), false);
  page.api = async () => ({ count: 0, shown: 0, plan: [], opencode_available: true });
  await page.loadList();
  assert.equal(page.agentPassesView("search", { agent: "opencode" }), true);
  assert.equal(page.agentPassesView("stats", { agent: "opencode" }), true);
});

test("OpenCode first input waits for the real composer, including the model footer", () => {
  const { openCodePromptReady } = load("opencode-tab");
  const composer = ["  ┃  Ask anything…", "  ┃  ", "  ┃  Build · Fixture model", "  ╹▀▀▀▀▀"];
  assert.equal(openCodePromptReady(composer), true);
  assert.equal(openCodePromptReady(composer.slice(0, 2).concat(composer[3])), false);
  assert.equal(openCodePromptReady(["What's new in 2.3.2", ...composer]), false);
});

import { it } from "node:test";
import assert from "node:assert/strict";
import { context, controls, definitionFor, settled, notices, Element, translate } from "./helpers/settings.mjs";

const field = (tab, key) => controls(definitionFor(tab, key));
const edit = async (control, value) => {
  control.focus?.();
  await control.type(value);
};

it("C1 closes with the focused edit saved exactly once", async () => {
  const { tab, plugin, saved, effects } = context();
  const args = field(tab, "settings.args.claude");
  await edit(args, "--chrome");
  assert.deepEqual(saved, []);
  await tab.hide?.();
  assert.equal(plugin.settings.agentArgs.claude, "--chrome");
  await args.blur();
  assert.equal(saved.length, 1);
  assert.deepEqual(effects, ["args"]);
});

it("C2 flushes the focused edit before rendering new settings", async () => {
  const { tab, plugin, saved } = context();
  const args = field(tab, "settings.args.claude");
  await edit(args, "--chrome");
  const rendered = [];
  tab.update = () => rendered.push([plugin.settings.agentArgs.claude, saved.length]);
  await tab.refresh();
  assert.deepEqual(rendered, [["--chrome", 1]]);
});

it("C2 waits for a blur already saving and the Codex folder can refresh after saving", async () => {
  const { tab, plugin, effects } = context();
  let release;
  plugin.saveData = () => new Promise(resolve => { release = resolve; });
  const folder = field(tab, "codexHook.home");
  await edit(folder, "/tmp/codex");
  const blur = folder.blur();
  const refresh = tab.refresh();
  await settled();
  assert.deepEqual(effects, []);
  release();
  await Promise.all([blur, refresh]);
  assert.ok(effects.includes("refresh"));
  assert.equal(plugin.settings.codexHome, "/tmp/codex");
});

it("C3 preserves failed input, reports the error and retries on the next blur", async () => {
  const { tab, plugin, saved } = context();
  const save = plugin.saveData;
  let attempts = 0;
  plugin.t = (key, vars) => translate("en", key, vars);
  plugin.saveData = data => {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error("disk unavailable"));
    return save(data);
  };
  const args = field(tab, "Extra Claude Code launch arguments");
  await args.type("--chrome");
  await args.blur();
  assert.equal(notices.at(-1), "Could not save: disk unavailable");
  assert.equal(args.value(), "--chrome");
  assert.deepEqual(saved, []);
  await args.blur();
  await args.blur();
  assert.equal(attempts, 2);
  assert.equal(saved[0].agentArgs.claude, "--chrome");
});

async function renderStatus(tab, view) {
  const el = new Element(view);
  const cleanup = definitionFor(tab, "setup.index").render({ settingEl: el });
  await settled();
  return { rows: el.children[0].children, cleanup };
}

it("C4 and R5 keep the short failure reason and restart in the unavailable Catalog row", async () => {
  const { tab, plugin } = context();
  plugin.serverProblem = "port busy\nfull diagnostics";
  plugin.healthInfo = async () => null;
  plugin.stopServer = () => {};
  plugin.ensureServer = async () => { plugin.healthInfo = async () => ({ app: "session-atlas" }); };
  plugin.t = (key, vars) => translate("en", key, vars);
  const el = new Element();
  const cleanup = definitionFor(tab, "Catalog").render({ settingEl: el });
  try {
    await settled();
    const [catalog, checks] = el.children[0].children;
    assert.equal(catalog.desc, "Catalog unavailable · port busy");
    assert.equal(checks.children.some(row => row.name === "Catalog server"), false);
    for (const name of ["Open catalog", "Rescan"]) {
      assert.ok(catalog.buttons.filter(button => button.text === name).every(button => button.disabled));
    }
    const restart = catalog.buttons.find(button => button.text === "Restart catalog");
    assert.ok(restart);
    assert.equal(restart.disabled, false);
    await restart.click();
    assert.equal(catalog.desc, "Ready · 3 sessions");
    assert.equal(restart.buttonEl.hidden, true);
  } finally { cleanup(); }
});

it("C4 says when a different Claude Code status line is installed", () => {
  const { tab, plugin } = context();
  plugin.statusLineState = () => ({ state: "foreign" });
  plugin.t = (key, vars) => translate("en", key, vars);
  const limits = field(tab, "Show Claude Code usage limits in Active");
  assert.equal(limits.desc, "Claude Code already has another status line.");
  assert.equal(limits.disabled, true);
});

it("C5 polls at 30 seconds when idle and 1.5 seconds while indexing", async () => {
  const { tab, plugin } = context();
  const ticks = [];
  const view = { setTimeout(fn, ms) { ticks.push({ fn, ms }); }, clearTimeout() {} };
  const { cleanup } = await renderStatus(tab, view);
  try {
    assert.equal(ticks[0].ms, 30000);
    plugin.atlasRequest = async () => ({ status: 200, data: { sessions: 3, indexing: true } });
    await ticks[0].fn();
    assert.equal(ticks[1].ms, 1500);
    plugin.atlasRequest = async () => ({ status: 200, data: { sessions: 3, indexing: false } });
    await ticks[1].fn();
    assert.equal(ticks[2].ms, 30000);
  } finally { cleanup(); }
});

it("C6 displays server auto values without writing them or saving the same selection", async () => {
  const { tab, config, effects } = context();
  for (const choice of [undefined, null, "", false, 0, [], {}]) {
    if (choice === undefined) delete config.ai_agent;
    else config.ai_agent = choice;
    const picker = field(tab, "ai.agent");
    assert.equal(picker.value(), "auto", JSON.stringify(choice));
    await picker[0]("auto");
    assert.deepEqual(effects, []);
  }
  const picker = field(tab, "ai.agent");
  await picker[0]("codex");
  await picker[0]("codex");
  assert.deepEqual(effects, [{ ai_agent: "codex" }]);
});

it("R3 shows canonical saved text, and restores invalid model efforts and paths with notices", async () => {
  const { tab, plugin, saved, config, effects } = context();
  plugin.t = (key, vars) => translate("en", key, vars);
  const model = field(tab, "Claude Code — topics and categories");
  await model.type("  opus   HIGH  ");
  await model.blur();
  assert.equal(model.value(), "");
  assert.equal(notices.at(-1), "Reasoning effort: low, medium, high, xhigh, max.");
  assert.deepEqual(effects, []);
  await model.type("  opus   high  ");
  await model.blur();
  assert.deepEqual(config.models.classification, ["opus", "high"]);
  assert.equal(model.value(), "opus high");
  await model.type("sonnet");
  await model.blur();
  assert.deepEqual(config.models.classification, ["sonnet", "low"]);
  assert.equal(model.value(), "sonnet low");
  await model.type("sonnet turbo");
  await model.blur();
  assert.equal(model.value(), "sonnet low");
  assert.equal(effects.length, 2);

  const folder = field(tab, "Codex folder");
  await folder.type("  /tmp/codex  ");
  await folder.blur();
  assert.equal(folder.value(), "/tmp/codex");
  assert.equal(saved[0].codexHome, "/tmp/codex");
  await folder.type("relative");
  await folder.blur();
  assert.equal(folder.value(), "/tmp/codex");
  assert.equal(notices.at(-1), "Enter an absolute path or a path starting with ~/.");
  assert.equal(saved.length, 1);
});

it("R1 shows the current automatic-classification state, with a fallback when unknown", async () => {
  const { tab, plugin, config } = context();
  for (const [auto, ai, expected] of [
    [null, true, "ai.classification.desc"],
    [{ enabled: false }, true, "ai.classification.off"],
    [{ enabled: true }, true, "ai.classification.on"],
    [{ enabled: true, paused: "provider changed" }, true, "ai.classification.paused"],
    [{ enabled: true }, false, "ai.classification.paused"],
  ]) {
    config.llm_enabled = ai;
    plugin.atlasRequest = async () => ({ status: 200, data: { auto_classify: auto } });
    const note = field(tab, "ai.classification");
    await settled();
    assert.equal(note.desc, expected);
    note.cleanup?.();
  }
});

it("R4 keeps the Codex approval instruction visible while enabled", () => {
  const { tab, plugin } = context();
  plugin.codexHookState = () => ({ state: "ours" });
  assert.equal(field(tab, "codexHook").desc, "codexHook.approve");
});

it("R5 distinguishes a ready and empty catalog from indexing", async () => {
  const { tab, plugin } = context();
  plugin.atlasRequest = async () => ({ status: 200, data: { sessions: 0, indexing: false } });
  const { rows, cleanup } = await renderStatus(tab);
  try {
    assert.equal(rows[0].desc, "setup.indexEmpty");
  } finally { cleanup(); }
});

it("R6 exposes Agent Mail and Codex search aliases", () => {
  const { tab } = context();
  assert.deepEqual(definitionFor(tab, "mail.wake").aliases, ["почта", "почта между агентами", "Agent Mail", "mail"]);
  for (const key of ["codexHook.home", "ai.codexModel"]) assert.deepEqual(definitionFor(tab, key).aliases, ["Codex"]);
});

it("R10 localizes only absent categories and preserves all untouched values", async () => {
  const { tab, plugin, config, effects } = context();
  plugin.t = (key, vars) => translate("ru", key, vars);
  const categories = field(tab, "Направления");
  assert.equal(categories.value(), "work — работа по найму и с клиентами\nprojects — свои проекты, инструменты и эксперименты\npersonal — личные дела: здоровье, семья, финансы, документы");
  await categories.blur();
  assert.equal(Object.hasOwn(config, "domains"), false);
  config.domains = [{ id: "work", description: "User description" }];
  assert.equal(field(tab, "Направления").value(), "work — User description");
  assert.deepEqual(effects, []);
});

it("R10 writes edited Russian category descriptions using the built-in IDs", async () => {
  const { tab, plugin, config, effects } = context();
  plugin.t = (key, vars) => translate("ru", key, vars);
  const categories = field(tab, "Направления");
  const edited = categories.value().replace("работа по найму и с клиентами", "клиентские проекты");
  await categories.type(edited);
  await categories.blur();
  assert.deepEqual(config.domains, [
    { id: "work", description: "клиентские проекты" },
    { id: "projects", description: "свои проекты, инструменты и эксперименты" },
    { id: "personal", description: "личные дела: здоровье, семья, финансы, документы" },
  ]);
  assert.deepEqual(effects, [{ domains: config.domains }]);
  assert.equal(field(tab, "Направления").value(), edited);
});

import { it } from "node:test";
import assert from "node:assert/strict";
import { context, notices, settled, translate } from "./helpers/settings.mjs";

const row = (tab, name) => tab.containerEl.children.find(item => item.name === name);
const status = tab => row(tab, "setup.index").children[0].children[0];
const button = (item, name) => item.buttons.find(control => control.text === name);
const diagnostics = tab => row(tab, "setup.address");

function pending() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

it("Diagnostics Rescan refreshes the tab and preserves a failed edit for retry", async () => {
  const { tab, plugin, saved } = context({ legacy: true });
  const scan = pending();
  const request = plugin.atlasRequest;
  plugin.atlasRequest = (...args) => args[0] === "POST" ? scan.promise : request(...args);
  plugin.saveData = async () => { throw new Error("disk unavailable"); };
  tab.display();
  try {
    await settled();
    const rescan = button(diagnostics(tab), "setup.reindex");
    const click = rescan.click();
    assert.equal(rescan.disabled, true);
    const args = row(tab, "settings.args.claude").field;
    args.focus();
    await args.type("--chrome");
    plugin.statusLineState = () => ({ state: "ours" });
    scan.resolve({ status: 200 });
    await click;
    await settled();
    assert.equal(button(diagnostics(tab), "setup.reindex").disabled, false);
    assert.equal(row(tab, "setup.limits").desc, "setup.limits.ours");
    assert.equal(notices.at(-1), "settings.saveFailed");
    const restored = row(tab, "settings.args.claude").field;
    assert.equal(restored.value(), "--chrome");
    assert.deepEqual(saved, []);
    plugin.saveData = async data => saved.push(data.agentArgs.claude);
    await restored.blur();
    assert.deepEqual(saved, ["--chrome"]);
  } finally { await tab.hide(); }
});

it("refresh preserves a failed catalog edit after blur even when the persisted value differs", async () => {
  const { tab, plugin, config } = context({ legacy: true });
  const write = plugin.writeServerConfig;
  plugin.writeServerConfig = () => { throw new Error("disk unavailable"); };
  tab.display();
  try {
    const tickets = row(tab, "cfg.tickets").field;
    await tickets.type("NEW");
    await tickets.blur();
    await tab.refresh();
    const restored = row(tab, "cfg.tickets").field;
    assert.equal(restored.value(), "NEW");
    assert.equal(config.ticket_prefixes, undefined);
    plugin.writeServerConfig = write;
    await restored.blur();
    assert.deepEqual(config.ticket_prefixes, ["NEW"]);
  } finally { await tab.hide(); }
});

it("legacy refresh abandons an in-flight save on close and waits for the next display", async () => {
  const { tab, plugin } = context({ legacy: true });
  const save = pending();
  plugin.saveData = () => save.promise;
  tab.display();
  try {
    const original = row(tab, "settings.args.claude");
    original.field.focus();
    await original.field.type("--chrome");
    const refresh = tab.refresh();
    const hide = tab.hide();
    const closedRefresh = tab.refresh();
    save.resolve();
    await Promise.all([refresh, hide, closedRefresh]);
    assert.equal(row(tab, "settings.args.claude"), original);

    tab.display();
    const reopened = row(tab, "settings.args.claude");
    assert.equal(reopened.field.value(), "--chrome");
    await tab.refresh();
    assert.notEqual(row(tab, "settings.args.claude"), reopened);
  } finally { await tab.hide(); }
});

it("the Codex folder save can finish after legacy hide without reopening the tab", async () => {
  const { tab, plugin } = context({ legacy: true });
  const save = pending();
  plugin.saveData = () => save.promise;
  tab.display();
  const folder = row(tab, "codexHook.home");
  folder.field.focus();
  await folder.field.type("/tmp/codex");
  const hide = tab.hide();
  save.resolve();
  await hide;
  await settled();
  assert.equal(plugin.settings.codexHome, "/tmp/codex");
  assert.equal(row(tab, "codexHook.home"), folder);
  await tab.hide();
});

it("a legacy refresh from before hide does not redraw a reopened tab", async () => {
  const { tab, plugin } = context({ legacy: true });
  const save = pending();
  plugin.saveData = () => save.promise;
  tab.display();
  try {
    const args = row(tab, "settings.args.claude").field;
    args.focus();
    await args.type("--chrome");
    const refresh = tab.refresh();
    const hide = tab.hide();
    tab.display();
    const reopened = row(tab, "settings.args.claude");
    save.resolve();
    await Promise.all([refresh, hide]);
    assert.equal(row(tab, "settings.args.claude"), reopened);
  } finally { await tab.hide(); }
});

it("refresh saves text typed during a pending save before it redraws", async () => {
  const { tab, plugin, saved } = context({ legacy: true });
  const firstSave = pending();
  plugin.saveData = data => {
    saved.push(data.agentArgs.claude);
    return saved.length === 1 ? firstSave.promise : Promise.resolve();
  };
  tab.display();
  try {
    const args = row(tab, "settings.args.claude").field;
    args.focus();
    await args.type("--chrome");
    const refresh = tab.refresh();
    await settled();
    assert.deepEqual(saved, ["--chrome"]);
    await args.type("--chrome --debug");
    firstSave.resolve();
    await refresh;
    assert.deepEqual(saved, ["--chrome", "--chrome --debug"]);
    assert.equal(row(tab, "settings.args.claude").field.value(), "--chrome --debug");
  } finally { await tab.hide(); }
});

it("a null status poll keeps Rescan disabled while the catalog goes down", async () => {
  const ticks = [];
  const view = { setTimeout(fn) { ticks.push(fn); }, clearTimeout() {} };
  const { tab, plugin } = context({ legacy: true, view });
  const health = pending();
  plugin.atlasRequest = async () => ({ status: 200, data: { sessions: 3, indexing: true } });
  tab.display();
  try {
    await settled();
    const catalog = status(tab);
    const rescan = button(catalog, "setup.reindex");
    assert.equal(rescan.disabled, true);
    plugin.atlasRequest = async () => ({ status: 503 });
    plugin.healthInfo = () => health.promise;
    plugin.serverProblem = "port busy";
    const poll = ticks[0]();
    await settled();
    assert.equal(rescan.disabled, true);
    assert.equal(catalog.desc, "setup.indexing");
    health.resolve(null);
    await poll;
    assert.equal(rescan.disabled, true);
    assert.equal(catalog.desc, "setup.serverDown · port busy");
  } finally { await tab.hide(); }
});

for (const fromStatus of [false, true]) {
  it(`catches restart errors from ${fromStatus ? "Status" : "Diagnostics"} and re-enables Restart`, async () => {
    const { tab, plugin } = context({ legacy: true });
    plugin.t = (key, vars) => translate("en", key, vars);
    plugin.stopServer = () => {};
    plugin.ensureServer = async () => { throw new Error("process failed"); };
    plugin.healthInfo = async () => null;
    const restart = () => fromStatus
      ? button(row(tab, "Catalog").children[0].children[0], "Restart catalog")
      : button(row(tab, "Catalog address"), "Restart");
    tab.display();
    try {
      await settled();
      await assert.doesNotReject(() => restart().click());
      await settled();
      assert.equal(restart().disabled, false);
      assert.equal(notices.at(-1), "Could not restart the catalog: process failed");
    } finally { await tab.hide(); }
  });
}

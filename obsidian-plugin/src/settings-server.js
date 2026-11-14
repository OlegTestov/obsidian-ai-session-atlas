// Catalog server settings (config.json) and environment checks: sections of the settings tab.
// Everything that differs between people is edited here, not in code: folders, domains, tickets, models.
import { Notice, Setting } from "obsidian";
import * as childProcess from "child_process";
import * as F from "./config-form";

const DEFAULT_MODELS = { classification: ["sonnet", "low"], catalog_summary: ["sonnet", "low"],
                         handoff: ["sonnet", "medium"] };

const MIN_MACOS = 12;
const AI_AGENTS = ["auto", "claude", "codex"];

/** Environment checks: what is present, what is missing, and a button where it can be fixed. */
async function renderStatus(tab, containerEl = tab.containerEl) {
  const { plugin } = tab;
  const t = (k, v) => plugin.t(k, v);
  new Setting(containerEl).setName(t("setup.heading")).setHeading();
  const box = containerEl.createDiv({ cls: "session-atlas-status" });
  box.createEl("p", { text: t("setup.checking") });
  const [macos, python, clt, shell, health] = await Promise.all([
    plugin.macosVersion(), plugin.findPython(), plugin.commandLineToolsInstalled(), plugin.shellProbe(),
    plugin.healthInfo(),
  ]);
  if (box.isConnected === false) return;
  box.empty();
  const row = (ok, name, detail, button) => {
    const s = new Setting(box).setName(`${ok ? "✓" : "✗"} ${name}`).setDesc(detail || "");
    if (button) s.addButton((b) => b.setButtonText(button.text).onClick(button.onClick));
    return s;
  };
  row(!!macos && Number(macos.split(".")[0]) >= MIN_MACOS, "macOS",
      macos ? (Number(macos.split(".")[0]) >= MIN_MACOS ? macos : t("setup.macosOld", { version: macos, min: MIN_MACOS }))
            : t("setup.notFound"));
  row(!!python, t("setup.python"), python ? `${python.path} · ${python.version}` : pythonProblem(plugin, clt),
      python || clt ? null : { text: t("setup.installClt"), onClick: () => {
        childProcess.spawn("/usr/bin/xcode-select", ["--install"], { detached: true, stdio: "ignore" }).unref();
      } });
  row(!!shell.claude, "Claude Code", shell.claude || t("setup.notFound"));
  row(!!shell.codex, "Codex", shell.codex || t("setup.notFoundOptional"));
  const up = !!health && health.app === "session-atlas";
  row(up, t("setup.server"), up ? `127.0.0.1:${health.port} · python ${health.python || "?"}`
      : (plugin.serverProblem || t("setup.serverDown")), { text: t("setup.restart"), onClick: async () => {
        plugin.stopServer();
        await plugin.ensureServer();
        tab.refresh();
      } });
  if (up) await renderIndex(tab, box, row);
  renderLimits(tab, box);
}

function pythonProblem(plugin, clt) {
  const tried = (plugin.pythonRejected || []).join("; ");
  if (!clt) return plugin.t("setup.pythonMissing");
  return plugin.t("setup.pythonUnfit", { tried: tried || "—" });
}

async function renderIndex(tab, box, row) {
  const { plugin } = tab;
  const r = await plugin.atlasRequest("GET", "/api/index-status");
  const info = r.status === 200 && r.data ? r.data : null;
  const detail = !info ? plugin.t("setup.indexUnknown")
    : info.indexing ? plugin.t("setup.indexing", { n: info.sessions })
    : plugin.t("setup.indexed", { n: info.sessions });
  row(!!info, plugin.t("setup.index"), detail, { text: plugin.t("setup.reindex"), onClick: async () => {
    new Notice(plugin.t("setup.reindexStarted"));
    const res = await plugin.atlasRequest("POST", "/api/reindex", {}, 30 * 60 * 1000);
    new Notice(res.status === 200 ? plugin.t("setup.reindexDone") : plugin.t("setup.reindexFailed"));
    tab.refresh();
  } });
}

/** Subscription limits: a file the plugin does not own (~/.claude/settings.json) is edited only on explicit opt-in. */
function renderLimits(tab, box) {
  const { plugin } = tab;
  const t = (k, v) => plugin.t(k, v);
  const { state, command } = plugin.statusLineState();
  const desc = state === "foreign" ? t("setup.limitsForeign", { command })
    : state === "broken" ? t("setup.limitsBroken", { file: plugin.claudeSettingsPath() })
    : t("setup.limits.desc", { file: plugin.claudeSettingsPath() });
  new Setting(box).setName(t("setup.limits")).setDesc(desc).addToggle((toggle) => {
    toggle.setValue(state === "ours").setDisabled(state === "foreign" || state === "broken")
      .onChange(async (on) => {
        const res = await plugin.setStatusLine(on);
        if (!res.ok) new Notice(t("setup.limitsFailed", { reason: res.reason }));
        tab.refresh();
      });
  });
}

function areaDefinition(tab, name, desc, getValue, onSave, rows = 4) {
  return { name: tab.plugin.t(name), desc: tab.plugin.t(desc), render: (setting) => {
    const value = getValue();
    setting.settingEl.addClass("session-atlas-area");
    setting.addTextArea((ta) => {
      ta.inputEl.rows = Math.max(rows, String(value || "").split("\n").length + 1);
      ta.inputEl.spellcheck = false;
      ta.setValue(value);
      ta.inputEl.addEventListener("blur", () => onSave(ta.getValue()));
    });
  } };
}

function catalogDefinitions(tab) {
  const { plugin } = tab, cfg = () => plugin.readServerConfig() || {};
  const save = (changes) => plugin.writeServerConfig(changes);
  return { type: "group", heading: plugin.t("cfg.heading"), items: [
    areaDefinition(tab, "cfg.vaults", "cfg.vaults.desc", () => F.vaultsToText(cfg().vaults),
      v => save({ vaults: F.textToVaults(v, cfg().vaults) }), 2),
    areaDefinition(tab, "cfg.roots", "cfg.roots.desc", () => F.listToText(cfg().workspace_roots || ["~/Code", "~/Projects", "~/Developer", "~/src"]),
      v => save({ workspace_roots: F.textToList(v) }), 3),
    areaDefinition(tab, "cfg.domains", "cfg.domains.desc", () => F.domainsToText(cfg().domains || []),
      v => save({ domains: F.textToDomains(v) }), 5),
    areaDefinition(tab, "cfg.rules", "cfg.rules.desc", () => F.rulesToText(cfg().vault_domain_rules || []),
      v => save({ vault_domain_rules: F.textToRules(v) }), 3),
    areaDefinition(tab, "cfg.sensitive", "cfg.sensitive.desc",
      () => F.listToText(((cfg().sensitive || {}).vault_areas || []).map(a => "vault:" + a).concat((cfg().sensitive || {}).projects || [])),
      v => {
        const items = F.textToList(v);
        save({ sensitive: { vault_areas: items.filter(x => x.startsWith("vault:")).map(x => x.slice(6)),
                             projects: items.filter(x => !x.startsWith("vault:")) } });
      }, 3),
    { name: plugin.t("cfg.tickets"), desc: plugin.t("cfg.tickets.desc"), render: setting => setting.addText(text => {
      text.setPlaceholder(plugin.t("cfg.tickets.placeholder")).setValue(F.prefixesToText(cfg().ticket_prefixes));
      text.inputEl.addEventListener("blur", () => save({ ticket_prefixes: F.textToPrefixes(text.getValue()) }));
    }) },
  ] };
}

function aiDefinitions(tab) {
  const { plugin } = tab, cfg = () => plugin.readServerConfig() || {};
  const models = () => Object.assign({}, DEFAULT_MODELS, cfg().models || {});
  const save = changes => plugin.writeServerConfig(changes);
  return { type: "group", heading: plugin.t("ai.heading"), items: [
    { name: plugin.t("ai.enabled"), desc: plugin.t("ai.enabled.desc"), render: setting => setting.addToggle(toggle =>
      toggle.setValue(cfg().llm_enabled !== false).onChange(v => save({ llm_enabled: v }))) },
    ...Object.keys(DEFAULT_MODELS).map(kind => ({ name: plugin.t(`ai.model.${kind}`), desc: plugin.t("ai.model.desc"),
      render: setting => setting.addText(text => {
        text.setPlaceholder(DEFAULT_MODELS[kind].join(" ")).setValue(F.modelToText(models()[kind]));
        text.inputEl.addEventListener("blur", () => {
          const next = Object.assign({}, (plugin.readServerConfig() || {}).models);
          next[kind] = F.textToModel(text.getValue(), DEFAULT_MODELS[kind]);
          save({ models: next });
        });
      }) })),
    { name: plugin.t("ai.force1m"), desc: plugin.t("ai.force1m.desc"), render: setting => setting.addToggle(toggle =>
      toggle.setValue(!!cfg().force_1m).onChange(v => save({ force_1m: v }))) },
    { name: plugin.t("ai.agent"), desc: plugin.t("ai.agent.desc"), render: setting => setting.addDropdown(dropdown => {
      for (const choice of AI_AGENTS) dropdown.addOption(choice, plugin.t(`ai.agent.${choice}`));
      dropdown.setValue(AI_AGENTS.includes(cfg().ai_agent) ? cfg().ai_agent : "auto")
        .onChange(value => save({ ai_agent: value }));
    }) },
    { name: plugin.t("ai.codexModel"), desc: plugin.t("ai.codexModel.desc"), render: setting => setting.addText(text => {
      text.setPlaceholder(plugin.t("ai.codexModel.placeholder")).setValue(F.modelToText(cfg().codex_model));
      // Empty: Codex's own default model, with low effort for topics and summaries, medium for notes.
      text.inputEl.addEventListener("blur", () => save({ codex_model: F.textToModel(text.getValue(), null) }));
    }) },
  ] };
}

/** Opt-in: a Codex hook marks approval waits of Codex sessions outside tabs (codex-hook.js). */
function codexHookDefinition(tab) {
  const { plugin } = tab;
  const t = (k, v) => plugin.t(k, v);
  return { name: t("codexHook"), desc: t("codexHook.desc", { file: plugin.codexHooksPath() }), render: setting => {
    const { state } = plugin.codexHookState();
    if (state === "broken") setting.setDesc(t("codexHook.broken", { file: plugin.codexHooksPath() }));
    setting.addToggle(toggle => toggle.setValue(state === "ours").setDisabled(state === "broken")
      .onChange(async on => {
        const res = await plugin.setCodexHook(on);
        new Notice(res.ok ? t(on ? "codexHook.on" : res.inert ? "codexHook.inert" : "codexHook.off",
                              { file: plugin.codexHooksPath() })
          : t("codexHook.failed", { reason: res.reason }));
        tab.refresh();
      }));
  } };
}

function advancedDefinitions(tab) {
  const { plugin } = tab;
  return { type: "group", heading: plugin.t("adv.heading"), items:
    [["pythonPath", "adv.python"], ["shellPath", "adv.shell"]].map(([key, name]) => ({
      name: plugin.t(name), desc: plugin.t(`${name}.desc`), render: setting => setting.addText(text =>
        text.setValue(plugin.settings[key] || "").onChange(async value => {
          plugin.settings[key] = value.trim();
          await plugin.saveData(plugin.settings);
        })),
    })) };
}

export { renderStatus, catalogDefinitions, aiDefinitions, advancedDefinitions, codexHookDefinition, DEFAULT_MODELS };

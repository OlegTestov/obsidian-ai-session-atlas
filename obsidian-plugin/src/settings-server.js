// Настройки сервера каталога (config.json) и проверки окружения — секции вкладки настроек.
// Всё, что у разных людей разное, правится здесь, а не в коде: папки, домены, тикеты, модели.
const { Notice, Setting } = require("obsidian");
const childProcess = require("child_process");
const F = require("./config-form");

const DEFAULT_MODELS = { classification: ["sonnet", "low"], catalog_summary: ["sonnet", "low"],
                         handoff: ["sonnet", "medium"] };

const MIN_MACOS = 12;

/** Проверки окружения: что есть, чего нет, и кнопка там, где можно исправить. */
async function renderStatus(tab) {
  const { plugin, containerEl } = tab;
  const t = (k, v) => plugin.t(k, v);
  containerEl.createEl("h3", { text: t("setup.heading") });
  const box = containerEl.createDiv({ cls: "session-atlas-status" });
  box.createEl("p", { text: t("setup.checking") });
  const [macos, python, clt, shell, health] = await Promise.all([
    plugin.macosVersion(), plugin.findPython(), plugin.commandLineToolsInstalled(), plugin.shellProbe(),
    plugin.healthInfo(),
  ]);
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
        tab.display();
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
    tab.display();
  } });
}

/** Лимиты подписки: правка чужого файла (~/.claude/settings.json) — только по явному включению. */
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
        tab.display();
      });
  });
}

function area(tab, name, desc, value, onSave, rows = 4) {
  const setting = new Setting(tab.containerEl).setName(tab.plugin.t(name)).setDesc(tab.plugin.t(desc));
  setting.settingEl.addClass("session-atlas-area");      // поле под описанием, на всю ширину
  setting.addTextArea((ta) => {
      ta.inputEl.rows = Math.max(rows, String(value || "").split("\n").length + 1);
      ta.inputEl.spellcheck = false;
      ta.setValue(value);
      // Сохраняем по уходу из поля: иначе на каждую букву перечитывался бы индекс.
      ta.inputEl.addEventListener("blur", () => onSave(ta.getValue()));
    });
}

/** Каталог: папки заметок и проектов, домены, чувствительное, тикеты. */
function renderCatalog(tab) {
  const { plugin, containerEl } = tab;
  const cfg = plugin.readServerConfig() || {};
  const save = (changes) => plugin.writeServerConfig(changes);
  containerEl.createEl("h3", { text: plugin.t("cfg.heading") });
  area(tab, "cfg.vaults", "cfg.vaults.desc", F.vaultsToText(cfg.vaults),
       (v) => save({ vaults: F.textToVaults(v, cfg.vaults) }), 2);
  area(tab, "cfg.roots", "cfg.roots.desc", F.listToText(cfg.workspace_roots || ["~/Code", "~/Projects", "~/Developer", "~/src"]),
       (v) => save({ workspace_roots: F.textToList(v) }), 3);
  area(tab, "cfg.domains", "cfg.domains.desc", F.domainsToText(cfg.domains || []),
       (v) => save({ domains: F.textToDomains(v) }), 5);
  area(tab, "cfg.rules", "cfg.rules.desc", F.rulesToText(cfg.vault_domain_rules || []),
       (v) => save({ vault_domain_rules: F.textToRules(v) }), 3);
  area(tab, "cfg.sensitive", "cfg.sensitive.desc",
       F.listToText(((cfg.sensitive || {}).vault_areas || []).map((a) => "vault:" + a)
         .concat((cfg.sensitive || {}).projects || [])),
       (v) => {
         const items = F.textToList(v);
         save({ sensitive: { vault_areas: items.filter((x) => x.startsWith("vault:")).map((x) => x.slice(6)),
                             projects: items.filter((x) => !x.startsWith("vault:")) } });
       }, 3);
  new Setting(containerEl).setName(plugin.t("cfg.tickets")).setDesc(plugin.t("cfg.tickets.desc"))
    .addText((text) => {
      text.setPlaceholder("ABC, OPS").setValue(F.prefixesToText(cfg.ticket_prefixes));
      text.inputEl.addEventListener("blur", () => save({ ticket_prefixes: F.textToPrefixes(text.getValue()) }));
    });
}

/** ИИ-функции: выключены, пока человек сам не включит; модели — алиасы или полные имена. */
function renderAi(tab) {
  const { plugin, containerEl } = tab;
  const cfg = plugin.readServerConfig() || {};
  const models = Object.assign({}, DEFAULT_MODELS, cfg.models || {});
  const save = (changes) => plugin.writeServerConfig(changes);
  containerEl.createEl("h3", { text: plugin.t("ai.heading") });
  new Setting(containerEl).setName(plugin.t("ai.enabled")).setDesc(plugin.t("ai.enabled.desc"))
    .addToggle((toggle) => toggle.setValue(!!cfg.llm_enabled).onChange((v) => save({ llm_enabled: v })));
  new Setting(containerEl).setName(plugin.t("ai.language")).setDesc(plugin.t("ai.language.desc"))
    .addDropdown((d) => d.addOption("en", "English").addOption("ru", "Русский")
      .setValue(cfg.language === "ru" ? "ru" : "en").onChange((v) => save({ language: v })));
  for (const kind of Object.keys(DEFAULT_MODELS)) {
    new Setting(containerEl).setName(plugin.t(`ai.model.${kind}`)).setDesc(plugin.t("ai.model.desc"))
      .addText((text) => {
        text.setPlaceholder(DEFAULT_MODELS[kind].join(" ")).setValue(F.modelToText(models[kind]));
        text.inputEl.addEventListener("blur", () => {
          const next = Object.assign({}, (plugin.readServerConfig() || {}).models);
          next[kind] = F.textToModel(text.getValue(), DEFAULT_MODELS[kind]);
          save({ models: next });
        });
      });
  }
  new Setting(containerEl).setName(plugin.t("ai.force1m")).setDesc(plugin.t("ai.force1m.desc"))
    .addToggle((toggle) => toggle.setValue(!!cfg.force_1m).onChange((v) => save({ force_1m: v })));
}

/** Дополнительно: свой python3 и своя оболочка — для нестандартных установок. */
function renderAdvanced(tab) {
  const { plugin, containerEl } = tab;
  containerEl.createEl("h3", { text: plugin.t("adv.heading") });
  for (const [key, name] of [["pythonPath", "adv.python"], ["shellPath", "adv.shell"]]) {
    new Setting(containerEl).setName(plugin.t(name)).setDesc(plugin.t(`${name}.desc`))
      .addText((text) => text.setValue(plugin.settings[key] || "").onChange(async (v) => {
        plugin.settings[key] = v.trim();
        await plugin.saveData(plugin.settings);
      }));
  }
}

module.exports = { renderStatus, renderCatalog, renderAi, renderAdvanced, DEFAULT_MODELS };

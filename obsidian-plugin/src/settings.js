// Настройки плагина: проверки окружения, язык, агенты, каталог, ИИ, уведомления, проводник.
const { PluginSettingTab, Setting } = require("obsidian");
const { renderStatus, renderCatalog, renderAi, renderAdvanced } = require("./settings-server");

const DEFAULT_SETTINGS = { notify: true, systemNotify: true, explorerClicks: true, language: "en",
                           agents: {}, agentArgs: { claude: "", codex: "" }, terminalFontSize: 13,
                           cardMessages: 10 };

class AtlasSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  save() {
    return this.plugin.saveData(this.plugin.settings);
  }

  toggle(key, name, desc) {
    const t = (k) => this.plugin.t(k);
    new Setting(this.containerEl)
      .setName(t(name))
      .setDesc(t(desc))
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.settings[key])
        .onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.save();
        }));
  }

  display() {
    const t = (k) => this.plugin.t(k);
    this.containerEl.empty();
    renderStatus(this).catch((error) => console.error("Session Atlas: проверки", error));
    new Setting(this.containerEl)
      .setName(t("settings.language"))
      .setDesc(t("settings.language.desc"))
      .addDropdown((dropdown) => dropdown
        .addOption("auto", t("settings.language.auto"))
        .addOption("ru", "Русский")
        .addOption("en", "English")
        .setValue(this.plugin.settings.language || "en")
        .onChange(async (value) => {
          this.plugin.settings.language = value;
          await this.save();
          this.display();                  // сама страница настроек — сразу на новом языке
        }));
    this.containerEl.createEl("h3", { text: t("settings.agentsHeading") });
    for (const kind of ["claude", "codex"]) {
      new Setting(this.containerEl)
        .setName(t(`settings.agent.${kind}`))
        .setDesc(t("settings.agent.desc"))
        .addToggle((toggle) => toggle
          .setValue(this.plugin.agentEnabled(kind))
          .onChange(async (value) => {
            this.plugin.settings.agents = Object.assign({}, this.plugin.settings.agents, { [kind]: value });
            await this.save();
            this.plugin.refreshAgentButtons();
          }))
        .addText((text) => text
          .setPlaceholder(t("settings.agent.argsPlaceholder"))
          .setValue((this.plugin.settings.agentArgs || {})[kind] || "")
          .onChange(async (value) => {
            this.plugin.settings.agentArgs = Object.assign({}, this.plugin.settings.agentArgs, { [kind]: value });
            await this.save();
            this.plugin.writeAgentArgs();
          }));
    }
    new Setting(this.containerEl)
      .setName(t("settings.fontSize"))
      .addSlider((slider) => slider
        .setLimits(9, 22, 1)
        .setValue(Number(this.plugin.settings.terminalFontSize) || 13)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.terminalFontSize = value;
          await this.save();
        }));
    new Setting(this.containerEl)
      .setName(t("settings.cardMessages"))
      .setDesc(t("settings.cardMessages.desc"))
      .addSlider((slider) => slider
        .setLimits(1, 30, 1)
        .setValue(Number(this.plugin.settings.cardMessages) || 10)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.cardMessages = value;
          await this.save();
          // Число уходит странице в адресе: открытые вкладки каталога перерисуются с ним.
          clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => this.plugin.reloadAtlasViews(), 600);
        }));
    renderCatalog(this);
    renderAi(this);
    this.containerEl.createEl("h3", { text: t("settings.otherHeading") });
    this.toggle("notify", "settings.notify", "settings.notify.desc");
    this.toggle("systemNotify", "settings.systemNotify", "settings.systemNotify.desc");
    this.toggle("explorerClicks", "settings.explorer", "settings.explorer.desc");
    renderAdvanced(this);
  }
}

module.exports = { AtlasSettingTab, DEFAULT_SETTINGS };

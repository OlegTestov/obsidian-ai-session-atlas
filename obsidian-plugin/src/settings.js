// Plugin settings: environment checks, language, agents, catalog, AI, notifications, file explorer.
import { PluginSettingTab, Setting } from "obsidian";
import { renderStatus, renderCatalog, renderAi, renderAdvanced } from "./settings-server";
import { NOTICE_HOLDS, DEFAULT_NOTICE_HOLD } from "./notify";
import { DEFAULT_FONT_SIZE } from "./constants";

const DEFAULT_SETTINGS = { notify: true, systemNotify: true, explorerClicks: false, language: "en",
                           agents: {}, agentArgs: { claude: "", codex: "" }, terminalFontSize: DEFAULT_FONT_SIZE,
                           cardMessages: 10, noticeHold: DEFAULT_NOTICE_HOLD };

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
    renderStatus(this).catch((error) => console.error("AI Session Atlas: environment checks failed", error));
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
          this.display();                  // the settings page itself switches to the new language at once
        }));
    new Setting(this.containerEl).setName(t("settings.agentsHeading")).setHeading();
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
        .setValue(Number(this.plugin.settings.terminalFontSize) || DEFAULT_FONT_SIZE)
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
          // The number reaches the page in its URL: open catalog tabs re-render with it.
          window.clearTimeout(this.reloadTimer);
          this.reloadTimer = window.setTimeout(() => this.plugin.reloadAtlasViews(), 600);
        }));
    renderCatalog(this);
    renderAi(this);
    new Setting(this.containerEl).setName(t("settings.otherHeading")).setHeading();
    this.toggle("notify", "settings.notify", "settings.notify.desc");
    new Setting(this.containerEl)
      .setName(t("settings.noticeHold"))
      .setDesc(t("settings.noticeHold.desc"))
      .addDropdown((dropdown) => {
        for (const hold of NOTICE_HOLDS) dropdown.addOption(hold, t(`settings.noticeHold.${hold}`));
        dropdown
          .setValue(NOTICE_HOLDS.includes(this.plugin.settings.noticeHold)
            ? this.plugin.settings.noticeHold : DEFAULT_NOTICE_HOLD)
          .onChange(async (value) => {
            this.plugin.settings.noticeHold = value;
            await this.save();
          });
      });
    this.toggle("systemNotify", "settings.systemNotify", "settings.systemNotify.desc");
    this.toggle("explorerClicks", "settings.explorer", "settings.explorer.desc");
    renderAdvanced(this);
  }
}

export { AtlasSettingTab, DEFAULT_SETTINGS };

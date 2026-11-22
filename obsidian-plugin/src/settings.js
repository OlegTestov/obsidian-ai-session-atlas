// One set of row definitions drives both Obsidian's settings search and the older settings UI.
import { PluginSettingTab, Setting } from "obsidian";
import { catalogDefinitions, aiDefinitions, modelDefinitions } from "./settings-server";
import { advancedDefinitions } from "./settings-advanced";
import { statusDefinitions } from "./settings-status";
import { definition, group } from "./settings-fields";
import { NOTICE_HOLDS, DEFAULT_NOTICE_HOLD } from "./notify";
import { DEFAULT_FONT_SIZE } from "./constants";
import { agentKinds, getAgent } from "./agent-registry";
import { supportsTerminal } from "./agents";

const DEFAULT_SETTINGS = { notify: true, systemNotify: true, explorerClicks: false, language: "auto",
                           wakeOnMail: true, agentMailRoot: "", agentMailScript: "", codexHome: "", agents: {}, agentArgs: Object.fromEntries(agentKinds.map(kind => [kind, ""])), terminalFontSize: DEFAULT_FONT_SIZE,
                           noticeHold: DEFAULT_NOTICE_HOLD, loadAgentTabs: true, showWhatsNew: true };

class AtlasSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.textSaves = new Set();
    this.legacyCleanup = [];
    this.openCycle = null;
  }

  save() { return this.plugin.saveData(this.plugin.settings); }

  hide() {
    this.openCycle = null;
    this.focusedText?.flush();
    this.focusedText = null;
    this.clearLegacyRows();
    return Promise.all(this.textSaves);
  }

  async flushText(cycle) {
    let field, value;
    do {
      field = this.focusedText;
      value = field?.value();
      const [saved] = await Promise.all([field?.flush(), ...this.textSaves]);
      if (cycle !== this.openCycle) return;
      if (saved === false && field === this.focusedText) return false;
    } while (field !== this.focusedText || value !== field?.value());
  }

  refresh() {
    const cycle = this.openCycle;
    if (!cycle) return;
    cycle.refreshing ||= this.flushText(cycle).then(() => {
      if (cycle !== this.openCycle) return;
      this.focusedText = null;
      if (typeof this.update === "function") this.update();
      else this.display();
    }).finally(() => { cycle.refreshing = null; });
    return cycle.refreshing;
  }

  toggleDefinition(key, name, desc, after) {
    return definition(this, name, desc, setting => setting.addToggle(toggle =>
      toggle.setValue(!!this.plugin.settings[key]).onChange(async value => {
        this.plugin.settings[key] = value;
        await this.save();
        await after?.();
      })));
  }

  generalDefinitions() {
    const { plugin } = this;
    return group(this, "settings.generalHeading", [
      definition(this, "settings.language", "settings.language.desc", setting => setting.addDropdown(dropdown =>
        dropdown.addOption("auto", plugin.t("settings.language.auto")).addOption("ru", "Русский").addOption("en", "English")
          .setValue(plugin.settings.language || "auto").onChange(async value => {
            plugin.settings.language = value;
            await this.save();
            plugin.writeServerConfig();          // topics, descriptions and handoffs follow the plugin's language
            await this.refresh();
          }))),
      this.toggleDefinition("showWhatsNew", "updates.setting", "updates.setting.desc"),
      this.toggleDefinition("explorerClicks", "settings.explorer", "settings.explorer.desc"),
    ]);
  }

  agentDefinitions() {
    const { plugin } = this;
    return group(this, "settings.agentsHeading", [
      ...agentKinds.map(kind => ({
        name: supportsTerminal(kind) ? plugin.t(`settings.agent.${kind}`) : getAgent(kind).label,
        desc: plugin.t("settings.agent.desc"),
        render: setting => setting.addToggle(toggle => toggle.setValue(plugin.agentEnabled(kind)).onChange(async value => {
          plugin.settings.agents = Object.assign({}, plugin.settings.agents, { [kind]: value });
          await this.save();
          plugin.refreshAgentButtons();
        })),
      })),
      this.toggleDefinition("loadAgentTabs", "settings.loadAgentTabs", "settings.loadAgentTabs.desc"),
      definition(this, "settings.fontSize", "settings.fontSize.desc", setting => {
        const size = Number(plugin.settings.terminalFontSize) || DEFAULT_FONT_SIZE;
        setting.addSlider(slider => slider.setLimits(9, 22, 1).setValue(size).setDynamicTooltip().onChange(async value => {
          plugin.settings.terminalFontSize = value;
          await this.save();
        }));
      }),
      {
        ...this.toggleDefinition("wakeOnMail", "mail.wake", "mail.wake.desc", () => plugin.writeMailArgs()),
        aliases: ["почта", "почта между агентами", "Agent Mail", "mail"],
      },
    ]);
  }

  notificationDefinitions() {
    const { plugin } = this;
    const dependent = (name, render) => definition(this, name, `${name}.desc`, setting => {
      const disabled = !plugin.settings.notify;
      if (disabled) setting.setDesc(plugin.t("settings.notify.disabled"));
      render(setting, disabled);
    });
    return group(this, "settings.notificationsHeading", [
      this.toggleDefinition("notify", "settings.notify", "settings.notify.desc", () => this.refresh()),
      dependent("settings.systemNotify", (setting, disabled) => setting.addToggle(toggle =>
        toggle.setValue(!!plugin.settings.systemNotify).setDisabled(disabled).onChange(async value => {
          plugin.settings.systemNotify = value;
          await this.save();
        }))),
      dependent("settings.noticeHold", (setting, disabled) => setting.addDropdown(dropdown => {
        for (const hold of NOTICE_HOLDS) dropdown.addOption(hold, plugin.t(`settings.noticeHold.${hold}`));
        dropdown.setValue(NOTICE_HOLDS.includes(plugin.settings.noticeHold) ? plugin.settings.noticeHold : DEFAULT_NOTICE_HOLD)
          .setDisabled(disabled).onChange(async value => {
            plugin.settings.noticeHold = value;
            await this.save();
          });
      })),
    ]);
  }

  getSettingDefinitions() {
    const { status, diagnostics, watchIndex } = statusDefinitions(this);
    const { integrations, launch, mail } = advancedDefinitions(this);
    const definitions = [
      status, this.generalDefinitions(), this.agentDefinitions(), catalogDefinitions(this),
      aiDefinitions(this, watchIndex), this.notificationDefinitions(),
      integrations, launch, modelDefinitions(this), mail, diagnostics,
    ];
    // Native Obsidian stores truthy render return values as teardown callbacks. Fluent Setting
    // methods return the row itself, so only forward actual cleanup functions.
    const safe = def => def.items ? { ...def, items: def.items.map(safe) } : { ...def, render: setting => {
      // Definitions are also requested for indexing. Only rendering opens the tab.
      this.openCycle ??= { failedText: new Map() };
      const cleanup = def.render(setting);
      if (typeof cleanup === "function") return cleanup;
    } };
    return definitions.map(safe);
  }

  /** Obsidian < 1.13 has no definitions renderer; keep the same controls and handlers there. */
  display() {
    this.clearLegacyRows();
    this.containerEl.empty();
    const render = definitions => {
      for (const def of definitions) {
        if (def.items) {
          if (def.heading) new Setting(this.containerEl).setName(def.heading).setHeading();
          render(def.items);
        } else {
          const setting = new Setting(this.containerEl).setName(def.name).setDesc(def.desc || "");
          const cleanup = def.render(setting);
          if (cleanup) this.legacyCleanup.push(cleanup);
        }
      }
    };
    render(this.getSettingDefinitions());
  }

  clearLegacyRows() {
    for (const cleanup of this.legacyCleanup.splice(0)) cleanup();
  }
}

export { AtlasSettingTab, DEFAULT_SETTINGS };

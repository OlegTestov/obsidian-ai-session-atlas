// One set of row definitions drives both Obsidian's settings search and the older settings UI.
import { Notice, PluginSettingTab, Setting } from "obsidian";
import { renderStatus, catalogDefinitions, aiDefinitions, advancedDefinitions, codexHookDefinition } from "./settings-server";
import { NOTICE_HOLDS, DEFAULT_NOTICE_HOLD } from "./notify";
import { DEFAULT_FONT_SIZE } from "./constants";
import { validMailRoot } from "./mail-nudge";
import { normalizeCodexHome } from "./codex-hook";
import { agentKinds, getAgent } from "./agent-registry";
import { supportsTerminal } from "./agents";

const DEFAULT_SETTINGS = { notify: true, systemNotify: true, explorerClicks: false, language: "auto",
                           wakeOnMail: true, agentMailRoot: "", agentMailScript: "", codexHome: "", agents: {}, agentArgs: Object.fromEntries(agentKinds.map(kind => [kind, ""])), terminalFontSize: DEFAULT_FONT_SIZE,
                           noticeHold: DEFAULT_NOTICE_HOLD, loadAgentTabs: true, showWhatsNew: true };

class AtlasSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  save() { return this.plugin.saveData(this.plugin.settings); }

  refresh() {
    if (typeof this.update === "function") this.update();
    else this.display();
  }

  toggleDefinition(key, name, desc, after) {
    return { name: this.plugin.t(name), desc: this.plugin.t(desc), render: setting => setting.addToggle(toggle =>
      toggle.setValue(!!this.plugin.settings[key]).onChange(async value => {
        this.plugin.settings[key] = value;
        await this.save();
        if (after) after();
      })) };
  }

  getSettingDefinitions() {
    const t = (key) => this.plugin.t(key), plugin = this.plugin;
    const definition = (name, desc, render) => ({ name: t(name), ...(desc ? { desc: t(desc) } : {}), render });
    const agentName = kind => supportsTerminal(kind) ? t(`settings.agent.${kind}`) : getAgent(kind).label;
    const definitions = [
      { name: t("setup.heading"), aliases: [t("setup.python"), t("setup.server"), t("setup.limits"), "macOS", ...agentKinds.map(kind => getAgent(kind).label)],
        render: setting => {
          setting.settingEl.empty();
          setting.settingEl.addClass("session-atlas-status-section");
          renderStatus(this, setting.settingEl).catch(error => console.error("AI Session Atlas: environment checks failed", error));
        } },
      definition("settings.language", "settings.language.desc", setting => setting.addDropdown(dropdown =>
        dropdown.addOption("auto", t("settings.language.auto")).addOption("ru", "Русский").addOption("en", "English")
          .setValue(plugin.settings.language || "auto").onChange(async value => {
            plugin.settings.language = value;
            await this.save();
            plugin.writeServerConfig();          // topics, descriptions and handoffs follow the plugin's language
            this.refresh();
          }))),
      { type: "group", heading: t("settings.agentsHeading"), items: [
        ...agentKinds.map(kind => ({ name: agentName(kind), desc: t("settings.agent.desc"), render: setting => {
          setting.addToggle(toggle => toggle.setValue(plugin.agentEnabled(kind)).onChange(async value => {
            plugin.settings.agents = Object.assign({}, plugin.settings.agents, { [kind]: value });
            await this.save();
            plugin.refreshAgentButtons();
          })).addText(text => text.setPlaceholder(t("settings.agent.argsPlaceholder"))
            .setValue((plugin.settings.agentArgs || {})[kind] || "").onChange(async value => {
              plugin.settings.agentArgs = Object.assign({}, plugin.settings.agentArgs, { [kind]: value });
              await this.save();
              plugin.writeAgentArgs();
            }));
        } })),
        codexHookDefinition(this),
        definition("codexHook.home", "codexHook.home.desc", setting => setting.addText(text => {
          text.setPlaceholder("~/.codex").setValue(plugin.settings.codexHome);
          text.inputEl.addEventListener("blur", async () => {
            const value = text.getValue().trim();
            if (value === plugin.settings.codexHome) return;
            if (value && !normalizeCodexHome(value)) {
              text.setValue(plugin.settings.codexHome);
              new Notice(t("codexHook.home.invalid"));
              return;
            }
            plugin.settings.codexHome = value;
            await this.save();
            this.refresh();
          });
        })),
        this.toggleDefinition("wakeOnMail", "mail.wake", "mail.wake.desc", () => plugin.writeMailArgs()),
        definition("mail.root", "mail.root.desc", setting => setting.addText(text => {
          text.setPlaceholder("~/.agent-mail").setValue(plugin.settings.agentMailRoot);
          text.inputEl.addEventListener("blur", async () => {
            const value = text.getValue().trim();
            if (value === plugin.settings.agentMailRoot) return;
            if (value && !validMailRoot(value)) {
              text.setValue(plugin.settings.agentMailRoot);
              new Notice(t("mail.root.invalid"));
              return;
            }
            plugin.settings.agentMailRoot = value;
            await this.save();
            plugin.writeMailArgs();
          });
        })),
        definition("mail.script", "mail.script.desc", setting => setting.addText(text =>
          text.setValue(plugin.settings.agentMailScript).onChange(async value => {
            plugin.settings.agentMailScript = value;
            await this.save();
          }))),
        this.toggleDefinition("loadAgentTabs", "settings.loadAgentTabs", "settings.loadAgentTabs.desc"),
        definition("settings.fontSize", null, setting => setting.addSlider(slider => slider.setLimits(9, 22, 1)
          .setValue(Number(plugin.settings.terminalFontSize) || DEFAULT_FONT_SIZE).setDynamicTooltip().onChange(async value => {
            plugin.settings.terminalFontSize = value;
            await this.save();
          }))),
      ] },
      catalogDefinitions(this), aiDefinitions(this),
      { type: "group", heading: t("settings.otherHeading"), items: [
        this.toggleDefinition("showWhatsNew", "updates.setting", "updates.setting.desc"),
        this.toggleDefinition("notify", "settings.notify", "settings.notify.desc"),
        definition("settings.noticeHold", "settings.noticeHold.desc", setting => setting.addDropdown(dropdown => {
          for (const hold of NOTICE_HOLDS) dropdown.addOption(hold, t(`settings.noticeHold.${hold}`));
          dropdown.setValue(NOTICE_HOLDS.includes(plugin.settings.noticeHold) ? plugin.settings.noticeHold : DEFAULT_NOTICE_HOLD)
            .onChange(async value => { plugin.settings.noticeHold = value; await this.save(); });
        })),
        this.toggleDefinition("systemNotify", "settings.systemNotify", "settings.systemNotify.desc"),
        this.toggleDefinition("explorerClicks", "settings.explorer", "settings.explorer.desc"),
      ] },
      advancedDefinitions(this),
    ];
    // Native Obsidian stores truthy render return values as teardown callbacks. Fluent Setting
    // methods return the row itself, so only forward actual cleanup functions.
    const safe = def => def.items ? { ...def, items: def.items.map(safe) } : { ...def, render: setting => {
      const cleanup = def.render(setting);
      if (typeof cleanup === "function") return cleanup;
    } };
    return definitions.map(safe);
  }

  /** Obsidian < 1.13 has no definitions renderer; keep the same controls and handlers there. */
  display() {
    this.containerEl.empty();
    const render = definitions => {
      for (const def of definitions) {
        if (def.items) {
          if (def.heading) new Setting(this.containerEl).setName(def.heading).setHeading();
          render(def.items);
        } else {
          const setting = new Setting(this.containerEl).setName(def.name).setDesc(def.desc || "");
          def.render(setting);
        }
      }
    };
    render(this.getSettingDefinitions());
  }
}

export { AtlasSettingTab, DEFAULT_SETTINGS };

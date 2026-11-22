import { Notice } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { agentKinds, getAgent } from "./agent-registry";
import { supportsTerminal } from "./agents";
import { normalizeCodexHome } from "./codex-hook";
import { validMailRoot } from "./mail-nudge";
import { BACKUP_SUFFIX } from "./statusline";
import { automatic, definition, group, pluginText, textDefinition } from "./settings-fields";

function fileNotice(plugin, key, file) {
  const backup = file + BACKUP_SUFFIX;
  const message = plugin.t(key, { file });
  new Notice(fs.existsSync(backup) ? `${message}\n${plugin.t("adv.backup", { backup })}` : message);
}

function limitsDefinition(tab) {
  const { plugin } = tab;
  return definition(tab, "setup.limits", "setup.limits.desc", setting => {
    const { state } = plugin.statusLineState();
    const unavailable = state === "foreign" || state === "broken";
    setting.setDesc(plugin.t(`setup.limits.${state}`));
    setting.addToggle(toggle => toggle.setValue(state === "ours").setDisabled(unavailable).onChange(async on => {
      toggle.setDisabled(true);
      try {
        const res = await plugin.setStatusLine(on);
        if (res.ok) fileNotice(plugin, on ? "setup.limitsOn" : "setup.limitsOff", plugin.claudeSettingsPath());
        else new Notice(plugin.t("setup.limitsFailed", { reason: res.reason }));
      } catch (error) {
        new Notice(plugin.t("setup.limitsFailed", { reason: error.message }));
      }
      await tab.refresh();
    }));
  });
}

function codexHookDefinition(tab) {
  const { plugin } = tab;
  return definition(tab, "codexHook", "codexHook.desc", setting => {
    const { state } = plugin.codexHookState();
    if (state === "broken") setting.setDesc(plugin.t("codexHook.broken"));
    if (state === "ours") setting.setDesc(plugin.t("codexHook.approve"));
    setting.addToggle(toggle => toggle.setValue(state === "ours").setDisabled(state === "broken").onChange(async on => {
      toggle.setDisabled(true);
      try {
        const res = await plugin.setCodexHook(on);
        if (res.ok) fileNotice(plugin, on ? "codexHook.on" : res.inert ? "codexHook.inert" : "codexHook.off", plugin.codexHooksPath());
        else new Notice(plugin.t("codexHook.failed", { reason: res.reason }));
      } catch (error) {
        new Notice(plugin.t("codexHook.failed", { reason: error.message }));
      }
      await tab.refresh();
    }));
  });
}

function openCodeDataHome(shell, env) {
  const xdg = shell?.XDG_DATA_HOME || env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, "opencode") : "~/.local/share/opencode";
}

function advancedDefinitions(tab) {
  const { plugin } = tab;
  const integrations = group(tab, "adv.integrations", [
    definition(tab, "adv.defaults", null, () => {}),
    limitsDefinition(tab),
    codexHookDefinition(tab),
    {
      ...pluginText(tab, "codexHome", "codexHook.home", {
        placeholder: automatic(tab, plugin.codexDirOverride || plugin.shellInfo?.CODEX_HOME ||
          process.env.CODEX_HOME || "~/.codex"),
        normalize: value => value.trim(),
        validate: value => value && !normalizeCodexHome(value) ? plugin.t("codexHook.home.invalid") : null,
      }, () => { void tab.refresh(); }),
      aliases: ["Codex"],
    },
    {
      ...pluginText(tab, "opencodeHome", "opencode.home", {
        placeholder: automatic(tab, openCodeDataHome(plugin.shellInfo, process.env)),
        normalize: value => value.trim(),
        validate: value => value && !normalizeCodexHome(value) ? plugin.t("opencode.home.invalid") : null,
      }, () => plugin.writeServerConfig({ opencode_home: normalizeCodexHome(plugin.settings.opencodeHome) || "" })),
      aliases: ["OpenCode"],
    },
  ]);
  const launch = group(tab, "adv.launch", [
    ...agentKinds.map(kind => {
      const name = `settings.args.${kind}`;
      const terminal = supportsTerminal(kind);
      const row = textDefinition(tab, name, () => plugin.settings.agentArgs?.[kind], async value => {
        plugin.settings.agentArgs = Object.assign({}, plugin.settings.agentArgs, { [kind]: value });
        await tab.save();
        plugin.writeAgentArgs();
      }, { desc: "settings.args.desc", placeholder: terminal ? plugin.t(`${name}.placeholder`) : automatic(tab) });
      return terminal ? row : { ...row, name: plugin.t("settings.args.generic", { agent: getAgent(kind).label }) };
    }),
    pluginText(tab, "shellPath", "adv.shell", {
      placeholder: automatic(tab, process.env.SHELL || "/bin/zsh"), normalize: value => value.trim(),
    }),
  ]);
  const mail = group(tab, "adv.mail", [
    pluginText(tab, "agentMailRoot", "mail.root", {
      placeholder: automatic(tab, process.env.AGENT_MAIL_HOME || "~/.agent-mail"),
      normalize: value => value.trim(),
      validate: value => value && !validMailRoot(value) ? plugin.t("mail.root.invalid") : null,
    }, () => plugin.writeMailArgs()),
    pluginText(tab, "agentMailScript", "mail.script", { placeholder: plugin.t("mail.script.placeholder") }),
  ]);
  return { integrations, launch, mail };
}

export { advancedDefinitions };

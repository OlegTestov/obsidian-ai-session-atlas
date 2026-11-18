import { Notice } from "obsidian";
import * as path from "path";
import { shellQuote } from "./agents";
import { mailRoot } from "./mail-nudge";
import { writeClipboard } from "./term-copy";

function mailSetupCommand(agent, executable, script, root, codexHome) {
  const option = agent === "claude" ? "-e" : "--env";
  const base = agent === "claude" ? "claude mcp add --scope user agent-mail"
    : `CODEX_HOME=${shellQuote(codexHome)} codex mcp add agent-mail`;
  return `${base} ${option} AGENT_MAIL_NAME=${agent} ${option} ${shellQuote(`AGENT_MAIL_HOME=${root}`)} -- ${shellQuote(executable)} ${shellQuote(script)}`;
}

function mailSetupDefinition(tab) {
  const { plugin } = tab;
  return { name: plugin.t("mail.setup"), desc: plugin.t("mail.setup.desc"), render: setting => {
    for (const agent of ["claude", "codex"]) {
      setting.addButton(button => button.setButtonText(plugin.t(`mail.setup.${agent}`)).onClick(async () => {
        try {
          const root = mailRoot(plugin.settings);
          const payload = plugin.embeddedPayload();
          const python = await plugin.findPython();
          if (!root || !payload || !python) throw new Error("mail prerequisites unavailable");
          if (agent === "codex") await plugin.shellProbe();
          const script = path.join(plugin.extractRuntime(payload), "atlas", "agent_mail.py");
          const command = mailSetupCommand(agent, python.path, script, root,
                                           agent === "codex" ? plugin.codexHome() : null);
          if (!await writeClipboard(command)) throw new Error("clipboard unavailable");
          new Notice(plugin.t("mail.setup.copied"));
        } catch {
          new Notice(plugin.t("mail.setup.failed"));
        }
      }));
    }
  } };
}

export { mailSetupCommand, mailSetupDefinition };

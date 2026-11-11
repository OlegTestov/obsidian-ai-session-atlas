// First start after installation: subscription limits on where nothing else holds the status line, and one
// notice that says what is on and where to turn it off. Existing installs never get here.
import { Notice } from "obsidian";
import * as fsSync from "fs";
import * as os from "os";

class FirstRunMethods {
  /** Runs once, after the agents check, so the notice names the agents it found. */
  async firstRunSetup() {
    let limits = false, copied = false;
    const file = this.claudeSettingsPath();
    const found = this.settings && this.settings.agentsFound;
    try {
      // Only for an installed Claude Code and an empty slot: our line already there or someone else's stays.
      if (found && found.claude && this.statusLineState().state === "off") {
        copied = fsSync.existsSync(file) && !fsSync.existsSync(file + ".session-atlas.bak");
        limits = (await this.setStatusLine(true)).ok === true;
      }
    } catch (error) { console.error("AI Session Atlas: could not turn on subscription limits", error); }
    if (this._loaded === false) return { limits };
    const cfg = this.readServerConfig() || {};
    const names = { claude: "Claude Code", codex: "Codex" };
    const agents = Object.keys(names).filter((kind) => this.agentEnabled(kind)).map((kind) => names[kind]);
    const lines = [];
    const home = os.homedir();
    const shown = file.startsWith(home + "/") ? "~" + file.slice(home.length) : file;
    if (limits) lines.push(this.t(copied ? "firstRun.limitsCopy" : "firstRun.limits", { file: shown }));
    if (cfg.llm_enabled !== false) lines.push(this.t("firstRun.ai"));
    if (agents.length) lines.push(this.t("firstRun.agents", { agents: agents.join(", ") }));
    const frag = document.createDocumentFragment();
    frag.createEl("div", { text: this.t("firstRun.title"), cls: "session-atlas-first-run-title" });
    const list = frag.createEl("ul", { cls: "session-atlas-first-run-list" });
    for (const line of lines) list.createEl("li", { text: line });
    frag.createEl("div", { text: this.t("firstRun.settings") });
    const notice = new Notice(frag, 0);
    const el = notice.containerEl || notice.messageEl;
    if (el) el.addEventListener("click", () => this.openOwnSettings());
    return { limits, copied, lines };
  }

  openOwnSettings() {
    const setting = this.app && this.app.setting;
    if (!setting || typeof setting.open !== "function") return;
    setting.open();
    if (typeof setting.openTabById === "function") setting.openTabById(this.manifest.id);
  }
}

export { FirstRunMethods };

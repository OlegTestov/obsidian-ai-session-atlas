// A ten-second release summary, bundled locally: no network, transcript, or Markdown renderer.
import { Modal, setIcon } from "obsidian";

const RELEASE_VERSION = "2.7.0";
const RELEASE_URL = `https://github.com/OlegTestov/obsidian-ai-session-atlas/releases/tag/${RELEASE_VERSION}`;

function parts(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : null;
}

function updateDecision(saved, version) {
  const current = parts(version);
  if (!current) return "none";
  const previous = parts(saved.lastSeenVersion);
  if (previous) {
    const different = current.findIndex((n, i) => n !== previous[i]);
    if (different < 0 || current[different] < previous[different]) return "none";
  }
  if (!Object.keys(saved).length || saved.showWhatsNew === false) return "baseline";
  return "show";
}

class WhatsNewModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    const t = (key) => this.plugin.t(`updates.${key}`);
    this.modalEl.addClass("sa-updates");
    this.setTitle(t("title"));
    const el = this.contentEl;
    el.createEl("p", { cls: "sa-updates-version", text: `AI Session Atlas · ${RELEASE_VERSION}` });
    for (const [key, icon] of [["tabs", "server"], ["close", "circle-stop"], ["news", "log-in"]]) {
      const card = el.createDiv({ cls: "sa-update-card" });
      setIcon(card.createSpan({ cls: "sa-update-icon" }), icon);
      card.createEl("h3", { text: t(`${key}.title`) });
      card.createEl("p", { text: t(`${key}.desc`) });
    }
    const actions = el.createDiv({ cls: "sa-update-actions" });
    actions.createEl("a", { text: t("all"), href: RELEASE_URL,
                           attr: { target: "_blank", rel: "noopener noreferrer" } });
    const done = actions.createEl("button", { cls: "mod-cta", text: t("done") });
    done.addEventListener("click", () => this.close());
    // Obsidian installs its focus trap after onOpen; focus the dismiss action on the next frame.
    this.focusFrame = window.requestAnimationFrame(() => { if (done.isConnected) done.focus(); });
  }

  onClose() {
    window.cancelAnimationFrame(this.focusFrame);
    this.contentEl.empty();
    if (this.plugin.updateModal === this) this.plugin.updateModal = null;
  }
}

class WhatsNewMethods {
  initWhatsNew(saved) {
    this.addCommand({ id: "whats-new", name: this.t("updates.command"), callback: () => this.showWhatsNew() });
    this.register(() => { if (this.updateModal) this.updateModal.close(); });
    this.app.workspace.onLayoutReady(() => {
      this.checkWhatsNew(saved).catch((error) => console.error("AI Session Atlas: update highlights", error));
    });
  }

  async checkWhatsNew(saved) {
    if (this._loaded === false) return;
    const decision = updateDecision(saved, this.manifest.version);
    if (decision === "none") return;
    this.settings.lastSeenVersion = this.manifest.version;
    await this.saveData(this.settings);
    if (decision === "show" && this._loaded !== false) this.showWhatsNew();
  }

  showWhatsNew() {
    if (this.updateModal) return;
    this.updateModal = new WhatsNewModal(this);
    this.updateModal.open();
  }
}

export { RELEASE_VERSION, updateDecision, WhatsNewMethods };

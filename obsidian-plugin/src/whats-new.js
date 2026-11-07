// A ten-second release summary, bundled locally: no network, transcript, or Markdown renderer.
import { Modal, setIcon } from "obsidian";
/* global __ATLAS_VERSION__ -- set by esbuild.config.mjs in the release build */

const RELEASE_VERSION = "2.7.0";
const RELEASE_URL = `https://github.com/OlegTestov/obsidian-ai-session-atlas/releases/tag/${RELEASE_VERSION}`;
// Obsidian reads plugin manifests only at startup: after an in-place reload this.manifest still names
// the version Obsidian started with. The release build stamps its own version (esbuild.config.mjs).
const BUILT_VERSION = typeof __ATLAS_VERSION__ === "string" ? __ATLAS_VERSION__ : null;

function parts(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : null;
}

/** -1, 0 or 1: a before, equal to or after b. */
function compare(a, b) {
  const different = a.findIndex((n, i) => n !== b[i]);
  return different < 0 ? 0 : Math.sign(a[different] - b[different]);
}

/**
 * "show", "baseline" (record the version quietly) or "none". The highlights belong to `release`: a
 * later patch without its own highlights records itself but does not show them a second time.
 */
function updateDecision(saved, version, release = RELEASE_VERSION) {
  const current = parts(version);
  if (!current) return "none";
  const previous = parts(saved.lastSeenVersion);
  if (previous && compare(current, previous) <= 0) return "none";
  if (!Object.keys(saved).length || saved.showWhatsNew === false) return "baseline";
  const notes = parts(release);
  if (previous && notes && compare(previous, notes) >= 0) return "baseline";
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
    for (const [key, icon] of [["marks", "server"], ["close", "circle-stop"], ["bringBack", "log-in"]]) {
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
    const version = this.runningVersion();
    const decision = updateDecision(saved, version);
    if (decision === "none") return;
    this.settings.lastSeenVersion = version;
    await this.saveData(this.settings);
    if (decision === "show" && this._loaded !== false) this.showWhatsNew();
  }

  runningVersion() {
    return BUILT_VERSION || this.manifest.version;
  }

  showWhatsNew() {
    if (this.updateModal) return;
    this.updateModal = new WhatsNewModal(this);
    this.updateModal.open();
  }
}

export { RELEASE_VERSION, updateDecision, WhatsNewMethods };

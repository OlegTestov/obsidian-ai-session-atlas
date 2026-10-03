// Catalog tab: an iframe on the local server.
import { ItemView } from "obsidian";
import { atlasTitle } from "./notify";
import {
  VIEW_TYPE,
  HOST_SOURCE,
} from "./constants";

const DEFAULT_CARD_MESSAGES = 10;

class AtlasView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.hash = "";
  }

  getViewType() { return VIEW_TYPE; }
  // The "waiting for you" counter shows in the tab title even when the tab is in the background.
  getDisplayText() { return atlasTitle(this.plugin.waitingCount || 0); }
  getIcon() { return "library"; }

  /** The tab is restored with the selected session: the state lives in the hash. */
  async setState(state, result) {
    if (state && typeof state.hash === "string") this.hash = state.hash;
    await super.setState(state, result);
    this.render();          // the single render point; onOpen does not duplicate it
  }

  getState() {
    const hash = this.frame && this.frame.contentWindow
      ? this.readHash()
      : this.hash;
    return { hash: hash || "" };
  }

  readHash() {
    try {
      return this.frame.contentWindow.location.hash || "";
    } catch {
      return this.hash;   // a foreign origin cannot be read: keep the last known value
    }
  }

  async onOpen() {
    // setState starts rendering. Without a state (an empty tab was opened), render here.
    if (!this.frame) this.render();
    // A hidden Obsidian tab has zero width. Back on screen, the page may rearrange its cards:
    // while you are on the tab, it keeps them in place.
    this.onScreen = this.contentEl.clientWidth > 0;
    this.visibility = new ResizeObserver(() => this.visibilityChanged(this.contentEl.clientWidth > 0));
    this.visibility.observe(this.contentEl);
  }

  visibilityChanged(visible) {
    if (visible && !this.onScreen && this.frame && this.frame.contentWindow) {
      this.frame.contentWindow.postMessage({ source: HOST_SOURCE, type: "shown" }, this.plugin.atlasOrigin());
    }
    this.onScreen = visible;
  }

  async onClose() {
    if (this.visibility) this.visibility.disconnect();
  }

  async render() {
    if (this.rendering) return;   // overlapping async passes would each draw an error block
    this.rendering = true;
    try {
      await this.renderOnce();
    } finally {
      this.rendering = false;
    }
  }

  async renderOnce() {
    const container = this.contentEl;
    container.empty();
    // The catalog scrolls inside the page; an outer scrollbar would only get in the way.
    container.addClass("session-atlas-view");

    const up = await this.plugin.ensureServer();
    if (!up) {
      const box = container.createDiv({ cls: "session-atlas-down" });
      box.createEl("p", { text: this.plugin.t("server.down") });
      box.createEl("p", { text: this.plugin.t("server.hint"), cls: "mod-warning" });
      const retry = box.createEl("button", { text: this.plugin.t("server.retry") });
      retry.addEventListener("click", () => this.render());
      return;
    }

    this.frame = container.createEl("iframe", { cls: "session-atlas-frame" });
    // The page language matches the plugin: Obsidian's language or the one chosen in settings.
    const messages = Number(this.plugin.settings && this.plugin.settings.cardMessages) || DEFAULT_CARD_MESSAGES;
    this.frame.src = this.plugin.atlasOrigin() + "/?lang=" + this.plugin.lang() + "&msgs=" + messages + (this.hash || "");
  }
}

export { AtlasView };

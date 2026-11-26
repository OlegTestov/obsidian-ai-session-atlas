// Catalog tab: an iframe on the local server.
import { ItemView } from "obsidian";
import { atlasTitle } from "./notify";
import {
  VIEW_TYPE,
  HOST_SOURCE,
} from "./constants";

class AtlasView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.hash = "";
    this.terminalMirrors = new Set();
  }

  getViewType() { return VIEW_TYPE; }
  // The "waiting for you" counter shows in the tab title even when the tab is in the background.
  getDisplayText() { return atlasTitle(this.plugin.waitingCount || 0); }
  getIcon() { return "library"; }

  onTabMenu(menu) {
    if (super.onTabMenu) super.onTabMenu(menu);
    this.plugin.addGroupItems(menu, this.leaf);
  }

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

  /** The parent cannot read the catalog's cross-origin URL. Save the state reported by our iframe. */
  rememberHash(hash) {
    if (typeof hash !== "string" || !hash.startsWith("#") || hash.length > 65536 || hash === this.hash) return;
    this.hash = hash;
    this.app.workspace.requestSaveLayout?.();
  }

  async onOpen() {
    // setState starts rendering. Without a state (an empty tab was opened), render here.
    if (!this.frame) this.render();
    // A hidden Obsidian tab has zero width even while the iframe document reports visible.
    this.onScreen = this.contentEl.clientWidth > 0;
    this.visibility = new ResizeObserver(() => this.visibilityChanged(this.contentEl.clientWidth > 0));
    this.visibility.observe(this.contentEl);
  }

  visibilityChanged(visible, loaded = false) {
    if (!loaded && visible === this.onScreen) return;
    this.onScreen = visible;
    if (this.frameLoaded) {
      this.frame?.contentWindow?.postMessage(
        { source: HOST_SOURCE, type: "pane-visibility", visible }, this.plugin.atlasOrigin());
    }
  }

  async onClose() {
    if (this.visibility) this.visibility.disconnect();
    this.terminalMirrors.forEach(close => close());
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
    this.terminalMirrors.forEach(close => close());
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

    const frame = this.frame = container.createEl("iframe", { cls: "session-atlas-frame" });
    // The clipboard button runs inside the cross-origin catalog frame.
    frame.allow = `clipboard-write ${this.plugin.atlasOrigin()}`;
    this.frameLoaded = false;
    frame.addEventListener("load", () => {
      if (this.frame !== frame) return;
      this.frameLoaded = true;
      this.visibilityChanged(container.clientWidth > 0, true);
    });
    // The page language matches the plugin: Obsidian's language or the one chosen in settings.
    frame.src = this.plugin.atlasOrigin() + "/?lang=" + this.plugin.lang() + "&host_visibility=1"
      + "&host=" + encodeURIComponent(this.plugin.hostId()) + (this.hash || "");
  }
}

export { AtlasView };

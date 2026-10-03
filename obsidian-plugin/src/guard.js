// Close confirmation: a terminal tab holds a live agent session, and the catalog tab is annoying to
// close by accident. The close button, a middle click on the header and ⌘W go through a dialog
// where "Keep open" is the default. Mixed into the plugin class.
import { Modal, View } from "obsidian";
import { VIEW_TYPE, AGENT_VIEW_TYPE, TERMINAL_VIEW_TYPE, TERMINAL_STATE_KEY, TAB_CLOSE_SELECTOR } from "./constants";

const TAB_HEADER_SELECTOR = ".workspace-tab-header";
const CLOSE_TAB_COMMAND_ID = "workspace:close";

class ConfirmCloseModal extends Modal {
  constructor(app, { title, text, keep, close, onConfirm, onDismiss }) {
    super(app);
    Object.assign(this, { title, text, keepLabel: keep, closeLabel: close, onConfirm, onDismiss });
    this.confirmed = false;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.text });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    // Focus on "keep": a stray Enter must not close the tab.
    const keep = buttons.createEl("button", { text: this.keepLabel });
    keep.addEventListener("click", () => this.close());
    const close = buttons.createEl("button", { text: this.closeLabel, cls: "mod-warning" });
    close.addEventListener("click", () => { this.confirmed = true; this.close(); });
    window.setTimeout(() => keep.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (this.confirmed && typeof this.onConfirm === "function") this.onConfirm();
    if (typeof this.onDismiss === "function") this.onDismiss();
  }
}

class GuardMethods {
  /** The tab kind: "terminal", "atlas", or null for a tab that closes without asking. */
  guardKind(leaf) {
    const type = leaf && leaf.view && typeof leaf.view.getViewType === "function"
      ? leaf.view.getViewType() : null;
    if (type === VIEW_TYPE) return "atlas";
    if (type === AGENT_VIEW_TYPE) return "terminal";
    if (type === TERMINAL_VIEW_TYPE) return "terminal";
    return null;
  }

  installCloseGuard(doc) {
    if (!doc || doc.__sessionAtlasGuard) return;
    doc.__sessionAtlasGuard = true;
    // The close button is caught on pointerdown: Obsidian closes the tab before click arrives.
    for (const type of ["pointerdown", "mousedown", "click"]) {
      this.registerDomEvent(doc, type, (event) => this.onCloseButton(event, type === "click"),
                            { capture: true });
    }
    this.registerDomEvent(doc, "auxclick", (event) => this.onMiddleClick(event), { capture: true });
  }

  onCloseButton(event, ask) {
    const target = event.target;
    const closeEl = target && typeof target.closest === "function" ? target.closest(TAB_CLOSE_SELECTOR) : null;
    if (!closeEl) return;
    const leaf = this.findLeafByTabHeader(closeEl.closest(TAB_HEADER_SELECTOR));
    if (!this.guardKind(leaf)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (ask) this.confirmClose(leaf);
  }

  onMiddleClick(event) {
    if (event.button !== 1) return;
    const target = event.target;
    const header = target && typeof target.closest === "function" ? target.closest(TAB_HEADER_SELECTOR) : null;
    const leaf = this.findLeafByTabHeader(header);
    if (!this.guardKind(leaf)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.confirmClose(leaf);
  }

  /** ⌘W is the same command as the menu item: it is wrapped while the plugin runs. */
  patchCloseTabCommand() {
    const commands = this.app.commands && this.app.commands.commands;
    const command = commands ? commands[CLOSE_TAB_COMMAND_ID] : null;
    if (!command) return;
    // The leaf to confirm, or null when the command runs as usual. Arrow functions keep the plugin
    // as `this`; the wrappers below keep the command's own `this` for the original callback.
    const guardedLeaf = () => {
      const leaf = this.activeLeaf();
      return this.guardKind(leaf) ? leaf : null;
    };
    const confirm = (leaf) => this.confirmClose(leaf);
    if (typeof command.checkCallback === "function") {
      const original = command.checkCallback;
      command.checkCallback = function (checking) {
        const leaf = checking ? null : guardedLeaf();
        if (leaf && original.call(this, true)) {
          confirm(leaf);
          return true;
        }
        return original.call(this, checking);
      };
      this.register(() => { command.checkCallback = original; });
    } else if (typeof command.callback === "function") {
      const original = command.callback;
      command.callback = function (...args) {
        const leaf = guardedLeaf();
        if (leaf) { confirm(leaf); return undefined; }
        return original.apply(this, args);
      };
      this.register(() => { command.callback = original; });
    }
  }

  /** The active view's leaf, else the last active leaf of the main area. */
  activeLeaf() {
    const ws = this.app.workspace;
    const view = typeof ws.getActiveViewOfType === "function" ? ws.getActiveViewOfType(View) : null;
    if (view && view.leaf) return view.leaf;
    return typeof ws.getMostRecentLeaf === "function" ? ws.getMostRecentLeaf() : null;
  }

  findLeafByTabHeader(headerEl) {
    if (!headerEl) return null;
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.tabHeaderEl === headerEl) found = leaf;
    });
    return found;
  }

  /** Session label: the terminal profile name or the tab title. */
  terminalLabel(leaf) {
    try {
      const state = leaf.getViewState();
      const term = state && state.state && state.state[TERMINAL_STATE_KEY];
      if (term && term.profile && term.profile.name) return term.profile.name;
    } catch (error) {
      console.error("Session Atlas: cannot read the tab state", error);
    }
    return (leaf.view && typeof leaf.view.getDisplayText === "function" && leaf.view.getDisplayText())
      || "Terminal";
  }

  confirmClose(leaf, label) {
    if (this.pendingCloseConfirms.has(leaf)) return;
    this.pendingCloseConfirms.add(leaf);
    const atlas = this.guardKind(leaf) === "atlas";
    new ConfirmCloseModal(this.app, {
      title: this.t(atlas ? "close.atlas.title" : "close.terminal.title"),
      text: atlas ? this.t("close.atlas.text")
        : this.t("close.terminal.text", { label: label || this.terminalLabel(leaf) }),
      keep: this.t("close.keep"),
      close: this.t("close.close"),
      onConfirm: () => leaf.detach(),
      onDismiss: () => this.pendingCloseConfirms.delete(leaf),
    }).open();
  }
}

export { GuardMethods, ConfirmCloseModal };

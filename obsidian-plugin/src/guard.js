// Close confirmation: a terminal tab holds a live agent session, and the catalog tab is annoying to
// close by accident. The close button, a middle click on the header and ⌘W go through a dialog
// where "Keep open" is the default. Mixed into the plugin class.
import { Modal, Notice, View } from "obsidian";
import { VIEW_TYPE, AGENT_VIEW_TYPE, TERMINAL_VIEW_TYPE, TERMINAL_STATE_KEY, TAB_CLOSE_SELECTOR } from "./constants";

const TAB_HEADER_SELECTOR = ".workspace-tab-header";
const CLOSE_TAB_COMMAND_ID = "workspace:close";

class ConfirmCloseModal extends Modal {
  /** stop/onStop: a third button, for a tab whose session runs in a background job. */
  constructor(app, { title, text, keep, close, stop, onConfirm, onStop, onDismiss }) {
    super(app);
    Object.assign(this, { title, text, keepLabel: keep, closeLabel: close, stopLabel: stop, onConfirm, onStop,
                          onDismiss });
    this.confirmed = false;
    this.stopping = false;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.text });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    // Focus on "keep": a stray Enter must not close the tab.
    const keep = buttons.createEl("button", { text: this.keepLabel });
    keep.addEventListener("click", () => this.close());
    const close = buttons.createEl("button", { text: this.closeLabel, cls: this.stopLabel ? "" : "mod-warning" });
    close.addEventListener("click", () => { this.confirmed = true; this.close(); });
    if (this.stopLabel) {
      const stop = buttons.createEl("button", { text: this.stopLabel, cls: "mod-warning" });
      stop.addEventListener("click", () => { this.stopping = true; this.close(); });
    }
    window.setTimeout(() => keep.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (this.confirmed && typeof this.onConfirm === "function") this.onConfirm();
    if (this.stopping && typeof this.onStop === "function") this.onStop();
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
    // Per plugin instance, not a mark on the document: the listeners go away with the instance on
    // unload, and a mark left on the document made the next instance skip the install.
    if (!this.guardedDocs) this.guardedDocs = new WeakSet();
    if (!doc || this.guardedDocs.has(doc)) return;
    this.guardedDocs.add(doc);
    // The close button is caught on pointerdown: Obsidian closes the tab before click arrives.
    for (const type of ["pointerdown", "mousedown", "click"]) {
      this.registerDomEvent(doc, type, (event) => this.onCloseButton(event, type === "click"),
                            { capture: true });
    }
    this.registerDomEvent(doc, "auxclick", (event) => this.onMiddleClick(event), { capture: true });
  }

  /** The main window and every popout open now (a plugin reload finds them already open). */
  installCloseGuards() {
    this.installCloseGuard(document);
    const ws = this.app && this.app.workspace;
    if (!ws || typeof ws.iterateAllLeaves !== "function") return;
    ws.iterateAllLeaves((leaf) => {
      const el = leaf && leaf.view && leaf.view.containerEl;
      if (el && el.ownerDocument) this.installCloseGuard(el.ownerDocument);
    });
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
    // A middle click on a group chip (or its label) is the chip's, not a close of the group's first tab.
    if ([target, target && target.parentElement].some((el) => el && el.classList && el.classList.contains("sa-group-chip"))) return;
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
      console.error("AI Session Atlas: cannot read the tab state", error);
    }
    return (leaf.view && typeof leaf.view.getDisplayText === "function" && leaf.view.getDisplayText())
      || "Terminal";
  }

  confirmClose(leaf, label) {
    if (this.pendingCloseConfirms.has(leaf) || (this.stoppingLeaves && this.stoppingLeaves.has(leaf))) return;
    this.pendingCloseConfirms.add(leaf);
    const atlas = this.guardKind(leaf) === "atlas";
    const job = atlas ? null : this.backgroundJobOf(leaf);
    if (job) {
      new ConfirmCloseModal(this.app, {
        title: this.t("close.background.title"),
        text: this.t("close.background.text", { label: label || this.terminalLabel(leaf) }),
        keep: this.t("close.keep"),
        close: this.t("close.background.close"),
        stop: this.t("close.background.stop"),
        onConfirm: () => leaf.detach(),
        onStop: () => this.stopAndClose(leaf, job),
        onDismiss: () => this.pendingCloseConfirms.delete(leaf),
      }).open();
      return;
    }
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

  /**
   * The job is stopped first: if that fails, the tab stays, the only way left to reach the session.
   * Until the stop ends the tab asks nothing again (a second × would start a second stop).
   */
  async stopAndClose(leaf, job) {
    if (!this.stoppingLeaves) this.stoppingLeaves = new WeakSet();
    this.stoppingLeaves.add(leaf);
    const notice = new Notice(this.t("close.background.stopping", { job }), 0);
    const view = leaf.view;
    const pty = view && view.pty;
    try {
      if (await this.stopJob(job)) {
        if (this.leafIsOpen(leaf) && leaf.view === view && (!view || view.pty === pty)) leaf.detach();
      }
    } catch (error) {
      new Notice(String(error.message || error));
    } finally {
      this.stoppingLeaves.delete(leaf);
      if (notice && typeof notice.hide === "function") notice.hide();
    }
  }

  leafIsOpen(leaf) {
    let found = false;
    this.app.workspace.iterateAllLeaves((l) => { if (l === leaf) found = true; });
    return found;
  }
}

export { GuardMethods, ConfirmCloseModal };

// Подтверждение закрытия: вкладка терминала держит живую сессию агента, вкладка каталога —
// то, что обидно закрыть случайно. Крестик, средний клик по заголовку и ⌘W идут через окно,
// где по умолчанию выбрано «Оставить». Подмешивается в класс плагина.
const { Modal } = require("obsidian");
const { VIEW_TYPE, AGENT_VIEW_TYPE, TERMINAL_VIEW_TYPE, TERMINAL_STATE_KEY, TAB_CLOSE_SELECTOR } = require("./constants");

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
    // Фокус на «оставить»: случайный Enter не должен закрывать вкладку.
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
  /** Что за вкладка: "terminal", "atlas" или null — такую закрываем без вопросов. */
  guardKind(leaf) {
    const type = leaf && leaf.view && typeof leaf.view.getViewType === "function"
      ? leaf.view.getViewType() : null;
    if (type === VIEW_TYPE) return "atlas";
    if (type === AGENT_VIEW_TYPE) return "terminal";
    // Пока включён старый плагин с тем же вопросом, терминалы спрашивает он — не дважды.
    if (type === TERMINAL_VIEW_TYPE && !this.legacyEnabled("agent-terminal-ribbons")) return "terminal";
    return null;
  }

  installCloseGuard(doc) {
    if (!doc || doc.__sessionAtlasGuard) return;
    doc.__sessionAtlasGuard = true;
    // Крестик ловим с pointerdown: Obsidian закрывает вкладку раньше, чем дойдёт click.
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

  /** ⌘W — та же команда, что у меню: подменяем её на время работы плагина. */
  patchCloseTabCommand() {
    const commands = this.app.commands && this.app.commands.commands;
    const command = commands ? commands[CLOSE_TAB_COMMAND_ID] : null;
    if (!command) return;
    const self = this;
    if (typeof command.checkCallback === "function") {
      const original = command.checkCallback;
      command.checkCallback = function (checking) {
        const leaf = self.activeLeaf();
        if (!checking && self.guardKind(leaf) && original.call(this, true)) {
          self.confirmClose(leaf);
          return true;
        }
        return original.call(this, checking);
      };
      this.register(() => { command.checkCallback = original; });
    } else if (typeof command.callback === "function") {
      const original = command.callback;
      command.callback = function () {
        const leaf = self.activeLeaf();
        if (self.guardKind(leaf)) { self.confirmClose(leaf); return undefined; }
        return original.apply(this, arguments);
      };
      this.register(() => { command.callback = original; });
    }
  }

  activeLeaf() {
    const ws = this.app.workspace;
    if (ws.activeLeaf) return ws.activeLeaf;
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

  /** Подпись сессии: название вкладки или имя профиля терминала. */
  terminalLabel(leaf) {
    try {
      const state = leaf.getViewState();
      const term = state && state.state && state.state[TERMINAL_STATE_KEY];
      if (term && term.profile && term.profile.name) return term.profile.name;
    } catch (error) {
      console.error("Session Atlas: не прочитать состояние вкладки", error);
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

module.exports = { GuardMethods, ConfirmCloseModal };

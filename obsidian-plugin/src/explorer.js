// Клики в проводнике файлов: левый — новая вкладка, средний — текущая; уже открытый файл не
// дублируется — переход к его вкладке. Выключается в настройках. Подмешивается в класс плагина.
const { TFile } = require("obsidian");

const FILE_TITLE_SELECTOR = ".nav-file-title";

class ExplorerMethods {
  installExplorerClicks() {
    // Захват: раньше собственного обработчика проводника, иначе он успеет открыть файл сам.
    this.registerDomEvent(document, "click", (e) => this.onExplorerClick(e, true), { capture: true });
    this.registerDomEvent(document, "auxclick", (e) => this.onExplorerClick(e, false), { capture: true });
  }

  explorerClicksOn() {
    return !!(this.settings && this.settings.explorerClicks) && !this.legacyEnabled("swap-click-open");
  }

  onExplorerClick(evt, left) {
    if (!this.explorerClicksOn()) return;
    if (left && (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey)) return;
    if (!left && evt.button !== 1) return;
    const el = evt.target && typeof evt.target.closest === "function" ? evt.target.closest(FILE_TITLE_SELECTOR) : null;
    const file = el && el.getAttribute("data-path")
      ? this.app.vault.getAbstractFileByPath(el.getAttribute("data-path")) : null;
    // Не файл (папка, устаревший путь) — пусть отработает сам Obsidian, событие не съедаем.
    if (!(file instanceof TFile)) return;
    evt.preventDefault();
    evt.stopImmediatePropagation();
    this.openExplorerFile(file, left).catch((e) => console.error("Session Atlas:", e));
  }

  async openExplorerFile(file, newTab) {
    const ws = this.app.workspace;
    let open = null;
    ws.iterateAllLeaves((leaf) => {
      const state = !open && leaf.getViewState();
      if (state && state.state && state.state.file === file.path) open = leaf;
    });
    if (open) {
      ws.setActiveLeaf(open, { focus: true });
      ws.revealLeaf(open);
      return;
    }
    const leaf = newTab ? ws.getLeaf("tab") : (ws.getMostRecentLeaf() || ws.getLeaf("tab"));
    await leaf.openFile(file);
  }
}

module.exports = { ExplorerMethods };

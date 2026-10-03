// File explorer clicks: left opens a new tab, middle the current one; an already open file is not
// duplicated, its tab is focused instead. Can be turned off in settings. Mixed into the plugin class.
import { TFile } from "obsidian";

const FILE_TITLE_SELECTOR = ".nav-file-title";

class ExplorerMethods {
  installExplorerClicks() {
    // Capture phase: runs before the explorer's own handler, which would open the file itself.
    this.registerDomEvent(document, "click", (e) => this.onExplorerClick(e, true), { capture: true });
    this.registerDomEvent(document, "auxclick", (e) => this.onExplorerClick(e, false), { capture: true });
  }

  explorerClicksOn() {
    return !!(this.settings && this.settings.explorerClicks);
  }

  onExplorerClick(evt, left) {
    if (!this.explorerClicksOn()) return;
    if (left && (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey)) return;
    if (!left && evt.button !== 1) return;
    const el = evt.target && typeof evt.target.closest === "function" ? evt.target.closest(FILE_TITLE_SELECTOR) : null;
    const file = el && el.getAttribute("data-path")
      ? this.app.vault.getAbstractFileByPath(el.getAttribute("data-path")) : null;
    // Not a file (a folder, a stale path): Obsidian handles it, the event is not swallowed.
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

export { ExplorerMethods };

// Reloading the plugin without closing tabs. The settings toggle means "disabled by the user", and
// Obsidian closes the plugin's tabs. A quiet unload leaves them as placeholders, and after loading
// Obsidian recreates them with the same state; terminals pick up live processes from the registry.
import { Notice } from "obsidian";
import * as fsSync from "fs";
import * as path from "path";

const WATCH_INTERVAL_MS = 2000;
const SETTLE_MS = 1500;         // the build is one file, but wait until its size stops changing

class ReloadMethods {
  canReloadInPlace() {
    const plugins = this.app && this.app.plugins;
    return !!(plugins && typeof plugins.disablePlugin === "function" && typeof plugins.enablePlugin === "function");
  }

  /** Unloads and loads again from the files on disk; tabs and sessions stay. */
  reloadInPlace() {
    if (this.reloading || !this.canReloadInPlace()) return false;
    const plugins = this.app.plugins;
    const id = this.manifest.id;
    if (plugins.plugins && plugins.plugins[id] !== this) return false;     // a reload is already under way
    this.reloading = true;
    // Not from inside our own handler: unloading would cut it off midway.
    window.setTimeout(async () => {
      await plugins.disablePlugin(id);
      await plugins.enablePlugin(id);
    }, 50);
    return true;
  }

  /** A new build in the plugin folder (installer, manual copy) is picked up automatically. */
  watchOwnBuild() {
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    if (!adapter || !adapter.getBasePath || !this.manifest || !this.manifest.dir) return;
    const file = path.join(adapter.getBasePath(), this.manifest.dir, "main.js");
    // Development installs only: tools/install_plugin.py leaves this marker next to main.js.
    if (!fsSync.existsSync(path.join(adapter.getBasePath(), this.manifest.dir, ".hotreload"))) return;
    let known;
    try { known = fsSync.statSync(file); } catch { return; }
    let timer = null;
    const listener = (current) => {
      if (!current.size || (current.mtimeMs === known.mtimeMs && current.size === known.size)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        let settled;
        try { settled = fsSync.statSync(file); } catch { return; }
        if (settled.size !== current.size) return;           // still being written: wait for the next poll
        known = settled;
        if (this.reloadInPlace()) new Notice(this.t("reload.newBuild"));
      }, SETTLE_MS);
    };
    fsSync.watchFile(file, { interval: WATCH_INTERVAL_MS }, listener);
    this.register(() => { window.clearTimeout(timer); fsSync.unwatchFile(file, listener); });
  }
}

export { ReloadMethods };

// Перезагрузка плагина без закрытия вкладок. Тумблер в настройках — «выключено пользователем»:
// Obsidian закрывает вкладки плагина. Тихая выгрузка оставляет их заглушками, а после загрузки
// Obsidian пересоздаёт их с тем же состоянием; терминалы подхватывают живые процессы из реестра.
const { Notice } = require("obsidian");
const fsSync = require("fs");
const path = require("path");

const WATCH_INTERVAL_MS = 2000;
const SETTLE_MS = 1500;         // сборку пишут одним файлом, но дождёмся, пока размер перестанет меняться

class ReloadMethods {
  canReloadInPlace() {
    const plugins = this.app && this.app.plugins;
    return !!(plugins && typeof plugins.disablePlugin === "function" && typeof plugins.enablePlugin === "function");
  }

  /** Выгрузить и загрузить заново из файлов на диске; вкладки и сессии остаются. */
  reloadInPlace() {
    if (this.reloading || !this.canReloadInPlace()) return false;
    const plugins = this.app.plugins;
    const id = this.manifest.id;
    if (plugins.plugins && plugins.plugins[id] !== this) return false;     // уже перезагружают
    this.reloading = true;
    // Не изнутри своего же обработчика: выгрузка оборвала бы его на середине.
    setTimeout(async () => {
      await plugins.disablePlugin(id);
      await plugins.enablePlugin(id);
    }, 50);
    return true;
  }

  /** Новая сборка легла в папку плагина (установщик, ручное копирование) — подхватить самим. */
  watchOwnBuild() {
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    if (!adapter || !adapter.getBasePath || !this.manifest || !this.manifest.dir) return;
    const file = path.join(adapter.getBasePath(), this.manifest.dir, "main.js");
    let known;
    try { known = fsSync.statSync(file); } catch (error) { return; }
    let timer = null;
    const listener = (current) => {
      if (!current.size || (current.mtimeMs === known.mtimeMs && current.size === known.size)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        let settled;
        try { settled = fsSync.statSync(file); } catch (error) { return; }
        if (settled.size !== current.size) return;           // ещё пишется — дождёмся следующего опроса
        known = settled;
        if (this.reloadInPlace()) new Notice(this.t("reload.newBuild"));
      }, SETTLE_MS);
    };
    fsSync.watchFile(file, { interval: WATCH_INTERVAL_MS }, listener);
    this.register(() => { clearTimeout(timer); fsSync.unwatchFile(file, listener); });
  }
}

module.exports = { ReloadMethods };

// Восстановление после перезапуска Obsidian: он завершает все процессы во вкладках терминала.
// Плагин помнит, какие сессии были открыты в его вкладках, и после запуска предлагает
// вернуть те, что не живы. Сессия, закрытая, пока Obsidian работал, из списка выпадает сама.
const { ATLAS_ORIGIN, HOST_SOURCE } = require("./constants");

const RESTORE_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// Вкладки агентов после запуска Obsidian поднимают свои сессии сами, за несколько секунд.
// Раньше этого срока список не отдаём: иначе предложили бы вернуть ту, что уже поднимается,
// и над одним транскриптом оказались бы два процесса.
const RESTORE_GRACE_MS = 20000;

const sameIds = (a, b) => a.length === b.length
  && a.every((x, i) => x.session_id === b[i].session_id);

class RestoreMethods {
  /** До первого опроса: что было открыто в прошлый раз — кандидаты, пока не видно, кто жив. */
  initRestore() {
    this.restorable = Array.isArray(this.settings && this.settings.openSessions)
      ? this.settings.openSessions.slice() : [];
    this.restoreChecked = false;
  }

  /** Каждый опрос: живые из кандидатов убираем, открытые во вкладках — запоминаем. */
  async trackOpenSessions(sessions, now = Date.now()) {
    const alive = new Set(sessions.map((s) => s.session_id));
    const fresh = (x) => !this.restoreChecked ? now - (x.at || 0) < RESTORE_MAX_AGE_MS : true;
    this.restorable = (this.restorable || []).filter((x) => !alive.has(x.session_id) && fresh(x));
    this.restoreChecked = true;
    const open = [];
    for (const s of sessions) {
      if (await this.tabForSession(s)) {
        open.push({ session_id: s.session_id, title: String(s.title || "").slice(0, 200), at: now });
      }
    }
    const saved = (this.settings && this.settings.openSessions) || [];
    if (!sameIds(open, saved)) {
      this.settings.openSessions = open;
      await this.saveData(this.settings);
    }
  }

  replyRestorable(target) {
    if (!target || typeof target.postMessage !== "function") return;
    target.postMessage({
      source: HOST_SOURCE,
      type: "restorable",
      ready: !!this.restoreChecked && Date.now() - (this.loadedAt || 0) >= RESTORE_GRACE_MS,
      sessions: (this.restorable || []).map(({ session_id, title, at }) => ({ session_id, title, at })),
    }, ATLAS_ORIGIN);
  }

  /** Восстановили или отказались: забыть этих (или всех, если список не передан). */
  forgetRestorable(ids) {
    const drop = Array.isArray(ids) ? new Set(ids.filter((x) => typeof x === "string")) : null;
    this.restorable = drop ? (this.restorable || []).filter((x) => !drop.has(x.session_id)) : [];
  }
}

module.exports = { RestoreMethods, RESTORE_MAX_AGE_MS, RESTORE_GRACE_MS };

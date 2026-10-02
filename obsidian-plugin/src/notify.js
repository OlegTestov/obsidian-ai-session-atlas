// Уведомления: сессия закончила ход и ждёт тебя. Опрос сервера идёт из плагина, а не со
// страницы: вкладка каталога может быть закрыта или в фоне, а знать хочется сразу.
const { Notice } = require("obsidian");
const http = require("http");
const { ATLAS_PORT, VIEW_TYPE } = require("./constants");
const { translate } = require("./i18n");

const POLL_MS = 10000;
const NOTICE_MS = 10000;
const WORKING = new Set(["busy", "background"]);

const activityOf = (s) => s.activity || s.status || "idle";
// «Ждут тебя» — как на странице: всё, что не работает и не в фоне.
const isWaiting = (s) => !WORKING.has(activityOf(s));

/**
 * Кто начал ждать с прошлого опроса. prev — Map id → activity; новой сессии нет в prev, и
 * уведомлять о ней не надо: она ещё ничего не сделала. Диалог (waiting) — всегда повод.
 */
function waitingTransitions(prev, sessions) {
  const next = new Map();
  const started = [];
  for (const s of sessions || []) {
    if (!s || typeof s.session_id !== "string") continue;
    const now = activityOf(s);
    next.set(s.session_id, now);
    const was = prev.get(s.session_id);
    if (was === undefined || was === now) continue;
    if ((WORKING.has(was) && isWaiting(s)) || now === "waiting") started.push(s);
  }
  const waiting = (sessions || []).filter((s) => s && isWaiting(s)).length;
  return { next, started, waiting };
}

/** t — переводчик плагина; без него — русский, как в тестах и на странице. */
function noticeText(s, t) {
  const tr = t || ((key, vars) => translate("ru", key, vars));
  const title = (s.title || tr("notify.session")).slice(0, 80);
  return tr(activityOf(s) === "waiting" ? "notify.dialog" : "notify.waiting", { title });
}

function windowFocused() {
  try {
    return typeof document.hasFocus === "function" ? document.hasFocus() : true;
  } catch (error) {
    return true;
  }
}

function raiseWindow() {
  try {
    const remote = require("electron").remote;
    const win = remote && remote.getCurrentWindow();
    if (win) { win.show(); win.focus(); }
  } catch (error) {
    // без electron.remote хватит фокуса окна страницы
  }
  if (typeof window.focus === "function") window.focus();
}

function atlasTitle(count) {
  return count ? `Session Atlas (${count})` : "Session Atlas";
}

class NotifyMethods {
  startWatch() {
    this.lastActivity = null;           // null — первого опроса ещё не было
    this.waitingCount = 0;
    this.registerInterval(window.setInterval(() => this.pollActive(), POLL_MS));
    this.pollActive();
  }

  /** Сервер спрашиваем через node http: fetch из Obsidian — чужой origin для сервера. */
  fetchActive(timeout = 8000) {
    return new Promise((resolve) => {
      const request = http.get(
        { host: "127.0.0.1", port: ATLAS_PORT, path: "/api/active", timeout },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            try {
              resolve(response.statusCode === 200 ? JSON.parse(body) : null);
            } catch (error) {
              resolve(null);
            }
          });
        }
      );
      request.on("timeout", () => { request.destroy(); resolve(null); });
      request.on("error", () => resolve(null));
    });
  }

  async pollActive() {
    if (this.polling) return;
    this.polling = true;
    try {
      const data = await this.fetchActive();
      if (!data || !Array.isArray(data.sessions)) return;
      const { next, started, waiting } = waitingTransitions(this.lastActivity || new Map(),
                                                            data.sessions);
      this.lastActivity = next;
      this.setWaitingCount(waiting);
      await this.trackOpenSessions(data.sessions);
      // Первый опрос молчит сам: все сессии для него новые.
      if (this.settings && this.settings.notify) {
        for (const s of started) await this.notifyWaiting(s);
      }
    } finally {
      this.polling = false;
    }
  }

  async notifyWaiting(s) {
    const tab = await this.tabForSession(s);
    const focused = windowFocused();
    // Смотришь прямо на эту вкладку — уведомление только мешает.
    if (focused && tab && this.app.workspace.activeLeaf === tab.leaf) return;
    const go = () => { if (tab) this.actOnTab("focus-tab", tab.pid, s.title || ""); };
    const t = (key, vars) => this.t(key, vars);
    const notice = new Notice(noticeText(s, t) + (tab ? t("notify.click") : ""), NOTICE_MS);
    const box = notice && (notice.noticeEl || notice.containerEl);
    if (tab && box && typeof box.addEventListener === "function") box.addEventListener("click", go);
    // Уведомление Obsidian видно, только если смотришь в его окно, — иначе ещё и системное.
    if (!focused && this.settings && this.settings.systemNotify) this.systemNotify(s, go);
  }

  /** Уведомление macOS: в Electron это обычный Web Notification, клик поднимает Obsidian. */
  systemNotify(s, go) {
    const Native = window.Notification;
    if (typeof Native !== "function" || Native.permission === "denied") return false;
    const text = noticeText(s, (key, vars) => this.t(key, vars));
    const note = new Native("Session Atlas", { body: text.replace(/^Session Atlas: /, "") });
    note.onclick = () => {
      raiseWindow();
      go();
    };
    return true;
  }

  /** Вкладка терминала сессии: процесс claude — потомок PTY своей вкладки. */
  async tabForSession(s) {
    const ancestors = new Set(Array.isArray(s.ancestors) ? s.ancestors : []);
    return (await this.terminalTabs()).find((t) => ancestors.has(t.pid)) || null;
  }

  setWaitingCount(count) {
    this.waitingCount = count;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (typeof leaf.updateHeader === "function") leaf.updateHeader();
      else if (leaf.tabHeaderInnerTitleEl) leaf.tabHeaderInnerTitleEl.textContent = atlasTitle(count);
    }
  }
}

module.exports = { NotifyMethods, waitingTransitions, noticeText, atlasTitle, POLL_MS };

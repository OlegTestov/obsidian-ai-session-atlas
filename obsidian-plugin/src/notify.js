// Notifications: a session finished its turn and waits for you. The plugin polls the server, not
// the page: the catalog tab may be closed or in the background, and the news should arrive at once.
import { Notice } from "obsidian";
import * as electron from "electron";
import * as http from "http";
import { VIEW_TYPE } from "./constants";
import { translate } from "./i18n";
import { codexScreenState } from "./dialog-codex";

const POLL_MS = 10000;
// How long a notice stays: seconds, or "sticky" — until you click or close it.
const NOTICE_HOLDS = ["10", "30", "60", "sticky"];
const DEFAULT_NOTICE_HOLD = "10";
// Sticky notices stack up; past this many the oldest goes, so the column never fills the window.
const MAX_NOTICES = 5;
const WORKING = new Set(["busy", "background"]);

const activityOf = (s) => s.activity || s.status || "idle";
// "Waiting for you", as on the page: everything that is neither working nor in the background.
const isWaiting = (s) => !WORKING.has(activityOf(s));

/**
 * Who started waiting since the last poll. prev is a Map id → activity; a new session is not in
 * prev and needs no notification: it has done nothing yet. A dialog (waiting) always counts.
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

/** t is the plugin's translator; without it the text is Russian. */
function noticeText(s, t) {
  const tr = t || ((key, vars) => translate("ru", key, vars));
  const title = (s.title || tr("notify.session")).slice(0, 80);
  return tr(activityOf(s) === "waiting" ? "notify.dialog" : "notify.waiting", { title });
}

/** Milliseconds for Obsidian's Notice: 0 keeps it until it is clicked or closed. */
function noticeDuration(hold) {
  const value = NOTICE_HOLDS.includes(String(hold)) ? String(hold) : DEFAULT_NOTICE_HOLD;
  return value === "sticky" ? 0 : Number(value) * 1000;
}

function windowFocused() {
  try {
    return typeof document.hasFocus === "function" ? document.hasFocus() : true;
  } catch {
    return true;
  }
}

function raiseWindow() {
  try {
    const remote = electron.remote;
    const win = remote && remote.getCurrentWindow();
    if (win) { win.show(); win.focus(); }
  } catch {
    // without electron.remote, focusing the page window is enough
  }
  if (typeof window.focus === "function") window.focus();
}

function atlasTitle(count) {
  return count ? `AI Session Atlas (${count})` : "AI Session Atlas";
}

class NotifyMethods {
  startWatch() {
    this.lastActivity = null;           // null: no poll yet
    this.waitingCount = 0;
    this.openNotices = new Map();       // session id → its notice on screen
    this.registerInterval(window.setInterval(() => this.pollActive(), POLL_MS));
    this.pollActive();
  }

  /** The server is asked through node http: a fetch from Obsidian is a foreign origin to the server. */
  fetchActive(timeout = 8000) {
    return new Promise((resolve) => {
      const request = http.get(
        { host: "127.0.0.1", port: this.atlasPort(), path: "/api/active", timeout },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            try {
              resolve(response.statusCode === 200 ? JSON.parse(body) : null);
            } catch {
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
      this.offerHeldTabs();             // a placeholder tab closed before it loaded leaves its process held
      const data = await this.fetchActive();
      if (!data || !Array.isArray(data.sessions)) return;
      const sessions = await this.withCodexScreens(data.sessions);
      const { next, started, waiting } = waitingTransitions(this.lastActivity || new Map(), sessions);
      this.lastActivity = next;
      this.setWaitingCount(waiting);
      this.dropStaleNotices(sessions);
      await this.trackOpenSessions(sessions);
      // The first poll stays silent by itself: every session is new to it.
      if (this.settings && this.settings.notify) {
        for (const s of started) await this.notifyWaiting(s);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Codex keeps no approval in its rollout, so the server sees a waiting Codex session as busy or
   * idle. When its tab shows an approval, question or choice, the session waits for you.
   */
  async withCodexScreens(sessions) {
    if (!sessions.some((s) => s && s.agent === "codex")) return sessions;
    const out = [];
    for (const s of sessions) {
      const tab = s && s.agent === "codex" ? await this.tabForSession(s) : null;
      const waiting = tab && codexScreenState(this.screenLines(tab.leaf)) === "waiting";
      out.push(waiting ? { ...s, status: "waiting", activity: "waiting" } : s);
    }
    return out;
  }

  async notifyWaiting(s) {
    const tab = await this.tabForSession(s);
    const focused = windowFocused();
    // You are looking right at this tab: a notification would only get in the way.
    if (focused && tab && this.activeLeaf() === tab.leaf) return;
    const go = () => { if (tab) this.actOnTab("focus-tab", tab.pid, s.title || ""); };
    const t = (key, vars) => this.t(key, vars);
    const hold = this.settings && this.settings.noticeHold;
    const notice = new Notice(noticeText(s, t) + (tab ? t("notify.click") : ""), noticeDuration(hold));
    this.keepNotice(s.session_id, notice);
    const box = notice && notice.containerEl;   // the whole notice, since Obsidian 1.8.7
    if (box && typeof box.createEl === "function") {
      box.addClass("session-atlas-notice");
      const close = box.createEl("button", { cls: "session-atlas-notice-close", text: "×" });
      close.setAttribute("aria-label", t("notify.close"));
      close.addEventListener("click", (event) => {
        event.stopPropagation();      // closing is not a request to open the tab
        this.hideNotice(s.session_id, notice);
      });
    }
    if (tab && box && typeof box.addEventListener === "function") box.addEventListener("click", go);
    // An Obsidian notice is visible only in its own window; otherwise a system one is shown too.
    if (!focused && this.settings && this.settings.systemNotify) this.systemNotify(s, go);
  }

  /** One notice per session: a newer one replaces it; the oldest goes past MAX_NOTICES. */
  keepNotice(id, notice) {
    if (!this.openNotices) this.openNotices = new Map();
    // A click or a timeout already took some off the screen; they no longer count.
    for (const [key, shown] of [...this.openNotices]) {
      const el = shown && shown.containerEl;
      if (el && el.isConnected === false) this.openNotices.delete(key);
    }
    const old = this.openNotices.get(id);
    if (old) this.hideNotice(id, old);
    this.openNotices.set(id, notice);
    while (this.openNotices.size > MAX_NOTICES) {
      const [oldestId, oldest] = this.openNotices.entries().next().value;
      this.hideNotice(oldestId, oldest);
    }
  }

  hideNotice(id, notice) {
    if (this.openNotices && this.openNotices.get(id) === notice) this.openNotices.delete(id);
    try {
      if (notice && typeof notice.hide === "function") notice.hide();
    } catch {
      // already gone from the screen
    }
  }

  /** A notice that is no longer true goes away: the session works again or has closed. */
  dropStaleNotices(sessions) {
    if (!this.openNotices || !this.openNotices.size) return;
    const waiting = new Set(sessions.filter((s) => s && isWaiting(s)).map((s) => s.session_id));
    for (const [id, notice] of [...this.openNotices]) {
      if (!waiting.has(id)) this.hideNotice(id, notice);
    }
  }

  /** A macOS notification: a plain Web Notification in Electron; a click raises Obsidian. */
  systemNotify(s, go) {
    const Native = window.Notification;
    if (typeof Native !== "function" || Native.permission === "denied") return false;
    const text = noticeText(s, (key, vars) => this.t(key, vars));
    const note = new Native("AI Session Atlas", { body: text.replace(/^AI Session Atlas: /, "") });
    note.onclick = () => {
      raiseWindow();
      go();
    };
    return true;
  }

  /** The session's terminal tab: the agent process descends from its tab's PTY. */
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

export { NotifyMethods, waitingTransitions, noticeText, noticeDuration, atlasTitle, POLL_MS, NOTICE_HOLDS,
         DEFAULT_NOTICE_HOLD, MAX_NOTICES };

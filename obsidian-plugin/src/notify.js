// Notifications: a session finished its turn and waits for you. The plugin polls the server, not
// the page: the catalog tab may be closed or in the background, and the news should arrive at once.
import { Notice } from "obsidian";
import * as electron from "electron";
import * as http from "http";
import { VIEW_TYPE } from "./constants";
import { translate } from "./i18n";

const POLL_MS = 10000;
const NOTICE_MS = 10000;
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
  return count ? `Session Atlas (${count})` : "Session Atlas";
}

class NotifyMethods {
  startWatch() {
    this.lastActivity = null;           // null: no poll yet
    this.waitingCount = 0;
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
      const data = await this.fetchActive();
      if (!data || !Array.isArray(data.sessions)) return;
      const { next, started, waiting } = waitingTransitions(this.lastActivity || new Map(),
                                                            data.sessions);
      this.lastActivity = next;
      this.setWaitingCount(waiting);
      await this.trackOpenSessions(data.sessions);
      // The first poll stays silent by itself: every session is new to it.
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
    // You are looking right at this tab: a notification would only get in the way.
    if (focused && tab && this.activeLeaf() === tab.leaf) return;
    const go = () => { if (tab) this.actOnTab("focus-tab", tab.pid, s.title || ""); };
    const t = (key, vars) => this.t(key, vars);
    const notice = new Notice(noticeText(s, t) + (tab ? t("notify.click") : ""), NOTICE_MS);
    const box = notice && (notice.noticeEl || notice.containerEl);
    if (tab && box && typeof box.addEventListener === "function") box.addEventListener("click", go);
    // An Obsidian notice is visible only in its own window; otherwise a system one is shown too.
    if (!focused && this.settings && this.settings.systemNotify) this.systemNotify(s, go);
  }

  /** A macOS notification: a plain Web Notification in Electron; a click raises Obsidian. */
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

  /** The session's terminal tab: the claude process descends from its tab's PTY. */
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

export { NotifyMethods, waitingTransitions, noticeText, atlasTitle, POLL_MS };

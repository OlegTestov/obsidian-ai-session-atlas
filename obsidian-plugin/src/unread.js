// Unread marks: a session finished its turn while you were not looking at its tab. The plugin keeps
// them, not the page: it polls even while the Atlas tab is closed, and the page asks for them with the tabs.
// "Looking" is remembered per session as a time, so a turn you watched end is not marked by a later poll.
import { VIEW_TYPE } from "./constants";

const WORKING = new Set(["busy", "background"]);
const activityOf = (s) => s.activity || s.status || "idle";
const SESSION_ID = /^[\w-]{1,80}$/;
const CLICK_MAX_AGE_MS = 60_000;          // a click time older than this from the page is not trusted

/**
 * The next set of unread session ids. Sessions that closed or work again lose their mark; sessions that
 * just started waiting (`started`, from waitingTransitions) get one unless you saw them (`seenIds`).
 */
function nextUnread(unread, sessions, started, seenIds) {
  const waiting = new Set();
  for (const s of sessions || []) {
    if (s && typeof s.session_id === "string" && !WORKING.has(activityOf(s))) waiting.add(s.session_id);
  }
  const next = new Set([...(unread || [])].filter((id) => waiting.has(id)));
  for (const s of started || []) {
    if (s && waiting.has(s.session_id) && !(seenIds && seenIds.has(s.session_id))) next.add(s.session_id);
  }
  return next;
}

/**
 * You saw the session after its turn ended: `seenAt` is when you last had it in view (ms). A finished turn
 * ends at its last message (no time: the previous poll, `since`). A dialog opens from a tool call, which
 * moves no message time, so it ends at its status change; without one (Codex, read from the screen) only
 * having it in view at this poll (`now`) counts: a missed dialog is worse than a needless mark.
 */
function endOf(s, since, now) {
  const message = Date.parse(s.last_message_at);
  let ended = Number.isFinite(message) ? message : since;
  if (activityOf(s) === "waiting") {
    const status = Date.parse(s.status_at);
    ended = Math.max(ended, Number.isFinite(status) ? status : now);
  }
  return ended;
}

function seenAfterEnd(seenAt, s, since, now) {
  if (seenAt === undefined || !s) return false;
  return seenAt >= endOf(s, since, now);
}

/** When the session's current stop began by its own times (NaN without them). */
function stopTime(s) {
  const times = [Date.parse(s.last_message_at)];
  if (activityOf(s) === "waiting") times.push(Date.parse(s.status_at));
  const known = times.filter(Number.isFinite);
  return known.length ? Math.max(...known) : NaN;
}

/** The click time the page sent, if it is a sane recent time; otherwise when the message came. */
function clickTime(at, now) {
  return typeof at === "number" && Number.isFinite(at) && at <= now && at > now - CLICK_MAX_AGE_MS ? at : now;
}

/** Session ids a page sent as seen: strings of the id shape only, at most 200. */
function seenFromPage(ids) {
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && SESSION_ID.test(id)).slice(0, 200) : [];
}

/** The leaf's own window has focus: a tab may live in a popout window, not only the main one. */
function leafFocused(leaf) {
  try {
    const doc = (leaf && leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument) || document;
    return typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
  } catch {
    return true;
  }
}

class UnreadMethods {
  watchUnread() {
    this.unread = new Set();
    this.seenAt = new Map();          // session id → when you last had it in view
    this.leafSessions = new Map();    // tab leaf → ids of the sessions in it, as of the last poll
    this.unreadEnd = new Map();       // marked id → when the turn it is marked for ended
    this.lastStop = new Map();        // id → stopTime at the last poll, for stops no transition shows
    this.frontLeaf = null;            // the active leaf while its window has focus
    this.lastUnreadPoll = Date.now();
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.frontChanged(leaf)));
    this.watchWindow(window);
    this.registerEvent(this.app.workspace.on("window-open", (win) => this.watchWindow(win && win.win)));
  }

  watchWindow(win) {
    if (!win) return;
    this.registerDomEvent(win, "focus", () => this.frontChanged(this.activeLeaf()));
    this.registerDomEvent(win, "blur", () => this.frontChanged(null));
  }

  /** The leaf in front changed: the one leaving was in view until now, the one coming is in view from now. */
  frontChanged(leaf) {
    const now = Date.now();
    this.creditLeaf(this.frontLeaf, now);
    this.frontLeaf = leaf && leafFocused(leaf) ? leaf : null;
    this.creditLeaf(this.frontLeaf, now);
  }

  creditLeaf(leaf, now) {
    if (!leaf || !this.leafSessions) return;
    for (const id of this.leafSessions.get(leaf) || []) {
      this.seenAt.set(id, now);
      this.unread.delete(id);
    }
  }

  async updateUnread(sessions, started) {
    if (!this.unread || !this.seenAt) return;          // watchUnread has not run
    if (!this.lastStop) this.lastStop = new Map();
    if (!this.unreadEnd) this.unreadEnd = new Map();
    const tabs = await this.terminalTabs();            // one snapshot: a slow tab is waited for once
    const now = Date.now();
    const leafSessions = new Map();
    for (const s of sessions) {
      const ancestors = new Set(Array.isArray(s.ancestors) ? s.ancestors : []);
      const tab = tabs.find((t) => ancestors.has(t.pid));
      if (!tab) continue;
      if (!leafSessions.has(tab.leaf)) leafSessions.set(tab.leaf, []);
      leafSessions.get(tab.leaf).push(s.session_id);
    }
    this.leafSessions = leafSessions;
    const front = this.activeLeaf();
    this.frontLeaf = front && leafFocused(front) ? front : null;
    this.creditLeaf(this.frontLeaf, now);               // in view right now
    const since = this.lastUnreadPoll;
    this.lastUnreadPoll = now;
    // A stop between two polls with the same state (a second dialog, a short turn) is no transition:
    // the session's own stop time moving forward shows it.
    const stopped = [...started];
    const named = new Set(started.map((s) => s.session_id));
    const stops = new Map();
    for (const s of sessions) {
      if (!s || typeof s.session_id !== "string" || WORKING.has(activityOf(s))) continue;
      const stop = stopTime(s);
      if (!Number.isFinite(stop)) continue;
      stops.set(s.session_id, stop);
      const was = this.lastStop.get(s.session_id);
      if (was !== undefined && stop > was && !named.has(s.session_id)) stopped.push(s);
    }
    this.lastStop = stops;
    const seen = new Set(stopped.filter((s) => seenAfterEnd(this.seenAt.get(s.session_id), s, since, now))
      .map((s) => s.session_id));
    const before = this.unread;
    this.unread = nextUnread(before, sessions, stopped, seen);
    for (const s of stopped) {
      if (this.unread.has(s.session_id) && !before.has(s.session_id)) this.unreadEnd.set(s.session_id, endOf(s, since, now));
    }
    for (const id of [...this.unreadEnd.keys()]) if (!this.unread.has(id)) this.unreadEnd.delete(id);
    const alive = new Set(sessions.map((s) => s.session_id));
    for (const id of [...this.seenAt.keys()]) if (!alive.has(id)) this.seenAt.delete(id);
  }

  /**
   * The page reports cards you opened, with the time of the click (a held click arrives up to 5 s later).
   * A click before the marked turn ended does not clear it. True when a mark went.
   */
  markSeen(data) {
    if (!this.unread || !this.seenAt) return false;
    const at = clickTime(data && data.at, Date.now());
    let changed = false;
    for (const id of seenFromPage(data && data.ids)) {
      this.seenAt.set(id, Math.max(this.seenAt.get(id) || 0, at));
      const end = this.unreadEnd && this.unreadEnd.get(id);
      if (this.unread.has(id) && !(end > at)) {
        this.unread.delete(id);
        if (this.unreadEnd) this.unreadEnd.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The Atlas tab of the page that asks (`target`, its window) is the active leaf and its window has
   * focus. A hint only: the tab list goes out regardless.
   */
  atlasInFront(target) {
    try {
      const leaf = this.activeLeaf();
      return !!leaf && !!leaf.view && typeof leaf.view.getViewType === "function"
        && leaf.view.getViewType() === VIEW_TYPE && !!leaf.view.frame && !!target
        && leaf.view.frame.contentWindow === target && leafFocused(leaf);
    } catch {
      return false;
    }
  }

  unreadIds() {
    return [...(this.unread || [])];
  }
}

export { UnreadMethods, nextUnread, seenAfterEnd, seenFromPage, leafFocused };

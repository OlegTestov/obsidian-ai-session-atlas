// Restore after an Obsidian restart, which ends every process in terminal tabs. The plugin remembers
// which sessions were open in its tabs and, after start, offers to bring back those that are not
// alive. A session closed while Obsidian was running drops off the list by itself.
import { HOST_SOURCE } from "./constants";

const RESTORE_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// After Obsidian starts, agent tabs bring their sessions back themselves within a few seconds.
// The list is not served before this delay: it would offer a session that is already coming back,
// and two processes would end up on one transcript.
const RESTORE_GRACE_MS = 20000;

const sameIds = (a, b) => a.length === b.length
  && a.every((x, i) => x.session_id === b[i].session_id);

class RestoreMethods {
  /** Before the first poll: what was open last time are candidates until it is clear which are alive. */
  initRestore() {
    this.restorable = Array.isArray(this.settings && this.settings.openSessions)
      ? this.settings.openSessions.slice() : [];
    this.restoreChecked = false;
  }

  /** Every poll: live candidates are dropped, sessions open in tabs are remembered. */
  async trackOpenSessions(sessions, now = Date.now()) {
    const alive = new Set(sessions.map((s) => s.session_id));
    const fresh = (x) => !this.restoreChecked ? now - (x.at || 0) < RESTORE_MAX_AGE_MS : true;
    this.restorable = (this.restorable || []).filter((x) => !alive.has(x.session_id) && fresh(x));
    this.restoreChecked = true;
    const open = [];
    for (const s of sessions) {
      // A process held without a tab (the plugin was toggled) is still ours: an Obsidian restart
      // would end it, and it must be offered back like an open tab.
      if ((await this.tabForSession(s)) || this.heldForSession(s)) {
        open.push({ session_id: s.session_id, title: String(s.title || "").slice(0, 200), at: now,
                    agent: s.agent === "codex" ? "codex" : "claude" });
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
      sessions: (this.restorable || []).map(({ session_id, title, at, agent }) =>
        ({ session_id, title, at, agent: agent || "claude" })),
    }, this.atlasOrigin());
  }

  /** Restored or declined: forget these (or all, when no list is passed). */
  forgetRestorable(ids) {
    const drop = Array.isArray(ids) ? new Set(ids.filter((x) => typeof x === "string")) : null;
    this.restorable = drop ? (this.restorable || []).filter((x) => !drop.has(x.session_id)) : [];
  }
}

export { RestoreMethods, RESTORE_MAX_AGE_MS, RESTORE_GRACE_MS };

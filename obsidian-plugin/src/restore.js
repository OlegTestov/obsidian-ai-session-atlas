// Restore after an Obsidian restart, which ends every process in terminal tabs. The plugin remembers
// which sessions were open in its tabs and, after start, offers to bring back those that are not
// alive. A session closed while Obsidian was running drops off the list by itself.
import { HOST_SOURCE } from "./constants";
import { restoreAgent } from "./agents";
import { validId } from "./agent-registry";

const RESTORE_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// After Obsidian starts, agent tabs bring their sessions back themselves within a few seconds.
// The list is not served before this delay: it would offer a session that is already coming back,
// and two processes would end up on one transcript.
const RESTORE_GRACE_MS = 20000;

const sameIds = (a, b) => a.length === b.length
  && a.every((x, i) => x.session_id === b[i].session_id
    && (x.agent ?? "claude") === (b[i].agent ?? "claude"));
const restoreKey = row => `${row.agent ?? "claude"}:${row.session_id}`;

class RestoreMethods {
  /** Before the first poll: what was open last time are candidates until it is clear which are alive. */
  initRestore() {
    this.restorable = Array.isArray(this.settings && this.settings.openSessions)
      ? this.settings.openSessions.filter(row => restoreAgent(row.agent ?? "claude")) : [];
    this.restorePending = new Set(this.restorable.filter(row =>
      row.agent === "codex" && validId("codex", row.session_id)));
    this.restoreChecked = false;
  }

  /** Every poll: live candidates are dropped, sessions open in tabs are remembered. */
  async trackOpenSessions(sessions, now = Date.now()) {
    const alive = new Set(sessions.map(restoreKey));
    const fresh = (x) => !this.restoreChecked ? now - (x.at || 0) < RESTORE_MAX_AGE_MS : true;
    this.restorable = (this.restorable || []).filter(x => !alive.has(restoreKey(x)) && fresh(x));
    if (this.restorePending?.size) await this.resolveRestoreCandidates(alive);
    this.restoreChecked = true;
    const open = [];
    for (const s of sessions) {
      const agent = s.agent ?? "claude";
      if (!restoreAgent(agent)) continue;
      // A process held without a tab (the plugin was toggled) is still ours: an Obsidian restart
      // would end it, and it must be offered back like an open tab.
      if ((await this.tabForSession(s)) || this.heldForSession(s)) {
        open.push({ session_id: s.session_id, title: String(s.title || "").slice(0, 200), at: now,
                    agent });
      }
    }
    const saved = (this.settings && this.settings.openSessions) || [];
    if (!sameIds(open, saved)) {
      this.settings.openSessions = open;
      await this.saveData(this.settings);
    }
  }

  async resolveRestoreCandidates(alive) {
    const pending = this.restorePending;
    const rows = this.restorable.filter(row => pending.has(row));
    const answers = new Map(await Promise.all(rows.map(async row =>
      [row, await this.fetchAtlasJson("/api/restore/codex/" + encodeURIComponent(row.session_id))])));
    const candidates = new Map();
    this.restorePending = new Set();
    for (const row of this.restorable) {
      const result = answers.get(row);
      let candidate = row;
      if (result) {
        if (!result.session_id) continue;       // an orphaned child cannot be resumed
        candidate = { ...row, session_id: result.session_id, title: result.title || row.title };
      } else if (pending.has(row)) {
        this.restorePending.add(row);          // the server was unavailable, retry on the next poll
      }
      const key = restoreKey(candidate);
      if (!alive.has(key) && (!candidates.has(key) || result?.title)) candidates.set(key, candidate);
    }
    this.restorable = [...candidates.values()];
  }

  replyRestorable(target) {
    if (!target || typeof target.postMessage !== "function") return;
    target.postMessage({
      source: HOST_SOURCE,
      type: "restorable",
      ready: !!this.restoreChecked && Date.now() - (this.loadedAt || 0) >= RESTORE_GRACE_MS,
      sessions: (this.restorable || []).filter(row => !this.restorePending?.has(row))
        .map(({ session_id, title, at, agent }) =>
        ({ session_id, title, at, agent: agent ?? "claude" })),
    }, this.atlasOrigin());
  }

  /** Restored or declined: forget these (or all, when no list is passed). */
  forgetRestorable(ids) {
    const drop = Array.isArray(ids) ? new Set(ids.filter((x) => typeof x === "string")) : null;
    this.restorable = drop ? (this.restorable || []).filter((x) => !drop.has(x.session_id)) : [];
  }
}

export { RestoreMethods, RESTORE_MAX_AGE_MS, RESTORE_GRACE_MS };

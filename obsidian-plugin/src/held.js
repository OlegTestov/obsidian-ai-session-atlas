// Terminal processes held across a plugin reload. The window-wide registry survives the plugin: a quiet
// reload keeps the tabs, and the new copy picks their processes up by tab id. The settings toggle
// closes the tabs instead, so after it is turned back on the processes have no tab: they are
// offered back (catalog banner, the card's Go to, a notice) and held until the user decides.
import { Notice } from "obsidian";
import { AGENT_VIEW_TYPE } from "./constants";

// Time for the new plugin copy to load and pick its tabs up; after that an unclaimed process ends.
const RECLAIM_MS = 120000;
// While offered, a process waits this long for an answer: long enough to notice, short enough that
// a forgotten agent does not keep working out of sight.
const OFFER_HOLD_MS = 30 * 60 * 1000;
const HELD_NOTICE_MS = 15000;

function registry() {
  if (!window.__sessionAtlasPtys) {
    window.__sessionAtlasPtys = new Map();
    // Quitting Obsidian ends them all: otherwise the tabs would start second processes on the next launch.
    window.addEventListener("beforeunload", () => {
      for (const { pty } of window.__sessionAtlasPtys.values()) pty.kill();
    });
  }
  return window.__sessionAtlasPtys;
}

/** Tab ids still in the layout. The saved view state, not the view: a leaf can hold a placeholder. */
function wantedTabs(workspace) {
  const wanted = new Set();
  if (!workspace || typeof workspace.iterateAllLeaves !== "function") return null;
  workspace.iterateAllLeaves((leaf) => {
    const state = leaf.getViewState && leaf.getViewState();
    if (state && state.type === AGENT_VIEW_TYPE && state.state && state.state.instance) wanted.add(state.state.instance);
  });
  return wanted;
}

/** A tab closed by the plugin's unload: its process waits RECLAIM_MS for the next plugin copy. */
function holdForReclaim(key, pty, state) {
  pty.onData(null);
  pty.onExit(null);
  const timer = window.setTimeout(() => releaseHeld(key), RECLAIM_MS);
  registry().set(key, { pty, timer, state: Object.assign({}, state), held: true });
}

/**
 * After a reload, keep every held process whose tab is still in the layout. Background tabs load
 * only when shown, so the reclaim timer would otherwise end their agents while nobody looks.
 * Output keeps going into the process's buffer until the tab opens. Returns the kept tab ids.
 */
function keepHeldTabs(workspace) {
  const wanted = wantedTabs(workspace);
  if (!wanted) return [];
  const kept = [];
  for (const [key, held] of registry()) {
    if (!wanted.has(key) || !held.timer) continue;
    window.clearTimeout(held.timer);
    held.timer = null;
    kept.push(key);
  }
  return kept;
}

/**
 * Held processes with no tab in the layout, still alive. Each is held OFFER_HOLD_MS from the
 * moment it is first offered, instead of the short reclaim time. Exited ones are forgotten.
 */
function offerHeld(workspace, now = Date.now()) {
  const wanted = wantedTabs(workspace);
  if (!wanted) return [];
  const out = [];
  for (const [key, held] of [...registry()]) {
    adoptLegacy(key, held);
    if (!held.held || wanted.has(key)) continue;
    if (held.pty.exited) { releaseHeld(key); continue; }
    if (!held.offeredAt) {
      window.clearTimeout(held.timer);
      held.offeredAt = now;
      held.timer = window.setTimeout(() => releaseHeld(key), OFFER_HOLD_MS);
    }
    out.push({ key, pty: held.pty, state: held.state || {} });
  }
  return out;
}

/**
 * An entry left by a plugin version before 2.2 (an update or a toggle from it): {pty, timer} with a
 * pending reclaim timer means held, and its tab state is rebuilt from the tab id (`claude-…`, `codex-…`).
 */
function adoptLegacy(key, held) {
  if (held.held !== undefined || !held.timer || !held.pty) return;
  const kind = /^(claude|codex)-/.exec(key);
  held.held = true;
  held.state = held.state || { kind: kind ? kind[1] : "shell", instance: kind ? key : null,
                               title: kind ? (kind[1] === "codex" ? "Codex" : "Claude Code") : "Terminal" };
}

/** Ends a held process; a process attached to a tab is not touched. */
function releaseHeld(key) {
  const held = registry().get(key);
  if (!held || !held.held) return false;
  window.clearTimeout(held.timer);
  registry().delete(key);
  held.pty.kill();
  return true;
}

class HeldMethods {
  /** Processes without a tab, as the page sees them: PTY pid and the tab's title. */
  heldTabs() {
    return offerHeld(this.app && this.app.workspace).map(({ key, pty, state }) => ({
      key, ptyPid: pty.pid, title: String(state.title || "Terminal").slice(0, 200),
      agent: state.kind === "codex" ? "codex" : state.kind === "shell" ? "shell" : "claude",
    }));
  }

  heldForSession(s) {
    const ancestors = new Set(Array.isArray(s && s.ancestors) ? s.ancestors : []);
    return this.heldTabs().find((h) => ancestors.has(h.ptyPid)) || null;
  }

  /** Called at load and every poll: new held processes get a notice; the catalog shows a banner. */
  offerHeldTabs() {
    const held = this.heldTabs();
    const keys = new Set(held.map((h) => h.key));
    const fresh = held.filter((h) => !(this.heldNoticed || new Set()).has(h.key));
    this.heldNoticed = keys;
    if (fresh.length) {
      const notice = new Notice(this.t("held.notice", { n: held.length }), HELD_NOTICE_MS);
      const box = notice && notice.containerEl;
      if (box && typeof box.addEventListener === "function") {
        box.addEventListener("click", () => this.reattachHeld(held.map((h) => h.ptyPid)));
      }
    }
    return held;
  }

  /**
   * Opens a tab on each held process: the same process, the agent is not restarted. A process that
   * ended meanwhile is gone from the list, and nothing opens for it.
   */
  async reattachHeld(ptyPids) {
    const wanted = new Set(ptyPids);
    const held = this.heldTabs().filter((h) => wanted.has(h.ptyPid));
    let first = null;
    for (const h of held) {
      const entry = registry().get(h.key);
      if (!entry) continue;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: AGENT_VIEW_TYPE, active: !first,
                                state: Object.assign({}, entry.state, { focus: !first }) });
      if (!first) first = leaf;
    }
    if (first) this.app.workspace.revealLeaf(first);
    return held.length;
  }

  releaseHeldTabs(ptyPids) {
    const wanted = new Set(ptyPids);
    let ended = 0;
    for (const h of this.heldTabs()) if (wanted.has(h.ptyPid) && releaseHeld(h.key)) ended++;
    return ended;
  }
}

export { HeldMethods, registry, keepHeldTabs, holdForReclaim, offerHeld, releaseHeld, adoptLegacy, RECLAIM_MS, OFFER_HOLD_MS };

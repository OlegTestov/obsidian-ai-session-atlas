// Active: state, server polling and the link to the Obsidian plugin.
// Classic script: shares one global scope with the other page files.
/* exported hostHealth, activeUpdated, activeLimits, activeCodexLimits, ACTIVE_FILTERS, PERIODS -- used by other page scripts */
/* exported activeFilter, filterUI, layout, LAYOUT_MAX, LAYOUT_CELLS, layoutUI -- used by other page scripts */
/* exported fullReplies, SEND_TIMEOUT_MS, MAX_ATTACH, lastSignature, composing -- used by other page scripts */
/* exported lastRenderAt, fmtShort, tellTabHost, tabFor, heldFor, hostHeld -- used by other page scripts */
// --- Active tab --------------------------------------------------------------

const ACTIVE_POLL_MS = 5000;
const HOST_SOURCE = "session-atlas-host";
let activeSessions = [];
let activeRaw = [];             // sessions as the server sent them; activeSessions adds tab screens
let hostScreens = new Map();    // PTY proxy PID → screen state of a Codex tab (waiting | busy | idle)
let hostTabs = new Map();       // PTY proxy PID → terminal tab title
let hostHeld = new Map();       // PTY proxy PID → title: the tab closed with the plugin, the process runs
let hostReady = false;          // the plugin answered, so Go to and Close are available
let hostHealth = null;          // {ok, reason} from the plugin: whether the terminal link works
let tabsAskedAt = null;         // when the tabs were requested and no answer has come yet
let activeTimer = null;
let activeUpdated = null;
let activeLimits = null;        // subscription limits from the Claude Code status line
let activeCodexLimits = null;   // Codex limits: from Codex itself or its newest token count

// Active filters: each list allows several values, as in Excel.
const ACTIVE_FILTERS = [
  { key:"domain", label:i18n("active.filter.domain"), hash:"ad" },
  { key:"project", label:i18n("active.filter.project"), hash:"ap" },
  { key:"topic", label:i18n("active.filter.topic"), hash:"at" },
  { key:"period", label:i18n("active.filter.period"), hash:"aw" },
];
const PERIODS = AtlasLogic.PERIODS;
const activeFilter = { domain:new Set(), project:new Set(), topic:new Set(), period:new Set() };
const filterUI = {};
let activeMode = "compact";           // compact | full
// Columns × rows layout, per view; null means auto.
const layout = { compact: null, full: null };
// Compact cards are small, so up to 5 × 5; detailed ones with a reply field up to 4 × 4.
const LAYOUT_MAX = { compact: 5, full: 4 };
const LAYOUT_CELLS = 5;
let layoutUI = null;
const drafts = new Map();             // session id → unfinished reply: survives a poll
const fullReplies = new Map();        // session id → the full reply, if expanded
const sendState = new Map();          // session id → {note, cls}
const pendingSends = new Map();       // nonce → session id
const SEND_TIMEOUT_MS = 6000;
const sentDrafts = new Map();         // nonce → what exactly was sent
const attachments = new Map();        // session id → [{path, thumb}]: images for the reply
// Just sent: the transcript catches up in seconds, but you want to see your message at once.
const justSent = new Map();           // session id → {text, images, at}
const MAX_ATTACH = 5;
let lastSignature = "";
let composing = false;                // IME composition in progress
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => { composing = false; });
let lastRenderAt = 0;

// Short date for the card: the year only when it is not the current one.
function fmtShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const opts = { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "2-digit";
  return d.toLocaleString(I18N.locale(), opts);
}

// Tab buttons only while the plugin is connected: outside Obsidian they have no target.
function tellTabHost(type, payload) {
  if (!hostReady) return false;
  window.parent.postMessage(Object.assign({ source: "session-atlas", type }, payload), "*");
  return true;
}

// The Atlas tab is on screen again (the plugin reports it; outside Obsidian, page visibility).
function backOnScreen() {
  if (state.view !== "active") return;
  resortActive();
  rerenderOrder();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) backOnScreen(); });

window.addEventListener("message", e => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (d && d.source === HOST_SOURCE && d.type === "shown") { backOnScreen(); return; }
  if (d && d.source === HOST_SOURCE && d.type === "sent" && pendingSends.has(d.nonce)) {
    const sid = pendingSends.get(d.nonce);
    pendingSends.delete(d.nonce);
    const draft = sentDrafts.get(d.nonce);
    sentDrafts.delete(d.nonce);
    if (d.ok) {
      if (draft) justSent.set(sid, Object.assign({ at: new Date().toISOString() }, draft));
      if (draft) rememberSent(draft.text);
      drafts.delete(sid);
      saveDrafts();
      attachments.delete(sid);
      renderThumbs(sid);
      // No "sent" label: your message in the card shows the send.
      setSendNote(sid, "", "", true);
      sendState.delete(sid);
      lastSignature = "";                  // show the sent message at once, without waiting for changes
      renderActive(null, true);
      window.setTimeout(loadActive, 1500);        // the status turns to "working"
    } else {
      setSendNote(sid, i18n("active.notSent", { reason: d.reason || i18n("active.errorWord") }), "bad");
    }
    return;
  }
  if (d && d.source === HOST_SOURCE
      && (handleDialogMessage(d) || handleStopMessage(d) || handleRestoreMessage(d)
          || handleCommandOutput(d))) return;
  if (!d || d.source !== HOST_SOURCE || d.type !== "tabs" || !Array.isArray(d.tabs)) return;
  hostTabs = new Map(d.tabs.filter(t => t && Number.isInteger(t.ptyPid))
    .map(t => [t.ptyPid, String(t.title || "")]));
  hostScreens = new Map(d.tabs.filter(t => t && Number.isInteger(t.ptyPid) && t.agent === "codex")
    .map(t => [t.ptyPid, typeof t.screen === "string" ? t.screen : null]));
  hostHeld = new Map((Array.isArray(d.held) ? d.held : []).filter(t => t && Number.isInteger(t.ptyPid))
    .map(t => [t.ptyPid, String(t.title || "")]));
  activeSessions = screenSessions();
  hostReady = true;
  tabsAskedAt = null;
  // Plugins before Codex launches send no agents: Claude Code only.
  hostAgents = d.agents && typeof d.agents === "object"
    ? { claude: d.agents.claude !== false, codex: d.agents.codex === true } : null;
  if ($("#newsess").open) fillNewSessionAgents();
  refreshResumeWith();
  // Plugins before 1.5 send no reason: an answer means the link works.
  hostHealth = d.health && typeof d.health === "object"
    ? { ok: !!d.health.ok, reason: typeof d.health.reason === "string" ? d.health.reason : null }
    : { ok: true, reason: null };
  requestDialogs();                      // tabs are known, so the dialogs of waiting sessions can be read
  requestRestorable();                   // and ask what the Obsidian restart closed
  renderRestoreBanner();                 // tabs closed with the plugin are offered back at once
  renderActive();
});

// A Codex session whose tab shows a prompt waits for you: only the screen knows it.
function screenSessions() {
  return activeRaw.map(s => {
    const pid = tabFor(s);
    return withTabScreen(s, pid ? hostScreens.get(pid) : null);
  });
}

// The claude process descends from its tab's PTY proxy: look for that PID among the ancestors.
function tabFor(s) {
  return (s.ancestors || []).find(pid => hostTabs.has(pid)) || null;
}

/** The held PTY the session runs in: its tab closed with the plugin, Go to brings it back. */
function heldFor(s) {
  return (s.ancestors || []).find(pid => hostHeld.has(pid)) || null;
}

registerView("active", { tab: "#view-active", panel: "#active",
                         show: () => { resortActive(); loadActive(); },
                         hide: () => window.clearTimeout(activeTimer) });

async function loadActive() {
  window.clearTimeout(activeTimer);
  try {
    // Only detailed cards need the conversation tail: compact ones skip it.
    // Codex's own usage read is asked for only while Codex cards are shown.
    const data = await api(AtlasLogic.activeUrl(activeMode === "full" ? CARD_MESSAGES : 1, agentPick.active));
    activeRaw = data.sessions || [];
    activeSessions = screenSessions();
    activeLimits = data.limits || null;
    activeCodexLimits = data.codex_limits || null;
    recentClosed = data.recent_closed || [];
    AtlasLogic.pruneClosedNotes(closedNotes, recentClosed.map(c => c.session_id), Date.now());
    activeUpdated = new Date();
  } catch (e) {
    // If the server is down, cards stay as they are and the banner on top reports it.
    if (!serverDown || !activeSessions.length) {
      $("#active-grid").replaceChildren(el("p", "empty", i18n("active.error", { msg: e.message })));
    }
  }
  $("#active-count").textContent = activeSessions.length ? String(activeSessions.length) : "";
  if (EMBEDDED) {                             // the answer arrives as a message and redraws the cards
    if (!tabsAskedAt) tabsAskedAt = Date.now();
    tellHost("list-tabs", {});
  }
  renderActive();
  refreshFeed(false);                        // an open feed refreshes together with the cards
  if (state.view === "active") activeTimer = window.setTimeout(loadActive, ACTIVE_POLL_MS);
}

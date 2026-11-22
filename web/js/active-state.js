// Active: state, server polling and the link to the Obsidian plugin.
// Classic script: shares one global scope with the other page files.
/* exported hostHealth, activeUpdated, ACTIVE_FILTERS, PERIODS -- used by other page scripts */
/* exported legacyGroupNames, activeFilter, filterUI, layout, LAYOUT_MAX, LAYOUT_CELLS, layoutUI -- used by other page scripts */
/* exported SEND_TIMEOUT_MS, MAX_ATTACH, lastSignature, composing -- used by other page scripts */
/* exported lastRenderAt, fmtShort, tellTabHost, tabFor, heldFor, hostHeld, hostBackground -- used by other page scripts */
// --- Active tab --------------------------------------------------------------

const ACTIVE_POLL_MS = 5000;
let activeSessions = [];
let activeRaw = [];             // sessions as the server sent them; activeSessions adds tab screens
let hostScreens = new Map();    // PTY proxy PID → a Codex tab's screen: {state: waiting | busy | idle, queued}
let hostTabs = new Map();       // PTY proxy PID → terminal tab title
let hostInlineTabs = new Set(); // PTYs of Atlas-owned terminals that can be shown in a card
let hostHeld = new Map();       // PTY proxy PID → title: the tab closed with the plugin, the process runs
let hostBackground = new Map(); // PTY proxy PID → the Claude Code background job the tab shows
let hostReady = false;          // the plugin answered, so Go to and Close are available
let hostHealth = null;          // {ok, reason} from the plugin: whether the terminal link works
let tabsAskedAt = null;         // when the tabs were requested and no answer has come yet
let activeTimer = null;
let activeLoading = false;
let activeUpdated = null;

// Active filters: each list allows several values, as in Excel.
const ACTIVE_FILTERS = [
  { key:"domain", label:i18n("active.filter.domain"), hash:"ad" },
  { key:"project", label:i18n("active.filter.project"), hash:"ap" },
  { key:"topic", label:i18n("active.filter.topic"), hash:"at" },
  { key:"period", label:i18n("active.filter.period"), hash:"aw" },
  { key:"group", label:i18n("active.filter.group"), hash:"agi" },
];
const PERIODS = AtlasLogic.PERIODS;
const activeFilter = { domain:new Set(), project:new Set(), topic:new Set(), period:new Set(), group:new Set() };
let legacyGroupNames = [];           // old URLs selected a name, before groups had distinct filter IDs
const filterUI = {};
let activeMode = "compact";           // compact | full
// Columns × rows layout, per view; null means auto.
const layout = { compact: null, full: null };
// Compact cards are small, so up to 5 × 5; detailed ones with a reply field up to 4 × 4.
const LAYOUT_MAX = { compact: 5, full: 4 };
const LAYOUT_CELLS = 5;
let layoutUI = null;
const drafts = new Map();             // session id → unfinished reply: survives a poll
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
let hostOpenCodeTabs = [];
let openCodeTabMeta = {};

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

window.addEventListener("message", e => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (d && d.source === HOST_SOURCE && d.type === "bg-result") {
    backgroundResult(d.job);
    return;
  }
  if (d && d.source === HOST_SOURCE && d.type === "sent" && pendingSends.has(d.nonce)) {
    const sid = pendingSends.get(d.nonce);
    pendingSends.delete(d.nonce);
    const draft = sentDrafts.get(d.nonce);
    sentDrafts.delete(d.nonce);
    if (d.ok) {
      if (draft && !draft.pending) justSent.set(sid, Object.assign({ at: new Date().toISOString() }, draft));
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
  hostInlineTabs = new Set(d.tabs.filter(t => t?.inline === true && Number.isInteger(t.ptyPid)).map(t => t.ptyPid));
  hostScreens = tabScreens(d.tabs);
  hostOpenCodeTabs = d.tabs.filter(t => t?.agent === "opencode" && Number.isInteger(t.ptyPid));
  if (hostOpenCodeTabs.length || d.agents?.opencode) setOpenCodeAvailable(true);
  hostBackground = new Map(d.tabs.filter(t => t && Number.isInteger(t.ptyPid) && /^[0-9a-f]{8}$/.test(t.background || ""))
    .map(t => [t.ptyPid, t.background]));
  hostHeld = new Map((Array.isArray(d.held) ? d.held : []).filter(t => t && Number.isInteger(t.ptyPid))
    .map(t => [t.ptyPid, String(t.title || "")]));
  readTabGroups(d);
  readHostUnread(d);
  activeSessions = screenSessions();
  $("#active-count").textContent = activeSessions.length ? String(activeSessions.length) : "";
  hostReady = true;
  tabsAskedAt = null;
  // Plugins before Codex launches send no agents: Claude Code only.
  hostAgents = d.agents && typeof d.agents === "object"
    ? Object.fromEntries(AtlasLogic.AGENTS.map(kind => [
        kind, kind === "claude" ? d.agents[kind] !== false : d.agents[kind] === true,
      ])) : null;
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

/** The plugin's tab list → PTY PID of each Codex tab → its screen: {state, queued}. */
function tabScreens(tabs) {
  return new Map(tabs.filter(t => t && Number.isInteger(t.ptyPid) && t.agent === "codex")
    .map(t => [t.ptyPid, { state: typeof t.screen === "string" ? t.screen : null,
                           queued: Array.isArray(t.queued) ? t.queued.filter(q => typeof q === "string") : [] }]));
}

// A Codex session whose tab shows a prompt waits for you: only the screen knows it. The tab's group comes along.
function screenSessions() {
  const sessions = activeRaw.filter(s => AtlasLogic.findAgent(AtlasLogic.agentOf(s))).map(s => {
    const pid = tabFor(s);
    return withTabGroup(withTabScreen(s, pid ? hostScreens.get(pid) : null), pid);
  });
  return sessions.concat(hostOpenCodeTabs.map(tab => {
    const meta = openCodeTabMeta[tab.sessionId] || {};
    return withTabGroup({ agent: "opencode", session_id: `opencode-tab-${tab.ptyPid}`,
      opencode_id: tab.sessionId, title: meta.title || tab.title || "OpenCode",
      cwd: tab.cwd, ancestors: [tab.ptyPid], last_message_at: meta.last_activity_at }, tab.ptyPid);
  }));
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
                         show: () => rerenderOrder(true),
                         refresh: loadActive,
                         hide: () => {
                           for (const panel of cardPanels.values()) panel.suspend?.();
                           lastSignature = "";
                         } });

function needsActiveSnapshot() {
  // The header counter and Quick Jump need one successful response on every entry view.
  return pageVisible() && (state.view === "active" || !activeUpdated);
}

async function loadActive() {
  window.clearTimeout(activeTimer);
  if (activeLoading || !needsActiveSnapshot()) return;
  activeLoading = true;
  const limitsSeq = markLimitsRequested();
  try {
    // The header needs Codex usage even if the cards are filtered to Claude.
    const data = await api("/api/active?codex_usage=1");
    updateHeaderLimits(data, limitsSeq);
    const previous = activeSessions;
    activeRaw = data.sessions || [];
    openCodeTabMeta = data.opencode_tabs || {};
    activeSessions = screenSessions();
    replacePendingSlots(previous, activeSessions);
    recentClosed = data.recent_closed || [];
    backgroundJobs = (data.background_jobs || []).filter(j => j && /^[0-9a-f]{8}$/.test(j.job_id || ""));
    pruneBackgroundNotes();
    AtlasLogic.pruneClosedNotes(closedNotes, recentClosed.map(c => c.session_id), Date.now());
    activeUpdated = new Date();
  } catch (e) {
    // If the server is down, cards stay as they are and the banner on top reports it.
    if (!serverDown || !activeSessions.length) {
      const grid = $("#active-grid");
      grid.replaceChildren(el("p", "empty", i18n("active.error", { msg: e.message })));
      mountCardPanels(grid);
    }
  } finally {
    activeLoading = false;
    if (needsActiveSnapshot()) activeTimer = window.setTimeout(loadActive, ACTIVE_POLL_MS);
  }
  $("#active-count").textContent = activeSessions.length ? String(activeSessions.length) : "";
  if (EMBEDDED) {                             // the answer arrives as a message and redraws the cards
    if (!tabsAskedAt) tabsAskedAt = Date.now();
    tellHost("list-tabs", {});
  }
  renderActive();
  refreshCardPanels();
}

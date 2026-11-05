// Active: recently closed sessions, the process ended but there was work in the last hours.
// Classic script: shares one global scope with the other page files.
/* exported closedSection, backgroundSection, pruneBackgroundNotes, backgroundResult -- used by other page scripts */
// The card disappears with the process; from here one button continues the session.
const CLOSED_OPEN_KEY = "atlas.closedOpen";
let recentClosed = [];
let closedOpen = loadStored(CLOSED_OPEN_KEY, true);
const closedNotes = new Map();          // session id → {text, pending, at}: "opening…" / why it failed

async function continueClosed(c) {
  closedNotes.set(c.session_id, { text: i18n("closed.opening"), pending: true, at: Date.now() });
  renderActive(null, true);
  try {
    const card = await api("/api/session/" + encodeURIComponent(c.session_id));
    const a = card.actions || {};
    if (!EMBEDDED || !a.resume_command || !a.can_open_terminal) {
      closedNotes.delete(c.session_id);
      showResume(card);                    // outside Obsidian or without a folder: a dialog with the command
      renderActive(null, true);
      return;
    }
    tellHost("resume", { session_id: c.session_id, cwd: a.resume_cwd, command: a.resume_command,
                         title: c.title || card.title || agentShort(card) });
    window.setTimeout(loadActive, 4000);
  } catch (e) {
    closedNotes.set(c.session_id, { text: i18n("closed.failed", { msg: e.message }), pending: false, at: Date.now() });
    renderActive(null, true);
  }
}

function closedRow(c) {
  const row = el("div", "crow");
  const title = el("span", "ct", c.title || c.session_id.slice(0, 8));
  title.title = c.summary || c.title || "";
  const turns = c.human_turns == null ? null
    : i18nN("logic.turns", c.human_turns);
  const meta = [i18n("closed.closedAgo", { ago: ago(c.last_activity_at) }), turns,
                c.cost_usd != null ? "$" + Math.round(c.cost_usd) : null].filter(Boolean).join(" · ");
  const note = closedNotes.get(c.session_id);
  const info = el("span", "cm", (note && note.text) || meta);
  info.title = i18n("closed.lastMessage", { time: fmtDateTime(c.last_activity_at) })
    + (c.cwd_last ? i18n("closed.folder", { cwd: c.cwd_last }) : "");
  const go = el("button", "primary", i18n("closed.continue"));
  go.type = "button";
  go.title = i18n("closed.continue.hint");
  go.addEventListener("click", () => continueClosed(c));
  const find = el("button", null, i18n("closed.inSearch"));
  find.type = "button";
  find.title = i18n("closed.inSearch.hint");
  find.addEventListener("click", () => { setView("search"); openCard(c.session_id); });
  row.append(title, info, go, find);
  return row;
}

// Claude Code background jobs no tab shows (a tab closed with "Close, keep running", ← on an empty
// prompt): they run on unseen. Bring back = the same conversation in an ordinary tab; Stop ends it.
let backgroundJobs = [];
const backgroundNotes = new Map();      // job id → {text, at}: "bringing back…" until the list changes
const BACKGROUND_NOTE_MS = 20000;

function pruneBackgroundNotes() {
  const live = new Set(backgroundJobs.map(j => j.job_id));
  for (const [job, note] of backgroundNotes) {
    if (!live.has(job) || Date.now() - note.at > BACKGROUND_NOTE_MS) backgroundNotes.delete(job);
  }
}

function backgroundResult(job) {
  backgroundNotes.delete(job);
  renderActive(null, true);
  loadActive();
}

function backgroundAct(j, type, noteKey) {
  if (backgroundNotes.has(j.job_id)) return;
  backgroundNotes.set(j.job_id, { text: i18n(noteKey), at: Date.now() });
  tellHost(type, { job: j.job_id });
  renderActive(null, true);
  window.setTimeout(loadActive, 3000);
}

function backgroundRow(j) {
  const row = el("div", "crow");
  const title = el("span", "ct", j.title || j.session_id.slice(0, 8));
  title.title = i18n("background.row.hint", { job: j.job_id, cwd: j.cwd || "?" });
  const state = i18n(j.status === "busy" ? "background.busy" : j.status === "waiting" ? "background.waiting"
    : "background.idle");
  const meta = [state, j.last_message_at ? i18n("background.lastAgo", { ago: ago(j.last_message_at) }) : null]
    .filter(Boolean).join(" · ");
  const note = backgroundNotes.get(j.job_id);
  // Outside Obsidian the page cannot open tabs: the commands for a terminal instead.
  const info = el("span", "cm", (note && note.text) || (EMBEDDED ? meta
    : `${meta} · claude attach ${j.job_id} · claude stop ${j.job_id}`));
  info.title = info.textContent || (EMBEDDED ? meta : `claude attach ${j.job_id} · claude stop ${j.job_id}`);
  row.append(title, info);
  if (!EMBEDDED) { row.classList.add("background-commands"); return row; }
  const back = el("button", "primary", i18n("background.bringBack"));
  back.type = "button";
  back.title = i18n("background.bringBack.hint");
  back.addEventListener("click", () => backgroundAct(j, "bg-bring-back", "background.bringingBack"));
  const stop = el("button", null, i18n("background.stop"));
  stop.type = "button";
  back.disabled = stop.disabled = !!note;
  stop.title = i18n("background.stop.hint");
  stop.addEventListener("click", () => backgroundAct(j, "bg-stop", "background.stopping"));
  row.append(back, stop);
  return row;
}

/** Under the cards, above Recently closed; null when no background job runs without a tab. */
function backgroundSection() {
  const list = backgroundJobs.filter(j => agentPassesView("active", j));
  if (!list.length) return null;
  const sec = el("section", "asec background");
  const h = el("h3", null, i18n("background.title"));
  h.title = i18n("background.title.hint");
  h.appendChild(el("span", "n", String(list.length)));
  sec.appendChild(h);
  const box = el("div", "clist");
  list.forEach(j => box.appendChild(backgroundRow(j)));
  sec.appendChild(box);
  return sec;
}

/** Section at the bottom of Active; null when nothing closed in the last hours. */
function closedSection() {
  const list = recentClosed.filter(c => agentPassesView("active", c));
  if (!list.length) return null;
  const sec = el("section", "asec closed" + (closedOpen ? "" : " folded"));
  const h = el("h3");
  const toggle = el("button", "fold", (closedOpen ? "▾ " : "▸ ") + i18n("closed.title"));
  toggle.type = "button";
  toggle.title = i18n("closed.title.hint");
  toggle.addEventListener("click", () => {
    closedOpen = !closedOpen;
    store(CLOSED_OPEN_KEY, closedOpen);
    renderActive(null, true);
  });
  h.append(toggle, el("span", "n", String(list.length)));
  sec.appendChild(h);
  if (closedOpen) {
    const box = el("div", "clist");
    list.forEach(c => box.appendChild(closedRow(c)));
    sec.appendChild(box);
  }
  return sec;
}

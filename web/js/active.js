// Active: sections and rendering.
// Classic script: shares one global scope with the other page files.
/* exported renderActive -- used by other page scripts */
function section(title, list) {
  const box = el("section", "asec");
  const h = el("h3", null, title);
  h.appendChild(el("span", "n", String(list.length)));
  box.appendChild(h);
  if (!list.length) { box.appendChild(el("p", "none", i18n("active.none"))); return box; }
  const l = layout[activeMode];
  const grid = el("div", (activeMode === "full" ? "agrid full" : "agrid")
    + (l ? ` c${l.c} r${l.r}` : ""));
  list.forEach(s => grid.appendChild(activeCard(s)));
  box.appendChild(grid);
  return box;
}

const RERENDER_EVERY_MS = 60000;     // "N min ago" ages, so redraw once a minute anyway

function renderActive(skipKey, force) {
  const summary = $("#active-summary");
  const grid = $("#active-grid");
  arrangeActive(activeSessions);              // bring back hidden cards that have a new message
  const arranged = arrangeActive(activeSessions.filter(s => passes(s)));
  const shown = arranged.visible;
  const any = ACTIVE_FILTERS.some(({ key }) => activeFilter[key].size);
  // Short, on one line: "11 · 09:08 · 5h 35% · wk 73% · terminal ● · ?"; the full text is in tooltips.
  const sep = () => document.createTextNode(" · ");
  // The total is already on the "Active N" tab; here only what the filters keep.
  const parts = [];
  if (any) {
    const count = el("b", null, i18n("active.shown", { n: shown.length }));
    count.title = i18n("active.shownHint", { shown: shown.length, total: activeSessions.length });
    parts.push(count);
  }
  summary.replaceChildren(...parts);
  if (arranged.hiddenCount) {
    const unhide = el("button", "keys", i18n("active.hidden", { n: arranged.hiddenCount }));
    unhide.type = "button";
    unhide.title = i18n("active.hiddenHint");
    unhide.addEventListener("click", unhideAll);
    if (summary.childNodes.length) summary.append(sep());
    summary.append(unhide);
  }
  if (activeUpdated) {
    if (summary.childNodes.length) summary.append(sep());
    summary.append(el("span", null, i18n("active.updated",
      { time: activeUpdated.toLocaleTimeString(I18N.locale(), { hour: "2-digit", minute: "2-digit" }) })));
  }
  // A reset within a day shows the time, later ones the date.
  const when = iso => {
    const d = new Date(iso);
    return d - Date.now() < 864e5
      ? d.toLocaleTimeString(I18N.locale(), { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(I18N.locale(), { day: "2-digit", month: "2-digit" });
  };
  const lim = AtlasLogic.limitsText(activeLimits, when);
  const short = { five_hour: i18n("active.limit.fiveHour"), seven_day: i18n("active.limit.week") };
  const limSpan = el("span", "limits " + (lim ? lim.tone : "none"), lim
    ? activeLimits.windows.map(w => `${short[w.key] || w.label} ${Math.round(w.used_percentage)}%`).join(" · ")
      + (lim.stale ? i18n("active.limitsStale") : "")
    : i18n("active.limitsNone"));
  // Cut the "limits: " prefix from logic.js: the tooltip has its own full one.
  limSpan.title = lim ? i18n("active.limitsHint", { limits: lim.text.replace(/^[^:]*: /, "") })
    : i18n("active.limitsSetup", { snippet: "\"statusLine\": {\"type\": \"command\", \"command\": "
      + "\"python3.11 ~/Code/session-atlas/tools/statusline.py\"}" });
  summary.append(sep(), limSpan);
  const link = AtlasLogic.terminalStatus(EMBEDDED, hostHealth, tabsAskedAt, Date.now());
  const status = el("span", "link " + (link.ok === false ? "warn" : link.ok ? "ok" : ""), i18n("active.terminal"));
  status.appendChild(el("span", "tdot", "●"));
  status.id = "terminal-link";
  status.title = i18n("active.terminalHint", {
    state: link.ok === null ? i18n("active.terminalChecking") : link.ok ? i18n("active.terminalYes") : i18n("active.terminalNo"),
    reason: link.reason ? ` (${link.reason})` : "" });
  summary.append(sep(), status);
  const keys = el("button", "keys", "?");
  keys.type = "button";
  keys.title = i18n("active.keysHint");
  keys.addEventListener("click", showKeys);
  summary.append(sep(), keys);
  if (state.view !== "active") return;
  refreshFilterButtons(skipKey);
  document.querySelectorAll(".mode button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === activeMode)));
  const closed = () => [closedSection()].filter(Boolean);
  if (!activeSessions.length) {
    grid.replaceChildren(el("p", "empty", i18n("active.noSessions")), ...closed());
    return;
  }
  if (!shown.length) {
    grid.replaceChildren(el("p", "empty", arranged.hiddenCount
      ? i18n("active.allHidden")
      : i18n("active.noMatches")), ...closed());
    return;
  }
  // During IME composition the DOM is left alone, otherwise the word breaks. Open command
  // hints too: a redraw every 5 s would recreate the field and drop the list.
  if (composing || document.querySelector("#active-grid .suggest:not(.hidden)")) return;
  // Plan feedback is being typed: the field is not recreated, otherwise focus and caret are lost.
  if (document.activeElement && document.activeElement.matches("#active-grid .planfb textarea")) return;
  // Nothing changed: leave the DOM alone entirely, so the text scroll does not reset.
  const signature = JSON.stringify([shown, activeMode, layout, hostReady, [...hostTabs.keys()],
    [...justSent].map(([sid, sent]) => [sid, AtlasLogic.deliveryState(
      activeSessions.find(x => x.session_id === sid) || {}, sent, Date.now())]), [...dialogs], [...dialogNotes], [...dialogAnswers.values()], [...stopNotes], [...commandOutputs], feedSid, pinnedCards, hiddenCards,
    [...fullReplies.keys()], [...attachments].map(([k, v]) => [k, v.length]),
    recentClosed, closedOpen, [...closedNotes], [...planForms],
    [...planTexts].map(([k, v]) => [k, v.name, (v.text || "").length])]);
  if (!force && signature === lastSignature && Date.now() - lastRenderAt < RERENDER_EVERY_MS) return;
  lastSignature = signature;
  lastRenderAt = Date.now();
  // On top, who waits for you (open dialogs first); below, who is working.
  // Background goes with working: the turn ended, but a monitor, agent or /loop wakes it, not you.
  const act = s => s.activity || s.status;
  const isWorking = s => act(s) === "busy" || act(s) === "background";
  // Order comes from arrangeSessions: pinned, then by start; freshness does not reorder.
  const waitingYou = shown.filter(s => !isWorking(s));
  const working = shown.filter(isWorking);
  // Scroll inside a reply is kept per card: otherwise the text jumps to the top every 5 seconds.
  const inner = new Map([...grid.querySelectorAll(".acard")].map(c => {
    const txt = c.querySelector(".reply .txt:not(.now)");
    return [c.dataset.id, txt ? txt.scrollTop : 0];
  }));
  // Focus and caret in the reply field survive a redraw: otherwise after sending the card
  // does not update until you click outside the field.
  const focused = document.activeElement && document.activeElement.tagName === "TEXTAREA"
    && grid.contains(document.activeElement) ? document.activeElement : null;
  const caret = focused && { id: focused.dataset.id, start: focused.selectionStart,
                             end: focused.selectionEnd, top: focused.scrollTop };
  const scroll = grid.scrollTop;
  grid.replaceChildren(section(i18n("active.sectionWaiting"), waitingYou), section(i18n("active.sectionWorking"), working), ...closed());
  stickChats(grid);
  grid.scrollTop = scroll;
  if (caret) {
    const area = grid.querySelector(`.answer textarea[data-id="${CSS.escape(caret.id)}"]`);
    if (area && !area.disabled) {
      area.focus({ preventScroll: true });
      area.setSelectionRange(caret.start, caret.end);
      area.scrollTop = caret.top;
    }
  }
  grid.querySelectorAll(".acard").forEach(c => {
    const txt = c.querySelector(".reply .txt:not(.now)");
    if (txt && inner.get(c.dataset.id)) txt.scrollTop = inner.get(c.dataset.id);
  });
  applySelection();                  // keyboard selection survives a redraw
}

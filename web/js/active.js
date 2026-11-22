// Active: sections and rendering.
// Classic script: shares one global scope with the other page files.
/* exported renderActive -- used by other page scripts */
function section(title, list, cls) {
  const box = el("section", "asec" + (cls ? " " + cls : ""));
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
  const any = ACTIVE_FILTERS.some(({ key }) => activeFilter[key].size) || agentFiltered("active");
  // Keep the Active controls on one line.
  const sep = () => document.createTextNode(" · ");
  // The total is already on the "Active N" tab; here only what the filters keep.
  const parts = [];
  if (any) {
    const count = el("b", null, i18n("active.shown", { n: shown.length }));
    count.title = i18n("active.shownHint", { shown: shown.length, total: activeSessions.length });
    parts.push(count);
  }
  summary.replaceChildren(...parts);
  const unread = unreadButton(shown.map(s => s.session_id));
  if (unread) {
    if (summary.childNodes.length) summary.append(sep());
    summary.append(unread);
  }
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
  const closed = () => [backgroundSection(), closedSection()].filter(Boolean);
  // An empty grid is not the cards of the last signature: clearing a filter must draw them again.
  if (!activeSessions.length || !shown.length) lastSignature = "";
  if (!activeSessions.length) {
    grid.replaceChildren(el("p", "empty", i18n("active.noSessions")), ...closed());
    mountCardPanels(grid);
    return;
  }
  if (!shown.length) {
    grid.replaceChildren(el("p", "empty", arranged.hiddenCount
      ? i18n("active.allHidden")
      : i18n("active.noMatches")), ...closed());
    mountCardPanels(grid);
    return;
  }
  // During IME composition the DOM is left alone, otherwise the word breaks. Open command
  // hints too: a redraw every 5 s would recreate the field and drop the list.
  if (composing || document.querySelector("#active-grid .suggest:not(.hidden)")) return;
  // Plan feedback is being typed: the field is not recreated, otherwise focus and caret are lost.
  if (document.activeElement && document.activeElement.matches("#active-grid .planfb textarea")) return;
  // Nothing changed: leave the DOM alone entirely, so the text scroll does not reset.
  const signature = JSON.stringify([shown, activeMode, layout, hostReady, [...hostTabs.keys()], [...hostInlineTabs], [...hostHeld.keys()], [...hostBackground],
    [...justSent].map(([sid, sent]) => [sid, AtlasLogic.deliveryState(
      activeSessions.find(x => x.session_id === sid) || {}, sent, Date.now())]), [...dialogs], [...dialogNotes], [...dialogAnswers.values()], [...stopNotes], [...commandOutputs], pinnedCards, hiddenCards,
    [...attachments].map(([k, v]) => [k, v.length]),
    recentClosed, backgroundJobs, [...backgroundNotes], agentPick.active, closedOpen, [...closedNotes], [...planForms], [...freeModes],
    [...planTexts].map(([k, v]) => [k, v.name, (v.text || "").length])]);
  if (!force && signature === lastSignature && Date.now() - lastRenderAt < RERENDER_EVERY_MS) return;
  lastSignature = signature;
  lastRenderAt = Date.now();
  // On top, who waits for you (open dialogs first); below, who is working.
  // Background goes with working: the turn ended, but a monitor, agent or /loop wakes it, not you.
  const isWorking = activity => activity === "busy" || activity === "background";
  // Order comes from arrangeSessions: pinned, then by start; freshness does not reorder.
  const decide = [], waitingYou = [], working = [], openCode = [];
  for (const s of shown) {
    if (s.agent === "opencode") { openCode.push(s); continue; }
    const activity = sectionActivity(s);
    (activity === "waiting" ? decide : isWorking(activity) ? working : waitingYou).push(s);
  }
  // A long dialog scrolls inside itself: the reader's place in it survives the redraw too.
  // A dialog that changed its view (another question tab) starts at the top.
  const dialogTops = new Map([...grid.querySelectorAll(".acard > .dialog")].map(d =>
    [d.parentElement.dataset.id, { top: d.scrollTop, view: d.dataset.view || "" }]));
  // Focus and caret in the reply field survive a redraw: otherwise after sending the card
  // does not update until you click outside the field.
  const focused = document.activeElement && document.activeElement.tagName === "TEXTAREA"
    && grid.contains(document.activeElement) ? document.activeElement : null;
  const caret = focused && { id: focused.dataset.id, start: focused.selectionStart,
                             end: focused.selectionEnd, top: focused.scrollTop };
  const scroll = grid.scrollTop;
  // A dialog blocks the session: such cards get their own section on top, shown only when there are any.
  const standard = !openCode.length || decide.length || waitingYou.length || working.length;
  const sections = [decide.length ? section(i18n("active.sectionDecision"), decide, "decide") : null,
                    standard ? section(i18n("active.sectionWaiting"), waitingYou) : null,
                    standard ? section(i18n("active.sectionWorking"), working) : null,
                    openCode.length ? section(i18n("opencode.active"), openCode, "open-code") : null];
  const terminalFocus = document.activeElement?.closest(".card-terminal")?.closest(".acard")?.dataset.id;
  const contentFocus = document.activeElement?.matches(".card-view-body")
    && document.activeElement.closest(".acard")?.dataset.id;
  const pickerFocus = document.activeElement?.matches(".card-view-picker")
    && document.activeElement.closest(".acard")?.dataset.id;
  // Keep the mounted body and its scroll position across header and status updates.
  const positions = new Map([...cardPanels].map(([sid, panel]) => [sid, panel.body.scrollTop]));
  grid.replaceChildren(...sections.filter(Boolean), ...closed());
  mountCardPanels(grid, shown);
  for (const [sid, top] of positions) {
    const panel = cardPanels.get(sid);
    if (panel && state.view === "active") panel.body.scrollTop = top;
  }
  if (terminalFocus) cardPanels.get(terminalFocus)?.focus?.();
  if (contentFocus) cardPanels.get(contentFocus)?.body.focus({ preventScroll: true });
  if (pickerFocus) grid.querySelector(`.acard[data-id="${CSS.escape(pickerFocus)}"] .card-view-picker`)?.focus({ preventScroll: true });
  fitBringBack(grid);
  watchBringBack(grid);
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
    const dialog = c.querySelector(":scope > .dialog");
    const was = dialogTops.get(c.dataset.id);
    if (dialog && was && was.top && was.view === (dialog.dataset.view || "")) dialog.scrollTop = was.top;
  });
  applySelection();                  // keyboard selection survives a redraw
}

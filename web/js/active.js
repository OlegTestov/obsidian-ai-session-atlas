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
  // A spent window names its reset; numbers that are not live end with their age.
  const windows = (l, shown) => l.windows.map(w => {
    const label = short[w.key] || w.label;
    return w.used_percentage >= 100 ? i18n("active.limitReached", { label, until: w.resets_at
      ? i18n("logic.limits.until", { when: when(w.resets_at) }) : "" }) : `${label} ${Math.round(w.used_percentage)}%`;
  }).join(" · ") + (shown.age ? i18n("active.limitsAge", { age: shown.age }) : "");
  const stamp = iso => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(I18N.locale(), { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? time
      : d.toLocaleDateString(I18N.locale(), { day: "2-digit", month: "2-digit" }) + " " + time;
  };
  // Cut the "limits: " prefix from logic.js: the tooltip has its own full one.
  const hintLimits = l => l.text.replace(/^[^:]*: /, "");
  // Each agent has its own subscription: Codex limits get their own span, named when both show.
  const codexLim = agentPick.active.includes("codex") ? AtlasLogic.limitsText(activeCodexLimits, when) : null;
  if (agentPick.active.includes("claude")) {
    const text = lim ? windows(activeLimits, lim) : i18n("active.limitsNone");
    const limSpan = el("span", "limits " + (lim ? lim.tone : "none"),
      codexLim ? i18n("active.limitsClaude", { limits: text }) : text);
    limSpan.title = lim ? i18n("active.limitsHint", { limits: hintLimits(lim) })
        + (lim.age && activeLimits.captured_at ? i18n("active.limitsAsOf", { time: stamp(activeLimits.captured_at) }) : "")
      : i18n("active.limitsSetup", { snippet: "\"statusLine\": {\"type\": \"command\", \"command\": "
        + "\"python3.11 ~/Code/session-atlas/tools/statusline.py\"}" });
    summary.append(sep(), limSpan);
  }
  if (codexLim) {
    const codexSpan = el("span", "limits " + codexLim.tone,
      i18n("active.limitsCodex", { limits: windows(activeCodexLimits, codexLim) }));
    const at = activeCodexLimits.captured_at ? stamp(activeCodexLimits.captured_at) : "?";
    codexSpan.title = i18n(activeCodexLimits.source === "live" ? "active.limitsCodexLive" : "active.limitsCodexRun",
                           { limits: hintLimits(codexLim), time: at });
    summary.append(sep(), codexSpan);
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
  const closed = () => [closedSection()].filter(Boolean);
  // An empty grid is not the cards of the last signature: clearing a filter must draw them again.
  if (!activeSessions.length || !shown.length) lastSignature = "";
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
  const signature = JSON.stringify([shown, activeMode, layout, hostReady, [...hostTabs.keys()], [...hostHeld.keys()],
    [...justSent].map(([sid, sent]) => [sid, AtlasLogic.deliveryState(
      activeSessions.find(x => x.session_id === sid) || {}, sent, Date.now())]), [...dialogs], [...dialogNotes], [...dialogAnswers.values()], [...stopNotes], [...commandOutputs], feedSid, pinnedCards, hiddenCards,
    [...fullReplies.keys()], [...attachments].map(([k, v]) => [k, v.length]),
    recentClosed, agentPick.active, closedOpen, [...closedNotes], [...planForms], [...freeModes],
    [...planTexts].map(([k, v]) => [k, v.name, (v.text || "").length])]);
  if (!force && signature === lastSignature && Date.now() - lastRenderAt < RERENDER_EVERY_MS) return;
  lastSignature = signature;
  lastRenderAt = Date.now();
  // On top, who waits for you (open dialogs first); below, who is working.
  // Background goes with working: the turn ended, but a monitor, agent or /loop wakes it, not you.
  const act = s => s.activity || s.status;
  const isWorking = s => act(s) === "busy" || act(s) === "background";
  // Order comes from arrangeSessions: pinned, then by start; freshness does not reorder.
  const decide = shown.filter(s => act(s) === "waiting");
  const waitingYou = shown.filter(s => !isWorking(s) && act(s) !== "waiting");
  const working = shown.filter(isWorking);
  // Scroll inside a reply is kept per card: otherwise the text jumps to the top every 5 seconds.
  const inner = new Map([...grid.querySelectorAll(".acard")].map(c => {
    const txt = c.querySelector(".reply .txt:not(.now)");
    return [c.dataset.id, txt ? txt.scrollTop : 0];
  }));
  // A long dialog scrolls inside itself: the reader's place in it survives the redraw too.
  const dialogTops = new Map([...grid.querySelectorAll(".acard > .dialog")].map(d =>
    [d.parentElement.dataset.id, d.scrollTop]));
  // Focus and caret in the reply field survive a redraw: otherwise after sending the card
  // does not update until you click outside the field.
  const focused = document.activeElement && document.activeElement.tagName === "TEXTAREA"
    && grid.contains(document.activeElement) ? document.activeElement : null;
  const caret = focused && { id: focused.dataset.id, start: focused.selectionStart,
                             end: focused.selectionEnd, top: focused.scrollTop };
  const scroll = grid.scrollTop;
  // A dialog blocks the session: such cards get their own section on top, shown only when there are any.
  const sections = [decide.length ? section(i18n("active.sectionDecision"), decide, "decide") : null,
                    section(i18n("active.sectionWaiting"), waitingYou), section(i18n("active.sectionWorking"), working)];
  grid.replaceChildren(...sections.filter(Boolean), ...closed());
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
    const dialog = c.querySelector(":scope > .dialog");
    if (dialog && dialogTops.get(c.dataset.id)) dialog.scrollTop = dialogTops.get(c.dataset.id);
  });
  applySelection();                  // keyboard selection survives a redraw
}

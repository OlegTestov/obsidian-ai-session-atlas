// Active: a session dialog (permission or question) right in the card.
// Classic script: shares one global scope with the other page files.
/* exported handleDialogMessage, dialogBlock, stopButton, handleStopMessage -- used by other page scripts */
// The plugin reads the dialog text from the tab's screen: the transcript lacks it while the dialog is open.
const dialogs = new Map();            // session id → {dialog, reason}
const dialogAnswers = new Map();      // nonce → session id
const dialogNotes = new Map();        // session id → {note, cls}
const DIALOG_TIMEOUT_MS = 6000;
const CHAT_OPTION = "Chat about this";

const isWaitingSession = s => (s.activity || s.status) === "waiting";

// Waiting sessions with a tab in Obsidian: read the dialog. The answer arrives as a message.
function requestDialogs() {
  const waiting = new Set();
  activeSessions.filter(isWaitingSession).forEach(s => {
    waiting.add(s.session_id);
    const pid = tabFor(s);
    if (pid) tellTabHost("read-dialog", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id });
  });
  [...dialogs.keys()].forEach(sid => { if (!waiting.has(sid)) dialogs.delete(sid); });
  [...freeModes.keys()].forEach(sid => { if (!waiting.has(sid)) { freeModes.delete(sid); freeDrafts.delete(sid); } });
  [...previewNoteOpen].forEach(sid => { if (!waiting.has(sid)) { previewNoteOpen.delete(sid); previewNoteDrafts.delete(sid); } });
}

// Plugin messages about dialogs. true means the message is handled here.
function handleDialogMessage(d) {
  if (d.type === "dialog" && typeof d.sessionId === "string") {
    // A dialog with a reason is a re-read after an action that did not go through (preview, highlight).
    if (d.dialog && d.reason) dialogs.set(d.sessionId, { dialog: d.dialog, reason: null });
    else dialogs.set(d.sessionId, { dialog: d.dialog || null, reason: d.reason || null });
    const shown = dialogNotes.get(d.sessionId);
    if (d.dialog && d.reason) dialogNotes.set(d.sessionId, { note: d.reason, cls: "bad" });
    else if (shown && shown.note === i18n("active.previewLoading")) dialogNotes.delete(d.sessionId);
    renderActive();
    return true;
  }
  if (d.type === "answered" && dialogAnswers.has(d.nonce)) {
    const sid = dialogAnswers.get(d.nonce);
    dialogAnswers.delete(d.nonce);
    if (d.ok) {
      dialogs.delete(sid);
      freeModes.delete(sid);              // a failed answer keeps the typed text for another try
      freeDrafts.delete(sid);
      previewNoteOpen.delete(sid);
      previewNoteDrafts.delete(sid);
      dialogNotes.set(sid, { note: i18n("active.answerSent"), cls: "ok" });
      window.setTimeout(() => { dialogNotes.delete(sid); loadActive(); }, 1500);
    } else {
      dialogNotes.set(sid, { note: i18n("active.notSent", { reason: d.reason || i18n("active.errorWord") }), cls: "bad" });
      requestDialogs();                   // the screen may have changed: read it again
    }
    lastSignature = "";
    renderActive(null, true);
    return true;
  }
  return false;
}

function answerDialogOption(s, pid, option) {
  const nonce = Math.random().toString(36).slice(2);
  dialogAnswers.set(nonce, s.session_id);
  dialogNotes.set(s.session_id, { note: i18n("active.sending"), cls: "" });
  tellTabHost("answer-dialog", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id,
                                 option: option.n, text: option.text, nonce });
  lastSignature = "";
  renderActive(null, true);
  window.setTimeout(() => {
    if (!dialogAnswers.has(nonce)) return;
    dialogAnswers.delete(nonce);
    dialogNotes.set(s.session_id, { note: i18n("active.noHostReply"), cls: "bad" });
    renderActive(null, true);
  }, DIALOG_TIMEOUT_MS);
}

// Dialog block in the card. null when the session is not waiting for a decision.
function dialogBlock(s, pid, full) {
  if (!isWaitingSession(s)) return null;
  // Waits because of a command panel whose answer is already in the card, along with the Close panel button.
  const own = commandOutputs.get(s.session_id);
  if (own && own.panel) return null;
  const box = el("div", "dialog");
  const got = dialogs.get(s.session_id);
  const note = dialogNotes.get(s.session_id);
  const busy = [...dialogAnswers.values()].includes(s.session_id);
  if (!hostReady || !pid) {
    box.appendChild(el("div", "q", s.waiting_for === "permission prompt"
      ? i18n("active.permissionInTab")
      : i18n("active.questionInTab")));
    return box;
  }
  if (!got) {
    box.appendChild(el("div", "q dim", note ? note.note : i18n("active.readingDialog")));
    return box;
  }
  const d = got.dialog;
  if (!d) {
    box.appendChild(el("div", "q", got.reason || i18n("active.dialogNotRead")));
    return box;
  }
  if (d.kind === "plan" && agentControls(s).plan) return planBlock(s, pid, d, full, busy, note, box);
  if (d.pick === "enter") return previewBlock(s, pid, d, full, busy, note, box);
  if (d.kind === "panel") {
    // Command panel (/usage, /effort…). If its answer is already in the card, the close button is there too.
    box.appendChild(el("div", "t", i18n("active.panelOpen", { title: d.title })));
    box.appendChild(el("pre", "det" + (full ? "" : " short"), full ? d.panel : d.title));
    const close = el("button", null, i18n("active.closePanel"));
    close.type = "button";
    close.addEventListener("click", e => { e.stopPropagation(); closePanel(s, pid); });
    const opts = el("div", "opts");
    opts.appendChild(close);
    box.appendChild(opts);
    return box;
  }
  const head = el("div", "t", d.kind === "permission" ? i18n("active.permission", { title: d.title }) : d.title);
  box.appendChild(head);
  const details = Array.isArray(d.details) ? d.details : [];   // Codex choices may have none
  if (details.length) {
    // Compact: the first line (command or path); without it "Yes" is pressed blind.
    const pre = el("pre", "det" + (full ? "" : " short"), full ? details.join("\n") : details[0]);
    pre.title = details.join("\n");
    box.appendChild(pre);
  }
  if (d.question && full) box.appendChild(el("div", "q", d.question));
  if (!d.answerable || !Array.isArray(d.options)) {
    box.appendChild(el("div", "q dim", d.reason || i18n("active.dialogTabOnly")));
    return box;
  }
  const opts = el("div", "opts");
  const free = AtlasLogic.freeTextOption(d);
  if (free) box.classList.add("with-free");
  d.options.forEach((o, i) => {
    if (free && o.n === free.n) {
      opts.appendChild(freeButton(s, d, o, full, busy));
      return;
    }
    const chat = d.agent !== "codex" && o.text === CHAT_OPTION;
    const text = chat ? i18n("active.chatOption") : o.text;
    // Only a long label shrinks: "1. Yes" and "3. No" are always fully visible.
    const cls = [i === 0 ? "primary" : "", text.length > 18 ? "long" : ""].join(" ").trim();
    const b = el("button", cls || null, `${o.n}. ${text}`);
    b.type = "button";
    b.title = (chat ? i18n("active.chatOptionHint") + " · " : o.detail ? o.detail + " · " : "")
      + i18n("active.pressesKey", { n: o.n });
    b.disabled = busy;
    b.addEventListener("click", () => answerDialogOption(s, pid, o));
    opts.appendChild(b);
    if (o.detail && full) opts.appendChild(el("span", "od", o.detail));
  });
  box.appendChild(opts);
  // Compact cards have no reply field: the typed answer gets its own field in the dialog.
  if (free && !full && freeModes.get(s.session_id) === free.n && !busy) {
    box.appendChild(freeField(s, pid, free, "planfb freefb"));
  }
  if (note) box.appendChild(el("div", "note " + (note.cls || ""), note.note));
  return box;
}

// --- Stop: a single Esc into the tab, as in the terminal; only with confirmation ---
const stopRequests = new Map();       // nonce → session id
const stopNotes = new Map();          // session id → text

const canStop = s => ["busy", "waiting"].includes(s.activity || s.status);

function stopButton(s, pid, mini) {
  if (!canStop(s)) return null;
  const b = el("button", "stop" + (mini ? " mini" : ""), i18n("active.stop"));
  b.type = "button";
  b.disabled = !hostReady || !pid;
  b.title = b.disabled ? i18n("active.stopNeedsTab")
    : (s.activity || s.status) === "waiting" ? i18n("active.stopDialogHint")
    : i18n("active.stopStepHint");
  b.addEventListener("click", e => { e.stopPropagation(); confirmStop(s, pid); });
  return mini ? iconify(b, STOP_SVG, i18n("active.stop")) : b;
}

function confirmStop(s, pid) {
  const waiting = (s.activity || s.status) === "waiting";
  modal(waiting ? i18n("active.stopDialogTitle") : i18n("active.stopSessionTitle"),
    i18n(waiting ? "active.stopDialogBody" : "active.stopSessionBody", { title: s.title || s.session_id }),
    s.progress ? i18n("active.nowText", { text: s.progress }) : "",
    waiting ? i18n("active.closeDialog") : i18n("active.interrupt"), () => {
      $("#modal").close();
      const nonce = Math.random().toString(36).slice(2);
      stopRequests.set(nonce, s.session_id);
      stopNotes.set(s.session_id, i18n("active.stopping"));
      tellTabHost("interrupt", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id, nonce });
      lastSignature = "";
      renderActive(null, true);
    });
  $("#m-copy").classList.add("hidden");
  $("#m-close").focus();                // a stray Enter must not interrupt
}

function handleStopMessage(d) {
  if (d.type !== "stopped" || !stopRequests.has(d.nonce)) return false;
  const sid = stopRequests.get(d.nonce);
  stopRequests.delete(d.nonce);
  stopNotes.set(sid, d.ok ? i18n("active.stopped")
    : i18n("active.notStopped", { reason: d.reason || i18n("active.errorWord") }));
  window.setTimeout(() => { stopNotes.delete(sid); lastSignature = ""; loadActive(); }, d.ok ? 1500 : 5000);
  lastSignature = "";
  renderActive(null, true);
  return true;
}

// Active: a Claude Code question with a preview per option. In the tab a digit only moves the
// highlight (and the preview with it); Enter answers the highlighted option; n opens a note that goes
// with the answer; the unnumbered "Chat about this" declines the question. The card shows the options
// in a column, the highlighted option's preview below them, and 👁 to look at another one's preview.
// Classic script: shares one global scope with the other page files.
/* exported previewBlock -- used by active-dialog.js */
const previewNoteDrafts = new Map();    // session id → the note typed for the answer, not sent yet
const previewNoteOpen = new Set();      // session ids whose note field is open

function sendDialogMessage(s, pid, type, extra, sending) {
  const nonce = Math.random().toString(36).slice(2);
  if (type === "answer-dialog") dialogAnswers.set(nonce, s.session_id);
  dialogNotes.set(s.session_id, { note: sending, cls: "" });
  tellTabHost(type, Object.assign({ ptyPid: pid, claudePid: s.pid, sessionId: s.session_id, nonce }, extra));
  const focused = document.activeElement;
  if (focused && focused.matches(".pvnote textarea")) focused.blur();     // a focused field holds redraws
  lastSignature = "";
  renderActive(null, true);
  if (type !== "answer-dialog") return;
  window.setTimeout(() => {
    if (!dialogAnswers.has(nonce)) return;
    dialogAnswers.delete(nonce);
    dialogNotes.set(s.session_id, { note: i18n("active.noHostReply"), cls: "bad" });
    renderActive(null, true);
  }, DIALOG_TIMEOUT_MS);
}

function answerWithPreview(s, pid, o) {
  const note = (previewNoteDrafts.get(s.session_id) || "").trim();
  const extra = { option: o.n, text: o.text };
  if (previewNoteOpen.has(s.session_id) && note) extra.note = note;
  sendDialogMessage(s, pid, "answer-dialog", extra,
                    i18n(extra.note ? "active.sendingWithNote" : "active.sending"));
}

function showPreviewOf(s, pid, o) {
  sendDialogMessage(s, pid, "preview-option", { option: o.n, text: o.text }, i18n("active.previewLoading"));
}

function noteField(s, pid, d) {
  const sid = s.session_id;
  const box = el("div", "planfb pvnote");
  const area = el("textarea");
  area.rows = 2;
  area.dataset.id = sid;
  area.value = previewNoteDrafts.get(sid) || "";
  area.placeholder = i18n("active.notePlaceholder", { n: d.highlighted });
  area.setAttribute("aria-label", i18n("active.noteAria"));
  area.addEventListener("input", () => previewNoteDrafts.set(sid, area.value));
  area.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      previewNoteOpen.delete(sid);
      lastSignature = "";
      renderActive(null, true);
    }
  });
  box.appendChild(area);
  box.appendChild(el("div", "pvhint", i18n("active.noteHint")));
  // No scroll on focus: the options above must stay in sight.
  window.setTimeout(() => { if (document.activeElement !== area && !area.value) area.focus({ preventScroll: true }); });
  return box;
}

/** The question block; box is the card's dialog element, already holding nothing. */
function previewBlock(s, pid, d, full, busy, note, box) {
  const sid = s.session_id;
  box.classList.add("pvq");
  box.appendChild(el("div", "t", d.title));
  if (d.question && full) box.appendChild(el("div", "q", d.question));
  if (!d.answerable) {
    box.appendChild(el("div", "q dim", d.reason || i18n("active.dialogTabOnly")));
    return box;
  }
  const list = el("div", full ? "pvopts" : "opts");
  d.options.forEach(o => {
    const on = o.n === d.highlighted;
    // Filled: the highlighted option, the one Enter would answer in the tab.
    const pick = el("button", ["pvpick", on ? "primary on" : "", full ? "" : "long"].join(" ").trim(),
                    `${o.n}. ${o.text}`);
    pick.type = "button";
    pick.title = i18n("active.previewPickHint", { n: o.n });
    pick.disabled = busy;
    pick.addEventListener("click", () => answerWithPreview(s, pid, o));
    if (!full) { list.appendChild(pick); return; }
    const row = el("div", "pvrow" + (on ? " on" : ""));
    row.appendChild(pick);
    const eye = el("button", "pveye" + (on ? " on" : ""), on ? "◉" : "👁");
    eye.type = "button";
    eye.title = on ? i18n("active.previewShown") : i18n("active.previewShow", { n: o.n });
    eye.setAttribute("aria-label", eye.title);
    eye.setAttribute("aria-pressed", String(on));
    eye.disabled = busy || on || previewNoteOpen.has(sid);
    eye.addEventListener("click", () => showPreviewOf(s, pid, o));
    row.appendChild(eye);
    list.appendChild(row);
  });
  box.appendChild(list);
  const extras = el("div", "opts pvextra");
  if (d.notes && full) {
    const open = previewNoteOpen.has(sid);
    const b = el("button", "ghost" + (open ? " on" : ""), i18n(open ? "active.noteClose" : "active.noteAdd"));
    b.type = "button";
    b.setAttribute("aria-pressed", String(open));
    b.disabled = busy;
    b.addEventListener("click", () => {
      if (open) previewNoteOpen.delete(sid); else previewNoteOpen.add(sid);
      lastSignature = "";
      renderActive(null, true);
    });
    extras.appendChild(b);
  }
  if (d.chat) {
    const c = el("button", "ghost", i18n("active.chatOption"));
    c.type = "button";
    c.title = i18n("active.chatOptionHint");
    c.disabled = busy;
    c.addEventListener("click", () => sendDialogMessage(s, pid, "answer-dialog", { chat: true }, i18n("active.sending")));
    extras.appendChild(c);
  }
  if (extras.childNodes.length) box.appendChild(extras);
  if (full && d.notes && previewNoteOpen.has(sid)) box.appendChild(noteField(s, pid, d));
  if (full && d.preview && d.preview.lines.length) {
    const pv = el("div", "pvbox");
    pv.appendChild(el("div", "pvh", i18n("active.previewOf", { n: d.preview.n })));
    pv.appendChild(el("pre", "pvtext", d.preview.lines.join("\n")));
    box.appendChild(pv);
  } else if (!full && d.preview) {
    list.title = i18n("active.previewInFull");          // a compact card has no room for the preview itself
  }
  if (note) box.appendChild(el("div", "note " + (note.cls || ""), note.note));
  return box;
}

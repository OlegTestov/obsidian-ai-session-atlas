// Active: the own answer to a dialog, the option that takes typed text ("Type something." in Claude
// Code's questions, Codex's "No, and tell Codex what to do differently"). The plugin presses the
// option's digit, types the text, checks it on the tab's screen and only then presses Enter.
// Classic script: shares one global scope with the other page files.
/* exported freeAnswerForm, freeButton, freeField, freeModes, freeDrafts -- used by other page scripts */
const freeModes = new Map();          // session id → number of the option the typed answer goes to
const freeDrafts = new Map();         // session id → the typed answer not sent yet

/** A toggle: on, the reply field below (or a field in a compact card) answers this option. */
function freeButton(s, d, o, full, busy) {
  const sid = s.session_id;
  const on = freeModes.get(sid) === o.n;
  const label = d.agent === "codex" ? o.text : i18n("active.freeOption");
  const b = el("button", "free" + (on ? " on" : ""), `${o.n}. ${label}`);
  b.type = "button";
  b.setAttribute("aria-pressed", String(on));
  b.title = i18n(full ? "active.freeOptionHint" : "active.freeOptionHintCompact");
  b.disabled = busy;
  b.addEventListener("click", () => {
    if (on) freeModes.delete(sid); else freeModes.set(sid, o.n);
    lastSignature = "";
    renderActive(null, true);
    window.setTimeout(() => focusFree(sid, !on));
  });
  return b;
}

/** After the mode switch: into the field when it opened, back to the option button when it closed. */
function focusFree(sid, field) {
  const c = document.querySelector(`#active-grid .acard[data-id="${CSS.escape(sid)}"]`);
  const target = c && c.querySelector(field ? ".answer.free textarea, .freefb textarea" : ".dialog button.free");
  if (target) target.focus();
  if (field && c) revealFree(c);
}

/** A long dialog scrolls inside itself: the pressed option stays in sight above the growing field. */
function revealFree(card) {
  const dialog = card.querySelector(":scope > .dialog");
  const option = dialog && dialog.querySelector("button.free.on");
  if (!option || card.querySelector(".freefb")) return;
  const d = dialog.getBoundingClientRect();
  const o = option.getBoundingClientRect();
  if (o.bottom > d.bottom) dialog.scrollTop += o.bottom - d.bottom + 6;
  else if (o.top < d.top) dialog.scrollTop -= d.top - o.top + 6;
}

function closeFree(sid) {
  freeModes.delete(sid);
  lastSignature = "";
  renderActive(null, true);
  window.setTimeout(() => focusFree(sid, false));
}

function sendFreeAnswer(s, pid, o) {
  const sid = s.session_id;
  const text = AtlasLogic.freeAnswerText(freeDrafts.get(sid));
  if (!text || [...dialogAnswers.values()].includes(sid)) return;
  const nonce = Math.random().toString(36).slice(2);
  dialogAnswers.set(nonce, sid);
  dialogNotes.set(sid, { note: i18n("active.sendingAnswer"), cls: "" });
  tellTabHost("answer-dialog", { ptyPid: pid, claudePid: s.pid, sessionId: sid,
                                 option: o.n, text: o.text, feedback: text, nonce });
  // While a field has focus cards may not redraw: release it so the note shows.
  const focused = document.activeElement;
  if (focused && focused.matches(".answer.free textarea, .freefb textarea")) focused.blur();
  lastSignature = "";
  renderActive(null, true);
  window.setTimeout(() => {
    if (!dialogAnswers.has(nonce)) return;
    dialogAnswers.delete(nonce);
    dialogNotes.set(sid, { note: i18n("active.noHostReply"), cls: "bad" });
    renderActive(null, true);
  }, DIALOG_TIMEOUT_MS);
}

/** The text field for the typed answer and its send button; Enter sends, Esc leaves the mode. */
function freeField(s, pid, o, cls) {
  const sid = s.session_id;
  const box = el("div", cls);
  const area = el("textarea");
  area.rows = cls.includes("freefb") ? 2 : 1;
  area.dataset.id = sid;
  area.value = freeDrafts.get(sid) || "";
  area.placeholder = i18n("active.freePlaceholder");
  area.setAttribute("aria-label", i18n("active.freeAria", { n: o.n }));
  const busy = [...dialogAnswers.values()].includes(sid);
  area.readOnly = busy;
  area.addEventListener("input", () => {
    freeDrafts.set(sid, area.value);
    if (cls.includes("freefb")) return;
    autosize(area);
    const card = area.closest(".acard");
    if (card) revealFree(card);
  });
  area.addEventListener("keydown", e => {
    if (e.isComposing) return;
    // The terminal field is one line and Enter there sends: Shift+Enter adds no line here either.
    if (e.key === "Enter") { e.preventDefault(); sendFreeAnswer(s, pid, o); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFree(sid); }
  });
  const send = el("button", "icon send");
  send.appendChild(svgIcon(PLANE_SVG));
  send.type = "button";
  send.title = i18n("active.sendAnswerHint", { n: o.n });
  send.setAttribute("aria-label", i18n("active.sendAnswer"));
  send.disabled = busy;
  send.addEventListener("click", () => sendFreeAnswer(s, pid, o));
  box.append(area, send);
  if (!cls.includes("freefb")) window.setTimeout(() => { if (area.value) autosize(area); }, 0);
  return box;
}

/**
 * Detailed card: the reply field in "answer to the question" mode, in place of the usual one, right
 * under the dialog. null when the mode is off or the option is no longer on screen.
 */
function freeAnswerForm(s, pid) {
  const sid = s.session_id;
  const got = dialogs.get(sid);
  const d = got && got.dialog;
  const o = AtlasLogic.freeTextOption(d);
  if (!o || freeModes.get(sid) !== o.n || !hostReady || !pid || !isWaitingSession(s)) return null;
  const form = el("div", "answer free");
  const head = el("div", "answering");
  head.appendChild(el("span", null, d.agent === "codex" ? i18n("active.answeringCodex")
    : i18n("active.answering", { question: d.question || d.title || "" })));
  const cancel = el("button", "ghost", i18n("active.cancelAnswer"));
  cancel.type = "button";
  cancel.title = i18n("active.cancelAnswerHint");
  cancel.addEventListener("click", () => closeFree(sid));
  head.appendChild(cancel);
  form.append(head, freeField(s, pid, o, "row2"));
  return form;
}

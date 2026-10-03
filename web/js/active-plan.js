// Active: the "plan ready" dialog: read the plan, approve it or send feedback.
// Classic script: shares one global scope with the other page files.
/* exported planBlock -- used by other page scripts */
// The plugin types feedback into the dialog field and presses Enter only after seeing it on the tab's screen.
const planTexts = new Map();          // session id → {name, text, at}
const planDrafts = new Map();         // session id → unfinished feedback
const planForms = new Set();          // cards with the feedback field open
const PLAN_REFRESH_MS = 10000;        // after feedback the agent edits the same file
// [detailed, compact]: in a compact card four buttons must fit on one line.
const PLAN_LABELS = {
  "Yes, auto-accept edits": [i18n("active.planAutoFull"), i18n("active.planAutoShort")],
  "Yes, manually approve edits": [i18n("active.planManualFull"), i18n("active.planManualShort")],
};

async function fetchPlan(s, d) {
  const name = (d.planPath || "").split("/").pop();
  const have = planTexts.get(s.session_id);
  if (have && have.name === name && Date.now() - have.at < PLAN_REFRESH_MS) return;
  planTexts.set(s.session_id, Object.assign({}, have || { text: null }, { name, at: Date.now() }));
  try {
    const r = await api(`/api/active/plan/${encodeURIComponent(s.session_id)}`
      + (d.planPath ? `?path=${encodeURIComponent(d.planPath)}` : ""));
    const changed = !have || have.text !== r.text;
    planTexts.set(s.session_id, { name: r.name, text: r.text, at: Date.now() });
    if (changed) { lastSignature = ""; renderActive(null, true); }
  } catch (e) {
    planTexts.set(s.session_id, { name, text: "", error: e.message, at: Date.now() });
  }
}

function sendPlanFeedback(s, pid, d) {
  const text = (planDrafts.get(s.session_id) || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  const nonce = Math.random().toString(36).slice(2);
  dialogAnswers.set(nonce, s.session_id);
  dialogNotes.set(s.session_id, { note: i18n("active.sendingFeedback"), cls: "" });
  tellTabHost("answer-dialog", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id,
                                 option: d.feedback.n, text: d.feedback.label, feedback: text, nonce });
  planDrafts.delete(s.session_id);
  planForms.delete(s.session_id);
  // While the field has focus cards do not redraw: release it, otherwise the form hangs.
  if (document.activeElement && document.activeElement.matches(".planfb textarea")) document.activeElement.blur();
  lastSignature = "";
  renderActive(null, true);
  window.setTimeout(() => {
    if (!dialogAnswers.has(nonce)) return;
    dialogAnswers.delete(nonce);
    dialogNotes.set(s.session_id, { note: i18n("active.noHostReply"), cls: "bad" });
    renderActive(null, true);
  }, DIALOG_TIMEOUT_MS);
}

function planFeedbackForm(s, pid, d) {
  const form = el("div", "planfb");
  const area = el("textarea");
  area.rows = 2;
  area.dataset.id = s.session_id;
  area.placeholder = i18n("active.planFeedbackPlaceholder");
  area.value = planDrafts.get(s.session_id) || "";
  area.addEventListener("input", () => planDrafts.set(s.session_id, area.value));
  area.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendPlanFeedback(s, pid, d); }
    if (e.key === "Escape") { e.stopPropagation(); planForms.delete(s.session_id); renderActive(null, true); }
  });
  const go = el("button", "primary", i18n("active.sendFeedback"));
  go.type = "button";
  go.title = i18n("active.sendFeedbackHint");
  go.addEventListener("click", () => sendPlanFeedback(s, pid, d));
  form.append(area, go);
  window.setTimeout(() => { if (planForms.has(s.session_id) && document.activeElement !== area) area.focus(); });
  return form;
}

/** Plan dialog block inside .dialog; box is the container already created. */
function planBlock(s, pid, d, full, busy, note, box) {
  fetchPlan(s, d);
  const plan = planTexts.get(s.session_id) || {};
  box.classList.add("plan");
  box.appendChild(el("div", "t", i18n("active.planReady")));
  if (full) {
    const body = el("div", "plantxt md");
    if (plan.text) body.appendChild(renderMarkdown(plan.text));
    else body.appendChild(el("p", "dim", plan.error ? i18n("active.planNotRead", { error: plan.error }) : i18n("active.readingPlan")));
    box.appendChild(body);
  }
  const opts = el("div", "opts");
  d.options.forEach((o, i) => {
    const known = PLAN_LABELS[o.text];
    const b = el("button", i === 0 ? "primary" : null, known ? known[full ? 0 : 1] : `${o.n}. ${o.text}`);
    b.type = "button";
    b.title = known ? i18n("active.planOptionHintKnown", { label: known[0], text: o.text, n: o.n })
      : i18n("active.planOptionHint", { text: o.text, n: o.n });
    b.disabled = busy;
    b.addEventListener("click", () => answerDialogOption(s, pid, o));
    opts.appendChild(b);
  });
  const fix = el("button", planForms.has(s.session_id) ? "on" : null, i18n("active.revise"));
  fix.type = "button";
  fix.title = i18n("active.reviseHint");
  fix.disabled = busy || !d.feedback;
  fix.addEventListener("click", () => {
    if (planForms.has(s.session_id)) planForms.delete(s.session_id); else planForms.add(s.session_id);
    renderActive(null, true);
  });
  opts.appendChild(fix);
  if (!full) {
    const read = el("button", "ghost", i18n("active.plan"));
    read.title = i18n("active.readPlanHint");
    read.type = "button";
    read.disabled = !plan.text;
    read.addEventListener("click", () => {
      modal(i18n("active.plan"), i18n("active.quoted", { text: s.title || s.session_id }) + ` · ${plan.name || ""}`, plan.text || "");
      $("#m-copy").classList.remove("hidden");
    });
    opts.appendChild(read);
  }
  box.appendChild(opts);
  if (planForms.has(s.session_id) && !busy) box.appendChild(planFeedbackForm(s, pid, d));
  if (note) box.appendChild(el("div", "note " + (note.cls || ""), note.note));
  return box;
}

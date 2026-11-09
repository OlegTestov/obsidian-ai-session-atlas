// Active: several questions at once (Claude Code's question tool with 2+ questions). The card shows
// them as tabs, like the terminal: one question at a time, options as buttons (one answer) or
// checkboxes (several), an own typed answer where Claude Code allows one, and a Submit tab with the
// answers. Nothing goes to the tab until "Send the answers": then the plugin answers key by key.
// Classic script: shares one global scope with the other page files.
/* exported multiBlock, multiState -- used by active-dialog.js */
const multiState = new Map();         // session id → {id, tab, answers: [null | {options} | {typed}], typing}
// The plugin waits up to ~3 s for the screen after every key: the page waits for all of them.
const multiTimeout = (d, answers) => 20000 + 4000 * d.questions.reduce((n, q, i) => {
  const a = answers[i] || {};
  return n + (typeof a.typed === "string" ? 3 : (a.options || []).length + 1);
}, 1);

function multiOf(s, d) {
  let st = multiState.get(s.session_id);
  if (!st || st.id !== d.id) {
    st = { id: d.id, tab: 0, answers: d.questions.map(() => null), typing: null, drafts: {} };
    multiState.set(s.session_id, st);
  }
  return st;
}

const multiRedraw = () => { lastSignature = ""; renderActive(null, true); };

function answerText(q, a) {
  if (!a) return "";
  if (typeof a.typed === "string") return a.typed;
  return a.options.map(n => q.options[n - 1].label).join(", ");
}

function sendMulti(s, pid, d, st) {
  const nonce = Math.random().toString(36).slice(2);
  dialogAnswers.set(nonce, s.session_id);
  dialogNotes.set(s.session_id, { note: i18n("active.multiSending"), cls: "" });
  tellTabHost("answer-multi", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id, nonce, id: d.id,
                                answers: st.answers });
  multiRedraw();
  window.setTimeout(() => {
    if (!dialogAnswers.has(nonce)) return;
    dialogAnswers.delete(nonce);
    dialogNotes.set(s.session_id, { note: i18n("active.noHostReply"), cls: "bad" });
    renderActive(null, true);
  }, multiTimeout(d, st.answers));
}

function multiTabs(d, st, busy) {
  const row = el("div", "mtabs");
  const names = d.questions.map(q => q.header).concat(i18n("active.multiSubmitTab"));
  names.forEach((name, i) => {
    const done = i < d.questions.length && !!st.answers[i];
    const b = el("button", [i === st.tab ? "on" : "", done ? "done" : ""].join(" ").trim() || null,
                 (done ? "✓ " : "") + name);
    b.type = "button";
    b.disabled = busy;
    b.title = i < d.questions.length ? d.questions[i].question : i18n("active.multiHint");
    b.addEventListener("click", e => { e.stopPropagation(); st.tab = i; st.typing = null; multiRedraw(); });
    row.appendChild(b);
  });
  return row;
}

function typedField(st, i) {
  const box = el("div", "planfb mtyped");
  const area = el("textarea");
  area.rows = 1;
  area.value = st.drafts[i] || "";
  area.placeholder = i18n("active.multiTypedPlaceholder");
  area.setAttribute("aria-label", i18n("active.multiTyped"));
  area.addEventListener("input", () => { st.drafts[i] = area.value; });
  area.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); st.typing = null; multiRedraw(); }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = area.value.replace(/\s+/g, " ").trim();
      if (!text) return;
      st.answers[i] = { typed: text };
      st.typing = null;
      st.tab = i + 1;
      area.blur();
      multiRedraw();
    }
  });
  box.appendChild(area);
  window.setTimeout(() => area.focus(), 0);
  return box;
}

function questionPane(d, st, full, busy) {
  const i = st.tab;
  const q = d.questions[i];
  const pane = el("div", "mq");
  pane.appendChild(el("div", "q", q.question));
  const opts = el("div", "mopts" + (q.multi ? " multi" : ""));
  const a = st.answers[i];
  q.options.forEach(o => {
    const picked = !!a && Array.isArray(a.options) && a.options.includes(o.n);
    const b = el("button", "mopt" + (picked ? " on" : ""), (q.multi ? (picked ? "☑ " : "☐ ") : "") + `${o.n}. ${o.label}`);
    b.type = "button";
    b.disabled = busy;
    b.title = o.description || o.label;
    b.setAttribute("aria-pressed", picked ? "true" : "false");
    b.addEventListener("click", e => {
      e.stopPropagation();
      if (q.multi) {
        const now = new Set(a && a.options ? a.options : []);
        if (now.has(o.n)) now.delete(o.n); else now.add(o.n);
        st.answers[i] = now.size ? { options: [...now].sort((x, y) => x - y) } : null;
      } else {
        st.answers[i] = { options: [o.n] };
        st.tab = i + 1;                       // as in the tab: one answer moves on
      }
      multiRedraw();
    });
    opts.appendChild(b);
    if (o.description && full) opts.appendChild(el("span", "od", o.description));
  });
  if (q.typed) {
    const typedNow = a && typeof a.typed === "string";
    const b = el("button", "mopt typed" + (typedNow ? " on" : ""),
                 typedNow ? `✎ ${a.typed}` : i18n("active.multiTyped"));
    b.type = "button";
    b.disabled = busy;
    b.addEventListener("click", e => {
      e.stopPropagation();
      st.typing = i;
      if (typedNow) st.drafts[i] = a.typed;
      multiRedraw();
    });
    opts.appendChild(b);
  }
  pane.appendChild(opts);
  if (q.typed && st.typing === i && !busy) pane.appendChild(typedField(st, i));
  if (q.multi) {
    const next = el("button", "mnext", i18n("active.multiNext"));
    next.type = "button";
    next.disabled = busy || !a;
    next.addEventListener("click", e => { e.stopPropagation(); st.tab = i + 1; multiRedraw(); });
    opts.appendChild(next);                 // the last in the options: compact cards keep one row
  }
  return pane;
}

function submitPane(s, pid, d, st, busy) {
  const pane = el("div", "mq msubmit");
  const list = el("div", "msum");
  d.questions.forEach((q, i) => {
    const line = el("div", "msline" + (st.answers[i] ? "" : " missing"));
    line.append(el("b", null, q.header), document.createTextNode(" → " + (answerText(q, st.answers[i]) || "—")));
    list.appendChild(line);
  });
  list.title = d.questions.map((q, i) => `${q.header} → ${answerText(q, st.answers[i]) || "—"}`).join("\n");
  pane.appendChild(list);
  const missing = d.questions.filter((q, i) => !st.answers[i]).map(q => q.header);
  const send = el("button", "primary msend", i18n("active.multiSend"));
  send.type = "button";
  send.disabled = busy || missing.length > 0;
  send.title = missing.length ? i18n("active.multiMissing", { list: missing.join(", ") }) : i18n("active.multiHint");
  send.addEventListener("click", e => { e.stopPropagation(); sendMulti(s, pid, d, st); });
  pane.appendChild(send);
  if (missing.length) pane.appendChild(el("div", "q dim", i18n("active.multiMissing", { list: missing.join(", ") })));
  return pane;
}

/** The block for several questions at once; the reason instead when the card cannot answer them. */
function multiBlock(s, pid, d, full, busy, note, box) {
  box.classList.add("multi");
  box.dataset.view = "multi";
  box.appendChild(el("div", "t", d.title));
  if (!d.answerable) {
    // While the card's own answers are typed, the tabs fill up: that is progress, not "finish in the tab".
    box.appendChild(busy && note ? el("div", "note " + (note.cls || ""), note.note)
                                 : el("div", "q dim", d.reason || i18n("active.dialogTabOnly")));
    return box;
  }
  const st = multiOf(s, d);
  if (st.tab > d.questions.length) st.tab = d.questions.length;
  box.dataset.view = "multi-" + st.tab;
  box.appendChild(multiTabs(d, st, busy));
  box.appendChild(st.tab < d.questions.length ? questionPane(d, st, full, busy) : submitPane(s, pid, d, st, busy));
  if (note) box.appendChild(el("div", "note " + (note.cls || ""), note.note));
  return box;
}

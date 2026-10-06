// A Claude Code dialog on the terminal tab's screen: a permission or a question with options.
// While a dialog is open, the transcript has no call yet, so the screen is the only source.
// Lines are as xterm returns them (`translateToString`), checked against recorded live output.

const RULE = /^\s*─{8,}\s*$/;
const FOOTER = /Esc to cancel/;
const OPTION = /^(\s*)(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const MAX_DETAIL_LINES = 12;
// A question's last answer above the separator is a text field: its digit only puts the cursor
// there, typed text replaces the label in the option line and Enter sends it (checked on the CLI).
// "Chat about this" below the separator is an ordinary option: it declines the question at once.
const FREE_TEXT_LABEL = "Type something.";
const CHAT = /^Chat about this/;

// The plan-mode exit dialog has no "Esc to cancel" footer, but the plan file path sits at the
// bottom. The last option is an input field: the digit only puts the cursor in it, the text is
// typed right into the option line, and Enter rejects the plan with that text (checked on the CLI).
const PLAN_PATH = /(~\/\.claude\/plans\/[\w.-]+\.md)/;
const PLAN_ASK = /Would you like to|proceed\?|Ready to code\?/;   // the question wraps onto two lines
const PLAN_OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const FEEDBACK_HINT = /shift\+tab to approve with this feedback/;
const FEEDBACK_LABEL = "Tell Claude what to change";
const PLAN_END = /ctrl\+g to edit|~\/\.claude\/plans\//;

// A question with a preview per option (checked on Claude Code 2.1.291): options on the left, a framed
// preview of the highlighted one on the right, "Notes:" under the frame, an unnumbered "Chat about this"
// below the separator. Here a digit only moves the highlight (and the preview); Enter answers the
// highlighted option, n opens a note that Enter sends along with it.
const BOX_TOP = /┌─{3,}┐/;
const BOX_BOTTOM = /└─{3,}┘/;
const NOTES = /^Notes:\s?(.*)$/;
const NOTES_EMPTY = /^press n to add notes$/;
const NOTES_PLACEHOLDER = /^Add notes on this/;
const NOTES_EDITING = /ctrl\+g to edit/;
const CHAT_ROW = /^\s*(❯\s*)?Chat about this\s*$/;

function parsePreviewQuestion(rows, footer) {
  let top = -1;
  for (let i = footer - 1; i >= 0 && footer - i <= 60; i--) {
    if (BOX_TOP.test(rows[i])) { top = i; break; }
  }
  if (top < 0) return null;
  const col = rows[top].indexOf("┌");
  let bottom = -1;
  for (let i = top + 1; i < footer; i++) if (BOX_BOTTOM.test(rows[i])) { bottom = i; break; }
  if (bottom < 0 || col < 4) return null;
  let start = -1;
  for (let i = top; i >= 0 && top - i <= 20; i--) if (RULE.test(rows[i])) { start = i; break; }
  if (start < 0) return null;
  // Rows split at the frame's left edge: the option column, and the frame or the notes line.
  const left = (row) => row.slice(0, col).replace(/\s+$/, "");
  const right = (row) => row.slice(col);
  const options = [];
  let highlighted = null;
  let firstOption = -1;
  for (let i = start + 1; i < footer && !RULE.test(rows[i]); i++) {
    const m = OPTION.exec(left(rows[i]));
    if (m && Number(m[3]) === options.length + 1) {
      if (firstOption < 0) firstOption = i;
      options.push({ n: Number(m[3]), text: m[4], detail: "" });
      if (m[2]) highlighted = Number(m[3]);
    } else if (options.length && left(rows[i]).trim()) {
      options[options.length - 1].text += " " + left(rows[i]).trim();   // a long label wraps in its column
    }
  }
  if (!options.length || highlighted === null) return null;
  const head = rows.slice(start + 1, Math.min(firstOption, top)).map((l) => l.trim()).filter(Boolean);
  const tabs = head.length && /^(←\s*)?[☐☒✔]/.test(head[0]) ? head[0] : null;
  if (!tabs) return null;
  const lines = [];
  for (let i = top + 1; i < bottom; i++) {
    const inner = right(rows[i]);
    const end = inner.lastIndexOf("│");
    lines.push((end > 0 ? inner.slice(1, end) : inner.slice(1)).replace(/^ /, "").replace(/\s+$/, ""));
  }
  let notes = null;
  for (let i = bottom + 1; i < footer && !RULE.test(rows[i]); i++) {
    const m = NOTES.exec(right(rows[i]).trim());
    if (m) { notes = m[1].trim(); break; }
  }
  const footerText = rows.slice(footer - 1, footer + 2).join(" ");
  const editing = NOTES_EDITING.test(footerText);
  const noteText = notes === null || NOTES_EMPTY.test(notes) || NOTES_PLACEHOLDER.test(notes) ? "" : notes;
  let chat = null;
  for (let i = bottom + 1; i < footer + 1 && i < rows.length; i++) {
    const m = CHAT_ROW.exec(rows[i]);
    if (m) { chat = { selected: !!m[1] }; break; }
  }
  const multi = /Submit/.test(tabs) || (tabs.match(/[☐☒✔]/g) || []).length > 1;
  return {
    kind: "question",
    title: tabs.replace(/[←→]/g, "").split(/[☐☒✔]/).map((t) => t.trim()).filter((t) => t && t !== "Submit").join(" · "),
    details: [],
    question: head.slice(1).join(" "),
    options,
    pick: "enter",                              // a digit only moves the highlight; Enter answers
    highlighted,
    preview: { n: highlighted, lines },
    notes: notes === null ? null : { editing, text: noteText },
    chat,
    answerable: !multi,
    reason: multi ? "dialog.multi" : null,
  };
}

function parsePlanDialog(rows) {
  let pathRow = -1;
  let planPath = null;
  let end = rows.length;                       // a fresh session draws at the top, empty lines below
  while (end > 0 && !rows[end - 1].trim()) end--;
  for (let i = end - 1; i >= 0 && end - i <= 8; i--) {
    const m = PLAN_PATH.exec(rows[i]);
    if (m) { pathRow = i; planPath = m[1]; break; }
  }
  if (pathRow < 0) return null;
  let first = -1;
  for (let i = pathRow - 1; i >= 0 && pathRow - i <= 30; i--) {
    const m = PLAN_OPTION.exec(rows[i]);
    if (m && m[2] === "1") { first = i; break; }
  }
  if (first < 0 || !rows.slice(Math.max(0, first - 4), first).some((r) => PLAN_ASK.test(r))) return null;
  const options = [];
  let feedback = null;
  for (let i = first; i < pathRow; i++) {
    const row = rows[i];
    if (PLAN_END.test(row)) break;
    const m = PLAN_OPTION.exec(row);
    if (m && Number(m[2]) === options.length + 1) {
      options.push({ n: Number(m[2]), text: m[3], selected: !!m[1] });
    } else if (FEEDBACK_HINT.test(row) && options.length) {
      feedback = options.pop();                       // the input field line sits above the hint
    } else if (row.trim() && options.length) {
      options[options.length - 1].text += " " + row.trim();   // a wrapped long line
    }
  }
  if (!feedback || !options.length) return null;
  return {
    kind: "plan", title: "dialog.planReady", details: [], question: "", planPath,
    options: options.map((o) => ({ n: o.n, text: o.text, detail: "" })),
    // Until something is typed, the line shows the label; typed text replaces it.
    feedback: { n: feedback.n, label: FEEDBACK_LABEL, selected: feedback.selected,
                typed: feedback.text === FEEDBACK_LABEL ? "" : feedback.text },
    answerable: true, reason: null,
  };
}

/**
 * lines: screen lines, top to bottom. null when there is no dialog.
 * {kind, title, details[], question, options[{n, text, detail}], answerable, reason}
 * A plan's title and the reason are i18n keys; the plugin translates them before answering.
 */
function parseDialog(lines) {
  if (!Array.isArray(lines)) return null;
  const rows = lines.map((l) => String(l || "").replace(/\s+$/, ""));
  const plan = parsePlanDialog(rows);
  if (plan) return plan;
  let end = rows.length;                       // a fresh session draws at the top, empty lines below
  while (end > 0 && !rows[end - 1].trim()) end--;
  let footer = -1;
  for (let i = end - 1; i >= 0 && end - i <= 6; i--) {
    if (FOOTER.test(rows[i])) { footer = i; break; }
  }
  if (footer < 0) return null;
  const preview = parsePreviewQuestion(rows, footer);
  if (preview) return preview;
  // The first "1." option above the footer; the block starts at the rule above it.
  let first = -1;
  for (let i = footer - 1; i >= 0 && footer - i <= 40; i--) {
    const m = OPTION.exec(rows[i]);
    if (m && m[3] === "1") { first = i; break; }
  }
  if (first < 0) return null;
  let start = -1;
  for (let i = first - 1; i >= 0 && first - i <= 40; i--) {
    if (RULE.test(rows[i])) { start = i; break; }
  }
  if (start < 0) return null;

  const options = [];
  let beforeRule = -1;                         // the option the separator rule follows
  for (let i = first; i < footer; i++) {
    const row = rows[i];
    if (!row.trim()) continue;
    if (RULE.test(row)) {
      if (options.length && beforeRule < 0) beforeRule = options.length - 1;
      continue;
    }
    const m = OPTION.exec(row);
    if (m && Number(m[3]) === options.length + 1) {
      options.push({ n: Number(m[3]), text: m[4], detail: "", selected: !!m[2] });
    } else if (options.length) {
      const last = options[options.length - 1];
      last.detail = (last.detail ? last.detail + " " : "") + row.trim();
    }
  }
  const head = rows.slice(start + 1, first).map((l) => l.trim()).filter(Boolean);
  const tabs = head.length && /^(←\s*)?[☐☒✔]/.test(head[0]) ? head[0] : null;
  const kind = tabs ? "question" : "permission";
  let title = "";
  let question = "";
  let details = [];
  if (kind === "question") {
    // "← ☐ Colour  ☐ Fruits  ✔ Submit →" → "Colour · Fruits"
    title = tabs.replace(/[←→]/g, "").split(/[☐☒✔]/).map((t) => t.trim())
      .filter((t) => t && t !== "Submit").join(" · ");
    question = head.slice(1).join(" ");
  } else {
    const ask = head.findIndex((l) => /^Do you want/.test(l));
    title = head[0] || "";
    question = ask >= 0 ? head[ask] : "";
    details = head.slice(1, ask >= 0 ? ask : head.length)
      .filter((l) => !/^╌+$/.test(l)).slice(0, MAX_DETAIL_LINES);
  }
  // In a permission a continuation line wraps a long label; in a question it describes the option.
  if (kind === "permission") {
    options.forEach((o) => { if (o.detail) { o.text += " " + o.detail; o.detail = ""; } });
  }
  // The text field: its label, or whatever was typed over it, right above "─── Chat about this".
  const chat = beforeRule >= 0 && options[beforeRule + 1] && CHAT.test(options[beforeRule + 1].text);
  const free = kind !== "question" ? null
    : chat ? options[beforeRule] : options.find((o) => o.text === FREE_TEXT_LABEL);
  const choices = options.map((o) => {
    if (o !== free) return { n: o.n, text: o.text, detail: o.detail };
    const typed = o.text === FREE_TEXT_LABEL ? "" : [o.text, o.detail].filter(Boolean).join(" ");
    return { n: o.n, text: FREE_TEXT_LABEL, detail: "", freeText: true, selected: o.selected, typed };
  });
  // Several questions at once: digits toggle checkboxes and tabs instead of answering.
  const multi = !!tabs && (/Submit/.test(tabs) || (tabs.match(/[☐☒✔]/g) || []).length > 1);
  return {
    kind,
    title,
    details,
    question,
    options: choices,
    answerable: !multi && choices.length > 0,
    reason: multi ? "dialog.multi" : null,
  };
}

/**
 * Whether the option under this number is unchanged; checked before the key press in case the screen
 * changed. A text field is never pressed alone: its digit only moves the cursor into it.
 */
function sameOption(dialog, n, text) {
  if (!dialog || !dialog.answerable) return false;
  const option = dialog.options.find((o) => o.n === n);
  return !!option && !option.freeText && option.text === text;
}

/** Where typed text goes: the plan's feedback line or a question's text field. {n, label, selected, typed} or null. */
function textField(dialog) {
  if (!dialog || !dialog.answerable) return null;
  if (dialog.kind === "plan") return dialog.feedback || null;
  const o = dialog.kind === "question" ? dialog.options.find((x) => x.freeText) : null;
  return o ? { n: o.n, label: o.text, selected: o.selected, typed: o.typed } : null;
}

const PANEL_RULE = /^\s*▔{8,}\s*$/;
const MAX_OUTPUT_LINES = 60;

const trimBlank = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/**
 * What a slash command showed: for an open panel (/usage, /effort without an argument, /goal),
 * everything below its top ▔▔▔ rule; otherwise the text above the input field, after the
 * "❯ /command" echo when visible (a long /context pushes it off the top). {text, panel} or null.
 */
function extractCommandOutput(lines, command) {
  if (!Array.isArray(lines)) return null;
  const rows = lines.map((l) => String(l || "").replace(/\s+$/, ""));
  let panel = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PANEL_RULE.test(rows[i])) { panel = i; break; }
  }
  let body;
  if (panel >= 0) {
    body = rows.slice(panel + 1);
  } else {
    // The input field is "────", "❯ …", "────" at the bottom; everything above is output.
    let promptRule = -1;
    for (let i = rows.length - 1; i >= 1; i--) {
      if (RULE.test(rows[i - 1]) && /^❯/.test(rows[i])) { promptRule = i - 1; break; }
    }
    body = promptRule >= 0 ? rows.slice(0, promptRule) : rows;
    const cmd = String(command || "").trim();
    for (let i = body.length - 1; i >= 0 && cmd; i--) {
      if (body[i].replace(/^❯\s*/, "").trim() === cmd && /^❯/.test(body[i])) {
        body = body.slice(i + 1);
        break;
      }
    }
  }
  // "⎿" marks a command reply in Claude Code; the card does not need it.
  body = trimBlank(body.map((l) => l.replace(/^(\s*)⎿ {1,2}/, "$1"))).slice(-MAX_OUTPUT_LINES);
  if (!body.length) return null;
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return { text: body.map((l) => l.slice(indent)).join("\n"), panel: panel >= 0 };
}

/** Typed text vs. the screen: the field wraps long text, and spaces at the wrap points get lost. */
const squash = (text) => String(text || "").replace(/\s+/g, "");

export { parseDialog, sameOption, textField, extractCommandOutput, squash, FEEDBACK_LABEL, FREE_TEXT_LABEL };

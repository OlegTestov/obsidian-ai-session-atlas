// A Claude Code dialog on the terminal tab's screen: a permission or a question with options.
// While a dialog is open, the transcript has no call yet, so the screen is the only source.
// Lines are as xterm returns them (`translateToString`), checked against recorded live output.

const RULE = /^\s*─{8,}\s*$/;
const FOOTER = /Esc to cancel/;
const OPTION = /^(\s*)(?:❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
// These options wait for typed text: a digit from the card cannot choose them.
const NEEDS_TEXT = /^(Type something|Chat about this)/;
const MAX_DETAIL_LINES = 12;

// The plan-mode exit dialog has no "Esc to cancel" footer, but the plan file path sits at the
// bottom. The last option is an input field: the digit only puts the cursor in it, the text is
// typed right into the option line, and Enter rejects the plan with that text (checked on the CLI).
const PLAN_PATH = /(~\/\.claude\/plans\/[\w.-]+\.md)/;
const PLAN_ASK = /Would you like to|proceed\?|Ready to code\?/;   // the question wraps onto two lines
const PLAN_OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const FEEDBACK_HINT = /shift\+tab to approve with this feedback/;
const FEEDBACK_LABEL = "Tell Claude what to change";
const PLAN_END = /ctrl\+g to edit|~\/\.claude\/plans\//;

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
  let footer = -1;
  for (let i = rows.length - 1; i >= 0 && rows.length - i <= 6; i--) {
    if (FOOTER.test(rows[i])) { footer = i; break; }
  }
  if (footer < 0) return null;
  // The first "1." option above the footer; the block starts at the rule above it.
  let first = -1;
  for (let i = footer - 1; i >= 0 && footer - i <= 40; i--) {
    const m = OPTION.exec(rows[i]);
    if (m && m[2] === "1") { first = i; break; }
  }
  if (first < 0) return null;
  let start = -1;
  for (let i = first - 1; i >= 0 && first - i <= 40; i--) {
    if (RULE.test(rows[i])) { start = i; break; }
  }
  if (start < 0) return null;

  const options = [];
  for (let i = first; i < footer; i++) {
    const row = rows[i];
    if (!row.trim() || RULE.test(row)) continue;
    const m = OPTION.exec(row);
    if (m && Number(m[2]) === options.length + 1) {
      options.push({ n: Number(m[2]), text: m[3], detail: "" });
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
  const choices = options.filter((o) => !NEEDS_TEXT.test(o.text));
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

/** Whether the option under this number is unchanged; checked before the key press in case the screen changed. */
function sameOption(dialog, n, text) {
  if (!dialog || !dialog.answerable) return false;
  const option = dialog.options.find((o) => o.n === n);
  return !!option && option.text === text;
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

export { parseDialog, sameOption, extractCommandOutput, squash, FEEDBACK_LABEL };

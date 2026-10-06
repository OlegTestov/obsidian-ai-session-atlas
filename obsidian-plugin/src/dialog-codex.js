// Codex screens in the terminal tab: approvals, questions and other choices, busy or idle.
// Codex writes no approval into its rollout while it waits, so the screen is the only source, as
// for Claude Code. Checked against live codex-cli 0.160.0 screens (tools/fixtures/codex_screens.json).

// The selection views end with one of these hints; without it a numbered list is just text.
const FOOTER = /^\s*(Press enter to confirm or esc to cancel|enter select · esc back|enter\/esc confirm|tab to add notes \| enter to submit)/;
const OPTION = /^(\s*)(›\s+)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const KEY_HINT = /\s+\((esc|tab|[a-z])\)$/;
const ASK = /^\s*Would you like to (.+\?)\s*$/;
const QUESTION = /^\s*Question (\d+)\/(\d+)\b/;
// The decline option ends the turn; the person then types what to do instead into the composer.
const FEEDBACK = /^No, and tell Codex what to do differently/;
const WORKING = /esc to interrupt\)/;           // "• Working (5s • esc to interrupt)"
const COMPOSER = /^› /;
const MAX_DETAIL_LINES = 12;
const MAX_OUTPUT_LINES = 60;

// Approval kinds by question: the page shows "permission" as a permission request.
const KINDS = [
  [/run the following command\?/, "permission", "Shell command"],
  [/make the following edits\?/, "edit", "File edits"],
  [/grant these permissions\?/, "network", "Permissions"],
  [/send input to the existing terminal\?/, "permission", "Terminal input"],
];

const clean = (lines) => (Array.isArray(lines) ? lines : []).map((l) => String(l || "").replace(/\s+$/, ""));

function footerRow(rows) {
  for (let i = rows.length - 1; i >= 0 && rows.length - i <= 4; i--) {
    if (FOOTER.test(rows[i])) return i;
  }
  return -1;
}

/** The option rows right above the footer: one block, no blank line inside, "1." first. */
function optionBlock(rows, footer) {
  let end = footer;
  while (end > 0 && !rows[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && rows[start - 1].trim()) start--;
  const first = OPTION.exec(rows[start] || "");
  if (start === end || !first || first[3] !== "1") return null;
  const col = first[1].length + (first[2] || "").length;     // where the number stands
  const options = [];
  for (let i = start; i < end; i++) {
    const m = OPTION.exec(rows[i]);
    const at = m ? m[1].length + (m[2] || "").length : -1;
    if (m && at === col && Number(m[3]) === options.length + 1) {
      options.push({ n: Number(m[3]), text: m[4], selected: !!m[2] });
    } else if (options.length) {
      options[options.length - 1].text += " " + rows[i].trim();   // a wrapped long label
    }
  }
  return { start, options };
}

/**
 * lines: screen lines, top to bottom. null when no selection view is open. The shape is the one
 * parseDialog gives for Claude Code, so the card renders it unchanged:
 * {kind, title, details[], question, options[{n, text, detail, key}], answerable, reason, feedback}
 */
function parseCodexDialog(lines) {
  const rows = clean(lines);
  const footer = footerRow(rows);
  if (footer < 0) return null;
  const block = optionBlock(rows, footer);
  if (!block) return null;
  const above = rows.slice(Math.max(0, block.start - 30), block.start);
  // The footer tells the view apart: an approval, a question from the model, or another choice.
  const approval = /^\s*Press enter to confirm/.test(rows[footer]);
  const askAt = approval ? above.map((l) => ASK.test(l)).lastIndexOf(true) : -1;
  const qAt = /enter to submit/.test(rows[footer]) ? above.map((l) => QUESTION.test(l)).lastIndexOf(true) : -1;
  let kind, title, question, details = [], columns = true;
  if (askAt >= 0) {
    question = above[askAt].trim();
    const known = KINDS.find(([re]) => re.test(question));
    kind = known ? known[1] : "permission";
    title = known ? known[2] : question;
    details = above.slice(askAt + 1).map((l) => l.trim()).filter(Boolean).slice(0, MAX_DETAIL_LINES);
    columns = false;                                  // approval labels have no description column
  } else if (qAt >= 0) {
    const m = QUESTION.exec(above[qAt]);
    kind = "question";
    title = `Question ${m[1]}/${m[2]}`;
    question = above.slice(qAt + 1).map((l) => l.trim()).filter(Boolean).join(" ");
  } else {
    // Any other choice (implement the plan, switch the model): the lines just above the options.
    const head = [];
    let i = above.length - 1;
    while (i >= 0 && !above[i].trim() && above.length - i <= 3) i--;
    for (; i >= 0 && above[i].trim() && head.length < 4; i--) head.unshift(above[i].trim());
    if (!head.length) return null;
    kind = "choice";
    title = head[0];
    question = head.slice(1).join(" ");
  }
  const options = block.options.map((o) => {
    let text = o.text;
    let detail = "";
    if (columns) {
      const parts = text.split(/\s{2,}/);
      text = parts[0];
      detail = parts.slice(1).join(" ");
    }
    const hint = KEY_HINT.exec(text);
    if (hint) text = text.slice(0, hint.index);
    return { n: o.n, text, detail, key: hint ? hint[1] : "", selected: o.selected };
  });
  const q = qAt >= 0 ? QUESTION.exec(above[qAt]) : null;
  const multi = !!q && Number(q[2]) > 1;           // a digit answers one question and moves to the next
  const decline = options.find((o) => FEEDBACK.test(o.text));
  return {
    kind,
    title,
    details,
    question,
    options: options.map(({ n, text, detail, key }) => ({ n, text, detail, key })),
    answerable: !multi && options.length > 0,
    reason: multi ? "dialog.multi" : null,
    feedback: decline ? { n: decline.n, label: decline.text, selected: decline.selected, typed: "" } : null,
    agent: "codex",
  };
}

/** The composer row ("› …") near the bottom, or -1; checked only when no selection view is open. */
function composerRow(rows) {
  for (let i = rows.length - 1; i >= 0 && rows.length - i <= 10; i--) {
    if (COMPOSER.test(rows[i])) return i;
  }
  return -1;
}

/** Text in the composer: its first row and the wrapped rows under it, up to the blank line. */
function composerText(lines) {
  const rows = clean(lines);
  if (parseCodexDialog(rows)) return null;
  const at = composerRow(rows);
  if (at < 0) return null;
  const parts = [rows[at].slice(2)];
  for (let i = at + 1; i < rows.length && rows[i].trim(); i++) parts.push(rows[i].trim());
  return parts.join(" ").trim();
}

/** "waiting" (a selection view), "busy" (a turn runs), "idle" (the composer), or null when unknown. */
function codexScreenState(lines) {
  const rows = clean(lines);
  if (parseCodexDialog(rows)) return "waiting";
  if (rows.slice(-15).some((l) => WORKING.test(l))) return "busy";
  return composerRow(rows) >= 0 ? "idle" : null;
}

/** What a slash command printed: the rows between its echo and the composer. {text, panel} or null. */
function extractCodexCommandOutput(lines, command) {
  const rows = clean(lines);
  const at = composerRow(rows);
  if (at < 0 || parseCodexDialog(rows)) return null;
  const cmd = String(command || "").trim();
  let body = rows.slice(0, at);
  const echo = cmd ? body.map((l) => l.trim() === cmd).lastIndexOf(true) : -1;
  if (echo < 0) return null;
  body = body.slice(echo + 1);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  body = body.slice(-MAX_OUTPUT_LINES);
  if (!body.length) return null;
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return { text: body.map((l) => l.slice(indent)).join("\n"), panel: false };
}

export { parseCodexDialog, codexScreenState, composerText, extractCodexCommandOutput };

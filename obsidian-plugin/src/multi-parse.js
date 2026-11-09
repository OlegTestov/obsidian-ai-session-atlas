// Several questions at once (Claude Code's question tool with 2+ questions): tabs across the top and
// a Submit tab. The screen shows one question at a time, so the questions and their options come from
// the transcript, where the tool call is written before the answer; the screen says where the dialog is.
// Key protocol, measured on Claude Code 2.1.319 (tools/live/capture_multi.mjs):
//   one answer: its digit picks the option and moves to the next tab;
//   several answers: a digit toggles a checkbox, → moves to the next tab;
//   a typed answer (one-answer questions only): the "Type something." digit puts the cursor there,
//     the text is typed into the option line, Enter takes it and moves on;
//   the Submit tab lists the answers ("Review your answers"), its 1 sends them all.
import * as fs from "fs";
import * as path from "path";
import { PROJECTS_DIR, SESSION_ID } from "./constants";
import { squash } from "./dialog";

const TAIL_BYTES = 524288;
const TABS = /^\s*←\s+.*✔\s*Submit\s+→\s*$/;
const MARK = /([☐☒])\s+/g;
const OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(?:\[([ ✔])\]\s+)?(\S.*?)\s*$/;
const FOOTER = /Esc to cancel/;
const TYPE_LABEL = /^Type something\.?$/;
const CHAT = /^Chat about this/;

/** The tab names and which have an answer: "←  ☒ Colour  ☐ Fruits  ✔ Submit  →". */
function parseTabs(line) {
  const body = line.replace(/^\s*←/, "").replace(/✔\s*Submit\s+→\s*$/, "");
  const marks = [...body.matchAll(MARK)];
  return marks.map((m, i) => ({
    name: body.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : body.length).trim(),
    done: m[1] === "☒",
  }));
}

/**
 * Where a several-questions dialog is on the screen: {tabs, review: null | [{question, answer}],
 * question, options: [{n, text, more: [rows under it], checked, selected}]}, or null when there is none.
 */
function parseMultiScreen(rows) {
  let at = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (TABS.test(rows[i])) { at = i; break; }
  if (at < 0) return null;
  const tabs = parseTabs(rows[at]);
  const below = rows.slice(at + 1).map((r) => r.replace(/\s+$/, ""));
  if (below.some((r) => r.trim() === "Review your answers")) {
    const review = [];
    let field = null;                            // a long question or answer wraps onto the next rows
    for (const row of below) {
      const q = /^\s*●\s+(.*)$/.exec(row);
      const a = /^\s*→\s+(.*)$/.exec(row);
      if (q) { review.push({ question: q[1].trim(), answer: "" }); field = "question"; }
      else if (a && review.length) { review[review.length - 1].answer = a[1].trim(); field = "answer"; }
      else if (/^\s*Ready to submit/.test(row) || OPTION.test(row)) field = null;
      else if (field && row.trim() && review.length) review[review.length - 1][field] += " " + row.trim();
    }
    const submit = below.map((r) => OPTION.exec(r)).find((m) => m && m[4] === "Submit answers");
    return { tabs, review, question: "", options: submit ? [{ n: Number(submit[2]), text: submit[4], more: [],
      checked: false, selected: !!submit[1] }] : [] };
  }
  const options = [];
  const question = [];
  let last = null;                               // rows under an option: its description, or a typed text that wraps
  for (const row of below) {
    if (FOOTER.test(row)) continue;
    if (/^\s*─{8,}\s*$/.test(row)) { last = null; continue; }
    const m = OPTION.exec(row);
    if (m && Number(m[2]) === options.length + 1) {
      last = { n: Number(m[2]), text: m[4], more: [], checked: m[3] === "✔", selected: !!m[1] };
      options.push(last);
    } else if (!options.length && row.trim()) {
      question.push(row.trim());
    } else if (last && row.trim()) {
      last.more.push(row.trim());
    }
  }
  return { tabs, review: null, question: question.join(" "), options };
}

/** The transcript of a session: <projects>/<any folder>/<id>.jsonl, or null. */
function transcriptPath(sessionId, root = PROJECTS_DIR) {
  if (!SESSION_ID.test(sessionId || "")) return null;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
  }
  return null;
}

/** The questions of the session's last question tool call that has no answer yet, or null. */
function pendingQuestions(text) {
  let last = null;
  const answered = new Set();
  for (const line of String(text).split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }      // a cut first line, or one being written
    const content = row && row.message && Array.isArray(row.message.content) ? row.message.content : [];
    for (const c of content) {
      if (c && c.type === "tool_use" && c.name === "AskUserQuestion" && c.input) last = c;
      if (c && c.type === "tool_result" && c.tool_use_id) answered.add(c.tool_use_id);
    }
  }
  if (!last || answered.has(last.id)) return null;
  const questions = Array.isArray(last.input.questions) ? last.input.questions : [];
  return questions.length ? { id: last.id, questions } : null;
}

/** root: Claude Code's projects folder (tests point it elsewhere; undefined = the real one). */
function readPending(sessionId, root = PROJECTS_DIR) {
  const file = transcriptPath(sessionId, root);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return pendingQuestions(tail.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The dialog for the card: the transcript's questions, checked against the screen (the same tab names
 * in the same order). Options with previews are not handled here: they stay "answer in the tab".
 * {kind: "multi", title, questions: [{header, question, multi, options: [{n, label, description}],
 * typed: n | null}], fresh, answerable, reason} or null when they do not match.
 */
function multiDialog(pending, screen) {
  if (!pending || !screen) return null;
  const qs = pending.questions;
  if (screen.tabs.length !== qs.length) return null;
  if (qs.some((q, i) => squash(String(q.header || "")) !== squash(screen.tabs[i].name))) return null;
  const previews = qs.some((q) => (q.options || []).some((o) => o && o.preview));
  const questions = qs.map((q) => {
    const options = (q.options || []).map((o, i) => ({ n: i + 1, label: String(o.label || ""),
                                                        description: String(o.description || "") }));
    return { header: String(q.header || ""), question: String(q.question || ""), multi: q.multiSelect === true,
             options, typed: q.multiSelect === true ? null : options.length + 1 };
  });
  // Answered from the start only: a dialog half answered in the tab is finished there.
  const fresh = !screen.review && screen.tabs.every((t) => !t.done) && squash(screen.question) === squash(questions[0].question);
  return {
    kind: "multi",
    id: pending.id,
    title: questions.map((q) => q.header).join(" · "),
    questions,
    answerable: fresh && !previews,
    reason: previews ? "dialog.multiPreview" : fresh ? null : "dialog.multiStarted",
  };
}

/** What the Submit tab should list for an answer: the label, the typed text, or the labels toggled. */
function expectedAnswer(question, answer) {
  if (typeof answer.typed === "string") return answer.typed;
  const labels = (answer.options || []).map((n) => question.options[n - 1].label);
  return labels.join(", ");
}

export { parseMultiScreen, parseTabs, pendingQuestions, readPending, transcriptPath, multiDialog, expectedAnswer,
         TYPE_LABEL, CHAT };

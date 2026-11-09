// Answers several questions at once from the card, key by key, re-reading the screen after each key
// (protocol in multi-parse.js). Nothing reaches Claude Code before the Submit tab's 1: if any step
// does not show what was asked for, the keys stop and the person finishes the dialog in the tab.
// Mixed into the plugin class.
import { cleanInput } from "./terminal";
import { squash } from "./dialog";
import { parseMultiScreen, readPending, multiDialog, expectedAnswer, TYPE_LABEL } from "./multi-parse";

const RIGHT = "\x1b[C";
const STEP_POLL_MS = 100;
const STEP_WAIT_MS = 3000;
const MAX_TYPED_CHARS = 2000;
const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** The answers as sent by the page, checked against the questions; null when malformed. */
function checkAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) return null;
  const out = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const a = answers[i] || {};
    if (typeof a.typed === "string") {
      const typed = cleanInput(a.typed).replace(/\s+/g, " ").trim();
      if (q.multi || !typed || typed.length > MAX_TYPED_CHARS) return null;
      out.push({ typed });
      continue;
    }
    const picked = Array.isArray(a.options) ? [...new Set(a.options)].sort((x, y) => x - y) : [];
    if (!picked.length || picked.some((n) => !Number.isInteger(n) || n < 1 || n > q.options.length)) return null;
    if (!q.multi && picked.length !== 1) return null;
    out.push({ options: picked });
  }
  return out;
}

class MultiQuestionMethods {
  /** The several-questions dialog for the card, or null when the screen shows none (or it does not match). */
  readMulti(sessionId, lines) {
    const screen = parseMultiScreen(lines);
    if (!screen) return null;
    const dialog = multiDialog(readPending(sessionId, this.transcriptsRoot), screen);
    return dialog ? { ...dialog, reason: dialog.reason && this.t(dialog.reason) } : null;
  }

  /** Waits until the re-read screen passes the test; the screen it passed on, or null. */
  async seenMulti(tab, test) {
    for (let waited = 0; waited <= STEP_WAIT_MS; waited += STEP_POLL_MS) {
      await pause(STEP_POLL_MS);
      const screen = parseMultiScreen(this.screenLines(tab.leaf));
      if (screen && test(screen)) return screen;
    }
    return null;
  }

  async answerMulti(target, data) {
    const reply = (ok, reason) => this.answerPage(target, { type: "answered", ok, reason: reason || null,
      sessionId: data.sessionId, nonce: data.nonce });
    // One run per session at a time: two runs would type into each other's questions.
    const running = this.multiRunning || (this.multiRunning = new Set());
    if (running.has(data.sessionId)) return reply(false, this.t("input.multiBusy"));
    running.add(data.sessionId);
    try {
      return await this.typeMulti(data, reply);
    } catch (e) {
      console.warn("[session-atlas] several questions: answering stopped", e);
      return reply(false, this.t("input.multiStopped"));
    } finally {
      running.delete(data.sessionId);
    }
  }

  async typeMulti(data, reply) {
    if (typeof data.id !== "string" || !Array.isArray(data.answers)) return reply(false, this.t("input.badRequest"));
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(false, error);
    if (state.status !== "waiting" || state.agent === "codex") return reply(false, this.t("input.dialogClosed"));
    const screen = parseMultiScreen(this.screenLines(tab.leaf));
    const dialog = multiDialog(readPending(data.sessionId, this.transcriptsRoot), screen);
    if (!dialog || dialog.id !== data.id || !dialog.answerable) return reply(false, this.t("input.dialogChanged"));
    const answers = checkAnswers(dialog.questions, data.answers);
    if (!answers) return reply(false, this.t("input.badRequest"));
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    const qs = dialog.questions;
    const on = (i) => (s) => !s.review && squash(s.question) === squash(qs[i].question);
    const option = (s, n) => s.options.find((o) => o.n === n);
    const lineText = (o) => squash([o.text, ...(o.more || [])].join(" "));
    // Moved on: this tab has an answer, and the next question (or the Submit tab) is on screen.
    const movedOn = (i) => (s) => s.tabs[i] && s.tabs[i].done && (i + 1 < qs.length ? on(i + 1)(s) : !!s.review);
    // Right before a key: the screen still shows question i (keys typed elsewhere would have moved it).
    const still = (i, fresh) => {
      const s = parseMultiScreen(this.screenLines(tab.leaf));
      return !!s && on(i)(s) && (!fresh || !s.tabs[i].done);
    };
    const stop = () => reply(false, this.t("input.multiStopped"));
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const a = answers[i];
      if (!still(i, true)) return stop();
      if (a.typed !== undefined) {
        stdin.write(String(q.typed));
        if (!(await this.seenMulti(tab, (s) => on(i)(s) && option(s, q.typed) && option(s, q.typed).selected
                                     && TYPE_LABEL.test(option(s, q.typed).text)))) return stop();
        stdin.write(a.typed);
        if (!(await this.seenMulti(tab, (s) => on(i)(s) && option(s, q.typed)
                                     && lineText(option(s, q.typed)) === squash(a.typed)))) return stop();
        if (!still(i)) return stop();
        stdin.write("\r");
      } else if (!q.multi) {
        stdin.write(String(a.options[0]));
      } else {
        for (const n of a.options) {
          if (!still(i)) return stop();
          stdin.write(String(n));
          if (!(await this.seenMulti(tab, (s) => on(i)(s) && option(s, n) && option(s, n).checked))) return stop();
        }
        if (!still(i)) return stop();
        stdin.write(RIGHT);
      }
      if (!(await this.seenMulti(tab, movedOn(i)))) return stop();
    }
    // The Submit tab lists what will be sent: it must be exactly the answers given in the card.
    const review = await this.seenMulti(tab, (s) => !!s.review);
    const listed = review && review.review.length === qs.length
      && qs.every((q, i) => squash(review.review[i].answer) === squash(expectedAnswer(q, answers[i])));
    if (!listed || !review.options.length) return reply(false, this.t("input.multiMismatch"));
    stdin.write(String(review.options[0].n));
    return reply(true);
  }
}

export { MultiQuestionMethods, checkAnswers };

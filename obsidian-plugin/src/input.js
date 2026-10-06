// Input into a session from the Active view: text and dialog answers. Mixed into the plugin class.
import {
  HOST_SOURCE,
  MAX_SEND_CHARS,
  ENTER_DELAY_MS,
  IMAGE_ENTER_DELAY_MS,
  PASTE_START,
  PASTE_END,
} from "./constants";
import { cleanInput } from "./terminal";
import { parseDialog, sameOption, textField, extractCommandOutput, squash } from "./dialog";

// Commands that answer on screen, not in the transcript: their output is read from the tab's screen.
const SCREEN_COMMANDS = new Set(["context", "usage", "effort", "model", "goal", "rewind", "cost",
  "status", "stats", "mcp", "skills", "agents", "hooks", "permissions", "memory", "tasks",
  "help", "doctor", "release-notes", "config", "plugin"]);
const COMMAND_OUTPUT_MS = 1800;

const ESC = "\x1b";
const SCREEN_POLL_MS = 100;
const SCREEN_WAIT_MS = 1500;
const MAX_FEEDBACK_CHARS = 4000;
const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const DOWN = "\x1b[B";
const STOPPABLE = new Set(["busy", "shell", "waiting"]);

class InputMethods {
  /** A reply to the catalog page, addressed to this install's server origin only. */
  answerPage(target, message) {
    if (target && typeof target.postMessage === "function") {
      target.postMessage(Object.assign({ source: HOST_SOURCE }, message), this.atlasOrigin());
    }
  }

  /**
   * Whether this is our session: the PID belongs to a terminal tab, the agent process descends
   * from it, and it is in the same session (Claude Code: its process file; Codex: the rollout it
   * holds open). {error} or {tab, state}. Status is not checked here: a dialog blocks text input
   * but is required for a dialog answer.
   */
  async checkTarget(data) {
    if (!Number.isInteger(data.ptyPid) || data.ptyPid <= 1
        || !Number.isInteger(data.claudePid) || data.claudePid <= 1
        || typeof data.sessionId !== "string") {
      return { error: this.t("input.badRequest") };
    }
    const tab = (await this.terminalTabs()).find((t) => t.pid === data.ptyPid);
    if (!tab) return { error: this.t("input.tabClosed") };
    if (!this.isDescendant(data.claudePid, data.ptyPid)) {
      return { error: this.t("input.otherSession") };
    }
    const state = this.readAgentState(data.claudePid, tab.leaf);
    if (!state || !state.sessionIds.includes(data.sessionId)) return { error: this.t("input.noSession") };
    return { tab, state };
  }

  /**
   * Types text into the terminal tab as if a person typed it. Refuses while the session waits for a
   * dialog decision: Enter there would pick an option, up to allowing a command.
   */
  async sendText(target, data) {
    const reply = (ok, reason) => this.answerPage(target, { type: "sent", ok, reason: reason || null,
                                                   ptyPid: data.ptyPid, nonce: data.nonce });
    if (typeof data.text !== "string") return reply(false, this.t("input.badRequest"));
    const text = cleanInput(data.text);
    const images = this.checkImages(data.images);
    if (images === null) return reply(false, this.t("input.foreignImage"));
    if (!text.trim() && !images.length) return reply(false, this.t("input.empty"));
    if (text.length > MAX_SEND_CHARS) return reply(false, this.t("input.tooLong"));

    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(false, error);
    if (state.status === "waiting") {
      return reply(false, this.t("input.inDialog"));
    }
    // A Codex screen that is neither the composer nor a turn at work: Enter could confirm something.
    if (state.agent === "codex" && !state.status) return reply(false, this.t("input.codexScreen"));
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    // An image path pasted on its own becomes an [Image #N] attachment in Claude Code.
    for (const image of images) stdin.write(PASTE_START + image + PASTE_END + " ");
    if (text) stdin.write(text.includes("\n") ? PASTE_START + text + PASTE_END : text);
    window.setTimeout(() => stdin.write("\r"),
                      ENTER_DELAY_MS + IMAGE_ENTER_DELAY_MS * images.length);
    reply(true);
    const command = /^\/([a-z][a-z-]*)(\s|$)/.exec(text.trim());
    const codex = state.agent === "codex";
    if (command && !images.length
        && (codex ? this.codexScreenCommand(command[1]) : SCREEN_COMMANDS.has(command[1]))) {
      window.setTimeout(() => {
        const out = codex ? this.codexCommandOutput(tab, text.trim())
          : extractCommandOutput(this.screenLines(tab.leaf), text.trim());
        this.answerPage(target, { type: "command-output", sessionId: data.sessionId, nonce: data.nonce,
                         command: text.trim(), text: out ? out.text : "", panel: !!(out && out.panel) });
      }, ENTER_DELAY_MS + COMMAND_OUTPUT_MS);
    }
  }

  /** The dialog on the tab's screen, parsed, so the card can show the question and options. */
  async readDialog(target, data) {
    const reply = (dialog, reason) => this.answerPage(target, { type: "dialog", sessionId: data.sessionId,
      ptyPid: data.ptyPid, dialog: dialog || null, reason: reason || null });
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(null, error);
    if (state.status !== "waiting") return reply(null, this.t("input.noDialog"));
    if (state.agent === "codex") return this.codexReadDialog(tab, reply);
    const lines = this.screenLines(tab.leaf);
    const dialog = parseDialog(lines);
    if (dialog) {
      const title = dialog.kind === "plan" ? this.t(dialog.title) : dialog.title;
      return reply({ ...dialog, title, reason: dialog.reason && this.t(dialog.reason) });
    }
    // Not a question with options but a panel (/usage, /effort, /model…): show its text; Esc closes it.
    const panel = extractCommandOutput(lines, "");
    if (panel && panel.panel) {
      return reply({ kind: "panel", title: panel.text.split("\n")[0], details: [], question: "",
                     options: [], answerable: false, panel: panel.text });
    }
    return reply(null, this.t("input.unparsed"));
  }

  /**
   * One digit, no Enter: Claude Code picks the option at once (checked on the live CLI: an extra
   * Enter lands in the input line). The screen is re-read before the key press: the option under
   * this number must match what the person saw, otherwise the dialog has changed.
   */
  async answerDialog(target, data) {
    const reply = (ok, reason) => this.answerPage(target, { type: "answered", ok, reason: reason || null,
      sessionId: data.sessionId, nonce: data.nonce });
    // "Chat about this" in a question with previews has no number: it is asked for by name.
    const chat = data.chat === true && data.option === undefined;
    if (!chat && (!Number.isInteger(data.option) || data.option < 1 || data.option > 9
        || typeof data.text !== "string")) {
      return reply(false, this.t("input.badRequest"));
    }
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(false, error);
    if (state.status !== "waiting") return reply(false, this.t("input.dialogClosed"));
    if (state.agent === "codex") return this.codexAnswer(tab, data, reply);
    const dialog = parseDialog(this.screenLines(tab.leaf));
    if (dialog && dialog.pick === "enter") return this.enterAnswer(tab, dialog, data, reply);
    if (data.feedback !== undefined) return this.typedAnswer(tab, dialog, data, reply);
    if (!sameOption(dialog, data.option, data.text)) {
      return reply(false, this.t("input.dialogChanged"));
    }
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    stdin.write(String(data.option));
    reply(true);
  }

  /**
   * Typed text: plan feedback or a question's own answer ("Type something."). The digit puts the
   * cursor into the field, the text is typed into it, and Enter sends it (a plan is rejected with
   * it). The screen is re-read after each step; on a mismatch Enter is not pressed: the dialog stays
   * unanswered and the person finishes it in the tab.
   */
  async typedAnswer(tab, dialog, data, reply) {
    const text = cleanInput(String(data.feedback || "")).replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_FEEDBACK_CHARS) return reply(false, this.t("input.feedbackBad"));
    const field = textField(dialog);
    if (!field || field.n !== data.option || data.text !== field.label || field.typed) {
      return reply(false, this.t("input.dialogChanged"));
    }
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    // The same dialog and the same field as before the keys, in the state the test expects.
    const seen = async (test) => {
      for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += SCREEN_POLL_MS) {
        await pause(SCREEN_POLL_MS);
        const d = parseDialog(this.screenLines(tab.leaf));
        const f = d && d.kind === dialog.kind ? textField(d) : null;
        if (f && f.n === field.n && f.label === field.label && test(f)) return true;
      }
      return false;
    };
    stdin.write(String(field.n));
    if (!(await seen((f) => f.selected))) {
      return reply(false, this.t("input.feedbackField"));
    }
    stdin.write(text);
    if (!(await seen((f) => f.selected && squash(f.typed) === squash(text)))) {
      return reply(false, this.t("input.textMismatch"));
    }
    stdin.write("\r");
    reply(true);
  }

  /** Waits until the re-read screen shows the same question in the state the test expects. */
  async seenQuestion(tab, dialog, test) {
    for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += SCREEN_POLL_MS) {
      await pause(SCREEN_POLL_MS);
      const d = parseDialog(this.screenLines(tab.leaf));
      if (d && d.pick === "enter" && d.question === dialog.question && test(d)) return d;
    }
    return null;
  }

  /**
   * A question with previews: a digit only moves the highlight, Enter answers the highlighted option,
   * n opens a note that goes with it, and the unnumbered "Chat about this" is reached with ↓. Each key
   * is followed by a re-read of the screen; Enter is pressed only when it shows what was asked for.
   */
  async enterAnswer(tab, dialog, data, reply) {
    if (!dialog.answerable) return reply(false, this.t("input.dialogChanged"));
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    if (data.chat === true) {
      if (!dialog.chat) return reply(false, this.t("input.dialogChanged"));
      stdin.write(DOWN.repeat(dialog.options.length - dialog.highlighted + 1));
      if (!(await this.seenQuestion(tab, dialog, (d) => d.chat && d.chat.selected))) {
        return reply(false, this.t("input.highlightMoved"));
      }
      stdin.write("\r");
      return reply(true);
    }
    const option = dialog.options.find((o) => o.n === data.option);
    if (!option || option.text !== data.text) return reply(false, this.t("input.dialogChanged"));
    const note = data.note === undefined ? "" : cleanInput(String(data.note)).replace(/\s+/g, " ").trim();
    if (note.length > MAX_FEEDBACK_CHARS || (data.note !== undefined && !note)) {
      return reply(false, this.t("input.feedbackBad"));
    }
    if (note && !dialog.notes) return reply(false, this.t("input.dialogChanged"));
    stdin.write(String(option.n));
    if (!(await this.seenQuestion(tab, dialog, (d) => d.highlighted === option.n && !(d.chat && d.chat.selected)))) {
      return reply(false, this.t("input.highlightMoved"));
    }
    if (note) {
      stdin.write("n");
      if (!(await this.seenQuestion(tab, dialog, (d) => d.highlighted === option.n && d.notes && d.notes.editing
                                     && !d.notes.text))) {
        return reply(false, this.t("input.feedbackField"));
      }
      stdin.write(note);
      if (!(await this.seenQuestion(tab, dialog, (d) => d.highlighted === option.n && d.notes
                                     && squash(d.notes.text) === squash(note)))) {
        return reply(false, this.t("input.textMismatch"));
      }
    }
    stdin.write("\r");
    return reply(true);
  }

  /** Shows another option's preview: its digit moves the highlight, nothing is answered. */
  async previewOption(target, data) {
    const reply = (dialog, reason) => this.answerPage(target, { type: "dialog", sessionId: data.sessionId,
      ptyPid: data.ptyPid, dialog: dialog || null, reason: reason || null });
    if (!Number.isInteger(data.option) || data.option < 1 || data.option > 9 || typeof data.text !== "string") {
      return reply(null, this.t("input.badRequest"));
    }
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(null, error);
    if (state.status !== "waiting" || state.agent === "codex") return reply(null, this.t("input.noDialog"));
    const dialog = parseDialog(this.screenLines(tab.leaf));
    const option = dialog && dialog.pick === "enter" && dialog.options.find((o) => o.n === data.option);
    if (!option || option.text !== data.text) return reply(dialog, this.t("input.dialogChanged"));
    // An open note would take the digit as text.
    if (dialog.notes && dialog.notes.editing) return reply(dialog, this.t("input.noteOpen"));
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(dialog, this.t("input.noInput"));
    stdin.write(String(option.n));
    const moved = await this.seenQuestion(tab, dialog, (d) => d.highlighted === option.n);
    return moved ? reply(moved) : reply(parseDialog(this.screenLines(tab.leaf)), this.t("input.highlightMoved"));
  }

  /**
   * "Stop" is exactly one Esc, as in the terminal: a working session interrupts its turn, an open
   * dialog closes (Codex: declines and ends the turn). An idle session is refused: a second Esc in a
   * row opens Claude Code's rewind menu, and in Codex Esc on the composer starts editing the last
   * message. Never Ctrl-C: it quits an idle Codex at once.
   */
  async interrupt(target, data) {
    const reply = (ok, reason) => this.answerPage(target, { type: "stopped", ok, reason: reason || null,
      sessionId: data.sessionId, nonce: data.nonce });
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(false, error);
    if (!STOPPABLE.has(state.status)) return reply(false, this.t("input.notRunning"));
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    stdin.write(ESC);
    reply(true);
  }
}

export { InputMethods };

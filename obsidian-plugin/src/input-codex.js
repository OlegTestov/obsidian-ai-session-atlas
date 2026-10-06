// Codex sessions in the plugin's terminal tabs: dialogs, feedback and command output read from the
// screen. Mixed into the plugin class; input.js routes here when the target process is Codex.
import { ENTER_DELAY_MS } from "./constants";
import { cleanInput } from "./terminal";
import { sameOption, squash } from "./dialog";
import { parseCodexDialog, codexScreenState, composerText, extractCodexCommandOutput } from "./dialog-codex";

// Codex prints these on screen; the transcript has nothing to show.
const CODEX_SCREEN_COMMANDS = new Set(["status", "mcp"]);
const SCREEN_POLL_MS = 100;
const SCREEN_WAIT_MS = 1500;
const MAX_FEEDBACK_CHARS = 4000;
const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

class CodexInputMethods {
  codexDialog(tab) {
    return parseCodexDialog(this.screenLines(tab.leaf));
  }

  /** The Codex approval, question or choice on screen, in the card's shape. */
  codexReadDialog(tab, reply) {
    const dialog = this.codexDialog(tab);
    if (!dialog) return reply(null, this.t("input.unparsed"));
    return reply({ ...dialog, reason: dialog.reason && this.t(dialog.reason) });
  }

  /**
   * A digit picks the option at once, no Enter (checked on codex-cli 0.160.0: approvals, questions
   * and choices alike). The option under the digit is compared with what the person saw first.
   */
  async codexAnswer(tab, data, reply) {
    const dialog = this.codexDialog(tab);
    if (data.feedback !== undefined) return this.codexFeedback(tab, dialog, data, reply);
    if (!sameOption(dialog, data.option, data.text)) return reply(false, this.t("input.dialogChanged"));
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    stdin.write(String(data.option));
    reply(true);
  }

  /**
   * "No, and tell Codex what to do differently": the digit declines and ends the turn, the composer
   * comes back, the text is typed there and sent. Each step waits for the screen; on a mismatch
   * Enter is not pressed and the person finishes in the tab.
   */
  async codexFeedback(tab, dialog, data, reply) {
    const text = cleanInput(String(data.feedback || "")).replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_FEEDBACK_CHARS) return reply(false, this.t("input.feedbackBad"));
    const field = dialog && dialog.feedback;
    if (!field || field.n !== data.option || data.text !== field.label) {
      return reply(false, this.t("input.dialogChanged"));
    }
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    const seen = async (test) => {
      for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += SCREEN_POLL_MS) {
        await pause(SCREEN_POLL_MS);
        if (test(this.screenLines(tab.leaf))) return true;
      }
      return false;
    };
    stdin.write(String(field.n));
    if (!(await seen((lines) => codexScreenState(lines) === "idle"))) {
      return reply(false, this.t("input.feedbackField"));
    }
    stdin.write(text);
    if (!(await seen((lines) => squash(composerText(lines)) === squash(text)))) {
      return reply(false, this.t("input.textMismatch"));
    }
    await pause(ENTER_DELAY_MS);         // a fast Enter right after typing counts as part of a paste
    stdin.write("\r");
    reply(true);
  }

  /** Whether this command answers on Codex's screen; the reply is read after it ran. */
  codexScreenCommand(name) {
    return CODEX_SCREEN_COMMANDS.has(name);
  }

  codexCommandOutput(tab, command) {
    return extractCodexCommandOutput(this.screenLines(tab.leaf), command);
  }
}

export { CodexInputMethods, CODEX_SCREEN_COMMANDS };

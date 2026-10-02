// Ввод в сессию из вкладки «Активные»: текст, ответ на диалог. Подмешивается в класс плагина.
const {
  ATLAS_ORIGIN,
  HOST_SOURCE,
  MAX_SEND_CHARS,
  ENTER_DELAY_MS,
  IMAGE_ENTER_DELAY_MS,
  PASTE_START,
  PASTE_END,
} = require("./constants");
const { cleanInput } = require("./terminal");
const { parseDialog, sameOption, extractCommandOutput, squash, FEEDBACK_LABEL } = require("./dialog");

// Команды, которые отвечают на экране, а не в транскрипте: их ответ читается с экрана вкладки.
const SCREEN_COMMANDS = new Set(["context", "usage", "effort", "model", "goal", "rewind", "cost",
  "status", "stats", "mcp", "skills", "agents", "hooks", "permissions", "memory", "tasks",
  "help", "doctor", "release-notes", "config", "plugin"]);
const COMMAND_OUTPUT_MS = 1800;

const ESC = "\x1b";
const SCREEN_POLL_MS = 100;
const SCREEN_WAIT_MS = 1500;
const MAX_FEEDBACK_CHARS = 4000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STOPPABLE = new Set(["busy", "shell", "waiting"]);

const answer = (target, message) => {
  if (target && typeof target.postMessage === "function") {
    target.postMessage(Object.assign({ source: HOST_SOURCE }, message), ATLAS_ORIGIN);
  }
};

class InputMethods {
  /**
   * Своя ли это сессия: PID — вкладки терминала, процесс claude — её потомок, в его файле тот же
   * id сессии. {error} или {tab, state}. Статус здесь не решает: для текста диалог — помеха,
   * для ответа на диалог — условие.
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
    const state = this.readSessionState(data.claudePid);
    if (!state || state.sessionId !== data.sessionId) return { error: this.t("input.noSession") };
    return { tab, state };
  }

  /**
   * Печатает текст во вкладку терминала, как будто его набрал человек. Отказывает, если
   * сессия ждёт решения в диалоге: Enter там выбрал бы вариант — вплоть до разрешения команды.
   */
  async sendText(target, data) {
    const reply = (ok, reason) => answer(target, { type: "sent", ok, reason: reason || null,
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
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    // Путь к картинке, вставленный отдельно, Claude Code превращает во вложение [Image #N].
    for (const image of images) stdin.write(PASTE_START + image + PASTE_END + " ");
    if (text) stdin.write(text.includes("\n") ? PASTE_START + text + PASTE_END : text);
    window.setTimeout(() => stdin.write("\r"),
                      ENTER_DELAY_MS + IMAGE_ENTER_DELAY_MS * images.length);
    reply(true);
    const command = /^\/([a-z][a-z-]*)(\s|$)/.exec(text.trim());
    if (command && SCREEN_COMMANDS.has(command[1]) && !images.length) {
      window.setTimeout(() => {
        const out = extractCommandOutput(this.screenLines(tab.leaf), text.trim());
        answer(target, { type: "command-output", sessionId: data.sessionId, nonce: data.nonce,
                         command: text.trim(), text: out ? out.text : "", panel: !!(out && out.panel) });
      }, ENTER_DELAY_MS + COMMAND_OUTPUT_MS);
    }
  }

  /** Диалог на экране вкладки — разобранным, чтобы карточка показала вопрос и варианты. */
  async readDialog(target, data) {
    const reply = (dialog, reason) => answer(target, { type: "dialog", sessionId: data.sessionId,
      ptyPid: data.ptyPid, dialog: dialog || null, reason: reason || null });
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(null, error);
    if (state.status !== "waiting") return reply(null, this.t("input.noDialog"));
    const lines = this.screenLines(tab.leaf);
    const dialog = parseDialog(lines);
    if (dialog) return reply(dialog);
    // Не вопрос с вариантами, а панель (/usage, /effort, /model…): показать её текст, закрыть — Esc.
    const panel = extractCommandOutput(lines, "");
    if (panel && panel.panel) {
      return reply({ kind: "panel", title: panel.text.split("\n")[0], details: [], question: "",
                     options: [], answerable: false, panel: panel.text });
    }
    return reply(null, this.t("input.unparsed"));
  }

  /**
   * Одна цифра, без Enter: Claude Code выбирает вариант сразу (проверено на живом CLI —
   * лишний Enter уходит в строку ввода). Перед нажатием экран перечитывается: вариант под этим
   * номером обязан совпасть с тем, что видел человек, иначе диалог сменился.
   */
  async answerDialog(target, data) {
    const reply = (ok, reason) => answer(target, { type: "answered", ok, reason: reason || null,
      sessionId: data.sessionId, nonce: data.nonce });
    if (!Number.isInteger(data.option) || data.option < 1 || data.option > 9
        || typeof data.text !== "string") {
      return reply(false, this.t("input.badRequest"));
    }
    const { error, tab, state } = await this.checkTarget(data);
    if (error) return reply(false, error);
    if (state.status !== "waiting") return reply(false, this.t("input.dialogClosed"));
    const dialog = parseDialog(this.screenLines(tab.leaf));
    if (data.feedback !== undefined) return this.planFeedback(tab, dialog, data, reply);
    if (!sameOption(dialog, data.option, data.text)) {
      return reply(false, this.t("input.dialogChanged"));
    }
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    stdin.write(String(data.option));
    reply(true);
  }

  /**
   * Замечания к плану: цифра ставит курсор в поле, текст набирается в него, Enter отклоняет
   * план с этим текстом. После каждого шага экран перечитывается; не сошлось — Enter не жмём:
   * план остаётся неотвеченным, и человек допишет во вкладке.
   */
  async planFeedback(tab, dialog, data, reply) {
    const text = cleanInput(String(data.feedback || "")).replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_FEEDBACK_CHARS) return reply(false, this.t("input.feedbackBad"));
    const field = dialog && dialog.kind === "plan" ? dialog.feedback : null;
    if (!field || field.n !== data.option || data.text !== FEEDBACK_LABEL || field.typed) {
      return reply(false, this.t("input.dialogChanged"));
    }
    const stdin = await this.ptyInput(tab.leaf);
    if (!stdin) return reply(false, this.t("input.noInput"));
    const seen = async (test) => {
      for (let waited = 0; waited <= SCREEN_WAIT_MS; waited += SCREEN_POLL_MS) {
        await pause(SCREEN_POLL_MS);
        const d = parseDialog(this.screenLines(tab.leaf));
        if (d && d.kind === "plan" && test(d.feedback)) return true;
      }
      return false;
    };
    stdin.write(String(field.n));
    if (!(await seen((f) => f.n === field.n && f.selected))) {
      return reply(false, this.t("input.feedbackField"));
    }
    stdin.write(text);
    if (!(await seen((f) => squash(f.typed) === squash(text)))) {
      return reply(false, this.t("input.textMismatch"));
    }
    stdin.write("\r");
    reply(true);
  }

  /**
   * «Стоп» — ровно одно Esc, как в терминале: работающая сессия прерывает ход, открытый диалог
   * закрывается. В покое — отказ: второе Esc подряд открывает в Claude Code меню отката.
   */
  async interrupt(target, data) {
    const reply = (ok, reason) => answer(target, { type: "stopped", ok, reason: reason || null,
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

module.exports = { InputMethods };

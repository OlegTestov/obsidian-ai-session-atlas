// Вкладки агентов: кнопки Claude Code и Codex на ленте и запуск сессий из каталога.
// Все вкладки агентов открываются через один скрипт (.obsidian/scripts/agent-resume-terminal.zsh):
// у вкладки есть свой id, скрипт помнит, какая сессия в ней была, и после перезапуска Obsidian
// возвращает её. Подмешивается в класс плагина.
const { Notice, addIcon } = require("obsidian");
const path = require("path");
const fsSync = require("fs");
const { AGENT_VIEW_TYPE } = require("./constants");

const SCRIPT_NAME = "agent-resume-terminal.zsh";
const SCRIPT_REL = ".obsidian/scripts/" + SCRIPT_NAME;
const AGENTS = { claude: "Claude Code", codex: "Codex" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AND = Symbol("&&");
const CODEX_ICON =
  '<g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M50 24V12" /><path d="M38 12h24" /><rect x="20" y="28" width="60" height="50" rx="10" />'
  + '<path d="M10 45v16" /><path d="M90 45v16" />'
  + '<circle cx="38" cy="50" r="4" fill="currentColor" stroke="none" />'
  + '<circle cx="62" cy="50" r="4" fill="currentColor" stroke="none" />'
  + '<path d="M38 62c6 8 18 8 24 0" /></g>';

/** POSIX-кавычки — те же, что shlex.quote на сервере. */
function shellQuote(text) {
  const s = String(text);
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Слова команды в формате shlex.quote: '…', "'" внутри, безопасные символы и «&&».
 * Всё прочее (;, |, $, обратные кавычки, \) — null: такую команду не разбираем.
 */
function shellWords(text) {
  const out = [];
  let cur = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " ") {
      if (cur !== null) { out.push(cur); cur = null; }
      i++;
    } else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return null;
      cur = (cur || "") + text.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      const j = text.indexOf('"', i + 1);
      if (j < 0) return null;
      const inner = text.slice(i + 1, j);
      if (/[\\$`]/.test(inner)) return null;
      cur = (cur || "") + inner;
      i = j + 1;
    } else if (c === "&" && cur === null && text.slice(i, i + 3) === "&& ") {
      out.push(AND);
      i += 2;
    } else if (/[A-Za-z0-9@%+=:,./_-]/.test(c)) {
      cur = (cur || "") + c;
      i++;
    } else {
      return null;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * Команда каталога → старт вкладки. Каталог отдаёт ровно такие:
 *   cd '<папка>' && claude --resume <id> [--fork-session]
 *   cd '<папка>' && claude --session-id <id> ['<первый запрос>']
 * {cwd, mode: resume | resume-fork | new, sessionId, prompt} или null.
 */
function parseLaunch(command) {
  const w = shellWords(String(command || ""));
  if (!w || w.length < 5 || w[0] !== "cd" || typeof w[1] !== "string" || !w[1].startsWith("/")
      || w[2] !== AND || w[3] !== "claude" || w.slice(4).some((x) => typeof x !== "string")) return null;
  const [flag, id, ...rest] = w.slice(4);
  if (!UUID.test(id || "")) return null;
  if (flag === "--resume" && rest.length === 0) return { cwd: w[1], mode: "resume", sessionId: id, prompt: "" };
  if (flag === "--resume" && rest.length === 1 && rest[0] === "--fork-session") {
    return { cwd: w[1], mode: "resume-fork", sessionId: id, prompt: "" };
  }
  if (flag === "--session-id" && rest.length <= 1) {
    return { cwd: w[1], mode: "new", sessionId: id, prompt: rest[0] || "" };
  }
  return null;
}

/** Аргументы профиля терминала: скрипт, вид агента, id вкладки и старт, если есть. */
function agentArgs(scriptPath, kind, instance, seed) {
  const parts = ["exec", shellQuote(scriptPath), kind, instance];
  if (seed) {
    parts.push(seed.mode, seed.sessionId);
    if (seed.prompt) parts.push(shellQuote(seed.prompt));
  }
  // -l -i: нужен профиль пользователя, иначе claude не найдётся в PATH.
  return ["-l", "-i", "-c", parts.join(" ")];
}

function newInstanceId(kind) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2, 12);
  return `${kind}-${Date.now().toString(36)}-${random}`;
}

class AgentMethods {
  addAgentButtons() {
    addIcon("codex-bot", CODEX_ICON);
    this.agentRibbons = {
      claude: this.addRibbonIcon("bot", this.t("agent.claude"), () => this.openAgent("claude")),
      codex: this.addRibbonIcon("codex-bot", this.t("agent.codex"), () => this.openAgent("codex")),
    };
    // Выключенный агент — без кнопки и без команды в палитре; включение — сразу, без перезапуска.
    for (const kind of Object.keys(AGENTS)) {
      this.addCommand({ id: kind === "claude" ? "open-claude-code-terminal" : "open-codex-terminal",
                        name: this.t(`agent.${kind}.command`),
                        checkCallback: (checking) => {
                          if (!this.agentEnabled(kind)) return false;
                          if (!checking) this.openAgent(kind);
                          return true;
                        } });
    }
    this.refreshAgentButtons();
  }

  agentEnabled(kind) {
    const agents = (this.settings && this.settings.agents) || {};
    return kind === "claude" ? agents.claude !== false : agents.codex === true;
  }

  refreshAgentButtons() {
    for (const [kind, el] of Object.entries(this.agentRibbons || {})) {
      if (el && el.style) el.style.display = this.agentEnabled(kind) ? "" : "none";
    }
  }

  /** Строка дополнительных аргументов — в файл, который читает скрипт вкладки. */
  /** Первый запуск с этими настройками: аргументы, уже лежащие в файлах, переходят в настройки,
   *  а не затираются пустыми. Возвращает true, если что-то взяли. */
  adoptAgentArgs() {
    const dir = path.join(this.dataDir(), "agent-args");
    const found = {};
    for (const kind of Object.keys(AGENTS)) {
      try { found[kind] = fsSync.readFileSync(path.join(dir, kind), "utf8").trim(); } catch (e) { found[kind] = ""; }
    }
    this.settings.agentArgs = found;
    return Object.values(found).some(Boolean);
  }

  writeAgentArgs() {
    const dir = path.join(this.dataDir(), "agent-args");
    fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const args = (this.settings && this.settings.agentArgs) || {};
    for (const kind of Object.keys(AGENTS)) {
      fsSync.writeFileSync(path.join(dir, kind), String(args[kind] || "").replace(/[\r\n]+/g, " ").trim() + "\n");
    }
  }

  /** Codex по умолчанию включён, только если он установлен. */
  async detectAgents() {
    if (!this.settings.agents) this.settings.agents = {};
    if (this.settings.agents.codex !== undefined) return;
    const shell = await this.shellProbe();
    this.settings.agents.codex = !!shell.codex;
    await this.saveData(this.settings);
    this.refreshAgentButtons();
  }

  /** Скрипт из распакованной сборки; при установке из репозитория — копия в vault. */
  agentScriptPath() {
    const bundled = path.join(this.runtimeDir(), "scripts", SCRIPT_NAME);
    if (fsSync.existsSync(bundled)) return bundled;
    const vault = this.getVaultPath();
    return vault ? path.join(vault, SCRIPT_REL) : "";
  }

  /**
   * Вкладка агента. Без opts — кнопка на ленте: профиль «Claude Code»/«Codex», папка vault.
   * opts: {cwd, seed, label} — сессия из каталога: вкладка рядом, подпись — её название.
   */
  async openAgent(kind, opts = {}) {
    try {
      const script = this.agentScriptPath();
      if (!script || !fsSync.existsSync(script)) {
        new Notice(this.t("agent.noScript", { path: script || SCRIPT_REL }));
        return false;
      }
      const instance = newInstanceId(kind);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: AGENT_VIEW_TYPE,
        active: true,
        state: { kind, instance, cwd: opts.cwd || this.getVaultPath(), title: opts.label || AGENTS[kind],
                 command: agentArgs(script, kind, instance, opts.seed || null)[3] },
      });
      this.app.workspace.revealLeaf(leaf);
      if (opts.label) new Notice(this.t("terminal.opened", { label: opts.label }));
      return true;
    } catch (error) {
      console.error(error);
      new Notice(this.t("terminal.failed", { error: error.message }));
      return false;
    }
  }
}

module.exports = { AgentMethods, parseLaunch, agentArgs, shellQuote, shellWords, AGENTS, SCRIPT_REL };

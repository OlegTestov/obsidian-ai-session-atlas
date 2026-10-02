// Лимиты подписки: Claude Code отдаёт их только скрипту строки состояния, поэтому подключаем
// свой скрипт в ~/.claude/settings.json — только по переключателю и никогда поверх чужого.
const fsSync = require("fs");
const os = require("os");
const path = require("path");

// Команду Claude Code исполняет через sh; одинарные кавычки держат пробел в «Application Support».
const quote = (text) => "'" + String(text).replace(/'/g, "'\"'\"'") + "'";

const SCRIPT_REL = path.join("atlas", "statusline.py");
const BACKUP_SUFFIX = ".session-atlas.bak";

/** Команда наша, если зовёт statusline.py этого плагина — из сборки или из репозитория. */
function isOurStatusLine(command) {
  return /session-atlas/.test(String(command || "")) && /statusline\.py/.test(String(command || ""));
}

function statusLineCommand(python, runtimeDir) {
  return `${quote(python)} ${quote(path.join(runtimeDir, SCRIPT_REL))}`;
}

class StatusLineMethods {
  claudeSettingsPath() {
    const dir = this.claudeDirOverride || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return path.join(dir, "settings.json");
  }

  /** {state: "off" | "ours" | "foreign" | "broken", command} */
  statusLineState() {
    let data;
    try {
      data = JSON.parse(fsSync.readFileSync(this.claudeSettingsPath(), "utf8"));
    } catch (error) {
      return { state: error.code === "ENOENT" ? "off" : "broken", command: null };
    }
    const line = data && data.statusLine;
    const command = line && typeof line === "object" ? line.command : null;
    if (!command) return { state: "off", command: null };
    return { state: isOurStatusLine(command) ? "ours" : "foreign", command };
  }

  /** Включить или выключить свою строку. Чужую и нечитаемый файл не трогаем: {ok, reason}. */
  async setStatusLine(on) {
    const { state } = this.statusLineState();
    if (state === "broken" || state === "foreign") return { ok: false, reason: state };
    if (!on && state === "off") return { ok: true };
    const file = this.claudeSettingsPath();
    let data = {};
    try { data = JSON.parse(fsSync.readFileSync(file, "utf8")); } catch (error) { /* файла нет */ }
    if (on) {
      const python = await this.findPython();
      if (!python) return { ok: false, reason: "python" };
      const payload = this.embeddedPayload();
      const runtime = payload ? this.extractRuntime(payload) : this.runtimeDir();
      data.statusLine = { type: "command", command: statusLineCommand(python.path, runtime) };
    } else {
      delete data.statusLine;
    }
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    if (fsSync.existsSync(file) && !fsSync.existsSync(file + BACKUP_SUFFIX)) {
      fsSync.copyFileSync(file, file + BACKUP_SUFFIX);        // первая правка — с копией рядом
    }
    const tmp = `${file}.tmp-${process.pid}`;
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fsSync.renameSync(tmp, file);
    return { ok: true };
  }
}

module.exports = { StatusLineMethods, isOurStatusLine, statusLineCommand, BACKUP_SUFFIX };

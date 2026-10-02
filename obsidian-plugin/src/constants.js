// Общие константы плагина: адрес каталога, типы вкладок, пределы быстрого ответа.
const path = require("path");

const VIEW_TYPE = "session-atlas";
const ATLAS_PORT = 8787;
const ATLAS_ORIGIN = `http://127.0.0.1:${ATLAS_PORT}`;

const AGENT_VIEW_TYPE = "session-atlas-terminal";   // своя вкладка терминала агента
const TERMINAL_VIEW_TYPE = "terminal:terminal";      // вкладки плагина Terminal — пока они открыты
const TERMINAL_STATE_KEY = "terminal:terminal";
const TERMINAL_SETTINGS_PATH = ".obsidian/plugins/terminal/data.json";

const TAB_CLOSE_SELECTOR = ".workspace-tab-header-inner-close-button";
const HOST_SOURCE = "session-atlas-host";
const PTY_WAIT_MS = 1000;
const SESSIONS_DIR = path.join(process.env.HOME || "", ".claude/sessions");
const MAX_SEND_CHARS = 20000;
const ENTER_DELAY_MS = 150;     // Enter после вставки: иначе TUI может принять его частью вставки
const UPLOADS_DIR = path.join(process.env.HOME || "",
  "Library/Application Support/session-atlas/uploads");
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_IMAGES = 5;
const IMAGE_ENTER_DELAY_MS = 300;   // на каждую картинку: Claude Code читает файл вложения
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

module.exports = {
  VIEW_TYPE,
  ATLAS_PORT,
  ATLAS_ORIGIN,
  AGENT_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  TERMINAL_STATE_KEY,
  TERMINAL_SETTINGS_PATH,
  TAB_CLOSE_SELECTOR,
  HOST_SOURCE,
  PTY_WAIT_MS,
  SESSIONS_DIR,
  MAX_SEND_CHARS,
  ENTER_DELAY_MS,
  UPLOADS_DIR,
  IMAGE_EXT,
  MAX_IMAGES,
  IMAGE_ENTER_DELAY_MS,
  PASTE_START,
  PASTE_END,
};

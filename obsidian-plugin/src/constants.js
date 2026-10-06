// Shared plugin constants: catalog address, view types, quick-reply limits.
import * as os from "os";
import * as path from "path";

const VIEW_TYPE = "session-atlas";
const ATLAS_PORT = 8787;
const ATLAS_ORIGIN = `http://127.0.0.1:${ATLAS_PORT}`;
// A development install (tools/install_plugin.py --dev) runs its own server, apart from the working one.
const DEV_PORT = 8788;
const DEV_MARKER = ".dev";

const AGENT_VIEW_TYPE = "session-atlas-terminal";   // our own agent terminal tab
const TERMINAL_VIEW_TYPE = "terminal:terminal";      // Terminal plugin tabs, while any are open
const TERMINAL_STATE_KEY = "terminal:terminal";

const TAB_CLOSE_SELECTOR = ".workspace-tab-header-inner-close-button";
const HOST_SOURCE = "session-atlas-host";
const PTY_WAIT_MS = 1000;
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
// The agent tab script's registry of tab → session (scripts/agent-registry-lib.zsh, same default path).
const REGISTRY_FILE = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
                                "obsidian-agent-terminals", "resume.tsv");
const MAX_SEND_CHARS = 20000;
const ENTER_DELAY_MS = 150;     // Enter after a paste: otherwise the TUI may take it as part of the paste
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_IMAGES = 5;
const IMAGE_ENTER_DELAY_MS = 300;   // per image: Claude Code reads the attachment file
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export {
  VIEW_TYPE,
  ATLAS_PORT,
  ATLAS_ORIGIN,
  DEV_PORT,
  DEV_MARKER,
  AGENT_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  TERMINAL_STATE_KEY,
  TAB_CLOSE_SELECTOR,
  HOST_SOURCE,
  PTY_WAIT_MS,
  SESSIONS_DIR,
  REGISTRY_FILE,
  MAX_SEND_CHARS,
  ENTER_DELAY_MS,
  IMAGE_EXT,
  MAX_IMAGES,
  IMAGE_ENTER_DELAY_MS,
  PASTE_START,
  PASTE_END,
};

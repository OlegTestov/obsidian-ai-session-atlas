import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Notice } from "obsidian";
import { DIRECTORY, ROUTE, MailRoutes, tabRoutes } from "./mail-routes";

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const FILE = /^\d{13}-[0-9a-f]{12}\.json$/;
const SESSION = /^[A-Za-z0-9-]{8,80}$/;
const POLL_MS = 5000;
const COOLDOWN_MS = 60000;
const NOTICE_MS = 4000;
// Agent Mail accepts 100,000 characters. JSON can use six bytes per escaped control character.
const MESSAGE_BYTES = 640 * 1024;

// Open only regular files, without following the final symlink or blocking on a FIFO.
function readSmall(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > limit) return "";
    const buffer = Buffer.alloc(Math.min(info.size, limit) + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, null);
    return size <= limit ? buffer.toString("utf8", 0, size) : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function entries(dir) {
  try {
    return fs.lstatSync(dir).isDirectory() ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  } catch {
    return [];
  }
}

function scanMail(root, routes = new Map()) {
  const batches = [];
  for (const box of entries(root)) {
    if (!box.isDirectory() || !NAME.test(box.name)) continue;
    const dir = path.join(root, box.name);
    const route = routes.get(box.name);
    if (ROUTE.test(box.name) && !route) continue;
    const id = route?.id || readSmall(path.join(dir, "session"), 128).trim();
    if (!SESSION.test(id)) continue;
    const inbox = path.join(dir, "inbox");
    const files = entries(inbox).filter(file => file.isFile() && FILE.test(file.name))
      .map(file => file.name).sort();
    if (files.length) batches.push({ name: box.name, id, inbox, files, ...(route && { agent: route.agent }) });
  }
  return batches;
}

function absolutePath(value) {
  // eslint-disable-next-line no-control-regex -- control characters cannot go into a terminal prompt
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

function shellQuote(text) {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function mailRoot(settings) {
  return absolutePath((settings.agentMailRoot || "").trim() || process.env.AGENT_MAIL_HOME || "~/.agent-mail");
}

class MailNudger {
  constructor(plugin, now = Date.now) {
    this.plugin = plugin;
    this.now = now;
    this.sent = new Map();
    this.routes = new MailRoutes();
  }

  start() {
    this.plugin.registerInterval(window.setInterval(() => this.poll(), POLL_MS));
    this.plugin.register(() => {
      this.closed = true;
      this.watcher?.close();
      this.routes.clear();
    });
    void this.poll();
  }

  currentRoot() {
    return this.plugin.settings.wakeOnMail ? mailRoot(this.plugin.settings) : null;
  }

  watch(root) {
    if (root === this.watched && this.watcher) return;
    this.watcher?.close();
    this.watcher = null;
    this.watched = root;
    try {
      if (!root || !fs.lstatSync(root).isDirectory()) return;
      const watcher = fs.watch(root, { recursive: true }, (_event, file) => {
        if (file === DIRECTORY || file?.startsWith(DIRECTORY + path.sep)) return;
        void this.poll();
      });
      this.watcher = watcher;
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
    } catch {
      // The root may not exist yet. The next poll will try again.
    }
  }

  async poll() {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const root = this.currentRoot();
      this.watch(root);
      if (!root) {
        this.routes.clear();
        return;
      }
      const active = await this.plugin.fetchActive();
      if (this.closed || root !== this.currentRoot()) return;
      const sessions = Array.isArray(active?.sessions) ? active.sessions : [];
      const tabs = sessions.length ? await this.plugin.terminalTabs() : [];
      if (this.closed || root !== this.currentRoot()) return;
      const routes = tabRoutes(sessions, tabs);
      try {
        this.routes.publish(root, routes);
      } catch (error) {
        console.error("AI Session Atlas: could not advertise the open mail tabs", error);
      }
      const pending = scanMail(root, routes).filter(batch => {
        const prior = this.sent.get(batch.inbox);
        return !prior || (batch.files.at(-1) > prior.file && this.now() - prior.at >= COOLDOWN_MS);
      });
      for (const batch of pending) {
        if (this.closed || root !== this.currentRoot()) break;
        const matches = sessions.filter(s => s?.session_id === batch.id && s.status === "idle"
          && (!batch.agent || s.agent === batch.agent));
        if (matches.length !== 1) continue;
        const session = matches[0];
        const tab = await this.plugin.tabForSession(session);
        if (!tab) continue;
        const guard = () => !this.closed && root === this.currentRoot()
          && entries(root).some(box => box.name === batch.name && box.isDirectory())
          && (batch.agent || readSmall(path.join(root, batch.name, "session"), 128).trim() === batch.id)
          && entries(batch.inbox).some(file => file.isFile() && file.name === batch.files.at(-1));
        if (!guard()) continue;
        const senders = new Set();
        for (const file of batch.files) {
          try {
            const msg = JSON.parse(readSmall(path.join(batch.inbox, file), MESSAGE_BYTES));
            if (typeof msg.from === "string" && NAME.test(msg.from)) senders.add(msg.from);
          } catch {
            // A reader can move the message while this scan is in progress.
          }
        }
        const from = [...senders].slice(0, 12).join(", ");
        const script = absolutePath((this.plugin.settings.agentMailScript || "").trim());
        const fallback = script ? ` or run: AGENT_MAIL_HOME=${shellQuote(root)} python3 -- ${shellQuote(script)} inbox ${batch.name}` : "";
        const count = batch.files.length;
        const text = `You have ${count} new ${count === 1 ? "message" : "messages"}${from ? " from " + from : ""}. Read with mail_inbox (as: ${batch.name})${fallback}`;
        if (await this.plugin.sendText(null, {
          text, ptyPid: tab.pid, claudePid: session.pid, sessionId: batch.id,
        }, guard)) {
          this.sent.set(batch.inbox, { file: batch.files.at(-1), at: this.now() });
          new Notice(this.plugin.t("mail.sent", { name: routes.get(batch.name)?.title || batch.name }), NOTICE_MS);
        }
      }
    } catch (error) {
      console.error("AI Session Atlas: mail poll failed", error);
    } finally {
      this.running = false;
    }
  }
}

export { MailNudger, mailRoot, scanMail };

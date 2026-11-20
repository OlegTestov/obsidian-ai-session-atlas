// Local discovery for Agent Mail, separate from its inbox and read files.
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const DIRECTORY = ".atlas-tabs";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ROUTE = /^atlas-(?:[cx]-[0-9a-f]{32}|o-ses_[a-z0-9]{20,28})$/;
const PREFIX = { claude: "c", codex: "x" };

function tabRoutes(sessions, tabs, limitForTab = () => null) {
  const routes = new Map();
  for (const session of sessions) {
    const id = session?.session_id;
    const agent = session?.agent;
    if (typeof id !== "string" || !UUID.test(id) || (agent !== "claude" && agent !== "codex")) continue;
    if (!Array.isArray(session.ancestors)) continue;
    const tab = tabs.find(t => session.ancestors.includes(t.pid));
    const title = tab?.title?.trim();
    if (!title || title.length > 1000) continue;
    const mailbox = `atlas-${PREFIX[agent]}-${id.replaceAll("-", "")}`;
    const usageLimit = limitForTab(id, agent, tab);
    const pid = Number.isInteger(session.pid) && session.pid > 1 ? session.pid : null;
    routes.set(mailbox, { mailbox, title, id, agent, ...(pid && { pid }), ...(usageLimit && { usage_limit: usageLimit }) });
  }
  return routes;
}

class MailRoutes {
  constructor() {
    this.instance = randomUUID();
    this.root = null;
  }

  clear() {
    if (!this.root) return;
    try {
      const dir = path.join(this.root, DIRECTORY);
      if (fs.lstatSync(this.root).isDirectory() && fs.lstatSync(dir).isDirectory()) {
        fs.unlinkSync(path.join(dir, `${this.instance}.json`));
      }
    } catch {
      // A leftover snapshot will expire if the root was moved or cannot be written.
    }
    this.root = null;
  }

  // The default root is created with its parents; a custom one only if its parent exists (it may be half-typed).
  publish(root, routes, createRoot = false) {
    if (this.root !== root) this.clear();
    if (!routes.size) {
      this.clear();
      return;
    }
    const dir = path.join(root, DIRECTORY);
    let temp;
    try {
      // A custom folder is made only inside an existing one, so a mistyped path does not grow a tree.
      try {
        fs.mkdirSync(root, { recursive: createRoot, mode: 0o700 });
      } catch (error) {
        if (error?.code === "ENOENT") return;
        if (error?.code !== "EEXIST") throw error;
      }
      if (!fs.lstatSync(root).isDirectory()) return;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(dir).isDirectory()) return;
      temp = path.join(dir, `.${this.instance}.tmp`);
      fs.writeFileSync(temp, JSON.stringify([...routes.values()]), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, path.join(dir, `${this.instance}.json`));
      this.root = root;
    } catch (error) {
      if (error?.code === "ENOENT" && !temp) return;
      if (temp && error?.code !== "EEXIST") {
        try { fs.unlinkSync(temp); } catch { /* temp not created or already removed */ }
      }
      throw error;
    }
  }
}

export { DIRECTORY, ROUTE, MailRoutes, tabRoutes };

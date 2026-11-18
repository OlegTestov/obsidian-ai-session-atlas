// Local discovery for Agent Mail, separate from its inbox and read files.
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const DIRECTORY = ".atlas-tabs";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const ROUTE = /^atlas-[cx]-[0-9a-f]{32}$/;
const PREFIX = { claude: "c", codex: "x" };

function tabRoutes(sessions, tabs) {
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
    routes.set(mailbox, { mailbox, title, id, agent });
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

  publish(root, routes) {
    if (this.root !== root) this.clear();
    if (!routes.size) {
      this.clear();
      return;
    }
    const dir = path.join(root, DIRECTORY);
    let temp;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(root).isDirectory()) return;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(dir).isDirectory()) return;
      temp = path.join(dir, `.${this.instance}.tmp`);
      fs.writeFileSync(temp, JSON.stringify([...routes.values()]), { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, path.join(dir, `${this.instance}.json`));
      this.root = root;
    } catch (error) {
      if (temp && error?.code !== "EEXIST") {
        try { fs.unlinkSync(temp); } catch { /* temp not created or already removed */ }
      }
      throw error;
    }
  }
}

export { DIRECTORY, ROUTE, MailRoutes, tabRoutes };

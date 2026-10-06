import { Notice, Plugin } from "obsidian";
import * as fsSync from "fs";
import * as http from "http";
import * as path from "path";
import {
  VIEW_TYPE,
  AGENT_VIEW_TYPE,
  ATLAS_PORT,
  DEV_PORT,
  DEV_MARKER,
  HOST_SOURCE,
} from "./constants";
import { TerminalMethods } from "./terminal";
import { codexScreenState } from "./dialog-codex";
import { InputMethods } from "./input";
import { CodexInputMethods } from "./input-codex";
import { AtlasView } from "./view";
import { AgentTerminalView } from "./term-view";
import { HeldMethods, keepHeldTabs } from "./held";
import { AgentMethods } from "./agents";
import { GuardMethods } from "./guard";
import { RuntimeMethods } from "./runtime";
import { StatusLineMethods } from "./statusline";
import { ReloadMethods } from "./reload";
import { ExplorerMethods } from "./explorer";
import { resolveLanguage, obsidianLanguage, translate } from "./i18n";
import { NotifyMethods } from "./notify";
import { RestoreMethods } from "./restore";
import { AtlasSettingTab, DEFAULT_SETTINGS } from "./settings";

/** A port written into the dev marker (a live test Obsidian next to the test vault), else none. */
function markerPort(file) {
  try {
    const port = Number(fsSync.readFileSync(file, "utf8").trim());
    return Number.isInteger(port) && port > 1024 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

class SessionAtlasPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.loadedAt = Date.now();
    this.initRestore();
    this.addSettingTab(new AtlasSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new AtlasView(leaf, this));
    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentTerminalView(leaf, this));

    this.addRibbonIcon("library", this.t("atlas.open"), () => this.openAtlas());
    this.addCommand({
      id: "open-catalog",
      name: this.t("atlas.open"),
      callback: () => this.openAtlas(),
    });
    this.addCommand({
      id: "reload-plugin",
      name: this.t("reload.command"),
      checkCallback: (checking) => (checking ? this.canReloadInPlace() : this.reloadInPlace()),
    });
    this.addAgentButtons();
    try {
      if (!saved.agentArgs && this.adoptAgentArgs()) await this.saveData(this.settings);
      this.writeAgentArgs();
    } catch (error) { console.error("AI Session Atlas: could not sync agent arguments", error); }
    this.app.workspace.onLayoutReady(() => this.detectAgents().catch(() => {}));
    this.app.workspace.onLayoutReady(() => this.watchOwnBuild());
    // Held processes whose tabs are still in the layout wait for them; the rest are offered back.
    this.app.workspace.onLayoutReady(() => { keepHeldTabs(this.app.workspace); this.offerHeldTabs(); });
    // Not only the catalog tab needs the server: notifications poll it constantly, and Obsidian
    // does not create a background tab until you switch to it.
    this.app.workspace.onLayoutReady(() => this.ensureServer().catch(() => {}));
    this.installExplorerClicks();
    this.patchCloseTabCommand();

    // Messages come from the catalog iframe. The origin is checked strictly: the page shows text
    // from other sessions, and only the catalog itself may trigger commands.
    this.onMessage = (event) => this.handleMessage(event);
    window.addEventListener("message", this.onMessage);
    this.register(() => window.removeEventListener("message", this.onMessage));

    this.pendingCloseConfirms = new WeakSet();
    this.installCloseGuard(document);
    this.app.workspace.onLayoutReady(() => this.installCloseGuards());     // popout windows already open
    this.registerEvent(
      this.app.workspace.on("window-open", (win) => this.installCloseGuard(win && win.doc))
    );
    // Polling starts after layout: at Obsidian start-up the terminal tabs are not restored yet.
    this.app.workspace.onLayoutReady(() => this.startWatch());
  }

  onunload() {
    // Tabs stay attached: Obsidian restores them itself on the next start.
    this.stopServer();
  }

  /** A string in the plugin's language: the settings choice, else Obsidian's language. */
  lang() {
    return resolveLanguage(this.settings && this.settings.language, obsidianLanguage());
  }

  t(key, vars) {
    return translate(this.lang(), key, vars);
  }

  // --- catalog tab ---

  async openAtlas(hash) {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = existing.length ? existing[0] : this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { hash: hash || "" } });
    this.app.workspace.revealLeaf(leaf);
  }

  /** The server may be down: without it the tab would show a blank page. */
  async ensureServer() {
    if (this.startingServer) return this.startingServer;     // two windows, one start
    this.startingServer = this.startServer().then((r) => {
      this.startingServer = null;
      this.serverProblem = r.ok ? null : r.reason;
      if (!r.ok) new Notice(this.t("server.failed", { error: r.reason }), 10000);
      return r.ok;
    });
    return this.startingServer;
  }

  /** A development install (marker next to main.js) uses its own port and data folder. */
  isDevInstall() {
    if (this.devInstall === undefined) {
      const adapter = this.app && this.app.vault && this.app.vault.adapter;
      const dir = this.manifest && this.manifest.dir;
      const marker = adapter && adapter.getBasePath && dir ? path.join(adapter.getBasePath(), dir, DEV_MARKER) : null;
      this.devInstall = !!(marker && fsSync.existsSync(marker));
      this.devPort = this.devInstall ? markerPort(marker) : null;
    }
    return this.devInstall;
  }

  atlasPort() { return this.isDevInstall() ? this.devPort || DEV_PORT : ATLAS_PORT; }

  atlasOrigin() { return `http://127.0.0.1:${this.atlasPort()}`; }

  /** Re-render open catalog tabs (a page setting changed). */
  reloadAtlasViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.render === "function") leaf.view.render();
    }
  }

  /** The page's start-server button: the same start as opening the tab. */
  async raiseServer(target) {
    if (this.raisingServer) return;          // a second click does not start a second launch
    this.raisingServer = true;
    let ok = false;
    let reason = null;
    try {
      ok = await this.ensureServer();
      if (!ok) reason = this.serverProblem || this.t("server.notRaised");
    } catch (error) {
      reason = error.message;
    } finally {
      this.raisingServer = false;
    }
    if (target && typeof target.postMessage === "function") {
      target.postMessage({ source: HOST_SOURCE, type: "server-ensured", ok, reason }, this.atlasOrigin());
    }
  }

  /**
   * Checked through node, not fetch. A fetch from Obsidian carries the origin `app://obsidian.md`,
   * so it is cross-origin: the server rejects it by Origin, and the browser would block it without
   * CORS headers. The Origin check must not be relaxed for a health probe.
   */
  async isServerUp(timeout = 2000) {
    const info = await this.healthInfo(timeout);
    return !!info && info.app === "session-atlas";
  }

  /** The /health answer: {app, port, python}, or null when nothing listens on the port. */
  healthInfo(timeout = 2000) {
    return new Promise((resolve) => {
      const request = http.get(
        { host: "127.0.0.1", port: this.atlasPort(), path: "/health", timeout },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            if (response.statusCode !== 200) return resolve({ app: null });
            try { resolve(JSON.parse(body)); } catch { resolve({ app: null }); }
          });
        }
      );
      request.on("timeout", () => { request.destroy(); resolve(null); });
      request.on("error", () => resolve(null));
    });
  }

  // --- bridge to the terminal ---

  handleMessage(event) {
    if (event.origin !== this.atlasOrigin()) return;
    const data = event.data;
    if (!data || data.source !== "session-atlas") return;
    if (data.type === "resume" || data.type === "new-session") {
      if (typeof data.command !== "string" || !data.command) return;
      this.openCommandInTerminal(data.command, data.cwd, data.title || "Claude");
      return;
    }
    if (data.type === "list-tabs") {
      this.replyTabs(event.source);
      return;
    }
    if (data.type === "send-text") {
      this.sendText(event.source, data);
      return;
    }
    if (data.type === "read-dialog") {
      this.readDialog(event.source, data);
      return;
    }
    if (data.type === "answer-dialog") {
      this.answerDialog(event.source, data);
      return;
    }
    if (data.type === "preview-option") {
      this.previewOption(event.source, data);
      return;
    }
    if (data.type === "ensure-server") {
      this.raiseServer(event.source);
      return;
    }
    if (data.type === "list-restorable") {
      this.replyRestorable(event.source);
      return;
    }
    if (data.type === "forget-restorable") {
      this.forgetRestorable(data.sessionIds);
      this.replyRestorable(event.source);
      return;
    }
    if (data.type === "reattach-held" || data.type === "release-held") {
      // Only PTY pids of processes this plugin holds: nothing else can be reached through them.
      const pids = Array.isArray(data.ptyPids) ? data.ptyPids.filter((p) => Number.isInteger(p) && p > 1) : [];
      if (!pids.length) return;
      const done = data.type === "reattach-held" ? this.reattachHeld(pids) : Promise.resolve(this.releaseHeldTabs(pids));
      done.then(() => this.replyTabs(event.source)).catch((error) => console.error("AI Session Atlas:", error));
      return;
    }
    if (data.type === "interrupt") {
      this.interrupt(event.source, data);
      return;
    }
    if (data.type === "focus-tab" || data.type === "close-tab") {
      // PID must be a number: it finds OUR terminal tab; a foreign process is never touched.
      if (!Number.isInteger(data.ptyPid) || data.ptyPid <= 1) return;
      const title = typeof data.title === "string" ? data.title.slice(0, 200) : "";
      this.actOnTab(data.type, data.ptyPid, title);
    }
  }

  // --- terminal tabs for the Active view ---

  async replyTabs(target) {
    if (!target || typeof target.postMessage !== "function") return;
    const { tabs, health } = await this.terminalReport();
    target.postMessage({
      source: HOST_SOURCE,
      type: "tabs",
      tabs: tabs.map((tab) => this.tabInfo(tab)),
      // Processes whose tabs closed with the plugin: still running, offered back on the page.
      held: this.heldTabs().map(({ ptyPid, title, agent }) => ({ ptyPid, title, agent })),
      health,
      // The page offers only the agents enabled here (Settings → Agents).
      agents: { claude: this.agentEnabled("claude"), codex: this.agentEnabled("codex") },
    }, this.atlasOrigin());
  }

  /**
   * A tab for the page. A Codex tab also carries its screen state (waiting | busy | idle | null):
   * Codex writes no approval into its rollout, so only the screen shows that it waits for you.
   */
  tabInfo({ leaf, pid, title }) {
    const info = { ptyPid: pid, title };
    if (this.tabAgent(leaf) === "codex") {
      info.agent = "codex";
      info.screen = codexScreenState(this.screenLines(leaf));
    }
    return info;
  }

  tabAgent(leaf) {
    const state = leaf && leaf.view && leaf.view.state;
    return state && typeof state.kind === "string" ? state.kind : null;
  }

  async actOnTab(type, ptyPid, title) {
    const tab = (await this.terminalTabs()).find((t) => t.pid === ptyPid);
    // "Go to" on a session whose tab closed with the plugin: a tab on the same process comes back.
    if (!tab && type === "focus-tab" && (await this.reattachHeld([ptyPid]))) return;
    if (!tab) {
      new Notice(this.t("tab.gone"));
      return;
    }
    if (type === "focus-tab") {
      this.app.workspace.setActiveLeaf(tab.leaf, { focus: true });
      this.app.workspace.revealLeaf(tab.leaf);
      return;
    }
    this.confirmClose(tab.leaf, title || tab.title);
  }
}

// Methods from the other files are mixed into the plugin class and run with the plugin as `this`.
for (const methods of [TerminalMethods, InputMethods, CodexInputMethods, NotifyMethods, RestoreMethods, HeldMethods,
                       AgentMethods, GuardMethods, ExplorerMethods, RuntimeMethods, StatusLineMethods, ReloadMethods]) {
  for (const name of Object.getOwnPropertyNames(methods.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(SessionAtlasPlugin.prototype, name,
                          Object.getOwnPropertyDescriptor(methods.prototype, name));
  }
}

export default SessionAtlasPlugin;

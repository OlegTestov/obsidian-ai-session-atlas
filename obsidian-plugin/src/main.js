const { Notice, Plugin } = require("obsidian");
const http = require("http");
const {
  VIEW_TYPE,
  AGENT_VIEW_TYPE,
  ATLAS_PORT,
  ATLAS_ORIGIN,
  HOST_SOURCE,
} = require("./constants");
const { TerminalMethods } = require("./terminal");
const { InputMethods } = require("./input");
const { AtlasView } = require("./view");
const { AgentTerminalView } = require("./term-view");
const { AgentMethods } = require("./agents");
const { GuardMethods } = require("./guard");
const { RuntimeMethods } = require("./runtime");
const { StatusLineMethods } = require("./statusline");
const { ReloadMethods } = require("./reload");
const { ExplorerMethods } = require("./explorer");
const { resolveLanguage, obsidianLanguage, translate } = require("./i18n");
const { NotifyMethods } = require("./notify");
const { RestoreMethods } = require("./restore");
const { AtlasSettingTab, DEFAULT_SETTINGS } = require("./settings");

// Старые плагины, чьи функции теперь здесь: пока включены, их части не дублируем.
const LEGACY = { "agent-terminal-ribbons": "Agent Terminal Ribbons", "swap-click-open": "Swap Click Open" };

class SessionAtlasPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.loadedAt = Date.now();
    this.initRestore();
    this.addSettingTab(new AtlasSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new AtlasView(leaf, this));
    this.registerView(AGENT_VIEW_TYPE, (leaf) => new AgentTerminalView(leaf, this));

    this.addRibbonIcon("library", "Session Atlas", () => this.openAtlas());
    this.addCommand({
      id: "open-session-atlas",
      name: this.t("atlas.open"),
      callback: () => this.openAtlas(),
    });
    this.addCommand({
      id: "reload-session-atlas",
      name: this.t("reload.command"),
      checkCallback: (checking) => (checking ? this.canReloadInPlace() : this.reloadInPlace()),
    });
    if (!this.legacyEnabled("agent-terminal-ribbons")) this.addAgentButtons();
    try {
      if (!saved.agentArgs && this.adoptAgentArgs()) await this.saveData(this.settings);
      this.writeAgentArgs();
    } catch (error) { console.error("Session Atlas: аргументы агентов", error); }
    this.app.workspace.onLayoutReady(() => this.detectAgents().catch(() => {}));
    this.app.workspace.onLayoutReady(() => this.watchOwnBuild());
    // Сервер нужен не только вкладке каталога: уведомления опрашивают его постоянно, а фоновую
    // вкладку Obsidian не создаёт, пока на неё не переключишься.
    this.app.workspace.onLayoutReady(() => this.ensureServer().catch(() => {}));
    for (const [id, name] of Object.entries(LEGACY)) {
      if (this.legacyEnabled(id)) new Notice(this.t("legacy.enabled", { name }), 15000);
    }
    this.installExplorerClicks();
    this.patchCloseTabCommand();

    // Сообщения приходят из iframe каталога. Источник проверяем строго: на этой странице
    // лежит текст чужих сессий, и выполнять по нему команды можно только от самого каталога.
    this.onMessage = (event) => this.handleMessage(event);
    window.addEventListener("message", this.onMessage);
    this.register(() => window.removeEventListener("message", this.onMessage));

    this.pendingCloseConfirms = new WeakSet();
    this.installCloseGuard(document);
    this.registerEvent(
      this.app.workspace.on("window-open", (win) => this.installCloseGuard(win && win.doc))
    );
    // Опрос после раскладки: на старте Obsidian вкладки терминала ещё не восстановлены.
    this.app.workspace.onLayoutReady(() => this.startWatch());
  }

  onunload() {
    // Вкладки не отцепляем: Obsidian восстановит их сам при следующем запуске.
    this.stopServer();
  }

  /** Строка на языке плагина: выбор в настройках, иначе язык Obsidian. */
  lang() {
    return resolveLanguage(this.settings && this.settings.language, obsidianLanguage());
  }

  t(key, vars) {
    return translate(this.lang(), key, vars);
  }

  legacyEnabled(id) {
    const plugins = this.app && this.app.plugins;
    return !!(plugins && plugins.enabledPlugins && plugins.enabledPlugins.has(id));
  }

  // --- вкладка каталога ---

  async openAtlas(hash) {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = existing.length ? existing[0] : this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { hash: hash || "" } });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Сервер мог не подняться: без него вкладка показала бы пустую страницу. */
  async ensureServer() {
    if (this.startingServer) return this.startingServer;     // два окна — один запуск
    this.startingServer = this.startServer().then((r) => {
      this.startingServer = null;
      this.serverProblem = r.ok ? null : r.reason;
      if (!r.ok) new Notice(this.t("server.failed", { error: r.reason }), 10000);
      return r.ok;
    });
    return this.startingServer;
  }

  atlasPort() { return ATLAS_PORT; }

  /** Перерисовать открытые вкладки каталога (настройка страницы поменялась). */
  reloadAtlasViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.render === "function") leaf.view.render();
    }
  }

  /** Кнопка «Поднять» на странице: тот же запуск, что при открытии вкладки. */
  async raiseServer(target) {
    if (this.raisingServer) return;          // второе нажатие не запускает второй подъём
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
      target.postMessage({ source: HOST_SOURCE, type: "server-ensured", ok, reason }, ATLAS_ORIGIN);
    }
  }

  /**
   * Проверяем через node, а не fetch. Fetch из Obsidian идёт с origin `app://obsidian.md`,
   * то есть кросс-оригин: сервер такие отклоняет по Origin, а браузер зарезал бы их без
   * CORS-заголовков. Ослаблять проверку Origin ради health-пробы нельзя.
   */
  async isServerUp(timeout = 2000) {
    const info = await this.healthInfo(timeout);
    return !!info && info.app === "session-atlas";
  }

  /** Ответ /health: {app, port, python} — или null, если на порту никого нет. */
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
            try { resolve(JSON.parse(body)); } catch (error) { resolve({ app: null }); }
          });
        }
      );
      request.on("timeout", () => { request.destroy(); resolve(null); });
      request.on("error", () => resolve(null));
    });
  }

  // --- мост в терминал ---

  handleMessage(event) {
    if (event.origin !== ATLAS_ORIGIN) return;
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
    if (data.type === "interrupt") {
      this.interrupt(event.source, data);
      return;
    }
    if (data.type === "focus-tab" || data.type === "close-tab") {
      // PID — только число: по нему ищется СВОЯ вкладка терминала, чужой процесс не трогаем.
      if (!Number.isInteger(data.ptyPid) || data.ptyPid <= 1) return;
      const title = typeof data.title === "string" ? data.title.slice(0, 200) : "";
      this.actOnTab(data.type, data.ptyPid, title);
    }
  }

  // --- вкладки терминала для вкладки «Активные» ---

  async replyTabs(target) {
    if (!target || typeof target.postMessage !== "function") return;
    const { tabs, health } = await this.terminalReport();
    target.postMessage({
      source: HOST_SOURCE,
      type: "tabs",
      tabs: tabs.map(({ pid, title }) => ({ ptyPid: pid, title })),
      health,
    }, ATLAS_ORIGIN);
  }

  async actOnTab(type, ptyPid, title) {
    const tab = (await this.terminalTabs()).find((t) => t.pid === ptyPid);
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

// Методы терминала и уведомлений живут в своих файлах, но вызываются как методы плагина (this.app и т.д.).
for (const methods of [TerminalMethods, InputMethods, NotifyMethods, RestoreMethods, AgentMethods,
                       GuardMethods, ExplorerMethods, RuntimeMethods, StatusLineMethods, ReloadMethods]) {
  for (const name of Object.getOwnPropertyNames(methods.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(SessionAtlasPlugin.prototype, name,
                          Object.getOwnPropertyDescriptor(methods.prototype, name));
  }
}

module.exports = SessionAtlasPlugin;

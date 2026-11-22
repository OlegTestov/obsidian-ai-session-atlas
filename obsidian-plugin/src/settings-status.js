import { Notice, Setting, setIcon } from "obsidian";
import * as childProcess from "child_process";
import { once } from "events";
import { agentKinds, getAgent } from "./agent-registry";
import { AGENT_ICONS } from "./agent-icons";
import { automatic, definition, group, pluginText } from "./settings-fields";

const MIN_MACOS = 12;

function installClt() {
  childProcess.spawn("/usr/bin/xcode-select", ["--install"], { detached: true, stdio: "ignore" }).unref();
}

async function restartCatalog(plugin) {
  const server = plugin.serverProcess;
  // Wait for the server we own to release its port before ensureServer probes it.
  const controller = new AbortController();
  try {
    const exited = server && once(server, "exit", { signal: controller.signal });
    await Promise.all([exited, Promise.resolve().then(() => plugin.stopServer())]);
    await plugin.ensureServer();
  } catch (error) {
    new Notice(plugin.t("setup.restartFailed", { error: error?.message ?? String(error) }));
  } finally {
    controller.abort();
  }
}

async function rescanCatalog(plugin) {
  new Notice(plugin.t("setup.reindexStarted"));
  const res = await plugin.atlasRequest("POST", "/api/reindex", {}, 30 * 60 * 1000);
  new Notice(plugin.t(res.status === 200 ? "setup.reindexDone" : "setup.reindexFailed"));
}

async function indexStatus(plugin) {
  const result = await plugin.atlasRequest("GET", "/api/index-status");
  return result.status === 200 ? result.data : null;
}

function catalogDetail(plugin, info) {
  if (!info) return plugin.t("setup.indexUnknown");
  if (info.indexing) return plugin.t("setup.indexing", { n: info.sessions });
  return plugin.t(info.sessions === 0 ? "setup.indexEmpty" : "setup.indexed", { n: info.sessions });
}

function reportEnvironmentError(error) {
  console.error("AI Session Atlas: environment checks failed", error);
}

function openCodeStatus(state, found) {
  if (state === "v1") return "setup.opencodeV1";
  if (state === "unsupported") return "setup.opencodeUnsupported";
  return found || state === "v2" ? "setup.found" : "setup.notFoundOptional";
}

function openCodeDetail(t, info, found) {
  const state = info?.opencode?.state;
  const base = t(openCodeStatus(state, found));
  const service = info?.opencode_service;
  if (state === "v1" || state === "unsupported" || !service?.message) return base;
  const version = service.version ? ` · ${service.version}` : "";
  return service.message + version;
}

function renderStatus(tab, container, inspect, readIndex) {
  const { plugin } = tab;
  const t = (key, vars) => plugin.t(key, vars);
  const view = container.ownerDocument.defaultView;
  const box = container.createDiv({ cls: "session-atlas-status" });
  const catalog = new Setting(box).setName(t("setup.index")).setDesc(t("setup.checking"));
  let open, rescan, restart;
  catalog.addButton(button => {
    open = button.setButtonText(t("setup.open")).setDisabled(true).onClick(async () => {
      await plugin.openAtlas();
      tab.app.setting?.close();
    });
  });
  catalog.addButton(button => {
    rescan = button.setButtonText(t("setup.reindex")).setDisabled(true);
  });
  catalog.addButton(button => {
    restart = button.setButtonText(t("setup.restartCatalog")).onClick(async () => {
      button.setDisabled(true);
      view.clearTimeout(timer);
      const id = ++renderId;
      await restartCatalog(plugin);
      if (id !== renderId || !box.isConnected) return;
      await refresh().catch(reportEnvironmentError);
      button.setDisabled(false);
    });
    restart.buttonEl.hidden = true;
  });
  const checks = box.createDiv();
  let timer;
  let index, openCodeRow, openCodeFound;
  let renderId = 0;
  const updateIndex = info => {
    index = info;
    catalog.setDesc(catalogDetail(plugin, info));
    rescan.setDisabled(!!info?.indexing);
    openCodeRow?.setDesc(openCodeDetail(t, info, openCodeFound));
  };
  const pollIndex = id => {
    timer = view.setTimeout(async () => {
      if (id !== renderId || !box.isConnected) return;
      const info = await readIndex();
      if (id !== renderId || !box.isConnected) return;
      if (info) {
        updateIndex(info);
        pollIndex(id);
      } else {
        rescan.setDisabled(true);
        await refresh().catch(reportEnvironmentError);
      }
    }, index?.indexing ? 1500 : 30000);
  };
  rescan.onClick(async () => {
    view.clearTimeout(timer);
    const id = ++renderId;
    if (index) updateIndex({ ...index, indexing: true });
    else rescan.setDisabled(true);
    await rescanCatalog(plugin);
    if (id === renderId && box.isConnected) await refresh();
  });

  async function refresh() {
    const id = ++renderId;
    const { macos, python, clt, shell, up } = await inspect();
    const info = up ? await readIndex() : null;
    if (id !== renderId || !box.isConnected) return;
    checks.empty();
    const row = (name, detail) => new Setting(checks).setName(name).setDesc(detail);
    index = info;
    if (info) pollIndex(id);
    if (!up) {
      const reason = (plugin.serverProblemShort || plugin.serverProblem || "").trim().split("\n", 1)[0];
      catalog.setDesc(reason ? `${t("setup.serverDown")} · ${reason}` : t("setup.serverDown"));
    } else {
      catalog.setDesc(catalogDetail(plugin, info));
    }
    open.setDisabled(!up);
    rescan.setDisabled(!info || !!info.indexing);
    restart.buttonEl.hidden = !!info;
    restart.setDisabled(false);
    if (agentKinds.some(kind => shell[kind])) {
      for (const kind of agentKinds.filter(kind => kind !== "opencode")) {
        const detail = shell[kind] ? "setup.found" : kind === "claude" ? "setup.claudeMissing" : "setup.notFoundOptional";
        row(getAgent(kind).label, t(detail));
      }
    } else {
      row(t("setup.noAgents"), "");
    }
    openCodeFound = !!shell.opencode;
    openCodeRow = row(getAgent("opencode").label, openCodeDetail(t, info, openCodeFound));
    if (openCodeRow.nameEl?.createSpan) {
      const icon = openCodeRow.nameEl.createSpan({ cls: "sa-opencode-mark" });
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, AGENT_ICONS.opencode);
      openCodeRow.nameEl.prepend(icon);
    }
    if (macos && Number(macos.split(".")[0]) < MIN_MACOS) {
      row("macOS", t("setup.macosOld", { version: macos, min: MIN_MACOS }));
    }
    if (!python) {
      const missing = row(t("setup.python"), t(clt ? "setup.pythonUnfit" : "setup.pythonMissing"));
      if (!clt) missing.addButton(button => button.setButtonText(t("setup.installClt")).onClick(installClt));
    }
  }

  refresh().catch(reportEnvironmentError);
  return () => { renderId += 1; view.clearTimeout(timer); };
}

function statusDefinitions(tab) {
  const { plugin } = tab;
  const t = key => plugin.t(key);
  let pending;
  const inspect = () => {
    pending ||= Promise.all([
      plugin.macosVersion(), plugin.findPython(), plugin.commandLineToolsInstalled(), plugin.shellProbe(), plugin.healthInfo(),
    ]).then(([macos, python, clt, shell, health]) => ({
      macos, python, clt, shell, up: health?.app === "session-atlas",
    })).finally(() => { pending = null; });
    return pending;
  };
  const indexListeners = new Set();
  let pendingIndex;
  const readIndex = () => {
    pendingIndex ||= indexStatus(plugin).then(info => {
      for (const update of indexListeners) update(info);
      return info;
    }).finally(() => { pendingIndex = null; });
    return pendingIndex;
  };
  const watchIndex = update => {
    indexListeners.add(update);
    void inspect().then(({ up }) => up && indexListeners.has(update) ? readIndex() : null)
      .catch(error => console.error("AI Session Atlas: index status check failed", error));
    return () => indexListeners.delete(update);
  };

  const status = { ...group(tab, "setup.heading", [{
    ...definition(tab, "setup.index", null, setting => {
      setting.settingEl.empty();
      setting.settingEl.addClass("session-atlas-status-section");
      return renderStatus(tab, setting.settingEl, inspect, readIndex);
    }),
    aliases: [...agentKinds.map(kind => getAgent(kind).label), ...["setup.open", "setup.reindex", "setup.restartCatalog"].map(t)],
  }]), cls: "session-atlas-status-group" };

  const readOnly = (name, detail, controls) => definition(tab, name, null, setting => {
    let active = true;
    setting.setDesc(t("setup.checking"));
    inspect().then(state => {
      if (!active || !setting.settingEl.isConnected) return;
      setting.setDesc(detail(state));
      if (controls) {
        setting.controlEl.empty();
        controls(setting, state);
      }
    }).catch(reportEnvironmentError);
    return () => { active = false; };
  });
  const diagnostics = group(tab, "adv.diagnostics", [
    readOnly("setup.macos", ({ macos }) => macos || t("setup.unknown")),
    readOnly("setup.python", ({ python, clt }) => python ? `${python.path} · ${python.version}`
      : clt ? plugin.t("setup.pythonRejected", { tried: (plugin.pythonRejected || []).join("; ") || "—" })
        : t("setup.pythonMissing"), (setting, { python, clt }) => {
      if (!python && !clt) setting.addButton(button => button.setButtonText(t("setup.installClt")).onClick(installClt));
    }),
    pluginText(tab, "pythonPath", "adv.python", {
      placeholder: automatic(tab), normalize: value => value.trim(),
    }, () => plugin.writeMailArgs?.()),
    ...agentKinds.map(kind => ({
      ...readOnly("setup.agentPath", ({ shell }) => shell[kind] || t("setup.unknown")),
      name: plugin.t("setup.agentPath", { agent: getAgent(kind).label }),
    })),
    readOnly("setup.address", () => plugin.atlasOrigin(), (setting, { up }) => {
      setting.addButton(button => button.setButtonText(t("setup.restart")).onClick(async () => {
        button.setDisabled(true);
        await restartCatalog(plugin);
        await tab.refresh();
      }));
      setting.addButton(button => button.setButtonText(t("setup.reindex")).setDisabled(!up).onClick(async () => {
        button.setDisabled(true);
        await rescanCatalog(plugin);
        await tab.refresh();
      }));
    }),
  ]);
  return { status, diagnostics, watchIndex };
}

export { statusDefinitions };

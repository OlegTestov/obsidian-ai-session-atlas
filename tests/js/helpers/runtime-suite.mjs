// End-to-end check of the build without Obsidian: main.js extracts the embedded server into a temp
// folder, finds python3, starts the server, serves the page and stops.
//
// bundle.test.mjs registers these tests in its own process and also runs this file directly with a
// clean account's environment:   ATLAS_RUNTIME_BUNDLE=<built main.js> node runtime-suite.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import Module from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { setGlobal } from "./globals.mjs";

/** The plugin class from a built main.js, loaded with stand-ins for Obsidian and Electron. */
function loadBundledPlugin(bundle) {
  const noop = class {};
  const stubs = {
    obsidian: { Plugin: class { registerDomEvent() {} register() {} addRibbonIcon() {} addCommand() {} },
                ItemView: noop, Modal: noop, Notice: class { constructor(m) { this.message = m; } },
                PluginSettingTab: noop, Setting: noop, addIcon() {}, TFile: noop, getLanguage: () => "en" },
    electron: { remote: null },
  };
  setGlobal("window", { localStorage: { getItem: () => "en" }, setTimeout, clearTimeout });
  const require = Module.createRequire(import.meta.url);
  const real = Module._load;
  Module._load = (r, p, i) => (stubs[r] ? stubs[r] : real(r, p, i));
  try {
    const mod = require(path.resolve(bundle));
    return mod && mod.default ? mod.default : mod;
  } finally {
    Module._load = real;
  }
}

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const get = (port, p) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port, path: p }, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  }).on("error", () => resolve({ status: 0, body: "" }));
});

const listen = (server, port) => new Promise((r) => server.listen(port, "127.0.0.1", r));

export function defineRuntimeTests(bundle) {
  describe("built plugin runs its embedded server", () => {
    let Plugin;
    let tmp;
    let port;
    let plugin;
    let health;
    let python;
    let vault;
    const servers = [];
    const plugins = [];

    before(async () => {
      Plugin = loadBundledPlugin(bundle);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-runtime-"));
      const projects = path.join(tmp, "projects");
      fs.mkdirSync(projects);
      vault = path.join(tmp, "My Vault");
      fs.mkdirSync(vault);
      port = await freePort();
      plugin = new Plugin();
      plugins.push(plugin);
      plugin.settings = { language: "en" };
      plugin.app = { vault: { adapter: { getBasePath: () => vault }, getName: () => "My Vault" } };
      plugin.dataDirOverride = path.join(tmp, "data");
      // Every agent folder points into the temp dir: the server never reads the real ~/.claude or ~/.codex.
      plugin.serverEnvExtra = { ATLAS_PROJECTS_ROOT: projects, ATLAS_CODEX_HOME: path.join(tmp, "codex"),
                                ATLAS_CLAUDE_SESSIONS: path.join(tmp, "claude-sessions"),
                                CLAUDE_CONFIG_DIR: path.join(tmp, "claude"), CODEX_HOME: path.join(tmp, "codex") };
      plugin.atlasPort = () => port;
    });

    after(async () => {
      for (const p of plugins) p.stopServer();
      for (const s of servers) {
        s.close();
        if (s.closeAllConnections) s.closeAllConnections();
      }
      await delay(300);
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    const newPlugin = (port_, extra) => {
      const p = new Plugin();
      plugins.push(p);
      Object.assign(p, { settings: {}, app: plugin.app, dataDirOverride: plugin.dataDirOverride }, extra);
      p.atlasPort = () => port_;
      return p;
    };

    it("finds python3 ≥ 3.8 with FTS5 and trigram", async () => {
      python = await plugin.findPython();
      assert.ok(python, JSON.stringify(plugin.pythonRejected));
    });

    if (process.env.ATLAS_EXPECT_PYTHON) {
      it("on a clean account uses python3 from Command Line Tools", async () => {
        assert.equal(python && python.path, process.env.ATLAS_EXPECT_PYTHON, JSON.stringify(python));
      });
    }

    it("starts the server from the build", async () => {
      const started = await plugin.startServer();
      assert.ok(started.ok, started.reason);
    });

    it("extracts the server, the page and the scripts", () => {
      const runtime = plugin.runtimeDir();
      for (const f of ["atlas/server.py", "web/index.html", "web/js/core.js", "scripts/agent-resume-terminal.zsh"]) {
        assert.ok(fs.existsSync(path.join(runtime, f)), f);
      }
    });

    it("makes the scripts executable", () => {
      const mode = fs.statSync(path.join(plugin.runtimeDir(), "scripts/agent-resume-terminal.zsh")).mode;
      assert.notEqual(mode & 0o111, 0);
    });

    it("creates config.json with this vault and the language", () => {
      const cfg = JSON.parse(fs.readFileSync(path.join(plugin.dataDirOverride, "config.json"), "utf8"));
      assert.equal(cfg.vaults[0].path, vault);
      assert.equal(cfg.vaults[0].id, "My Vault");
      assert.equal(cfg.language, "en");
    });

    it("/health names the app and the port", async () => {
      health = JSON.parse((await get(port, "/health")).body);
      assert.equal(health.app, "session-atlas");
      assert.equal(health.port, port);
    });

    it("serves the page", async () => {
      const page = await get(port, "/");
      assert.equal(page.status, 200);
      assert.match(page.body, /<title>/);
    });

    it("the plugin reindexes and reads the index status with the token", async () => {
      // The plugin talks to the server itself (settings checks): token from the file, its own Origin.
      const reindex = await plugin.atlasRequest("POST", "/api/reindex", {});
      const status = await plugin.atlasRequest("GET", "/api/index-status");
      assert.equal(reindex.status, 200);
      assert.equal(status.status, 200);
      assert.equal(status.data.sessions, 0);
    });

    it("reads the macOS version", async () => {
      const macos = await plugin.macosVersion();
      assert.match(macos || "", /^\d+\.\d+/);
    });

    it("a second start reuses the running server", async () => {
      const pid = plugin.serverProcess && plugin.serverProcess.pid;
      const again = await plugin.startServer();
      assert.ok(again.ok);
      assert.ok(plugin.serverProcess);
      assert.equal(plugin.serverProcess.pid, pid);
    });

    it("a new version removes stale files and keeps its own", () => {
      const runtime = plugin.runtimeDir();
      fs.writeFileSync(path.join(runtime, "atlas/old_module.py"), "");
      fs.writeFileSync(path.join(runtime, ".version"), "other");
      plugin.extractRuntime(plugin.embeddedPayload());
      assert.ok(!fs.existsSync(path.join(runtime, "atlas/old_module.py")));
      assert.ok(fs.existsSync(path.join(runtime, "atlas/server.py")));
    });

    it("without Command Line Tools never runs /usr/bin/python3", async () => {
      // Without Command Line Tools the system python3 is an installer stub.
      const noClt = new Plugin();
      noClt.settings = {};
      noClt.commandLineToolsInstalled = async () => false;
      const other = await noClt.findPython();
      assert.ok(!other || other.path !== "/usr/bin/python3", JSON.stringify(other));
    });

    it("a foreign program on the port: refusal with a reason", async () => {
      const foreignPort = await freePort();
      const foreign = http.createServer((q, r) => { r.end(JSON.stringify({ ok: true })); });
      servers.push(foreign);
      await listen(foreign, foreignPort);
      const busy = await newPlugin(foreignPort).startServer();
      foreign.close();
      assert.equal(busy.ok, false);
      assert.match(busy.reason || "", /port|порт/i);
    });

    it("/health reports the build version", () => {
      assert.equal(health.version, plugin.embeddedPayload().version);
    });

    it("an old-version server is stopped by token and replaced", async () => {
      // A server of an earlier version (not our child): the plugin asks it to stop and starts its own.
      const stalePort = await freePort();
      let shutdownAsked = false;
      const staleServer = http.createServer((q, r) => {
        if (q.method === "POST" && q.url === "/api/shutdown") {
          const token = fs.readFileSync(path.join(plugin.dataDirOverride, "csrf.token"), "utf8").trim();
          shutdownAsked = q.headers["x-atlas-token"] === token;
          r.end("{}");
          staleServer.close();
          if (staleServer.closeAllConnections) staleServer.closeAllConnections();
          return;
        }
        r.end(JSON.stringify({ ok: true, app: "session-atlas", port: stalePort, version: "old" }));
      });
      servers.push(staleServer);
      await listen(staleServer, stalePort);
      const upgraded = newPlugin(stalePort, { settings: { language: "en" }, serverEnvExtra: plugin.serverEnvExtra });
      const swap = await upgraded.startServer();
      const fresh = JSON.parse((await get(stalePort, "/health")).body || "{}");
      upgraded.stopServer();
      assert.ok(swap.ok, swap.reason);
      assert.ok(shutdownAsked);
      assert.equal(fresh.version, plugin.embeddedPayload().version);
    });

    it("unloading the plugin stops the server", async () => {
      plugin.stopServer();
      await delay(500);
      const afterStop = await get(port, "/health");
      assert.equal(afterStop.status, 0);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  defineRuntimeTests(process.env.ATLAS_RUNTIME_BUNDLE);
}

/**
 * Сквозная проверка сборки без Obsidian: main.js распаковывает встроенный сервер во временную
 * папку, находит python3, запускает сервер, отдаёт страницу, останавливает.
 *
 *   node tools/test_runtime.js <собранный main.js>
 */
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");

const bundle = path.resolve(process.argv[2]);
const noop = class {};
const stubs = { obsidian: { Plugin: class { registerDomEvent() {} register() {} addRibbonIcon() {} addCommand() {} },
  ItemView: noop, Modal: noop, Notice: class { constructor(m) { console.log("  notice:", m); } },
  PluginSettingTab: noop, Setting: noop, addIcon() {}, TFile: noop } };
const real = Module._load;
Module._load = (r, p, i) => (stubs[r] ? stubs[r] : real(r, p, i));
global.window = { localStorage: { getItem: () => "en" }, setTimeout, clearTimeout };
const Plugin = require(bundle);
Module._load = real;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : " → " + JSON.stringify(detail)}`);
};
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const get = (port, p) => new Promise((resolve) => {
  http.get({ host: "127.0.0.1", port, path: p }, (res) => {
    let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body }));
  }).on("error", () => resolve({ status: 0, body: "" }));
});

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-runtime-"));
  const projects = path.join(tmp, "projects");
  fs.mkdirSync(projects);
  const vault = path.join(tmp, "My Vault");
  fs.mkdirSync(vault);
  const port = await freePort();
  const plugin = new Plugin();
  plugin.settings = { language: "en" };
  plugin.app = { vault: { adapter: { getBasePath: () => vault }, getName: () => "My Vault" } };
  plugin.dataDirOverride = path.join(tmp, "data");
  plugin.serverEnvExtra = { ATLAS_PROJECTS_ROOT: projects };
  plugin.atlasPort = () => port;
  try {
    const python = await plugin.findPython();
    check("найден python3 ≥ 3.8 с FTS5 и trigram", !!python, python);
    if (process.env.ATLAS_EXPECT_PYTHON) {
      check("на чистой машине — python3 из Command Line Tools", python && python.path === process.env.ATLAS_EXPECT_PYTHON, python);
    }
    const started = await plugin.startServer();
    check("сервер запущен из сборки", started.ok, started);
    const runtime = plugin.runtimeDir();
    check("распакованы сервер, страница, скрипты", ["atlas/server.py", "web/index.html", "web/js/core.js",
      "scripts/agent-resume-terminal.zsh"].every((f) => fs.existsSync(path.join(runtime, f))));
    check("скрипты исполняемые", (fs.statSync(path.join(runtime, "scripts/agent-resume-terminal.zsh")).mode & 0o111) !== 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(plugin.dataDirOverride, "config.json"), "utf8"));
    check("config.json заведён: этот vault, язык", cfg.vaults[0].path === vault && cfg.vaults[0].id === "My Vault"
          && cfg.language === "en", cfg);
    const health = JSON.parse((await get(port, "/health")).body);
    check("/health называет себя", health.app === "session-atlas" && health.port === port, health);
    const page = await get(port, "/");
    check("страница отдаётся", page.status === 200 && /<title>/.test(page.body));
    // Плагин ходит к серверу сам (экран проверок): токен из файла, Origin — свой.
    const reindex = await plugin.atlasRequest("POST", "/api/reindex", {});
    const status = await plugin.atlasRequest("GET", "/api/index-status");
    check("плагин: пересборка и состояние индекса по токену", reindex.status === 200
          && status.status === 200 && status.data.sessions === 0, [reindex.status, status]);
    const macos = await plugin.macosVersion();
    check("версия macOS читается", /^\d+\.\d+/.test(macos || ""), macos);
    // Второй запуск: сервер уже работает — второй процесс не нужен.
    const pid = plugin.serverProcess && plugin.serverProcess.pid;
    check("повторный запуск берёт работающий", (await plugin.startServer()).ok && plugin.serverProcess
          && plugin.serverProcess.pid === pid);
    // Файл от старой версии удаляется, свои — на месте.
    fs.writeFileSync(path.join(runtime, "atlas/old_module.py"), "");
    fs.writeFileSync(path.join(runtime, ".version"), "другая");
    plugin.extractRuntime(plugin.embeddedPayload());
    check("новая версия: чужое удалено, своё на месте", !fs.existsSync(path.join(runtime, "atlas/old_module.py"))
          && fs.existsSync(path.join(runtime, "atlas/server.py")));
    // Без Command Line Tools системный python3 — заглушка установщика: его не трогаем.
    const noClt = new Plugin();
    noClt.settings = {};
    noClt.commandLineToolsInstalled = async () => false;
    const other = await noClt.findPython();
    check("без Command Line Tools /usr/bin/python3 не запускается", !other || other.path !== "/usr/bin/python3", other);
    // На порту чужая программа — не наш сервер: не притворяемся, что всё хорошо.
    const foreignPort = await freePort();
    const foreign = http.createServer((q, r) => { r.end(JSON.stringify({ ok: true })); });
    await new Promise((r) => foreign.listen(foreignPort, "127.0.0.1", r));
    const intruded = new Plugin();
    intruded.settings = {};
    intruded.app = plugin.app;
    intruded.dataDirOverride = plugin.dataDirOverride;
    intruded.atlasPort = () => foreignPort;
    const busy = await intruded.startServer();
    check("чужая программа на порту — отказ с причиной", !busy.ok && /port|порт/i.test(busy.reason || ""), busy);
    foreign.close();
    check("/health называет версию сборки", health.version === plugin.embeddedPayload().version, health);
    // Сервер прошлой версии (не наш дочерний) — плагин просит его остановиться и запускает свой.
    const stalePort = await freePort();
    let shutdownAsked = false;
    const staleServer = http.createServer((q, r) => {
      if (q.method === "POST" && q.url === "/api/shutdown") {
        shutdownAsked = q.headers["x-atlas-token"] === fs.readFileSync(path.join(plugin.dataDirOverride, "csrf.token"), "utf8").trim();
        r.end("{}");
        staleServer.close();
        staleServer.closeAllConnections && staleServer.closeAllConnections();
        return;
      }
      r.end(JSON.stringify({ ok: true, app: "session-atlas", port: stalePort, version: "old" }));
    });
    await new Promise((r) => staleServer.listen(stalePort, "127.0.0.1", r));
    const upgraded = new Plugin();
    upgraded.settings = { language: "en" };
    upgraded.app = plugin.app;
    upgraded.dataDirOverride = plugin.dataDirOverride;
    upgraded.serverEnvExtra = plugin.serverEnvExtra;
    upgraded.atlasPort = () => stalePort;
    const swap = await upgraded.startServer();
    const fresh = JSON.parse((await get(stalePort, "/health")).body || "{}");
    check("сервер старой версии остановлен по токену, запущен свой", swap.ok && shutdownAsked
          && fresh.version === plugin.embeddedPayload().version, [swap, shutdownAsked, fresh]);
    upgraded.stopServer();
  } finally {
    plugin.stopServer();
    await new Promise((r) => setTimeout(r, 500));
    const after = await get(port, "/health");
    check("после выгрузки плагина сервер остановлен", after.status === 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} проверок упало` : "\nсборка работает сама");
  process.exit(failures ? 1 : 0);
})();

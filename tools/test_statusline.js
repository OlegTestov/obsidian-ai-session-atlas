/** Строка состояния в ~/.claude/settings.json: своя ставится и снимается, чужая не трогается.
 *   node tools/test_statusline.js */
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require(path.join(__dirname, "..", "obsidian-plugin", "src", "statusline.js"));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : " → " + JSON.stringify(detail)}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-statusline-"));
// Пробел в пути — как в «Application Support»: команда обязана его пережить.
const runtime = path.join(tmp, "Application Support", "session-atlas", "runtime");
fs.mkdirSync(path.join(runtime, "atlas"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "..", "atlas", "statusline.py"), path.join(runtime, "atlas", "statusline.py"));
const claudeDir = path.join(tmp, "claude");
const file = path.join(claudeDir, "settings.json");

function plugin() {
  const p = { claudeDirOverride: claudeDir, runtimeDir: () => runtime, embeddedPayload: () => null,
              findPython: async () => ({ path: "/usr/bin/python3", version: "3.9" }) };
  for (const name of Object.getOwnPropertyNames(S.StatusLineMethods.prototype)) {
    if (name !== "constructor") p[name] = S.StatusLineMethods.prototype[name].bind(p);
  }
  return p;
}
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

(async () => {
  const p = plugin();
  check("нет файла — выключено", p.statusLineState().state === "off");

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { Stop: [] } }));
  let r = await p.setStatusLine(true);
  const cfg = read();
  check("включение: своя строка, остальные ключи на месте", r.ok && p.statusLineState().state === "ours"
        && cfg.model === "opus" && cfg.hooks && cfg.statusLine.type === "command", cfg);
  check("копия исходного файла рядом", JSON.parse(fs.readFileSync(file + S.BACKUP_SUFFIX, "utf8")).model === "opus"
        && !("statusLine" in JSON.parse(fs.readFileSync(file + S.BACKUP_SUFFIX, "utf8"))));

  const home = path.join(tmp, "atlas-home");
  const out = childProcess.spawnSync("/bin/sh", ["-c", cfg.statusLine.command], {
    input: JSON.stringify({ model: { display_name: "Opus" },
                            rate_limits: { seven_day: { used_percentage: 12, resets_at: 1790548575 } } }),
    env: Object.assign({}, process.env, { ATLAS_HOME: home }), encoding: "utf8" });
  check("команда работает через sh, путь с пробелом не ломается",
        out.status === 0 && out.stdout.startsWith("Opus · week 12%")
        && fs.existsSync(path.join(home, "rate-limits.json")), out.stdout + out.stderr);

  r = await p.setStatusLine(false);
  check("выключение: строки нет, остальное цело", r.ok && !("statusLine" in read()) && read().model === "opus");

  fs.writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command: "~/bin/my-line.sh" } }));
  r = await p.setStatusLine(true);
  check("чужая строка — не трогаем", !r.ok && r.reason === "foreign" && read().statusLine.command === "~/bin/my-line.sh");
  r = await p.setStatusLine(false);
  check("и выключение чужую не снимает", !r.ok && read().statusLine.command === "~/bin/my-line.sh");

  fs.writeFileSync(file, "{ не json");
  r = await p.setStatusLine(true);
  check("битый файл — не трогаем", !r.ok && r.reason === "broken" && fs.readFileSync(file, "utf8") === "{ не json");

  check("своя — и из репозитория", S.isOurStatusLine("python3.11 ~/Code/session-atlas/tools/statusline.py")
        && !S.isOurStatusLine("python3 ~/statusline.py"));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} проверок упало` : "\nстрока состояния в порядке");
  process.exit(failures ? 1 : 0);
})();

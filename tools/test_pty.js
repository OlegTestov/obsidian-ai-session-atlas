/**
 * Псевдотерминал на системных утилитах: настоящий tty, размер, Ctrl-C, UTF-8, выход, закрытие.
 *
 *   node tools/test_pty.js
 */
const path = require("path");
const { spawnPty } = require(path.join(__dirname, "..", "obsidian-plugin", "src", "pty.js"));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : " → " + JSON.stringify(detail)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

(async () => {
  const env = Object.assign({}, process.env, { TERM: "xterm-256color", LANG: "en_US.UTF-8", PS1: "$ " });
  const pty = spawnPty({ file: "/bin/sh", args: [], cwd: "/tmp", env, cols: 132, rows: 40 });
  let out = "";
  let exitCode;
  pty.onData((d) => { out += d; });
  pty.onExit((c) => { exitCode = c; });
  await sleep(500);
  pty.write("tty; stty size; echo 'Привет, мир'\r");
  await sleep(600);
  const tty = await pty.tty();
  check("настоящий tty", tty && /^\/dev\/ttys\d+$/.test(tty.tty) && clean(out).includes(tty.tty), tty);
  check("начальный размер — до запуска программы", clean(out).includes("40 132"), clean(out).slice(-200));
  check("UTF-8 туда и обратно", clean(out).includes("Привет, мир"));
  // Буква и линия рамки приходят половинками в разных кусках вывода — склеиваются без «��».
  pty.write("printf '\\320'; sleep 0.3; printf '\\277\\342\\224'; sleep 0.3; printf '\\200\\n'\r");
  await sleep(1200);
  check("UTF-8 разрезан между кусками — без битых знаков", clean(out).includes("п─") && !out.includes("\uFFFD"),
        clean(out).slice(-80));
  await pty.resize(100, 30);
  pty.write("stty size\r");
  await sleep(500);
  check("размер меняется снаружи", clean(out).includes("30 100"), clean(out).slice(-100));
  pty.write("sleep 30 && echo NOT-INTERRUPTED\r");
  await sleep(400);
  pty.write("\x03");
  await sleep(400);
  pty.write("echo AFTER\r");
  await sleep(500);
  // «NOT-INTERRUPTED» встречается один раз — в эхе набранной команды; второй был бы её вывод.
  check("Ctrl-C прерывает программу", clean(out).includes("AFTER")
        && clean(out).split("NOT-INTERRUPTED").length === 2, clean(out).slice(-300));
  pty.write("exit\r");
  for (let i = 0; i < 30 && exitCode === undefined; i++) await sleep(200);
  check("выход программы — вкладка узнаёт", exitCode !== undefined);

  // Подхват: новая вкладка получает хвост вывода и дальнейший вывод, старая — уже нет.
  const long = spawnPty({ file: "/bin/sh", args: [], cwd: "/tmp", env, cols: 80, rows: 24 });
  let first = "";
  long.onData((d) => { first += d; });
  await sleep(400);
  long.write("echo BEFORE-RELOAD\r");
  await sleep(400);
  let second = "";
  long.onData((d) => { second += d; });
  check("хвост вывода для новой вкладки", clean(long.recent()).includes("BEFORE-RELOAD"));
  long.write("echo AFTER-RELOAD\r");
  await sleep(400);
  check("вывод идёт новой вкладке, не старой", clean(second).includes("AFTER-RELOAD")
        && !clean(first).includes("AFTER-RELOAD"));
  long.kill();

  // Закрытие вкладки гасит всё дерево, даже если программа занята.
  const busy = spawnPty({ file: "/bin/sh", args: ["-c", "sleep 60"], cwd: "/tmp", env, cols: 80, rows: 24 });
  await sleep(500);
  const inner = await busy.tty();
  busy.kill();
  await sleep(500);
  let alive = true;
  try { process.kill(inner.pid, 0); } catch (e) { alive = false; }
  check("закрытие гасит программу внутри", inner && !alive);

  console.log(failures ? `\n${failures} проверок упало` : "\nпсевдотерминал работает");
  process.exit(failures ? 1 : 0);
})();

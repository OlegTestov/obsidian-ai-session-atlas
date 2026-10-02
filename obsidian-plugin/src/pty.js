// Псевдотерминал без нативных модулей и без Python: системный /usr/bin/script даёт настоящий
// tty. Напрямую из node он не работает — node подаёт дочернему процессу stdin сокетом, а script
// требует канал или tty («tcgetattr: Operation not supported on socket»). cat посередине даёт
// ему обычный канал. Размер: при старте — stty внутри tty до запуска программы, потом —
// stty -f снаружи (ядро само шлёт программе SIGWINCH). Проверено на macOS 14.
const { StringDecoder } = require("string_decoder");
const childProcess = require("child_process");

const SCRIPT = "/usr/bin/script";
// Внутри tty: выставить размер и заменить себя программой. Аргументы — через "$@", без кавычек.
const INNER = 'stty rows "$1" cols "$2" 2>/dev/null; shift 2; exec "$@"';
const OUTER = 'cat | exec ' + SCRIPT + ' -q /dev/null "$@"';
const LIVENESS_MS = 3000;
const RECENT_BYTES = 256 * 1024;     // хвост вывода: новая вкладка подхватывает процесс и показывает его

function execFile(file, args) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { timeout: 3000, encoding: "utf8" },
      (error, stdout) => resolve(error ? "" : stdout));
  });
}

/** Таблица процессов: pid → {ppid, tty}. */
async function processTable() {
  const out = new Map();
  for (const line of (await execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,tty="])).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3] });
  }
  return out;
}

/** Первый потомок root с настоящим tty — программа внутри псевдотерминала. */
function findTtyChild(table, root) {
  const children = new Map();
  for (const [pid, p] of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) || []) {
      const tty = table.get(child).tty;
      if (tty && tty !== "??" && tty !== "-") return { pid: child, tty: "/dev/" + (tty.startsWith("tty") ? tty : "tty" + tty) };
      queue.push(child);
    }
  }
  return null;
}

/**
 * Запуск программы в псевдотерминале. {pid, write, resize, kill, onData, onExit}.
 * pid — корень дерева процессов вкладки: программа — его потомок (по нему «Активные» находят
 * вкладку сессии).
 */
function spawnPty({ file, args = [], cwd, env, cols = 80, rows = 24 }) {
  const inner = ["/bin/sh", "-c", INNER, "atlas-pty", String(rows), String(cols), file, ...args];
  const child = childProcess.spawn("/bin/sh", ["-c", OUTER, "atlas-pty", ...inner], {
    cwd, env, detached: true,          // своя группа процессов: закрытие вкладки гасит всё дерево
  });
  // Получатель один и сменяемый: после перезагрузки плагина процесс подхватывает новая вкладка.
  let sink = null;
  let exitSink = null;
  let recent = "";
  let tty = null;
  let exited = false;
  let exitCode = null;
  // Буква UTF-8 может прийти половинками в двух кусках: декодер держит хвост до следующего,
  // иначе вместо кириллицы и линий рамки — «��», а строка ввода переносится.
  const reader = () => {
    const decoder = new StringDecoder("utf8");
    return (chunk) => {
      const text = decoder.write(chunk);
      if (!text) return;
      recent = (recent + text).slice(-RECENT_BYTES);
      if (typeof sink === "function") sink(text);
    };
  };
  child.stdout.on("data", reader());
  child.stderr.on("data", reader());
  child.stdin.on("error", () => { /* программа уже вышла — запись в закрытый канал */ });
  const finish = (code) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    clearInterval(liveness);
    if (exitSink) exitSink(code);
  };
  child.on("exit", finish);

  const findTty = async () => {
    if (tty) return tty;
    for (let i = 0; i < 20 && !tty && !exited; i++) {
      tty = findTtyChild(await processTable(), child.pid);
      if (!tty) await new Promise((r) => setTimeout(r, 100));
    }
    return tty;
  };
  // Программа вышла, а cat всё ещё ждёт ввода — без этого вкладка не узнала бы о выходе.
  const liveness = setInterval(async () => {
    const t = await findTty();
    if (!t) return;
    try { process.kill(t.pid, 0); } catch (error) { try { child.stdin.end(); } catch (e) { /* уже закрыт */ } }
  }, LIVENESS_MS);

  return {
    pid: child.pid,
    write(data) { if (!exited) child.stdin.write(data); },
    async resize(newCols, newRows) {
      const t = await findTty();
      if (t) await execFile("/bin/stty", ["-f", t.tty, "rows", String(newRows), "cols", String(newCols)]);
    },
    kill(signal = "SIGHUP") {
      clearInterval(liveness);
      try { process.kill(-child.pid, signal); } catch (error) { /* группы уже нет */ }
    },
    onData(fn) { sink = fn; },
    onExit(fn) { exitSink = fn; if (exited) fn(exitCode); },
    recent() { return recent; },
    get exited() { return exited; },
    tty: findTty,
  };
}

module.exports = { spawnPty, findTtyChild, processTable };

// A pseudo-terminal without native modules or Python: the system /usr/bin/script provides a real
// tty. It does not work straight from node: node gives the child a socket for stdin, while script
// needs a pipe or a tty ("tcgetattr: Operation not supported on socket"). cat in between gives it a
// plain pipe. Size: at start, stty inside the tty before the program runs; later, stty -f from
// outside (the kernel sends the program SIGWINCH itself). Checked on macOS 14.
import { StringDecoder } from "string_decoder";
import * as childProcess from "child_process";

const SCRIPT = "/usr/bin/script";
// Inside the tty: set the size and replace itself with the program. Arguments go through "$@", unquoted.
const INNER = 'stty rows "$1" cols "$2" 2>/dev/null; shift 2; exec "$@"';
const OUTER = 'cat | exec ' + SCRIPT + ' -q /dev/null "$@"';
const LIVENESS_MS = 3000;
const RECENT_BYTES = 256 * 1024;     // output tail: a new tab picks up the process and shows it

function execFile(file, args) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { timeout: 3000, encoding: "utf8" },
      (error, stdout) => resolve(error ? "" : stdout));
  });
}

/** Process table: pid → {ppid, tty}. */
async function processTable() {
  const out = new Map();
  for (const line of (await execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,tty="])).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3] });
  }
  return out;
}

/** The first descendant of root with a real tty: the program inside the pseudo-terminal. */
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
 * Runs a program in a pseudo-terminal. {pid, write, resize, kill, onData, onExit}.
 * pid is the root of the tab's process tree and the program descends from it (the Active view
 * finds a session's tab by it).
 */
function spawnPty({ file, args = [], cwd, env, cols = 80, rows = 24 }) {
  const inner = ["/bin/sh", "-c", INNER, "atlas-pty", String(rows), String(cols), file, ...args];
  const child = childProcess.spawn("/bin/sh", ["-c", OUTER, "atlas-pty", ...inner], {
    cwd, env, detached: true,          // own process group: closing the tab ends the whole tree
  });
  // One replaceable receiver: after a plugin reload a new tab picks up the process.
  let sink = null;
  let exitSink = null;
  let recent = "";
  let tty = null;
  let exited = false;
  let exitCode = null;
  // A UTF-8 character may arrive split across two chunks: the decoder keeps the tail for the next
  // one, otherwise Cyrillic and box-drawing characters turn into "��" and the input line wraps.
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
  child.stdin.on("error", () => { /* the program has exited: a write to a closed pipe */ });
  const finish = (code) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    window.clearInterval(liveness);
    if (exitSink) exitSink(code);
  };
  child.on("exit", finish);

  const findTty = async () => {
    if (tty) return tty;
    for (let i = 0; i < 20 && !tty && !exited; i++) {
      tty = findTtyChild(await processTable(), child.pid);
      if (!tty) await new Promise((r) => window.setTimeout(r, 100));
    }
    return tty;
  };
  // The program exited while cat still waits for input: without this the tab never learns of the exit.
  const liveness = window.setInterval(async () => {
    const t = await findTty();
    if (!t) return;
    try { process.kill(t.pid, 0); } catch { try { child.stdin.end(); } catch { /* already closed */ } }
  }, LIVENESS_MS);

  return {
    pid: child.pid,
    write(data) { if (!exited) child.stdin.write(data); },
    async resize(newCols, newRows) {
      const t = await findTty();
      if (t) await execFile("/bin/stty", ["-f", t.tty, "rows", String(newRows), "cols", String(newCols)]);
    },
    kill(signal = "SIGHUP") {
      window.clearInterval(liveness);
      try { process.kill(-child.pid, signal); } catch { /* the group is gone */ }
    },
    onData(fn) { sink = fn; },
    onExit(fn) { exitSink = fn; if (exited && typeof fn === "function") fn(exitCode); },
    recent() { return recent; },
    get exited() { return exited; },
    tty: findTty,
  };
}

export { spawnPty, findTtyChild, processTable };

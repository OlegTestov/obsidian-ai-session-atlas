// A stand-in for Obsidian's renderer that owns one terminal and then dies without closing it.
//   node pty-owner.mjs <pid file>
// Starts a program in raw mode (as Claude Code puts its tty) that writes its pid to the file.
import process from "node:process";
import { setGlobal } from "./globals.mjs";
import { loadSrc } from "./load-src.mjs";

setGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval });
const { spawnPty } = loadSrc("pty");
const program = "import os, sys, time, tty\ntty.setraw(0)\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(120)\n";
spawnPty({ file: "/usr/bin/python3", args: ["-c", program, process.argv[2]], cwd: "/tmp",
           env: Object.assign({}, process.env, { TERM: "xterm-256color" }), cols: 80, rows: 24 });
setInterval(() => {}, 1000);

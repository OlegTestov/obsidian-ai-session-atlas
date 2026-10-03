// Node tests load the plugin's ES-module sources through this helper: esbuild converts
// obsidian-plugin/src/ to CommonJS once per process, file by file, so modules share state the way
// they do in the bundle and stubs installed via Module._load still apply to "obsidian".
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SRC = path.join(ROOT, "obsidian-plugin", "src");
export const FIXTURES = path.join(ROOT, "tools", "fixtures");

let outDir = null;

function buildOnce() {
  if (outDir) return outDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-src-"));
  // Bare imports such as @xterm/xterm resolve from the repository's node_modules.
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  esbuild.buildSync({
    entryPoints: fs.readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => path.join(SRC, f)),
    outdir: dir,
    format: "cjs",
    platform: "node",
    target: "es2020",
    logLevel: "error",
  });
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  outDir = dir;
  return outDir;
}

/** require() for a module of obsidian-plugin/src, e.g. loadSrc("statusline"). */
export function loadSrc(name) {
  return require(path.join(buildOnce(), name.replace(/\.js$/, "") + ".js"));
}

/** The plugin class from a module object: CommonJS export or ES default export. */
export function pluginClass(mod) {
  return mod && mod.default ? mod.default : mod;
}

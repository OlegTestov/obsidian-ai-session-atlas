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

const builds = new Map();

function buildOnce(extraAgents) {
  const key = JSON.stringify(extraAgents);
  if (builds.has(key)) return builds.get(key);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-src-"));
  // Bare imports such as @xterm/xterm resolve from the repository's node_modules.
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.mkdirSync(path.join(dir, "atlas"));
  const agents = JSON.parse(fs.readFileSync(path.join(ROOT, "atlas", "agents.json")));
  fs.writeFileSync(path.join(dir, "atlas", "agents.json"), JSON.stringify([...agents, ...extraAgents]));
  esbuild.buildSync({
    entryPoints: fs.readdirSync(SRC).filter((f) => f.endsWith(".js")).map((f) => path.join(SRC, f)),
    outdir: path.join(dir, "obsidian-plugin", "src"),
    format: "cjs",
    platform: "node",
    target: "es2020",
    logLevel: "error",
  });
  for (const name of fs.readdirSync(SRC).filter(f => f.endsWith(".mjs"))) {
    fs.copyFileSync(path.join(SRC, name), path.join(dir, "obsidian-plugin", "src", name));
  }
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  builds.set(key, dir);
  return dir;
}

/** require() for a module of obsidian-plugin/src, e.g. loadSrc("statusline"). */
export function loadSrc(name, extraAgents = []) {
  return require(path.join(buildOnce(extraAgents), "obsidian-plugin", "src", name.replace(/\.js$/, "") + ".js"));
}

/** The plugin class from a module object: CommonJS export or ES default export. */
export function pluginClass(mod) {
  return mod && mod.default ? mod.default : mod;
}

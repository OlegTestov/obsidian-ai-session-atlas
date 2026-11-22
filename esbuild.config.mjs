// Builds the three release files Obsidian installs: main.js, manifest.json, styles.css.
// main.js carries everything: plugin code, xterm.js, and the payload (server, page, tab scripts)
// that the plugin extracts on first start.
//
// The default output is the repository root, as in Obsidian's sample plugin: main.js and styles.css
// are build outputs (git-ignored); manifest.json at the root is the source.
//
//   node esbuild.config.mjs [--outdir DIR]
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { SHELL_REGISTRY, shellRegistry } from "./tools/agent_registry.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf("--outdir");
const OUT = path.resolve(outIndex >= 0 ? args[outIndex + 1] : ROOT);

// What the plugin extracts at runtime. Text files only; tab scripts land in runtime/scripts.
const PAYLOAD = [
  ["atlas", [".py", ".md", ".json"]],
  ["web", ["index.html"]],
  ["web/js", [".js", ".css"]],
  ["obsidian-plugin/scripts", [".zsh"]],
  ["obsidian-plugin/opencode-tab", [".mjs", ".json"]],
];

// The card's terminal renderer: the e2e specs serve exactly this build.
export function terminalRenderer() {
  const terminal = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: ["obsidian-plugin/src/term-mirror-browser.js"],
    bundle: true, minify: true, write: false, platform: "browser", format: "iife",
    target: "es2020", legalComments: "inline",
  });
  return { js: terminal.outputFiles[0].text,
           css: fs.readFileSync(path.join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"), "utf8") };
}

export function payload() {
  const files = {};
  for (const [folder, suffixes] of PAYLOAD) {
    for (const name of fs.readdirSync(path.join(ROOT, folder)).sort()) {
      if (folder === "obsidian-plugin/scripts" && name === SHELL_REGISTRY) continue;
      if (!suffixes.some((s) => name.endsWith(s))) continue;
      const rel = path.posix.join(folder, name).replace(/^obsidian-plugin\//, "");
      files[rel] = fs.readFileSync(path.join(ROOT, folder, name), "utf8");
    }
  }
  files["scripts/" + SHELL_REGISTRY] = shellRegistry();
  const renderer = terminalRenderer();
  files["web/js/card-terminal-renderer.js"] = renderer.js;
  files["web/js/card-terminal-renderer.css"] = renderer.css;
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  const version = createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
  return { version, files: sorted };
}

// src/payload.js is an empty stand-in for tests; the release build swaps in the real payload.
const embedPayload = {
  name: "embed-payload",
  setup(build) {
    build.onResolve({ filter: /^\.\/payload$/ }, () => ({ path: "payload", namespace: "atlas-payload" }));
    build.onLoad({ filter: /.*/, namespace: "atlas-payload" }, () => ({
      contents: `export default ${JSON.stringify(payload())};`,
      loader: "js",
    }));
  },
};

export async function build(outdir = OUT) {
  fs.mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    absWorkingDir: ROOT,
    preserveSymlinks: true,
    entryPoints: [path.join(ROOT, "obsidian-plugin", "src", "main.js")],
    outfile: path.join(outdir, "main.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "es2020",
    external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    banner: { js: "/* AI Session Atlas — https://github.com/OlegTestov/obsidian-ai-session-atlas. Bundles xterm.js (MIT); see THIRD-PARTY-NOTICES.md. */" },
    plugins: [embedPayload],
    define: { __ATLAS_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version) },
    legalComments: "inline",
    logLevel: "warning",
  });
  const xtermCss = fs.readFileSync(path.join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"), "utf8");
  const ownCss = fs.readFileSync(path.join(ROOT, "obsidian-plugin", "styles.css"), "utf8");
  fs.writeFileSync(path.join(outdir, "styles.css"), xtermCss.trimEnd() + "\n\n" + ownCss);
  if (path.resolve(outdir) !== ROOT) fs.copyFileSync(path.join(ROOT, "manifest.json"), path.join(outdir, "manifest.json"));
  return outdir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    process.stdout.write(`${name}\t${fs.statSync(path.join(OUT, name)).size}\n`);
  }
}

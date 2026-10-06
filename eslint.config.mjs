// Obsidian's recommended rules for the whole repository, plus the environments of its three kinds
// of JavaScript: the plugin (Obsidian, desktop), the catalog page (a browser iframe), and Node tools.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(ROOT, "web", "js");

// The page loads its scripts in order as classic <script> tags, so they share one global scope.
// Every top-level declaration of one script, and every `root.name =` export of the UMD-style
// helpers, is a global for the others.
function pageGlobals() {
  const names = {};
  const decl = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const file of fs.readdirSync(PAGE).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(PAGE, file), "utf8");
    for (const m of text.matchAll(decl)) names[m[1]] = "writable";
    for (const m of text.matchAll(/\broot\.([A-Za-z_$][\w$]*)\s*=/g)) names[m[1]] = "readonly";
  }
  return names;
}

export default defineConfig([
  globalIgnores(["dist/", "node_modules/", ".venv/", "main.js"]),
  ...obsidianmd.configs.recommendedWithLocalesEn,
  {
    files: ["web/js/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...pageGlobals(), ATLAS_TOKEN: "readonly" },
    },
    // A script's own top-level names are also listed as page globals above.
    rules: { "no-redeclare": ["error", { builtinGlobals: false }] },
  },
  {
    files: ["tools/**/*.{js,mjs}", "tests/js/**/*.{js,mjs,cjs}", "*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright specs: Node, plus callbacks that run inside the page (page.evaluate).
    files: ["tests/e2e/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { "no-restricted-globals": "off" },
  },
  {
    // The live Obsidian harness: a Node program that drives Obsidian from outside and reports to the console.
    files: ["tools/live/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser, app: "readonly" } },
    rules: { "no-console": "off", "obsidianmd/rule-custom-message": "off", "no-restricted-globals": "off",
             "obsidianmd/hardcoded-config-path": "off" },   // it builds a test vault from outside Obsidian
  },
  {
    // Tests and build scripts run in Node, not in an Obsidian window: popout-window rules do not apply.
    files: ["tests/js/**/*.{js,mjs,cjs}", "tests/e2e/**/*.mjs", "*.mjs", "tools/live/**/*.mjs"],
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/prefer-active-doc": "off",
    },
  },
]);

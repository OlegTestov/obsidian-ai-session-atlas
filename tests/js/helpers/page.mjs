// Loads the catalog page scripts the way the browser does: classic scripts run one after another in
// one shared global scope, where `window` is that global. Each script runs through node:vm in index.html order.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WEB = path.join(ROOT, "web");
export const JS = path.join(WEB, "js");

/** Page scripts in the order index.html loads them. */
export function pageOrder() {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  return [...html.matchAll(/src="\/static\/([\w-]+\.js)"/g)].map((m) => m[1]);
}

/** Dictionary scripts (lang-*.js), sorted. */
export function langFiles() {
  return fs.readdirSync(JS).filter((f) => /^lang-.*\.js$/.test(f)).sort();
}

export function readScript(file) {
  return fs.readFileSync(path.join(JS, file), "utf8");
}

/** Compiles a page script as a classic script without running it. */
export function compileScript(file) {
  return new vm.Script(readScript(file), { filename: path.join(JS, file) });
}

// A stand-in for any DOM object: every property is another stand-in, every call returns one,
// it converts to 0 / "" and iterates as empty. Enough for top-level wiring such as
// $("#x").addEventListener(...) and the startup code in init.js; no rendering happens.
function domStub() {
  const cache = new Map();
  const target = function () {};
  const proxy = new Proxy(target, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return (hint) => (hint === "number" ? 0 : "");
      if (key === Symbol.iterator) return function* () {};
      if (key === "then") return undefined;
      if (key === "length") return 0;
      if (typeof key === "symbol") return undefined;
      if (!cache.has(key)) cache.set(key, domStub());
      return cache.get(key);
    },
    set(_, key, value) { cache.set(key, value); return true; },
    apply() { return domStub(); },
    construct() { return domStub(); },
    has() { return true; },
  });
  return proxy;
}

/**
 * Runs page scripts in one vm context and returns the context (the page's `window`).
 * files: script names under web/js, in load order (default: everything index.html loads).
 */
export function loadPage(files = pageOrder()) {
  const noop = () => 0;
  const ctx = vm.createContext({
    URL,
    URLSearchParams,
    AbortController,
    ATLAS_TOKEN: "test-token",
    location: { search: "", hash: "", pathname: "/", href: "http://127.0.0.1/" },
    navigator: { language: "en", clipboard: { writeText: () => Promise.resolve() } },
    document: domStub(),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    history: { replaceState: noop, pushState: noop },
    addEventListener: noop,
    removeEventListener: noop,
    getComputedStyle: () => domStub(),
    requestAnimationFrame: noop,
    // The page never runs in the background here: timers and network wait forever.
    setTimeout: noop,
    clearTimeout: noop,
    setInterval: noop,
    clearInterval: noop,
    fetch: () => new Promise(() => {}),
    innerWidth: 1280,
    innerHeight: 800,
  });
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.top = ctx;
  ctx.parent = ctx;
  for (const file of files) compileScript(file).runInContext(ctx);
  return ctx;
}

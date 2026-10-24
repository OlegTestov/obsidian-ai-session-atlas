// Local paths in agent tabs: which text is a path, what it resolves to, and how a click opens it.
// The xterm side (rows, wrapping, the mouse) runs on the real xterm.js in tests/e2e/terminal-links.spec.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { loadSrc } from "./helpers/load-src.mjs";

class TFile { constructor(p) { this.path = p; this.extension = p.split(".").pop(); } }
const realLoad = Module._load;
Module._load = (r, p, i) => (r === "obsidian" ? { TFile } : realLoad(r, p, i));
const { findPaths, localTarget, clean } = loadSrc("term-links");
const { OpenPathMethods, resolvePath, vaultFile, agentCwd, launches } = loadSrc("open-path");
Module._load = realLoad;

const HOME = "/Users/alex";
const CWD = `${HOME}/Code/app`;
const disk = new Set([`${HOME}/Code/news/docs/jira/final-comment-24.10.md`, `${CWD}/src/main.rs`, `${CWD}/README.md`,
  `${HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Planner/Week notes.md`, `${HOME}/Заметки/План.md`,
  `${CWD}/docs`, `${CWD}/.env`, `${HOME}/Code/app/very/long/path/notes.md`, CWD]);
const check = (raw) => resolvePath(raw, CWD, HOME, (p) => disk.has(p));
const found = (text, next) => findPaths(text, check, next).map((m) => [text.slice(m.start, m.end), m.path]);

describe("paths in a line of text", () => {
  it("as Claude Code prints them: the full stop after a path is not part of it", () => {
    assert.deepEqual(found("Черновик: ~/Code/news/docs/jira/final-comment-24.10.md."),
      [["~/Code/news/docs/jira/final-comment-24.10.md", `${HOME}/Code/news/docs/jira/final-comment-24.10.md`]]);
  });

  it("relative ones are read from the agent's folder; a line number stays on screen, not in the path", () => {
    assert.deepEqual(found("edited src/main.rs:12:4, README.md and docs#L3"),
      [["src/main.rs:12:4", `${CWD}/src/main.rs`], ["README.md", `${CWD}/README.md`]]);
    assert.deepEqual(found("see ./src/main.rs#L10-L20 and .env"),
      [["./src/main.rs#L10-L20", `${CWD}/src/main.rs`], [".env", `${CWD}/.env`]]);
  });

  it("only what exists: prose, numbers, IPs and missing files stay text", () => {
    assert.deepEqual(found("Стенд .64 до 24.10, и/или nope/missing.md, /usr/nothing, ~ and / alone"), []);
  });

  it("web addresses are left to the web links, even when a part of them looks like a path", () => {
    const everything = (raw) => `/x/${raw}`;
    assert.deepEqual(findPaths("https://github.com/a/b/c.md and ftp://h/x.md", everything), []);
    const short = findPaths("~/a https://x.org/b", everything).map((m) => m.path);
    assert.deepEqual(short, ["/x/~/a"], "a path does not run on into the web address after it");
    assert.deepEqual(found("src/main.rs https://x.org/a").map((m) => m[0]), ["src/main.rs"]);
  });

  it("in brackets, quotes and inline code; not in the middle of a word", () => {
    assert.deepEqual(found("(~/Заметки/План.md) «src/main.rs» `docs/` foo~/Заметки/План.md").map((m) => m[0]),
      ["~/Заметки/План.md", "src/main.rs", "docs/"]);
  });

  it("a long run of dots or a huge line does not freeze a hover", () => {
    let t = Date.now();
    findPaths(`${".".repeat(50000)}y a/b.md`, check);
    findPaths(`${"a".repeat(50000)} x`, check);
    assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
    let asked = 0;
    t = Date.now();
    findPaths(Array(2000).fill("a/b").join(" "), () => { asked++; return null; });
    assert.equal(asked, 0, "a line over the length limit is not searched");
    findPaths(Array(300).fill("a/b").join(" "), () => { asked++; return null; });
    assert.ok(asked <= 200, `${asked} disk checks for one line`);
  });

  it("a bare Cyrillic file name is a path when it exists", () => {
    const plan = (raw) => resolvePath(raw, `${HOME}/Заметки`, HOME, (p) => disk.has(p));
    assert.deepEqual(findPaths("правка в План.md готова", plan).map((m) => m.path), [`${HOME}/Заметки/План.md`]);
  });

  it("words before a path are not looked up on disk: a hover stays cheap", () => {
    const asked = [];
    const counting = (raw) => { asked.push(raw); return check(raw); };
    assert.deepEqual(findPaths("Edit docs then src/main.rs and more", counting).map((m) => m.path), [`${CWD}/src/main.rs`]);
    assert.deepEqual(asked, ["src/main.rs", "src/main.rs and", "src/main.rs and more"]);
  });

  it("a bare word is not a path, even when a folder has that name: `docs` and `src` stay text", () => {
    assert.deepEqual(found("the docs folder and src"), []);
  });

  it("a path with spaces: the longest form that exists, and no further", () => {
    const vault = "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Planner/Week notes.md";
    assert.deepEqual(found(`Vault: ${vault} done`).map((m) => m[0]), [vault]);
    assert.deepEqual(found("open README.md now please").map((m) => m[0]), ["README.md"]);
  });

  it("a path broken at the screen edge goes on in the next line's first word", () => {
    const out = findPaths("See ~/Code/app/very/long/", check, "   path/notes.md for details");
    assert.equal(out.length, 1);
    assert.equal(out[0].path, `${HOME}/Code/app/very/long/path/notes.md`);
    assert.deepEqual(out[0].cont, { start: 3, end: 16 });
    assert.deepEqual(findPaths("See ~/Code/app/very/long/ x", check, "path/notes.md"), []);  // not at the end
    assert.deepEqual(findPaths("See ~/Code/app/very/long/ (x)", check, "path/notes.md"), []); // a path mid-line
  });

  it("broken at a slash: the joined path wins over its first half that exists too", () => {
    const out = findPaths("see ~/Code/app/", check, "src/main.rs for");
    assert.deepEqual(out.map((m) => [m.path, m.cont]), [[`${CWD}/src/main.rs`, { start: 0, end: 11 }]]);
  });

  it("trailing punctuation and line numbers come off in that order", () => {
    assert.deepEqual(clean("a/b.md:12."), { shown: "a/b.md:12", file: "a/b.md" });
    assert.deepEqual(clean("a/b.md…"), { shown: "a/b.md", file: "a/b.md" });
  });
});

describe("links the program marks (OSC 8)", () => {
  it("file:// and editor links are local paths; web links are not", () => {
    assert.equal(localTarget("file:///Users/alex/a%20b.md"), "/Users/alex/a b.md");
    assert.equal(localTarget("file://host.local/Users/alex/a.md"), "/Users/alex/a.md");
    assert.equal(localTarget("vscode://file/Users/alex/app/src/main.rs:12:3"), "/Users/alex/app/src/main.rs");
    assert.equal(localTarget("cursor://file/Users/alex/x.ts"), "/Users/alex/x.ts");
    assert.equal(localTarget("https://example.com/a.md"), null);
    assert.equal(localTarget("vscode://settings/x"), null);
  });
});

describe("resolving a path", () => {
  const exists = (p) => disk.has(p);
  it("~, absolute and relative to the folder; nothing for what is missing or too short", () => {
    assert.equal(resolvePath("~/Заметки/План.md", CWD, HOME, exists), `${HOME}/Заметки/План.md`);
    assert.equal(resolvePath(`${CWD}/src/main.rs`, null, HOME, exists), `${CWD}/src/main.rs`);
    assert.equal(resolvePath("./src/../src/main.rs", CWD, HOME, exists), `${CWD}/src/main.rs`);
    assert.equal(resolvePath("src/main.rs", null, HOME, exists), null);
    assert.equal(resolvePath("src/other.rs", CWD, HOME, exists), null);
    for (const raw of ["~", "/", ".", "..", ""]) assert.equal(resolvePath(raw, CWD, HOME, () => true), null);
    assert.equal(resolvePath(`${CWD}/docs/`, null, HOME, exists), `${CWD}/docs`, "a folder written with a slash");
    assert.equal(resolvePath("~/Code/app/docs/", null, HOME, exists), `${CWD}/docs`);
  });
});

describe("opening a path", () => {
  const VAULT = `${HOME}/Vault`;
  const files = { "Planner/Week.md": new TFile("Planner/Week.md"), "data/x.bin": new TFile("data/x.bin") };
  // The lookup also finds a same-named note for `../x` (the leading `../` dropped): only the base check stops it.
  const app = { vault: { adapter: { getBasePath: () => VAULT },
                         getAbstractFileByPath: (p) => files[p.replace(/^(\.\.\/)+[^/]+\//, "")] || files[p] || null },
                viewRegistry: { isExtensionRegistered: (ext) => ["md", "canvas", "pdf"].includes(ext) } };

  it("a note named in decomposed letters (NFD «й» from ls) is still found in the vault", () => {
    const nfc = "Planner/Синий.md".normalize("NFC");
    const named = { [nfc]: new TFile(nfc) };
    const vault = { vault: { adapter: { getBasePath: () => VAULT }, getAbstractFileByPath: (p) => named[p] || null },
                    viewRegistry: app.viewRegistry };
    assert.equal(vaultFile(vault, `${VAULT}/${"Planner/Синий.md".normalize("NFD")}`), named[nfc]);
  });

  it("a note of this vault is a vault file; other kinds, folders and outside paths are not", () => {
    assert.equal(vaultFile(app, `${VAULT}/Planner/Week.md`), files["Planner/Week.md"]);
    assert.equal(vaultFile(app, `${VAULT}/data/x.bin`), null);
    assert.equal(vaultFile(app, `${VAULT}/Planner`), null);
    assert.equal(vaultFile(app, `${HOME}/Code/app/README.md`), null);
    assert.equal(vaultFile(app, `${HOME}/Other/Planner/Week.md`), null, "the same name in another folder");
    assert.equal(vaultFile({ vault: { adapter: {} } }, `${VAULT}/Planner/Week.md`), null);
  });

  function plugin() {
    const p = Object.assign(Object.create(OpenPathMethods.prototype), { app, opened: [], runs: [] });
    p.openExplorerFile = async (file, newTab) => { p.opened.push([file.path, newTab]); };
    return p;
  }

  it("a vault note opens in a new Obsidian tab; nothing else runs", async () => {
    const p = plugin();
    await p.openLocalPath(`${VAULT}/Planner/Week.md`, {}, async (f, a) => { p.runs.push([f, ...a]); });
    assert.deepEqual(p.opened, [["Planner/Week.md", true]]);
    assert.deepEqual(p.runs, []);
  });

  // A plain file, a folder, an executable file.
  const stat = (p) => ({ isFile: () => !p.endsWith("app") && !p.endsWith("Tool.app"), mode: p.endsWith("/run") ? 0o755 : 0o644 });

  it("another file or a folder goes to `open`; ⌘ shows it in Finder", async () => {
    const p = plugin();
    const exec = async (f, a) => { p.runs.push([f, ...a]); };
    await p.openLocalPath(`${HOME}/Code/app/README.md`, {}, exec, stat);
    await p.openLocalPath(`${HOME}/Code/app`, {}, exec, stat);
    await p.openLocalPath(`${VAULT}/Planner/Week.md`, { reveal: true }, exec, stat);
    assert.deepEqual(p.runs, [["/usr/bin/open", `${HOME}/Code/app/README.md`], ["/usr/bin/open", `${HOME}/Code/app`],
      ["/usr/bin/open", "-R", `${VAULT}/Planner/Week.md`]]);
    assert.deepEqual(p.opened, []);
  });

  it("a file no app takes is shown selected in Finder", async () => {
    const p = plugin();
    const exec = async (f, a) => {
      p.runs.push([f, ...a]);
      if (a[0] !== "-R") throw new Error("No application knows how to open");
    };
    await p.openLocalPath(`${HOME}/Code/app/data.xyz`, {}, exec, stat);
    assert.deepEqual(p.runs, [["/usr/bin/open", `${HOME}/Code/app/data.xyz`], ["/usr/bin/open", "-R", `${HOME}/Code/app/data.xyz`]]);
  });
});

describe("what a click never runs", () => {
  it("apps, scripts, installers and executable files are shown in Finder, not started", async () => {
    const stat = (p) => ({ isFile: () => !p.endsWith(".app"), mode: p.endsWith("/run") ? 0o755 : 0o644 });
    for (const target of ["/x/Tool.app", "/x/setup.command", "/x/a.workflow", "/x/i.pkg", "/x/t.jar", "/x/l.webloc", "/x/run"]) {
      assert.equal(launches(target, stat), true, target);
    }
    for (const target of ["/x/notes.md", "/x/docs", "/x/img.png"]) {
      assert.equal(launches(target, (p) => ({ isFile: () => p !== "/x/docs", mode: 0o644 })), false, target);
    }
    assert.equal(launches("/x/gone.md", () => { throw new Error("ENOENT"); }), true, "unknown counts as running");
    const runs = [];
    const p = Object.assign(Object.create(OpenPathMethods.prototype), { app: {} });
    await p.openLocalPath("/x/setup.command", {}, async (f, a) => { runs.push(a); }, stat);
    assert.deepEqual(runs, [["-R", "/x/setup.command"]]);
  });
});

describe("the folder relative paths are read from", () => {
  const ps = ["  10     1 /bin/sh -c x atlas-pty", "  11    10 /bin/zsh -l -i -c tab", "  12    11 /Users/alex/.local/bin/claude --resume x",
    "  20     1 /bin/zsh"].join("\n");
  const exec = (cwd) => async (file, args) => {
    if (file === "/bin/ps") return ps;
    assert.deepEqual(args, ["-a", "-p", "12", "-d", "cwd", "-Fn"]);
    return `p12\nfcwd\nn${cwd}\n`;
  };

  it("is the agent's own working folder, from lsof", async () => {
    assert.equal(await agentCwd(10, exec("/Users/alex/Code/app")), "/Users/alex/Code/app");
    assert.equal(await agentCwd(20, exec("/x")), null);                       // no agent under it
  });

  it("falls back to the tab's folder, and is kept for a few seconds", async () => {
    const p = Object.create(OpenPathMethods.prototype);
    const view = { pty: { pid: 10, exited: false }, state: { cwd: "/Users/alex/start" } };
    let calls = 0;
    const counting = async (f, a) => { calls++; return exec("/Users/alex/Code/app")(f, a); };
    assert.equal(await p.tabCwd(view, counting), "/Users/alex/Code/app");
    assert.equal(await p.tabCwd(view, counting), "/Users/alex/Code/app");
    assert.equal(calls, 2, "ps and lsof once, then the cached folder");
    const together = { pty: { pid: 10, exited: false }, state: {} };
    calls = 0;
    const dirs = await Promise.all([p.tabCwd(together, counting), p.tabCwd(together, counting), p.tabCwd(together, counting)]);
    assert.deepEqual(dirs, Array(3).fill("/Users/alex/Code/app"));
    assert.equal(calls, 2, "rows hovered at once share one lookup");
    const failing = { pty: { pid: 10, exited: false }, state: { cwd: "/Users/alex/start" } };
    assert.equal(await p.tabCwd(failing, async () => { throw new Error("no lsof"); }), "/Users/alex/start");
    const exited = { pty: { pid: 10, exited: true }, state: { cwd: "/Users/alex/start" } };
    assert.equal(await p.tabCwd(exited, counting), "/Users/alex/start");
  });
});

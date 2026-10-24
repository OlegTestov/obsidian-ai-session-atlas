// Local paths in the agent tab on the real xterm.js: a click on a path that exists opens it, also
// while the program holds the mouse (Claude Code's fullscreen view sends clicks to itself).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { expect, run, test } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const XTERM = path.join(ROOT, "node_modules", "@xterm", "xterm");
const LINKS = esbuild.buildSync({
  entryPoints: [path.join(ROOT, "obsidian-plugin", "src", "term-links.js")],
  bundle: true, write: false, format: "iife", globalName: "AtlasTermLinks", logLevel: "error",
}).outputFiles[0].text;

const HOME = "/Users/alex";
const CWD = `${HOME}/Code/app`;
// What exists on the stand-in disk.
const DISK = new Set([`/t/🎉x.md`, `/t/日本語/a.md`, `/t/${"Синий.md".normalize("NFD")}`, `/t/${"日".repeat(20)}/b.md`,`${HOME}/Code/app/docs/plan-24.10.md`, `${HOME}/Code/app/docs`, `${CWD}/src/main.rs`,
  `${HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Planner/Week notes.md`,
  `${HOME}/Code/app/very/long/folder/structure/for/a/file/that/does/not/fit/on/one/screen/row/notes.md`]);

/** A terminal as the plugin opens it, with the path links; `wired` false = without them. */
async function terminal(page, wired = true, cols = 80, cwdDelay = 0) {
  await page.route(`${run.base}/e2e-links.html`, (route) => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><html><body style="margin:0"><div id="box"></div></body></html>' }));
  await page.goto(`${run.base}/e2e-links.html`);
  await page.addStyleTag({ content: fs.readFileSync(path.join(XTERM, "css", "xterm.css"), "utf8") });
  await page.addScriptTag({ content: fs.readFileSync(path.join(XTERM, "lib", "xterm.js"), "utf8") });
  await page.addScriptTag({ content: LINKS });
  await page.evaluate(({ wired, cols, disk, home, cwd, cwdDelay }) => {
    const exists = new Set(disk);
    const check = (raw, dir) => {
      let full = raw.startsWith("~/") ? home + raw.slice(1) : raw.startsWith("/") ? raw : `${dir}/${raw}`;
      full = full.replace(/\/\.\//g, "/");
      return exists.has(full) ? full : null;
    };
    const term = new window.Terminal({ cols, rows: 12, fontSize: 13, allowProposedApi: true,
      linkHandler: { allowNonHttpProtocols: true, activate: (event, uri) => { window.linkEvent = event; window.opened.push(`osc8:${uri}`); } } });
    term.open(document.getElementById("box"));
    window.opened = [];
    window.toProgram = [];
    term.onData((d) => window.toProgram.push(d));
    if (wired) {
      const paths = { check, cwd: () => new Promise((r) => setTimeout(() => r(cwd), cwdDelay)) };
      term.registerLinkProvider(window.AtlasTermLinks.pathLinkProvider(term, paths));
      window.AtlasTermLinks.pathClicks(term, { ...paths, taken: (e) => e === window.linkEvent,
        open: (p, event) => window.opened.push(event.metaKey ? `reveal:${p}` : p) });
    }
    window.term = term;
  }, { wired, cols, disk: [...DISK], home: HOME, cwd: CWD, cwdDelay });
  return page.locator("#box .xterm-screen");
}

const write = (page, text) => page.evaluate((t) => new Promise((r) => window.term.write(t, r)), text);
const takeMouse = (page) => write(page, "\x1b[?1000h\x1b[?1002h\x1b[?1006h");

/** Clicks the cell (1-based col, row) and returns what was opened. */
async function clickCell(page, screen, col, row, modifier, button = "left") {
  const box = await screen.boundingBox();
  const size = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  const x = box.x + (col - 0.5) * (box.width / size.cols);
  const y = box.y + (row - 0.5) * (box.height / size.rows);
  await page.mouse.move(x - 3, y);
  await page.mouse.move(x, y, { steps: 3 });
  await page.waitForTimeout(150);                 // links are looked up on hover
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.down({ button });
  await page.mouse.up({ button });
  if (modifier) await page.keyboard.up(modifier);
  await page.waitForTimeout(150);
  return page.evaluate(() => window.opened.splice(0));
}

const SCREEN = [
  "Draft: ~/Code/app/docs/plan-24.10.md.",          // row 1: trailing period is not part of it
  "  - edited src/main.rs:12 and nope/missing.md",   // row 2: relative with a line number; missing one
  "folder `~/Code/app/docs` and https://example.com/x",
  "Vault: ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Planner/Week notes.md done",
].join("\r\n");

test("a click on an existing path opens it; the program holds the mouse as Claude Code does", async ({ page }) => {
  const screen = await terminal(page);
  await write(page, SCREEN);
  await takeMouse(page);
  expect(await clickCell(page, screen, 12, 1)).toEqual([`${HOME}/Code/app/docs/plan-24.10.md`]);
  expect(await clickCell(page, screen, 37, 1)).toEqual([]);                       // the period after it
  expect(await clickCell(page, screen, 14, 2)).toEqual([`${CWD}/src/main.rs`]);
  expect(await clickCell(page, screen, 36, 2)).toEqual([]);                       // does not exist
  expect(await clickCell(page, screen, 12, 3)).toEqual([`${HOME}/Code/app/docs`]);
  expect(await clickCell(page, screen, 12, 3, "Meta")).toEqual([`reveal:${HOME}/Code/app/docs`]);
});

test("a path with spaces, wrapped by the terminal over two rows, opens from either row", async ({ page }) => {
  const screen = await terminal(page);
  await write(page, SCREEN);
  const target = `${HOME}/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Planner/Week notes.md`;
  expect(await clickCell(page, screen, 20, 4)).toEqual([target]);
  expect(await clickCell(page, screen, 5, 5)).toEqual([target]);                 // the wrapped part
  expect(await clickCell(page, screen, 13, 5)).toEqual([]);                      // "done" after it
});

test("a path the program broke at the screen edge (a hard line break) opens from both parts", async ({ page }) => {
  const screen = await terminal(page, true, 60);
  const full = "~/Code/app/very/long/folder/structure/for/a/file/that/does/not/fit/on/one/screen/row/notes.md";
  await write(page, `See ${full.slice(0, 56)}\r\n   ${full.slice(56)} for details`);
  const target = `${HOME}/Code/app/very/long/folder/structure/for/a/file/that/does/not/fit/on/one/screen/row/notes.md`;
  expect(await clickCell(page, screen, 10, 1)).toEqual([target]);
  expect(await clickCell(page, screen, 6, 2)).toEqual([target]);
  expect(await clickCell(page, screen, 2, 2)).toEqual([]);                       // the indent
});

test("without the provider a click on a path opens nothing (the state before)", async ({ page }) => {
  const screen = await terminal(page, false);
  await write(page, SCREEN);
  await takeMouse(page);
  expect(await clickCell(page, screen, 12, 1)).toEqual([]);
});

test("a terminal link (OSC 8) to a file goes to the handler, without a browser dialog", async ({ page }) => {
  let dialog = false;
  page.on("dialog", (d) => { dialog = true; d.dismiss(); });
  const screen = await terminal(page);
  await write(page, "\x1b]8;;vscode://file/Users/alex/Code/app/src/main.rs:12\x1b\\src/main.rs:12\x1b]8;;\x1b\\");
  expect(await clickCell(page, screen, 3, 1)).toEqual(["osc8:vscode://file/Users/alex/Code/app/src/main.rs:12"]);
  expect(dialog).toBe(false);
});

test("emoji, CJK and decomposed letters: every cell of the path is part of the link", async ({ page }) => {
  const screen = await terminal(page);
  const nfd = "Синий.md".normalize("NFD");
  await write(page, `/t/🎉x.md\r\n/t/日本語/a.md\r\n/t/${nfd} end`);
  // xterm's width tables give 🎉 one cell and each CJK character two.
  for (const col of [1, 4, 5, 8]) expect(await clickCell(page, screen, col, 1)).toEqual(["/t/🎉x.md"]);
  for (const col of [4, 5, 9, 12]) expect(await clickCell(page, screen, col, 2)).toEqual(["/t/日本語/a.md"]);
  for (const col of [4, 7, 10, 11]) expect(await clickCell(page, screen, col, 3)).toEqual([`/t/${nfd}`]);
  expect(await clickCell(page, screen, 14, 3)).toEqual([]);
});

test("a wide character pushed to the next row by the wrap does not cut the path", async ({ page }) => {
  const screen = await terminal(page, true, 30);
  // "/t/" + 20 wide characters: 43 cells, the 14th character does not fit in the last column of row 1.
  await write(page, `/t/${"日".repeat(20)}/b.md`);
  expect(await clickCell(page, screen, 10, 1)).toEqual([`/t/${"日".repeat(20)}/b.md`]);
  expect(await clickCell(page, screen, 5, 2)).toEqual([`/t/${"日".repeat(20)}/b.md`]);
});

test("only the left button opens: middle and right clicks do not", async ({ page }) => {
  const screen = await terminal(page);
  await write(page, SCREEN);
  expect(await clickCell(page, screen, 12, 1, null, "middle")).toEqual([]);
  expect(await clickCell(page, screen, 12, 1, null, "right")).toEqual([]);
  expect(await clickCell(page, screen, 12, 1, "Alt")).toEqual([]);       // ⌥ and Shift select
  expect(await clickCell(page, screen, 12, 1, "Shift")).toEqual([]);
  expect(await clickCell(page, screen, 12, 1)).toEqual([`${HOME}/Code/app/docs/plan-24.10.md`]);
});

test("the program redraws the screen between hover and click: the click still opens the path", async ({ page }) => {
  const screen = await terminal(page);
  await write(page, SCREEN);
  await takeMouse(page);
  const box = await screen.boundingBox();
  const size = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  const x = box.x + 11.5 * (box.width / size.cols);
  const y = box.y + 0.5 * (box.height / size.rows);
  await page.mouse.move(x - 3, y);
  await page.mouse.move(x, y, { steps: 3 });
  await page.waitForTimeout(150);
  // As a status line does: the whole screen is written again; xterm drops the hovered link.
  await write(page, `\x1b[H${SCREEN}`);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.opened.splice(0))).toEqual([`${HOME}/Code/app/docs/plan-24.10.md`]);
});

test("a drag across a path selects, it does not open", async ({ page }) => {
  const screen = await terminal(page);
  await write(page, SCREEN);
  const box = await screen.boundingBox();
  const size = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  const cell = (col) => box.x + (col - 0.5) * (box.width / size.cols);
  const y = box.y + 0.5 * (box.height / size.rows);
  await page.mouse.move(cell(10), y);
  await page.mouse.down();
  await page.mouse.move(cell(30), y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.opened.splice(0))).toEqual([]);
});

test("a click right after the pointer arrives, while the agent's folder is still looked up, opens the path", async ({ page }) => {
  // ps and lsof take a moment on the first hover: xterm has no link yet when the button goes down.
  const screen = await terminal(page, true, 80, 400);
  await write(page, SCREEN);
  const box = await screen.boundingBox();
  const size = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  await page.mouse.move(box.x + 11.5 * (box.width / size.cols), box.y + 0.5 * (box.height / size.rows));
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.opened.splice(0))).toEqual([`${HOME}/Code/app/docs/plan-24.10.md`]);
});

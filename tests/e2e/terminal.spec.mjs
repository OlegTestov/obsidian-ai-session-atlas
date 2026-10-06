// The agent tab's selection and copy on the real xterm.js, set up the way Obsidian loads it: with node
// integration `process.title` exists, and xterm takes itself for Node instead of macOS. That turned off
// its own "⌥ forces selection" rule, so while Claude Code held the mouse nothing could be selected.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { expect, run, test } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const XTERM = path.join(ROOT, "node_modules", "@xterm", "xterm");
const COPY = esbuild.buildSync({
  entryPoints: [path.join(ROOT, "obsidian-plugin", "src", "term-copy.js")],
  bundle: true, write: false, format: "iife", globalName: "AtlasTermCopy", logLevel: "error",
}).outputFiles[0].text;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

/** A terminal as the plugin opens it; `fixed` applies the plugin's selection setup. */
async function terminal(page, fixed) {
  // On the server's origin: the clipboard API needs a secure context (127.0.0.1 is one, about:blank not).
  await page.route(`${run.base}/e2e-terminal.html`, (route) => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><html><body style="margin:0"><div id="box" style="width:900px;height:400px"></div></body></html>' }));
  await page.goto(`${run.base}/e2e-terminal.html`);
  await page.addScriptTag({ content: 'window.process = { title: "obsidian" };' });   // as in Obsidian
  await page.addStyleTag({ content: fs.readFileSync(path.join(XTERM, "css", "xterm.css"), "utf8") });
  await page.addScriptTag({ content: fs.readFileSync(path.join(XTERM, "lib", "xterm.js"), "utf8") });
  await page.addScriptTag({ content: COPY });
  await page.evaluate((fix) => {
    const term = new window.Terminal({ macOptionIsMeta: true, macOptionClickForcesSelection: true,
                                       rightClickSelectsWord: true, allowProposedApi: true, fontSize: 13 });
    term.open(document.getElementById("box"));
    window.hooked = fix ? window.AtlasTermCopy.selectWithModifier(term) : null;
    term.attachCustomKeyEventHandler((e) => !(window.AtlasTermCopy.isCopyKey(e) && window.AtlasTermCopy.copySelection(term)));
    window.toProgram = [];
    term.onData((d) => window.toProgram.push(d));
    window.term = term;
  }, fixed);
  await page.evaluate(() => new Promise((r) => window.term.write("selectable words on the first line\r\nsecond line\r\n", r)));
  return page.locator("#box .xterm-screen");
}

/** The program asks for the mouse, as Claude Code's fullscreen view does (click, drag, SGR). */
const takeMouse = (page) => page.evaluate(() => new Promise((r) => window.term.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h", r)));

async function drag(page, screen, modifier) {
  const box = await screen.boundingBox();
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(box.x + 4, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 8, { steps: 6 });
  await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
  return page.evaluate(() => window.term.getSelection());
}

test("as loaded in Obsidian, xterm without the fix sends ⌥-drag to the program", async ({ page }) => {
  const screen = await terminal(page, false);
  await takeMouse(page);
  expect(await drag(page, screen, "Alt")).toBe("");
  await expect.poll(() => page.evaluate(() => window.toProgram.join(""))).toContain("\x1b[<");
});

test("the program holds the mouse: ⌥-drag or Shift-drag selects, ⌘C copies", async ({ page }) => {
  const screen = await terminal(page, true);
  expect(await page.evaluate(() => window.hooked)).toBe(true);     // the xterm hook is still there
  await takeMouse(page);
  expect(await drag(page, screen)).toBe("");                      // a plain drag belongs to the program
  await page.evaluate(() => { window.toProgram = []; });
  expect(await drag(page, screen, "Alt")).toMatch(/electable words/);
  expect(await page.evaluate(() => window.toProgram.join(""))).not.toContain("\x1b[<");
  await page.evaluate(() => window.term.clearSelection());
  expect(await drag(page, screen, "Shift")).toMatch(/electable words/);
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await page.locator("#box textarea").focus();
  await page.keyboard.press("Meta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/electable words/);
});

test("the agent exited and the shell is left: a plain drag selects, ⌘C copies", async ({ page }) => {
  const screen = await terminal(page, true);
  await takeMouse(page);
  // The tab script resets the modes after the agent exits (agent-resume-terminal.zsh).
  await page.evaluate(() => new Promise((r) => window.term.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l", r)));
  expect(await drag(page, screen)).toMatch(/electable words/);
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await page.locator("#box textarea").focus();
  await page.keyboard.press("Meta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/electable words/);
});

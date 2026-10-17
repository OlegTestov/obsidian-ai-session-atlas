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


test("Codex image paste bypasses xterm text and inserts one attachment path without Enter", async ({ page }) => {
  await terminal(page, true);
  const source = esbuild.buildSync({ entryPoints: [path.join(ROOT, "obsidian-plugin/src/term-paste.js")],
    bundle: true, write: false, format: "iife", globalName: "AtlasTermPaste" }).outputFiles[0].text;
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.savedImages = [];
    document.getElementById("box").addEventListener("paste", (event) => {
      window.pastedImage = window.AtlasTermPaste.pasteImageEvent(event, window.term, async (image) => {
        window.savedImages.push({ type: image.type, size: image.size });
        return "/test data/uploads/clipboard.png";
      });
    }, { capture: true });
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137,80,78,71])], "clipboard.png", {type:"image/png"}));
    data.setData("text/plain", "must not be pasted twice");
    document.querySelector("#box textarea").dispatchEvent(new ClipboardEvent("paste", {bubbles:true, cancelable:true, clipboardData:data}));
  });
  await page.evaluate(() => window.pastedImage);
  expect(await page.evaluate(() => window.savedImages)).toEqual([{type:"image/png",size:4}]);
  expect(await page.evaluate(() => window.toProgram.join(""))).toBe('"/test data/uploads/clipboard.png" ');
});

test("Codex context menu reads a real clipboard PNG instead of its empty text", async ({ page }) => {
  await terminal(page, true);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d").fillRect(0, 0, 2, 2);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({"image/png":png})]);
    let saved = 0;
    const ok = await window.AtlasTermCopy.pasteClipboard(window.term, async image => {
      if (image.type === "image/png" && image.size > 0) saved++;
      return "/clipboard.png";
    });
    return {ok,saved,typed:window.toProgram.join("")};
  });
  expect(result).toEqual({ok:true,saved:1,typed:'"/clipboard.png" '});
});


test("Obsidian color-mix selection stays visible on the white shell after Claude exits", async ({ page }) => {
  const screen = await terminal(page, true);
  const source = esbuild.buildSync({entryPoints:[path.join(ROOT,"obsidian-plugin/src/term-theme.js")],
    bundle:true,write:false,format:"iife",globalName:"AtlasTermTheme"}).outputFiles[0].text;
  await page.addScriptTag({content:source});
  await page.addStyleTag({content:`#box {
    --background-primary:#ffffff; --text-normal:#222222;
    --text-accent:hsl(258, 88%, 66%);
    --text-selection:color-mix(in oklch, hsl(258, 88%, 66%) 20%, transparent);
  }`});
  await page.evaluate(() => {
    window.term.options.theme=window.AtlasTermTheme.themeFromCss(document.getElementById("box"));
  });
  // The agent takes the alternate screen; on exit its shell uses the light Obsidian theme again.
  await page.evaluate(() => new Promise(resolve => window.term.write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h",resolve)));
  await page.evaluate(() => new Promise(resolve => window.term.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l",resolve)));
  expect(await drag(page,screen)).toMatch(/electable words/);
  const colors=await page.evaluate(()=>{
    const c=window.term._core._themeService.colors;
    return {background:c.background.css,selection:c.selectionBackgroundOpaque.css,cursor:c.cursor.css};
  });
  expect(colors.selection).not.toBe(colors.background);
  expect(colors.cursor).not.toBe(colors.background);
  expect(await page.evaluate(()=>window.term.options.theme.selectionBackground))
    .toMatch(/^rgba\(\d+, \d+, \d+, 0\.2\)$/);
  // Tab focus/theme notifications reapply the same palette: modern CSS must not leak back to xterm.
  const afterRefresh=await page.evaluate(()=>{
    const changed=window.AtlasTermTheme.applyTheme(window.term,document.getElementById("box"));
    const c=window.term._core._themeService.colors;
    return {changed,background:c.background.css,selection:c.selectionBackgroundOpaque.css};
  });
  expect(afterRefresh.changed).toBe(false);
  expect(afterRefresh.selection).not.toBe(afterRefresh.background);
  await page.locator("#box textarea").focus();
  await page.keyboard.press("Meta+c");
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toMatch(/electable words/);
});

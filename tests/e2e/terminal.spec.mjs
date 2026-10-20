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

for (const initial of ["dark", "light"]) for (const bufferType of ["normal", "alternate"]) {
  test(`Codex input surface follows both theme transitions from ${initial} (${bufferType}) without changing text`, async ({ page }) => {
    const screen = await terminal(page, true);
    const source = esbuild.buildSync({entryPoints:[path.join(ROOT,"obsidian-plugin/src/term-theme.js")],
      bundle:true,write:false,format:"iife",globalName:"AtlasTermTheme"}).outputFiles[0].text;
    await page.addScriptTag({content:source});
    await page.evaluate(initial => {
      window.switchTheme = mode => {
        const el=document.getElementById("box");
        el.style.setProperty("--background-primary",mode==="dark"?"#1c1c1c":"#ffffff");
        el.style.setProperty("--text-normal",mode==="dark"?"#dddddd":"#222222");
        return window.AtlasTermTheme.applyTheme(window.term,el);
      };
      window.switchTheme(initial);
      window.surface=window.AtlasTermTheme.followCodexSurface?.(window.term);
      window.contrast=window.AtlasTermTheme.followTextContrast(window.term);
      window.toProgram=[];
    },initial);
    if(bufferType==="alternate")await page.evaluate(()=>new Promise(r=>window.term.write("\x1b[?1049h",r)));
    const color=initial==="dark"?"55;55;55":"244;244;244";
    const draft="DRAFT_THEME_PROBE";
    const panel=cols=>`\x1b[H\x1b[48;2;${color}m${" ".repeat(cols)}\r\n› ${draft}${" ".repeat(cols-draft.length-2)}\r\n${" ".repeat(cols)}\x1b[0m`;
    await page.evaluate(data=>new Promise(r=>window.term.write(data,r)),panel(80)+"\x1b[6;1H\x1b[48;2;30;60;90m"+"COLOR_SAMPLE".padEnd(80)+"\x1b[0m");
    const historyColor=initial==="dark"?"64;64;64":"249;249;249";
    const history="HISTORY_THEME_PROBE";
    await page.evaluate(data=>new Promise(r=>window.term.write(data,r)),
      `\x1b[8;1H\x1b[48;2;${historyColor}m${" ".repeat(80)}\r\n\x1b[1;2m›\x1b[22m ${history}${" ".repeat(80-history.length-2)}\r\n${" ".repeat(80)}\x1b[0m`);
    const rendered = token => page.evaluate(token=>{
      const row=[...document.querySelectorAll(".xterm-rows > div")].find(r=>r.textContent.includes(token));
      const span=row&&[...row.querySelectorAll("span")].find(s=>s.textContent.includes(token)||s.textContent===token[0]);
      return span?{bg:getComputedStyle(span).backgroundColor,fg:getComputedStyle(span).color}:null;
    },token);
    for(const mode of [initial,initial==="dark"?"light":"dark",initial,"light","dark"]){
      await page.evaluate(mode=>window.switchTheme(mode),mode);
      await expect.poll(()=>rendered(draft)).toEqual({bg:mode==="dark"?"rgb(55, 55, 55)":"rgb(244, 244, 244)",
                                                    fg:mode==="dark"?"rgb(221, 221, 221)":"rgb(34, 34, 34)"});
      await expect.poll(()=>rendered(history)).toEqual({bg:mode==="dark"?"rgb(64, 64, 64)":"rgb(249, 249, 249)",
                                                      fg:mode==="dark"?"rgb(221, 221, 221)":"rgb(34, 34, 34)"});
      expect((await rendered("COLOR_SAMPLE")).bg).toBe("rgb(30, 60, 90)");
      const selected=await page.evaluate(draft=>{window.term.select(2,1,draft.length);const s=window.term.getSelection();window.term.clearSelection();return s;},draft);
      expect(selected).toBe(draft);
      expect(await page.evaluate(()=>window.term.markers.length)).toBeLessThanOrEqual(6);
    }
    // Verify resize before selection: xterm 6 can visually restore a cleared selection on resize.
    await page.evaluate(()=>window.term.resize(90,24));
    await page.evaluate(data=>new Promise(r=>window.term.write(data,r)),panel(90));
    await expect.poll(()=>rendered(draft)).toEqual({bg:"rgb(55, 55, 55)",fg:"rgb(221, 221, 221)"});
    const bounds = await screen.boundingBox();
    const cell = await page.evaluate(()=>({cols:window.term.cols,rows:window.term.rows}));
    await page.mouse.move(bounds.x+bounds.width*2.1/cell.cols,bounds.y+bounds.height*1.5/cell.rows);
    await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*(2.1+draft.length)/cell.cols,bounds.y+bounds.height*1.5/cell.rows,{steps:6});
    await page.mouse.up();
    expect(await page.evaluate(()=>window.term.getSelection())).toBe(draft);
    await page.keyboard.press("Meta+c");
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(draft);
    await page.evaluate(()=>window.term.clearSelection());
    expect(await page.evaluate(()=>window.toProgram)).toEqual([]);
    // Native /permissions replaces the prompt with a narrower panel in the same cached colour.
    const menu = "PERMISSIONS_PROBE";
    await page.evaluate(data=>new Promise(r=>window.term.write(data,r)),
      `\x1b[2J\x1b[H\x1b[48;2;${color}m${menu.padEnd(60)}\r\n${"Approve or cancel".padEnd(60)}\r\n\x1b[48;2;180;180;180m${"› 1. Current permission".padEnd(60)}\x1b[0m`);
    for(const mode of ["light","dark"]){
      await page.evaluate(mode=>window.switchTheme(mode),mode);
      await expect.poll(()=>rendered(menu)).toEqual({bg:mode==="dark"?"rgb(55, 55, 55)":"rgb(244, 244, 244)",
                                                   fg:mode==="dark"?"rgb(221, 221, 221)":"rgb(34, 34, 34)"});
      expect((await rendered("Current permission")).bg).toBe("rgb(180, 180, 180)");
    }
    await page.evaluate(()=>new Promise(r=>window.term.write("\x1b[?1049l\x1b[2J\x1b[Hshell",r)));
    await expect.poll(()=>page.evaluate(()=>window.term.markers.length)).toBe(0);
    await page.evaluate(()=>{window.surface?.dispose();window.contrast.dispose();});
    expect(await page.evaluate(()=>window.term.markers.length)).toBe(0);
  });
}

for (const initial of ["dark", "light"]) {
  test(`Claude input keeps its native background through both theme transitions from ${initial}`, async ({ page }) => {
    await terminal(page, true);
    const source=esbuild.buildSync({entryPoints:[path.join(ROOT,"obsidian-plugin/src/term-theme.js")],
      bundle:true,write:false,format:"iife",globalName:"AtlasTermTheme"}).outputFiles[0].text;
    await page.addScriptTag({content:source});
    await page.evaluate(data=>new Promise(r=>window.term.write(data,r)),"\x1b[2J\x1b[H❯ DRAFT_THEME_PROBE");
    for(const mode of [initial,initial==="dark"?"light":"dark",initial]){
      const result=await page.evaluate(mode=>{
        const el=document.getElementById("box"), t=window.term;
        el.style.setProperty("--background-primary",mode==="dark"?"#1c1c1c":"#ffffff");
        el.style.setProperty("--text-normal",mode==="dark"?"#dddddd":"#222222");
        window.AtlasTermTheme.applyTheme(t,el);
        const line=t.buffer.active.getLine(0);
        return {bg:t.options.theme.background,explicitBg:line.getCell(2).isBgRGB(),
                text:line.translateToString(true),markers:t.markers.length};
      },mode);
      expect(result).toEqual({bg:mode==="dark"?"#1c1c1c":"#ffffff",explicitBg:false,
                             text:"❯ DRAFT_THEME_PROBE",markers:0});
      await expect.poll(()=>page.locator(".xterm-rows > div").first().evaluate(el=>getComputedStyle(el).color))
        .toBe(mode==="dark"?"rgb(221, 221, 221)":"rgb(34, 34, 34)");
    }
  });
}

for (const initial of ["dark", "light"]) {
  test(`Codex submitted prompt in scrollback follows theme from ${initial} when scrolled into view`, async ({ page }) => {
    await terminal(page, true);
    const source = esbuild.buildSync({entryPoints:[path.join(ROOT,"obsidian-plugin/src/term-theme.js")],
      bundle:true,write:false,format:"iife",globalName:"AtlasTermTheme"}).outputFiles[0].text;
    await page.addScriptTag({content:source});
    const fill = initial === "dark" ? "64;64;64" : "249;249;249";
    // The prompt has already left the screen when the tab attaches its colour adapter.
    await page.evaluate(text => new Promise(resolve => window.term.write(text, resolve)),
      `\x1b[2J\x1b[H\x1b[48;2;${fill}m${" ".repeat(80)}\r\n\x1b[1;2m›\x1b[22m SCROLLBACK_THEME_PROBE${" ".repeat(56)}\r\n${" ".repeat(80)}\x1b[0m\r\n`
      + Array.from({length:60}, (_, i) => `normal output ${i}\r\n`).join(""));
    await page.evaluate(() => { window.surface = window.AtlasTermTheme.followCodexSurface(window.term); });
    for (const mode of [initial === "dark" ? "light" : "dark", initial]) {
      await page.evaluate(mode => {
        const box = document.getElementById("box");
        box.style.setProperty("--background-primary", mode === "dark" ? "#1c1c1c" : "#ffffff");
        box.style.setProperty("--text-normal", mode === "dark" ? "#dddddd" : "#222222");
        window.AtlasTermTheme.applyTheme(window.term, box);
        window.term.scrollToTop();
      }, mode);
      await expect.poll(() => page.evaluate(() => {
        const row = [...document.querySelectorAll(".xterm-rows > div")].find(r => r.textContent.includes("SCROLLBACK_THEME_PROBE"));
        const span = row && [...row.querySelectorAll("span")].find(s => s.textContent.includes("SCROLLBACK_THEME_PROBE") || s.textContent === "S");
        return span ? {bg:getComputedStyle(span).backgroundColor, fg:getComputedStyle(span).color} : null;
      })).toEqual({bg:mode === "dark" ? "rgb(64, 64, 64)" : "rgb(249, 249, 249)",
                   fg:mode === "dark" ? "rgb(221, 221, 221)" : "rgb(34, 34, 34)"});
      await page.evaluate(() => window.term.scrollToBottom());
    }
    await page.evaluate(() => window.surface.dispose());
    expect(await page.evaluate(() => window.term.markers.length)).toBe(0);
    expect(await page.evaluate(() => window.toProgram)).toEqual([]);
  });
}

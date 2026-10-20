// Claude question headings and Codex key hints use explicit neutral RGB, rather than the terminal default.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { expect, run, test } from "./fixtures.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const XTERM = path.join(ROOT, "node_modules/@xterm/xterm");
test.use({permissions:["clipboard-read","clipboard-write"]});
const source = esbuild.buildSync({stdin:{contents:'export * from "./term-theme"; export * from "./term-copy";',
  resolveDir:path.join(ROOT,"obsidian-plugin/src")},bundle:true,write:false,format:"iife",globalName:"Theme"}).outputFiles[0].text;

async function terminal(page, initial) {
  await page.route(`${run.base}/claude-theme.html`, route => route.fulfill({contentType:"text/html",
    body:'<!doctype html><div id="box" style="width:1000px;height:500px"></div>'}));
  await page.goto(`${run.base}/claude-theme.html`);
  await page.addStyleTag({content:fs.readFileSync(path.join(XTERM,"css/xterm.css"),"utf8")});
  await page.addScriptTag({content:fs.readFileSync(path.join(XTERM,"lib/xterm.js"),"utf8")});
  await page.addScriptTag({content:source});
  await page.evaluate(initial => {
    const term=window.term=new window.Terminal({cols:100,rows:24,allowProposedApi:true,fontSize:14});
    term.open(document.getElementById("box"));
    window.switchTheme=mode=>{
      const box=document.getElementById("box");
      box.style.setProperty("--background-primary",mode==="dark"?"#1c1c1c":"#ffffff");
      box.style.setProperty("--text-normal",mode==="dark"?"#dddddd":"#222222");
      window.Theme.applyTheme(term,box);
    };
    window.switchTheme(initial);
    window.adapter=window.Theme.followTextContrast?.(term);
    window.Theme.selectWithModifier(term);
    term.attachCustomKeyEventHandler(e=>!(window.Theme.isCopyKey(e)&&window.Theme.copySelection(term)));
    window.input=[];term.onData(data=>window.input.push(data));
  },initial);
}
const write=(page,text)=>page.evaluate(text=>new Promise(resolve=>window.term.write(text,resolve)),text);
const color=(page,token)=>page.evaluate(token=>{
  const row=[...document.querySelectorAll('.xterm-rows>div')].find(row=>row.textContent.includes(token));
  const span=row&&[...row.querySelectorAll('span')].find(span=>span.textContent.includes(token)||span.textContent===token[0]);
  return span?{fg:getComputedStyle(span).color,bg:getComputedStyle(span).backgroundColor}:null;
},token);

for(const initial of ["light","dark"]) for(const buffer of ["normal","alternate"]) {
  test(`Claude explicit question text stays readable from ${initial} in ${buffer}`,async({page})=>{
    await terminal(page,initial);
    if(buffer==="alternate")await write(page,"\x1b[?1049h");
    const grey=initial==="light"?67:218;
    const rgb=initial==="light"?"0;0;0":"255;255;255";
    await write(page,`\x1b[1;38;2;${rgb}mQUESTION_THEME_PROBE\x1b[0m\r\n`
      +`\x1b[38;2;${grey};${grey};${grey}mKEY_HINT_PROBE\x1b[0m\r\n`
      +"\x1b[38;2;210;50;60mRED_SAMPLE\x1b[0m\r\n"
      +"\x1b[38;2;0;0;0;48;2;240;240;240mBLACK_ON_LIGHT_PANEL\x1b[0m\r\n"
      +"\x1b[38;2;255;255;255;48;2;30;30;30mWHITE_ON_DARK_PANEL\x1b[0m\r\n"
      +`\x1b[7;38;2;${rgb}mINVERSE_SAMPLE\x1b[0m\r\n› 1. Option\r\n2. Type something\r\n3. Chat about this`);
    const raw=await page.evaluate(()=>{const c=window.term.buffer.active.getLine(0).getCell(0);return{rgb:c.isFgRGB(),fg:c.getFgColor()};});
    for(const mode of [initial,initial==="light"?"dark":"light",initial]) {
      await page.evaluate(mode=>window.switchTheme(mode),mode);
      await expect.poll(async()=> (await color(page,"QUESTION_THEME_PROBE"))?.fg)
        .toBe(mode===initial?(initial==="light"?"rgb(0, 0, 0)":"rgb(255, 255, 255)")
          :mode==="dark"?"rgb(221, 221, 221)":"rgb(34, 34, 34)");
      await expect.poll(async()=> (await color(page,"KEY_HINT_PROBE"))?.fg)
        .toBe(mode===initial?`rgb(${grey}, ${grey}, ${grey})`
          :mode==="dark"?"rgb(221, 221, 221)":"rgb(34, 34, 34)");
      expect((await color(page,"INVERSE_SAMPLE")).fg).toBe(mode==="dark"?"rgb(28, 28, 28)":"rgb(255, 255, 255)");
      expect((await color(page,"RED_SAMPLE")).fg).toBe("rgb(210, 50, 60)");
      expect(await color(page,"BLACK_ON_LIGHT_PANEL")).toEqual({fg:"rgb(0, 0, 0)",bg:"rgb(240, 240, 240)"});
      expect(await color(page,"WHITE_ON_DARK_PANEL")).toEqual({fg:"rgb(255, 255, 255)",bg:"rgb(30, 30, 30)"});
      expect(await page.evaluate(()=>{const c=window.term.buffer.active.getLine(0).getCell(0);return{rgb:c.isFgRGB(),fg:c.getFgColor()};})).toEqual(raw);
      expect(await page.evaluate(()=>window.term.markers.length)).toBeLessThanOrEqual(2);
    }
    await page.evaluate(()=>window.term.resize(110,26));
    await page.evaluate(initial=>window.switchTheme(initial==="light"?"dark":"light"),initial);
    await expect.poll(async()=> (await color(page,"QUESTION_THEME_PROBE"))?.fg)
      .toBe(initial==="light"?"rgb(221, 221, 221)":"rgb(34, 34, 34)");
    await page.evaluate(()=>{window.term.select(0,0,20);window.term.focus();});
    expect(await page.evaluate(()=>window.term.getSelection())).toBe("QUESTION_THEME_PROBE");
    await page.keyboard.press("Meta+c");
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe("QUESTION_THEME_PROBE");
    await page.evaluate(()=>window.term.clearSelection());
    await write(page,"\x1b[2J\x1b[Hshell");
    await expect.poll(()=>page.evaluate(()=>window.term.markers.length)).toBe(0);
    await page.evaluate(()=>window.adapter?.dispose());
    expect(await page.evaluate(()=>window.input)).toEqual([]);
  });
}

test("Claude question scrolled back into view receives the current theme and frees decorations on disposal",async({page})=>{
  await terminal(page,"light");
  await write(page,"\x1b[38;2;0;0;0mOLD_QUESTION_PROBE\x1b[0m\r\n"+"ordinary output\r\n".repeat(55));
  await page.evaluate(()=>{window.switchTheme("dark");window.term.scrollToTop();});
  await expect.poll(async()=> (await color(page,"OLD_QUESTION_PROBE"))?.fg).toBe("rgb(221, 221, 221)");
  await page.evaluate(()=>window.adapter?.dispose());
  expect(await page.evaluate(()=>window.term.markers.length)).toBe(0);
  await expect.poll(async()=> (await color(page,"OLD_QUESTION_PROBE"))?.fg).toBe("rgb(0, 0, 0)");
});

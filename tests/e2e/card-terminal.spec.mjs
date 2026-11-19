// The card's Terminal mode with the real renderer bundle under the page's nonce CSP. The plugin is a
// stand-in host that answers `open-card-terminal` with a MessagePort the test drives like the PTY mirror.
import { expect, ids, run, test } from "./fixtures.mjs";
import { terminalRenderer } from "../../esbuild.config.mjs";

const renderer = terminalRenderer();
const FIRST = { type: "start", text: "ready$ ", cols: 80, rows: 24, scrollback: 1000, fontSize: 13,
  fontFamily: "monospace", theme: {} };

// The server itself emits the nonce'd tags and serves the built files (global-setup). `js` swaps the bundle for one spec.
async function serveRenderer(page, js) {
  if (js === renderer.js) return;
  await page.route("**/static/card-terminal-renderer.js", route =>
    route.fulfill({ contentType: "text/javascript", body: js }));
}

function hostPage(lang, first) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab", inline: true }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&am=full" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];       // what the page asks the plugin
window.fromCard = [];   // what the card sends over the port
window.opened = 0;
const tabs = ${JSON.stringify(tabs)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d.type);
  const reply = (m, ports) => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*", ports || []);
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true } });
  if (d.type === "open-card-terminal") {
    const channel = new MessageChannel();
    window.opened++;
    window.hostPort = channel.port1;
    channel.port1.onmessage = m => window.fromCard.push(m.data);
    channel.port1.postMessage(${JSON.stringify(first)});
    reply({ type: "card-terminal", request: d.request }, [channel.port2]);
  }
});
</script></body></html>`;
}

async function openTerminal(page, lang, { first = FIRST, js = renderer.js, ready = true } = {}) {
  await serveRenderer(page, js);
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, first) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const card = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  await card.locator(".card-view-picker").selectOption("terminal");
  if (ready) await expect(card.locator(".card-terminal .xterm")).toBeVisible();
  return { frame, card, term: card.locator(".card-terminal") };
}

const toCard = (page, message) => page.evaluate(m => window.hostPort.postMessage(m), message);
const fromCard = (page, type) => page.evaluate(t => window.fromCard.filter(m => m.type === t), type);

test("the renderer draws truecolor cells under the nonce CSP", async ({ page, lang }) => {
  const { term } = await openTerminal(page, lang);
  await toCard(page, { type: "data", text: "\x1b[38;2;10;200;30mTRUE\x1b[0m done" });
  const cell = term.locator(".xterm-rows span", { hasText: "TRUE" }).first();
  await expect(cell).toBeVisible();
  await expect(cell).toHaveCSS("color", "rgb(10, 200, 30)");
  await expect(term).toContainText("ready$");
});

test("terminal replies are not input; typed text is", async ({ page, lang }) => {
  const { term } = await openTerminal(page, lang);
  await toCard(page, { type: "data", text: "\x1b[6n\x1b[c\x1b[>c\x1b[?u" });
  await page.waitForTimeout(300);
  expect(await fromCard(page, "input")).toEqual([]);
  await term.locator(".xterm-screen").click();
  await page.keyboard.type("hi");
  await expect.poll(async () => (await fromCard(page, "input")).map(m => m.text).join("")).toBe("hi");
});

test("size requests are sent once per size", async ({ page, lang }) => {
  const { term } = await openTerminal(page, lang);
  await expect.poll(async () => (await fromCard(page, "size")).length).toBeGreaterThan(0);
  const sizes = async () => (await fromCard(page, "size")).map(m => `${m.cols}x${m.rows}`);
  await page.waitForTimeout(400);
  const before = await sizes();
  // A fraction of a pixel fires the resize observer without changing the cell grid.
  for (const height of ["calc(100% - 0.4px)", "calc(100% - 0.2px)", "100%"]) {
    await term.evaluate((node, h) => { node.style.height = h; }, height);
    await page.waitForTimeout(150);
  }
  // Font metrics differ by platform: a step may cross a row and the last one back, never a repeat.
  expect((await sizes()).length - before.length).toBeLessThanOrEqual(2);
  const settled = (await sizes()).length;
  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(async () => (await sizes()).length).toBeGreaterThan(settled);
  const all = await sizes();
  all.forEach((size, i) => { if (i) expect(size).not.toBe(all[i - 1]); });
});

test("coming back to Active does not put the keyboard into the terminal", async ({ page, lang }) => {
  const { frame, term } = await openTerminal(page, lang);
  await term.locator(".xterm-screen").click();
  await expect(term.locator("textarea")).toBeFocused();
  await frame.locator("#view-search").click();
  await frame.locator("#view-active").click();
  await expect(frame.locator(".acard .card-terminal .xterm")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.opened)).toBe(2);
  await page.waitForTimeout(300);
  const inside = await frame.locator("body").evaluate(() => !!document.activeElement?.closest(".card-terminal"));
  expect(inside).toBe(false);
});

test("a terminal whose PTY ended connects again on the next redraw", async ({ page, lang }) => {
  const { frame } = await openTerminal(page, lang);
  await toCard(page, { type: "exit" });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.opened)).toBe(1);
  // The plugin reports another tab: the card grid redraws and mounts the panel again.
  await page.evaluate(pid => document.getElementById("atlas").contentWindow.postMessage(
    { source: "session-atlas-host", type: "tabs", health: { ok: true },
      tabs: [{ ptyPid: pid, title: "claude tab", inline: true }, { ptyPid: 999999, title: "other" }] }, "*"),
    run.pids.claude.shell);
  await expect.poll(() => page.evaluate(() => window.opened)).toBe(2);
  await expect(frame.locator(".acard .card-terminal .xterm")).toBeVisible();
});

test("an open card terminal follows a theme change of the tab", async ({ page, lang }) => {
  const { term } = await openTerminal(page, lang);
  await toCard(page, { type: "theme", theme: { background: "#102030", foreground: "#eeeeee" } });
  await expect(term.locator(".xterm-scrollable-element")).toHaveCSS("background-color", "rgb(16, 32, 48)");
});

test("a large paste goes to the plugin as one input message", async ({ page, lang }) => {
  const { term } = await openTerminal(page, lang);
  await term.locator(".xterm-screen").click();
  const text = Array.from({ length: 150000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  await page.keyboard.insertText(text);
  await expect.poll(async () => (await fromCard(page, "input")).length).toBe(1);
  const inputs = await fromCard(page, "input");
  expect(inputs[0].text).toBe(text);
  expect(inputs[0].part).toBeUndefined();
});

test("the page carries the renderer's tags under its nonce and the server serves the files", async ({ page, lang }) => {
  const res = await page.request.get(`${run.base}/?lang=${lang}`);
  const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers()["content-security-policy"])[1];
  const html = await res.text();
  expect(html).toContain(`<script nonce="${nonce}" src="/static/card-terminal-renderer.js"></script>`);
  expect(html).toContain(`<link rel="stylesheet" nonce="${nonce}" href="/static/card-terminal-renderer.css">`);
  expect((await page.request.get(`${run.base}/static/card-terminal-renderer.js`)).headers()["content-type"]).toContain("javascript");
  expect((await page.request.get(`${run.base}/static/card-terminal-renderer.css`)).headers()["content-type"]).toContain("css");
});

test("an xterm without the private paths leaves the panel unavailable and no terminal behind", async ({ page, lang }) => {
  const js = renderer.js.replaceAll("?._rowFactory", "?._rowFactoryGone");
  expect(js).not.toBe(renderer.js);
  page.expectConsoleError(/internals the card terminal needs/);
  const { card, term } = await openTerminal(page, lang, { js, ready: false });
  await expect(card.locator(".card-view-body .empty")).toContainText(
    lang === "ru" ? "Терминал доступен" : "The terminal is available");
  await expect(term.locator(".xterm")).toHaveCount(0);
});

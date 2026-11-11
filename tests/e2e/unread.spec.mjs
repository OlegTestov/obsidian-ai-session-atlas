/* global openFeed, READ -- page globals, used inside page.evaluate */
// Unread marks on Active cards: the plugin sends which sessions finished while you were away; the page
// shows a dot and a "N new" button and reports the cards you open. A stand-in host page plays the plugin.
import { expect, ids, run, test } from "./fixtures.mjs";

function hostPage(lang, unread, mode = "compact", answerSeen = true) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab" },
                { ptyPid: run.pids.codex.shell, title: "codex tab", agent: "codex", screen: null }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&am=${mode}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
window.unread = ${JSON.stringify(unread)};
window.front = false;
const tabs = ${JSON.stringify(tabs)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "seen") window.unread = window.unread.filter(id => !d.ids.includes(id));
  if (d.type === "list-tabs" || (d.type === "seen" && ${answerSeen})) reply({ type: "tabs", tabs, health: { ok: true }, unread: window.unread, front: window.front });
});
</script></body></html>`;
}

async function openHost(page, lang, unread, mode, answerSeen) {
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, unread, mode, answerSeen) }));
  await page.goto(`${run.base}/e2e-host.html`);
  return page.frameLocator("#atlas");
}

const seenSent = page => page.evaluate(() => window.sent.filter(m => m.type === "seen"));

test("an unread card has the dot, the others do not; the summary counts them", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive]);
  const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  const codex = frame.locator(`.acard[data-id="${ids.codexLive}"]`);
  await expect(claude.locator(".unread-dot")).toBeVisible();
  await expect(claude).toHaveClass(/\bunread\b/);
  await expect(codex.locator(".unread-dot")).toHaveCount(0);
  await expect(codex).not.toHaveClass(/\bunread\b/);
  await expect(frame.locator("#active-summary .unread-all")).toHaveText(lang === "ru" ? "новых 1" : "1 new");
});

test("a click on the card clears its mark in place and tells the plugin", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive, ids.codexLive], "compact", false);
  const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  await expect(claude.locator(".unread-dot")).toBeVisible();
  // A redraw would replace the card element and drop a text selection or focus inside it.
  await claude.evaluate(c => { c.dataset.probe = "same"; });
  await claude.locator(".d").click();
  await expect(claude.locator(".unread-dot")).toHaveCount(0, { timeout: 1500 });
  await expect(claude).not.toHaveClass(/\bunread\b/);
  await expect(claude).toHaveAttribute("data-probe", "same");
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .unread-dot`)).toBeVisible();
  await expect(frame.locator("#active-summary .unread-all")).toHaveText(lang === "ru" ? "новых 1" : "1 new");
  await expect.poll(() => seenSent(page)).toEqual([expect.objectContaining({ ids: [ids.claudeLive] })]);
});

test("a click on a card without a mark still tells the plugin, which may not have marked it yet", async ({ page, lang }) => {
  const frame = await openHost(page, lang, []);
  await frame.locator(`.acard[data-id="${ids.codexLive}"] .d`).click();
  await expect.poll(() => seenSent(page)).toEqual([expect.objectContaining({ ids: [ids.codexLive] })]);
});

test("\"N new\" marks the cards on screen as seen at once, before the plugin answers", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive, ids.codexLive], "compact", false);
  const all = frame.locator("#active-summary .unread-all");
  await expect(all).toHaveText(lang === "ru" ? "новых 2" : "2 new");
  await all.click();
  await expect(frame.locator(".acard .unread-dot")).toHaveCount(0, { timeout: 1500 });
  await expect(all).toHaveCount(0, { timeout: 1500 });
  const sent = await seenSent(page);
  expect(sent).toHaveLength(1);
  expect([...sent[0].ids].sort()).toEqual([ids.claudeLive, ids.codexLive].sort());
});

test("\"N new\" counts and clears only the cards the filters show", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive, ids.codexLive]);
  await expect(frame.locator(".acard .unread-dot")).toHaveCount(2);
  await frame.locator("#active-filters .agent-ms .ms-btn").click();
  await frame.locator("#active-filters .agent-ms .ms-pop label", { hasText: "Codex" }).locator("input").setChecked(false);
  await frame.locator("#active-grid").click({ position: { x: 2, y: 2 } });
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"]`)).toHaveCount(0);
  const all = frame.locator("#active-summary .unread-all");
  await expect(all).toHaveText(lang === "ru" ? "новых 1" : "1 new");
  await all.click();
  await expect.poll(() => seenSent(page)).toEqual([expect.objectContaining({ ids: [ids.claudeLive] })]);
  expect(await page.evaluate(() => window.unread)).toEqual([ids.codexLive]);
});

test("opening the feed of a card clears its mark at once", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.codexLive], "full", false);
  const codex = frame.locator(`.acard[data-id="${ids.codexLive}"]`);
  await expect(codex.locator(".unread-dot")).toBeVisible();
  // The feed opens without a click on the card too (the f key); a click would clear the mark by itself.
  await frame.locator("body").evaluate((_, id) => openFeed(id), ids.codexLive);
  await expect(frame.locator("#feed")).toBeVisible();
  await expect(codex.locator(".unread-dot")).toHaveCount(0, { timeout: 1500 });
  await expect.poll(() => seenSent(page)).toEqual([expect.objectContaining({ ids: [ids.codexLive] })]);
});

test("a session whose feed is open stays seen when the plugin marks it", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [], "full");
  await frame.locator("body").evaluate((_, id) => openFeed(id), ids.codexLive);
  await expect(frame.locator("#feed")).toBeVisible();
  await frame.locator("#feed-body").click();            // you are reading the feed: the page has focus
  const before = (await seenSent(page)).length;
  await page.evaluate(id => { window.unread = [id]; }, ids.codexLive);
  await expect.poll(async () => (await seenSent(page)).length, { timeout: 12000 }).toBeGreaterThan(before);
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .unread-dot`)).toHaveCount(0);
});

test("arrow keys pass over cards without clearing marks; Enter on one clears it", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive, ids.codexLive], "full");
  await expect(frame.locator(".acard .unread-dot")).toHaveCount(2);
  // Focus inside the frame without touching a card: keys go to the page's document.
  await frame.locator("#active-grid").evaluate(g => { g.tabIndex = -1; g.focus(); });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(frame.locator(".acard.sel")).toHaveCount(1);
  await expect(frame.locator(".acard .unread-dot")).toHaveCount(2);
  const selected = await frame.locator(".acard.sel").getAttribute("data-id");
  await page.keyboard.press("Enter");
  await expect(frame.locator(`.acard[data-id="${selected}"] .unread-dot`)).toHaveCount(0);
  await expect(frame.locator(".acard .unread-dot")).toHaveCount(1);
});

test("a mark that the plugin adds later shows at the next poll", async ({ page, lang }) => {
  const frame = await openHost(page, lang, []);
  const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  await expect(claude).toBeVisible();
  await expect(frame.locator(".acard .unread-dot")).toHaveCount(0);
  await page.evaluate(id => { window.unread = [id]; }, ids.claudeLive);
  await expect(claude.locator(".unread-dot")).toBeVisible({ timeout: 12000 });
  await expect(frame.locator("#active-summary .unread-all")).toBeVisible();
  // and goes again when the plugin drops it (the session works again)
  await page.evaluate(() => { window.unread = []; });
  await expect(claude.locator(".unread-dot")).toHaveCount(0, { timeout: 12000 });
  await expect(frame.locator("#active-summary .unread-all")).toHaveCount(0);
});

test("cards drawn again keep their marks at once", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive, ids.codexLive], "compact", false);
  const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  await expect(claude.locator(".unread-dot")).toBeVisible();
  // A filter redraws the cards without asking the plugin: the dot must come with the new card.
  await claude.evaluate(c => { c.dataset.probe = "old"; });
  await frame.locator("#active-filters .agent-ms .ms-btn").click();
  await frame.locator("#active-filters .agent-ms .ms-pop label", { hasText: "Codex" }).locator("input").setChecked(false);
  await expect(claude).not.toHaveAttribute("data-probe", "old");
  await expect(claude.locator(".unread-dot")).toBeVisible({ timeout: 1000 });
});

test("an open feed in a page without focus does not keep its session seen", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [], "full");
  await frame.locator("body").evaluate((_, id) => openFeed(id), ids.codexLive);
  await expect(frame.locator("#feed")).toBeVisible();
  // Focus leaves the Atlas page (another tab or app in Obsidian).
  await page.evaluate(() => { const b = document.createElement("button"); document.body.prepend(b); b.focus(); });
  expect(await frame.locator("body").evaluate(() => document.hasFocus())).toBe(false);
  await page.evaluate(id => { window.unread = [id]; }, ids.codexLive);
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .unread-dot`)).toBeVisible({ timeout: 12000 });
});

test("the summary line keeps its separators right when \"N new\" goes", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [ids.claudeLive], "compact", false);
  const summary = frame.locator("#active-summary");
  await expect(summary.locator(".unread-all")).toBeVisible();
  await summary.locator(".unread-all").click();         // removed in place: no redraw rebuilds the line
  await expect(summary.locator(".unread-all")).toHaveCount(0, { timeout: 1000 });
  const text = await summary.evaluate(n => n.textContent);
  expect(text.startsWith(" · ")).toBe(false);
  expect(text.includes(" ·  · ")).toBe(false);
});

test("repeated clicks inside a card without a mark send one message per poll", async ({ page, lang }) => {
  const frame = await openHost(page, lang, []);
  const desc = frame.locator(`.acard[data-id="${ids.codexLive}"] .d`);
  const started = await page.evaluate(() => Date.now());
  await desc.click();
  await desc.click();
  const beforeLast = await page.evaluate(() => Date.now());
  await desc.click();
  const lastClick = await page.evaluate(() => Date.now());
  await expect.poll(() => seenSent(page)).toHaveLength(1);
  await page.waitForTimeout(300);
  expect(await seenSent(page)).toHaveLength(1);
  // The last click still reaches the plugin at the end of the window, with the time it was made:
  // a turn that ends while the click is held must not count as seen.
  await expect.poll(() => seenSent(page), { timeout: 8000 }).toHaveLength(2);
  const [first, held] = await seenSent(page);
  expect(first.at).toBeGreaterThanOrEqual(started);
  expect(held.at).toBeGreaterThanOrEqual(beforeLast);
  expect(held.at).toBeLessThanOrEqual(lastClick);
  await page.waitForTimeout(1000);
  expect(await seenSent(page)).toHaveLength(2);
});

test("a click after the window sends at once", async ({ page, lang }) => {
  const frame = await openHost(page, lang, []);
  const desc = frame.locator(`.acard[data-id="${ids.codexLive}"] .d`);
  await desc.click();
  await expect.poll(() => seenSent(page)).toHaveLength(1);
  await page.waitForTimeout(5200);
  await desc.click();
  await expect.poll(() => seenSent(page), { timeout: 500 }).toHaveLength(2);
});

test("an open feed stays seen when the plugin says the Atlas tab is in front, without page focus", async ({ page, lang }) => {
  const frame = await openHost(page, lang, [], "full");
  await page.evaluate(() => { window.front = true; });
  await frame.locator("body").evaluate((_, id) => openFeed(id), ids.codexLive);
  await expect(frame.locator("#feed")).toBeVisible();
  await page.evaluate(() => { const b = document.createElement("button"); document.body.prepend(b); b.focus(); });
  const before = (await seenSent(page)).length;
  await page.evaluate(id => { window.unread = [id]; }, ids.codexLive);
  await expect.poll(async () => (await seenSent(page)).length, { timeout: 12000 }).toBeGreaterThan(before);
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .unread-dot`)).toHaveCount(0);
});

// A detailed card on screen while you work at the page: a reply you could read as it came is not marked.
async function readingSetup(page, lang, mode, { settledMs = 300, inputMs = 60000, unread = [], input = true } = {}) {
  const frame = await openHost(page, lang, unread, mode);
  await page.evaluate(() => { window.front = true; });
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"]`)).toBeVisible();
  await frame.locator("body").evaluate((_, r) => Object.assign(READ, r), { settledMs, inputMs });
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "list-tabs").length),
                    { timeout: 12000 }).toBeGreaterThan(1);       // the page has seen itself in view for a poll
  await page.waitForTimeout(Math.min(settledMs, 1000) + 100);
  if (input) {
    await page.mouse.move(200, 200);
    await page.mouse.wheel(0, 1);                                   // you are at the screen
  }
  return frame;
}
const markLater = (page, id) => page.evaluate(i => { window.unread = [i]; }, id);
const newSeen = async (page, before) => (await seenSent(page)).slice(before.length);

test("detailed view: a reply that comes while you work at the page is not marked", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "full");
  const before = await seenSent(page);
  await markLater(page, ids.claudeLive);
  await expect.poll(async () => (await newSeen(page, before)).flatMap(m => m.ids), { timeout: 12000 })
    .toContain(ids.claudeLive);
  await page.waitForTimeout(500);
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toHaveCount(0);
});

test("compact view: the same reply is marked", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "compact");
  await markLater(page, ids.claudeLive);
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toBeVisible({ timeout: 12000 });
});

test("detailed view without recent input: marked, you may be away from the screen", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "full", { inputMs: 1 });
  await page.waitForTimeout(50);
  await markLater(page, ids.claudeLive);
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toBeVisible({ timeout: 12000 });
});

test("detailed view, the page just came into view: marked, the turn may have ended before", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "full", { settledMs: 600000 });
  await markLater(page, ids.claudeLive);
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toBeVisible({ timeout: 12000 });
});

test("detailed view, the card is off screen: marked", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "full");
  await frame.locator(`.acard[data-id="${ids.claudeLive}"]`).evaluate(c => {
    const sheet = new CSSStyleSheet();                              // inline <style> is refused by the page's CSP
    sheet.replaceSync(".e2e-far{margin-top:5000px}");
    c.ownerDocument.adoptedStyleSheets = [...c.ownerDocument.adoptedStyleSheets, sheet];
    c.classList.add("e2e-far");
  });
  await page.mouse.wheel(0, 1);
  await markLater(page, ids.claudeLive);
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toBeAttached({ timeout: 12000 });
});

test("detailed view: a mark from while you were away stays when you come back and move the mouse", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "full", { unread: [ids.claudeLive] });
  const before = await seenSent(page);
  await page.mouse.wheel(0, 1);
  await page.waitForTimeout(6000);                                  // more polls with the same mark
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toBeVisible();
  expect((await newSeen(page, before)).flatMap(m => m.ids)).not.toContain(ids.claudeLive);
});

test("detailed view: the page scrolling itself or a pointer move is not you at the screen", async ({ page, lang }) => {
  const frame = await readingSetup(page, lang, "full", { input: false });
  await frame.locator("body").evaluate(() => {
    document.dispatchEvent(new Event("scroll"));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    for (const el of document.querySelectorAll(".acard .feed, .acard")) el.scrollTop = el.scrollHeight;
  });
  await markLater(page, ids.claudeLive);
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .unread-dot`)).toBeVisible({ timeout: 12000 });
});

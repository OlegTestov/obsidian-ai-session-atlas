// Active: several questions at once in the card, as tabs (Claude Code's question tool with 2+ questions).
// The dialog is what the plugin's own parser makes of a recorded screen and the transcript's questions;
// a stand-in host page answers for the plugin and records what the card sends.
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { expect, ids, run, test } from "./fixtures.mjs";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "tools", "fixtures");
const screens = JSON.parse(fs.readFileSync(path.join(FIXTURES, "claude-multi-question.json"), "utf8"));
const QUESTIONS = [
  { question: "Which colour should the badge be?", header: "Colour", multiSelect: false, options: [
    { label: "Red", description: "Warm and loud" }, { label: "Green", description: "Calm" }, { label: "Blue", description: "Neutral" }] },
  { question: "Which fruits go in the basket?", header: "Fruits", multiSelect: true, options: [
    { label: "Apple", description: "Crunchy" }, { label: "Pear", description: "Soft" }, { label: "Plum", description: "Sour" }] },
  { question: "Who reviews it?", header: "Reviewer", multiSelect: false, options: [
    { label: "Alice", description: "Owns the module" }, { label: "Bob", description: "Knows the UI" }] }];

async function multiDialog(screen = "start") {
  const realLoad = Module._load;
  Module._load = (request, parent, isMain) => (request === "obsidian" ? { Notice: class {} } : realLoad(request, parent, isMain));
  try {
    const { loadSrc } = await import("../js/helpers/load-src.mjs");
    const parse = loadSrc("multi-parse");
    return parse.multiDialog({ id: "toolu_e2e", questions: QUESTIONS }, parse.parseMultiScreen(screens[screen]));
  } finally {
    Module._load = realLoad;
  }
}

function hostPage(lang, mode, dialog) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab" }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&am=${mode}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
let dialog = ${JSON.stringify(dialog)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true } });
  if (d.type === "read-dialog") reply({ type: "dialog", sessionId: d.sessionId, ptyPid: d.ptyPid, dialog });
  if (d.type === "answer-multi" && !window.holdAnswers) reply({ type: "answered", ok: true, sessionId: d.sessionId, nonce: d.nonce });
});
</script></body></html>`;
}

async function open(page, lang, mode, dialog) {
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (s.session_id === ids.claudeLive) Object.assign(s, { status: "waiting", activity: "waiting", waiting_for: "question" });
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, mode, dialog) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const card = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  await expect(card.locator(".dialog.multi .mtabs")).toBeVisible();
  return { frame, card };
}

for (const mode of ["full", "compact"]) {
  test(`${mode}: the questions as tabs, answered in the card, sent once with every answer`, async ({ page, lang }) => {
    const ru = lang === "ru";
    const { card } = await open(page, lang, mode, await multiDialog());
    const tabs = card.locator(".mtabs button");
    await expect(tabs).toHaveText(["Colour", "Fruits", "Reviewer", ru ? "Проверить ответы" : "Review answers"]);
    await expect(tabs.nth(0)).toHaveClass(/\bon\b/);
    await expect(card.locator(".mq .q")).toHaveText("Which colour should the badge be?");
    // One answer moves on, as in the tab.
    await card.locator(".mopt", { hasText: "2. Green" }).click();
    await expect(tabs.nth(0)).toHaveText("✓ Colour");
    await expect(tabs.nth(1)).toHaveClass(/\bon\b/);
    // Several answers: checkboxes, then Next.
    const next = card.locator(".mnext");
    await expect(next).toBeDisabled();
    await card.locator(".mopt", { hasText: "Pear" }).click();
    await card.locator(".mopt", { hasText: "Pear" }).click();      // a second click unticks it
    await card.locator(".mopt", { hasText: "Plum" }).click();
    await card.locator(".mopt", { hasText: "Apple" }).click();
    await expect(card.locator(".mopt.on")).toHaveText(["☑ 1. Apple", "☑ 3. Plum"]);
    if (process.env.LIVE_SHOT_DIR) await card.screenshot({ path: `${process.env.LIVE_SHOT_DIR}/multi-fruits-${mode}-${lang}.png` });
    await next.click();
    await expect(tabs.nth(2)).toHaveClass(/\bon\b/);
    // An own typed answer: Enter takes it and moves to the Submit tab.
    await card.locator(".mopt.typed").click();
    const typed = card.locator(".mtyped textarea");
    await expect(typed).toBeFocused();
    await typed.fill("Carol");
    await typed.press("Enter");
    await expect(tabs.nth(3)).toHaveClass(/\bon\b/);
    await expect(card.locator(".msline")).toHaveText(["Colour → Green", "Fruits → Apple, Plum", "Reviewer → Carol"]);
    // A new tab starts at the top of the dialog, and Send is in view without scrolling.
    const fit = await card.locator(":scope > .dialog").evaluate(d => {
      const box = d.getBoundingClientRect();
      const inside = e => { const r = e.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1; };
      return { top: d.scrollTop, tabs: inside(d.querySelector(".mtabs")), send: inside(d.querySelector(".msend")),
               oneLine: d.querySelector(".msum").getBoundingClientRect().height
                 < 1.6 * d.querySelector(".msline").getBoundingClientRect().height };
    });
    // The compact card lists the answers on one line.
    expect(fit).toEqual({ top: 0, tabs: true, send: true, oneLine: mode === "compact" });
    if (process.env.LIVE_SHOT_DIR) await card.screenshot({ path: `${process.env.LIVE_SHOT_DIR}/multi-submit-${mode}-${lang}.png` });
    expect(await page.evaluate(() => window.sent.filter(m => m.type === "answer-multi").length)).toBe(0);
    await card.locator(".msend").click();
    await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "answer-multi"))).toEqual([
      expect.objectContaining({ sessionId: ids.claudeLive, ptyPid: run.pids.claude.shell, id: "toolu_e2e",
                                answers: [{ options: [2] }, { options: [1, 3] }, { typed: "Carol" }] })]);
    await expect(card.locator(".dialog")).toContainText(ru ? "ответ отправлен" : "answer sent");
  });
}

test("a dialog scrolled on one question starts at the top on the next", async ({ page, lang }) => {
  const { frame, card } = await open(page, lang, "full", await multiDialog());
  // A short dialog, so it scrolls (CSSOM: the page's CSP allows no inline style element).
  await frame.locator("head").evaluate(h => h.ownerDocument.styleSheets[0].insertRule(
    ".acard>.dialog.multi{max-height:60px!important;min-height:0!important}", 0));
  await card.locator(".mopt", { hasText: "2. Green" }).click();
  await card.locator(".mopt", { hasText: "Apple" }).click();
  const dialog = card.locator(":scope > .dialog");
  await dialog.evaluate(d => { d.scrollTop = 40; });
  expect(await dialog.evaluate(d => d.scrollTop)).toBeGreaterThan(20);
  await dialog.evaluate(d => d.querySelector(".mnext").click());      // no scrolling into view
  await expect(card.locator(".mq .q")).toHaveText("Who reviews it?");
  expect(await dialog.evaluate(d => [d.scrollTop, d.scrollHeight > d.clientHeight + 20])).toEqual([0, true]);
});

test("while the card's answers are typed, the filling tabs read as progress, not as finish in the tab", async ({ page, lang }) => {
  const ru = lang === "ru";
  const { card } = await open(page, lang, "full", await multiDialog());
  await card.locator(".mopt", { hasText: "2. Green" }).click();
  await card.locator(".mopt", { hasText: "Apple" }).click();
  await card.locator(".mnext").click();
  await card.locator(".mopt", { hasText: "1. Alice" }).click();
  const half = await multiDialog("fruits_fresh");
  half.reason = "FINISH-IN-THE-TAB";
  await page.evaluate(d => { window.holdAnswers = true; dialog = d; }, half);   // the plugin is still typing
  const reads = await page.evaluate(() => window.sent.filter(m => m.type === "read-dialog").length);
  await card.locator(".msend").click();
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "read-dialog").length),
                    { timeout: 15000 }).toBeGreaterThan(reads);
  await expect(card.locator(".dialog")).toContainText(ru ? "отвечаю во вкладке" : "answering in the tab");
  await expect(card.locator(".dialog")).not.toContainText("FINISH-IN-THE-TAB");
});

test("Send stays off until every question has an answer; a tab can be revisited", async ({ page, lang }) => {
  const { card } = await open(page, lang, "full", await multiDialog());
  const tabs = card.locator(".mtabs button");
  await tabs.nth(3).click();
  await expect(card.locator(".msend")).toBeDisabled();
  await expect(card.locator(".msline.missing")).toHaveCount(3);
  await tabs.nth(0).click();
  await card.locator(".mopt", { hasText: "1. Red" }).click();
  await tabs.nth(0).click();                                   // back to change it
  await card.locator(".mopt", { hasText: "3. Blue" }).click();
  await tabs.nth(3).click();
  await expect(card.locator(".msline").first()).toHaveText("Colour → Blue");
  await expect(card.locator(".msend")).toBeDisabled();
  expect(await page.evaluate(() => window.sent.filter(m => m.type === "answer-multi").length)).toBe(0);
});

test("questions half answered in the tab: the card says to finish there", async ({ page, lang }) => {
  const d = await multiDialog("fruits_fresh");
  expect(d.answerable).toBe(false);
  d.reason = "Some of these questions were answered in the tab — finish there";
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (s.session_id === ids.claudeLive) Object.assign(s, { status: "waiting", activity: "waiting", waiting_for: "question" });
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, "full", d) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const card = page.frameLocator("#atlas").locator(`.acard[data-id="${ids.claudeLive}"]`);
  await expect(card.locator(".dialog.multi .q.dim")).toHaveText(d.reason);
  await expect(card.locator(".mtabs")).toHaveCount(0);
});

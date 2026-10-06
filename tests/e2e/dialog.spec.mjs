// Active: a dialog in the card (question with options) and the own answer typed into the reply field.
// The live Claude session is shown as waiting; a stand-in host page answers for the plugin with a
// dialog parsed by the plugin's own parser from a recorded screen.
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { expect, ids, run, test } from "./fixtures.mjs";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "tools", "fixtures");
const screens = JSON.parse(fs.readFileSync(path.join(FIXTURES, "dialog_screens.json"), "utf8"));

// The plugin's modules, loaded in Node the way the unit tests load them ("obsidian" is a stand-in).
let plugin = null;
const codexScreens = JSON.parse(fs.readFileSync(path.join(FIXTURES, "codex_screens.json"), "utf8"));
async function pluginSrc() {
  if (plugin) return plugin;
  const realLoad = Module._load;
  Module._load = (request, parent, isMain) =>
    (request === "obsidian" ? { Notice: class {} } : realLoad(request, parent, isMain));
  try {
    const { loadSrc } = await import("../js/helpers/load-src.mjs");
    plugin = { dialog: loadSrc("dialog"), codex: loadSrc("dialog-codex"), input: loadSrc("input") };
  } finally {
    Module._load = realLoad;
  }
  return plugin;
}

/** A question with many options and long descriptions: taller than any card. */
function longDialog() {
  const long = "A long description that wraps over several lines in a narrow card, so the block grows taller "
    + "than the room above the reply field and has to scroll inside itself instead of pushing it out";
  const options = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, text: `Option ${i + 1}`, detail: long }));
  options.push({ n: 8, text: "Type something.", detail: "", freeText: true, selected: false, typed: "" });
  options.push({ n: 9, text: "Chat about this", detail: "" });
  return { kind: "question", title: "Approach", details: [], answerable: true, reason: null, options,
           question: "Which approach should the migration take, given the constraints listed above?" };
}

function hostPage(lang, hash, dialog) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab" },
                { ptyPid: run.pids.codex.shell, title: "codex tab", agent: "codex", screen: null }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&${hash}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
const dialog = ${JSON.stringify(dialog)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  window.frameSource = e.source;
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  window.replyToPage = reply;
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true } });
  if (d.type === "read-dialog") reply({ type: "dialog", sessionId: d.sessionId, ptyPid: d.ptyPid, dialog });
});
</script></body></html>`;
}

/** Opens the page in the stand-in host with the live Claude session waiting on this dialog. */
async function openWithDialog(page, lang, dialog, hash = "am=full", sid = ids.claudeLive) {
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (s.session_id === sid) Object.assign(s, { status: "waiting", activity: "waiting",
                                                   waiting_for: "question" });
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, hash, dialog) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const card = frame.locator(`.acard[data-id="${sid}"]`);
  await expect(card.locator(".dialog .opts button").first()).toBeVisible();
  return { frame, card };
}

const box = loc => loc.boundingBox();

/** The card holds everything: nothing sticks out of it and the reply field is inside. */
async function expectFits(card) {
  const c = await box(card);
  for (const part of [".dialog", ".answer"]) {
    const b = await box(card.locator(`:scope > ${part}`));
    expect(b.y, part).toBeGreaterThanOrEqual(c.y - 0.5);
    expect(b.y + b.height, part).toBeLessThanOrEqual(c.y + c.height + 0.5);
  }
  const overflow = await card.evaluate(el => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function questionDialog() {
  const { dialog } = await pluginSrc();
  const d = dialog.parseDialog(screens.free_question);
  expect(d.options.map(o => o.text)).toEqual(["Red", "Blue", "Type something.", "Chat about this"]);
  return d;
}

test("the dialog sits on the reply field and rises with it as the field grows", async ({ page, lang }) => {
  // Two tall cards side by side: the chat has room to give.
  const { card } = await openWithDialog(page, lang, await questionDialog(), "am=full&lf=2x1");
  const dialog = card.locator(":scope > .dialog");
  const chat = card.locator(":scope > .amsgs, :scope > .reply").first();
  // Order: chat, dialog, reply field; the dialog right on the field.
  const [c0, d0, a0] = [await box(chat), await box(dialog), await box(card.locator(":scope > .answer"))];
  expect(c0.y + c0.height).toBeLessThanOrEqual(d0.y + 0.5);
  expect(a0.y - (d0.y + d0.height)).toBeGreaterThanOrEqual(0);
  expect(a0.y - (d0.y + d0.height)).toBeLessThanOrEqual(8);
  await expectFits(card);

  // The own answer turns the reply field into the answer field; typing grows it.
  await card.locator(".dialog button.free").click();
  const area = card.locator(".answer.free textarea");
  await expect(area).toBeFocused();
  const a1 = await box(card.locator(":scope > .answer"));
  const d1 = await box(dialog);
  await area.fill("a fairly long answer that keeps going so the field wraps it onto more lines ".repeat(6));
  await area.dispatchEvent("input");
  await expect.poll(async () => (await box(card.locator(":scope > .answer"))).height).toBeGreaterThan(a1.height + 30);
  const a2 = await box(card.locator(":scope > .answer"));
  const d2 = await box(dialog);
  const grew = a2.height - a1.height;
  expect(Math.abs((d1.y - d2.y) - grew)).toBeLessThanOrEqual(1.5);      // moved up by as much as the field grew
  expect(Math.abs((d2.y + d2.height) - (d1.y + d1.height) + grew)).toBeLessThanOrEqual(1.5);
  expect((await box(chat)).height).toBeLessThan(c0.height);              // the chat gave the room
  await expectFits(card);
});

test("in a short card the dialog stays on the growing field and scrolls; nothing leaves the card", async ({ page, lang }) => {
  const { card } = await openWithDialog(page, lang, await questionDialog(), "am=full&lf=2x4");
  const dialog = card.locator(":scope > .dialog");
  await card.locator(".dialog button.free").click();
  const area = card.locator(".answer.free textarea");
  await area.pressSequentially("a long answer that wraps onto more lines of the field ".repeat(5));
  await expect.poll(() => area.evaluate(el => el.rows)).toBeGreaterThan(2);
  const d = await box(dialog);
  const a = await box(card.locator(":scope > .answer"));
  expect(a.y - (d.y + d.height)).toBeGreaterThanOrEqual(0);
  expect(a.y - (d.y + d.height)).toBeLessThanOrEqual(8);
  expect(d.height).toBeGreaterThan(30);                                   // the question stays readable
  expect(await dialog.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  // The pressed option is scrolled into sight inside the dialog.
  const pressed = await box(card.locator(".dialog button.free"));
  expect(pressed.y).toBeGreaterThanOrEqual(d.y - 0.5);
  expect(pressed.y + pressed.height).toBeLessThanOrEqual(d.y + d.height + 0.5);
  await expectFits(card);
});

test("a dialog taller than the card scrolls inside itself; the reply field stays visible", async ({ page, lang }) => {
  for (const hash of ["am=full", "am=full&lf=2x1", "am=full&lf=2x4", "lc=5x5"]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const { card } = await openWithDialog(page, lang, longDialog(), hash);
    const dialog = card.locator(":scope > .dialog");
    const scroll = await dialog.evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight,
                                                  oy: getComputedStyle(el).overflowY }));
    expect(scroll.oy, hash).toBe("auto");
    const full = hash.includes("am=full");
    if (full) expect(scroll.sh, hash).toBeGreaterThan(scroll.ch + 20);
    if (full) {
      await expectFits(card);
      await expect(card.locator(":scope > .answer textarea")).toBeInViewport();
      // The chat keeps a couple of lines while the card has room for them.
      const chat = await box(card.locator(":scope > .amsgs, :scope > .reply").first());
      if (!hash.includes("lf=")) expect(chat.height, hash).toBeGreaterThanOrEqual(30);
      // A tall card does not hand the whole height to the dialog: at most 60 % of it.
      expect((await box(dialog)).height, hash).toBeLessThanOrEqual((await box(card)).height * 0.6 + 1);
    } else {
      const c = await box(card);
      const foot = await box(card.locator(":scope > .foot"));
      expect(foot.y + foot.height, hash).toBeLessThanOrEqual(c.y + c.height + 0.5);
      expect(await card.evaluate(el => el.scrollHeight - el.clientHeight), hash).toBeLessThanOrEqual(1);
    }
    // Scrolled to the end, the last options are reachable.
    await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const top = await dialog.evaluate(el => el.scrollTop);
    // A redraw (new data, or the minute tick) keeps the reader's place in the dialog.
    await page.frame({ url: /lang=/ }).evaluate(() => window.renderActive(null, true));
    expect(await card.locator(":scope > .dialog").evaluate(el => el.scrollTop), hash).toBe(top);
    await expect(card.locator(".dialog .opts button", { hasText: "9." })).toBeInViewport();
  }
});

test("own answer: the card sends it and the plugin types digit, text, check, Enter", async ({ page, lang, t }) => {
  const { card } = await openWithDialog(page, lang, await questionDialog());
  const free = card.locator(".dialog button.free");
  await expect(free).toHaveText(/^3\. /);
  await expect(free).toHaveAttribute("aria-pressed", "false");
  // Esc leaves the mode and gives the focus back to the option.
  await free.click();
  await expect(free).toHaveAttribute("aria-pressed", "true");
  const area = card.locator(".answer.free textarea");
  await expect(area).toBeFocused();
  await area.press("Escape");
  await expect(card.locator(".answer.free")).toHaveCount(0);
  await expect(card.locator(".dialog button.free")).toBeFocused();

  await card.locator(".dialog button.free").click();
  await area.fill("green\nplease");
  await area.press("Enter");
  const sent = () => page.evaluate(() => window.sent.filter(m => m.type === "answer-dialog"));
  await expect.poll(sent).toHaveLength(1);
  const [msg] = await sent();
  expect(msg).toMatchObject({ ptyPid: run.pids.claude.shell, sessionId: ids.claudeLive, option: 3,
                              text: "Type something.", feedback: "green please" });

  // The plugin's own code takes the message: the tab's screens follow the keys as recorded live.
  const { input } = await pluginSrc();
  global.window = global.window || globalThis;
  const reactions = { 3: screens.free_selected, "green please": screens.free_typed };
  let screen = screens.free_question;
  const keys = [];
  const fake = {
    screenLines: () => screen,
    ptyInput: async () => ({ write: k => { keys.push(k); if (reactions[k]) screen = reactions[k]; } }),
    t: k => k,
  };
  let result = null;
  const dialog = (await pluginSrc()).dialog.parseDialog(screen);
  await input.InputMethods.prototype.typedAnswer.call(fake, { leaf: {} }, dialog, msg, (ok, reason) => { result = { ok, reason }; });
  expect(keys).toEqual(["3", "green please", "\r"]);
  expect(result).toEqual({ ok: true, reason: undefined });

  await page.evaluate(m => window.replyToPage({ type: "answered", ok: true, sessionId: m.sessionId, nonce: m.nonce }), msg);
  await expect(card.locator(".dialog")).toContainText(lang === "ru" ? "ответ отправлен" : "answer sent");
  expect(t).toBeTruthy();
});

test("Chat about this is one key; the free option moved elsewhere is refused by the plugin", async ({ page, lang }) => {
  const { card } = await openWithDialog(page, lang, await questionDialog());
  await card.locator(".dialog .opts button", { hasText: /^4\. / }).click();
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "answer-dialog")))
    .toEqual([expect.objectContaining({ option: 4, text: "Chat about this" })]);

  // The screen changed under the person: option 3 is no longer the text field → no key at all.
  const { input, dialog } = await pluginSrc();
  global.window = global.window || globalThis;
  const keys = [];
  const fake = { screenLines: () => screens.question, ptyInput: async () => ({ write: k => keys.push(k) }), t: k => k };
  let ok = null;
  await input.InputMethods.prototype.typedAnswer.call(fake, { leaf: {} }, dialog.parseDialog(screens.question),
    { option: 2, text: "Type something.", feedback: "x" }, r => { ok = r; });
  expect(ok).toBe(false);
  expect(keys).toEqual([]);
});

test("compact card: the own answer gets a field inside the dialog", async ({ page, lang }) => {
  const { card } = await openWithDialog(page, lang, await questionDialog(), "lc=4x4");
  const free = card.locator(".dialog button.free");
  await expect(free).toBeVisible();
  await expect(card.locator(".dialog .opts button", { hasText: /^4\. / })).toBeVisible();
  await free.click();
  const area = card.locator(".dialog .freefb textarea");
  await expect(area).toBeFocused();
  await area.fill("green please");
  await area.press("Enter");
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "answer-dialog")))
    .toEqual([expect.objectContaining({ option: 3, text: "Type something.", feedback: "green please" })]);
  expect(await card.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
});

test("Codex: the decline that tells Codex what to do uses the same answer field", async ({ page, lang }) => {
  const { codex } = await pluginSrc();
  const approval = codex.parseCodexDialog(codexScreens.exec);
  const { card } = await openWithDialog(page, lang, approval, "am=full", ids.codexLive);
  const free = card.locator(".dialog button.free");
  await expect(free).toHaveText("3. No, and tell Codex what to do differently");
  await free.click();
  const area = card.locator(".answer.free textarea");
  await expect(area).toBeFocused();
  await expect(card.locator(".answer.free .answering")).toContainText(lang === "ru" ? "Что Codex сделать" : "What Codex should do");
  await area.fill("list the folder with ls -la instead");
  await area.press("Enter");
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "answer-dialog"))).toEqual([
    expect.objectContaining({ ptyPid: run.pids.codex.shell, sessionId: ids.codexLive, option: 3,
                              text: "No, and tell Codex what to do differently",
                              feedback: "list the folder with ls -la instead" })]);
});

// Active: a Claude Code question with a preview per option (options on the left, a framed preview of the
// highlighted one on the right in the terminal). The stand-in host answers for the plugin with the
// plugin's own parse of recorded Claude Code 2.1.291 screens: the first option highlighted, and after
// 👁 on the second option the screen where it is highlighted.
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { expect, ids, run, test } from "./fixtures.mjs";

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "tools", "fixtures");
const screens = JSON.parse(fs.readFileSync(path.join(FIXTURES, "dialog_screens.json"), "utf8"));
const TEXT = {
  en: { section: "Needs your decision", strip: "Needs your decision · CLAUDE.md", previewOf: n => `Preview of option ${n}`,
        note: "+ Note", chat: "Chat about this" },
  ru: { section: "Нужно решение", strip: "Нужно твоё решение · CLAUDE.md", previewOf: n => `Превью варианта ${n}`,
        note: "+ Заметка", chat: "Обсудить вопрос" },
};

async function parse(name) {
  const realLoad = Module._load;
  Module._load = (request, parent, isMain) => (request === "obsidian" ? {} : realLoad(request, parent, isMain));
  try {
    const { loadSrc } = await import("../js/helpers/load-src.mjs");
    return loadSrc("dialog").parseDialog(screens[name]);
  } finally {
    Module._load = realLoad;
  }
}

function hostPage(lang, hash, first, second) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab" }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&${hash}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
let dialog = ${JSON.stringify(first)};
const moved = ${JSON.stringify(second)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true } });
  if (d.type === "read-dialog") reply({ type: "dialog", sessionId: d.sessionId, ptyPid: d.ptyPid, dialog });
  if (d.type === "preview-option") { dialog = moved; reply({ type: "dialog", sessionId: d.sessionId, ptyPid: d.ptyPid, dialog }); }
  if (d.type === "answer-dialog") reply({ type: "answered", ok: true, sessionId: d.sessionId, nonce: d.nonce });
});
</script></body></html>`;
}

async function open(page, lang, hash = "am=full") {
  const first = await parse("preview_wide");
  const second = await parse("preview_wide_down");
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (s.session_id === ids.claudeLive) Object.assign(s, { status: "waiting", activity: "waiting", waiting_for: "question" });
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route(`${run.base}/e2e-preview-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, hash, first, second) }));
  await page.goto(`${run.base}/e2e-preview-host.html`);
  const frame = page.frameLocator("#atlas");
  const card = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  await expect(card.locator(".dialog button").first()).toBeVisible();
  return { frame, card };
}

const sentOf = (page, type) => page.evaluate(t => window.sent.filter(m => m.type === t), type);

test("a question with previews: its own section on top, a strip, options in a column and the preview below",
  async ({ page, lang }) => {
    const tx = TEXT[lang];
    const { frame, card } = await open(page, lang);
    await expect(frame.locator(".asec").first().locator("h3")).toContainText(tx.section);
    await expect(frame.locator(".asec.decide .acard")).toHaveCount(1);
    await expect(card.locator(".decide")).toHaveText(`❓ ${tx.strip}`);
    await expect(card.locator(".pvrow .pvpick")).toHaveText(["1. Yes, all 5", "2. Yes, with changes", "3. Not now"]);
    await expect(card.locator(".pvrow.on .pvpick")).toHaveText("1. Yes, all 5");
    await expect(card.locator(".pvh")).toHaveText(tx.previewOf(1));
    await expect(card.locator(".pvtext")).toContainText("Answer in the language of the message.");
    // Nothing of the terminal's frame leaks into the card.
    expect(await card.locator(".dialog").innerText()).not.toMatch(/[┌┐└┘│]|Notes:/);
    await expect(card.locator(".pvextra button")).toHaveText([tx.note, tx.chat]);
  });

test("👁 shows another option's preview without answering", async ({ page, lang }) => {
  const tx = TEXT[lang];
  const { card } = await open(page, lang);
  await card.locator(".pvrow").nth(1).locator(".pveye").click();
  await expect(card.locator(".pvh")).toHaveText(tx.previewOf(2));
  await expect(card.locator(".pvtext")).toContainText("PREVIEW-TWO");
  await expect(card.locator(".pvrow.on .pvpick")).toHaveText("2. Yes, with changes");
  expect((await sentOf(page, "preview-option")).map(m => [m.option, m.text])).toEqual([[2, "Yes, with changes"]]);
  expect(await sentOf(page, "answer-dialog")).toHaveLength(0);
});

test("a note goes with the chosen option", async ({ page, lang }) => {
  const tx = TEXT[lang];
  const { card } = await open(page, lang);
  await card.locator(".pvextra button", { hasText: tx.note }).click();
  const area = card.locator(".pvnote textarea");
  await expect(area).toBeFocused();
  await area.fill("keep it short");
  await card.locator(".pvrow").nth(0).locator(".pvpick").click();
  await expect.poll(async () => (await sentOf(page, "answer-dialog")).length).toBe(1);
  const [answer] = await sentOf(page, "answer-dialog");
  expect(answer).toMatchObject({ option: 1, text: "Yes, all 5", note: "keep it short" });
});

test("Chat about this sends the decline, with no option", async ({ page, lang }) => {
  const tx = TEXT[lang];
  const { card } = await open(page, lang);
  await card.locator(".pvextra button", { hasText: tx.chat }).click();
  await expect.poll(async () => (await sentOf(page, "answer-dialog")).length).toBe(1);
  const [answer] = await sentOf(page, "answer-dialog");
  expect(answer.chat).toBe(true);
  expect(answer.option).toBeUndefined();
});

test("compact card: the strip and the options in a row, no frame", async ({ page }) => {
  const { card } = await open(page, "en", "am=compact");
  await expect(card.locator(".decide")).toBeVisible();
  await expect(card.locator(".dialog .opts .pvpick")).toHaveCount(3);
  await expect(card.locator(".dialog .opts .pvpick").first()).toBeVisible();
  expect(await card.locator(".dialog").innerText()).not.toMatch(/[┌┐└┘│]/);
});

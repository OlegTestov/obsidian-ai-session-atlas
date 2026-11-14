// Catalog edits: renaming a Codex and a Claude session, deleting a Codex session, refusing to delete
// a running one. Each language project edits its own fixture sessions.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, ids, run, test } from "./fixtures.mjs";

const row = (page, id) => page.locator(`#list .row[data-id="${id}"]`);
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const historyIds = () => fs.readFileSync(path.join(run.corpus.codexHome, "history.jsonl"), "utf8")
  .split("\n").filter(Boolean).map(l => JSON.parse(l).session_id);

async function rename(page, id, title) {
  await row(page, id).click();
  await expect(page.locator("#card h3")).toBeVisible();
  await page.locator("#card .sub button.ghost").click();
  await expect(page.locator("#rename")).toBeVisible();
  await page.locator("#rename-input").fill(title);
  await page.locator("#rename-save").click();
  await expect(page.locator("#rename")).toBeHidden();
}

async function openDelete(page, id, t) {
  await row(page, id).click();
  await expect(page.locator("#card h3")).toBeVisible();
  await page.locator("#bar button.ghost").click();
  await page.locator("#menu button", { hasText: t.deleteMenu }).click();
  await expect(page.locator("#modal")).toBeVisible();
}

// Codex's own commands (rename, delete) as the stand-in codex received them.
const standInLog = () => fs.existsSync(run.codexStandInLog + ".own") ? fs.readFileSync(run.codexStandInLog + ".own", "utf8") : "";

test("renaming a Codex session asks Codex to rename it and leaves the rollout alone", async ({ page, open, lang, t }) => {
  const id = lang === "en" ? ids.codexRenameEn : ids.codexRenameRu;
  const file = run.corpus.files[lang === "en" ? "codexRenameEn" : "codexRenameRu"];
  const before = sha(file);
  const title = lang === "en" ? "SDK bump, renamed" : "Обновление SDK, переименовано";
  await open();
  await row(page, id).click();
  await page.locator("#card .sub button.ghost").click();
  await expect(page.locator("#rename-note")).toHaveText(t.renameNoteCodex);
  await page.locator("#rename-cancel").click();
  await rename(page, id, title);
  // Codex's own thread/name/set did the rename: no "catalog only" notice.
  await expect(page.locator("#modal")).toBeHidden();
  expect(standInLog()).toContain(`name ${id} ${title}\n`);
  await expect(page.locator("#card h3")).toHaveText(title);
  await expect(row(page, id).locator(".t")).toContainText(title);
  await page.reload();
  await expect(row(page, id).locator(".t")).toContainText(title);
  await expect(page.locator("#card h3")).toHaveText(title);
  expect(sha(file)).toBe(before);
});

test("renaming a Claude session writes it to the catalog and to the transcript", async ({ page, open, lang, t }) => {
  const id = lang === "en" ? ids.claudeRenameEn : ids.claudeRenameRu;
  const file = run.corpus.files[lang === "en" ? "claudeRenameEn" : "claudeRenameRu"];
  const title = lang === "en" ? "Changelog tidy-up" : "Уборка в ченджлоге";
  await open();
  await row(page, id).click();
  await page.locator("#card .sub button.ghost").click();
  await expect(page.locator("#rename-note")).toHaveText(t.renameNote);
  await page.locator("#rename-cancel").click();
  await rename(page, id, title);
  await expect(page.locator("#modal")).toBeHidden();
  await expect(page.locator("#card h3")).toHaveText(title);
  await page.reload();
  await expect(row(page, id).locator(".t")).toContainText(title);
  await expect(page.locator("#card h3")).toHaveText(title);
  const last = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop());
  expect(last).toMatchObject({ type: "custom-title", customTitle: title, sessionId: id });
});

test("deleting a Codex session: the preview lists what goes, then the files are gone", async ({ page, open, lang, t }) => {
  const id = lang === "en" ? ids.codexDeleteEn : ids.codexDeleteRu;
  const file = run.corpus.files[lang === "en" ? "codexDeleteEn" : "codexDeleteRu"];
  const othersBefore = historyIds().filter(x => x !== id);
  expect(historyIds().filter(x => x === id)).toHaveLength(2);
  expect(fs.existsSync(file)).toBe(true);
  await open();
  await openDelete(page, id, t);
  const body = page.locator("#m-body");
  await expect(body).toContainText(`${t.rollout} — `);
  await expect(body).toContainText(t.history(2));
  await expect(body).toContainText(t.catalog);
  await expect(body).toContainText(t.codexNote);
  await expect(page.locator("#m-ok")).toHaveText(t.deleteConfirm);
  await page.locator("#m-ok").click();
  await expect(page.locator("#modal")).toBeHidden();
  await expect(page.locator("#card")).toContainText(t.deleted);
  await expect(row(page, id)).toHaveCount(0);
  expect(fs.existsSync(file)).toBe(false);
  expect(standInLog()).toContain(`delete --force ${id}\n`);         // Codex deleted its own thread
  expect(historyIds()).toEqual(othersBefore);            // only this thread's prompts left the history
  await page.reload();
  await expect(page.locator("#list .row").first()).toBeVisible();
  await expect(row(page, id)).toHaveCount(0);
});

for (const agent of ["codex", "claude"]) {
  test(`a running ${agent} session cannot be deleted`, async ({ page, open, t }) => {
    const id = agent === "codex" ? ids.codexLive : ids.claudeLive;
    const file = run.corpus.files[agent === "codex" ? "codexLive" : "claudeLive"];
    await open();
    await openDelete(page, id, t);
    await expect(page.locator("#m-note")).toContainText(t.running);
    await expect(page.locator("#m-ok")).toBeHidden();
    await page.locator("#m-close").click();
    expect(fs.existsSync(file)).toBe(true);
    // The server refuses too, whatever the page does.
    page.expectHttpError(/\/api\/delete$/);
    const status = await page.evaluate(async sid => (await fetch("/api/delete", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Atlas-Token": window.ATLAS_TOKEN },
      body: JSON.stringify({ session_id: sid, confirmed: true }) })).status, id);
    expect(status).toBe(409);
    expect(fs.existsSync(file)).toBe(true);
  });
}

test("the card menu opens under its own button, not at the left edge of the bar", async ({ page, open, lang }) => {
  const id = lang === "en" ? ids.codexRenameEn : ids.codexRenameRu;
  for (const width of [1280, 520]) {
    await page.setViewportSize({ width, height: 800 });
    await open();
    await row(page, id).click();
    await expect(page.locator("#card h3")).toBeVisible();
    const more = page.locator("#bar button.ghost");
    await more.click();
    await expect(page.locator("#menu")).toBeVisible();
    const b = await more.boundingBox(), m = await page.locator("#menu").boundingBox();
    const bar = await page.locator("#bar").boundingBox();
    // Inside the bar, and it overlaps the button horizontally.
    expect(m.x).toBeGreaterThanOrEqual(bar.x);
    expect(m.x + m.width).toBeLessThanOrEqual(bar.x + bar.width);
    expect(m.x).toBeLessThan(b.x + b.width);
    expect(m.x + m.width).toBeGreaterThan(b.x);
    // With room for it, its right edge lines up with the button's.
    if (b.x + b.width - m.width >= bar.x + 8) expect(Math.abs(m.x + m.width - (b.x + b.width))).toBeLessThan(2);
  }
});

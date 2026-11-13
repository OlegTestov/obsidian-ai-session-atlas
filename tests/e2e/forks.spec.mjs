// A Claude Code copy of a session (--fork-session, /branch) carries its source's title: the list
// numbers it "Title (2)", and each card links to the other. The two sessions are written for the
// test and removed after it: other specs count the catalog.
import fs from "node:fs";
import path from "node:path";

import { expect, run, test } from "./fixtures.mjs";
import { ago } from "./corpus.mjs";
import { line } from "./records.mjs";

const SOURCE = { en: "22222222-2222-4222-8222-0000000000e1", ru: "22222222-2222-4222-8222-0000000000a1" };
const COPY = { en: "22222222-2222-4222-8222-0000000000e2", ru: "22222222-2222-4222-8222-0000000000a2" };
const L = { en: { title: "Alert scoring for fork test", from: "Copy of", copies: "Copies:" },
            ru: { title: "Скоринг алертов для теста копий", from: "Копия сессии", copies: "Копии:" } };

const row = (page, id) => page.locator(`#list .row[data-id="${id}"]`);
// A list row reads "<title>  · 1 h ago".
const heading = text => new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+·");

function record(type, sid, ts, extra) {
  return line({ type, timestamp: ts, sessionId: sid, cwd: run.corpus.cwds.demo, entrypoint: "cli",
                gitBranch: "main", version: "2.1.323", ...extra });
}
const prompt = (sid, ts, text, extra = {}) =>
  record("user", sid, ts, { session_id: sid, ...extra, message: { role: "user", content: [{ type: "text", text }] } });
const title = (sid, text) => line({ type: "custom-title", customTitle: text, sessionId: sid });

function write(sid, lines) {
  const folder = path.join(run.corpus.projects, run.corpus.cwds.demo.replace(/[/.]/g, "-"));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, sid + ".jsonl");
  fs.writeFileSync(file, lines.join(""));
  return file;
}

async function reindex(page) {
  const status = await page.evaluate(async () => (await fetch("/api/reindex", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Atlas-Token": window.ATLAS_TOKEN },
    body: "{}" })).status);
  expect(status).toBe(200);
}

test("a copy is numbered in the list and linked to its source on both cards", async ({ page, open, lang }) => {
  const source = SOURCE[lang], copy = COPY[lang], t = L[lang];
  const now = Date.now();
  const files = [
    write(source, [title(source, t.title), prompt(source, ago(now, 2), "Score the alerts by day")]),
    // The copy keeps the source's records under the source's id, then goes on under its own.
    write(copy, [title(copy, t.title), prompt(copy, ago(now, 2), "Score the alerts by day", { session_id: source }),
                 prompt(copy, ago(now, 1), "Try a weekly window instead")]),
  ];
  try {
    await open();
    await reindex(page);
    await page.reload();
    await expect(row(page, copy).locator(".t")).toHaveText(heading(`${t.title} (2)`));
    await expect(row(page, source).locator(".t")).toHaveText(heading(t.title));

    await row(page, copy).click();
    await expect(page.locator("#card h3")).toHaveText(`${t.title} (2)`);
    const lineage = page.locator("#card .lineage");
    await expect(lineage).toContainText(`${t.from} ${t.title}`);
    await lineage.getByRole("button", { name: t.title, exact: true }).click();

    await expect(page.locator("#card h3")).toHaveText(t.title);
    await expect(page.locator("#card .lineage")).toContainText(`${t.copies} ${t.title} (2)`);
    await page.locator("#card .lineage").getByRole("button", { name: `${t.title} (2)` }).click();
    await expect(page.locator("#card h3")).toHaveText(`${t.title} (2)`);
  } finally {
    files.forEach(f => fs.rmSync(f, { force: true }));
    await reindex(page);
  }
});

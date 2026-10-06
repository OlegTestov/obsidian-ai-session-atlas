// "+ Session" folder field: suggestions while typing, keys, the vault root, a pasted path, a wrong one,
// and the folder the stand-in host receives. The page runs in a frame of a host that records messages.
import fs from "node:fs";
import path from "node:path";

import { expect, run, test } from "./fixtures.mjs";

const HOST = `${run.base}/e2e-folder-host.html`;
const HOME = run.corpus.home;
const VAULT = run.corpus.vault;
const ERR = { missing: /no such folder|такой папки нет/, notDir: /not a folder|это не папка/,
              relative: /not a full path|это не полный путь/ };

function hostPage(src) {
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="${src}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  if (d.type === "list-tabs") e.source.postMessage({ source: "session-atlas-host", type: "tabs", tabs: [],
                                                     health: { ok: true } }, "*");
});
</script></body></html>`;
}

async function openDialog(page, lang) {
  await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8",
                                                 body: hostPage(`/?lang=${lang}#view=active&am=full`) }));
  await page.goto(HOST);
  const frame = page.frameLocator("#atlas");
  const listed = page.waitForResponse(r => r.url().endsWith("/api/workdirs"));
  await frame.locator("#active-filters .newsess").click();
  await expect(frame.locator("#newsess")).toBeVisible();
  await listed;
  return frame;
}

const sentOf = (page, type) => page.evaluate(t => window.sent.filter(m => m.type === t), type);
const options = frame => frame.locator("#ns-dir-list [role=option] .fp-text");

/** Type into the field as a person does and wait for the server's subfolders for that text. */
async function typeIn(page, frame, text) {
  const field = frame.locator("#ns-dir");
  await field.fill("");
  const answered = page.waitForResponse(r => r.url().endsWith("/api/folders")
                                             && r.request().postDataJSON().text === text);
  await field.pressSequentially(text);
  await answered;
}

async function start(page, frame) {
  const req = page.waitForRequest(r => r.url().endsWith("/api/new-session"));
  await frame.locator("#ns-go").click();
  const body = (await req).postDataJSON();
  await expect.poll(async () => (await sentOf(page, "new-session")).length).toBe(1);
  return { body, sent: (await sentOf(page, "new-session"))[0] };
}

test("typing filters the known folders; the field starts with the most recent one", async ({ page, lang }) => {
  const frame = await openDialog(page, lang);
  const field = frame.locator("#ns-dir");
  await expect(field).toHaveAttribute("role", "combobox");
  await expect(field).not.toHaveValue("");
  await typeIn(page, frame, "billing");
  await expect(frame.locator("#ns-dir-list")).toBeVisible();
  await expect(field).toHaveAttribute("aria-expanded", "true");
  await expect(options(frame).first()).toHaveText("~/Code/billing-api");
  await expect(frame.locator("#ns-dir-list [role=option]").first().locator(".fp-side")).toHaveText(/\d/);
  for (const t of await options(frame).allTextContents()) expect(t.toLowerCase()).toContain("b");
  // Scattered letters still find it.
  await typeIn(page, frame, "opsscr");
  await expect(options(frame)).toHaveText(["~/Code/ops-scripts"]);
  // Mouse: a click picks the folder and closes the list.
  await options(frame).first().click();
  await expect(field).toHaveValue("~/Code/ops-scripts");
  await expect(frame.locator("#ns-dir-list")).toBeHidden();
});

test("deleting the tail goes up to the vault root, and the session starts there", async ({ page, lang }) => {
  const frame = await openDialog(page, lang);
  const field = frame.locator("#ns-dir");
  await typeIn(page, frame, "notes/Projects/Atlas");
  await expect(frame.locator("#ns-dir-hint")).toHaveClass(/ok/);
  const answered = page.waitForResponse(r => r.url().endsWith("/api/folders")
                                             && r.request().postDataJSON().text === "notes");
  for (let i = 0; i < "/Projects/Atlas".length; i++) await field.press("Backspace");
  await answered;
  await expect(field).toHaveValue("notes");
  // The vault itself (a known folder), then its own folders: no hidden ones, no files.
  await expect(options(frame)).toHaveText(["notes", "notes/Daily", "notes/Projects"]);
  await expect(frame.locator("#ns-dir-hint")).toHaveText(VAULT);
  await field.press("Escape");
  await expect(frame.locator("#ns-dir-list")).toBeHidden();
  await expect(frame.locator("#newsess")).toBeVisible();          // Esc closed the list, not the dialog
  const { body, sent } = await start(page, frame);
  expect(body.cwd).toBe("notes");
  expect(sent.cwd).toBe(VAULT);
  expect(sent.command.startsWith("cd ")).toBe(true);
});

test("quick picks: the vault root and home", async ({ page, lang }) => {
  const frame = await openDialog(page, lang);
  await expect(frame.locator("#ns-dir-quick button")).toHaveCount(2);
  await frame.locator("#ns-dir-quick button").first().click();
  await expect(frame.locator("#ns-dir")).toHaveValue("notes");
  await frame.locator("#ns-dir-quick button").last().click();
  await expect(frame.locator("#ns-dir")).toHaveValue("~");
  await expect(frame.locator("#ns-dir-hint")).toHaveText(HOME);
});

test("a pasted absolute path is taken as is", async ({ page, lang }) => {
  const frame = await openDialog(page, lang);
  const field = frame.locator("#ns-dir");
  const target = path.join(HOME, "Code", "atlas-demo");
  await field.fill("");
  const answered = page.waitForResponse(r => r.url().endsWith("/api/folders"));
  await field.focus();
  await page.keyboard.insertText(target);            // one input event with the whole text, as a paste
  await answered;
  await expect(field).toHaveValue(target);
  await expect(frame.locator("#ns-dir-hint")).toHaveClass(/ok/);
  const { body, sent } = await start(page, frame);
  expect(body.cwd).toBe(target);
  expect(sent.cwd).toBe(target);
});

test("typing before the folders arrive: the default does not land inside the typed path", async ({ page, lang }) => {
  // The folder list is slow to come; the person is already typing a path of their own.
  let release;
  const held = new Promise(r => { release = r; });
  await page.route("**/api/workdirs", async route => { await held; await route.continue(); });
  await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8",
                                                 body: hostPage(`/?lang=${lang}#view=active&am=full`) }));
  await page.goto(HOST);
  const frame = page.frameLocator("#atlas");
  await frame.locator("#active-filters .newsess").click();
  await expect(frame.locator("#newsess")).toBeVisible();
  const field = frame.locator("#ns-dir");
  const target = path.join(HOME, "Code", "atlas-demo");
  await field.focus();                                // in the field, not a letter typed yet
  const listed = page.waitForResponse(r => r.url().endsWith("/api/workdirs"));
  release();
  await listed;
  await expect(frame.locator("#ns-dir-quick button").first()).toBeVisible();   // the answer is applied
  await page.keyboard.insertText(target);
  await expect(field).toHaveValue(target);
  const { body } = await start(page, frame);
  expect(body.cwd).toBe(target);
});

test("keyboard: arrows highlight, Enter picks, Tab goes into the folder", async ({ page, lang }) => {
  const frame = await openDialog(page, lang);
  const field = frame.locator("#ns-dir");
  await typeIn(page, frame, "~/Code/");
  await expect(options(frame).first()).toHaveText("~/Code/atlas-demo");
  await expect(options(frame).nth(1)).toHaveText("~/Code/billing-api");
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await expect(field).toHaveAttribute("aria-activedescendant", "ns-dir-opt-1");
  await expect(frame.locator("#ns-dir-opt-1")).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowUp");
  await field.press("ArrowUp");                       // wraps around to the last one
  await expect(frame.locator("#ns-dir-list [role=option]").last()).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowDown");                     // back to the first
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(field).toHaveValue("~/Code/billing-api");
  await expect(frame.locator("#ns-dir-list")).toBeHidden();
  await expect(field).toBeFocused();

  await typeIn(page, frame, "notes/Pro");
  await field.press("ArrowDown");
  await field.press("Tab");
  await expect(field).toHaveValue("notes/Projects/");
  await expect(field).toBeFocused();
  await expect(options(frame)).toHaveText(["notes/Projects/Atlas"]);
  await field.press("Escape");
  await field.press("Escape");                        // list closed: now Esc closes the dialog
  await expect(frame.locator("#newsess")).toBeHidden();
});

test("a wrong path says what is wrong, and Start does not start", async ({ page, lang }) => {
  page.expectHttpError(/\/api\/new-session$/);
  const frame = await openDialog(page, lang);
  const field = frame.locator("#ns-dir");
  const hint = frame.locator("#ns-dir-hint");
  await typeIn(page, frame, "/no/such/place");
  await expect(hint).toHaveText(ERR.missing);
  await expect(hint).toHaveClass(/bad/);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await typeIn(page, frame, "notes/Inbox.md");
  await expect(hint).toHaveText(ERR.notDir);
  await typeIn(page, frame, "Codex/x");
  await expect(hint).toHaveText(ERR.relative);
  await typeIn(page, frame, "~/Code/billing-api/..");
  await expect(hint).toHaveText(/\.\./);
  const answer = page.waitForResponse(r => r.url().endsWith("/api/new-session"));
  await frame.locator("#ns-go").click();
  expect((await answer).status()).toBe(400);
  await expect(frame.locator("#ns-note")).toHaveText(/\.\./);
  await expect(frame.locator("#newsess")).toBeVisible();
  expect(await sentOf(page, "new-session")).toEqual([]);
  // Fixed by hand: the hint clears and the folder is accepted.
  await typeIn(page, frame, "~/Code/billing-api");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
});

test("narrow panel: no sideways overflow, the list stays above Start and on screen", async ({ page, lang }) => {
  await page.setViewportSize({ width: 380, height: 640 });
  // A folder with many subfolders: the list has to scroll.
  const many = path.join(run.root, "many-folders");
  for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(many, `project-${String(i).padStart(2, "0")}`), { recursive: true });
  const frame = await openDialog(page, lang);
  await typeIn(page, frame, many + "/");
  const list = frame.locator("#ns-dir-list");
  await expect(list).toBeVisible();
  await expect(options(frame)).toHaveCount(40);
  expect(await list.evaluate(l => l.scrollHeight > l.clientHeight)).toBe(true);
  const box = await list.boundingBox();
  const go = await frame.locator("#ns-go").boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(go.y);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(380);
  const overflow = await frame.locator("#newsess").evaluate(d => d.scrollWidth - d.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (process.env.FOLDER_PICK_SHOTS) {
    await page.screenshot({ path: path.join(process.env.FOLDER_PICK_SHOTS, `narrow-${lang}.png`) });
    await page.setViewportSize({ width: 1100, height: 760 });
    await typeIn(page, frame, "notes");
    await frame.locator("#ns-dir").press("ArrowDown");
    await page.screenshot({ path: path.join(process.env.FOLDER_PICK_SHOTS, `wide-${lang}.png`) });
  }
});

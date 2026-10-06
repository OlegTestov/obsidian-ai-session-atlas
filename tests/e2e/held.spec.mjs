// Turning the plugin off and on closes its tabs while the agents in them keep running. The plugin
// reports those processes as `held`; the page offers them back: a banner and Go to on the card.
import { expect, ids, run, test } from "./fixtures.mjs";

const HOST = `${run.base}/e2e-held-host.html`;
const TEXT = {
  en: { banner: "1 tab closed with the plugin", back: "Bring the tab back", end: "End", go: "Go",
        closed: "After Obsidian restarted" },
  ru: { banner: "1 вкладка закрылась вместе с плагином", back: "Вернуть вкладку", end: "Завершить", go: "Перейти",
        closed: "После перезапуска Obsidian" },
};

// The plugin's side: no tabs, the Claude stand-in's PTY held. The restore list is "not ready" first
// (the plugin is still seeing which sessions came back by themselves), then ready and empty.
function hostPage(lang) {
  const held = [{ ptyPid: run.pids.claude.shell, title: "claude tab", agent: "claude" }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
window.held = ${JSON.stringify(held)};
window.restoreReady = false;
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs: [], held: window.held, health: { ok: true } });
  if (d.type === "list-restorable") reply({ type: "restorable", ready: window.restoreReady,
    sessions: window.restoreReady ? [] : [{ session_id: "${ids.claudeLive}", title: "still alive", at: 1 }] });
  if (d.type === "reattach-held" || d.type === "release-held") {
    window.held = [];
    reply({ type: "tabs", tabs: [], held: [], health: { ok: true } });
  }
});
</script></body></html>`;
}

async function openHost(page, lang) {
  await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang) }));
  await page.goto(HOST);
  return page.frameLocator("#atlas");
}

const sentOf = (page, type) => page.evaluate(t => window.sent.filter(m => m.type === t), type);

test("a held agent: the banner offers its tab back, and stays until answered", async ({ page, lang }) => {
  const tx = TEXT[lang];
  const frame = await openHost(page, lang);
  const banner = frame.locator("#restore-banner");
  await expect(banner).toContainText(tx.banner);
  await expect(banner).toContainText("claude tab");
  // A restore list that is not ready yet is not shown: it would vanish a second later.
  await expect.poll(async () => (await sentOf(page, "list-restorable")).length).toBeGreaterThan(0);
  await page.waitForTimeout(500);                  // the reply has arrived and been drawn
  await expect(banner).not.toContainText(tx.closed);
  // Polls go on and the offer is still there.
  await expect.poll(async () => (await sentOf(page, "list-tabs")).length, { timeout: 12000 }).toBeGreaterThan(1);
  await expect(banner).toContainText(tx.banner);

  await banner.getByRole("button", { name: tx.back }).click();
  await expect.poll(() => sentOf(page, "reattach-held")).toEqual([
    expect.objectContaining({ ptyPids: [run.pids.claude.shell] })]);
  await expect(banner).toBeHidden();
});

test("a held agent: Go to on its card brings the tab back", async ({ page, lang }) => {
  const tx = TEXT[lang];
  const frame = await openHost(page, lang);
  const go = frame.locator(`.acard[data-id="${ids.claudeLive}"] .foot button`, { hasText: tx.go });
  await expect(go).toBeEnabled();
  await go.click();
  await expect.poll(() => sentOf(page, "focus-tab")).toEqual([
    expect.objectContaining({ ptyPid: run.pids.claude.shell })]);
  // The Codex stand-in is not held and has no tab: its Go to stays off.
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .foot button`, { hasText: tx.go })).toBeDisabled();
});

test("a held agent: End asks first, then ends it", async ({ page, lang }) => {
  const tx = TEXT[lang];
  const frame = await openHost(page, lang);
  const banner = frame.locator("#restore-banner");
  await banner.getByRole("button", { name: tx.end, exact: true }).click();
  await expect(frame.locator("#modal")).toBeVisible();
  expect(await sentOf(page, "release-held")).toEqual([]);
  await frame.locator("#m-ok").click();
  await expect.poll(() => sentOf(page, "release-held")).toEqual([
    expect.objectContaining({ ptyPids: [run.pids.claude.shell] })]);
  await expect(banner).toBeHidden();
});

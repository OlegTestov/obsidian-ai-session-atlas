// After an Obsidian restart the plugin lists the sessions that were open in tabs. One of them may
// still be running: its old tab's process outlived Obsidian. Restoring it again would put a second
// process on the same transcript, so only the closed ones open; the live one is named instead.
import { expect, ids, run, test } from "./fixtures.mjs";

const HOST = `${run.base}/e2e-restore-host.html`;
const TEXT = {
  en: { all: "Resume all", elsewhere: "already running, not opened twice" },
  ru: { all: "Продолжить все", elsewhere: "уже запущены, второй раз не открываю" },
};

function hostPage(lang, list = [{ session_id: ids.claudeLive, title: "still alive", at: 1 },
                               { session_id: ids.claudeMain, title: "closed one", at: 2 }], ok = true) {
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
let candidates = ${JSON.stringify(list)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs: [], held: [], health: { ok: true } });
  if (d.type === "list-restorable") reply({ type: "restorable", ready: true, sessions: candidates });
  if (d.type === "resume") reply({ type: "launch-result", request: d.launchRequest, ok: ${ok} });
  if (d.type === "forget-restorable") {
    candidates = candidates.filter(s => d.sessionIds && !d.sessionIds.includes(s.session_id));
    reply({ type: "restorable", ready: true, sessions: candidates });
  }
});
</script></body></html>`;
}

const sentOf = (page, type) => page.evaluate(t => window.sent.filter(m => m.type === t), type);

test("restore after a restart: a session still running elsewhere is not opened a second time",
  async ({ page, lang }) => {
    const tx = TEXT[lang];
    await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang) }));
    await page.goto(HOST);
    const frame = page.frameLocator("#atlas");
    const banner = frame.locator("#restore-banner");
    await expect(banner.locator("button.primary")).toHaveText(tx.all);
    await banner.locator("button.primary").click();
    await expect(banner).toContainText(tx.elsewhere, { timeout: 10000 });
    await expect(banner).toContainText("still alive");
    const resumed = await sentOf(page, "resume");
    expect(resumed.map(m => m.session_id)).toEqual([ids.claudeMain]);
    const forgot = (await sentOf(page, "forget-restorable")).at(-1);
    expect(forgot.sessionIds.sort()).toEqual([ids.claudeLive, ids.claudeMain].sort());
  });

test("a saved Codex subagent with no catalog card shows the server's reason after Resume",
  async ({ page, lang }) => {
    const child = "019e0000-1111-7000-8000-000000000003";
    const list = [{ session_id: child, title: "Synthetic subagent", agent: "codex", at: 1 }];
    await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, list) }));
    await page.goto(HOST);
    const banner = page.frameLocator("#atlas").locator("#restore-banner");
    await expect(banner.locator("button.primary")).toBeVisible();
    await banner.locator("button.primary").click();
    await expect(banner.locator(".note")).toContainText(lang === "ru" ? /сессия не найдена/i : /session not found/i);
    expect(await sentOf(page, "resume")).toHaveLength(0);
    await expect(banner.locator("button.primary")).toBeEnabled();
  });

test("Resume surfaces a failed terminal launch and keeps the offer",
  async ({ page, lang }) => {
    const list = [{ session_id: ids.claudeMain, title: "Closed session", at: 1 }];
    await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, list, false) }));
    await page.goto(HOST);
    const banner = page.frameLocator("#atlas").locator("#restore-banner");
    await banner.locator("button.primary").click();
    await expect(banner.locator(".note")).toContainText(lang === "ru" ? /открыть вкладку/i : /open a tab/i);
    await expect(banner.locator("button.primary")).toBeEnabled();
  });

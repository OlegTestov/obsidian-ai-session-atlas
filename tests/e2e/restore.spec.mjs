// After an Obsidian restart the plugin lists the sessions that were open in tabs. One of them may
// still be running: its old tab's process outlived Obsidian. Restoring it again would put a second
// process on the same transcript, so only the closed ones open; the live one is named instead.
import { expect, ids, run, test } from "./fixtures.mjs";

const HOST = `${run.base}/e2e-restore-host.html`;
const TEXT = {
  en: { all: "Restore all", elsewhere: "already running outside Obsidian" },
  ru: { all: "Восстановить все", elsewhere: "уже работают вне Obsidian" },
};

function hostPage(lang) {
  const list = [{ session_id: ids.claudeLive, title: "still alive", at: 1 },
                { session_id: ids.claudeMain, title: "closed one", at: 2 }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs: [], held: [], health: { ok: true } });
  if (d.type === "list-restorable") reply({ type: "restorable", ready: true, sessions: ${JSON.stringify(list)} });
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

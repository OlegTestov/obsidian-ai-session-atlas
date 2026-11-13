// Active: a live Claude Code session and a live Codex thread (stand-in processes from the global setup).
import fs from "node:fs";

import { expect, ids, run, test } from "./fixtures.mjs";
import { PHRASES } from "./corpus.mjs";

const card = (page, id) => page.locator(`#active-grid .acard[data-id="${id}"]`);
const agentBox = (page, name) => page.locator("#active-filters .agent-ms .ms-pop label", { hasText: name });

async function pickAgents(page, want) {
  await page.locator("#active-filters .agent-ms .ms-btn").click();
  for (const [name, on] of [["Claude Code", want.includes("claude")], ["Codex", want.includes("codex")]]
    .sort((a, b) => Number(b[1]) - Number(a[1]))) {
    const box = agentBox(page, name).locator("input");
    if ((await box.isChecked()) !== on) await box.setChecked(on);
  }
  await page.locator("#active-grid").click({ position: { x: 2, y: 2 } });
}

test("both live sessions show by default with badges and statuses", async ({ page, open, t }) => {
  await open("active");
  await expect(page.locator("#active-count")).toHaveText("2");
  const codex = card(page, ids.codexLive);
  const claude = card(page, ids.claudeLive);
  await expect(codex.locator(".tags .agent-badge.codex")).toHaveText("Codex");
  await expect(claude.locator(".tags .agent-badge.claude")).toHaveText("Claude Code");
  // Codex: a turn started and not finished is work in progress; Claude Code: idle, waiting for you.
  await expect(codex.locator(".head .state")).toHaveText(t.working);
  await expect(codex).toHaveClass(/\bbusy\b/);
  await expect(claude.locator(".head .state")).toHaveText(t.idle);
  await expect(codex.locator(".head .t")).toHaveText("Reconcile the ledger with the invoices");
  await expect(claude.locator(".head .t")).toHaveText("Make the login retry back off");
  await expect(codex.locator(".tags")).toContainText("billing-api");
  // Codex limits come from Codex itself (a stand-in app server): a separate span in the summary bar,
  // a spent window names its reset, live numbers carry no age.
  const codexLimits = page.locator("#active-summary .limits", { hasText: "Codex" });
  await expect(codexLimits).toHaveText(t.codexLimits);
  await expect(codexLimits).toHaveClass(/\bwarn\b/);
  await expect(codexLimits).toHaveAttribute("title", new RegExp(t.codexLive));
  // Claude Code's status line file is 3 hours old: the same line, with its age.
  const claudeLimits = page.locator("#active-summary .limits", { hasText: "Claude" });
  await expect(claudeLimits).toHaveText(t.claudeLimits);
  await expect(claudeLimits).toHaveAttribute("title", new RegExp(t.claudeAsOf.replace("(", "\\(")));
  // Only the handshake and the usage read: no thread, no model request.
  const asked = new Set(fs.readFileSync(run.codexStandInLog, "utf8").trim().split("\n"));
  expect([...asked].sort()).toEqual(["account/rateLimits/read", "initialize", "initialized"]);
});

test("the Agent filter hides and shows each agent's cards", async ({ page, open }) => {
  await open("active");
  await expect(card(page, ids.codexLive)).toBeVisible();
  await page.locator("#active-filters .agent-ms .ms-btn").click();
  await expect(agentBox(page, "Codex").locator(".n")).toHaveText("1");
  await expect(agentBox(page, "Claude Code").locator(".n")).toHaveText("1");
  await page.locator("#active-grid").click({ position: { x: 2, y: 2 } });

  await pickAgents(page, ["claude"]);
  await expect(card(page, ids.codexLive)).toHaveCount(0);
  await expect(card(page, ids.claudeLive)).toBeVisible();
  await expect(page.locator("#active-summary .limits", { hasText: "Codex" })).toHaveCount(0);
  await page.reload();
  await expect(card(page, ids.claudeLive)).toBeVisible();
  await expect(card(page, ids.codexLive)).toHaveCount(0);

  await pickAgents(page, ["codex"]);
  await expect(card(page, ids.claudeLive)).toHaveCount(0);
  await expect(card(page, ids.codexLive)).toBeVisible();
  await expect(page.locator("#active-summary .limits", { hasText: "Codex" })).toBeVisible();

  await pickAgents(page, ["claude", "codex"]);
  await expect(card(page, ids.claudeLive)).toBeVisible();
  await expect(card(page, ids.codexLive)).toBeVisible();
});

test("the detailed view shows the chat tail of both agents", async ({ page, open, t }) => {
  await open("active");
  const tail = page.waitForRequest(r => /\/api\/active\?msgs=\d+/.test(r.url()));
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  await tail;
  const codex = card(page, ids.codexLive);
  const claude = card(page, ids.claudeLive);
  await expect(claude.locator(".amsgs")).toContainText("Does it cap the delay?");
  await expect(claude.locator(".amsgs .reply").last()).toContainText(PHRASES.claudeLiveReply);
  await expect(claude.locator(".amsgs .who").last()).toContainText("Claude,");
  await expect(codex.locator(".amsgs")).toContainText(PHRASES.codexLiveReply);
  await expect(codex.locator(".amsgs .hmsg:not(.mine) .who").last()).toContainText("Codex,");
  // The prompt of the running turn has no answer yet: it closes the tail.
  await expect(codex.locator(".amsgs .reply.mine").last()).toContainText("Run the full test suite");
  await expect(codex.locator(".amsgs .reply.mine .who").last()).toContainText(t.you);
});

test("the feed of the Codex card: turns, steps with exit codes, files", async ({ page, open, t }) => {
  await open("active");
  await card(page, ids.codexLive).locator(".feedbtn").click();
  const feed = page.locator("#feed");
  await expect(feed).toBeVisible();
  await expect(page.locator("#feed-title")).toHaveText("Reconcile the ledger with the invoices");
  const body = page.locator("#feed-body");
  await expect(body.locator(".fturn")).toHaveCount(2);
  await expect(body.locator(".fturn").first()).toContainText("Reconcile the ledger with the invoices");
  await expect(body.locator(".fturn").first()).toContainText(PHRASES.codexLiveReply);
  await expect(body.locator(".fturn").last()).toContainText("Run the full test suite");

  await page.locator("#feed-views button", { hasText: t.steps }).click();
  await expect(body.locator(".fev").first()).toBeVisible();
  await expect(body.locator(".fev.bash", { hasText: "python3 scripts/reconcile.py" })).not.toHaveClass(/\berr\b/);
  const failed = body.locator(".fev.err", { hasText: "pytest -q" });
  await expect(failed.locator(".ferr")).toContainText(t.exit);
  await expect(failed.locator(".ferr")).toContainText("FAILED tests/test_ledger.py::test_total");
  await expect(body.locator(".fev.edit")).toContainText("reconcile.py");

  await page.locator("#feed-views button", { hasText: t.files }).click();
  await expect(body.locator(".ffile")).toHaveCount(1);
  await expect(body.locator(".ffile .fn")).toContainText("reconcile.py");
  await expect(body.locator(".ffile .fdelta")).toHaveText("+2 −1");

  await page.locator("#feed-close").click();
  await expect(feed).toBeHidden();
  // The Claude card has a feed too.
  await card(page, ids.claudeLive).locator(".feedbtn").click();
  await page.locator("#feed-views button", { hasText: t.turns }).click();
  await expect(page.locator("#feed-body .fturn")).toHaveCount(2);
  await expect(page.locator("#feed-body")).toContainText(PHRASES.claudeLiveReply);
});

// Inside Obsidian the page is a frame and the plugin answers with its terminal tabs. A stand-in host
// page on the same origin does that here, so the cards get their reply fields as they do in Obsidian.
function hostPage(lang, { mode = "full", background = null, cover = 0 } = {}) {
  const tabs = [Object.assign({ ptyPid: run.pids.claude.shell, title: "claude tab" }, background ? { background } : {}),
                { ptyPid: run.pids.codex.shell, title: "codex tab", agent: "codex", screen: null }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&am=${mode}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true }, cover: ${cover} });
  if (d.type === "send-text") reply({ type: "sent", nonce: d.nonce, ok: true });
});
</script></body></html>`;
}

test("Claude-only controls are hidden on the Codex card; replies reach the right tab", async ({ page, lang }) => {
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const claudeArea = frame.locator(`.acard[data-id="${ids.claudeLive}"] .answer textarea`);
  const codexArea = frame.locator(`.acard[data-id="${ids.codexLive}"] .answer textarea`);
  await expect(claudeArea).toBeEnabled();
  await expect(codexArea).toBeEnabled();

  // Claude Code's slash commands: hints and the /effort picker on the Claude card only.
  await claudeArea.fill("/comp");
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .suggest`)).toBeVisible();
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .suggest`)).toContainText("/compact");
  await claudeArea.fill("/effort");
  await expect(frame.locator(`.acard[data-id="${ids.claudeLive}"] .argpick`)).toBeVisible();
  await claudeArea.fill("");

  await codexArea.fill("/comp");
  await page.waitForTimeout(500);                      // the hint list loads asynchronously on Claude cards
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .suggest`)).toBeHidden();
  await codexArea.fill("/effort");
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .argpick`)).toBeHidden();

  await codexArea.fill("please also check the rounding");
  await codexArea.press("Enter");
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "send-text"))).toEqual([
    expect.objectContaining({ ptyPid: run.pids.codex.shell, sessionId: ids.codexLive,
                              text: "please also check the rounding" })]);
});

// A long "now" line of a working session: in the detailed chat it is shown in full. Capped at a few
// lines while the chat lets it overflow, it was drawn over the message below it.
test("the detailed chat shows a long \"now\" line in full, over nothing", async ({ page, open }) => {
  const progress = "Found the cause: the orchestrator starts the subagents in the background and spends its turns "
    + "on side tasks while it waits for their results. ".repeat(12);
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (s.session_id === ids.codexLive) Object.assign(s, { status: "busy", activity: "busy", progress });
    });
    await route.fulfill({ response: res, json: data });
  });
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const now = card(page, ids.codexLive).locator(".amsgs .txt.now");
  await expect(now).toContainText("Found the cause");
  const fit = await now.evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(fit.sh).toBeLessThanOrEqual(fit.ch + 1);
});

// A Claude Code tab that shows a background job (← on an empty prompt, /background): its card says
// so and offers Bring back, as the tab menu does; the other cards do not.
for (const mode of ["compact", "full"]) {
  test(`${mode} card of a background tab: the mark and Bring back with the tab's job`, async ({ page, lang }) => {
    await page.route(`${run.base}/e2e-host.html`, route => route.fulfill({ contentType: "text/html; charset=utf-8",
      body: hostPage(lang, { mode, background: "ab12cd34" }) }));
    await page.goto(`${run.base}/e2e-host.html`);
    const frame = page.frameLocator("#atlas");
    const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
    const ru = lang === "ru";
    // Not a tag: the tab's server icon before the title and a short word by the status.
    await expect(claude.locator(".head .bgico svg")).toBeVisible();
    await expect(claude.locator(".head .bgico")).toHaveAttribute("title", /ab12cd34/);
    await expect(claude.locator(".head .state .bgword")).toHaveText(ru ? " · фоновая" : " · background");
    await expect(claude.locator(".tags .bgjob")).toHaveCount(0);
    const order = await claude.locator(".head").evaluate(h => [...h.children].map(c => c.className.split(" ")[0]));
    expect(order.indexOf("bgico")).toBe(order.indexOf("t") - 1);       // right before the title
    await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .bgico, .acard[data-id="${ids.codexLive}"] .bgword, `
      + `.acard[data-id="${ids.codexLive}"] .bgback`)).toHaveCount(0);
    const back = claude.locator(mode === "full" ? ".head button.bgback" : ".foot button.bgback");
    if (mode === "compact") await expect(back).toHaveAttribute("title", ru ? /обычной вкладке/ : /regular tab/);
    else await expect(back).toHaveAttribute("aria-label", ru ? "Вернуть из фона" : "Bring back");
    if (mode === "compact") {
      if (process.env.LIVE_SHOT_DIR) await claude.screenshot({ path: `${process.env.LIVE_SHOT_DIR}/bg-card-${lang}.png` });
      // Every button stays inside the card, on a second line when the card is narrow.
      const cut = await claude.evaluate(c => {
        const box = c.getBoundingClientRect();
        return [...c.querySelectorAll(".foot button")].filter(b => {
          const r = b.getBoundingClientRect();
          return r.right > box.right + 1 || r.bottom > box.bottom + 1 || r.left < box.left - 1;
        }).map(b => b.textContent);
      });
      expect(cut).toEqual([]);
      // A card as wide as on a large screen: the button has its words; a narrow one, its icon only.
      if (ru) await expect(claude.locator(".foot")).toHaveClass(/tight/);   // the English row fits as it is
      await page.setViewportSize({ width: 1900, height: 900 });
      await expect(claude.locator(".foot")).not.toHaveClass(/tight/);
      await expect(back.locator(".lbl")).toBeVisible();
      await expect(back.locator(".lbl")).toHaveText(ru ? "Вернуть из фона" : "Bring back");
      if (process.env.LIVE_SHOT_DIR) await claude.screenshot({ path: `${process.env.LIVE_SHOT_DIR}/bg-card-wide-${lang}.png` });
    }
    await back.click();
    await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "bg-bring-back")))
      .toEqual([expect.objectContaining({ job: "ab12cd34" })]);
    await expect(claude.locator("button.bgback")).toBeDisabled();
  });
}

// The session feed has the card's reply field under it: in the compact view too, where cards have none.
for (const mode of ["compact", "full"]) {
  test(`${mode}: a reply typed under the feed goes to the session's tab; the card's field shows the same draft`,
    async ({ page, lang }) => {
      await page.route(`${run.base}/e2e-host.html`, route => route.fulfill({ contentType: "text/html; charset=utf-8",
        body: hostPage(lang, { mode }) }));
      await page.route(/\/api\/upload$/, route => route.fulfill({ json: { path: "/tmp/atlas-e2e-shot.png" } }));
      await page.goto(`${run.base}/e2e-host.html`);
      const frame = page.frameLocator("#atlas");
      const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
      await claude.locator(".feedbtn").click();
      const area = frame.locator("#feed-reply .answer textarea");
      await expect(area).toBeEnabled();
      await expect(frame.locator("#feed-reply .answer .send")).toBeVisible();
      await expect(frame.locator("#feed-reply .answer .clip")).toBeVisible();
      await area.fill("check the feed field");
      if (process.env.LIVE_SHOT_DIR) await page.screenshot({ path: `${process.env.LIVE_SHOT_DIR}/feed-reply-${mode}-${lang}.png` });
      if (mode === "full") await expect(claude.locator(".answer textarea")).toHaveValue("check the feed field");
      else await expect(claude.locator(".answer textarea")).toHaveCount(0);
      // A picture attached under the feed shows on the card's field too, and goes with the reply.
      await frame.locator('#feed-reply input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") });
      await expect(frame.locator("#feed-reply .thumbs img")).toHaveCount(1);
      if (mode === "full") await expect(claude.locator(".thumbs img")).toHaveCount(1);
      await area.press("Enter");
      await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "send-text"))).toEqual([
        expect.objectContaining({ ptyPid: run.pids.claude.shell, sessionId: ids.claudeLive, text: "check the feed field",
                                  images: [expect.stringMatching(/\.png$/)] })]);
      await expect(area).toHaveValue("");
      if (mode === "full") await expect(claude.locator(".answer textarea")).toHaveValue("");
      // The feed's field stays the feed's: another card's feed gets that session's field.
      await frame.locator(`.acard[data-id="${ids.codexLive}"] .feedbtn`).click();
      await expect(frame.locator("#feed-reply .answer textarea")).toHaveAttribute("data-id", ids.codexLive);
      await frame.locator("#feed-close").click();
      await expect(frame.locator("#feed-reply .answer")).toHaveCount(0);
    });
}

test("the feed's field follows the session: a dialog opens, the field says where to answer", async ({ page, lang }) => {
  let waiting = false;
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (waiting && s.session_id === ids.claudeLive) {
        Object.assign(s, { status: "waiting", activity: "waiting", waiting_for: "permission prompt" });
      }
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route(`${run.base}/e2e-host.html`, route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: hostPage(lang, { mode: "compact" }) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  await frame.locator(`.acard[data-id="${ids.claudeLive}"] .feedbtn`).click();
  const area = frame.locator("#feed-reply .answer textarea");
  await expect(area).toBeEnabled();
  waiting = true;                                          // the next poll brings the dialog
  await expect(area).toBeDisabled({ timeout: 15000 });
  await expect(area).toHaveAttribute("placeholder", lang === "ru" ? /на карточке или во вкладке/ : /on the card or in the tab/);
});

// Obsidian's status bar floats over the bottom-right corner: the feed's field rises above what it covers.
test("the feed's reply field rises above Obsidian's status bar", async ({ page, lang }) => {
  await page.route(`${run.base}/e2e-host.html`, route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: hostPage(lang, { mode: "compact", cover: 26 }) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  await frame.locator(`.acard[data-id="${ids.claudeLive}"] .feedbtn`).click();
  const send = frame.locator("#feed-reply .answer .send");
  await expect(send).toBeVisible();
  const gap = await page.evaluate(() => {
    const f = document.querySelector("#atlas");
    const b = f.contentDocument.querySelector("#feed-reply .answer .send").getBoundingClientRect();
    return f.getBoundingClientRect().height - b.bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(26);
});

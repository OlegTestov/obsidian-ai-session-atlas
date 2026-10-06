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
function hostPage(lang) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab" },
                { ptyPid: run.pids.codex.shell, title: "codex tab", agent: "codex", screen: null }];
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#view=active&am=full" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true } });
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

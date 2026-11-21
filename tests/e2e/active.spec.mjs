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

test("a pending Codex card keeps its slot when the first rollout appears", async ({ page, lang }) => {
  const started = "2026-11-01T10:00:00+00:00";
  const pendingId = "pending-codex-7101-Sun-Nov-1-10:00:00-2026";
  const pending = { session_id: pendingId, agent: "codex", pending: true, status: "idle",
    pid: 7101, ancestors: [7001], cwd: "/tmp/project with spaces", started_at: started, process_started_at: started };
  const real = { ...pending, pending: false, session_id: ids.codexLive, title: "First prompt", status: "busy" };
  const peer = (id, time) => ({ session_id: id, agent: "claude", status: "idle",
    title: id, started_at: `2026-11-01T${time}:00:00+00:00` });
  let sessions = [peer("first", "11"), pending, peer("last", "09")];
  await page.route("**/api/active?*", route => route.fulfill({ json: { sessions } }));
  await page.route("**/api/active/feed/**", route => route.fulfill({ json: { turns: [] } }));
  await page.route(`${run.base}/pending-host.html`, route => route.fulfill({
    contentType: "text/html", body: `<iframe id="atlas" style="width:100vw;height:100vh;border:0"
      src="/?lang=${lang}#view=active"></iframe><script>
      window.actions = [];
      addEventListener("message", e => {
        if (e.data.type === "list-tabs") e.source.postMessage({ source:"session-atlas-host", type:"tabs",
          tabs:[{ ptyPid:7001, agent:"codex", inline:true }] }, "*");
        if (["focus-tab", "close-tab", "send-text"].includes(e.data.type)) window.actions.push(e.data);
      });
    </script>`,
  }));
  await page.goto(`${run.base}/pending-host.html`);
  const frame = page.frameLocator("#atlas");
  const card = frame.locator(`.acard[data-id="${pendingId}"]`);
  const [title, status, go, close, terminal] = lang === "ru"
    ? ["Новая сессия Codex", "ждёт первого сообщения", "Перейти", "Закрыть", "Терминал"]
    : ["New Codex session", "waiting for the first message", "Go", "Close", "Terminal"];
  await expect(card.locator(".head .t")).toHaveText(title);
  await expect(card.locator(".head .state")).toHaveText(status);
  await expect(card.locator(".d")).toHaveText(pending.cwd);
  await expect(card.locator(".agent-badge")).toHaveText("Codex");
  await expect(card.locator(".when")).toHaveText(/\d{2}:\d{2}/);
  await expect(card.getByRole("button")).toHaveText([go, close]);
  await card.getByRole("button", { name: go, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.actions.map(a => [a.type, a.ptyPid]))).toEqual([["focus-tab", 7001]]);

  await frame.locator('.mode button[data-mode="full"]').click();
  await expect(card.locator(".head button")).toHaveCount(3);
  await expect(card.getByRole("button", { name: terminal, exact: true })).toBeVisible();
  await expect(card.locator(".answer textarea")).toBeEnabled();
  await expect(card.locator(".card-view-picker, .card-view-body")).toHaveCount(0);
  const grid = frame.locator("#active-grid");
  await grid.evaluate((node, [before, after]) => {
    window.pendingFrames = [];
    new MutationObserver(() => window.pendingFrames.push(
      [...node.querySelectorAll(".acard")].map(c => c.dataset.id).filter(id => id === before || id === after)))
      .observe(node, { childList: true, subtree: true });
  }, [pendingId, real.session_id]);
  sessions = [sessions[2], real, sessions[0]];
  await expect(frame.locator(`.acard[data-id="${real.session_id}"]`)).toHaveClass(/\bbusy\b/, { timeout: 12000 });
  await expect(card).toHaveCount(0);
  const order = await grid.locator(".acard").evaluateAll(cards => cards.map(c => c.dataset.id));
  expect(order).toEqual(["first", real.session_id, "last"]);
  expect(await grid.evaluate(() => window.pendingFrames.every(ids => ids.length === 1))).toBe(true);
});

test("a Codex card shows its /goal and the message queued for after the turn", async ({ page, open }) => {
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();   // replies and the queue
  const codex = card(page, ids.codexLive);
  // goals_1.sqlite and queue_1.sqlite of the Codex home (global setup); the turn has no reply yet.
  await expect(codex.locator(".ftxt.mine").last()).toContainText("Run the full test suite");
  const goal = codex.locator(".tags .pill.acc", { hasText: "goal" });
  await expect(goal).toHaveAttribute("title", new RegExp(PHRASES.codexGoal));
  await expect(codex.locator(".queued")).toContainText(PHRASES.codexQueued);
  await expect(codex.locator(".queued")).toHaveAttribute("title", PHRASES.codexQueued);
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

test("detailed cards default to the conversation of their own agent", async ({ page, open }) => {
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const codex = card(page, ids.codexLive);
  const claude = card(page, ids.claudeLive);
  await expect(claude.locator(".card-view-picker")).toHaveValue("turns");
  await expect(codex.locator(".card-view-picker")).toHaveValue("turns");
  await expect(claude.locator(".card-view-body")).toContainText("Does it cap the delay?");
  await expect(claude.locator(".fturn").last()).toContainText(PHRASES.claudeLiveReply);
  await expect(claude.locator(".fturn .fwho").last()).toContainText("Claude");
  await expect(codex.locator(".card-view-body")).toContainText(PHRASES.codexLiveReply);
  await expect(codex.locator(".fturn").first()).toContainText("Codex");
  await expect(codex.locator(".ftxt.mine").last()).toContainText("Run the full test suite");
  await expect(codex.locator("option[value=terminal]")).toBeDisabled();
});

test("the card switches between conversation, steps and files independently", async ({ page, open, t }) => {
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const codex = card(page, ids.codexLive);
  const claude = card(page, ids.claudeLive);
  const picker = codex.locator(".card-view-picker");
  const body = codex.locator(".card-view-body");
  await expect(picker.locator("option")).toHaveCount(4);
  await expect(body.locator(".fturn")).toHaveCount(2);
  await expect(body.locator(".fturn").first()).toContainText(PHRASES.codexLiveReply);
  await picker.selectOption("steps");
  await expect(body.locator(".fev.bash", { hasText: "python3 scripts/reconcile.py" })).not.toHaveClass(/\berr\b/);
  const failed = body.locator(".fev.err", { hasText: "pytest -q" });
  await expect(failed.locator(".ferr")).toContainText(t.exit);
  await expect(failed.locator(".ferr")).toContainText("FAILED tests/test_ledger.py::test_total");
  await expect(body.locator(".fev.edit")).toContainText("reconcile.py");
  await picker.selectOption("files");
  await expect(body.locator(".ffile")).toHaveCount(1);
  await expect(body.locator(".ffile .fn")).toContainText("reconcile.py");
  await expect(body.locator(".ffile .fdelta")).toHaveText("+2 −1");
  await expect(claude.locator(".card-view-picker")).toHaveValue("turns");
  await expect(claude.locator(".card-view-body")).toContainText(PHRASES.claudeLiveReply);
  await page.locator("#active-filters .mode button[data-mode=compact]").click();
  await expect(picker).toHaveCount(0);
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  await expect(picker).toHaveValue("files");
  await expect(body.locator(".ffile")).toHaveCount(1);
  await picker.selectOption("turns");
  await expect(body.locator(".fturn")).toHaveCount(2);
  await expect(page.locator("#feed")).toHaveCount(0);
});

test("conversation loads earlier pages inside the card and marks shortened replies", async ({ page, open }) => {
  const prompt = n => ({ prompt: `Prompt ${n} ` + "words ".repeat(30), prompt_at: `2026-11-01T00:${String(n).padStart(2, "0")}:00Z`,
    steps: [], reply: "The reply ends here", reply_len: 100, reply_at: "2026-11-01T01:00:00Z" });
  await page.route(`**/api/active/feed/${ids.claudeLive}?*`, route => {
    const before = new URL(route.request().url()).searchParams.has("before");
    const turns = before ? [prompt(1)] : Array.from({ length: 20 }, (_, i) => prompt(i + 2));
    return route.fulfill({ json: { turns, has_more: !before } });
  });
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const body = card(page, ids.claudeLive).locator(".card-view-body");
  await expect(body.locator(".fturn")).toHaveCount(20);
  await expect(body.locator(".cutmark")).toHaveCount(20);
  expect(await body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await body.evaluate(el => { el.scrollTop = 0; });
  await expect(body.locator(".fturn")).toHaveCount(21);
  await expect(body.locator(".fturn").first()).toContainText("Prompt 1 ");
  expect(await body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
});

// Inside Obsidian the page is a frame and the plugin answers with its terminal tabs. A stand-in host
// page on the same origin does that here, so the cards get their reply fields as they do in Obsidian.
function hostPage(lang, { mode = "full", background = null } = {}) {
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
  if (d.type === "list-tabs") reply({ type: "tabs", tabs, health: { ok: true } });
  if (d.type === "send-text") reply({ type: "sent", nonce: d.nonce, ok: true });
});
</script></body></html>`;
}

test("the Codex card offers Codex's own commands, skills and models; replies reach the right tab", async ({ page, lang }) => {
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const claudeCard = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  const codexCard = frame.locator(`.acard[data-id="${ids.codexLive}"]`);
  const claudeArea = claudeCard.locator(".answer textarea");
  const codexArea = codexCard.locator(".answer textarea");
  await expect(claudeArea).toBeEnabled();
  await expect(codexArea).toBeEnabled();

  // Claude Code's slash commands: hints and the /effort picker on the Claude card.
  await claudeArea.fill("/comp");
  await expect(claudeCard.locator(".suggest")).toContainText("/compact");
  await claudeArea.fill("/effort");
  await expect(claudeCard.locator(".argpick")).toBeVisible();
  await claudeArea.fill("$rel");
  await expect(claudeCard.locator(".suggest")).toBeHidden();
  await claudeArea.fill("");

  // Codex: its own list, its skills after "$", no Claude Code-only command.
  await codexArea.fill("/comp");
  await expect(codexCard.locator(".suggest")).toContainText("/compact");
  await codexArea.fill("/effo");
  await page.waitForTimeout(300);
  await expect(codexCard.locator(".suggest")).toBeHidden();
  await codexArea.fill("$rel");
  await expect(codexCard.locator(".suggest")).toContainText("$release-notes");
  await expect(codexCard.locator(".suggest")).toContainText("Draft release notes from the git log");
  await codexArea.fill("/effort");
  await expect(codexCard.locator(".argpick")).toBeHidden();

  // /model: the models Codex lists (not the hidden ones), then the chosen model's efforts.
  await codexArea.fill("/model");
  const pick = codexCard.locator(".argpick");
  await expect(pick.locator("button")).toHaveText(["GPT-6-Luna"]);
  await pick.locator("button", { hasText: "GPT-6-Luna" }).click();
  await expect(codexArea).toHaveValue("/model gpt-6-luna");
  await expect(pick.locator("button")).toHaveText(["medium", "xhigh"]);
  await pick.locator("button", { hasText: "xhigh" }).click();
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "send-text"))).toEqual([
    expect.objectContaining({ ptyPid: run.pids.codex.shell, sessionId: ids.codexLive,
                              text: "/model gpt-6-luna --reasoning=xhigh" })]);

  await codexArea.fill("please also check the rounding");
  await codexArea.press("Enter");
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "send-text").at(-1))).toEqual(
    expect.objectContaining({ ptyPid: run.pids.codex.shell, sessionId: ids.codexLive,
                              text: "please also check the rounding" }));
});

// A message sent from the card while the agent works waits in the agent's queue: the card shows it once,
// as yours ("queued"), and the queued line lists only the other waiting messages.
test("a message sent while the agent works is not shown twice", async ({ page, lang }) => {
  const mine = "LIVE-QUEUE please also check the rounding";
  let queue = [];
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => {
      if (s.session_id === ids.claudeLive && queue.length) Object.assign(s, { status: "busy", activity: "busy", queued: queue });
    });
    await route.fulfill({ response: res, json: data });
  });
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const claude = page.frameLocator("#atlas").locator(`.acard[data-id="${ids.claudeLive}"]`);
  const area = claude.locator(".answer textarea");
  await expect(area).toBeEnabled();
  queue = [{ text: mine, at: new Date().toISOString() }];
  await area.fill(mine);
  await area.press("Enter");
  const ru = lang === "ru";
  await expect(claude.locator(".fturn:has(.mine) .fwho:first-child").last()).toContainText(ru ? "в очереди" : "queued");
  await expect(claude.locator(".ftxt.mine").last()).toContainText(mine);
  await expect(claude.locator(".queued")).toHaveCount(0);                 // only that one waits: no second line
  queue = [queue[0], { text: "and update the README", at: new Date().toISOString() }];
  await expect(claude.locator(".queued")).toHaveCount(1, { timeout: 15000 });
  await expect(claude.locator(".queued")).toContainText("and update the README");
  await expect(claude.locator(".queued")).not.toContainText("LIVE-QUEUE");
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
  const now = card(page, ids.codexLive).locator(".card-view-body .now");
  await expect(now).toContainText("Found the cause");
  const fit = await now.evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(fit.sh).toBeLessThanOrEqual(fit.ch + 1);
  await page.unrouteAll({ behavior: "wait" });
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

test("the reply field and its draft stay on the card when switching views", async ({ page, lang }) => {
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang) }));
  await page.route(/\/api\/upload$/, route => route.fulfill({ json: { path: "/tmp/atlas-e2e-shot.png" } }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const claude = frame.locator(`.acard[data-id="${ids.claudeLive}"]`);
  const area = claude.locator(".answer textarea");
  await expect(area).toBeEnabled();
  await area.fill("check the card field");
  await claude.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64") });
  await claude.locator(".card-view-picker").selectOption("files");
  await expect(area).toHaveValue("check the card field");
  await expect(claude.locator(".thumbs img")).toHaveCount(1);
  await area.press("Enter");
  await expect.poll(() => page.evaluate(() => window.sent.filter(m => m.type === "send-text"))).toEqual([
    expect.objectContaining({ ptyPid: run.pids.claude.shell, sessionId: ids.claudeLive, text: "check the card field",
                              images: [expect.stringMatching(/\.png$/)] })]);
  await expect(area).toHaveValue("");
});

test("the card reply field is disabled while the agent shows a dialog", async ({ page, lang }) => {
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
    body: hostPage(lang) }));
  await page.goto(`${run.base}/e2e-host.html`);
  const frame = page.frameLocator("#atlas");
  const area = frame.locator(`.acard[data-id="${ids.claudeLive}"] .answer textarea`);
  await expect(area).toBeEnabled();
  waiting = true;                                          // the next poll brings the dialog
  await expect(area).toBeDisabled({ timeout: 15000 });
  await expect(area).toHaveAttribute("placeholder", lang === "ru" ? /диалог/ : /dialog/);
});

test("the live conversation refresh fetches from the last turn only and merges without a gap or duplicate", async ({ page, open }) => {
  // Turn 0 has no time at all; ids are what the page merges on.
  const mk = (n, reply = "The reply ends here") => ({ id: `t${n}`, prompt: `Prompt ${n}`, steps: [], reply, reply_len: reply.length,
    prompt_at: n === 0 ? "" : `2026-11-01T00:${String(n).padStart(2, "0")}:00Z`, reply_at: "2026-11-01T01:00:00Z" });
  let turns = Array.from({ length: 25 }, (_, n) => mk(n));
  const asked = [];
  let tick = 0;
  await page.route(`**/api/active/feed/${ids.claudeLive}?*`, route => {
    const q = new URL(route.request().url()).searchParams;
    asked.push(Object.fromEntries(q));
    const at = id => turns.findIndex(t => t.id === id);
    if (q.has("since_id")) return route.fulfill({ json: { turns: turns.slice(at(q.get("since_id"))), has_more: null } });
    if (q.has("before_id")) return route.fulfill({ json: { turns: turns.slice(0, at(q.get("before_id"))).slice(-20), has_more: false } });
    return route.fulfill({ json: { turns: turns.slice(-20), has_more: true } });
  });
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => { if (s.session_id === ids.claudeLive) s.last_activity_at = new Date(Date.now() + ++tick * 1000).toISOString(); });
    await route.fulfill({ response: res, json: data });
  });
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const body = card(page, ids.claudeLive).locator(".card-view-body");
  await expect(body.locator(".fturn")).toHaveCount(20);
  await body.evaluate(el => { el.scrollTop = 0; });
  await expect(body.locator(".fturn")).toHaveCount(25);
  // The last turn grows and a new one starts.
  turns = turns.slice(0, -1).concat([mk(24, "The reply grew"), mk(25)]);
  await expect(body.locator(".fturn")).toHaveCount(26, { timeout: 20000 });
  const prompts = await body.locator(".fturn .ftxt.mine").allTextContents();
  expect(prompts.map(p => p.trim())).toEqual(Array.from({ length: 26 }, (_, n) => `Prompt ${n}`));
  await expect(body.locator(".fturn").nth(24)).toContainText("The reply grew");
  const live = asked.filter(q => q.since_id);
  expect(live.length).toBeGreaterThan(0);
  expect(live.every(q => q.since_id === "t24" || q.since_id === "t25")).toBe(true);
  expect(asked.some(q => q.since)).toBe(false);
});

test("a reset answer reloads the latest page, so older pages can still be loaded", async ({ page, open }) => {
  const mk = n => ({ id: `t${n}`, prompt: `Prompt ${n}`, steps: [], reply: "Done", reply_len: 4,
    prompt_at: `2026-11-01T00:${String(n).padStart(2, "0")}:00Z`, reply_at: "2026-11-01T01:00:00Z" });
  const turns = Array.from({ length: 30 }, (_, n) => mk(n));
  const asked = [];
  let tick = 0, lost = false;
  await page.route(`**/api/active/feed/${ids.claudeLive}?*`, route => {
    const q = new URL(route.request().url()).searchParams;
    asked.push({ ...Object.fromEntries(q), at: Date.now() });
    // The anchor fell out of the server's read window: it answers reset, with nothing to show.
    if (q.has("since_id")) { lost = true; return route.fulfill({ json: { turns: [], has_more: true, reset: true } }); }
    if (q.has("before_id")) return route.fulfill({ json: { turns: turns.slice(0, 10), has_more: false } });
    return route.fulfill({ json: { turns: turns.slice(-20), has_more: true } });
  });
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    (data.sessions || []).forEach(s => { if (s.session_id === ids.claudeLive) s.last_activity_at = new Date(Date.now() + ++tick * 1000).toISOString(); });
    await route.fulfill({ response: res, json: data });
  });
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const body = card(page, ids.claudeLive).locator(".card-view-body");
  await expect(body.locator(".fturn")).toHaveCount(20);
  await expect.poll(() => lost, { timeout: 20000 }).toBe(true);
  await expect.poll(() => asked.filter(q => q.since_id).length > 0 && asked.at(-1).since_id === undefined).toBe(true);
  const reset = asked.findIndex(q => q.since_id);
  const reload = asked.findIndex((q, i) => i > reset && !q.since_id && !q.before_id);
  expect(reload).toBeGreaterThan(reset);
  expect(asked[reload].at - asked[reset].at).toBeLessThan(1500);   // at once, not on a later poll
  await expect(body.locator(".fturn")).toHaveCount(20);            // not emptied by the reset
  await body.evaluate(el => { el.scrollTop = 0; });
  await expect(body.locator(".fturn")).toHaveCount(30);            // the earlier page loads from the first turn shown
  expect(asked.some(q => q.before_id === "t10")).toBe(true);
});

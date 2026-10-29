// Statistics: totals for both agents, the per-agent panel priced by each vendor's table, the Agent
// filter and background runs (the `codex exec` run).
import { api, expect, stored, test } from "./fixtures.mjs";

// The `codex exec` fixture run: 50,000 input tokens of which 10,000 cached, 4,000 output, gpt-5.5
// at $5 / $0.50 cached / $30 per 1M (atlas/openai_costs.py) — computed here, not read from the server.
const EXEC_COST = (40000 * 5 + 10000 * 0.5 + 4000 * 30) / 1e6;

const money = (v, lang) => "$" + (lang === "ru" ? v.toFixed(2).replace(".", ",") : v.toFixed(2));
const parseMoney = text => Number(text.replace("$", "").replace(",", "."));

/** A tile's value without its "vs previous period" badge. */
const tileValue = (page, title) => page.locator("#stats-body .tile", { has: page.locator(".tt", { hasText: title }) })
  .locator(".tv").evaluate(n => n.firstChild.textContent);
const agentsPanel = (page, t) => page.locator("#stats-body .spanel", { has: page.locator("h3", { hasText: new RegExp(`^${t.agents}$`) }) });
const agentRow = (page, t, name) => agentsPanel(page, t).locator(".brow", { has: page.locator(".bn", { hasText: new RegExp(`^${name}$`) }) });

// Specs before this one change the data on the shared server, and stats come from a snapshot
// refreshed in the background: compare numbers only once the page and the API both hold a fresh one.
const settled = page => expect(page.locator("#stats-bar .shown")).not.toHaveText(/updating…|обновляются…/, { timeout: 30000 });
async function freshApi(path) {
  for (let i = 0; i < 60; i++) {
    const data = await api(path);
    if (!data.stale) return data;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${path}: still stale after 30 s`);
}

async function pickAgents(page, want) {
  await page.locator("#stats-bar .agent-ms .ms-btn").click();
  const pop = page.locator("#stats-bar .agent-ms .ms-pop");
  for (const [name, on] of [["Claude Code", want.includes("claude")], ["Codex", want.includes("codex")]]
    .sort((a, b) => Number(b[1]) - Number(a[1]))) {
    const box = pop.locator("label", { hasText: name }).locator("input");
    if ((await box.isChecked()) !== on) {
      const loaded = page.waitForResponse(r => r.url().includes("/api/stats?"));
      await box.setChecked(on);
      await loaded;
      await settled(page);
    }
  }
  await page.locator("#stats-body").click({ position: { x: 2, y: 2 } });
}

test("totals for both agents and an Agents panel priced per vendor", async ({ page, open, t, lang }) => {
  await open("stats");
  await settled(page);
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(2);
  const data = await freshApi("/api/stats?period=7d&auto=0");
  const byAgent = Object.fromEntries(data.by_agent.map(r => [r.name, r]));
  expect(Object.keys(byAgent).sort()).toEqual(["claude", "codex"]);
  expect(byAgent.codex.cost).toBeGreaterThan(0);
  expect(byAgent.claude.cost).toBeGreaterThan(0);
  expect(data.totals.unpriced_models).toEqual([]);
  await expect(agentRow(page, t, "Codex").locator(".bv")).toHaveText(money(byAgent.codex.cost, lang));
  await expect(agentRow(page, t, "Claude Code").locator(".bv")).toHaveText(money(byAgent.claude.cost, lang));
  expect(await tileValue(page, t.cost)).toBe(money(data.totals.cost, lang));
  expect(Math.abs(data.totals.cost - byAgent.codex.cost - byAgent.claude.cost)).toBeLessThan(0.011);
  // Models of both vendors in one list: Codex's priced from the OpenAI table.
  await expect(page.locator("#stats-body .spanel", { hasText: "gpt-5.5" })).toBeVisible();
  await expect(page.locator("#stats-body .spanel", { hasText: "sonnet-5" })).toBeVisible();
});

test("the Agent filter: totals equal that agent's row, and the pick survives a reload", async ({ page, open, t }) => {
  await open("stats");
  await settled(page);
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(2);
  const codexCost = await agentRow(page, t, "Codex").locator(".bv").textContent();
  const claudeCost = await agentRow(page, t, "Claude Code").locator(".bv").textContent();
  await page.locator("#stats-bar .metric button").nth(1).click();          // tokens
  const codexTokens = await agentRow(page, t, "Codex").locator(".bv").textContent();
  const claudeTokens = await agentRow(page, t, "Claude Code").locator(".bv").textContent();
  await page.locator("#stats-bar .metric button").nth(0).click();          // cost

  const sent = page.waitForRequest(r => /\/api\/stats\?.*agent=codex/.test(r.url()));
  await pickAgents(page, ["codex"]);
  await sent;
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(1);
  await expect.poll(() => tileValue(page, t.cost)).toBe(codexCost);
  await page.locator("#stats-bar .metric button").nth(1).click();
  await expect.poll(() => tileValue(page, t.tokensTile)).toBe(codexTokens);
  await page.locator("#stats-bar .metric button").nth(0).click();
  await page.reload();
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(1);
  await expect(agentRow(page, t, "Codex")).toBeVisible();
  expect((await stored(page, "atlas.agents")).stats).toEqual(["codex"]);

  await pickAgents(page, ["claude"]);
  await expect(agentRow(page, t, "Claude Code")).toBeVisible();
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(1);
  await expect.poll(() => tileValue(page, t.cost)).toBe(claudeCost);
  await page.locator("#stats-bar .metric button").nth(1).click();
  await expect.poll(() => tileValue(page, t.tokensTile)).toBe(claudeTokens);
  await page.locator("#stats-bar .metric button").nth(0).click();

  await pickAgents(page, ["claude", "codex"]);
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(2);
});

test("background runs add the codex exec run, priced from the OpenAI table", async ({ page, open, t }) => {
  await open("stats");
  await settled(page);
  await pickAgents(page, ["codex"]);
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(1);
  const before = parseMoney(await agentRow(page, t, "Codex").locator(".bv").textContent());
  const sessionsBefore = Number(await tileValue(page, t.sessionsTile));
  await expect(page.locator("#stats-body")).not.toContainText("Summarize the nightly ops log");

  const loaded = page.waitForResponse(r => /\/api\/stats\?.*auto=1/.test(r.url()));
  await page.locator("#stats-bar label.chk", { hasText: t.background }).locator("input").check();
  await loaded;
  await settled(page);
  await expect.poll(async () => Number(await tileValue(page, t.sessionsTile))).toBe(sessionsBefore + 1);
  const after = parseMoney(await agentRow(page, t, "Codex").locator(".bv").textContent());
  expect(Math.abs(after - before - EXEC_COST)).toBeLessThan(0.011);
  await expect(page.locator("#stats-body .spanel", { hasText: "Summarize the nightly ops log" })).toBeVisible();
});

test("the cost caption is one short line; how it is counted shows behind ⓘ on hover and on focus",
  async ({ page, open, t, lang }) => {
    await open("stats");
    const costTile = page.locator("#stats-body .tile", { has: page.locator(".tt", { hasText: t.cost }) });
    const sub = costTile.locator(".ts");
    const caption = lang === "ru" ? "оценка по ценам API, не подписка" : "estimate at API prices, not the subscription";
    const hint = lang === "ru" ? /Каждый ответ — по ценам API своей модели/ : /Each reply at its own model's API prices/;
    await expect(sub).toContainText(caption);
    expect(await sub.evaluate(n => n.firstChild.textContent)).toBe(caption);
    const info = sub.locator("button.info");
    const tip = sub.locator(".tip");
    await expect(tip).toBeHidden();
    await expect(costTile).not.toHaveAttribute("title");            // one tooltip, not two
    await info.hover();
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText(hint);
    await page.mouse.move(0, 0);
    await expect(tip).toBeHidden();
    await info.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");                                   // keyboard focus, :focus-visible
    await expect(tip).toBeVisible();
    await expect(info).toHaveAttribute("aria-describedby", "cost-tip");
    await expect(info).toHaveAccessibleName(lang === "ru" ? "Как оценена цена" : "How the cost is estimated");
  });

// Stale-snapshot polling with a faked server: `answers[i]` decides the i-th answer — "old" (stale,
// counted at 08:05, 777 sessions), "fresh", "failed" (stale, its refresh failed) or "error" (503, a busy server).
async function fakeSnapshots(page, answers) {
  const seen = { calls: 0 };
  await page.route("**/api/stats?*", async route => {
    const kind = answers[Math.min(seen.calls, answers.length - 1)];
    seen.calls += 1;
    if (kind === "error") return route.fulfill({ status: 503, json: { error: "busy" } });
    const real = await (await route.fetch()).json();
    if (kind === "fresh") return route.fulfill({ json: Object.assign(real, { stale: false, refresh_failed: false }) });
    real.totals.sessions = 777;
    await route.fulfill({ json: Object.assign(real, { stale: true, refresh_failed: kind === "failed",
                                                      until: "2026-10-28T08:05:00+00:00" }) });
  });
  return seen;
}
const updatingNote = lang => lang === "ru" ? /^данные на .+, обновляются…$/ : /^as of .+, updating…$/;
const updatedNote = lang => lang === "ru" ? /^обновлено / : /^updated /;
const sessionsTile = (page, lang) => tileValue(page, lang === "ru" ? "Сессии" : "Sessions");

test("an old snapshot is shown at once with its time and replaced when the server has a newer one",
  async ({ page, open, lang }) => {
    const seen = await fakeSnapshots(page, ["old", "old", "fresh"]);
    await page.clock.install();
    await open("stats");
    const note = page.locator("#stats-bar .shown");
    await expect(note).toHaveText(updatingNote(lang));
    expect(await sessionsTile(page, lang)).toBe("777");
    await page.clock.runFor(2100);
    await expect(note).toHaveText(updatingNote(lang));
    await page.clock.runFor(2100);
    await expect(note).toHaveText(updatedNote(lang));
    await expect.poll(() => sessionsTile(page, lang)).not.toBe("777");   // the body shows the new numbers
    expect(seen.calls).toBe(3);
    await page.clock.runFor(10000);
    expect(seen.calls).toBe(3);                                       // polling stopped
  });

test("one failed request does not stop the wait for a newer snapshot", async ({ page, open, lang }) => {
  const seen = await fakeSnapshots(page, ["old", "error", "fresh"]);
  page.expectHttpError(/\/api\/stats\?/);
  await page.clock.install();
  await open("stats");
  const note = page.locator("#stats-bar .shown");
  await expect(note).toHaveText(updatingNote(lang));
  await page.clock.runFor(2100);
  await expect.poll(() => seen.calls).toBe(2);
  await expect(note).toHaveText(updatingNote(lang));                // still waiting after the error
  await page.clock.runFor(2100);
  await expect(note).toHaveText(updatedNote(lang));
  await expect.poll(() => sessionsTile(page, lang)).not.toBe("777");
});

test("polling ends when the refresh failed, and after 15 tries", async ({ page, open, lang }) => {
  const failed = await fakeSnapshots(page, ["old", "failed"]);
  await page.clock.install();
  await open("stats");
  const note = page.locator("#stats-bar .shown");
  await page.clock.runFor(2100);
  await expect.poll(() => failed.calls).toBe(2);
  await expect(note).toHaveText(updatedNote(lang));                 // the old numbers, no "updating…"
  await page.clock.runFor(20000);
  expect(failed.calls).toBe(2);

  await page.unroute("**/api/stats?*");
  const stale = await fakeSnapshots(page, ["old"]);                 // never newer
  await page.locator("#stats-bar .seg:not(.metric) button:not(.on)").first().click();   // a new wait
  await expect(note).toHaveText(updatingNote(lang));
  for (let i = 0; i < 16; i++) {                                    // each answer comes in real time
    await page.clock.runFor(2100);
    await expect.poll(() => stale.calls).toBe(Math.min(i + 2, 16));
  }
  await expect(note).toHaveText(updatedNote(lang));
  expect(stale.calls).toBe(16);                                     // the first answer + 15 tries
  await page.clock.runFor(20000);
  expect(stale.calls).toBe(16);
  expect(await sessionsTile(page, lang)).toBe("777");
});

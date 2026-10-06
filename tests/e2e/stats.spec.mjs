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
    }
  }
  await page.locator("#stats-body").click({ position: { x: 2, y: 2 } });
}

test("totals for both agents and an Agents panel priced per vendor", async ({ page, open, t, lang }) => {
  await open("stats");
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(2);
  const data = await api("/api/stats?period=7d&auto=0");
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
  await pickAgents(page, ["codex"]);
  await expect(agentsPanel(page, t).locator(".brow")).toHaveCount(1);
  const before = parseMoney(await agentRow(page, t, "Codex").locator(".bv").textContent());
  const sessionsBefore = Number(await tileValue(page, t.sessionsTile));
  await expect(page.locator("#stats-body")).not.toContainText("Summarize the nightly ops log");

  const loaded = page.waitForResponse(r => /\/api\/stats\?.*auto=1/.test(r.url()));
  await page.locator("#stats-bar label.chk", { hasText: t.background }).locator("input").check();
  await loaded;
  await expect.poll(async () => Number(await tileValue(page, t.sessionsTile))).toBe(sessionsBefore + 1);
  const after = parseMoney(await agentRow(page, t, "Codex").locator(".bv").textContent());
  expect(Math.abs(after - before - EXEC_COST)).toBeLessThan(0.011);
  await expect(page.locator("#stats-body .spanel", { hasText: "Summarize the nightly ops log" })).toBeVisible();
});

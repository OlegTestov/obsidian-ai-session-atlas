// Statistics: totals for both agents, the per-agent panel priced by each vendor's table, the Agent
// filter and background runs (the `codex exec` run).
import { CODEX_COLD_EXTRA, COLD_WRITES } from "./corpus.mjs";
import { api, expect, ids, stored, test } from "./fixtures.mjs";

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

// Background runs are counted by default now. The specs below were written for the unticked box and
// seed that choice (with the migration marker); the "by default" specs run with empty storage.
test.beforeEach(async ({ page }, info) => {
  if (info.title.includes("by default")) return;
  await page.addInitScript(() => {
    if (window.localStorage.getItem("atlas.stats") === null) {
      window.localStorage.setItem("atlas.stats", JSON.stringify({ auto: false, autoV: 2 }));
    }
  });
});

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

test("background runs are counted by default and the cost tile shows their share", async ({ page, open, t, lang }) => {
  await open("stats");
  await settled(page);
  const box = page.locator("#stats-bar label.chk", { hasText: t.background }).locator("input");
  await expect(box).toBeChecked();
  const data = await freshApi("/api/stats?period=7d&auto=1");
  expect(data.totals.auto_cost).toBeGreaterThan(0);
  const share = Math.round(100 * data.totals.auto_cost / data.totals.cost);
  const costTile = page.locator("#stats-body .tile", { has: page.locator(".tt", { hasText: t.cost }) });
  const line = costTile.locator(".bgl");
  const text = lang === "ru" ? `из них автоматические запуски: ${money(data.totals.auto_cost, lang)} (${share < 1 ? "<1" : share}%)`
                             : `automated runs: ${money(data.totals.auto_cost, lang)} (${share < 1 ? "<1" : share}%)`;
  await expect(line).toHaveText(text.replace(/ /g, " "));
  // Unticking removes the line and the choice survives a reload.
  const loaded = page.waitForResponse(r => /\/api\/stats\?.*auto=0/.test(r.url()));
  await box.uncheck();
  await loaded;
  await settled(page);
  await expect(costTile.locator(".bgl")).toHaveCount(0);
  expect((await stored(page, "atlas.stats")).auto).toBe(false);
  await page.reload();
  await open("stats");
  await expect(page.locator("#stats-bar label.chk", { hasText: t.background }).locator("input")).not.toBeChecked();
});

test("the cost caption is one short line; how it is counted shows behind ⓘ on hover and on focus",
  async ({ page, open, t, lang }) => {
    await open("stats");
    const costTile = page.locator("#stats-body .tile", { has: page.locator(".tt", { hasText: t.cost }) });
    const sub = costTile.locator(".ts");
    const caption = lang === "ru" ? "оценка по ценам API, не платёж за подписку" : "estimate at API prices, not your subscription payment";
    const hint = lang === "ru" ? /Каждый вызов модели — по ценам API этой модели/ : /Each model call at that model's API prices/;
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
    await expect(info).toHaveAccessibleName(lang === "ru" ? "Как рассчитана стоимость" : "How the cost is estimated");
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

// --- cache rewrites ---------------------------------------------------------------------------
// The corpus session "Rework the export pipeline after lunch" (claude-sonnet-5: $2 input, ×1.25 cache write,
// ×0.1 cache read): its first reply is normal, the next three rewrite the cache after 2 h, 30 min and 3 min.
const CLAUDE_REWRITE_COST = COLD_WRITES.slice(1).reduce((sum, written) => sum + (1200 * 1.8 + written * 2.3) / 1e6, 0);
const REWRITE_COST = CLAUDE_REWRITE_COST + CODEX_COLD_EXTRA;       // plus the interactive Codex thread
const COLD_TITLE = "Rework the export pipeline after lunch";
const CODEX_COLD_TITLE = "Codex cold: audit the invoice rounding";
const CACHE_TILE = { en: "Cache hit rate", ru: "Доля из кэша" };
const REWRITE_PANEL = { en: "Cache rewrites · estimated extra cost", ru: "Повторная запись кэша · оценка переплаты" };
// The line's own text: the ⓘ button and its tooltip live inside the same element.
const lineText = (page, lang) => cacheTile(page, lang).locator(".ts.rw").evaluate(n => n.firstChild.textContent.trim());
const cacheTip = (page, lang) => cacheTile(page, lang).locator(".tip");
const cacheTile = (page, lang) => page.locator("#stats-body .tile", { has: page.locator(".tt", { hasText: CACHE_TILE[lang] }) });
const rewritePanel = (page, lang) => page.locator("#stats-body .spanel.rewrites", { has: page.locator("h3", { hasText: REWRITE_PANEL[lang] }) });
const rewriteLine = (rw, lang) => {
  const cost = money(rw.cost, lang);
  const pct = Math.round(rw.share * 100);
  return lang === "ru" ? `Повторная запись кэша: ${cost} · ${pct}% расхода` : `Cache rewrites: ${cost} · ${pct}% of cost`;
};

// The page with a doctored payload: the shape the server sends, one field changed.
async function withPayload(page, change) {
  await page.route("**/api/stats?*", async route => {
    const real = await (await route.fetch()).json();
    change(real);
    await route.fulfill({ json: Object.assign(real, { stale: false, refresh_failed: false }) });
  });
}

test("the cache tile shows what rewrites cost, warns, and the panel opens the session", async ({ page, open, lang }) => {
  await open("stats");
  await settled(page);
  const data = await freshApi("/api/stats?period=7d&auto=0");
  const rw = data.cache_rewrites;
  expect(rw.count).toBe(4);
  expect(rw.cost).toBeCloseTo(REWRITE_COST, 2);
  expect(Object.fromEntries(Object.entries(rw.by_cause).map(([k, v]) => [k, v.count])))
    .toEqual({ pause_long: 2, pause: 1, changed: 1 });
  expect(rw.share).toBeGreaterThanOrEqual(0.1);                     // the fixture is mostly small replies
  const tile = cacheTile(page, lang);
  await expect(tile.locator(".tv")).toContainText("%");             // the hit rate stays the big value
  await expect.poll(() => lineText(page, lang)).toBe(rewriteLine(rw, lang));
  await expect(tile).toHaveClass(/\bwarn\b/);
  await expect(tile).not.toHaveAttribute("title");                  // one tooltip, behind ⓘ
  const info = tile.locator("button.info");
  const tip = cacheTip(page, lang);
  await expect(tip).toBeHidden();
  await info.focus();                                               // keyboard focus opens it, no hover needed
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(tip).toBeVisible();
  const hint = await tip.textContent();
  expect(hint).toContain(lang === "ru" ? "После паузы дольше часа: ответов 2" : "After a pause over 1 hour: replies 2");
  expect(hint).toContain(lang === "ru" ? "После паузы больше 5 минут (до часа)" : "After a pause over 5 minutes (up to 1 hour)");
  expect(hint).toContain(lang === "ru" ? "Без долгой паузы — вероятно, изменился контекст" : "No long pause — the context probably changed");
  expect(hint).not.toContain("/clear");
  expect(hint).toContain(lang === "ru" ? "Продолжить в новой сессии" : "Continue in a new session");
  await expect(info).toHaveAttribute("aria-describedby", "cache-tip");

  const panel = rewritePanel(page, lang);
  await expect(panel.locator(".brow")).toHaveCount(2);
  const row = panel.locator(".brow", { has: page.locator(".bn", { hasText: COLD_TITLE }) });
  await expect(row.locator(".bv")).toHaveText(money(CLAUDE_REWRITE_COST, lang));
  const rowHint = await row.getAttribute("title");
  expect(rowHint).toContain(lang === "ru" ? "ответов 3" : "replies 3");
  expect(rowHint).toContain(lang === "ru" ? "пауза больше часа: 1" : "pause over 1 h: 1");
  expect(rowHint).toContain(lang === "ru" ? "пауза больше 5 минут: 1" : "pause over 5 min: 1");
  await expect(panel.locator(".brow", { has: page.locator(".bn", { hasText: CODEX_COLD_TITLE }) }).locator(".bv"))
    .toHaveText(money(CODEX_COLD_EXTRA, lang));
  await row.click();
  await expect(page.locator("#card-body")).toContainText(COLD_TITLE);
  expect(page.url()).toContain(ids.claudeCold);
});

for (const [share, pct, warns] of [[0.0949, 9, false], [0.095, 10, true]]) {
  test(`the warning follows the percent the tile shows: ${share} shows ${pct}%`, async ({ page, open, lang }) => {
    await withPayload(page, d => { d.cache_rewrites.share = share; });
    await open("stats");
    await settled(page);
    await expect.poll(() => lineText(page, lang)).toContain(lang === "ru" ? `${pct}% расхода` : `${pct}% of cost`);
    if (warns) await expect(cacheTile(page, lang)).toHaveClass(/\bwarn\b/);
    else await expect(cacheTile(page, lang)).not.toHaveClass(/\bwarn\b/);
  });
}

test("no rewrites: no warning and no panel", async ({ page, open, lang }) => {
  await withPayload(page, d => { Object.assign(d.cache_rewrites, { count: 0, cost: 0, share: 0, sessions: [] }); });
  await open("stats");
  await settled(page);
  await expect.poll(() => lineText(page, lang)).toBe(lang === "ru" ? "Повторной записи кэша не найдено" : "No cache rewrites found");
  await expect(cacheTile(page, lang)).not.toHaveClass(/\bwarn\b/);
  await expect(rewritePanel(page, lang)).toHaveCount(0);
});

test("an unknown share leaves the share out of the line and does not warn", async ({ page, open, lang }) => {
  await withPayload(page, d => { d.cache_rewrites.share = null; });
  await open("stats");
  await settled(page);
  await expect.poll(() => lineText(page, lang)).toMatch(
    lang === "ru" ? /^Повторная запись кэша: \$[\d.,]+$/ : /^Cache rewrites: \$[\d.]+$/);
  await expect(cacheTile(page, lang)).not.toHaveClass(/\bwarn\b/);
});

test("nothing priced: the line shows a dash, not $0.00", async ({ page, open, lang }) => {
  await withPayload(page, d => { Object.assign(d.cache_rewrites, { share: null, cost: 0 }); });
  await open("stats");
  await settled(page);
  await expect.poll(() => lineText(page, lang)).toBe(lang === "ru" ? "Повторная запись кэша: —" : "Cache rewrites: —");
});

test("an older server without cache_rewrites still renders the plain cache tile", async ({ page, open, lang }) => {
  await withPayload(page, d => { delete d.cache_rewrites; });
  await open("stats");
  await settled(page);
  const tile = cacheTile(page, lang);
  await expect(tile.locator(".tv")).toContainText("%");
  await expect(tile.locator(".rw")).toHaveCount(0);
  await expect(tile).not.toHaveClass(/\bwarn\b/);
  await expect(rewritePanel(page, lang)).toHaveCount(0);
  await expect(page.locator("#stats-body .spanel").first()).toBeVisible();
});

test("only Codex: the interactive cold thread is counted, the nightly exec run is not", async ({ page, open, lang }) => {
  await open("stats");
  await settled(page);
  await pickAgents(page, ["codex"]);
  const data = await freshApi("/api/stats?period=7d&auto=0&agent=codex");
  expect(data.cache_rewrites.count).toBe(1);
  expect(data.cache_rewrites.by_cause.pause_long.count).toBe(1);
  expect(data.cache_rewrites.cost).toBeCloseTo(CODEX_COLD_EXTRA, 2);
  await expect.poll(() => lineText(page, lang)).toContain(money(CODEX_COLD_EXTRA, lang));
  const panel = rewritePanel(page, lang);
  await expect(panel.locator(".brow")).toHaveCount(1);
  await expect(panel.locator(".bn")).toHaveText(CODEX_COLD_TITLE);
  const exec = await freshApi("/api/stats?period=7d&auto=1&agent=codex");       // with background runs: the cold exec run adds nothing
  expect(exec.cache_rewrites.count).toBe(1);
  await pickAgents(page, ["claude", "codex"]);
});

test("a session with no priced rewrite shows a dash in the panel", async ({ page, open, lang }) => {
  await withPayload(page, d => { d.cache_rewrites.sessions[d.cache_rewrites.sessions.length - 1].cost = null; });
  await open("stats");
  await settled(page);
  const panel = rewritePanel(page, lang);
  await expect(panel.locator(".brow")).toHaveCount(2);
  await expect(panel.locator(".brow").last().locator(".bv")).toHaveText("—");
  await expect(panel.locator(".brow").first().locator(".bv")).not.toHaveText("—");
});

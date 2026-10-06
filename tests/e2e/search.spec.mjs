// Search: both agents by default, the Agent filter, full-text search across both, the session card.
import { api, expect, ids, run, stored, test } from "./fixtures.mjs";
import { PHRASES } from "./corpus.mjs";

const list = page => page.locator("#list .row");
const row = (page, id) => page.locator(`#list .row[data-id="${id}"]`);

/** Type a query and wait for the list drawn for it (search runs on a debounce). */
async function search(page, q) {
  await page.locator("#q").fill(q);
  await expect(page.locator("#list")).toHaveAttribute("data-q", q);
  await expect(page.locator("#list")).not.toHaveAttribute("aria-busy", "true");
}

async function pickAgents(page, want) {
  await page.locator("#search-agent .ms-btn").click();
  const pop = page.locator("#search-agent .ms-pop");
  await expect(pop).toBeVisible();
  // Tick the wanted ones first: the last ticked agent cannot be unticked.
  for (const [name, on] of [["Claude Code", want.includes("claude")], ["Codex", want.includes("codex")]]
    .sort((a, b) => Number(b[1]) - Number(a[1]))) {
    const box = pop.locator("label", { hasText: name }).locator("input");
    if ((await box.isChecked()) !== on) await box.setChecked(on);
  }
  await page.keyboard.press("Escape");
  await page.locator("#list").click({ position: { x: 5, y: 5 } });      // an outside click closes the list
  await expect(pop).toBeHidden();
}

/** Every row's badge matches the agent the server has for that session. */
async function expectBadges(page, only) {
  const rows = await list(page).all();
  expect(rows.length).toBeGreaterThan(0);
  const all = await api("/api/sessions?limit=200");
  const agentOf = Object.fromEntries(all.results.map(r => [r.session_id, r.agent]));
  for (const r of rows) {
    const id = await r.getAttribute("data-id");
    const agent = only || agentOf[id];
    await expect(r.locator(".agent-badge")).toHaveClass(new RegExp(`\\b${agent}\\b`));
    await expect(r.locator(".agent-badge")).toHaveText(agent === "codex" ? "Codex" : "Claude Code");
  }
}

test("both agents are listed by default with their badges", async ({ page, open, t }) => {
  await open();
  const expected = await api("/api/sessions?limit=200");
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(expected.count));
  await expect(list(page)).toHaveCount(expected.shown);
  expect(new Set(expected.results.map(r => r.agent))).toEqual(new Set(["claude", "codex"]));
  await expect(row(page, ids.codexLedger).locator(".agent-badge.codex")).toHaveText("Codex");
  await expect(row(page, ids.claudeMain).locator(".agent-badge.claude")).toHaveText("Claude Code");
  await expect(row(page, ids.claudeMain).locator(".meta")).toContainText("ABC-12");
  await expect(page.locator("#search-agent .ms-btn")).toContainText("Claude Code, Codex");
  await expectBadges(page);
  // Background runs (a headless Claude run, `codex exec`) are hidden until asked for.
  await expect(row(page, ids.codexExec)).toHaveCount(0);
  await expect(row(page, ids.claudeHeadless)).toHaveCount(0);
  await page.locator("#automation").check();
  await expect(row(page, ids.codexExec).locator(".agent-badge.codex")).toBeVisible();
  await expect(row(page, ids.claudeHeadless).locator(".agent-badge.claude")).toBeVisible();
});

test("the Agent filter narrows the list, sends agent= and survives a reload", async ({ page, open, t }) => {
  await open();
  const both = await api("/api/sessions?limit=200");
  const codexOnly = await api("/api/sessions?limit=200&agent=codex");
  const claudeOnly = await api("/api/sessions?limit=200&agent=claude");
  expect(codexOnly.count + claudeOnly.count).toBe(both.count);
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(both.count));

  const sent = page.waitForRequest(r => /\/api\/sessions\?.*agent=codex/.test(r.url()));
  await pickAgents(page, ["codex"]);
  await sent;
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(codexOnly.count));
  await expect(list(page)).toHaveCount(codexOnly.shown);
  await expectBadges(page, "codex");
  await expect(row(page, ids.claudeMain)).toHaveCount(0);
  await expect(page.locator("#chips")).toContainText("Codex");
  expect((await stored(page, "atlas.agents")).search).toEqual(["codex"]);
  // The last ticked agent cannot be unticked: an empty pick would show an empty page.
  await page.locator("#search-agent .ms-btn").click();
  await expect(page.locator("#search-agent .ms-pop label", { hasText: "Codex" }).locator("input")).toBeDisabled();
  await page.locator("#list").click({ position: { x: 5, y: 5 } });

  await page.reload();
  await expect(page.locator("#search-agent .ms-btn")).toContainText("Codex");
  await expect(page.locator("#search-agent .ms-btn")).not.toContainText("Claude Code");
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(codexOnly.count));
  await expectBadges(page, "codex");

  await pickAgents(page, ["claude"]);
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(claudeOnly.count));
  await expect(list(page)).toHaveCount(claudeOnly.shown);
  await expectBadges(page, "claude");
  await expect(row(page, ids.codexLedger)).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(claudeOnly.count));

  const unfiltered = page.waitForRequest(r => /\/api\/sessions\?/.test(r.url()) && !/agent=/.test(r.url()));
  await pickAgents(page, ["claude", "codex"]);
  await unfiltered;
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(both.count));
  await expectBadges(page);
  await page.reload();
  await expect(page.locator("#chips .count")).toHaveText(t.sessions(both.count));
  expect((await stored(page, "atlas.agents")).search).toEqual(["claude", "codex"]);
});

test("full-text search finds text that only one agent's transcript has", async ({ page, open }) => {
  await open();
  await search(page, PHRASES.codexOnly);
  await expect(row(page, ids.codexLedger)).toBeVisible();
  await expectBadges(page, "codex");
  await expect(row(page, ids.codexLedger).locator(".frag")).toContainText("flamingo");

  await search(page, PHRASES.claudeOnly);
  await expect(list(page)).toHaveCount(1);
  await expect(row(page, ids.claudeMain).locator(".agent-badge.claude")).toBeVisible();
  await expect(row(page, ids.claudeMain).locator(".frag")).toContainText("marmalade");

  // The filter applies to search results too.
  await pickAgents(page, ["codex"]);
  await expect(page.locator("#list .row")).toHaveCount(0);
  await expect(page.locator("#list .empty")).toBeVisible();
});

test("a Codex card: title from Codex's state database, prompts, files, codex resume", async ({ page, open, t }) => {
  await open();
  await row(page, ids.codexLedger).click();
  const card = page.locator("#card");
  await expect(card.locator("h3")).toHaveText(PHRASES.codexTitle);
  await expect(card.locator(".sub .agent-badge.codex")).toHaveText("Codex");
  await card.locator("summary", { hasText: t.userPrompts }).click();
  await expect(card.locator("details pre").first()).toContainText(`Find why the ${PHRASES.codexOnly} totals drift`);
  await card.locator("summary", { hasText: t.editedFiles(1) }).click();
  await expect(card.locator("ul.files li")).toHaveText(run.corpus.cwds.billing + "/billing/ledger.py");
  await card.locator("#bar button.primary", { hasText: t.resume }).click();
  await expect(page.locator("#modal")).toBeVisible();
  await expect(page.locator("#m-body")).toHaveText(`cd ${run.corpus.cwds.billing} && codex resume ${ids.codexLedger}`);
  await page.locator("#m-close").click();
  // The address keeps the open card: a reload shows it again.
  await page.reload();
  await expect(page.locator("#card h3")).toHaveText(PHRASES.codexTitle);
});

test("a Claude card: compaction, edited files and claude --resume", async ({ page, open, t }) => {
  await open();
  await row(page, ids.claudeMain).click();
  const card = page.locator("#card");
  await expect(card.locator("h3")).toHaveText("Fix the flaky login test for ABC-12");
  await expect(card.locator(".sub .agent-badge.claude")).toHaveText("Claude Code");
  await expect(card.locator(".block.lead")).toContainText("raising the retry count");
  await card.locator("summary", { hasText: t.editedFiles(2) }).click();
  await expect(card.locator("ul.files")).toContainText(run.corpus.cwds.demo + "/src/login.py");
  await card.locator("#bar button.primary", { hasText: t.resume }).click();
  await expect(page.locator("#m-body")).toHaveText(`cd ${run.corpus.cwds.demo} && claude --resume ${ids.claudeMain}`);
  await page.locator("#m-close").click();
});

// A narrow pane (Obsidian split in two): search stays on top, the other filters fold behind a button.
test("narrow pane: the search field stays, Filters opens the rest, a found session opens below", async ({ page, open }) => {
  await page.setViewportSize({ width: 680, height: 900 });
  await open();
  await expect(page.locator("#q")).toBeVisible();
  await expect(page.locator("#project")).toBeHidden();
  const toggle = page.locator("#filters-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#project")).toBeVisible();
  await toggle.click();
  await expect(page.locator("#project")).toBeHidden();
  await search(page, PHRASES.claudeOnly);
  await row(page, ids.claudeMain).click();
  await expect(page.locator("#bar")).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, "no sideways scroll").toBeLessThanOrEqual(680);
});

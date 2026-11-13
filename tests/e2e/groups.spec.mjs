// Active: session groups the plugin reports with its tabs. The card shows its tab's group, the Group
// filter picks a group's sessions, and the label asks the plugin for its group menu at the click.
import { expect, ids, run, test } from "./fixtures.mjs";

const WORDS = { en: { add: "Add to group…", filter: "Group" }, ru: { add: "В группу…", filter: "Группа" } };

/** A stand-in plugin host; window.setGroup(group) changes the Claude tab's group for the next poll. */
function hostPage(lang, groups, options = {}) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab", group: { id: "g1", name: "Backend", color: "red" } },
                { ptyPid: run.pids.codex.shell, title: "codex tab", agent: "codex", screen: null }];
  if (options.empty) tabs[0].group = null;
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="/?lang=${lang}#${options.hash || "view=active"}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
window.setGroup = g => { tabs[0].group = g; };
window.setTabGroup = (index, group) => { tabs[index].group = group; };
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply(Object.assign({ type: "tabs", tabs, health: { ok: true } }, ${groups ? "{ groups: true }" : "{}"}));
});
</script></body></html>`;
}

async function openHost(page, lang, groups = true, options = {}) {
  await page.route(`${run.base}/e2e-host.html`, route =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: hostPage(lang, groups, options) }));
  await page.goto(`${run.base}/e2e-host.html`);
  return page.frameLocator("#atlas");
}

const card = (frame, id) => frame.locator(`#active-grid .acard[data-id="${id}"]`);

test("a card shows its tab's group; the label asks the plugin for the group menu where it was clicked",
  async ({ page, lang }) => {
    const frame = await openHost(page, lang);
    const claude = card(frame, ids.claudeLive);
    const label = claude.locator(".tags .pill.grp");
    await expect(label).toHaveText("Backend");
    await expect(label).toHaveClass(/\bg-red\b/);
    await expect(claude).toHaveClass(/\bgrouped\b/);
    const color = await label.evaluate(e => getComputedStyle(e).backgroundColor);
    expect(color).not.toBe("rgba(0, 0, 0, 0)");
    // A card whose tab has no group offers one, shown on hover.
    const add = card(frame, ids.codexLive).locator(".tags .pill.grp.add");
    await expect(add).toHaveText(WORDS[lang].add);
    await card(frame, ids.codexLive).hover();
    await expect(add).toHaveCSS("opacity", "1");
    const asked = () => page.evaluate(() => window.sent.filter(m => m.type === "group-menu"));
    await label.click();
    await expect.poll(asked).toEqual([expect.objectContaining({ ptyPid: run.pids.claude.shell })]);
    const box = await label.boundingBox();
    const [byMouse] = await asked();
    expect(byMouse.x).toBeGreaterThan(0);
    expect(byMouse.y).toBeGreaterThan(0);
    // From the keyboard there is no pointer: the menu goes under the label, not to the corner.
    await label.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await asked()).length).toBe(2);
    const byKey = (await asked())[1];
    expect(byKey.y).toBeGreaterThan(box.y - 1);
    expect(byKey.x).toBeGreaterThan(box.x - 1);
    await add.click();
    await expect.poll(async () => (await asked()).length).toBe(3);
  });

test("the Group filter picks a group's sessions and follows a group change in Obsidian", async ({ page, lang }) => {
  const frame = await openHost(page, lang);
  const filter = frame.locator("#active-filters .ms", { hasText: WORDS[lang].filter });
  await expect(filter).toBeVisible();
  await filter.locator(".ms-btn").click();
  await filter.locator(".ms-pop label", { hasText: "Backend" }).locator("input").check();
  await frame.locator("#active-grid").click({ position: { x: 2, y: 2 } });
  await expect(card(frame, ids.claudeLive)).toBeVisible();
  await expect(card(frame, ids.codexLive)).toHaveCount(0);
  // Renamed and recoloured in Obsidian: the next answer redraws the card.
  await page.evaluate(() => window.setGroup({ id: "g1", name: "Infra", color: "blue" }));
  await filter.locator(".ms-btn").click();
  await filter.locator(".ms-pop button", { hasText: lang === "ru" ? "Сбросить" : "Reset" }).click();
  await frame.locator("#active-grid").click({ position: { x: 2, y: 2 } });
  const label = card(frame, ids.claudeLive).locator(".tags .pill.grp");
  await expect(label).toHaveText("Infra", { timeout: 15000 });
  await expect(label).toHaveClass(/\bg-blue\b/);
  // Out of every group: the filter goes away.
  await page.evaluate(() => window.setGroup(null));
  await expect(card(frame, ids.claudeLive).locator(".tags .pill.grp.add")).toHaveCount(1, { timeout: 15000 });
  await expect(filter).toBeHidden();
});

test("a plugin without groups gets no group labels and no Group filter", async ({ page, lang }) => {
  const frame = await openHost(page, lang, false);
  await expect(card(frame, ids.claudeLive).locator(".tags .agent-badge")).toBeVisible();
  await expect(frame.locator(".pill.grp")).toHaveCount(0);
  await expect(frame.locator("#active-filters .ms", { hasText: WORDS[lang].filter })).toBeHidden();
});

test("same-named groups are distinct and a rename keeps the selected group", async ({ page, lang }) => {
  const frame = await openHost(page, lang);
  await page.evaluate(() => window.setTabGroup(1, { id: "g2", name: "Backend", color: "blue" }));
  await expect(card(frame, ids.codexLive).locator(".tags .pill.grp")).toHaveText("Backend", { timeout: 15000 });
  const filter = frame.locator("#active-filters .ms", { hasText: WORDS[lang].filter });
  await filter.locator(".ms-btn").click();
  const options = filter.locator(".ms-pop label", { hasText: "Backend" });
  await expect(options).toHaveCount(2);
  const red = filter.locator(".ms-pop label", { hasText: lang === "ru" ? "красная" : "red" });
  await red.locator("input").check();
  await frame.locator("#active-grid").click({ position: { x: 2, y: 2 } });
  await expect(card(frame, ids.claudeLive)).toBeVisible();
  await expect(card(frame, ids.codexLive)).toHaveCount(0);
  await page.evaluate(() => window.setGroup({ id: "g1", name: "Infra", color: "green" }));
  await expect(card(frame, ids.claudeLive).locator(".tags .pill.grp")).toHaveText("Infra", { timeout: 15000 });
  await expect(card(frame, ids.codexLive)).toHaveCount(0);
  await expect(filter.locator(".ms-btn")).toHaveAttribute("title", /Infra/);
});


test("unchecking an unresolved legacy group stays cleared after tabs arrive", async ({ page, lang }) => {
  const frame = await openHost(page, lang, true, { empty: true, hash: "view=active&ag=Backend" });
  const filter = frame.locator("#active-filters .ms", { hasText: WORDS[lang].filter });
  await filter.locator(".ms-btn").click();
  await filter.locator(".ms-pop label", { hasText: "Backend" }).locator("input").uncheck();
  await frame.locator("#active-grid").click({ position: { x: 2, y: 2 } });
  await expect(card(frame, ids.codexLive)).toBeVisible();
  await page.evaluate(() => window.setGroup({ id: "g1", name: "Backend", color: "red" }));
  await expect(card(frame, ids.claudeLive).locator(".tags .pill.grp")).toHaveText("Backend", { timeout: 15000 });
  await expect(card(frame, ids.codexLive)).toBeVisible();
  await filter.locator(".ms-btn").click();
  await expect(filter.locator(".ms-pop label", { hasText: "Backend" }).locator("input")).not.toBeChecked();
});

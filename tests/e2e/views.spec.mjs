// Every view loads in the project's language and theme without console errors or failed requests
// (the shared page fixture fails the test on either).
import { api, expect, test } from "./fixtures.mjs";

const NAV = { en: ["Search", "Active", "Statistics"], ru: ["Поиск", "Активные", "Статистика"] };

/** Relative luminance of a CSS rgb() colour: dark theme backgrounds are near 0, light near 1. */
const luminance = rgb => {
  const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

async function expectHeaderControlsInBounds(page) {
  expect(await page.locator("#views").evaluate(nav => {
    const bounds = nav.getBoundingClientRect();
    let edge = bounds.left;
    return [...nav.querySelectorAll("button")].every(button => {
      const rect = button.getBoundingClientRect();
      const fits = rect.width > 0 && rect.left >= edge && rect.right <= bounds.right
        && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      edge = rect.right;
      return fits;
    });
  })).toBe(true);
}

test("all views and the help dialog render in the language and theme", async ({ page, open, lang, colorScheme }) => {
  await open();
  await expect(page.locator("#list .row").first()).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (colorScheme === "dark") expect(luminance(bg)).toBeLessThan(0.2);
  else expect(luminance(bg)).toBeGreaterThan(0.8);
  await expect(page.locator("#view-search")).toHaveText(NAV[lang][0]);
  await expect(page.locator("#view-active")).toContainText(NAV[lang][1]);
  await expect(page.locator("#view-stats")).toHaveText(NAV[lang][2]);

  await page.locator("#view-active").click();
  await expect(page.locator("#active-grid .acard")).toHaveCount(2);
  await page.locator("#view-stats").click();
  await expect(page.locator("#stats-body .tiles")).toBeVisible();
  await page.locator("#help-btn").click();
  await expect(page.locator("#help")).toBeVisible();
  await expect(page.locator("#help-body")).toContainText(lang === "ru"
    ? "Лимиты подписок Claude Code и Codex — в верхней панели"
    : "Claude Code and Codex subscription limits are in the header");
  await page.locator("#help-close").click();
  await page.locator("#view-search").click();
  await expect(page.locator("#app")).toBeVisible();
  // Nothing on the page fell back to a raw dictionary key.
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\b(?:search|card|active|stats|agent|feed|delete|common)\.[a-z]+[A-Za-z.]*\b/);
});

test("subscription limits fit in the header on every view", async ({ page, open, lang }) => {
  const reset = new Date(Date.now() + 3600000).toISOString();
  const limits = (first, week) => ({ live: false, age_seconds: 600, windows: [
    { key: "five_hour", label: "5 hours", used_percentage: first, resets_at: reset },
    { key: "seven_day", label: "week", used_percentage: week },
  ] });
  const data = { limits: limits(78, 3), codex_limits: limits(42, 100) };
  const active = { ...await api("/api/active", lang), ...data };
  await page.route("**/api/active?*", route => route.fulfill({ json: active }));
  await page.route("**/api/limits", route => route.fulfill({ json: data }));
  await open();
  const header = page.locator("#header-limits");
  const shown = header.locator(".shown");
  const full = lang === "ru" ? /^Claude 5ч 78% · нед 3%.*Codex 5ч 42% · нед 100%, исчерпан/
    : /^Claude 5h 78% · wk 3%.*Codex 5h 42% · wk 100%, used up/;
  await expect(header).toHaveAttribute("aria-label", full);
  await expect(page.locator("#active-count")).toHaveText("2");
  for (const view of ["search", "active", "stats"]) {
    await page.locator(`#view-${view}`).click();
    await expect(header).toBeVisible();
    await expect(header).toHaveAttribute("title", full);
    await expect(page.locator("#active-summary .limits")).toHaveCount(0);
    for (const [width, wanted] of [[360, "Codex 100%"], [600, "Claude 78% · Codex 100%"], [900], [1400, full]]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 360) await expectHeaderControlsInBounds(page);
      if (wanted) await expect(shown).toHaveText(wanted);
      await expect(shown.locator(".limits.warn")).toContainText("Codex");
      await expect.poll(() => header.evaluate(node => {
        const available = node.parentElement.getBoundingClientRect().width;
        const versions = [...node.children];
        const fits = versions.find(version => version.getBoundingClientRect().width <= available);
        return fits?.classList.contains("shown");
      })).toBe(true);
      expect(await shown.evaluate(part => {
        const slot = document.querySelector("#header-limits-slot");
        const nav = slot.parentElement;
        const box = nav.getBoundingClientRect();
        const tab = document.querySelector("#view-stats").getBoundingClientRect();
        const help = document.querySelector("#help-btn").getBoundingClientRect();
        const limit = part.getBoundingClientRect();
        return getComputedStyle(slot).whiteSpace === "nowrap" && box.height === 32
          && help.right <= box.right && limit.left >= tab.right && limit.right <= help.left
          && limit.top >= box.top && limit.bottom <= box.bottom;
      })).toBe(true);
    }
  }
  const nextLang = lang === "ru" ? "en" : "ru";
  await page.evaluate(value => window.I18N.setLang(value), nextLang);
  await expect(shown).toContainText(nextLang === "ru" ? "нед 100%" : "wk 100%");
  await page.setViewportSize({ width: 240, height: 900 });
  await expect(shown).toHaveCount(0);
  await expect(header).toHaveAttribute("aria-label", nextLang === "ru" ? /нед 100%, исчерпан/ : /wk 100%, used up/);
  // Use the locale's own tab labels at 240 CSS pixels, then operate every control.
  await page.evaluate(value => window.I18N.setLang(value), lang);
  await expect(page.locator("#view-stats")).toHaveText(NAV[lang][2]);
  await expectHeaderControlsInBounds(page);
  for (const view of ["search", "active", "stats"]) {
    const tab = page.locator("#view-" + view);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
  await page.locator("#help-btn").click();
  await expect(page.locator("#help")).toBeVisible();
});

test("the header tooltip follows a light limits refresh while hovered", async ({ page, open }) => {
  const usage = percent => ({ limits: { live: true, windows: [
    { key: "five_hour", label: "5 hours", used_percentage: percent },
  ] } });
  await page.clock.install();
  await page.route("**/api/active?*", route => route.fulfill({ json: { ...usage(27), sessions: [] } }));
  await page.route("**/api/limits", route => route.fulfill({ json: usage(42) }));
  await open();
  const header = page.locator("#header-limits");
  await expect(header).toHaveAttribute("aria-label", /27%/);
  await header.locator(".shown").hover();
  await page.clock.runFor(1100);
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("27%");
  await page.clock.fastForward(60000);
  await expect(header).toHaveAttribute("aria-label", /42%/);
  await expect(tooltip).toContainText("42%");
});

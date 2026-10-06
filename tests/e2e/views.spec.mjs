// Every view loads in the project's language and theme without console errors or failed requests
// (the shared page fixture fails the test on either).
import { expect, test } from "./fixtures.mjs";

const NAV = { en: ["Search", "Active", "Statistics"], ru: ["Поиск", "Активные", "Статистика"] };

/** Relative luminance of a CSS rgb() colour: dark theme backgrounds are near 0, light near 1. */
const luminance = rgb => {
  const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

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
  await page.locator("#help-close").click();
  await page.locator("#view-search").click();
  await expect(page.locator("#app")).toBeVisible();
  // Nothing on the page fell back to a raw dictionary key.
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\b(?:search|card|active|stats|agent|feed|delete|common)\.[a-z]+[A-Za-z.]*\b/);
});

// AI features: the page confirms the agent its preview named (the server refuses another one), and a
// paused auto-classification says why. The server's answers are routed here: no model is called.
import { expect, ids, test } from "./fixtures.mjs";

const TX = {
  en: { summarize: "Summarize session", changed: "Open the preview again." },
  ru: { summarize: "Подвести итог", changed: "Открой предпросмотр снова." },
};

async function aiOn(page, autoClassify = null) {
  await page.route("**/api/facets", async route => {
    const res = await route.fetch();
    const data = await res.json();
    await route.fulfill({ response: res, json: { ...data, llm_enabled: true,
                                                  ...(autoClassify ? { auto_classify: autoClassify } : {}) } });
  });
}

test("the job names the agent the preview showed; a refusal asks to preview again", async ({ page, open, lang }) => {
  const tx = TX[lang];
  await aiOn(page);
  await page.route("**/api/preview", route => route.fulfill({ json: {
    backend: "codex-cli", agent_name: "Codex", model: "default / low", text: "PREVIEW-TEXT", chars: 12,
    sensitivity: "normal", sections: [] } }));
  const sent = [];
  page.expectHttpError(/\/api\/job$/);
  await page.route("**/api/job", route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: `→ Claude Code. ${tx.changed}` } });
  });
  await open("search", `#s=${ids.codexRenameEn}`);
  await expect(page.locator("#card h3")).toBeVisible();
  await page.locator("#bar button.ghost").click();
  await page.locator("#menu button", { hasText: tx.summarize }).click();
  await expect(page.locator("#modal")).toContainText("Codex");
  await page.locator("#m-ok").click();
  await expect(page.locator("#m-note")).toContainText(tx.changed);
  expect(sent).toEqual([{ session_id: ids.codexRenameEn, artifact_kind: "catalog_summary", confirmed: true,
                          backend: "codex-cli" }]);
});

test("classifying names the agent its preview showed", async ({ page, open, lang }) => {
  await aiOn(page);
  await page.route("**/api/classify/preview", route => route.fulfill({ json: {
    backend: "codex-cli", agent_name: "Codex", model: "default / low", pending: 2, estimated_chars: 900,
    note: "", samples: ["SAMPLE"] } }));
  const sent = [];
  page.expectHttpError(/\/api\/classify$/);
  await page.route("**/api/classify", route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: TX[lang].changed } });
  });
  await open();
  await page.locator("#classify").click();
  await expect(page.locator("#modal")).toContainText("Codex");
  await page.locator("#m-ok").click();
  await expect(page.locator("#m-note")).toContainText(TX[lang].changed);
  expect(sent).toEqual([{ confirmed: true, backend: "codex-cli" }]);
});

test("a paused auto-classification shows why, a running one does not", async ({ page, open }) => {
  const reason = "Paused: it was turned on for Claude Code, and AI features now go to Codex.";
  const auto = { enabled: true, agent: "Claude Code", paused: reason, last_run: null, next_run: null,
                 interval_minutes: 60, max_per_run: 8 };
  await aiOn(page, auto);
  await open();
  await expect(page.locator("#auto-classify-paused")).toBeVisible();
  await expect(page.locator("#auto-classify-paused")).toHaveText(reason);
  await expect(page.locator("#auto-classify-label")).toHaveAttribute("title", /Claude Code/);
  await page.unroute("**/api/facets");
  await aiOn(page, { ...auto, paused: null });
  await page.reload();
  await expect(page.locator("#auto-classify-paused")).toBeHidden();
});

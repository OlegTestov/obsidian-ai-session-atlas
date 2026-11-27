import { expect, ids, test } from "./fixtures.mjs";

test("a Codex rewind drops reverted turns from every loaded page", async ({ page, open }) => {
  let rewound = false;
  let revision = 0;
  const turn = (id, prompt, minute) => ({
    id, prompt, steps: [], reply: "Answer", reply_len: 6,
    prompt_at: `2026-11-27T12:0${minute}:00Z`,
    reply_at: `2026-11-27T12:0${minute}:03Z`,
  });
  const kept = turn("kept", "Kept prompt", 0);
  const older = turn("older", "Earlier reverted prompt", 1);
  const reverted = turn("reverted", "Reverted prompt", 2);
  const replacement = turn("replacement", "Replacement prompt", 3);
  const asked = [];
  await page.route(`**/api/active/feed/${ids.codexLive}?*`, route => {
    const query = new URL(route.request().url()).searchParams;
    asked.push(Object.fromEntries(query));
    if (rewound) {
      const since = query.get("since_id");
      const changed = since === reverted.id;
      const turns = since === replacement.id ? [replacement] : [kept, replacement];
      return route.fulfill({ json: { turns, has_more: false, history: "rewound",
        ...(changed ? { reset: true, history_changed: true } : {}) } });
    }
    if (query.has("before_id")) {
      return route.fulfill({ json: { turns: [kept, older], has_more: false, history: "original" } });
    }
    return route.fulfill({ json: { turns: [reverted], has_more: true, history: "original" } });
  });
  await page.route(/\/api\/active(\?|$)/, async route => {
    const res = await route.fetch();
    const data = await res.json();
    for (const row of data.sessions || []) if (row.session_id === ids.codexLive) {
      row.prompt_at = new Date(Date.now() + ++revision * 1000).toISOString();
    }
    await route.fulfill({ response: res, json: data });
  });
  await open("active");
  await page.locator("#active-filters .mode button[data-mode=full]").click();
  const body = page.locator(`.acard[data-id="${ids.codexLive}"] .card-view-body`);
  await expect(body.getByText(reverted.prompt, { exact: true })).toBeVisible();
  await body.locator(".fearlier").click();
  await expect(body.getByText(older.prompt, { exact: true })).toBeVisible();
  rewound = true;
  await expect(body.getByText(replacement.prompt, { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(body.locator(".ftxt.mine")).toHaveText([kept.prompt, replacement.prompt]);
  expect(asked).toContainEqual(expect.objectContaining({ before_id: reverted.id, history: "original" }));
  expect(asked).toContainEqual(expect.objectContaining({ since_id: reverted.id, history: "original" }));
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.mjs";

test("OpenCode catalog exposes native controls and plain compact badges", async ({ page, context, lang, t }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-open-code-e2e-"));
  const source = path.join(root, "data", "opencode");
  const work = path.join(root, "Project with spaces");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(work);
  fs.copyFileSync("tests/fixtures/opencode/opencode.db", path.join(source, "opencode.db"));
  const python = process.env.E2E_PYTHON || "/usr/bin/python3";
  execFileSync(python, ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); "
    + "c.execute('update session_v2 set directory=?',(sys.argv[2],)); c.commit()",
  path.join(source, "opencode.db"), work]);
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = spawn(python, ["-m", "atlas.cli", "serve", "--port", String(port)], {
    stdio: "ignore",
    env: { ...process.env, HOME: root, ATLAS_HOME: path.join(root, "atlas"), ATLAS_OPENCODE_HOME: source,
      XDG_STATE_HOME: path.join(root, "state"), XDG_DATA_HOME: path.dirname(source),
      ATLAS_OPENCODE_BIN: "", ATLAS_PROJECTS_ROOT: path.join(root, "claude"), ATLAS_CODEX_HOME: path.join(root, "codex") },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await expect.poll(async () => {
      try { return (await (await fetch(base + "/api/index-status")).json()).sessions; }
      catch { return 0; }
    }, { timeout: 15000 }).toBe(8);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.addInitScript(() => localStorage.setItem("atlas.stats", JSON.stringify({ period: "all" })));
    // The page may have loaded facets before the background pass commits the first OpenCode rows.
    await page.route("**/api/facets", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), opencode_available: false } });
    });
    await page.goto(`${base}/?lang=${lang}`);
    const row = page.locator(".row", { hasText: "OpenCode fixture plain" });
    await expect(row.locator(".agent-badge.opencode")).toHaveText("OpenCode");
    expect(await row.locator(".agent-badge.opencode").evaluate(node => getComputedStyle(node, "::before").content)).toBe("none");
    await page.locator("#search-agent .ms-btn").click();
    const filter = page.getByRole("group", { name: t.agent, exact: true });
    const openCode = filter.getByRole("checkbox", { name: "OpenCode" });
    await expect(openCode).toBeChecked();
    await openCode.uncheck();
    await expect(row).toHaveCount(0);
    await openCode.check();
    await expect(row).toBeVisible();
    await page.locator("#search-agent .ms-btn").click();
    await row.click();

    const card = page.locator("#card");
    await expect(card.locator(".agent-badge.brand-size")).toHaveText("OpenCode");
    const mark = await card.locator(".agent-badge.brand-size").evaluate(el => getComputedStyle(el, "::before").backgroundImage);
    expect(mark).toContain(lang === "ru" ? "%23EEEEEE" : "%231F1F1F");
    await expect(card.getByRole("button", { name: t.rename, exact: true })).toBeVisible();
    const commands = card.locator("#bar button");
    await expect(commands).toHaveCount(4);
    await expect(commands.last()).toBeDisabled();
    await expect(commands.last()).toHaveAttribute("title", /PATH/);
    await commands.first().click();
    const command = page.locator("#m-body");
    await expect(command).toHaveText(/opencode .*Project with spaces.* --session ses_[A-Za-z0-9]{26}$/);
    await page.locator("#m-copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await command.textContent());
    await page.keyboard.press("Escape");
    await page.locator(".row", { hasText: "OpenCode fixture empty" }).click();
    await expect(card.locator("#bar button").nth(1)).toBeDisabled();
    await expect(card.locator("#bar button").nth(1)).toHaveAttribute("title", /empty session|пустую сессию/);

    await page.route("**/api/delete/preview", route => route.fulfill({ json: {
      children: [], disabled_reason: lang === "ru"
        ? "Открыта вкладка OpenCode, где Atlas не знает текущую сессию"
        : "An OpenCode tab is open and Atlas does not know its current session.",
    } }));
    await row.click();
    await expect(card.locator("#bar button.danger")).toBeDisabled();
    await expect(card.locator("#bar button.danger")).toHaveAttribute("title", /текущую сессию|current session/);
    await expect(card.locator("#bar button").nth(2)).toBeEnabled();

    await page.unroute("**/api/delete/preview");
    const database = "/fixture/custom/opencode.db";
    await page.route("**/api/delete/preview", route => route.fulfill({ json: {
      database, service_generation: "fixture-generation",
      children: [{ title: "Fixture child", session_id: "ses_" + "c".repeat(26) }], disabled_reason: null,
    } }));
    await page.route("**/api/delete", async route => {
      expect(route.request().postDataJSON()).toMatchObject({
        confirmed: true, children: ["ses_" + "c".repeat(26)], service_generation: "fixture-generation",
      });
      await route.fulfill({ json: { deleted: true,
        extra_deleted: [{ title: "Unconfirmed child", session_id: "ses_" + "d".repeat(26) }] } });
    });
    await page.evaluate(id => window.openCard(id), await row.getAttribute("data-id"));
    await expect(card.locator("#bar button.danger")).toBeEnabled();
    let firstRequest;
    const forkId = "ses_" + "f".repeat(26);
    const missingRequest = "fixture-missing-copy";
    const copyRequests = [];
    await page.route("**/api/opencode/fork", route => {
      const request = route.request().postDataJSON();
      copyRequests.push(request);
      if (request.request_id === missingRequest) {
        return route.fulfill({ status: 409, json: { state: "session_missing", error: "Saved copy is missing" } });
      }
      if (!firstRequest) {
        firstRequest = request.request_id;
        return route.fulfill({ json: { status: "unknown", confirmation_id: firstRequest,
          candidates: [{ title: "Possible fork", session_id: forkId }] } });
      }
      if (request.confirm_unknown) expect(request.confirm_unknown).toBe(firstRequest);
      expect(request.request_id).not.toBe(firstRequest);
      return route.fulfill({ json: { agent: "opencode", session_id: forkId, cwd: work,
        command: `cd "${work}" && opencode "${work}" --session ${forkId}` } });
    });
    await card.locator("#bar button").nth(1).click();
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-note")).toContainText(lang === "ru"
      ? "Возможно, копия уже создана. Создать ещё одну?"
      : "A copy may already exist. Create another one?");
    await expect(page.locator("#m-body")).toContainText("Possible fork");
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-body")).toContainText("--session " + forkId);
    await page.keyboard.press("Escape");

    const sid = await row.getAttribute("data-id");
    const storageKey = "atlas.opencode.copy." + sid;
    page.expectHttpError(/\/api\/opencode\/fork$/);
    page.expectConsoleError(/server responded with a status of 409/);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey)).toBeNull();
    await page.evaluate(([key, request]) => localStorage.setItem(key, JSON.stringify(request)),
      [storageKey, missingRequest]);
    await card.locator("#bar button").nth(1).click();
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-note")).toHaveText("Saved copy is missing");
    await expect(page.locator("#m-ok")).toHaveText(lang === "ru" ? "Создать копию" : "Create copy");
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-body")).toContainText("--session " + forkId);
    expect(copyRequests[2].request_id).toBe(missingRequest);
    expect(copyRequests[3].request_id).not.toBe(missingRequest);
    await page.keyboard.press("Escape");

    await page.unroute("**/api/opencode/fork");
    const committed = new Map();
    let dropResponse = true;
    page.expectConsoleError(/net::ERR_ABORTED/);
    await page.route("**/api/opencode/fork", route => {
      const { request_id } = route.request().postDataJSON();
      if (!committed.has(request_id)) {
        committed.set(request_id, "ses_" + String(committed.size + 1).padStart(26, "0"));
      }
      if (dropResponse) {
        dropResponse = false;
        return route.abort("aborted");
      }
      const id = committed.get(request_id);
      return route.fulfill({ json: { agent: "opencode", session_id: id, cwd: work,
        command: `cd "${work}" && opencode "${work}" --session ${id}` } });
    });
    await card.locator("#bar button").nth(1).click();
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-ok")).toBeEnabled();
    await page.reload();
    await expect(card.locator("#bar button").nth(1)).toBeEnabled();
    await card.locator("#bar button").nth(1).click();
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-body")).toContainText("--session " + committed.values().next().value);
    expect(committed.size).toBe(1);
    await page.keyboard.press("Escape");

    await page.locator("#bar button.danger").click();
    await expect(page.locator("#m-note")).toContainText(lang === "ru" ? "Другой клиент OpenCode" : "Another OpenCode client");
    await expect(page.locator("#m-body")).toContainText("Fixture child");
    await expect(page.locator("#m-body")).toContainText(database);
    await expect(page.locator("#m-close")).toBeFocused();
    await page.locator("#m-ok").click();
    await expect(page.locator("#m-note")).toContainText(lang === "ru" ? "Также исчезли" : "Also disappeared");
    await expect(page.locator("#m-body")).toContainText("Unconfirmed child");
    await page.keyboard.press("Escape");

    await page.route("**/api/stats?*", async route => {
      const response = await route.fetch();
      const json = await response.json();
      const point = json.series.points.find(item => item.sessions > 0);
      if (point) point.cost = null;
      await route.fulfill({ response, json });
    });
    await page.locator("#view-stats").click();
    const agent = page.locator("#stats-body .spanel", { has: page.getByRole("heading", { name: t.agents, exact: true }) })
      .locator(".brow .agent-badge.opencode");
    await expect(agent).toHaveText("OpenCode");
    await expect(page.locator("#stats-body .legend")).toContainText(lang === "ru" ? "рассуждения 15" : "reasoning 15");
    await expect(agent.locator("xpath=../..").locator(".bv")).toHaveText(lang === "ru" ? "$0,28" : "$0.28");
    await expect(page.locator(".chart .col:has(.unknown)").first()).toHaveAttribute("title",
      lang === "ru" ? /стоимость неизвестна/ : /unknown cost/);
    await page.locator("#stats-bar .agent-ms .ms-btn").click();
    await expect(page.getByRole("group", { name: t.agent, exact: true }).getByRole("checkbox", { name: "OpenCode" }))
      .toBeChecked();
  } finally {
    const ended = once(server, "exit");
    server.kill();
    if (server.exitCode === null) await ended;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

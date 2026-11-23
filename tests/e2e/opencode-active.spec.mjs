/* global openCodeReplyChecks, openCodeReplying, sendOpenCodeReply -- page globals used inside evaluate callbacks */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.mjs";

const recorded = JSON.parse(fs.readFileSync("tests/fixtures/opencode/service-2.3.2-active.json"));
const value = key => recorded[key].body.data;
const python = process.env.E2E_PYTHON || "/usr/bin/python3";

async function startWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-open-code-active-"));
  const source = path.join(root, "data/opencode");
  const state = path.join(root, "state/opencode");
  const atlas = path.join(root, "atlas");
  const tabs = path.join(atlas, "opencode-tabs");
  for (const dir of [source, state, tabs]) fs.mkdirSync(dir, { recursive: true });
  const database = path.join(source, "opencode.db");
  fs.copyFileSync("tests/fixtures/opencode/opencode.db", database);
  const [sid, external] = JSON.parse(execFileSync(python, ["-c", `
import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('update session_v2 set directory=?',(sys.argv[2],))
c.commit()
print(json.dumps([id for id, in c.execute("select id from session_v2 where title in (?, ?) order by title",
    ("OpenCode fixture plain", "OpenCode fixture tools"))]))
`, database, root], { encoding: "utf8" }));

  const pty = spawn("/bin/sh", ["-c", "/bin/sleep 120 & echo $!; wait"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [chunk] = await once(pty.stdout, "data");
  const pid = Number(chunk.toString().trim());
  const attempt = "a".repeat(32);
  const nonce = "b".repeat(32);
  const instance = "opencode-e2e";
  const start = pid => execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
  fs.writeFileSync(path.join(tabs, `layout-${process.pid}.json`), JSON.stringify({
    pid: process.pid, start: start(process.pid), tabs: [{ instance, attempt, ptyPid: pty.pid, launching: true }],
  }));
  fs.writeFileSync(path.join(tabs, `${instance}.json`), JSON.stringify({ pid, start: start(pid), nonce, attempt, current: sid }));
  let current = sid;
  const routeFile = path.join(tabs, `${instance}.${nonce}.route`);
  const writeRoute = () => {
    fs.writeFileSync(routeFile + ".tmp", JSON.stringify({ pid, nonce, route: "session", current, at: Date.now() }));
    fs.renameSync(routeFile + ".tmp", routeFile);
  };
  const setRoute = sid => { current = sid; writeRoute(); };
  writeRoute();
  const heartbeat = setInterval(writeRoute, 1000);

  const serviceState = { active: { [sid]: { type: "running" }, [external]: { type: "running" } },
    permissions: { [sid]: { ...value("permission"), sessionID: sid },
      [external]: { ...value("permission"), sessionID: external } }, form: null, inbox: [], calls: [] };
  const native = http.createServer(async (req, res) => {
    const raw = [];
    for await (const buf of req) raw.push(buf);
    const body = raw.length ? JSON.parse(Buffer.concat(raw).toString()) : null;
    const parts = new URL(req.url, "http://127.0.0.1").pathname.split("/").slice(2);
    const { active, permissions, form, inbox, calls } = serviceState;
    const send = (status, body) => { res.writeHead(status); res.end(body == null ? "" : JSON.stringify(body)); };
    const data = result => send(200, { data: result });
    calls.push({ method: req.method, parts, body });
    if (parts[0] === "info") return send(200, { pid: process.pid, version: "2.3.2", paths: { database } });
    if (parts[0] === "model") return send(200, recorded.models);
    if (parts[1] === "active") return serviceState.unavailable ? send(503, {}) : data(active);
    const [, session, route, id] = parts;
    if (route === "permission") {
      const item = permissions[session];
      if (!id) return data(item ? [item] : []);
      if (item?.id !== id) return send(404, {});
      if (req.method === "GET") {
        if (session === sid && serviceState.switchOnPermissionRead) {
          serviceState.switchOnPermissionRead = false;
          setRoute(external);
        }
        return data(item);
      }
      delete permissions[session];
      return send(204);
    }
    if (route === "form") {
      if (!id) return data(form?.sessionID === session ? [form] : []);
      if (form?.id !== id) return send(404, {});
      if (req.method === "GET") return data(form);
      serviceState.form = null;
      return send(204);
    }
    if (route === "inbox") return data(session === sid && !serviceState.hideInbox ? inbox : []);
    if (route === "prompt") {
      const entry = { ...value("admission"), id: body.id, sessionID: session, payload: { text: body.text } };
      if (!inbox.some(item => item.id === entry.id)) inbox.push(entry);
      if (serviceState.dropPromptResponse) return req.socket.destroy();
      return data(serviceState.hideInbox ? {} : entry);
    }
    if (route === "interrupt" && req.method === "POST") {
      delete active[session];
      return send(200, recorded.stop);
    }
    send(404, {});
  }).listen(0, "127.0.0.1");
  // Keep the fixture's verified socket open across the 5-second Active polls.
  native.keepAliveTimeout = 30_000;
  await once(native, "listening");
  fs.writeFileSync(path.join(state, "service.json"), JSON.stringify({ id: "fixture",
    url: `http://127.0.0.1:${native.address().port}`, pid: process.pid, version: "2.3.2",
    password: "synthetic-only" }), { mode: 0o600 });

  const probe = http.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(python, ["-m", "atlas.cli", "serve", "--port", String(port)], { stdio: "ignore",
    env: { ...process.env, HOME: root, ATLAS_HOME: atlas, ATLAS_OPENCODE_HOME: source,
      XDG_STATE_HOME: path.dirname(state), XDG_DATA_HOME: path.dirname(source), XDG_CONFIG_HOME: path.join(root, "config"),
      ATLAS_OPENCODE_BIN: "/usr/bin/false", ATLAS_PROJECTS_ROOT: path.join(root, "claude"),
      ATLAS_CLAUDE_SESSIONS: path.join(root, "claude-live"), ATLAS_CODEX_HOME: path.join(root, "codex"),
      ATLAS_CODEX_BIN: "", CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude-conf") } });
  return { base: `http://127.0.0.1:${port}`, sid, external, pty: pty.pid, serviceState, setRoute, async close() {
    clearInterval(heartbeat);
    const closed = once(server, "exit");
    server.kill();
    await closed;
    await new Promise(resolve => native.close(resolve));
    process.kill(pid, "SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test("OpenCode Active uses the managed service for tab-gated decisions, replies, stop and Move", async ({
  page, lang, t,
}) => {
  test.setTimeout(100_000);
  const world = await startWorld();
  const { base, sid, external, pty, serviceState: native } = world;
  try {
    await expect.poll(async () => {
      try { return (await (await fetch(base + "/api/active")).json()).sessions.filter(s => s.agent === "opencode").length; }
      catch { return 0; }
    }, { timeout: 20_000 }).toBe(2);
    const host = base + "/opencode-active.host";
    await page.route(host, route => route.fulfill({ contentType: "text/html", body: `
      <style>iframe{width:100%;height:95vh;border:0}</style>
      <iframe src="/?lang=${lang}#view=active"></iframe>
      <script>
        window.sent = [];
        window.tabSession = null;
        window.sendTabs = () => document.querySelector("iframe").contentWindow.postMessage({
          source:"session-atlas-host", type:"tabs", groups:true, tabs:[
            { agent:"opencode", ptyPid:${pty}, inline:true, sessionId:window.tabSession }]
        }, location.origin);
        window.addEventListener("message", e => {
          const d = e.data;
          if (d.source !== "session-atlas") return;
          window.sent.push(d);
          const send = reply => e.source.postMessage({source:"session-atlas-host", ...reply}, location.origin);
          if (d.type === "list-tabs") window.sendTabs();
          if (d.type === "resume") send({type:"launch-result", request:d.launchRequest, ok:true});
        });
      </script>` }));
    page.expectHttpError(/\/api\/opencode\/active\/permission$/);
    page.expectHttpError(/\/api\/opencode\/active\/reply$/);
    await page.goto(host);
    const frame = page.frameLocator("iframe");
    const card = frame.locator(`.acard[data-id="${sid}"]`);
    const outside = frame.locator(`.acard[data-id="${external}"]`);
    const refresh = () => frame.locator("body").evaluate(() => window.loadActive());
    const onceButton = card.getByRole("button", { name: /Allow once|Разрешить один раз/ });
    const reject = card.getByRole("button", { name: /Reject|Отклонить/ });
    await expect(card.getByRole("button", { name: /Move|Перенести/ })).toBeVisible();
    await expect(frame.locator(`.acard[data-id="opencode-tab-${pty}"]`)).toHaveCount(0);
    await page.evaluate(sid => { window.tabSession = sid; window.sendTabs(); }, sid);
    await expect(onceButton).toBeVisible();
    await expect(card.locator(".oc-permission-title")).toHaveText(
      (lang === "ru" ? "Запрос разрешения: " : "Permission request: ") + value("permission").action);
    await expect(card.locator(".oc-permission-title")).toBeVisible();
    await frame.getByRole("button", { name: t.detailed, exact: true }).click();
    await expect(card.locator(".stop")).toBeEnabled();
    await expect(card.locator('.card-view-picker option[value="terminal"]')).toBeEnabled();
    await frame.locator(".lay-btn").click();
    await frame.getByRole("button", { name: "2 × 4", exact: true }).click();
    await expect(card.locator(".decide")).toBeHidden();
    await expect(card.locator(".oc-permission-title")).toBeVisible();
    await frame.locator(".lay-btn").click();
    await frame.locator(".lay-foot button").click();
    await frame.locator('.mode button[data-mode="compact"]').click();
    await expect(outside.locator(".dialog button")).toHaveCount(0);
    await expect(outside.locator(".stop")).toHaveCount(0);
    await expect(outside.locator(".answer")).toHaveCount(0);
    await outside.getByRole("button", { name: /Move|Перенести/ }).click();
    await frame.locator("#m-ok").click();
    await expect.poll(() => page.evaluate(() => window.sent.find(d => d.type === "resume")?.session_id)).toBe(external);

    native.switchOnPermissionRead = true;
    const staleTarget = page.waitForResponse(r => r.url().endsWith("/api/opencode/active/permission"));
    await onceButton.click();
    const staleResponse = await staleTarget;
    expect(staleResponse.request().postDataJSON()).toHaveProperty("generation", "fixture");
    expect(await staleResponse.json()).toMatchObject({ state: "live_needs_tab" });
    expect(native.calls.filter(c => c.body?.decision)).toHaveLength(0);
    world.setRoute(sid);
    await refresh();
    await onceButton.click();
    await expect.poll(() => native.calls.filter(c => c.body?.decision).map(c => c.body.decision)).toEqual(["once"]);
    native.permissions[sid] = { ...value("permission"), id: "per_" + "b".repeat(26), sessionID: sid };
    await refresh();
    await expect(reject).toBeEnabled({ timeout: 12_000 });
    await reject.click();
    await expect.poll(() => native.calls.filter(c => c.body?.decision).map(c => c.body.decision)).toEqual(["once", "reject"]);

    const customOnly = { ...value("required").fields[1], key: "customOnly", options: [], minItems: 2 };
    native.form = { ...value("required"), sessionID: sid,
      fields: [...value("required").fields, value("form").fields[0], customOnly] };
    await refresh();
    const submit = card.getByRole("button", { name: /Submit answer|Отправить ответ/ });
    await expect(submit).toBeEnabled({ timeout: 12_000 });
    await submit.click();
    await expect(card.locator(".dialog .note")).toHaveText(/required fields|обязательные поля/);
    await card.locator("fieldset").nth(0).getByRole("radio", { name: "Blue" }).check();
    await card.getByRole("checkbox", { name: "Green" }).check();
    await card.locator("fieldset").nth(1).getByRole("textbox").fill("Custom green");
    const freeText = card.locator("fieldset").nth(2).getByRole("textbox");
    await freeText.fill("Custom blue");
    await freeText.evaluate(input => input.setSelectionRange(3, 6));
    await expect(outside.locator(".decide")).toBeVisible();
    delete native.permissions[external];
    await refresh();
    await expect(outside.locator(".decide")).toHaveCount(0, { timeout: 12000 });
    await expect(freeText).toBeFocused();
    await expect(freeText).toHaveValue("Custom blue");
    await expect(freeText).toHaveJSProperty("selectionStart", 3);
    await expect(freeText).toHaveJSProperty("selectionEnd", 6);
    world.setRoute(external);
    await refresh();
    await expect(submit).toHaveCount(0, { timeout: 12_000 });
    world.setRoute(sid);
    await refresh();
    await expect(freeText).toHaveValue("Custom blue", { timeout: 12_000 });
    await frame.getByRole("button", { name: t.detailed, exact: true }).click();
    native.unavailable = true;
    await refresh();
    await expect(card.locator(".state")).toHaveText(new RegExp(t.idle), { timeout: 12_000 });
    await expect(submit).toHaveCount(0);
    await expect(card.locator(".stop")).toHaveCount(0);
    const offlineReply = card.locator(".answer textarea");
    await expect(offlineReply).toBeDisabled();
    await expect(offlineReply).toHaveAttribute("placeholder", /stopped or unreachable|остановлен или недоступен/);
    await expect(card.locator(".answer .send")).toBeDisabled();
    native.unavailable = false;
    await refresh();
    await expect(freeText).toHaveValue("Custom blue", { timeout: 12_000 });
    await frame.locator('.mode button[data-mode="compact"]').click();
    const custom = card.locator("fieldset").nth(3);
    const add = custom.getByRole("button", { name: /Add answer|Добавить ответ/ });
    const remove = custom.getByRole("button", { name: /Remove answer|Удалить ответ/ });
    await custom.getByRole("textbox").fill("Drop this");
    await add.click();
    await custom.getByRole("textbox").nth(1).fill("One");
    await remove.first().click();
    await add.click();
    await custom.getByRole("textbox").nth(1).fill("Two");
    if (process.env.OPENCODE_B1_SHOTS) {
      await card.screenshot({ path: path.join(process.env.OPENCODE_B1_SHOTS, `opencode-b1-form-${lang}.png`) });
    }
    await submit.click();
    await expect.poll(() => native.calls.find(c => c.body?.answer)?.body.answer)
      .toEqual({ fixed: "blue", loose: ["green", "Custom green"], q0: "Custom blue", customOnly: ["One", "Two"] });

    native.form = { ...value("form"), sessionID: sid };
    await refresh();
    await card.getByRole("button", { name: /Dismiss|Закрыть вопрос/ }).click({ timeout: 12_000 });
    await expect.poll(() => native.calls.some(c => c.method === "DELETE" && c.parts[2] === "form")).toBe(true);

    native.permissions[sid] = { ...value("permission"), id: "per_" + "c".repeat(26), sessionID: sid };
    await refresh();
    await expect(onceButton).toBeEnabled({ timeout: 12_000 });
    delete native.permissions[sid];
    await onceButton.click();
    await expect(card.getByText(/Already answered or gone|Запрос уже обработан или исчез/)).toBeVisible();

    await frame.getByRole("button", { name: t.detailed, exact: true }).click();
    const reply = card.locator(".answer textarea");
    await expect(reply).toBeEnabled({ timeout: 12_000 });
    await expect(card.locator(".clip")).toHaveCount(0);
    await expect(card.locator(".tags .grp.add")).toHaveCount(1);
    await expect(card.locator(".tags > :first-child")).toHaveClass(/agent-badge/);
    native.hideInbox = true;
    await reply.fill("Fixture queued reply");
    await card.locator(".answer .send").click();
    await expect.poll(() => native.inbox[0]?.payload.text).toBe("Fixture queued reply");
    await expect(card.locator(".answer .note")).toHaveClass(/bad/);
    native.hideInbox = false;
    await page.reload();
    await page.evaluate(sid => { window.tabSession = sid; window.sendTabs(); }, sid);
    await frame.getByRole("button", { name: t.detailed, exact: true }).click();
    await expect(card.locator(".queued")).toContainText("Fixture queued reply", { timeout: 12000 });
    await expect(reply).toHaveValue("");
    expect(native.calls.filter(c => c.method === "POST" && c.parts[2] === "prompt")).toHaveLength(1);

    native.hideInbox = native.dropPromptResponse = true;
    const original = "Reply with lost acknowledgement";
    await reply.fill(original);
    await card.locator(".answer .send").click();
    await expect(card.locator(".answer .note")).toHaveClass(/bad/);
    await card.getByRole("button", { name: /Discard saved reply|Удалить сохранённый ответ/ }).click();
    await expect(frame.locator("#m-note")).toHaveText(/may already have been sent|мог уже отправиться/);
    await frame.locator("#modal").press("Escape");
    const retry = async () => {
      const body = frame.locator("body");
      await expect.poll(() => body.evaluate((_, id) => !openCodeReplying.has(id) && !openCodeReplyChecks.has(id), sid))
        .toBe(true);
      return body.evaluate((_, [session_id, text]) => sendOpenCodeReply({ session_id, opencode_generation: "fixture" }, text), [sid, original]);
    };
    world.setRoute(external);
    const refused = page.waitForResponse(response => response.url().endsWith("/api/opencode/active/reply")
      && response.status() === 409);
    await retry();
    expect((await (await refused).json()).state).toBe("live_needs_tab");
    world.setRoute(sid);
    await retry();
    const retries = native.calls.filter(call => call.parts[2] === "prompt" && call.body.text === original);
    expect(retries).toHaveLength(2);
    expect(retries[0].body.id).toEqual(retries[1].body.id);
    expect(native.inbox.filter(item => item.payload.text === original)).toHaveLength(1);
    native.hideInbox = native.dropPromptResponse = false;
    await refresh();
    await expect(reply).toHaveValue("", { timeout: 12_000 });

    await card.locator(".stop").click();
    await frame.locator("#m-ok").click();
    await expect.poll(() => native.calls.filter(c => c.method === "POST" && c.parts[2] === "interrupt")
      .map(c => c.parts[1])).toEqual([sid]);
    await refresh();
    await expect(card.locator(".state")).toHaveText(new RegExp(t.idle), { timeout: 12_000 });
    delete native.active[external];
    await refresh();
    await expect(outside).toHaveCount(0, { timeout: 12_000 });
  } finally {
    await world.close();
  }
});

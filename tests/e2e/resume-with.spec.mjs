// "Resume with…" on the Search card: a Claude Code session continues in Codex and a Codex session in
// Claude Code. The server writes the new session in the target agent's own format into the fixture
// homes; the stand-in plugin host records the launch; the copy shows in search, linked to its source.
// Every copy is deleted after its test: other specs count the catalog.
import fs from "node:fs";
import path from "node:path";

import { expect, ids, run, test } from "./fixtures.mjs";
import { PHRASES } from "./corpus.mjs";

const HOST = `${run.base}/e2e-resume-with-host.html`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const L = {
  en: { button: "Resume with…", own: "this session's agent — the ordinary resume", other: "a new session from this conversation",
        off: "Codex is turned off in the plugin settings (Settings → Agents)", title: a => `Resume in ${a}`,
        badge: a => `↪ from ${a}`, from: a => `Continued from the ${a} session`, to: "Continued in:",
        resume: "Resume session", note: "[Continued conversation]" },
  ru: { button: "Открыть с помощью…", own: "агент этой сессии — обычное восстановление", other: "новая сессия из этого разговора",
        off: "Codex выключен в настройках плагина (Настройки → Агенты)", title: a => `Продолжить в ${a}`,
        badge: a => `↪ из ${a}`, from: a => `Продолжение сессии ${a}`, to: "Продолжена в:",
        resume: "Восстановить сессию", note: "[Continued conversation]" },
};
const BOTH = { claude: true, codex: true };

/** shlex.quote, as atlas/actions.py builds the command. */
function quote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, `'"'"'`) + "'";
}

// What Obsidian's plugin answers: its agent switches; every message the page sends is kept.
function hostPage(src, agents) {
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="${src}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  if (d.type === "list-tabs") e.source.postMessage({ source: "session-atlas-host", type: "tabs", tabs: [],
                                                      health: { ok: true }, agents: ${JSON.stringify(agents)} }, "*");
});
</script></body></html>`;
}

async function openCard(page, lang, id, agents = BOTH) {
  await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8",
                                                 body: hostPage(`/?lang=${lang}#s=${id}`, agents) }));
  await page.goto(HOST);
  const frame = page.frameLocator("#atlas");
  await expect(frame.locator("#card h3")).toBeVisible();
  // The plugin's switches have arrived: the menu reads them.
  await expect.poll(() => page.evaluate(() => window.sent.some(m => m.type === "list-tabs"))).toBe(true);
  return frame;
}

const sentOf = (page, type) => page.evaluate(t => window.sent.filter(m => m.type === t), type);

/** Deletes the copy through the server, as the card's "Delete session…" does. "200" or the error. */
async function removeCopy(frame, id) {
  return frame.locator("body").evaluate(async (_, sid) => {
    const r = await fetch("/api/delete", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Atlas-Token": window.ATLAS_TOKEN },
      body: JSON.stringify({ session_id: sid, confirmed: true }) });
    return r.ok ? "200" : `${r.status} ${await r.text()}`;
  }, id);
}

function findRollout(id) {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  return walk(path.join(run.corpus.codexHome, "sessions")).filter(f => f.endsWith(`-${id}.jsonl`));
}

const records = file => fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));

/** Menu → the other agent → confirm. Returns the launch the host got. */
async function resumeWith(page, frame, lang, agentName) {
  await frame.locator("#rw-button").click();
  await expect(frame.locator("#rw-menu")).toBeVisible();
  await frame.locator("#rw-menu .rw-item", { hasText: agentName }).click();
  await expect(frame.locator("#m-title")).toHaveText(L[lang].title(agentName));
  const before = (await sentOf(page, "resume")).length;
  await frame.locator("#m-ok").click();
  await expect.poll(async () => (await sentOf(page, "resume")).length).toBe(before + 1);
  await expect(frame.locator("#modal")).toBeHidden();         // handed to Obsidian: nothing left to close
  return (await sentOf(page, "resume")).at(-1);
}

/** The copy in the list with its badge; its card links back to the source and the source to it. */
async function expectLinked(frame, lang, copy, source, sourceAgent, copyAgent) {
  const row = frame.locator(`#list .row[data-id="${copy}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.locator(".pill.conv")).toHaveText(L[lang].badge(sourceAgent));
  await row.click();
  await expect(frame.locator("#card .lineage")).toContainText(L[lang].from(sourceAgent));
  await expect(frame.locator("#card .sub .agent-badge")).toHaveText(copyAgent);
  await frame.locator("#card .lineage button").click();
  await expect(frame.locator("#card .lineage")).toContainText(L[lang].to);
  await expect(frame.locator("#card .lineage button", { hasText: copyAgent })).toBeVisible();
  expect(await frame.locator("#list").evaluate(() => location.hash)).toContain(source);
}

test("a Claude Code session continues in Codex as a new Codex thread", async ({ page, lang }) => {
  const frame = await openCard(page, lang, ids.claudeMain);
  await frame.locator("#rw-button").click();
  const items = frame.locator("#rw-menu .rw-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Claude Code" + L[lang].own);
  await expect(items.nth(1)).toContainText("Codex" + L[lang].other);
  await frame.locator("#rw-button").click();                             // toggles closed
  await expect(frame.locator("#rw-menu")).toBeHidden();

  const sent = await resumeWith(page, frame, lang, "Codex");
  const cwd = run.corpus.cwds.demo;
  expect(sent.session_id).toMatch(UUID);
  expect(sent.session_id[14]).toBe("7");                                 // a v7 id, as Codex makes them
  expect(sent).toMatchObject({ cwd, command: `cd ${quote(cwd)} && codex resume ${sent.session_id}` });
  let removed;
  try {
    const [file] = findRollout(sent.session_id);
    expect(file, "the rollout in the fixture Codex home").toBeTruthy();
    const recs = records(file);
    expect(recs[0]).toMatchObject({ type: "session_meta", payload: { id: sent.session_id, cwd, source: "cli",
                                                                      originator: "session-atlas" } });
    expect(recs[0].payload.cli_version).toBeTruthy();
    expect(recs[0].payload.model_provider).toBeTruthy();
    const first = recs.find(r => r.payload.type === "user_message").payload.message;
    expect(first.startsWith(L[lang].note)).toBe(true);
    expect(first).toContain(ids.claudeMain);
    expect(first).toContain("raising the retry count");                  // the compaction summary
    const text = JSON.stringify(recs);
    expect(text).toContain(PHRASES.claudeOnly);                           // a prompt after the compaction
    expect(text).not.toContain("Fix the flaky login test");               // before it: not copied
    await expectLinked(frame, lang, sent.session_id, ids.claudeMain, "Claude Code", "Codex");
  } finally {
    removed = await removeCopy(frame, sent.session_id);
  }
  expect(removed).toBe("200");
  expect(findRollout(sent.session_id)).toHaveLength(0);
});

test("a Codex session continues in Claude Code as a new transcript", async ({ page, lang }) => {
  const frame = await openCard(page, lang, ids.codexLedger);
  const sent = await resumeWith(page, frame, lang, "Claude Code");
  const cwd = run.corpus.cwds.billing;
  expect(sent.session_id).toMatch(UUID);
  expect(sent).toMatchObject({ cwd, command: `cd ${quote(cwd)} && claude --resume ${sent.session_id}` });
  const file = path.join(run.corpus.projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), sent.session_id + ".jsonl");
  let removed;
  try {
    expect(fs.existsSync(file), file).toBe(true);
    const chain = records(file).filter(r => r.type === "user" || r.type === "assistant");
    expect(chain[0]).toMatchObject({ parentUuid: null, sessionId: sent.session_id, cwd, type: "user" });
    chain.slice(1).forEach((r, i) => expect(r.parentUuid).toBe(chain[i].uuid));
    expect(chain[0].message.content.startsWith(L[lang].note)).toBe(true);
    expect(JSON.stringify(chain)).toContain(PHRASES.codexOnly);
    await expectLinked(frame, lang, sent.session_id, ids.codexLedger, "Codex", "Claude Code");
  } finally {
    removed = await removeCopy(frame, sent.session_id);
  }
  expect(removed).toBe("200");
  expect(fs.existsSync(file)).toBe(false);
});

test("an agent the plugin has off is disabled with a hint; the own agent is the ordinary resume",
  async ({ page, lang }) => {
    const frame = await openCard(page, lang, ids.claudeMain, { claude: true, codex: false });
    await frame.locator("#rw-button").click();
    const codex = frame.locator('#rw-menu .rw-item[data-agent="codex"]');
    await expect(codex).toBeDisabled();
    await expect(codex).toContainText(L[lang].off);
    await expect(codex).toHaveAttribute("title", L[lang].off);
    await frame.locator('#rw-menu .rw-item[data-agent="claude"]').click();
    await expect(frame.locator("#m-title")).toHaveText(L[lang].resume);
    await expect(frame.locator("#m-body")).toHaveText(`cd ${run.corpus.cwds.demo} && claude --resume ${ids.claudeMain}`);
    await frame.locator("#m-close").click();
    expect(await sentOf(page, "resume")).toHaveLength(0);
  });

test("Resume: the tab opens and the dialog closes by itself", async ({ page, lang }) => {
  const frame = await openCard(page, lang, ids.claudeMain);
  await frame.locator("#bar button.primary").first().click();
  await expect(frame.locator("#m-title")).toHaveText(L[lang].resume);
  await frame.locator("#m-ok").click();
  await expect.poll(async () => (await sentOf(page, "resume")).length).toBe(1);
  expect((await sentOf(page, "resume"))[0].command).toBe(`cd ${run.corpus.cwds.demo} && claude --resume ${ids.claudeMain}`);
  await expect(frame.locator("#modal")).toBeHidden();
});

test("the menu works from the keyboard", async ({ page, lang }) => {
  const frame = await openCard(page, lang, ids.claudeMain);
  const btn = frame.locator("#rw-button");
  const item = agent => frame.locator(`#rw-menu .rw-item[data-agent="${agent}"]`);
  await btn.focus();
  await page.keyboard.press("ArrowDown");
  await expect(frame.locator("#rw-menu")).toBeVisible();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(item("claude")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item("codex")).toBeFocused();
  await page.keyboard.press("ArrowDown");                                 // wraps around
  await expect(item("claude")).toBeFocused();
  await page.keyboard.press("End");
  await expect(item("codex")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(frame.locator("#rw-menu")).toBeHidden();
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");                                     // Enter opens it on the first item
  await expect(item("claude")).toBeFocused();
  await page.keyboard.press("Enter");                                     // the own agent: ordinary resume
  await expect(frame.locator("#m-title")).toHaveText(L[lang].resume);
  await frame.locator("#m-close").click();

  // With Codex off the arrows skip it.
  const off = await openCard(page, lang, ids.claudeMain, { claude: true, codex: false });
  await off.locator("#rw-button").focus();
  await page.keyboard.press("ArrowDown");
  await expect(off.locator('#rw-menu .rw-item[data-agent="claude"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(off.locator('#rw-menu .rw-item[data-agent="claude"]')).toBeFocused();
});

test("outside Obsidian: the copy is created and its command is shown", async ({ page, open, lang }) => {
  await open("search", `s=${ids.claudeBilling}`);
  await page.locator("#rw-button").click();
  await page.locator('#rw-menu .rw-item[data-agent="codex"]').click();
  await page.locator("#m-ok").click();
  await expect(page.locator("#m-body")).toHaveText(/ && codex resume [0-9a-f-]{36}$/);
  await expect(page.locator("#m-ok")).toBeHidden();
  const id = (await page.locator("#m-body").textContent()).trim().split(" ").at(-1);
  try {
    expect(findRollout(id)).toHaveLength(1);
    await expect(page.locator(`#list .row[data-id="${id}"] .pill.conv`)).toHaveText(L[lang].badge("Claude Code"),
                                                                                 { timeout: 10000 });
  } finally {
    const status = await page.evaluate(async sid => (await fetch("/api/delete", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Atlas-Token": window.ATLAS_TOKEN },
      body: JSON.stringify({ session_id: sid, confirmed: true }) })).status, id);
    expect(status).toBe(200);
  }
});

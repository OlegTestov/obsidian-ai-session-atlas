// Starting sessions from the catalog: "+ Session" with an agent choice and "New from this one".
// The page runs in a frame of a stand-in host, which records what the plugin would receive.
import fs from "node:fs";
import path from "node:path";

import { expect, ids, run, test } from "./fixtures.mjs";
import { ago, writeRollout } from "./corpus.mjs";
import { codex } from "./records.mjs";

const HOST = `${run.base}/e2e-launch-host.html`;
const CONFIG = path.join(run.corpus.atlasHome, "config.json");
const FAKE_BIN = path.join(run.root, "fake-claude", "claude");
const FAKE_CALLS = path.join(run.root, "fake-claude", "calls.log");
// The thread Codex would start from the handoff, one per page language.
const NEW_THREAD = { en: "0199a1b2-c3d4-7e5f-8a6b-0000000000a1", ru: "0199a1b2-c3d4-7e5f-8a6b-0000000000a2" };
const CODEX_HANDOFF = /launch-[0-9A-Za-z-]{1,8}-[0-9a-f]{12}\.md$/;
const LABEL = { en: { newFrom: "New from this one" }, ru: { newFrom: "Новая на основе этой" } };

/** shlex.quote, as atlas/actions.py builds the command. */
function quote(s) {
  if (s && /^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

/** The words of a `cd <dir> && <agent> …` command, unquoted as the shell would. */
function words(command) {
  const out = [];
  let cur = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      cur = (cur || "") + command.slice(i + 1, end);
      i = end;
    } else if (c === " ") {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur || "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// What Obsidian's plugin answers. `agents` is the plugin's agent switch; left out, the reply is
// that of a plugin without Codex launches.
function hostPage(src, agents) {
  const tabs = [{ ptyPid: run.pids.claude.shell, title: "claude tab" },
                { ptyPid: run.pids.codex.shell, title: "codex tab", agent: "codex", screen: null }];
  const extra = agents ? { agents } : {};
  return `<!doctype html><html><head><title>host</title></head><body style="margin:0">
<iframe id="atlas" src="${src}" style="width:100vw;height:100vh;border:0"></iframe>
<script>
window.sent = [];
const tabs = ${JSON.stringify(tabs)};
const extra = ${JSON.stringify(extra)};
window.addEventListener("message", e => {
  const d = e.data;
  if (!d || d.source !== "session-atlas") return;
  window.sent.push(d);
  const reply = m => e.source.postMessage(Object.assign({ source: "session-atlas-host" }, m), "*");
  if (d.type === "list-tabs") reply(Object.assign({ type: "tabs", tabs, health: { ok: true } }, extra));
  if (d.type === "send-text") reply({ type: "sent", nonce: d.nonce, ok: true });
});
</script></body></html>`;
}

async function openHost(page, lang, hash, agents) {
  await page.route(HOST, route => route.fulfill({ contentType: "text/html; charset=utf-8",
                                                 body: hostPage(`/?lang=${lang}#${hash}`, agents) }));
  await page.goto(HOST);
  return page.frameLocator("#atlas");
}

const sentOf = (page, type) => page.evaluate(t => window.sent.filter(m => m.type === t), type);

/** Wait until the page has the host's tabs reply: the agent choice depends on it. */
async function hostAnswered(page, frame) {
  await expect.poll(async () => (await sentOf(page, "list-tabs")).length).toBeGreaterThan(0);
  await expect(frame.locator(`.acard[data-id="${ids.codexLive}"] .answer textarea`)).toBeEnabled();
}

// --- "+ Session" ----------------------------------------------------------------------------

test.describe("+ Session", () => {
  const BOTH = { claude: true, codex: true };

  async function newSession(page, frame, { agent, prompt, cwd = run.corpus.cwds.billing }) {
    await frame.locator("#active-filters .newsess").click();
    await expect(frame.locator("#newsess")).toBeVisible();
    await frame.locator("#ns-dir").fill(cwd);
    if (agent) await frame.locator("#ns-agent").selectOption(agent);
    await frame.locator("#ns-prompt").fill(prompt);
    const req = page.waitForRequest(r => r.url().endsWith("/api/new-session"));
    const before = (await sentOf(page, "new-session")).length;
    await frame.locator("#ns-go").click();
    const body = (await req).postDataJSON();
    await expect.poll(async () => (await sentOf(page, "new-session")).length).toBe(before + 1);
    await expect(frame.locator("#newsess")).toBeHidden();
    return { body, sent: (await sentOf(page, "new-session")).at(-1) };
  }

  test("the host reports Codex: the agent choice, a codex command, the choice kept", async ({ page, lang }) => {
    const frame = await openHost(page, lang, "view=active&am=full", BOTH);
    await hostAnswered(page, frame);
    await frame.locator("#active-filters .newsess").click();
    await expect(frame.locator("#ns-agent-row")).toBeVisible();
    await expect(frame.locator("#ns-agent option")).toHaveText(["Claude Code", "Codex"]);
    await expect(frame.locator("#ns-agent")).toHaveValue("claude");
    await frame.locator("#ns-close").click();

    const cwd = run.corpus.cwds.billing;
    const { body, sent } = await newSession(page, frame, { agent: "codex", prompt: "fix the rounding drift" });
    expect(body).toEqual({ cwd, prompt: "fix the rounding drift", agent: "codex" });
    expect(sent).toMatchObject({ session_id: null, cwd,
                                 command: `cd ${quote(cwd)} && codex 'fix the rounding drift'` });

    // The choice survives a reload of the whole host.
    await page.reload();
    await hostAnswered(page, frame);
    await frame.locator("#active-filters .newsess").click();
    await expect(frame.locator("#ns-agent")).toHaveValue("codex");
  });

  test("a flag-like or one-word first prompt reaches codex as a prompt", async ({ page, lang }) => {
    const frame = await openHost(page, lang, "view=active&am=full", BOTH);
    await hostAnswered(page, frame);
    const cwd = run.corpus.cwds.billing;
    for (const [prompt, arg] of [["-x", "' -x'"], ["resume", "' resume'"]]) {
      const { body, sent } = await newSession(page, frame, { agent: "codex", prompt });
      expect(body.agent).toBe("codex");
      expect(sent.command).toBe(`cd ${quote(cwd)} && codex ${arg}`);
      expect(words(sent.command).slice(3)).toEqual(["codex", " " + prompt]);
    }
  });

  test("the host reports Claude Code only: no agent choice, a claude command", async ({ page, lang }) => {
    // Codex remembered from an earlier pick, but the plugin has it off now.
    await page.addInitScript(() => window.localStorage.setItem("atlas.newSessionAgent", "codex"));
    const frame = await openHost(page, lang, "view=active&am=full", { claude: true, codex: false });
    await hostAnswered(page, frame);
    await frame.locator("#active-filters .newsess").click();
    await expect(frame.locator("#ns-agent-row")).toBeHidden();
    await frame.locator("#ns-close").click();
    const cwd = run.corpus.cwds.billing;
    const { body, sent } = await newSession(page, frame, { prompt: "resume" });
    expect(body.agent).toBe("claude");
    expect(sent.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.command).toBe(`cd ${quote(cwd)} && claude --session-id ${sent.session_id} ' resume'`);
  });

  test("a plugin without the agents field: no agent choice", async ({ page, lang }) => {
    const frame = await openHost(page, lang, "view=active&am=full");
    await hostAnswered(page, frame);
    await frame.locator("#active-filters .newsess").click();
    await expect(frame.locator("#ns-agent-row")).toBeHidden();
  });
});

// --- "New from this one" --------------------------------------------------------------------

// The handoff is an AI artifact: the button exists only with AI features on, and the server calls
// `claude -p`. A stand-in `claude` set as claude_bin answers with a valid handoff; no model is called.
const HANDOFF_TEXT = ["## Goal", "Keep the ledger totals stable.", "## Current state", "Rounding fixed.",
  "## Decisions made", "Round at the end.", "## Files changed", "billing/ledger.py",
  "## Checks and their results", "pytest passes.", "## Unfinished", "Nothing.",
  "## Risks and gotchas", "None known.", "## Next concrete step", "Add a test for negative totals.",
  "## Цель", "## Текущее состояние", "## Следующий конкретный шаг"].join("\n");

test.describe("New from this one", () => {
  let original;

  test.beforeEach(async () => {
    fs.mkdirSync(path.dirname(FAKE_BIN), { recursive: true });
    fs.writeFileSync(FAKE_BIN, `#!/bin/sh\necho "$*" >> ${quote(FAKE_CALLS)}\ncat > /dev/null\n`
      + `cat <<'EOF'\n${HANDOFF_TEXT}\nEOF\n`, { mode: 0o755 });
    original = fs.readFileSync(CONFIG, "utf8");
    fs.writeFileSync(CONFIG, JSON.stringify({ ...JSON.parse(original), llm_enabled: true, claude_bin: FAKE_BIN }));
    await expect.poll(async () => (await (await fetch(run.base + "/api/facets")).json()).llm_enabled).toBe(true);
  });

  test.afterEach(async () => {
    fs.writeFileSync(CONFIG, original);
    await expect.poll(async () => (await (await fetch(run.base + "/api/facets")).json()).llm_enabled).toBe(false);
  });

  const modelCalls = () =>
    fs.existsSync(FAKE_CALLS) ? fs.readFileSync(FAKE_CALLS, "utf8").split("\n").filter(Boolean).length : 0;

  /** Card → preview → confirm → the stand-in model → the launch dialog → open as a tab. */
  async function newFromThisOne(page, lang, sessionId) {
    const frame = await openHost(page, lang, `s=${sessionId}`, { claude: true, codex: true });
    const calls = modelCalls();
    await frame.locator("#bar button", { hasText: LABEL[lang].newFrom }).click();
    await expect(frame.locator("#modal")).toBeVisible();
    const launched = page.waitForResponse(r => r.url().endsWith("/api/launch"), { timeout: 20000 });
    await frame.locator("#m-ok").click();                       // confirm sending to the model
    const launch = await (await launched).json();
    expect(modelCalls()).toBe(calls + 1);
    await expect(frame.locator("#m-body")).toHaveText(launch.command);
    await frame.locator("#m-ok").click();                       // open as a tab
    await expect.poll(async () => (await sentOf(page, "new-session")).length).toBe(1);
    await expect(frame.locator("#modal")).toBeHidden();         // handed to Obsidian: the dialog closes
    return { frame, launch, sent: (await sentOf(page, "new-session"))[0] };
  }

  const card = async id => (await (await fetch(`${run.base}/api/session/${id}`)).json()).actions.lineage;

  test("a Codex session continues in codex, and the new thread is linked to it", async ({ page, lang }) => {
    const source = ids.codexLedger;
    const cwd = run.corpus.cwds.billing;
    const { frame, launch, sent } = await newFromThisOne(page, lang, source);
    expect(launch).toMatchObject({ agent: "codex", new_session_id: null, cwd });
    const handoff = launch.handoff_path;
    expect(path.basename(handoff)).toMatch(CODEX_HANDOFF);
    expect(fs.readFileSync(handoff, "utf8")).toBe(HANDOFF_TEXT);
    const prompt = `Read ${handoff} and continue the work from where it stopped.`;
    expect(sent).toMatchObject({ session_id: null, cwd, command: `cd ${quote(cwd)} && codex ${quote(prompt)}` });
    expect(words(sent.command)).toEqual(["cd", cwd, "&&", "codex", prompt]);
    // Waiting: the launch is known, the thread is not.
    const pending = (await card(source)).derived.filter(d => !d.confirmed_at);
    expect(pending).toHaveLength(1);

    // Codex starts the thread: its first prompt names the handoff file.
    const thread = NEW_THREAD[lang];
    const now = Date.now();
    const at = m => ago(now, 0, m);
    writeRollout(run.corpus.codexHome, thread, at(0), [
      codex.meta(thread, at(0), cwd), codex.context(at(0), cwd), codex.started(at(0)),
      codex.user(at(0), prompt), codex.agent(at(0), "Reading the handoff."),
    ]);
    const reindex = await frame.locator("body").evaluate(async () => (await fetch("/api/reindex", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Atlas-Token": window.ATLAS_TOKEN },
      body: "{}" })).status);
    expect(reindex).toBe(200);

    const lineage = await card(source);
    const link = lineage.derived.find(d => d.new_session_id === thread);
    expect(link?.confirmed_at).toBeTruthy();
    expect(lineage.derived.filter(d => !d.confirmed_at)).toHaveLength(0);   // the placeholder took the id
    expect((await card(thread)).derived_from).toMatchObject({ source_session_id: source, handoff_path: handoff });
  });

  test("a Claude Code session still continues with claude --session-id", async ({ page, lang }) => {
    const source = ids.claudeBilling;
    const cwd = run.corpus.cwds.billing;
    const { launch, sent } = await newFromThisOne(page, lang, source);
    expect(launch).toMatchObject({ agent: "claude", cwd });
    const newId = launch.new_session_id;
    expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(path.basename(launch.handoff_path)).toBe(`launch-${source.slice(0, 8)}.md`);
    const prompt = `Read ${launch.handoff_path} and continue the work from where it stopped.`;
    expect(sent).toMatchObject({ session_id: newId, cwd,
                                 command: `cd ${quote(cwd)} && claude --session-id ${newId} ${quote(prompt)}` });
    expect((await card(source)).derived.map(d => d.new_session_id)).toContain(newId);
  });
});

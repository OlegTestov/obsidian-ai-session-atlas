// Made-up fixture corpus for the browser tests: Claude Code projects and a Codex home in a temp dir.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { claude, codex, line } from "./records.mjs";

const HOUR = 3600e3;

/** ISO time `hours` ago plus `minutes`, in UTC with milliseconds, as both agents write it. */
export function ago(now, hours, minutes = 0) {
  return new Date(now - hours * HOUR + minutes * 60e3).toISOString();
}

// --- the corpus ------------------------------------------------------------------------------

/** Fixed ids: the specs address cards by them. */
export const IDS = {
  claudeMain: "11111111-1111-4111-8111-000000000001",
  claudeBilling: "11111111-1111-4111-8111-000000000002",
  claudeHeadless: "11111111-1111-4111-8111-000000000003",
  claudeRenameEn: "11111111-1111-4111-8111-000000000004",
  claudeRenameRu: "11111111-1111-4111-8111-000000000005",
  claudeLive: "11111111-1111-4111-8111-000000000006",
  codexLedger: "0199a1b2-c3d4-7e5f-8a6b-000000000001",
  codexExec: "0199a1b2-c3d4-7e5f-8a6b-000000000002",
  codexFork: "0199a1b2-c3d4-7e5f-8a6b-000000000003",
  codexRenameEn: "0199a1b2-c3d4-7e5f-8a6b-000000000004",
  codexRenameRu: "0199a1b2-c3d4-7e5f-8a6b-000000000005",
  codexDeleteEn: "0199a1b2-c3d4-7e5f-8a6b-000000000006",
  codexDeleteRu: "0199a1b2-c3d4-7e5f-8a6b-000000000007",
  codexLive: "0199a1b2-c3d4-7e5f-8a6b-000000000008",
};

export const PHRASES = {
  codexOnly: "quartz flamingo ledger",
  claudeOnly: "obsidian marmalade turbine",
  codexTitle: "Refactor the billing ledger",
  codexLiveReply: "Ledger totals now reconcile with the invoices",
  claudeLiveReply: "The login retry now backs off exponentially",
};

// The 5-hour and weekly windows Codex reports in token_count, as on a paid plan.
export const CODEX_LIMITS = { primary: 42, secondary: 17 };

function writeClaude(root, cwd, sid, lines) {
  const folder = path.join(root, cwd.replace(/[/.]/g, "-"));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, sid + ".jsonl");
  fs.writeFileSync(file, lines.join(""));
  return file;
}

export function writeRollout(home, sid, startIso, lines) {
  const d = new Date(startIso);
  const ymd = [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"),
               String(d.getUTCDate()).padStart(2, "0")];
  const folder = path.join(home, "sessions", ...ymd);
  fs.mkdirSync(folder, { recursive: true });
  const stamp = startIso.slice(0, 19).replace(/:/g, "-");
  const file = path.join(folder, `rollout-${stamp}-${sid}.jsonl`);
  fs.writeFileSync(file, lines.join(""));
  return file;
}

/**
 * Write the corpus under `root`. Returns paths and the facts the specs assert on.
 * `python` writes Codex's state database (sqlite3 from the standard library).
 */
export function writeCorpus(root, python, now = Date.now()) {
  const home = path.join(root, "home");
  const claudeDir = path.join(root, "claude");
  const projects = path.join(claudeDir, "projects");
  const codexHome = path.join(root, "codex");
  const atlasHome = path.join(root, "atlas");
  const cwds = { demo: path.join(home, "Code", "atlas-demo"), billing: path.join(home, "Code", "billing-api"),
                 ops: path.join(home, "Code", "ops-scripts") };
  // A vault no session ran in: the "+ Session" folder field offers it and its notes folders.
  const vault = path.join(home, "Notes");
  const vaultDirs = ["Projects/Atlas", "Daily", ".trash"].map(d => path.join(vault, d));
  for (const dir of [projects, codexHome, atlasHome, path.join(claudeDir, "sessions"), ...Object.values(cwds),
                     ...vaultDirs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(vault, "Inbox.md"), "a note, not a folder\n");
  fs.writeFileSync(path.join(atlasHome, "config.json"), JSON.stringify({
    language: "en", ticket_prefixes: ["ABC"], llm_enabled: false,
    workspace_roots: ["~/Code"], vaults: [{ path: "~/Notes", id: "notes" }] }));

  // Claude Code's limits as its status line saved them, 3 hours ago: the toolbar shows their age.
  fs.writeFileSync(path.join(atlasHome, "rate-limits.json"), JSON.stringify({
    captured_at: now / 1000 - 3 * 3600 - 300,
    rate_limits: { five_hour: { used_percentage: 41.6, resets_at: now / 1000 + 3600 },
                   seven_day: { used_percentage: 87.2, resets_at: now / 1000 + 4 * 86400 } } }));

  const files = {};
  const at = (h, m) => ago(now, h, m);

  // Claude Code: a working session with edits, a ticket, a compaction and a unique phrase.
  let ctx = { cwd: cwds.demo, sid: IDS.claudeMain };
  files.claudeMain = writeClaude(projects, cwds.demo, ctx.sid, [
    claude.user(ctx, at(26), "Fix the flaky login test for ABC-12"),
    claude.reply(ctx, at(26, 1), "Looking at the login test first."),
    claude.tool(ctx, at(26, 2), "Edit", { file_path: path.join(cwds.demo, "src", "login.py"),
                                         old_string: "retry = 1", new_string: "retry = 3" }),
    claude.tool(ctx, at(26, 3), "Bash", { command: "pytest -q tests/test_login.py" }),
    claude.reply(ctx, at(26, 4), "The test passes ten runs in a row now."),
    claude.compaction(ctx, at(26, 10), "Summary: the login test was fixed by raising the retry count."),
    claude.user(ctx, at(26, 11), `Now document the ${PHRASES.claudeOnly} in the README`),
    claude.tool(ctx, at(26, 12), "Write", { file_path: path.join(cwds.demo, "README.md"), content: "docs" }),
    claude.reply(ctx, at(26, 13), "Documented in README.md."),
    claude.snapshot(ctx, at(26, 13), [path.join(cwds.demo, "src", "login.py"), path.join(cwds.demo, "README.md")]),
  ]);
  ctx = { cwd: cwds.billing, sid: IDS.claudeBilling };
  files.claudeBilling = writeClaude(projects, cwds.billing, ctx.sid, [
    claude.user(ctx, at(50), "Add a currency column to the invoices export"),
    claude.reply(ctx, at(50, 2), "Added the column and a migration.", [3000, 900]),
  ]);
  // A headless SDK run (hooks, nightly agents): automation, hidden by default.
  ctx = { cwd: cwds.ops, sid: IDS.claudeHeadless, entrypoint: "sdk-cli" };
  files.claudeHeadless = writeClaude(projects, cwds.ops, ctx.sid, [
    claude.user(ctx, at(30), "Nightly: rotate the ops logs"),
    claude.reply(ctx, at(30, 1), "Rotated 4 log files."),
  ]);
  for (const [key, sid, lang] of [["claudeRenameEn", IDS.claudeRenameEn, "en"],
                                  ["claudeRenameRu", IDS.claudeRenameRu, "ru"]]) {
    ctx = { cwd: cwds.demo, sid };
    files[key] = writeClaude(projects, cwds.demo, sid, [
      claude.user(ctx, at(40), `Claude rename target ${lang}: tidy the changelog`),
      claude.reply(ctx, at(40, 1), "Tidied."),
    ]);
  }
  // The live Claude session: its process is started by the global setup.
  ctx = { cwd: cwds.demo, sid: IDS.claudeLive };
  files.claudeLive = writeClaude(projects, cwds.demo, ctx.sid, [
    claude.user(ctx, at(0, -30), "Make the login retry back off"),
    claude.reply(ctx, at(0, -29), "Changing the retry loop."),
    claude.tool(ctx, at(0, -28), "Edit", { file_path: path.join(cwds.demo, "src", "retry.py"),
                                          old_string: "sleep(1)", new_string: "sleep(2 ** n)" }),
    claude.user(ctx, at(0, -10), "Does it cap the delay?"),
    claude.reply(ctx, at(0, -9), PHRASES.claudeLiveReply + ", capped at 30 seconds."),
  ]);

  // Codex: an interactive thread with a title in the state database, patches and commands.
  const limits = (pct5, pctWeek) => ({
    primary: { used_percent: pct5, window_minutes: 300, resets_at: Math.round(now / 1000) + 3 * 3600 },
    secondary: { used_percent: pctWeek, window_minutes: 10080, resets_at: Math.round(now / 1000) + 4 * 86400 },
  });
  let start = at(28);
  const ledgerHistory = [
    codex.user(at(28, 1), `Find why the ${PHRASES.codexOnly} totals drift`),
    codex.reasoning(at(28, 1)),
    codex.exec(at(28, 2), "c1", "rg -n total billing/", cwds.billing, 0),
    codex.patch(at(28, 3), "p1", { [path.join(cwds.billing, "billing", "ledger.py")]:
      { type: "update", unified_diff: "@@ -1,2 +1,2 @@\n-total = sum(a)\n+total = round(sum(a), 2)\n" } }),
    codex.agent(at(28, 4), "Rounding fixed in ledger.py."),
    codex.tokens(at(28, 4), 20000, 12000, 1500, [20000, 12000, 1500], limits(30, 10)),
    codex.complete(at(28, 4), "Rounding fixed in ledger.py."),
  ];
  files.codexLedger = writeRollout(codexHome, IDS.codexLedger, start, [
    codex.meta(IDS.codexLedger, start, cwds.billing),
    codex.context(at(28, 0), cwds.billing),
    codex.started(at(28, 0)),
    ...ledgerHistory,
  ]);
  // A fork: its own meta first, the parent's meta and replayed history after it, then a new prompt.
  start = at(27);
  files.codexFork = writeRollout(codexHome, IDS.codexFork, start, [
    codex.meta(IDS.codexFork, start, cwds.billing, { forkedFrom: IDS.codexLedger }),
    codex.meta(IDS.codexLedger, at(28), cwds.billing),
    codex.context(at(27, 0), cwds.billing),
    ...ledgerHistory,
    codex.started(at(27, 1)),
    codex.user(at(27, 1), "Fork: also add a test for the rounding"),
    codex.patch(at(27, 2), "p2", { [path.join(cwds.billing, "tests", "test_ledger.py")]:
      { type: "add", content: "def test_round():\n    assert True\n" } }),
    codex.agent(at(27, 3), "Added tests/test_ledger.py."),
    codex.tokens(at(27, 3), 9000, 6000, 700, [29000, 18000, 2200], limits(31, 11)),
    codex.complete(at(27, 3), "Added tests/test_ledger.py."),
  ]);
  // `codex exec`: automation, like a headless Claude run.
  start = at(20);
  files.codexExec = writeRollout(codexHome, IDS.codexExec, start, [
    codex.meta(IDS.codexExec, start, cwds.ops, { originator: "codex_exec", source: "exec" }),
    codex.context(at(20, 0), cwds.ops),
    codex.started(at(20, 0)),
    codex.user(at(20, 0), "Summarize the nightly ops log"),
    codex.exec(at(20, 1), "c1", "tail -n 50 ops.log", cwds.ops, 0),
    codex.agent(at(20, 2), "Nothing unusual in the nightly log."),
    codex.tokens(at(20, 2), 50000, 10000, 4000, [50000, 10000, 4000], limits(33, 12)),
    codex.complete(at(20, 2), "Nothing unusual in the nightly log."),
  ]);
  const simple = (key, sid, hours, prompt) => {
    const s = at(hours);
    files[key] = writeRollout(codexHome, sid, s, [
      codex.meta(sid, s, cwds.billing), codex.context(at(hours, 0), cwds.billing), codex.started(at(hours, 0)),
      codex.user(at(hours, 1), prompt), codex.agent(at(hours, 2), "Done."),
      codex.tokens(at(hours, 2), 3000, 1000, 200, [3000, 1000, 200]),
      codex.complete(at(hours, 2), "Done."),
    ]);
  };
  simple("codexRenameEn", IDS.codexRenameEn, 44, "Codex rename target en: bump the SDK");
  simple("codexRenameRu", IDS.codexRenameRu, 45, "Codex rename target ru: bump the SDK");
  simple("codexDeleteEn", IDS.codexDeleteEn, 46, "Codex delete target en: scratch experiment");
  simple("codexDeleteRu", IDS.codexDeleteRu, 47, "Codex delete target ru: scratch experiment");

  // The live Codex thread: one finished turn, one still running with a failed command.
  start = at(0, -40);
  files.codexLive = writeRollout(codexHome, IDS.codexLive, start, [
    codex.meta(IDS.codexLive, start, cwds.billing),
    codex.context(at(0, -40), cwds.billing),
    codex.started(at(0, -40)),
    codex.user(at(0, -39), "Reconcile the ledger with the invoices"),
    codex.exec(at(0, -38), "c1", "python3 scripts/reconcile.py", cwds.billing, 0),
    codex.patch(at(0, -37), "p1", { [path.join(cwds.billing, "billing", "reconcile.py")]:
      { type: "update", unified_diff: "@@ -1 +1,2 @@\n-x = 1\n+x = 2\n+y = 3\n" } }),
    codex.agent(at(0, -36), PHRASES.codexLiveReply + "."),
    codex.tokens(at(0, -36), 40000, 30000, 2500, [40000, 30000, 2500],
                 limits(CODEX_LIMITS.primary - 2, CODEX_LIMITS.secondary)),
    codex.complete(at(0, -36), PHRASES.codexLiveReply + "."),
    codex.started(at(0, -5)),
    codex.user(at(0, -5), "Run the full test suite"),
    codex.execEnd(at(0, -4), "c2", "pytest -q", cwds.billing, 1, "FAILED tests/test_ledger.py::test_total"),
    codex.tokens(at(0, -4), 45000, 38000, 800, [85000, 68000, 3300],
                 limits(CODEX_LIMITS.primary, CODEX_LIMITS.secondary)),
  ]);

  // Input history: Codex writes `session_id`, one line per prompt.
  const history = [IDS.codexDeleteEn, IDS.codexDeleteEn, IDS.codexDeleteRu, IDS.codexDeleteRu, IDS.codexLedger]
    .map((sid, i) => line({ session_id: sid, ts: Math.round(now / 1000) - 3600 * (40 - i), text: `prompt ${i}` }))
    .join("");
  fs.writeFileSync(path.join(codexHome, "history.jsonl"), history);

  // Codex's own thread list: a title for the ledger thread. Read-only for the catalog.
  execFileSync(python, ["-c", [
    "import sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1])",
    "c.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, name TEXT)')",
    "c.execute('INSERT INTO threads (id, rollout_path, title, name) VALUES (?,?,?,NULL)', (sys.argv[2], sys.argv[3], sys.argv[4]))",
    "c.commit()",
  ].join("\n"), path.join(codexHome, "state_5.sqlite"), IDS.codexLedger, files.codexLedger, PHRASES.codexTitle]);

  return {
    root, home, vault, claudeDir, projects, codexHome, atlasHome, cwds, files,
    sessionCount: Object.keys(IDS).length,
  };
}

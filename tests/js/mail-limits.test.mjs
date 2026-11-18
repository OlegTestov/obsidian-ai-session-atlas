import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadSrc, ROOT } from "./helpers/load-src.mjs";

const { MailLimits, screenLimit } = loadSrc("mail-limits");
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "fixtures", "codex_screens.json"), "utf8"));
const DATE = Date.parse("2026-11-18T19:30:00.000Z");
const claude = [
  "❯ You have 1 new message. Read with mail_inbox",
  "  You've hit your 5-hour limit · resets 8:50pm (Europe/Madrid)",
  "  Usage credits are at least 15% off for one purchase",
  "",
  "  ⏺ Usage limit reached · continuing automatically at 8:50pm · esc to cancel",
];

test("Claude's reset uses the timezone shown, without copying other screen text", () => {
  const limits = new MailLimits();
  assert.deepEqual(limits.forTab("c", "claude", claude, DATE), {
    reset_text: "8:50 PM (Europe/Madrid)",
    reset_at: "2026-11-18T19:50:00.000Z",
    expires_at: "2026-11-18T19:50:00.000Z",
  });
  assert.equal(limits.forTab("c", "claude", claude, Date.parse("2026-11-18T20:00:00Z")), null);
});

test("an idle Claude prompt hint does not hide the error, a new turn supersedes it", () => {
  const error = "You've hit your 5-hour limit · resets 8:50pm (Europe/Madrid)";
  const hint = "❯ Try asking about your project";
  assert.equal(screenLimit([error, "──────", hint, "──────"], "claude").clock.label, "8:50 PM (Europe/Madrid)");
  assert.equal(screenLimit([error, "❯ Continue", "⏺ Updated.", "──────", hint], "claude"), null);
});

test("a weekly limit announced with a date keeps its actual reset date", () => {
  const lines = ["You've hit your weekly limit · resets Nov 20 at 10am (Europe/Madrid)"];
  const result = new MailLimits().forTab("c", "claude", lines, DATE);
  assert.equal(result.reset_at, "2026-11-20T09:00:00.000Z");
});

test("Codex's exhaustion is detected from its real screen fixture, including wrapped output", () => {
  const rows = fixture.rate_limit;
  assert.equal(screenLimit(rows, "codex").clock.label, "1:36 AM");
  const split = rows.flatMap(line => line.includes("try again at") ? line.replace(" try again at", "\ntry again at").split("\n") : [line]);
  assert.equal(screenLimit(split, "codex").clock.label, "1:36 AM");
  assert.equal(screenLimit(rows.slice(rows.findIndex(line => line.includes("Approaching rate limits"))), "codex"), null);
  assert.equal(screenLimit(["■ You’ve hit your usage limit. Try again at 1:36 AM.", "› new request",
    "• Worked for 2s • 08:00", "› Ask Codex to do anything"], "codex"), null);
});

test("an unknown reset expires and a successful turn clears the observation", () => {
  const limits = new MailLimits();
  const lines = ["⏺ Usage limit reached · esc to cancel"];
  assert.equal(limits.forTab("c", "claude", lines, DATE).reset_at, null);
  assert.equal(limits.forTab("c", "claude", lines, DATE + 3600001), null);
  assert.equal(limits.forTab("c", "claude", ["❯"], DATE + 3600010), null);
  assert.ok(limits.forTab("c", "claude", lines, DATE + 3600020));
});

// "Resume with…" on the card (web/js/resume-with.js): which agents the menu offers and how the
// arrow keys move in it. The browser flow is in tests/e2e/resume-with.spec.mjs.
//   node --test tests/js/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, pageOrder } from "./helpers/page.mjs";

const page = loadPage(pageOrder().filter((f) => f.startsWith("lang-") || ["i18n.js", "resume-with.js"].includes(f)));
const RW = page.ResumeWith;
const pick = (list) => Array.from(list, (c) => `${c.agent}:${c.own ? "own" : ""}${c.enabled ? "on" : "off"}`);

describe("Resume with: the agents offered", () => {
  test("outside Obsidian there is no plugin to ask: both agents", () => {
    assert.deepEqual(pick(RW.choices("claude", null, false)), ["claude:ownon", "codex:on"]);
    assert.deepEqual(pick(RW.choices("codex", null, false)), ["claude:on", "codex:ownon"]);
  });
  test("in Obsidian: the plugin's switches decide", () => {
    assert.deepEqual(pick(RW.choices("claude", { claude: true, codex: true }, true)), ["claude:ownon", "codex:on"]);
    assert.deepEqual(pick(RW.choices("claude", { claude: true, codex: false }, true)), ["claude:ownon", "codex:off"]);
    assert.deepEqual(pick(RW.choices("codex", { claude: false, codex: true }, true)), ["claude:off", "codex:ownon"]);
  });
  test("a plugin that has not answered (or predates the switches): Claude Code on, Codex off", () => {
    assert.deepEqual(pick(RW.choices("claude", null, true)), ["claude:ownon", "codex:off"]);
  });
  test("the session's own agent stays available even when switched off: it is the ordinary resume", () => {
    assert.deepEqual(pick(RW.choices("codex", { claude: true, codex: false }, true)), ["claude:on", "codex:ownon"]);
  });
});

describe("Resume with: keyboard", () => {
  const on = [true, true];
  test("down and up wrap around", () => {
    assert.equal(RW.menuStep(on, -1, "ArrowDown"), 0);
    assert.equal(RW.menuStep(on, 0, "ArrowDown"), 1);
    assert.equal(RW.menuStep(on, 1, "ArrowDown"), 0);
    assert.equal(RW.menuStep(on, 0, "ArrowUp"), 1);
    assert.equal(RW.menuStep(on, -1, "ArrowUp"), 1);
  });
  test("a disabled item is skipped; Home and End jump to enabled ones", () => {
    assert.equal(RW.menuStep([true, false], 0, "ArrowDown"), 0);
    assert.equal(RW.menuStep([false, true], -1, "Home"), 1);
    assert.equal(RW.menuStep([true, false], -1, "End"), 0);
  });
  test("nothing enabled: nothing to focus; other keys keep the place", () => {
    assert.equal(RW.menuStep([false, false], -1, "ArrowDown"), -1);
    assert.equal(RW.menuStep(on, 1, "a"), 1);
  });
});

describe("Resume with: strings", () => {
  const I = page.I18N;
  test("both languages name the button as the owner asked", () => {
    I.setLang("en");
    assert.equal(I.i18n("rw.button"), "Resume with…");
    assert.match(I.i18n("rw.off", { agent: "Codex" }), /^Codex is turned off in the plugin settings/);
    I.setLang("ru");
    assert.equal(I.i18n("rw.button"), "Открыть с помощью…");
    assert.match(I.i18n("rw.off", { agent: "Codex" }), /^Codex выключен в настройках плагина/);
  });
});

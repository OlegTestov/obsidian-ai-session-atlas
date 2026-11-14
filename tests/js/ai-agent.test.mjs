// AI features run through Claude Code or Codex (the server picks, atlas/runner.py): the preview says
// which agent gets the text. The settings row that picks the agent is in plugin.test.mjs.
//   node --test tests/js/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, pageOrder } from "./helpers/page.mjs";

const page = loadPage(pageOrder().filter((f) => f.startsWith("lang-") || ["i18n.js", "actions.js"].includes(f)));

describe("AI preview: where the text goes", () => {
  test("names the agent and its model in both languages", () => {
    page.I18N.setLang("en");
    assert.equal(page.egressTarget({ agent_name: "Codex", model: "default / low" }), "Codex, model default / low");
    page.I18N.setLang("ru");
    assert.equal(page.egressTarget({ agent_name: "Codex", model: "по умолчанию / low" }),
                 "Codex, модель по умолчанию / low");
    assert.equal(page.egressTarget({ agent_name: "Claude Code", model: "sonnet / low" }), "Claude Code, модель sonnet / low");
  });
  test("an older server without agent_name still means Claude Code", () => {
    page.I18N.setLang("en");
    assert.equal(page.egressTarget({ model: "sonnet / low" }), "Claude Code, model sonnet / low");
  });
});

// Settings fields ↔ config.json: parsing and back without loss.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers/load-src.mjs";

const F = loadSrc("config-form");

describe("settings fields", () => {
  const domains = F.textToDomains("work — my job: OPS-* tickets\n  home\nbad id — x\nwork — duplicate\nside-projects: mine");

  it("domains: id — description, empty description; bad ids and duplicates dropped", () => {
    assert.deepEqual(domains, [{ id: "work", description: "my job: OPS-* tickets" }, { id: "home", description: "" },
                               { id: "side-projects", description: "mine" }]);
  });

  it("domains: round trip", () => {
    assert.deepEqual(F.textToDomains(F.domainsToText(domains)), domains);
  });

  it("rules: Area → domain with different separators", () => {
    assert.deepEqual(F.textToRules("Work → work\nPersonal - personal\njunk"), [["Work", "work"], ["Personal", "personal"]]);
  });

  it("tickets: commas, spaces, trailing hyphen, junk", () => {
    assert.deepEqual(F.textToPrefixes("ABC, OPS- 12x a|b ops"), ["ABC", "OPS", "ops"]);
  });

  it("note folders: a known id is kept, a new one is the folder name, no duplicates", () => {
    const vaults = F.textToVaults("/Users/a/Notes\n/Users/a/Work/\n/Users/a/Notes", [{ path: "/Users/a/Notes", id: "vault" }]);
    assert.deepEqual(vaults, [{ path: "/Users/a/Notes", id: "vault" }, { path: "/Users/a/Work/", id: "Work" }]);
  });

  it("model: \"opus high\", default effort, empty keeps the previous one", () => {
    assert.deepEqual(F.textToModel("opus high"), ["opus", "high"]);
    assert.deepEqual(F.textToModel("haiku", ["sonnet", "low"]), ["haiku", "low"]);
    assert.deepEqual(F.textToModel("  ", ["sonnet", "low"]), ["sonnet", "low"]);
    assert.deepEqual(F.textToModel("opus turbo"), ["opus", "medium"]);
  });
});

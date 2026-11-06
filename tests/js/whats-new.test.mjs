import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import { loadSrc } from "./helpers/load-src.mjs";
const realLoad = Module._load;
Module._load = (r, p, i) => r === "obsidian" ? { Modal: class {}, setIcon() {} } : realLoad(r, p, i);
const { updateDecision, WhatsNewMethods, RELEASE_VERSION } = loadSrc("whats-new");
Module._load = realLoad;

describe("update highlights", () => {
  it("first install establishes a baseline without showing old news", () => {
    // The highlights belong to this minor version: a patch may keep them, a new minor needs its own.
    const shipped = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url))).version.split(".").map(Number);
    const notes = RELEASE_VERSION.split(".").map(Number);
    assert.deepEqual(notes.slice(0, 2), shipped.slice(0, 2));
    assert.ok(notes[2] <= shipped[2]);
    assert.equal(updateDecision({}, RELEASE_VERSION), "baseline");
  });
  it("existing users upgrading from before version tracking get the highlights once", () => {
    assert.equal(updateDecision({ language: "ru" }, RELEASE_VERSION), "show");
    assert.equal(updateDecision({ lastSeenVersion: RELEASE_VERSION }, RELEASE_VERSION), "none");
  });
  it("compares versions numerically, and does not show notes on downgrade or invalid builds", () => {
    assert.equal(updateDecision({ lastSeenVersion: "2.5.0" }, "2.6.0", "2.6.0"), "show");
    assert.equal(updateDecision({ lastSeenVersion: "2.9.0" }, "2.10.0", "2.10.0"), "show");
    assert.equal(updateDecision({ lastSeenVersion: "2.10.0" }, "2.6.0", "2.6.0"), "none");
    assert.equal(updateDecision({ lastSeenVersion: "2.6.0" }, "dev"), "none");
    assert.equal(updateDecision({ lastSeenVersion: {} }, RELEASE_VERSION), "show");
  });
  it("a patch without its own highlights records itself and does not show the same notes again", () => {
    assert.equal(updateDecision({ lastSeenVersion: "2.7.0" }, "2.7.1", "2.7.0"), "baseline");
    assert.equal(updateDecision({ lastSeenVersion: "2.6.0" }, "2.7.1", "2.7.0"), "show");
    assert.equal(updateDecision({ lastSeenVersion: "2.7.1" }, "2.7.1", "2.7.0"), "none");
    assert.equal(updateDecision({ lastSeenVersion: "2.7.0" }, "2.8.0", "2.8.0"), "show");
  });
  it("opt-out records an upgrade without opening a modal", () => {
    assert.equal(updateDecision({ lastSeenVersion: "2.5.0", showWhatsNew: false }, RELEASE_VERSION), "baseline");
  });
  it("a layout callback from an unloaded instance writes nothing", async () => {
    const p = Object.assign(Object.create(WhatsNewMethods.prototype), {
      _loaded: false, settings: {}, manifest: { version: RELEASE_VERSION },
      saveData() { assert.fail("stale instance wrote settings"); },
      showWhatsNew() { assert.fail("stale instance opened a modal"); },
    });
    await p.checkWhatsNew({ language: "en" });
    assert.equal(p.settings.lastSeenVersion, undefined);
  });
  it("saves the checkpoint before showing, repeated loads do not show it again", async () => {
    const saved = { language: "en" }, events = [];
    const plugin = Object.assign(Object.create(WhatsNewMethods.prototype), {
      settings: { ...saved }, manifest: { version: RELEASE_VERSION },
      async saveData(value) { events.push(["saved", value.lastSeenVersion]); },
      showWhatsNew() { events.push(["shown"]); },
    });
    await plugin.checkWhatsNew(saved);
    assert.deepEqual(events, [["saved", RELEASE_VERSION], ["shown"]]);
    await plugin.checkWhatsNew(plugin.settings);
    assert.equal(events.length, 2);
  });
  it("first install, disabled popups, and unloading during save never steal focus", async () => {
    for (const saved of [{}, { showWhatsNew: false }, { language: "en" }]) {
      let shown = 0;
      const p = Object.assign(Object.create(WhatsNewMethods.prototype), {
        settings: { ...saved }, manifest: { version: RELEASE_VERSION },
        async saveData() { this._loaded = false; }, showWhatsNew() { shown++; },
      });
      await p.checkWhatsNew(saved);
      assert.equal(shown, 0);
    }
  });
});

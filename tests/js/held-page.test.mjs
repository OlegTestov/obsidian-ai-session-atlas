// The Active page and tabs that closed with the plugin while their agents kept running (`held`), and
// the restore list after an Obsidian restart, which is shown only once the plugin is sure of it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadPage } from "./helpers/page.mjs";

function page() {
  const ctx = loadPage();
  // A banner element that remembers what it was given; the rest of the DOM stays a stand-in.
  ctx.fakeBanner = { hidden: true, children: [],
    classList: { add: (c) => { if (c === "hidden") ctx.fakeBanner.hidden = true; },
                 remove: (c) => { if (c === "hidden") ctx.fakeBanner.hidden = false; } },
    replaceChildren: (...kids) => { ctx.fakeBanner.children = kids; },
    appendChild: (kid) => { ctx.fakeBanner.children.push(kid); } };
  const realQuery = ctx.document.querySelector;
  ctx.document.querySelector = (sel) => (sel === "#restore-banner" ? ctx.fakeBanner : realQuery(sel));
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

describe("restore list after an Obsidian restart", () => {
  it("is not shown while the plugin says it is not ready (it would vanish a second later)", () => {
    const ctx = page();
    run(ctx, `handleRestoreMessage({ type: "restorable", ready: false, sessions: [{ session_id: "a", title: "A" }] })`);
    assert.equal(run(ctx, "restorable.length"), 0);
    assert.equal(ctx.fakeBanner.hidden, true);
  });
  it("is shown once ready", () => {
    const ctx = page();
    run(ctx, `handleRestoreMessage({ type: "restorable", ready: true, sessions: [{ session_id: "a", title: "A" }] })`);
    assert.equal(run(ctx, "restorable.length"), 1);
    assert.equal(ctx.fakeBanner.hidden, false);
  });
});

describe("tabs closed with the plugin", () => {
  it("a held agent shows the banner on its own and finds its card by the process tree", () => {
    const ctx = page();
    run(ctx, `hostHeld = new Map([[4100, "Fix the build"]]); renderRestoreBanner();`);
    assert.equal(ctx.fakeBanner.hidden, false);
    assert.equal(ctx.fakeBanner.children.length, 1, "one row: the held tabs");
    assert.equal(run(ctx, "heldFor({ ancestors: [1, 4100, 4200] })"), 4100);
    assert.equal(run(ctx, "heldFor({ ancestors: [1, 4200] })"), null);
  });
  it("held tabs and a ready restore list share the banner", () => {
    const ctx = page();
    run(ctx, `hostHeld = new Map([[4100, "Fix the build"]]);
              handleRestoreMessage({ type: "restorable", ready: true, sessions: [{ session_id: "a", title: "A" }] })`);
    assert.equal(ctx.fakeBanner.hidden, false);
    assert.equal(ctx.fakeBanner.children.length, 4, "held row, the restore text and its two buttons");
  });
  it("nothing held and nothing to restore: no banner", () => {
    const ctx = page();
    run(ctx, `hostHeld = new Map(); renderRestoreBanner();`);
    assert.equal(ctx.fakeBanner.hidden, true);
  });
});

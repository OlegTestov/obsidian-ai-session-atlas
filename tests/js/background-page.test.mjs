import { it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readScript } from "./helpers/page.mjs";

function page(embedded = true) {
  const calls = [];
  const element = (tag, cls, text) => ({ tag, cls, text, children: [], events: {}, classList: { add() {} },
    append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); },
    addEventListener(type, fn) { this.events[type] = fn; } });
  const ctx = vm.createContext({ Map, Set, Date, EMBEDDED: embedded, hostBackground: new Map(),
    iconify: (b) => { b.icon = true; return b; }, svgIcon: () => ({ tag: "svg" }), loadStored: () => true,
    i18n: (key) => key, agentPassesView: (view, j) => j.agent === "claude", el: element,
    ago: s => s, renderActive() {}, tellHost: (type, payload) => calls.push([type, payload]),
    loadActive() {}, window: { setTimeout() {} } });
  vm.runInContext(readScript("active-closed.js"), ctx);
  return { ctx, calls, run: code => vm.runInContext(code, ctx) };
}
const job = { job_id: "ab12cd34", session_id: "test-session", title: "Recorder", status: "busy", agent: "claude" };
it("background row names the state and sends only the job id; pending actions cannot repeat", () => {
  const { ctx, calls } = page();
  const row = ctx.backgroundRow(job);
  assert.equal(row.children[0].text, "Recorder");
  assert.match(row.children[1].text, /active.status.busy/);
  row.children[2].events.click();
  row.children[3].events.click();
  assert.equal(JSON.stringify(calls), JSON.stringify([["bg-bring-back", { job: "ab12cd34" }]]));
  const pending = ctx.backgroundRow(job);
  assert.equal(pending.children[2].disabled, true);
  assert.equal(pending.children[3].disabled, true);
});
it("stop has a distinct bridge action", () => {
  const { ctx, calls } = page();
  ctx.backgroundRow(job).children[3].events.click();
  assert.equal(calls[0][0], "bg-stop");
});
it("outside Obsidian gives terminal commands and no ineffective buttons", () => {
  const { ctx } = page(false);
  const row = ctx.backgroundRow(job);
  assert.equal(row.children.length, 2);
  assert.match(row.children[1].text, /claude attach ab12cd34.*claude stop ab12cd34/);
});
it("section disappears when empty or filtered; stale pending state expires", () => {
  const { ctx, run } = page();
  assert.equal(ctx.backgroundSection(), null);
  run(`backgroundJobs = [${JSON.stringify(job)}]`);
  assert.equal(ctx.backgroundSection().children[1].children.length, 1);
  ctx.backgroundAct(job, "bg-stop", "stopping");
  run('backgroundJobs = []; pruneBackgroundNotes()');
  assert.equal(run('backgroundNotes.size'), 0);
  run(`backgroundJobs = [${JSON.stringify({ ...job, agent: 'codex' })}]`);
  assert.equal(ctx.backgroundSection(), null);
});

it("completion or cancellation immediately unlocks the pending row", () => {
  const { ctx, run } = page();
  ctx.backgroundAct(job, "bg-stop", "stopping");
  assert.equal(run("backgroundNotes.size"), 1);
  ctx.backgroundResult(job.job_id);
  assert.equal(run("backgroundNotes.size"), 0);
  assert.equal(ctx.backgroundRow(job).children[3].disabled, false);
});

// A card whose tab shows a background job: Bring back there, as in the tab menu.
it("the card's Bring back sends the tab's job once and stays pending while the tab shows it", () => {
  const { ctx, calls, run } = page();
  const button = ctx.bringBackButton("ab12cd34", false);
  assert.equal(button.children[1].text, "active.bringBack");
  assert.equal(button.disabled, false);
  button.events.click({ stopPropagation() {} });
  button.events.click({ stopPropagation() {} });
  assert.equal(JSON.stringify(calls), JSON.stringify([["bg-bring-back", { job: "ab12cd34" }]]));
  const pending = ctx.bringBackButton("ab12cd34", false);
  assert.equal(pending.disabled, true);
  assert.equal(pending.children[1].text, "background.bringingBack");
  run('hostBackground = new Map([[7, "ab12cd34"]]); pruneBackgroundNotes()');
  assert.equal(run("backgroundNotes.size"), 1, "a tab still shows the job: not a vanished job");
  run("hostBackground = new Map(); pruneBackgroundNotes()");
  assert.equal(run("backgroundNotes.size"), 0);
  assert.equal(ctx.bringBackButton("ab12cd34", true).icon, true, "the detailed card has the icon form");
});

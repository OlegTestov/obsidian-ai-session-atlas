import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { loadPage } from "./helpers/page.mjs";

test("a stale workspace delete and retry preserves the last workspace", async () => {
  const page = loadPage(["workspaces.js", "workspace-editor.js"]);
  const run = code => vm.runInContext(code, page);
  const boards = ["stale", "last"].map(id => ({ id, name: id, slots: [] }));
  let shared = { revision: 1, boards };
  let rendered = "";
  const writes = [];
  page.refreshLayoutButton = () => {};
  page.refreshWorkspaceEditor = () => {};
  page.writeHash = () => {};
  page.renderActive = () => { rendered = run("workspaceBoards().map(x => x.id).join(',')"); };
  page.api = async (_, body) => {
    if (!body) return shared;
    writes.push(body.boards.map(board => board.id).join(","));
    if (body.revision !== shared.revision) throw Object.assign(new Error("conflict"), { status: 409 });
    shared = { revision: shared.revision + 1, boards: body.boards };
    return shared;
  };
  page.i18n = key => key;
  page.el = () => ({});
  page.initial = shared;
  run("applyWorkspaces(initial)");
  run("confirmWorkspaceAction = (_a, _b, _c, action) => globalThis.confirmDelete = action");
  run("confirmWorkspaceDeletion(workspaceBoard('stale'), { failed: () => {} })");
  shared = { revision: 2, boards: [boards[1]] }; // a second window deleted the same board
  await page.confirmDelete();
  assert.equal(rendered, "last");
  page.staleBoard = boards[0];
  run("confirmWorkspaceDeletion(staleBoard, { failed: () => {} })");
  await page.confirmDelete();
  assert.deepEqual(writes, ["last"]);
  assert.deepEqual(shared.boards, [boards[1]]);
});

test("refreshing from a workspace launch conflict immediately renders the new revision", async () => {
  const page = loadPage(["workspaces.js"]);
  const run = code => vm.runInContext(code, page);
  let activeRenders = 0;
  let editorRenders = 0;
  page.renderActive = () => { activeRenders++; };
  page.refreshWorkspaceEditor = () => { editorRenders++; };
  page.refreshLayoutButton = () => {};
  page.writeHash = () => {};
  page.api = async () => ({ revision: 2, boards: [] });
  run(`applyWorkspaces({revision: 1, boards: [{id:"gone",slots:[null]}]});
       saveWorkspaces = async () => { throw Object.assign(new Error("conflict"), {status:409}); };`);
  await page.workspaceNewSession("gone", "session");
  assert.deepEqual([activeRenders, editorRenders], [1, 1]);
});

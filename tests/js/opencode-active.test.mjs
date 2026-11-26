import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { loadPage, ROOT } from "./helpers/page.mjs";

const recorded = JSON.parse(fs.readFileSync(ROOT + "/tests/fixtures/opencode/service-2.3.2-active.json"));
const field = recorded.required.body.data.fields;

test("OpenCode permission decisions only include once and reject", () => {
  const page = loadPage(["opencode-active.js"]);
  assert.equal(vm.runInContext("openCodePermissionDecisions.join(',')", page), "once,reject");
});

test("OpenCode form validation keeps required and custom multi-choice rules", () => {
  const page = loadPage(["opencode-active.js"]);
  page.fields = field;
  page.answer = { fixed: "blue", loose: ["green", "custom"] };
  assert.equal(vm.runInContext("openCodeAnswerValid(fields, answer)", page), true);
  for (const invalid of [{}, { fixed: "unknown", loose: ["green"] }, { fixed: "blue", loose: "green" },
    { fixed: "blue", loose: [] }]) {
    page.answer = invalid;
    assert.equal(vm.runInContext("openCodeAnswerValid(fields, answer)", page), false);
  }
});

test("OpenCode stopping persists while a later poll still lists the run", () => {
  const page = loadPage(["opencode-active.js"]);
  vm.runInContext("const stopNotes = new Map([['ses_test', 'Stopping']]); openCodeStopping.add('ses_test');", page);
  assert.equal(vm.runInContext("pruneOpenCodeStops(['ses_test']); stopNotes.has('ses_test')", page), true);
  assert.equal(vm.runInContext("pruneOpenCodeStops(null); stopNotes.has('ses_test')", page), true);
  assert.equal(vm.runInContext("pruneOpenCodeStops([]); stopNotes.has('ses_test')", page), false);
});

test("OpenCode prunes a form draft only after a known pending snapshot", () => {
  const page = loadPage(["opencode-active.js"], { setup(ctx) { ctx.loadStored = () => null; } });
  const run = code => vm.runInContext(code, page);
  run("openCodeForms.set('form', { sid: 'owner', fields: new Map() })");
  assert.equal(run("reconcileOpenCode([], false); openCodeForms.has('form')"), true);
  assert.equal(run("reconcileOpenCode([], true); openCodeForms.has('form')"), true);
  assert.equal(run(`reconcileOpenCode([{session_id:'other', opencode_pending_known:true},
    {session_id:'owner', opencode_pending_known:false}], true); openCodeForms.has('form')`), true);
  assert.equal(run(`reconcileOpenCode([{session_id:'owner', opencode_pending_known:true,
    opencode_dialog:{id:'form', kind:'form'}}], true); openCodeForms.has('form')`), true);
  assert.equal(run(`reconcileOpenCode([{session_id:'owner', opencode_pending_known:true,
    opencode_dialog:{id:'permission', kind:'permission'}}], true); openCodeForms.has('form')`), true);
  assert.equal(run(`reconcileOpenCode([{session_id:'other', opencode_pending_known:false},
    {session_id:'owner', opencode_pending_known:true}], true); openCodeForms.has('form')`), false);
});

function replyPage(storage, calls, uuid, setup = () => {}) {
  return loadPage(["active-cards.js", "opencode-active.js"], {
    setup(ctx) {
      ctx.crypto = { randomUUID: () => uuid };
      ctx.localStorage = {
        setItem: (key, raw) => storage.set(key, raw),
        removeItem: key => storage.delete(key),
      };
      ctx.loadStored = key => JSON.parse(storage.get(key) || "null");
      ctx.i18n = key => key;
      ctx.sendState = new Map();
      ctx.CSS = { escape: value => value };
      ctx.document.querySelector = () => null;
      ctx.loadActive = () => {};
      ctx.api = async (path, body) => {
        const stored = JSON.parse(storage.get("atlas.opencode.reply.fixture"));
        assert.equal(stored.id, body.message_id);
        calls.push([path, body]);
        return { delivery: null };
      };
      setup(ctx);
    },
  });
}

const reply = (page, text) => {
  page.replyText = text;
  return vm.runInContext("sendOpenCodeReply({session_id:'fixture'}, replyText)", page);
};

const firstUUID = "01234567-89ab-cdef-abcd-ef0123456789";
const nextUUID = "abcdef01-2345-6789-abcd-ef0123456789";

test("OpenCode sends no request for text Python strips as blank", async () => {
  const storage = new Map();
  const calls = [];
  const page = replyPage(storage, calls, firstUUID);
  for (const text of ["\u0085", " \x1c\u2003\u0085"]) await reply(page, text);
  assert.deepEqual(calls, []);
  assert.equal(storage.size, 0);
  await reply(page, "\ufeff");
  assert.equal(calls.length, 1);
});

test("OpenCode keeps the composer editable and unlocks the request ID after a local refusal", async () => {
  for (const [status, state] of [[400, "request_failed"], [403, undefined], [409, "live_needs_tab"], [409, "live_stale"]]) {
    const storage = new Map();
    const calls = [];
    const note = {};
    const area = { value: "Original", closest: () => ({ querySelector: () => note }) };
    const page = replyPage(storage, calls, firstUUID, ctx => {
      ctx.document.querySelector = () => area;
      ctx.api = async () => { throw Object.assign(new Error("Refused"), { status, state }); };
      ctx.saveDrafts = () => {};
    });
    vm.runInContext("const drafts = new Map()", page);
    await reply(page, "Original");
    assert.equal(storage.size, 0);
    assert.equal(area.value, "Original");
    assert.equal(vm.runInContext("drafts.get('fixture')", page), "Original");
    await reply(replyPage(storage, calls, nextUUID), "Edited");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].message_id, "msg_abcdef0123456789abcdef0123");
  }
});

test("OpenCode keeps the saved request when the POST response is ambiguous", async () => {
  const storage = new Map();
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.api = async () => { throw Object.assign(new Error("Unavailable"), { status: 502 }); };
  });
  await reply(page, "Original");
  const saved = JSON.parse(storage.get("atlas.opencode.reply.fixture"));
  assert.equal(saved.text, "Original");
  assert.equal(saved.ambiguous, true);
});

test("OpenCode admits a reply once when acknowledgement and the tab route are lost", async () => {
  const storage = new Map();
  const admissions = new Map();
  let route = true;
  let reconciliation = false;
  const requests = [];
  function setup(ctx) {
    ctx.rememberSent = () => {};
    ctx.saveDrafts = () => {};
    ctx.api = async (_path, body) => {
      requests.push(body);
      if (reconciliation && admissions.has(body.message_id)) return { delivery: "queued" };
      if (!route) throw Object.assign(new Error("Tab closed"), { status: 409, state: "live_needs_tab" });
      admissions.set(body.message_id, body.text);
      return { delivery: null };
    };
  }
  const first = replyPage(storage, [], firstUUID, setup);
  vm.runInContext("const drafts = new Map()", first);
  await reply(first, "Original");
  route = false;
  const reloaded = replyPage(storage, [], nextUUID, setup);
  vm.runInContext("const drafts = new Map()", reloaded);
  await reply(reloaded, "Original");
  route = reconciliation = true;
  await reply(reloaded, "Original");
  assert.equal(admissions.size, 1);
  assert.equal(new Set(requests.map(request => request.message_id)).size, 1);
  assert.equal(requests[2].text, "Original");
  assert.equal(storage.size, 0);
});

test("OpenCode requires confirmation to discard an ambiguous reply and keeps a newer draft", async () => {
  const storage = new Map();
  let confirm;
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.modal = (_title, warning, _body, _label, callback) => {
      assert.equal(warning, "opencode.discardReplyWarning");
      confirm = callback;
    };
    ctx.closeAfterHandOff = () => {};
    ctx.saveDrafts = () => {};
    ctx.api = path => path.endsWith("/reply-check") ? new Promise(() => {}) : Promise.resolve({ delivery: null });
  });
  vm.runInContext("const drafts = new Map([['fixture', 'Newer']])", page);
  await reply(page, "Original");
  vm.runInContext("reconcileOpenCode([{session_id:'fixture', pid:1}], true)", page);
  vm.runInContext("discardOpenCodeReply('fixture')", page);
  assert.equal(storage.size, 1);
  confirm();
  assert.equal(storage.size, 0);
  assert.equal(vm.runInContext("drafts.get('fixture')", page), "Newer");
});

test("the page API exposes the response status for a local refusal", async () => {
  const page = loadPage(["core.js"], { setup(ctx) {
    ctx.I18N = { lang: () => "en" };
    ctx.i18n = key => key;
    ctx.serverStatus = () => {};
    ctx.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: "Refused" }) });
  } });
  await assert.rejects(vm.runInContext("api('/api/opencode/active/reply', {})", page), { status: 403 });
});

test("OpenCode persists the queue ID before POST and reuses it after an ambiguous result and reload", async () => {
  const storage = new Map();
  const calls = [];
  await reply(replyPage(storage, calls, firstUUID), "Queued fixture");
  await reply(replyPage(storage, calls, nextUUID), "Queued fixture");
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], calls[1][0]);
  assert.equal(calls[0][1].ambiguous, false);
  assert.equal(calls[1][1].ambiguous, true);
  assert.equal(calls[0][1].message_id, calls[1][1].message_id);
  assert.equal(calls[0][1].text, calls[1][1].text);
  assert.equal(calls[1][1].message_id, "msg_0123456789abcdefabcdef0123");
});

test("OpenCode rejects oversized replies and replaces a legacy rejected pending entry", async () => {
  const oversized = "x".repeat(100001);
  const storage = new Map();
  const calls = [];
  const page = replyPage(storage, calls, firstUUID);
  await reply(page, oversized);
  assert.equal(calls.length, 0);
  assert.equal(storage.size, 0);
  storage.set("atlas.opencode.reply.fixture", JSON.stringify({ id: "msg_" + "z".repeat(26), text: oversized }));
  await reply(page, "🧪".repeat(100000));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].message_id, "msg_0123456789abcdefabcdef0123");
});

test("OpenCode admission preserves the newer draft in both the composer and the map", async () => {
  const storage = new Map();
  const note = {};
  const area = { value: "First", closest: () => ({ querySelector: () => note }) };
  let confirm;
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.document.querySelector = () => area;
    ctx.CSS = { escape: value => value };
    ctx.autosize = () => {};
    ctx.rememberSent = () => {};
    ctx.saveDrafts = () => {};
    ctx.api = () => new Promise(resolve => { confirm = resolve; });
  });
  vm.runInContext("const drafts = new Map([['fixture', 'First']])", page);
  const sent = reply(page, "First");
  area.value = "Second";
  vm.runInContext("drafts.set('fixture', 'Second')", page);
  confirm({ delivery: "queued" });
  await sent;
  assert.equal(area.value, "Second");
  assert.equal(vm.runInContext("drafts.get('fixture')", page), "Second");
  assert.equal(storage.size, 0);
});

test("OpenCode Stop feedback expires after a failed request", async () => {
  let expire;
  const page = loadPage(["opencode-active.js"], {
    setup(ctx) {
      ctx.i18n = key => key;
      ctx.renderActive = () => {};
      ctx.loadActive = () => {};
      ctx.api = async () => { throw new Error("temporary"); };
      ctx.setTimeout = callback => { expire = callback; return 1; };
    },
  });
  vm.runInContext("let lastSignature; const stopNotes = new Map()", page);
  await vm.runInContext("stopOpenCode({session_id:'fixture'})", page);
  assert.equal(vm.runInContext("stopNotes.get('fixture')", page), "active.notStopped");
  expire();
  assert.equal(vm.runInContext("stopNotes.has('fixture')", page), false);
});

for (const launched of [true, false]) {
  test(`OpenCode Move ignores a stale launch ${launched ? "success" : "failure"}`, async () => {
    const button = {};
    const note = {};
    const dialog = { open: true, close() { this.open = false; } };
    const copy = { classList: { add() {} } };
    const elements = { "#m-ok": button, "#m-note": note, "#modal": dialog, "#m-copy": copy };
    let complete;
    let launchStarted;
    const started = new Promise(resolve => { launchStarted = resolve; });
    const page = loadPage(["active-restore.js"], {
      setup(ctx) {
        ctx.$ = selector => elements[selector];
        ctx.modal = (_title, _note, _body, _label, callback) => { button.onclick = callback; };
        ctx.i18n = key => key;
        ctx.crypto = { randomUUID: () => firstUUID };
        ctx.api = async () => ({});
        ctx.openCodeInTab = () => new Promise(resolve => { complete = resolve; launchStarted(); });
        ctx.loadActive = () => {};
      },
    });
    vm.runInContext("confirmMove({agent:'opencode', session_id:'fixture'})", page);
    const finished = button.onclick();
    await started;
    button.onclick = () => {};
    button.disabled = true;
    note.textContent = "New modal";
    complete(launched);
    await finished;
    assert.equal(dialog.open, true);
    assert.equal(button.disabled, true);
    assert.equal(note.textContent, "New modal");
  });
}

test("OpenCode actions send the generation from the card that initiated them", async () => {
  const calls = [];
  const page = loadPage(["opencode-active.js"], {setup(ctx) {
    ctx.api = async (path, body) => calls.push([path.split("/").at(-1), body.generation]);
  }});
  for (const operation of ["permission", "form", "dismiss", "stop", "reply", "reply-check"]) {
    page.operation = operation;
    await vm.runInContext("openCodeRequest({session_id:'fixture', opencode_generation:'drawn'}, operation)", page);
  }
  assert.deepEqual(calls, ["permission", "form", "dismiss", "stop", "reply", "reply-check"].map(op => [op, "drawn"]));
});

test("OpenCode checks delivery before retrying the same reply across service generations", async () => {
  const storage = new Map();
  const calls = [];
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.rememberSent = () => {};
    ctx.api = async (path, body) => {
      calls.push([path.split("/").at(-1), body]);
      if (ctx.failCheck && path.endsWith("/reply-check")) throw new Error("Unavailable");
      if (ctx.stale && path.endsWith("/reply")) {
        throw Object.assign(new Error("Stale"), { status: 409, state: "live_stale" });
      }
      return { delivery: ctx.delivered ? "delivered" : null };
    };
  });
  const run = code => vm.runInContext(code, page);
  run("const drafts = new Map()");
  await run("sendOpenCodeReply({session_id:'fixture', opencode_generation:'before'}, 'Original')");
  const key = "atlas.opencode.reply.fixture";
  const original = JSON.parse(storage.get(key));
  assert.equal(original.generation, "before");
  page.failCheck = true;
  const retry = () => run("sendOpenCodeReply({session_id:'fixture', opencode_generation:'after'}, 'Original')");
  await retry();
  assert.equal(JSON.parse(storage.get(key)).generation, "before");
  page.failCheck = false;
  page.stale = true;
  await retry();
  assert.deepEqual(calls.map(([op, body]) => [op, body.generation, body.message_id]), [
    ["reply", "before", original.id], ["reply-check", "after", original.id],
    ["reply-check", "after", original.id], ["reply", "after", original.id],
  ]);
  assert.equal(calls.at(-1)[1].text, original.text);
  assert.equal(calls.at(-1)[1].ambiguous, true);
  assert.equal(JSON.parse(storage.get(key)).id, original.id);
  page.delivered = true;
  run("reconcileOpenCode([{session_id:'fixture', opencode_generation:'after'}], true)");
  await new Promise(setImmediate);
  assert.equal(calls.at(-1)[0], "reply-check");
  assert.equal(storage.size, 0);
});

test("OpenCode restored composers preserve the original ID when either page reconciles first", async () => {
  for (const [winner, edited] of [[0, false], [1, false], [0, true]]) {
    const storage = new Map();
    const calls = [];
    const key = "atlas.opencode.reply.fixture";
    const original = { id: "msg_0123456789abcdefabcdef0123", text: "Original", generation: "same" };
    storage.set(key, JSON.stringify(original));
    const pages = [firstUUID, nextUUID].map(uuid => {
      const area = { value: "", note: {}, closest: () => ({ querySelector: () => area.note }) };
      const page = replyPage(storage, [], uuid, ctx => {
        ctx.addEventListener = (event, callback) => { if (event === "storage") ctx.storageEvent = callback; };
        ctx.document.querySelector = () => area;
        ctx.autosize = () => {};
        ctx.rememberSent = () => {};
        ctx.api = async (_path, body) => {
          calls.push(body);
          return { delivery: "delivered" };
        };
      });
      const run = code => vm.runInContext(code, page);
      run("const drafts = new Map(); const card = {session_id:'fixture', opencode_generation:'same'}");
      area.value = run("openCodeComposerText('fixture')");
      return { page, area, run };
    });
    await pages[winner].run("sendOpenCodeReply(card, 'Original')");
    const other = pages[1 - winner];
    if (edited) other.area.value = "Edited";
    if (edited) {
      other.page.storageEvent({ key, oldValue: JSON.stringify(original), newValue: null,
        storageArea: other.page.localStorage });
      assert.equal(other.area.value, "Edited");
      assert.equal(other.area.note.textContent, "");
    }
    other.page.submitted = edited ? "Edited" : "Original";
    await other.run("sendOpenCodeReply(card, submitted)");
    assert.equal(calls[1].message_id === original.id, !edited);
    assert.equal(calls[1].ambiguous, !edited);
    assert.equal(calls[1].text, other.page.submitted);
  }
});

test("OpenCode clears a saved reply when a newer generation already delivered it", async () => {
  const key = "atlas.opencode.reply.fixture";
  const original = { id: "msg_0123456789abcdefabcdef0123", text: "Original", generation: "before" };
  const storage = new Map([[key, JSON.stringify(original)]]);
  const calls = [];
  const page = replyPage(storage, [], nextUUID, ctx => {
    ctx.saveDrafts = () => {};
    ctx.rememberSent = () => {};
    ctx.api = async (path, body) => {
      calls.push([path.split("/").at(-1), body.message_id]);
      return { delivery: "delivered" };
    };
  });
  const run = code => vm.runInContext(code, page);
  run("const drafts = new Map([['fixture', 'Original']])");
  await run("sendOpenCodeReply({session_id:'fixture', opencode_generation:'after'}, 'Original')");
  assert.deepEqual(calls, [["reply-check", original.id]]);
  assert.equal(storage.has(key), false);
  assert.equal(run("drafts.has('fixture')"), false);
});

test("a composer redrawn during a send allocates a new ID for a later identical message", async () => {
  const storage = new Map();
  const calls = [];
  let next = firstUUID;
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.crypto.randomUUID = () => next;
    ctx.rememberSent = () => {};
    ctx.api = async (_path, body) => {
      calls.push(body);
      assert.equal(vm.runInContext("openCodeComposerText('fixture')", page), "Original");
      return { delivery: "delivered" };
    };
  });
  vm.runInContext("const drafts = new Map(); const card = {session_id:'fixture', opencode_generation:'same'}", page);
  await vm.runInContext("sendOpenCodeReply(card, 'Original')", page);
  next = nextUUID;
  await vm.runInContext("sendOpenCodeReply(card, 'Original')", page);
  assert.notEqual(calls[0].message_id, calls[1].message_id);
});

test("editing an unresolved OpenCode reply preserves its ID until delivery is known", async () => {
  const key = "atlas.opencode.reply.fixture";
  const original = { id: "msg_0123456789abcdefabcdef0123", text: "Original", generation: "same" };
  const storage = new Map([[key, JSON.stringify(original)]]);
  const calls = [];
  const page = replyPage(storage, [], nextUUID, ctx => {
    ctx.rememberSent = () => {};
    ctx.api = async (path, body) => {
      calls.push([path.split("/").at(-1), body]);
      if (!ctx.delivered) throw new Error("offline");
      return { delivery: "delivered" };
    };
  });
  const run = code => vm.runInContext(code, page);
  run("const drafts = new Map(); const card = {session_id:'fixture', opencode_generation:'same'}");
  run("openCodeComposerText('fixture'); drafts.set('fixture', 'Edited')");
  await run("sendOpenCodeReply(card, 'Edited')");
  assert.equal(JSON.parse(storage.get(key)).id, original.id);
  assert.equal(run("drafts.get('fixture')"), "Edited");
  assert.equal(run("sendState.get('fixture').note"), "opencode.retryOriginal");
  assert.deepEqual(calls.map(([op, body]) => [op, body.message_id]), [["reply-check", original.id]]);
  page.delivered = true;
  await run("sendOpenCodeReply(card, 'Edited')");
  assert.equal(calls[1][1].message_id, original.id);
  assert.notEqual(calls[2][1].message_id, original.id);
  assert.equal(calls[2][1].text, "Edited");
});

test("a removal event forgets the old restored ID even if storage already holds a replacement", () => {
  const key = "atlas.opencode.reply.fixture";
  const original = { id: "msg_" + "a".repeat(26), text: "Original" };
  const storage = new Map([[key, JSON.stringify(original)]]);
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.addEventListener = (event, callback) => { if (event === "storage") ctx.storageEvent = callback; };
  });
  const run = code => vm.runInContext(code, page);
  run("const drafts = new Map(); openCodeComposerText('fixture')");
  storage.set(key, JSON.stringify({ id: "msg_" + "b".repeat(26), text: "Replacement" }));
  page.storageEvent({ key, oldValue: JSON.stringify(original), newValue: null, storageArea: page.localStorage });
  assert.equal(run("openCodeRestoredReplies.has('fixture')"), false);
  assert.equal(JSON.parse(storage.get(key)).text, "Replacement");
});

test("simultaneous OpenCode sends keep the first ambiguous ID until it is reconciled", async () => {
  const key = "atlas.opencode.reply.fixture";
  const storage = new Map();
  const calls = [];
  let tail = Promise.resolve();
  const locks = { request(name, callback) {
    assert.equal(name, key);
    const next = tail.then(callback);
    tail = next.catch(() => {});
    return next;
  } };
  const pages = [firstUUID, nextUUID].map(uuid => replyPage(storage, [], uuid, ctx => {
    ctx.navigator = { locks };
    ctx.api = async (path, body) => {
      calls.push([path.split("/").at(-1), body.message_id, body.text]);
      return { delivery: null };
    };
  }));
  const [first, second] = pages;
  let secondSend;
  first.loadStored = (name, fallback) => {
    const value = JSON.parse(storage.get(name) || "null") ?? fallback;
    if (!value && !secondSend) secondSend = reply(second, "Second");
    return value;
  };
  await reply(first, "First");
  await secondSend;
  const id = "msg_" + firstUUID.replaceAll("-", "").slice(0, 26);
  assert.deepEqual(calls, [["reply", id, "First"], ["reply-check", id, undefined]]);
  assert.equal(JSON.parse(storage.get(key)).id, id);
  assert.equal(second.sendState.get("fixture").note, "opencode.retryOriginal");
});

test("an image-only OpenCode reply restores and retries the same attachment and ID after reload", async () => {
  const storage = new Map();
  const calls = [];
  const sid = "fixture";
  const open = uuid => {
    const page = replyPage(storage, calls, uuid, ctx => { ctx.MAX_ATTACH = 5; });
    return code => vm.runInContext(code, page);
  };
  const first = open(firstUUID);
  const reloaded = open(nextUUID);
  first("const drafts = new Map(); const attachments = new Map()");
  await first(`sendOpenCodeReply({session_id:'fixture'}, '', [{path:'/atlas/uploads/fixture.png', name:'image.png'}])`);
  const saved = JSON.parse(storage.get("atlas.opencode.reply." + sid));
  assert.deepEqual(saved.images, [{ path: "/atlas/uploads/fixture.png", name: "image.png" }]);
  reloaded("const drafts = new Map(); const attachments = new Map()");
  assert.equal(reloaded("openCodeComposerText('fixture')"), "");
  assert.equal(reloaded("attachments.get('fixture')[0].name"), "image.png");
  await reloaded(`sendOpenCodeReply({session_id:'fixture'}, '', attachments.get('fixture'))`);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].message_id, saved.id);
  assert.equal(JSON.stringify(calls[1][1].images), JSON.stringify(saved.images));
});


test("a lost native command response blocks another send until explicit acknowledgement", async () => {
  const storage = new Map();
  const submissions = [];
  let confirm;
  const text = "/fixture argument";
  const note = {};
  const area = { value: text, isConnected: true, disabled: false, rows: 1, closest: () => ({ querySelector: () => note }) };
  const page = replyPage(storage, [], firstUUID, ctx => {
    ctx.localStorage.getItem = key => storage.get(key);
    ctx.document.querySelector = () => area;
    ctx.closeAfterHandOff = () => {};
    ctx.saveDrafts = () => {};
    ctx.modal = (_title, warning, _body, _label, callback) => {
      assert.equal(warning, "opencode.pickerUncertain");
      confirm = callback;
    };
    ctx.api = async (path, body) => {
      submissions.push([path, body.id]);
      if (submissions.length === 1) throw Object.assign(new Error("Lost"), { status: 409, state: "live_picker_uncertain" });
      return { ok: true };
    };
  });
  const run = code => vm.runInContext(code, page);
  run("const drafts = new Map(); const card = {session_id:'fixture', opencode_generation:'same'}");
  const submit = () => run("runOpenCodePicker(card, '/fixture argument', [], 'command', {id:'fixture', text:'argument'})");
  await submit();
  await submit();
  assert.equal(submissions.length, 1);
  assert.equal(storage.get("atlas.opencode.picker.fixture"), firstUUID);
  await confirm();
  assert.equal(submissions.length, 2);
  assert.equal(storage.size, 0);
  assert.equal(area.value, "");
});

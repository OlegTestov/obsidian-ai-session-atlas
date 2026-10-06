// The folder field of "+ Session" (web/js/folder-pick.js): matching, the suggestion list, the keys.
// The browser flow is in tests/e2e/folder-pick.spec.mjs.
//   node --test tests/js/
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadPage, pageOrder } from "./helpers/page.mjs";

const page = loadPage(pageOrder().filter((f) => f.startsWith("lang-") || ["i18n.js", "folder-pick.js"].includes(f)));
const FP = page.FolderPick;
const texts = (items) => Array.from(items, (it) => it.text);

const KNOWN = [
  { path: "/h/Code/billing-api", text: "~/Code/billing-api", sessions: 4, recent: true },
  { path: "/h/Notes/Work/Agent Rooms", text: "vault/Work/Agent Rooms", sessions: 9, recent: true },
  { path: "/h/Code/atlas-demo", text: "~/Code/atlas-demo", sessions: 2, recent: true },
  { path: "/h/Notes", text: "vault", sessions: 0, recent: false },
  { path: "/h/Code/ops-scripts", text: "~/Code/ops-scripts", sessions: 0, recent: false },
];

describe("folder field: matching known folders", () => {
  test("an empty field lists the known folders in the server's order: recent first", () => {
    assert.deepEqual(texts(FP.suggest("", KNOWN, null)), KNOWN.map((k) => k.text));
    assert.deepEqual(texts(FP.suggest("   ", KNOWN, null, 2)), KNOWN.slice(0, 2).map((k) => k.text));
  });
  test("start of the text, then start of a part, then inside, then scattered letters", () => {
    assert.equal(FP.score("~/code/billing-api", KNOWN[0]), 0);
    assert.equal(FP.score("~/co", KNOWN[0]), 1);
    assert.equal(FP.score("api", KNOWN[0]), 2);
    assert.equal(FP.score("illing", KNOWN[0]), 3);
    assert.equal(FP.score("blap", KNOWN[0]), 4);
    assert.equal(FP.score("zz", KNOWN[0]), Infinity);
    assert.equal(FP.score("ipa", KNOWN[0]), Infinity);          // letters out of order
  });
  test("every word must match, any case", () => {
    assert.deepEqual(texts(FP.rankKnown("WORK rooms", KNOWN)), ["vault/Work/Agent Rooms"]);
    assert.deepEqual(texts(FP.rankKnown("work billing", KNOWN)), []);
  });
  test("a better match wins; equal ones: recent, then more sessions", () => {
    assert.deepEqual(texts(FP.rankKnown("vault", KNOWN)), ["vault", "vault/Work/Agent Rooms"]);
    assert.deepEqual(texts(FP.rankKnown("code", KNOWN)),
      ["~/Code/billing-api", "~/Code/atlas-demo", "~/Code/ops-scripts"]);
  });
});

describe("folder field: the list under it", () => {
  const listing = { text: "~/Code/b", dirs: [{ path: "/h/Code/beta", text: "~/Code/beta" },
                                             { path: "/h/Code/billing-api", text: "~/Code/billing-api" }] };
  test("a path being typed: subfolders first, known matches after, no repeats", () => {
    const items = FP.suggest("~/Code/b", KNOWN, listing);
    assert.deepEqual(texts(items), ["~/Code/beta", "~/Code/billing-api"]);
    assert.equal(items[1].sessions, 4);                         // the count comes from the known folder
    assert.equal(items[0].kind, "dir");
  });
  test("a name: known folders first", () => {
    const named = { text: "bil", dirs: [{ path: "/x/bilbo", text: "/x/bilbo" }] };
    assert.deepEqual(texts(FP.suggest("bil", KNOWN, named)), ["~/Code/billing-api", "/x/bilbo"]);
  });
  test("an older listing keeps only the folders that continue the new text", () => {
    assert.deepEqual(texts(FP.suggest("~/Code/be", KNOWN, listing)), ["~/Code/beta"]);
  });
  test("paths and names are told apart", () => {
    for (const t of ["/opt", "~", "~/x", "vault/Work"]) assert.equal(FP.looksLikePath(t), true, t);
    for (const t of ["vault", "billing", ""]) assert.equal(FP.looksLikePath(t), false, t);
  });
});

describe("folder field: keys and layout", () => {
  test("down and up wrap; nothing highlighted at first", () => {
    assert.equal(FP.step(3, -1, "ArrowDown"), 0);
    assert.equal(FP.step(3, 2, "ArrowDown"), 0);
    assert.equal(FP.step(3, -1, "ArrowUp"), 2);
    assert.equal(FP.step(3, 0, "ArrowUp"), 2);
    assert.equal(FP.step(3, 1, "ArrowUp"), 0);
    assert.equal(FP.step(0, -1, "ArrowDown"), -1);
    assert.equal(FP.step(3, 1, "x"), 1);
  });
  test("Tab goes into the folder: a trailing slash, never two", () => {
    assert.equal(FP.completion({ text: "~/Code" }), "~/Code/");
    assert.equal(FP.completion({ text: "/" }), "/");
  });
  test("the list stops above the Start row, within bounds", () => {
    assert.equal(FP.listMaxHeight(100, 400), 292);
    assert.equal(FP.listMaxHeight(100, 1000), 320);
    assert.equal(FP.listMaxHeight(100, 120), 96);
  });
  test("the line under the field: resolved path, or the error once no suggestion helps", () => {
    const ok = { text: "vault", folder: { path: "/h/Notes", text: "vault" }, error: null, dirs: [] };
    assert.deepEqual({ ...FP.hint("vault", ok, []) }, { kind: "ok", text: "/h/Notes" });
    const same = { text: "/h/Notes", folder: { path: "/h/Notes", text: "vault" }, error: null, dirs: [] };
    assert.deepEqual({ ...FP.hint("/h/Notes", same, []) }, { kind: "ok", text: "" });
    const bad = { text: "/nope", folder: null, error: "no such folder: /nope", dirs: [] };
    assert.deepEqual({ ...FP.hint("/nope", bad, []) }, { kind: "bad", text: "no such folder: /nope" });
    assert.deepEqual({ ...FP.hint("/nope", bad, [{ text: "x" }]) }, { kind: "", text: "" });
    assert.deepEqual({ ...FP.hint("/nop", bad, []) }, { kind: "", text: "" });    // answer for older text
  });
});

describe("folder field: strings", () => {
  test("both languages have the plural forms", () => {
    for (const lang of ["en", "ru"]) {
      page.I18N.setLang(lang);
      assert.match(page.i18nN("newsess.sessions", 5), /5/);
    }
    page.I18N.setLang("ru");
    assert.equal(page.i18nN("newsess.sessions", 2), "2 сессии");
  });
});

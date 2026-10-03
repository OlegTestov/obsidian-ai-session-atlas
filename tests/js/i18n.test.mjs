// Page translations:
//   1. page code (outside the dictionaries) has no Cyrillic in strings or in markup text;
//   2. every key of i18n("…") / i18nN("…") / data-i18n="…" exists in both en and ru;
//   3. en and ru have the same keys; plural forms: ru has 3, en has 2.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JS, ROOT, WEB, loadPage, pageOrder } from "./helpers/page.mjs";

const CYR = /[А-Яа-яЁё]/;

/** JS strings and templates without comments: [{line, text}]. Regexes are skipped as /…/. */
function jsStrings(src) {
  const out = [];
  let i = 0, line = 1, prev = "";
  const push = (text, at) => out.push({ line: at, text });
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const at = line; let j = i + 1, text = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { text += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === "\n") line++;
        text += src[j]; j++;
      }
      push(text, at); i = j + 1; prev = c; continue;
    }
    // A regex: "/" where it cannot be a division.
    if (c === "/" && /[(,=:[!&|?{};]|^$/.test(prev.trim() || "")) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      i = j + 1; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

function htmlProblems(src) {
  const out = [];
  src.split("\n").forEach((l, n) => {
    const visible = l.replace(/<script[^>]*>.*?<\/script>/g, "").replace(/<!--.*?-->/g, "");
    const texts = [...visible.matchAll(/>([^<]+)</g)].map((m) => m[1])
      .concat([...visible.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)].map((m) => m[1]));
    for (const t of texts) if (CYR.test(t)) out.push({ line: n + 1, text: t.trim() });
  });
  return out;
}

function keysUsed(src) {
  const keys = [];
  for (const m of src.matchAll(/\bi18nN?\(\s*["'`]([^"'`$]+)["'`]/g)) keys.push(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) keys.push(m[1]);
  return keys;
}

// The dictionaries, loaded the browser way: i18n.js first, then every lang-*.js.
const { dicts } = loadPage(pageOrder().filter((f) => f === "i18n.js" || f.startsWith("lang-"))).I18N;

const pageFiles = fs.readdirSync(JS).filter((f) => f.endsWith(".js") && f !== "i18n.js" && !f.startsWith("lang-"))
  .map((f) => path.join(JS, f)).concat([path.join(WEB, "index.html")]);

describe("page code", () => {
  for (const file of pageFiles) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, "utf8");
    test(`${rel}: no Cyrillic in strings or markup text`, () => {
      const found = file.endsWith(".html") ? htmlProblems(src) : jsStrings(src).filter((s) => CYR.test(s.text));
      assert.deepEqual(found.map((f) => `${rel}:${f.line} ${JSON.stringify(f.text.slice(0, 80))}`), []);
    });
    test(`${rel}: every i18n key exists in en and ru`, () => {
      const missing = [];
      for (const key of keysUsed(src)) {
        for (const lg of ["en", "ru"]) if (!(key in dicts[lg])) missing.push(`${key} (${lg})`);
      }
      assert.deepEqual(missing, []);
    });
  }
});

describe("dictionaries", () => {
  const en = Object.keys(dicts.en), ru = Object.keys(dicts.ru);
  test("every en key exists in ru", () => assert.deepEqual(en.filter((k) => !(k in dicts.ru)), []));
  test("every ru key exists in en", () => assert.deepEqual(ru.filter((k) => !(k in dicts.en)), []));
  test("plural forms exist in both languages, en has 2 and ru has 3", () => {
    const bad = [];
    for (const k of en) {
      const e = dicts.en[k], r = dicts.ru[k];
      if (Array.isArray(e) !== Array.isArray(r)) bad.push(`${k}: plural form in one language only`);
      else if (Array.isArray(e) && (e.length !== 2 || r.length !== 3)) bad.push(`${k}: needs en[2], ru[3]`);
    }
    assert.deepEqual(bad, []);
  });
});

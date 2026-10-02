/**
 * Проверка переводов страницы:
 *   1. в коде страницы (кроме словарей) нет кириллицы в строках и в тексте разметки;
 *   2. каждый ключ i18n("…") / i18nN("…") / data-i18n="…" есть и в en, и в ru;
 *   3. у en и ru одинаковые ключи; формы по числу: ru — 3, en — 2.
 *
 *   node tools/check_i18n.js            — вся страница
 *   node tools/check_i18n.js a.js b.js  — только эти файлы (пункты 1–2), словари — всегда целиком
 */
const fs = require("fs");
const path = require("path");

const WEB = path.join(__dirname, "..", "web");
const JS = path.join(WEB, "js");
const CYR = /[А-Яа-яЁё]/;

/** Строки и шаблоны JS без комментариев: [{line, text}]. Регулярки пропускаются по «/…/». */
function jsStrings(src) {
  const out = [];
  let i = 0, line = 1, prev = "";
  const push = (text, at) => out.push({ line: at, text });
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const at = line; let j = i + 1, text = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { text += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === "\n") line++;
        text += src[j]; j++;
      }
      push(text, at); i = j + 1; prev = c; continue;
    }
    // Регулярка: «/» там, где не может быть делением.
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
  const lines = src.split("\n");
  lines.forEach((l, n) => {
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

const I = require(path.join(JS, "i18n.js"));
for (const f of fs.readdirSync(JS).filter((f) => /^lang-.*\.js$/.test(f)).sort()) require(path.join(JS, f));

const all = fs.readdirSync(JS).filter((f) => f.endsWith(".js") && f !== "i18n.js" && !f.startsWith("lang-"))
  .map((f) => path.join(JS, f)).concat([path.join(WEB, "index.html")]);
const targets = process.argv.slice(2).length ? process.argv.slice(2).map((f) => path.resolve(f)) : all;

const problems = [];
for (const file of targets) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(path.join(WEB, ".."), file);
  const found = file.endsWith(".html") ? htmlProblems(src) : jsStrings(src).filter((s) => CYR.test(s.text));
  for (const f of found) problems.push(`${rel}:${f.line} кириллица в строке: ${JSON.stringify(f.text.slice(0, 80))}`);
  for (const key of keysUsed(src)) {
    for (const lg of ["en", "ru"]) {
      if (!(key in I.dicts[lg])) problems.push(`${rel}: нет ключа ${key} в ${lg}`);
    }
  }
}
const en = Object.keys(I.dicts.en), ru = Object.keys(I.dicts.ru);
for (const k of en) if (!(k in I.dicts.ru)) problems.push(`словарь: ${k} есть в en, нет в ru`);
for (const k of ru) if (!(k in I.dicts.en)) problems.push(`словарь: ${k} есть в ru, нет в en`);
for (const k of en) {
  const e = I.dicts.en[k], r = I.dicts.ru[k];
  if (Array.isArray(e) !== Array.isArray(r)) problems.push(`словарь: ${k} — форма по числу только в одном языке`);
  else if (Array.isArray(e) && (e.length !== 2 || r.length !== 3)) problems.push(`словарь: ${k} — нужно en[2], ru[3]`);
}
problems.forEach((p) => console.log("  " + p));
console.log(problems.length ? `\n${problems.length} проблем с переводом` : `\nпереводы в порядке (${en.length} ключей)`);
process.exit(problems.length ? 1 : 0);

// Два языка страницы: en и ru. Строки — в словарях lang-*.js (по областям), здесь только механика.
// Язык: ?lang= в адресе (его ставит плагин — язык Obsidian или выбранный в настройках), иначе язык
// браузера. Классический скрипт и модуль node одновременно: логику страницы тестируют в node.
(function (root) {
  const dicts = { en: {}, ru: {} };
  let lang = "en";

  /** Добавить часть словаря: {en: {key: text}, ru: {key: text}}. Ключи областей не пересекаются. */
  function add(part) {
    for (const [lg, entries] of Object.entries(part || {})) {
      dicts[lg] = dicts[lg] || {};
      for (const [key, value] of Object.entries(entries)) {
        if (key in dicts[lg] && dicts[lg][key] !== value) throw new Error(`i18n: ключ ${key} уже есть (${lg})`);
        dicts[lg][key] = value;
      }
    }
  }

  function setLang(value) {
    lang = String(value || "").toLowerCase().startsWith("ru") ? "ru" : "en";
    if (root.document && root.document.documentElement) root.document.documentElement.lang = lang;
    return lang;
  }

  function lookup(key) {
    if (key in dicts[lang]) return dicts[lang][key];
    if (key in dicts.en) return dicts.en[key];
    return key;                                   // нет перевода — ключ виден сразу, тест это ловит
  }

  function fill(text, vars) {
    return vars ? String(text).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text;
  }

  /** Строка по ключу; {имя} заменяется из vars. */
  function i18n(key, vars) {
    return fill(lookup(key), vars);
  }

  /** Форма по числу: в словаре — массив [one, few, many] для ru и [one, other] для en; {n} — само число. */
  function i18nN(key, n, vars) {
    const forms = lookup(key);
    if (!Array.isArray(forms)) return fill(forms, Object.assign({ n }, vars));
    return fill(forms[pluralIndex(lang, n)] || forms[forms.length - 1], Object.assign({ n }, vars));
  }

  function pluralIndex(lg, n) {
    const a = Math.abs(Number(n)) || 0;
    if (lg !== "ru") return a === 1 ? 0 : 1;
    const m10 = a % 10, m100 = a % 100;
    if (m10 === 1 && m100 !== 11) return 0;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
    return 2;
  }

  /** Локаль для дат и чисел. */
  function locale() {
    return lang === "ru" ? "ru-RU" : "en-GB";
  }

  /** Разметка: data-i18n — текст, data-i18n-title / -placeholder / -aria-label — атрибуты. */
  function applyDom(doc) {
    doc.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = i18n(el.dataset.i18n); });
    for (const attr of ["title", "placeholder", "aria-label"]) {
      doc.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        el.setAttribute(attr, i18n(el.getAttribute(`data-i18n-${attr}`)));
      });
    }
  }

  const api = { add, setLang, lang: () => lang, i18n, i18nN, locale, dicts, pluralIndex, applyDom };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.I18N = api;
    root.i18n = i18n;
    root.i18nN = i18nN;
    let wanted = null;
    try { wanted = new URLSearchParams(root.location.search).get("lang"); } catch (e) { /* нет адреса */ }
    setLang(wanted || (root.navigator && root.navigator.language) || "en");
    // Скрипты страницы — в конце body: разметка уже есть, словари подключены раньше этого вызова.
    root.addEventListener("DOMContentLoaded", () => applyDom(root.document));
  }
})(typeof window !== "undefined" ? window : globalThis);

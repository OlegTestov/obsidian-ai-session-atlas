// The page's two languages: en and ru. Strings live in the lang-*.js dictionaries (by area); this file holds the mechanics.
// Language: ?lang= in the address (the plugin sets it from Obsidian's language or the settings), otherwise
// the browser language. Classic script; tests load it into a node:vm context the same way.
(function (root) {
  const dicts = { en: {}, ru: {} };
  let lang = "en";

  /** Add a part of the dictionary: {en: {key: text}, ru: {key: text}}. Area keys do not overlap. */
  function add(part) {
    for (const [lg, entries] of Object.entries(part || {})) {
      dicts[lg] = dicts[lg] || {};
      for (const [key, value] of Object.entries(entries)) {
        if (key in dicts[lg] && dicts[lg][key] !== value) throw new Error(`i18n: key ${key} already exists (${lg})`);
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
    return key;                                   // missing translation: the key shows at once, and the test catches it
  }

  function fill(text, vars) {
    return vars ? String(text).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text;
  }

  /** String by key; {name} is replaced from vars. */
  function i18n(key, vars) {
    return fill(lookup(key), vars);
  }

  /** Plural form: the dictionary holds [one, few, many] for ru and [one, other] for en; {n} is the number. */
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

  /** Locale for dates and numbers. */
  function locale() {
    return lang === "ru" ? "ru-RU" : "en-GB";
  }

  /** Markup: data-i18n is the text, data-i18n-title / -placeholder / -aria-label are attributes. */
  function applyDom(doc) {
    doc.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = i18n(el.dataset.i18n); });
    for (const attr of ["title", "placeholder", "aria-label"]) {
      doc.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        el.setAttribute(attr, i18n(el.getAttribute(`data-i18n-${attr}`)));
      });
    }
  }

  const api = { add, setLang, lang: () => lang, i18n, i18nN, locale, dicts, pluralIndex, applyDom };
  root.I18N = api;
  root.i18n = i18n;
  root.i18nN = i18nN;
  let wanted = null;
  try { wanted = new URLSearchParams(root.location.search).get("lang"); } catch { /* no address */ }
  setLang(wanted || (root.navigator && root.navigator.language) || "en");
  // Page scripts sit at the end of body: the markup exists and the dictionaries load before this call.
  root.addEventListener("DOMContentLoaded", () => applyDom(root.document));
})(window);

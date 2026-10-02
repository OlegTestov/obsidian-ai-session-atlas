// Строки страницы: ответы сервера и плагина, которые видны на странице. Ключи — с префиксом «server.»; en и ru — одинаковый набор ключей.
// Множественное число — массивом: ru [one, few, many], en [one, other]; {n} — само число.
(function (root) {
  const I = typeof module !== "undefined" && module.exports ? require("./i18n.js") : root.I18N;
  I.add({
    en: {
    },
    ru: {
    },
  });
})(typeof window !== "undefined" ? window : globalThis);

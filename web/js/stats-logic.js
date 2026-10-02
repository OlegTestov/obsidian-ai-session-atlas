// «Статистика»: форматы чисел и расчёты без DOM — проверяются в node (tools/test_page.js).
(function (root) {
  const node = typeof module !== "undefined" && module.exports;
  const I18 = node ? require("./i18n.js") : root.I18N;
  if (node) require("./lang-views.js");
  const tr = (key, vars) => I18.i18n(key, vars);

  // Подписи — геттеры: язык выбирается после загрузки модуля.
  const period = (value, withPrev) => ({ value,
    get label() { return tr("stats.period." + value); },
    get prev() { return withPrev ? tr("stats.period." + value + ".prev") : null; } });
  const PERIODS = [period("today", true), period("7d", true), period("30d", true), period("90d", true),
                   period("all", false)];
  const METRICS = [
    { value: "cost", get label() { return tr("stats.metric.cost"); } },
    { value: "tokens", get label() { return tr("stats.metric.tokens"); } },
    { value: "active_s", get label() { return tr("stats.metric.time"); } },
  ];

  // ru: «18,9», группы через неразрывный пробел; en: «18.9», группы через запятую.
  const ru = () => I18.lang() === "ru";
  const group = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ru() ? "\u00a0" : ",");
  /** Десятичная точка по языку: «12.5» → «12,5» в ru. */
  const decimal = text => (ru() ? String(text).replace(".", ",") : String(text));
  const comma = (n, digits) => decimal(n.toFixed(digits).replace(/\.0+$/, ""));

  /** 18 895 000 000 → «18,9 млрд» (en «18.9B»); 540 → «540». */
  function bigNum(n) {
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return tr("stats.num.billion", { n: comma(n / 1e9, a >= 1e11 ? 0 : 1) });
    if (a >= 1e6) return tr("stats.num.million", { n: comma(n / 1e6, a >= 1e8 ? 0 : 1) });
    if (a >= 1e4) return tr("stats.num.thousand", { n: comma(n / 1e3, 0) });
    return group(n);
  }

  /** 16 200 с → «4 ч 30 мин»; от 10 ч — только часы; меньше часа — минуты. */
  function hoursText(sec) {
    if (sec == null) return "—";
    const min = Math.round(sec / 60);
    if (min < 60) return tr("stats.num.minutes", { m: min });
    const h = Math.floor(min / 60), m = min % 60;
    if (h >= 10) return tr("stats.num.hours", { h: group(Math.round(sec / 3600)) });
    return m ? tr("stats.num.hoursMinutes", { h, m: String(m).padStart(2, "0") }) : tr("stats.num.hours", { h });
  }

  function money(v) {
    if (v == null) return "—";
    return "$" + (v >= 100 ? group(v) : decimal(v.toFixed(2)));
  }

  function metricText(metric, v) {
    return metric === "cost" ? money(v) : metric === "tokens" ? bigNum(v) : hoursText(v);
  }

  /** Сравнение с прошлым отрезком: {text:"+12%", dir:"up"} или null, если сравнивать не с чем. */
  function delta(cur, prev) {
    if (cur == null || prev == null || prev <= 0) return null;
    const pct = Math.round((cur - prev) / prev * 100);
    if (pct === 0) return { text: "±0%", dir: null };
    return { text: (pct > 0 ? "+" : "−") + group(Math.abs(pct)) + "%", dir: pct > 0 ? "up" : "down" };
  }

  /** Подпись столбца: день «28.09», час «14:00». t — «2026-09-28» или «2026-09-28 14». */
  function pointLabel(t, unit) {
    if (unit === "hour") return t.slice(11, 13) + ":00";
    return t.slice(8, 10) + "." + t.slice(5, 7);
  }

  /** Какие подписи оставить под столбцами, чтобы не слиплись: не больше max штук. */
  function labelStep(count, max) {
    return Math.max(1, Math.ceil(count / (max || 12)));
  }

  /** Доля от максимума в процентах, для высоты столбца или длины полосы. */
  function share(v, max) {
    if (!max || !v || v < 0) return 0;
    return Math.min(100, v / max * 100);
  }

  /** Уровень клетки «ритма» 0–4: 0 — пусто, 4 — не меньше 3/4 максимума. */
  function heatLevel(v, max) {
    if (!v || !max) return 0;
    return Math.min(4, Math.max(1, Math.ceil(v / max * 4)));
  }

  /** Строки разбивки по выбранной мере, по убыванию; пустые отброшены. */
  function ranked(items, metric, limit) {
    return (items || []).filter(i => i[metric] > 0)
      .sort((a, b) => b[metric] - a[metric]).slice(0, limit || items.length);
  }

  const api = { PERIODS, METRICS, decimal, bigNum, hoursText, money, metricText, delta, pointLabel,
                labelStep, share, heatLevel, ranked };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StatsLogic = api;
})(typeof window !== "undefined" ? window : globalThis);

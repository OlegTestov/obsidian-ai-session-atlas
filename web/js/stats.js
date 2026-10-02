// Вкладка «Статистика»: итоги за период, график по дням или часам, разбивки и ритм недели.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// Числа считает сервер (atlas/stats.py), здесь — только вид. Выбор периода и меры помнит
// браузер: это удобство одного окна, пропадёт — не страшно.
const S = window.StatsLogic;
const STATS_KEY = "atlas.stats";
const WEEKDAYS = i18n("stats.weekdays").split(" ");
const LIST_ROWS = 8;

let statsPrefs = Object.assign({ period: "7d", metric: "cost", auto: false },
  (() => { try { return JSON.parse(localStorage.getItem(STATS_KEY) || "{}"); } catch (e) { return {}; } })());
let statsData = null;
let statsSeq = 0;

function saveStatsPrefs() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(statsPrefs)); } catch (e) { /* приватное окно */ }
}

function renderStatsBar() {
  const auto = el("label", "chk");
  const box = el("input");
  box.type = "checkbox";
  box.checked = statsPrefs.auto;
  box.addEventListener("change", () => { statsPrefs.auto = box.checked; saveStatsPrefs(); loadStats(); });
  auto.append(box, " " + i18n("stats.auto"));
  auto.title = i18n("stats.auto.hint");
  const note = el("span", "shown", statsData ? i18n("stats.updated", { time: new Date().toLocaleTimeString(I18N.locale(),
    { hour: "2-digit", minute: "2-digit" }) }) : "");
  $("#stats-bar").replaceChildren(
    segButtons(S.PERIODS, statsPrefs.period, v => { statsPrefs.period = v; saveStatsPrefs(); loadStats(); }),
    auto,
    segButtons(S.METRICS, statsPrefs.metric, v => { statsPrefs.metric = v; saveStatsPrefs(); renderStats(); }, "metric"),
    note);
}

async function loadStats() {
  renderStatsBar();
  const seq = ++statsSeq;
  if (!statsData) $("#stats-body").replaceChildren(el("p", "empty", i18n("stats.loading")));
  try {
    const data = await api(`/api/stats?period=${encodeURIComponent(statsPrefs.period)}&auto=${statsPrefs.auto ? 1 : 0}`);
    if (seq !== statsSeq) return;                 // пока ждали, выбрали другой период
    statsData = data;
  } catch (e) {
    if (seq === statsSeq && !statsData) $("#stats-body").replaceChildren(el("p", "empty", i18n("stats.error", { msg: e.message })));
    return;
  }
  renderStatsBar();
  renderStats();
}

// --- плитки итогов ---------------------------------------------------------------

function tile(title, value, sub, dlt, hint) {
  const t = el("div", "tile");
  if (hint) t.title = hint;
  t.appendChild(el("div", "tt", title));
  const v = el("div", "tv", value);
  if (dlt) {
    const d = el("span", "delta " + (dlt.dir || ""), dlt.text);
    d.title = S.PERIODS.find(p => p.value === statsData.period).prev;
    v.appendChild(d);
  }
  t.appendChild(v);
  if (sub) t.appendChild(sub instanceof Node ? sub : el("div", "ts", sub));
  return t;
}

function tokenBar(tk) {
  const box = el("div", "ts");
  const bar = el("div", "tbar");
  const parts = [["in", tk.input, i18n("stats.tok.input")], ["cache", tk.cache_read, i18n("stats.tok.cache")],
                 ["out", tk.output, i18n("stats.tok.output")]];
  parts.forEach(([cls, v]) => {
    const seg = el("span", cls);
    seg.style.width = S.share(v, tk.total) + "%";
    bar.appendChild(seg);
  });
  box.appendChild(bar);
  const legend = el("div", "legend");
  parts.forEach(([cls, v, label]) => {
    const item = el("span");
    item.append(el("i", cls), `${label} ${S.bigNum(v)}`);
    legend.appendChild(item);
  });
  box.appendChild(legend);
  return box;
}

function renderTiles(d) {
  const t = d.totals, p = d.previous;
  const diff = key => p ? S.delta(key(t), key(p)) : null;
  const unpriced = t.unpriced_models.length ? i18n("stats.unpriced", { list: t.unpriced_models.join(", ") }) : "";
  const box = el("div", "tiles");
  box.append(
    tile(i18n("stats.tile.sessions"), S.bigNum(t.sessions),
         i18n("stats.tile.sessions.sub", { prompts: S.bigNum(t.prompts), answers: S.bigNum(t.answers) }),
         diff(x => x.sessions), i18n("stats.tile.sessions.hint")),
    tile(i18n("stats.tile.tokens"), S.bigNum(t.tokens.total), tokenBar(t.tokens), diff(x => x.tokens.total),
         i18n("stats.tile.tokens.hint")),
    tile(i18n("stats.tile.time"), S.hoursText(t.wall_s), i18n("stats.tile.time.sub", { time: S.hoursText(t.active_s) }),
         diff(x => x.wall_s), i18n("stats.tile.time.hint")),
    tile(i18n("stats.tile.cost"), S.money(t.cost), i18n("stats.tile.cost.sub") + unpriced,
         diff(x => x.cost), i18n("stats.tile.cost.hint")),
    tile(i18n("stats.tile.cache"), t.cache_hit == null ? "—" : S.decimal(Math.round(t.cache_hit * 1000) / 10) + "%",
         i18n("stats.tile.cache.sub"), null, i18n("stats.tile.cache.hint")));
  return box;
}

// --- график -------------------------------------------------------------------------

function renderChart(d) {
  const metric = statsPrefs.metric;
  const pts = d.series.points;
  const panel = el("div", "spanel chart");
  const title = d.series.unit === "hour" ? i18n("stats.chart.hours") : i18n("stats.chart.days");
  panel.appendChild(el("h3", null, `${title} · ${S.METRICS.find(m => m.value === metric).label.toLowerCase()}`));
  if (!pts.length) { panel.appendChild(el("p", "none", i18n("stats.chart.empty"))); return panel; }
  const max = Math.max(...pts.map(p => p[metric]));
  const bars = el("div", "bars");
  const step = S.labelStep(pts.length, 14);
  pts.forEach((p, i) => {
    const col = el("div", "col");
    const bar = el("div", "bar");
    bar.style.height = S.share(p[metric], max) + "%";
    col.title = i18n("stats.chart.pointHint", {
      when: S.pointLabel(p.t, d.series.unit) + (d.series.unit === "day" ? "." + p.t.slice(0, 4) : ""),
      cost: S.money(p.cost), tokens: S.bigNum(p.tokens), time: S.hoursText(p.active_s), sessions: p.sessions });
    col.appendChild(bar);
    col.appendChild(el("span", "x", i % step === 0 ? S.pointLabel(p.t, d.series.unit) : ""));
    bars.appendChild(col);
  });
  const top = el("div", "ymax", S.metricText(metric, max));
  panel.append(top, bars);
  return panel;
}

// --- разбивки -------------------------------------------------------------------------

function breakdown(title, items, opts) {
  const metric = statsPrefs.metric;
  const panel = el("div", "spanel");
  panel.appendChild(el("h3", null, title));
  const rows = S.ranked(items, metric, LIST_ROWS);
  if (!rows.length) { panel.appendChild(el("p", "none", i18n("stats.noData"))); return panel; }
  const max = rows[0][metric];
  rows.forEach(r => {
    const row = el("div", "brow" + (opts && opts.onPick ? " link" : ""));
    const name = el("span", "bn", (opts && opts.label ? opts.label(r) : r.name));
    const fill = el("span", "bf");
    fill.style.width = S.share(r[metric], max) + "%";
    const track = el("span", "bt");
    track.appendChild(fill);
    row.append(name, track, el("span", "bv", S.metricText(metric, r[metric])));
    row.title = i18n("stats.row.hint", { name: opts && opts.label ? opts.label(r) : r.name, cost: S.money(r.cost),
      tokens: S.bigNum(r.tokens), time: S.hoursText(r.active_s) })
      + (r.prompts ? i18n("stats.row.prompts", { n: r.prompts }) : "");
    if (opts && opts.onPick) row.addEventListener("click", () => opts.onPick(r));
    panel.appendChild(row);
  });
  return panel;
}

function countPanel(title, tools) {
  const panel = el("div", "spanel");
  panel.appendChild(el("h3", null, title));
  if (!tools.length) { panel.appendChild(el("p", "none", i18n("stats.noData"))); return panel; }
  const max = tools[0].count;
  tools.slice(0, LIST_ROWS).forEach(t => {
    const row = el("div", "brow");
    const track = el("span", "bt");
    const fill = el("span", "bf");
    fill.style.width = S.share(t.count, max) + "%";
    track.appendChild(fill);
    row.append(el("span", "bn", t.name), track, el("span", "bv", S.bigNum(t.count)));
    panel.appendChild(row);
  });
  return panel;
}

function rhythmPanel(week) {
  const panel = el("div", "spanel wide");
  panel.appendChild(el("h3", null, i18n("stats.rhythm")));
  const max = Math.max(0, ...week.flat());
  const grid = el("div", "heat");
  grid.appendChild(el("span"));
  for (let h = 0; h < 24; h++) grid.appendChild(el("span", "hx", h % 3 === 0 ? String(h) : ""));
  week.forEach((day, i) => {
    grid.appendChild(el("span", "hy", WEEKDAYS[i]));
    day.forEach((v, h) => {
      const c = el("span", "cell l" + S.heatLevel(v, max));
      c.title = `${WEEKDAYS[i]} ${String(h).padStart(2, "0")}:00 — ${S.hoursText(v)}`;
      grid.appendChild(c);
    });
  });
  panel.appendChild(grid);
  return panel;
}

function renderStats() {
  const d = statsData;
  if (!d) return;
  const openSession = r => { setView("search"); openCard(r.session_id); };
  const panels = el("div", "spanels");
  panels.append(
    breakdown(i18n("stats.panel.domains"), d.domains),
    breakdown(i18n("stats.panel.models"), d.models),
    breakdown(i18n("stats.panel.topics"), d.topics),
    ...(d.projects.length > 1 ? [breakdown(i18n("stats.panel.projects"), d.projects)] : []),
    breakdown(i18n("stats.panel.sessions"), d.sessions, { onPick: openSession, label: r => r.name }),
    countPanel(i18n("stats.panel.tools"), d.tools),
    countPanel(i18n("stats.panel.skills"), d.skills),
    countPanel(i18n("stats.panel.agents"), d.agents),
    rhythmPanel(d.week));
  $("#stats-body").replaceChildren(renderTiles(d), renderChart(d), panels);
}

registerView("stats", { tab: "#view-stats", panel: "#stats", show: loadStats });

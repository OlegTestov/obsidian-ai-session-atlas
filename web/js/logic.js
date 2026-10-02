// Чистая логика вкладки «Активные»: без DOM и сети — тестируется в node (tools/test_page.js).
(function (root) {
  const node = typeof module !== "undefined" && module.exports;
  const I18 = node ? require("./i18n.js") : root.I18N;
  if (node) require("./lang-views.js");
  const decimal = text => (I18.lang() === "ru" ? text.replace(".", ",") : text);

  // Склонение по-русски; строки страницы склоняет i18nN, эта — для совместимости.
  function pluralRu(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // Отрезки не пересекаются — поэтому несколько галочек в периоде тоже имеют смысл.
  // Подпись — геттер: язык выбирается после загрузки модуля.
  const PERIODS = [
    { value: "hour", get label() { return I18.i18n("logic.period.hour"); } },
    { value: "today", get label() { return I18.i18n("logic.period.today"); } },
    { value: "yesterday", get label() { return I18.i18n("logic.period.yesterday"); } },
    { value: "week", get label() { return I18.i18n("logic.period.week"); } },
    { value: "older", get label() { return I18.i18n("logic.period.older"); } },
  ];

  function periodOf(iso, now) {
    if (!iso) return "older";
    const t = new Date(iso);
    now = now || new Date();
    if (now - t < 36e5) return "hour";
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(now) - day(t)) / 864e5);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days <= 7) return "week";
    return "older";
  }

  function valuesOf(s, key, now) {
    if (key === "domain") return s.domains || [];
    if (key === "project") return s.projects || [];
    if (key === "topic") return s.topic ? [s.topic] : [];
    return [periodOf(s.last_message_at, now)];
  }

  // filters — {key: Set}; except — фильтр, который не учитывается (для счётчиков его же списка).
  function passes(s, filters, except, now) {
    return Object.keys(filters).every(key => {
      const want = filters[key];
      return key === except || !want.size || valuesOf(s, key, now).some(v => want.has(v));
    });
  }

  // Значения списка со счётчиками при остальных фильтрах; выбранное остаётся, даже если 0.
  function filterOptions(sessions, filters, key, now) {
    const counts = new Map();
    sessions.filter(s => passes(s, filters, key, now))
      .forEach(s => valuesOf(s, key, now).forEach(v => counts.set(v, (counts.get(v) || 0) + 1)));
    if (key === "period") {
      return PERIODS.filter(p => counts.has(p.value) || filters[key].has(p.value))
        .map(p => ({ value: p.value, label: p.label, count: counts.get(p.value) || 0 }));
    }
    return [...new Set([...counts.keys(), ...filters[key]])].sort((a, b) => a.localeCompare(b, "ru"))
      .map(v => ({ value: v, label: v, count: counts.get(v) || 0 }));
  }

  function parseLayout(value, max) {
    const m = /^([1-5])x([1-5])$/.exec(value || "");
    return m && +m[1] <= max && +m[2] <= max ? { c: +m[1], r: +m[2] } : null;
  }

  // Что разбудит сессию без тебя — словами; время форматирует вызывающий.
  function backgroundReasons(b, fmtTime) {
    if (!b) return [];
    const out = [];
    if (b.shells) out.push(b.shells === 1 ? I18.i18n("logic.bg.shell") : I18.i18n("logic.bg.shells", { n: b.shells }));
    if (b.agents) out.push(I18.i18nN("logic.bg.agents", b.agents));
    if (b.wake_at) out.push(I18.i18n("logic.bg.wake", { time: fmtTime ? fmtTime(b.wake_at) : b.wake_at }));
    if (b.crons) out.push(I18.i18n("logic.bg.cron"));
    return out;
  }

  // Твоё сообщение без ответа: только что отправленное (пока транскрипт не догнал) или из
  // транскрипта. dropSent — отправленное из карточки уже не нужно держать.
  function unansweredPrompt(s, sent) {
    const t = iso => (iso ? new Date(iso).getTime() : 0);
    let dropSent = false;
    if (sent && (t(s.reply_at) > t(sent.at) || t(s.prompt_at) >= t(sent.at) - 2000)) {
      dropSent = true;
      sent = null;
    }
    if (sent) return { prompt: { text: sent.text, images: sent.images, at: sent.at, sent: true },
                       dropSent };
    if (s.prompt && t(s.prompt_at) > t(s.reply_at)) {
      return { prompt: { text: s.prompt, images: s.prompt_images || 0, at: s.prompt_at,
                         interrupted: t(s.interrupted_at) >= t(s.prompt_at) }, dropSent };
    }
    return { prompt: null, dropSent };
  }

  // Где только что отправленное из карточки, пока транскрипт его не показал: в очереди (набрано,
  // пока Claude работал), ещё в пути — или пропало (вкладка не приняла ввод, диалог перехватил).
  const DELIVERY_WAIT_MS = 15000;
  function deliveryState(s, sent, now) {
    if (!sent) return null;
    const head = (sent.text || "").trim().slice(0, 40);
    if (head && (s.queued || []).some(q => (q.text || "").trim().startsWith(head))) return "queued";
    if (head && now - new Date(sent.at).getTime() > DELIVERY_WAIT_MS) return "lost";
    return "sending";
  }

  // Подсказки слэш-команд: пока набрано «/слово» без пробела. Сначала — начинающиеся с набранного.
  function commandMatches(list, text) {
    const m = /^\/([^\s]*)$/.exec(text || "");
    if (!m) return [];
    const q = m[1].toLowerCase();
    const starts = list.filter(c => c.name.toLowerCase().startsWith(q));
    const inside = q ? list.filter(c => !c.name.toLowerCase().startsWith(q)
      && c.name.toLowerCase().includes(q)) : [];
    return starts.concat(inside);
  }

  // История отправленного, как в шелле: index −1 — свой черновик, 0 — последнее отправленное.
  function historyStep(history, index, dir) {
    const next = Math.max(-1, Math.min(history.length - 1, index + (dir === "up" ? 1 : -1)));
    return { index: next, text: next < 0 ? null : history[history.length - 1 - next] };
  }

  // Контекст сессии: доля окна и тон — от 80% уже близко к автоматической компактации.
  function contextLevel(s) {
    if (!s.context_tokens || !s.context_window) return null;
    const pct = Math.round(100 * s.context_tokens / s.context_window);
    return { pct, tone: pct >= 80 ? "warn" : pct >= 60 ? "mid" : "ok",
             text: I18.i18n("logic.context", { pct }),
             hint: I18.i18n("logic.context.hint", { used: Math.round(s.context_tokens / 1000),
                                                    window: Math.round(s.context_window / 1000) })
               + (pct >= 80 ? I18.i18n("logic.context.soon") : "") };
  }

  // Недельный лимит и лимит 5 часов — строкой для верхней панели; устаревшее помечаем.
  function limitsText(l, fmtWhen) {
    if (!l || !l.windows || !l.windows.length) return null;
    const parts = l.windows.map(w => `${w.label} ${Math.round(w.used_percentage)}%`
      + (w.resets_at && fmtWhen ? I18.i18n("logic.limits.until", { when: fmtWhen(w.resets_at) }) : ""));
    const top = Math.max(...l.windows.map(w => w.used_percentage));
    const stale = l.age_seconds != null && l.age_seconds > 6 * 3600;
    return { text: I18.i18n("logic.limits", { parts: parts.join(" · ") }) + (stale ? I18.i18n("logic.limits.stale") : ""),
             tone: top >= 90 ? "warn" : top >= 75 ? "mid" : "ok", stale };
  }

  // Порядок карточек не зависит от свежести сообщений — иначе они прыгают при каждом ответе:
  // закреплённые (в порядке закрепления), затем по времени запуска, новые сверху. Скрытые до
  // следующего сообщения уходят: hidden — {id: last_message_at на момент скрытия}.
  function arrangeSessions(list, pinned, hidden) {
    const pins = pinned || [];
    const hid = hidden || {};
    const isHidden = s => Object.prototype.hasOwnProperty.call(hid, s.session_id)
      && hid[s.session_id] === (s.last_message_at || "");
    const visible = list.filter(s => !isHidden(s));
    const started = s => new Date(s.process_started_at || s.started_at || 0).getTime();
    visible.sort((a, b) => {
      const pa = pins.indexOf(a.session_id), pb = pins.indexOf(b.session_id);
      if (pa !== pb) return (pa < 0 ? 1e9 : pa) - (pb < 0 ? 1e9 : pb);
      return started(b) - started(a) || (a.session_id < b.session_id ? -1 : 1);
    });
    // Скрытые, у которых появилось новое сообщение, — вернуть; записи о них больше не нужны.
    const stale = Object.keys(hid).filter(id => {
      const s = list.find(x => x.session_id === id);
      return !s || hid[id] !== (s.last_message_at || "");
    });
    return { visible, hiddenCount: list.length - visible.length, stale };
  }

  // Стрелки и j/k по карточкам: влево-вправо — соседняя, вверх-вниз — на ряд (cols карточек).
  function nextCard(ids, current, key, cols) {
    if (!ids.length) return null;
    const i = ids.indexOf(current);
    if (i < 0) return ids[0];
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, j: 1, k: -1 }[key];
    if (step === undefined) return current;
    return ids[Math.max(0, Math.min(ids.length - 1, i + step))];
  }

  // Стоимость: записанная Claude Code (на дату) и оценка сейчас — по токенам.
  function costText(s, fmtDay) {
    if (s.cost_now != null && (s.cost_usd == null || s.cost_now - s.cost_usd >= 0.005)) {
      return "≈ $" + s.cost_now.toFixed(2);
    }
    if (s.cost_usd == null) return "$ —";
    return "$" + s.cost_usd.toFixed(2) + (s.cost_recorded_at && fmtDay ? I18.i18n("logic.cost.on", { day: fmtDay(s.cost_recorded_at) }) : "");
  }

  // Строка карточки коротко: «26.08 16:36 · 12 ч назад · 396 ходов · ≈$832 · 606k/1M».
  // Полный текст — в подсказке. ago и fmtStart даёт страница: форматы времени там.
  function shortTokens(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, "") + "M"
      : Math.round(n / 1000) + "k";
  }
  function shortCost(s) {
    const estimate = s.cost_now != null && (s.cost_usd == null || s.cost_now - s.cost_usd >= 0.005);
    const v = estimate ? s.cost_now : s.cost_usd;
    if (v == null) return null;
    return (estimate ? "≈" : "") + "$" + (v >= 10 ? Math.round(v) : v.toFixed(2));
  }
  function infoParts(s, ago, fmtStart) {
    const when = [fmtStart(s.started_at), s.last_message_at ? ago(s.last_message_at) : null]
      .filter(Boolean);
    const nums = [];
    if (s.human_turns != null) nums.push(I18.i18nN("logic.turns", s.human_turns));
    const cost = shortCost(s);
    if (cost) nums.push(cost);
    const ctx = contextLevel(s);
    return { when, nums, context: ctx ? { text: shortTokens(s.context_tokens) + "/"
      + shortTokens(s.context_window), tone: ctx.tone, hint: ctx.hint } : null };
  }

  // Связь с терминалом словами. health — ответ плагина; askedAt — когда спросили без ответа.
  const HOST_REPLY_MS = 3000;
  function terminalStatus(embedded, health, askedAt, now) {
    if (!embedded) return { ok: false, reason: I18.i18n("logic.term.notObsidian") };
    if (!health) {
      if (askedAt && now - askedAt > HOST_REPLY_MS) {
        return { ok: false, reason: I18.i18n("logic.term.noReply") };
      }
      return { ok: null, reason: I18.i18n("logic.term.checking") };
    }
    return { ok: !!health.ok, reason: health.reason || null };
  }

  // Задачи агента: «3/7», что идёт сейчас и весь список в подсказку. null — задач нет.
  const TASK_MARK = { completed: "✓", in_progress: "▶", pending: "○" };
  function tasksSummary(t) {
    if (!t || !t.total) return null;
    const current = (t.active || [])[0] || null;
    const hint = (t.items || []).map(i => `${TASK_MARK[i.status] || "○"} ${i.subject}`).join("\n");
    return { count: `${t.done}/${t.total}`, current, hint, pct: Math.round(t.done / t.total * 100),
             finished: t.done === t.total };
  }

  // Лента, «Шаги»: сколько шёл вызов — «0,8 с», «42 с», «3 мин», «1 ч 05 мин».
  function durationText(sec) {
    if (sec == null || sec < 0) return "";
    if (sec < 10) return I18.i18n("logic.dur.sec", { n: decimal(sec.toFixed(1)) });
    if (sec < 60) return I18.i18n("logic.dur.sec", { n: Math.round(sec) });
    const min = Math.round(sec / 60);
    if (min < 60) return I18.i18n("logic.dur.min", { n: min });
    return I18.i18n("logic.dur.hm", { h: Math.floor(min / 60), m: String(min % 60).padStart(2, "0") });
  }
  // Какие шаги оставляет фильтр ленты. Текст рассуждений виден только во «всех».
  const STEP_FILTERS = { all: null, error: ev => ev.status === "error", bash: ev => ev.kind === "bash",
                         edit: ev => ev.kind === "edit", agent: ev => ev.kind === "agent" };
  function stepPasses(ev, filter) {
    const f = STEP_FILTERS[filter];
    return !f || f(ev);
  }
  // Путь файла в ленте: от папки сессии, иначе от домашней — «~/Code/x/a.py».
  function relPath(path, cwd, home) {
    if (cwd && path.startsWith(cwd.replace(/\/$/, "") + "/")) return path.slice(cwd.replace(/\/$/, "").length + 1);
    if (home && path.startsWith(home + "/")) return "~" + path.slice(home.length);
    return path;
  }

  // Быстрый переход (⌘K): все слова запроса — в названии или подписи; живые — выше закрытых,
  // совпадение с началом названия — выше совпадения в середине. Пустой запрос — всё по порядку.
  function jumpMatches(items, query, limit) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    (items || []).forEach((it, i) => {
      const title = String(it.title || "").toLowerCase();
      const hay = title + " " + String(it.sub || "").toLowerCase();
      if (!words.every(w => hay.includes(w))) return;
      const head = words.length && title.startsWith(words[0]) ? 0 : 1;
      scored.push([it.kind === "live" ? 0 : 1, head, i, it]);
    });
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return scored.slice(0, limit || 12).map(x => x[3]);
  }

  /** Прежние сообщения для подробной карточки: всё до того, что показывает её последний блок
   *  (твой запрос без ответа или последний ответ), не больше limit − 1. */
  function cardHistory(s, unanswered, limit) {
    const shownAt = unanswered ? unanswered.at : s.reply_at;
    const list = (s.history || []).filter(m => !shownAt || !m.at || m.at < shownAt);
    return limit > 1 ? list.slice(-(limit - 1)) : [];
  }

  /** Порядок карточек, пока ты на вкладке: прежние — на своих местах, новые — в конец, ушедшие
   *  выпадают. frozen = null — порядок ещё не снят: берём свежую сортировку и запоминаем её. */
  function applyFrozenOrder(sorted, frozen) {
    const ids = sorted.map(s => s.session_id);
    if (!frozen) return { list: sorted, frozen: ids };
    const known = new Map(frozen.map((id, i) => [id, i]));
    const kept = sorted.filter(s => known.has(s.session_id))
      .sort((a, b) => known.get(a.session_id) - known.get(b.session_id));
    const fresh = sorted.filter(s => !known.has(s.session_id));
    const list = kept.concat(fresh);
    return { list, frozen: list.map(s => s.session_id) };
  }

  /** Пометки ряда «Недавно закрытые»: сессия ушла из списка (открылась) — пометка снимается,
   *  иначе при следующем закрытии ряд снова писал бы «открываю…». Ожидание открытия — не дольше ttl. */
  const CLOSED_NOTE_TTL_MS = 60000;
  function pruneClosedNotes(notes, closedIds, now, ttl) {
    const still = new Set(closedIds || []);
    for (const [id, note] of notes) {
      const stale = note.pending && now - note.at > (ttl || CLOSED_NOTE_TTL_MS);
      if (!still.has(id) || stale) notes.delete(id);
    }
    return notes;
  }

  const api = { cardHistory, applyFrozenOrder, pruneClosedNotes, CLOSED_NOTE_TTL_MS, pluralRu, tasksSummary, jumpMatches, durationText, stepPasses, relPath, terminalStatus, infoParts, shortTokens, arrangeSessions, contextLevel, limitsText, deliveryState, DELIVERY_WAIT_MS, commandMatches,
                historyStep, PERIODS, periodOf, valuesOf, passes, filterOptions, parseLayout,
                backgroundReasons, unansweredPrompt, nextCard, costText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AtlasLogic = api;           // своё пространство имён: в active.js есть обёртки
})(typeof window !== "undefined" ? window : globalThis);

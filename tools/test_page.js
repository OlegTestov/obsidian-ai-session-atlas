/**
 * Чистая логика страницы без браузера: разбор Markdown и вкладка «Активные».
 *
 *   node tools/test_page.js
 */
const path = require("path");
const fs = require("fs");
// Строки страницы — из словарей: язык «ru», чтобы проверки ниже сверяли русский текст.
const I18N = require(path.join(__dirname, "..", "web", "js", "i18n.js"));
fs.readdirSync(path.join(__dirname, "..", "web", "js")).filter(f => /^lang-.*\.js$/.test(f)).sort()
  .forEach(f => require(path.join(__dirname, "..", "web", "js", f)));
I18N.setLang("ru");
const md = require(path.join(__dirname, "..", "web", "js", "markdown.js"));
const L = require(path.join(__dirname, "..", "web", "js", "logic.js"));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : " → " + JSON.stringify(detail)}`);
};
const types = blocks => blocks.map(b => b.t);
const inlineTypes = items => items.map(i => i.t);

// --- Markdown ---------------------------------------------------------------------

{
  const b = md.parseMarkdown("## Итог\n\nСделано **три** и *одна*; `код` и snake_case_name, 2 * 3 * 4.");
  check("заголовок и абзац", JSON.stringify(types(b)) === '["h","p"]', types(b));
  check("## → h5 (масштаб карточки)", b[0].level === 5);
  const kinds = inlineTypes(b[1].lines[0]);
  check("жирный, курсив, код в строке", kinds.includes("strong") && kinds.includes("em") && kinds.includes("code"), kinds);
  const text = JSON.stringify(b[1]);
  check("snake_case и 2 * 3 * 4 — не курсив", text.includes("snake_case_name") && text.includes("2 * 3 * 4"));
}
{
  const inl = md.parseInline("[MR](https://x.y/1) и [клик](javascript:alert(1)) и https://example.com/a.");
  const links = inl.filter(i => i.t === "link");
  check("ссылки разобраны", links.length === 3, links.map(l => l.href));
  check("точка после URL не входит в ссылку", links[2].href === "https://example.com/a");
  check("javascript: не проходит проверку безопасности", !md.SAFE_URL.test(links[1].href) && md.SAFE_URL.test(links[0].href));
  const html = md.parseInline("<img src=x onerror=alert(1)>");
  check("HTML остаётся текстом", html.length === 1 && html[0].t === "text");
}
{
  const b = md.parseMarkdown("- раз\n- два\n  - вложенный\n1. нумерованный\n2. второй");
  check("маркированный и нумерованный — два списка", JSON.stringify(b.map(x => [x.t, x.ordered])) === '[["list",false],["list",true]]', b.map(x => [x.t, x.ordered]));
  check("вложенный список внутри пункта", b[0].items[1].sub.length === 1 && b[0].items[1].sub[0].items.length === 1);
}
{
  const b = md.parseMarkdown("| A | B |\n|---|---|\n| 1 | **2** |\n| 3 | 4 |\n\n> цитата\n\n```py\nprint('**нет**')\n```\n\n---");
  check("таблица, цитата, код, разделитель", JSON.stringify(types(b)) === '["table","quote","pre","hr"]', types(b));
  check("строки таблицы", b[0].rows.length === 2 && b[0].head.length === 2);
  check("внутри кода разметка не разбирается", b[2].text === "print('**нет**')");
}
{
  const b = md.parseMarkdown("```\nобрезанный код без закрытия");
  check("незакрытый блок кода не роняет разбор", b.length === 1 && b[0].t === "pre");
}

// --- Логика «Активных» ----------------------------------------------------------------

const now = new Date("2026-09-27T12:00:00");
check("период: за час", L.periodOf("2026-09-27T11:30:00", now) === "hour");
check("период: сегодня", L.periodOf("2026-09-27T08:00:00", now) === "today");
check("период: вчера", L.periodOf("2026-09-26T23:00:00", now) === "yesterday");
check("период: неделя", L.periodOf("2026-09-22T10:00:00", now) === "week");
check("период: раньше", L.periodOf("2026-09-01T10:00:00", now) === "older");

const sessions = [
  { domains: ["hired-work"], projects: ["a"], topic: "x", last_message_at: "2026-09-27T11:50:00" },
  { domains: ["personal"], projects: ["b"], topic: "y", last_message_at: "2026-09-20T10:00:00" },
  { domains: ["hired-work"], projects: ["b"], topic: "y", last_message_at: "2026-09-26T10:00:00" },
];
const filters = { domain: new Set(["hired-work"]), project: new Set(), topic: new Set(), period: new Set() };
check("фильтр домена", sessions.filter(s => L.passes(s, filters, null, now)).length === 2);
filters.domain.add("personal");
check("два значения — ИЛИ внутри списка", sessions.filter(s => L.passes(s, filters, null, now)).length === 3);
filters.project.add("b");
check("разные списки — И", sessions.filter(s => L.passes(s, filters, null, now)).length === 2);
const opts = L.filterOptions(sessions, filters, "domain", now);
check("счётчик значения без своего фильтра", JSON.stringify(opts.map(o => [o.value, o.count])) === '[["hired-work",1],["personal",1]]', opts);
{
  const only = { domain: new Set(["hired-work"]), project: new Set(), topic: new Set(), period: new Set() };
  const own = L.filterOptions(sessions, only, "domain", now);
  check("свой фильтр не прячет соседние значения своего списка",
        JSON.stringify(own.map(o => [o.value, o.count])) === '[["hired-work",2],["personal",1]]', own);
}
const per = L.filterOptions(sessions, { domain: new Set(), project: new Set(), topic: new Set(), period: new Set() }, "period", now);
check("периоды только непустые, в порядке", JSON.stringify(per.map(p => p.value)) === '["hour","yesterday","week"]', per.map(p => p.value));

check("раскладка из адреса", JSON.stringify(L.parseLayout("3x2", 4)) === '{"c":3,"r":2}');
check("раскладка сверх предела — отброшена", L.parseLayout("5x5", 4) === null && L.parseLayout("5x5", 5) !== null);
check("мусор в адресе — отброшен", L.parseLayout("9x1", 5) === null && L.parseLayout("", 5) === null);

check("причины фона словами", JSON.stringify(L.backgroundReasons({ shells: 1, agents: 2, wake_at: "T", crons: 1 }, t => "16:35"))
  === '["команда в фоне","2 агента","проснётся в 16:35","по расписанию"]');

{
  const s = { reply_at: "2026-09-27T10:00:00Z", prompt: "сделай", prompt_at: "2026-09-27T10:05:00Z" };
  check("неотвеченное из транскрипта", L.unansweredPrompt(s, null).prompt.text === "сделай");
  const cut = L.unansweredPrompt({ ...s, interrupted_at: "2026-09-27T10:05:30Z" }, null).prompt;
  check("прерванный запрос помечен", cut && cut.interrupted === true);
  check("прерывание до запроса — не про него",
        L.unansweredPrompt({ ...s, interrupted_at: "2026-09-27T10:01:00Z" }, null).prompt.interrupted === false);
  check("отвеченное — не показывается", L.unansweredPrompt({ ...s, reply_at: "2026-09-27T10:06:00Z" }, null).prompt === null);
  const sent = { text: "только что", images: 0, at: "2026-09-27T10:10:00Z" };
  check("только что отправленное — до транскрипта", L.unansweredPrompt(s, sent).prompt.text === "только что");
  const caught = L.unansweredPrompt({ ...s, prompt_at: "2026-09-27T10:10:01Z", prompt: "только что" }, sent);
  check("транскрипт догнал — отправленное снимается", caught.dropSent && caught.prompt.text === "только что");
}

{
  const sent = { text: "проверь тесты и почини", at: "2026-09-27T10:00:00Z" };
  const t0 = new Date(sent.at).getTime();
  check("доставка: только что — в пути", L.deliveryState({}, sent, t0 + 3000) === "sending");
  check("доставка: в очереди по тексту",
        L.deliveryState({ queued: [{ text: "  проверь тесты и почини, а потом" }] }, sent, t0 + 20000) === "queued");
  check("доставка: 15 с без следа — пропало", L.deliveryState({ queued: [] }, sent, t0 + 16000) === "lost");
  check("доставка: чужое в очереди — не наше",
        L.deliveryState({ queued: [{ text: "другое" }] }, sent, t0 + 16000) === "lost");
  check("доставка: только картинка — не пугаем",
        L.deliveryState({}, { text: "", at: sent.at }, t0 + 60000) === "sending");
  check("доставка: нет отправленного — нет состояния", L.deliveryState({}, null, t0) === null);
}

{
  const cmds = [{ name: "goal" }, { name: "compact" }, { name: "clear" }, { name: "context" },
                { name: "context-save" }, { name: "obsidian-log" }, { name: "log-x" }];
  const names = t => L.commandMatches(cmds, t).map(c => c.name).join(",");
  check("подсказки: «/» — все по порядку", names("/") === "goal,compact,clear,context,context-save,obsidian-log,log-x");
  check("подсказки: сначала начинающиеся", names("/lo") === "log-x,obsidian-log");
  check("подсказки: регистр не важен", names("/COMP") === "compact");
  check("подсказки: после пробела — нет", names("/goal сделай") === "" && names("привет /g") === "");
  check("подсказки: все совпадения, без обрезки",
        L.commandMatches(Array.from({ length: 200 }, (_, i) => ({ name: "c" + i })), "/c").length === 200);
  const h = ["первое", "второе", "третье"];
  let st = L.historyStep(h, -1, "up");
  check("история: вверх — последнее", st.index === 0 && st.text === "третье");
  st = L.historyStep(h, st.index, "up"); st = L.historyStep(h, st.index, "up"); st = L.historyStep(h, st.index, "up");
  check("история: упирается в самое старое", st.index === 2 && st.text === "первое");
  st = L.historyStep(h, 0, "down");
  check("история: вниз с последнего — свой черновик", st.index === -1 && st.text === null);
  check("история: пустая", L.historyStep([], -1, "up").text === null);
}

{
  check("контекст: нет данных — нет плашки", L.contextLevel({}) === null);
  const c = L.contextLevel({ context_tokens: 870094, context_window: 1000000 });
  check("контекст: 87% — тревожно", c.pct === 87 && c.tone === "warn" && /компактация/.test(c.hint));
  check("контекст: 61% — средне", L.contextLevel({ context_tokens: 122000, context_window: 200000 }).tone === "mid");
  check("контекст: 22% — спокойно", L.contextLevel({ context_tokens: 222018, context_window: 1000000 }).tone === "ok");
  const lim = { age_seconds: 60, windows: [{ label: "5 часов", used_percentage: 41.6, resets_at: "x" },
                                           { label: "неделя", used_percentage: 87.2, resets_at: "y" }] };
  const t = L.limitsText(lim, v => v === "y" ? "01.10" : "00:36");
  check("лимиты: строка", t.text === "лимиты: 5 часов 42% до 00:36 · неделя 87% до 01.10" && t.tone === "mid");
  check("лимиты: давно — помечено", L.limitsText({ ...lim, age_seconds: 7 * 3600 }).stale === true);
  check("лимиты: 90% — тревожно", L.limitsText({ windows: [{ label: "неделя", used_percentage: 93 }] }).tone === "warn");
  check("лимиты: нет файла — нет строки", L.limitsText(null) === null);
}

{
  const mk = (id, started, last) => ({ session_id: id, process_started_at: started, last_message_at: last });
  const list = [mk("a", "2026-09-27T08:00:00Z", "2026-09-27T12:00:00Z"),
                mk("b", "2026-09-27T10:00:00Z", "2026-09-27T09:00:00Z"),
                mk("c", "2026-09-27T09:00:00Z", "2026-09-27T11:00:00Z")];
  const ids = r => r.visible.map(s => s.session_id).join("");
  check("порядок: по запуску, новые сверху", ids(L.arrangeSessions(list, [], {})) === "bca");
  const fresher = list.map(s => s.session_id === "a" ? { ...s, last_message_at: "2026-09-27T13:00:00Z" } : s);
  check("порядок: новое сообщение карточку не двигает", ids(L.arrangeSessions(fresher, [], {})) === "bca");
  check("порядок: закреплённые первыми, в порядке закрепления", ids(L.arrangeSessions(list, ["a", "c"], {})) === "acb");
  const hid = { c: "2026-09-27T11:00:00Z", gone: "x" };
  const r = L.arrangeSessions(list, [], hid);
  check("скрыть: до следующего сообщения", ids(r) === "ba" && r.hiddenCount === 1);
  check("скрыть: записи об ушедших — к удалению", JSON.stringify(r.stale) === '["gone"]');
  const back = L.arrangeSessions(list.map(s => s.session_id === "c" ? { ...s, last_message_at: "2026-09-27T14:00:00Z" } : s), [], hid);
  check("скрыть: новое сообщение возвращает карточку", ids(back) === "bca" && back.stale.includes("c"));
}

{
  const s = { started_at: "x", last_message_at: "y", human_turns: 396, cost_now: 832.06, cost_usd: 700,
              context_tokens: 605574, context_window: 1000000 };
  const p = L.infoParts(s, () => "12 ч назад", () => "26.08 16:36");
  check("строка карточки: коротко", [...p.when, ...p.nums, p.context.text].join(" · ")
        === "26.08 16:36 · 12 ч назад · 396 ходов · ≈$832 · 606k/1M");
  check("строка: записанная сумма без ≈, мелкая — с центами",
        L.infoParts({ cost_usd: 5.1, cost_now: 5.1 }, () => "", () => "").nums.join() === "$5.10");
  check("строка: окно 200k", L.infoParts({ context_tokens: 130020, context_window: 200000 }, () => "", () => "")
        .context.text === "130k/200k");
  check("строка: нет данных — пусто", JSON.stringify(L.infoParts({}, () => "", () => ""))
        === '{"when":[],"nums":[],"context":null}');
  check("токены: 1.5M", L.shortTokens(1500000) === "1.5M" && L.shortTokens(1000000) === "1M");
}

check("навигация: вправо", L.nextCard(["a", "b", "c", "d"], "a", "ArrowRight", 2) === "b");
check("навигация: вниз на ряд", L.nextCard(["a", "b", "c", "d"], "a", "ArrowDown", 2) === "c");
check("навигация: j/k", L.nextCard(["a", "b"], "b", "k", 2) === "a" && L.nextCard(["a", "b"], "a", "j", 2) === "b");
check("навигация: край не переходит", L.nextCard(["a", "b"], "b", "ArrowRight", 2) === "b");
check("навигация: без выбора — первая", L.nextCard(["a", "b"], null, "j", 2) === "a");

{
  const ts = L.terminalStatus;
  check("связь: вне Obsidian — нет", ts(false, null, null, 0).ok === false && /не в Obsidian/.test(ts(false, null, null, 0).reason));
  check("связь: ждём ответа плагина", ts(true, null, 1000, 2000).ok === null);
  check("связь: плагин молчит — нет с причиной", ts(true, null, 1000, 5000).ok === false && /не отвечает/.test(ts(true, null, 1000, 5000).reason));
  check("связь: причина от плагина", ts(true, { ok: false, reason: "плагин Terminal выключен" }, null, 0).reason === "плагин Terminal выключен");
  check("связь: есть", ts(true, { ok: true, reason: null }, null, 0).ok === true);
}

check("стоимость: оценка сейчас", L.costText({ cost_usd: 10, cost_now: 12.5 }) === "≈ $12.50");
check("стоимость: без прироста — на дату", L.costText({ cost_usd: 10, cost_now: 10, cost_recorded_at: "x" }, () => "25.09") === "$10.00 на 25.09");
check("стоимость: неизвестна", L.costText({}) === "$ —");
check("склонения", L.pluralRu(1, "ход", "хода", "ходов") === "ход" && L.pluralRu(3, "ход", "хода", "ходов") === "хода"
  && L.pluralRu(11, "ход", "хода", "ходов") === "ходов" && L.pluralRu(22, "ход", "хода", "ходов") === "хода");



// --- Задачи агента на карточке ----------------------------------------------------------
{
  const t = L.tasksSummary({ total: 4, done: 1, active: ["Проверяю дифф"],
    items: [{ subject: "а", status: "completed" }, { subject: "б", status: "in_progress" },
            { subject: "в", status: "pending" }, { subject: "г", status: "pending" }] });
  check("задачи: счёт и текущая", t.count === "1/4" && t.current === "Проверяю дифф" && t.pct === 25 && !t.finished, t);
  check("задачи: список в подсказке с отметками", t.hint === "✓ а\n▶ б\n○ в\n○ г", t.hint);
  check("задачи: нет — ничего не показывать", L.tasksSummary(null) === null && L.tasksSummary({ total: 0 }) === null);
  check("задачи: все сделаны", L.tasksSummary({ total: 2, done: 2, active: [], items: [] }).finished === true);
}


// --- Лента: шаги и файлы -----------------------------------------------------------------
check("длительность шага", L.durationText(0.84) === "0,8 с" && L.durationText(42.4) === "42 с"
  && L.durationText(180) === "3 мин" && L.durationText(3900) === "1 ч 05 мин" && L.durationText(null) === "",
  [L.durationText(0.84), L.durationText(3900)]);
check("фильтр шагов", L.stepPasses({ kind: "bash", status: "error" }, "error")
  && !L.stepPasses({ kind: "bash", status: "ok" }, "error") && L.stepPasses({ kind: "edit", status: "ok" }, "edit")
  && !L.stepPasses({ kind: "text", status: "ok" }, "agent") && L.stepPasses({ kind: "text", status: "ok" }, "all"));
check("путь файла от папки сессии", L.relPath("/u/Code/p/a/b.py", "/u/Code/p", "/u") === "a/b.py"
  && L.relPath("/u/Code/q/c.py", "/u/Code/p", "/u") === "~/Code/q/c.py"
  && L.relPath("/u/Code/pp/c.py", "/u/Code/p", null) === "/u/Code/pp/c.py");


// --- Быстрый переход ⌘K ---------------------------------------------------------------------
{
  const items = [{ kind: "closed", id: "c", title: "Session Atlas старый", sub: "" },
                 { kind: "live", id: "a", title: "Верстка лендинга", sub: "landing-site personal" },
                 { kind: "live", id: "b", title: "Session Atlas плагин", sub: "session-atlas" },
                 { kind: "live", id: "d", title: "Новый Session Atlas", sub: "" },
                 { kind: "live", id: "e", title: "Atlas отчёт", sub: "" }];
  const hist = [{ role: "you", at: "10:00" }, { role: "claude", at: "10:01" }, { role: "you", at: "10:02" },
                { role: "claude", at: "10:03" }];
  check("подробная карточка: история — всё до последнего ответа, не больше N − 1",
        L.cardHistory({ history: hist, reply_at: "10:03" }, null, 10).map(m => m.at).join() === "10:00,10:01,10:02"
        && L.cardHistory({ history: hist, reply_at: "10:03" }, null, 3).map(m => m.at).join() === "10:01,10:02"
        && L.cardHistory({ history: hist, reply_at: "10:01" }, { at: "10:02" }, 10).map(m => m.at).join() === "10:00,10:01"
        && L.cardHistory({ history: hist, reply_at: "10:03" }, null, 1).length === 0);
  const S = id => ({ session_id: id });
  const first = L.applyFrozenOrder([S("a"), S("b"), S("c")], null);
  check("порядок: первый раз — свежая сортировка, она же запоминается",
        first.list.map(s => s.session_id).join() === "a,b,c" && first.frozen.join() === "a,b,c");
  const later = L.applyFrozenOrder([S("d"), S("c"), S("a")], first.frozen);
  check("порядок: пока на вкладке — прежние на местах, новая в конец, ушедшая выпала",
        later.list.map(s => s.session_id).join() === "a,c,d" && later.frozen.join() === "a,c,d", later.frozen);
  const notes = new Map([["gone", { text: "opening…", pending: true, at: 0 }],
                         ["waiting", { text: "opening…", pending: true, at: 1000 }],
                         ["old", { text: "opening…", pending: true, at: 0 }],
                         ["failed", { text: "failed", pending: false, at: 0 }]]);
  L.pruneClosedNotes(notes, ["waiting", "old", "failed"], 1000 + 5000, 60000);
  check("закрытые: открылась — пометка снята, ждёт — висит, ошибка — остаётся",
        [...notes.keys()].join() === "waiting,old,failed");
  L.pruneClosedNotes(notes, ["waiting", "old", "failed"], 61000 + 5, 60000);
  check("закрытые: «открываю…» дольше минуты — снимается", [...notes.keys()].join() === "failed");
  const ids = (q, n) => L.jumpMatches(items, q, n).map(i => i.id).join();
  check("переход: все слова, живые выше закрытых", ids("atlas session") === "b,d,c", ids("atlas session"));
  check("переход: начало названия выше середины", ids("atlas") === "e,b,d,c" && ids("нов") === "d", ids("atlas"));
  check("переход: подпись тоже ищется, регистр не важен", ids("PERSONAL") === "a");
  check("переход: пустой запрос — всё, живые сверху, с лимитом", ids("", 3) === "a,b,d", ids("", 3));
}

// --- Статистика -------------------------------------------------------------------------
const SL = require(path.join(__dirname, "..", "web", "js", "stats-logic.js"));
const nb = s => s.replace(/\u00a0/g, " ");
check("токены: миллиарды", nb(SL.bigNum(18895000000)) === "18,9 млрд", SL.bigNum(18895000000));
check("токены: миллионы и тысячи", nb(SL.bigNum(401700000)) === "402 млн" && nb(SL.bigNum(12400)) === "12 тыс"
  && SL.bigNum(540) === "540", [SL.bigNum(401700000), SL.bigNum(12400)]);
check("время: часы и минуты", nb(SL.hoursText(16200)) === "4 ч 30 мин" && nb(SL.hoursText(3900)) === "1 ч 05 мин"
  && nb(SL.hoursText(47100)) === "13 ч", [SL.hoursText(16200), SL.hoursText(47100)]);
check("время: меньше часа — минуты, много — часы", nb(SL.hoursText(1500)) === "25 мин"
  && nb(SL.hoursText(3600 * 1234)) === "1 234 ч", [SL.hoursText(1500), SL.hoursText(3600 * 1234)]);
check("деньги", nb(SL.money(3367.52)) === "$3 368" && SL.money(12.4) === "$12,40", [SL.money(3367.52), SL.money(12.4)]);
check("сравнение: рост и падение", SL.delta(112, 100).text === "+12%" && SL.delta(112, 100).dir === "up"
  && SL.delta(50, 100).text === "−50%" && SL.delta(50, 100).dir === "down");
check("сравнение: не с чем", SL.delta(5, 0) === null && SL.delta(5, null) === null);
check("подпись столбца", SL.pointLabel("2026-09-28", "day") === "28.09" && SL.pointLabel("2026-09-28 14", "hour") === "14:00");
check("подписи не слипаются", SL.labelStep(90, 14) === 7 && SL.labelStep(10, 14) === 1);
check("доля от максимума", SL.share(50, 200) === 25 && SL.share(0, 200) === 0 && SL.share(5, 0) === 0);
check("уровень ритма", SL.heatLevel(0, 10) === 0 && SL.heatLevel(1, 10) === 1 && SL.heatLevel(10, 10) === 4
  && SL.heatLevel(6, 10) === 3);
{
  const items = [{ name: "a", cost: 1, tokens: 9 }, { name: "b", cost: 5, tokens: 1 }, { name: "c", cost: 0, tokens: 3 }];
  check("разбивка сортируется по выбранной мере", SL.ranked(items, "cost").map(i => i.name).join() === "b,a"
    && SL.ranked(items, "tokens", 2).map(i => i.name).join() === "a,c");
}


// --- Английский: те же функции после смены языка ----------------------------------------
{
  I18N.setLang("en");
  check("en: большие числа", SL.bigNum(18895000000) === "18.9B" && SL.bigNum(401700000) === "402M"
    && SL.bigNum(12400) === "12k" && SL.bigNum(1234) === "1,234", [SL.bigNum(18895000000), SL.bigNum(1234)]);
  check("en: часы и минуты", nb(SL.hoursText(47100)) === "13 h" && nb(SL.hoursText(1500)) === "25 min"
    && nb(SL.hoursText(3900)) === "1 h 05 min" && nb(SL.hoursText(3600 * 1234)) === "1,234 h",
    [SL.hoursText(47100), SL.hoursText(3600 * 1234)]);
  check("en: деньги", SL.money(3367.52) === "$3,368" && SL.money(12.4) === "$12.40", [SL.money(3367.52), SL.money(12.4)]);
  check("en: подписи периодов", SL.PERIODS[0].label === "Today" && L.PERIODS[2].label === "yesterday");
  check("en: длительность шага", L.durationText(0.84) === "0.8 s" && L.durationText(42.4) === "42 s"
    && L.durationText(180) === "3 min" && L.durationText(3900) === "1 h 05 min", [L.durationText(0.84), L.durationText(3900)]);
  const t = L.tasksSummary({ total: 4, done: 1, active: ["Checking the diff"],
    items: [{ subject: "a", status: "completed" }, { subject: "b", status: "in_progress" }] });
  check("en: задачи — счёт и подсказка", t.count === "1/4" && t.current === "Checking the diff" && t.hint === "✓ a\n▶ b", t);
  const p = L.infoParts({ human_turns: 1 }, () => "", () => "");
  check("en: склонение ходов вместо pluralRu", p.nums[0] === "1 turn"
    && L.infoParts({ human_turns: 396 }, () => "", () => "").nums[0] === "396 turns", p.nums);
  check("en: причины фона", JSON.stringify(L.backgroundReasons({ shells: 2, agents: 1, crons: 1 }))
    === '["background commands: 2","1 agent","scheduled"]');
  I18N.setLang("ru");
  check("ru снова после en", nb(SL.bigNum(18895000000)) === "18,9 млрд" && L.durationText(0.84) === "0,8 с");
}


// --- Общее пространство имён ------------------------------------------------------------
// Скрипты страницы классические: одноимённая функция в другом файле молча подменяет первую
// (так кнопки «Статистики» сломали подсветку поиска). Имя верхнего уровня — ровно в одном файле.
{
  const dir = path.join(__dirname, "..", "web", "js");
  const owners = {};
  fs.readdirSync(dir).filter(f => f.endsWith(".js")).forEach(f => {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/^(?:async )?function (\w+)|^(?:const|let|var) (\w+)/gm)) {
      const name = m[1] || m[2];
      (owners[name] = owners[name] || []).push(f);
    }
  });
  const dups = Object.entries(owners).filter(([, files]) => files.length > 1);
  check("глобальные имена страницы не повторяются", dups.length === 0, dups);
}


// Вызов на верхнем уровне файла выполняется при загрузке: функция уже должна быть объявлена —
// в этом файле или в подключённом раньше (порядок — из index.html). Иначе файл падает целиком.
{
  const root = path.join(__dirname, "..", "web");
  const order = [...fs.readFileSync(path.join(root, "index.html"), "utf8")
    .matchAll(/src="\/static\/([\w-]+\.js)"/g)].map(m => m[1]);
  const definedIn = {};
  order.forEach((f, i) => {
    const src = fs.readFileSync(path.join(root, "js", f), "utf8");
    for (const m of src.matchAll(/^(?:async )?function (\w+)/gm)) definedIn[m[1]] = i;
  });
  const late = [];
  order.forEach((f, i) => {
    const src = fs.readFileSync(path.join(root, "js", f), "utf8");
    for (const m of src.matchAll(/^(?:(?:let|const|var) \w+ = )?(\w+)\(/gm)) {
      if (m[1] in definedIn && definedIn[m[1]] > i) late.push(`${f}: ${m[1]} (из ${order[definedIn[m[1]]]})`);
    }
  });
  check("верхний уровень не зовёт функции из поздних файлов", late.length === 0, late);
}

console.log(failures ? `\n${failures} проверок упало` : "\nвсе проверки страницы прошли");
process.exit(failures ? 1 : 0);

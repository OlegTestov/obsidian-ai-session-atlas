// «Активные»: секции и отрисовка.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
function section(title, list) {
  const box = el("section", "asec");
  const h = el("h3", null, title);
  h.appendChild(el("span", "n", String(list.length)));
  box.appendChild(h);
  if (!list.length) { box.appendChild(el("p", "none", i18n("active.none"))); return box; }
  const l = layout[activeMode];
  const grid = el("div", (activeMode === "full" ? "agrid full" : "agrid")
    + (l ? ` c${l.c} r${l.r}` : ""));
  list.forEach(s => grid.appendChild(activeCard(s)));
  box.appendChild(grid);
  return box;
}

const RERENDER_EVERY_MS = 60000;     // «N мин назад» стареет — раз в минуту перерисуем и так

function renderActive(skipKey, force) {
  const summary = $("#active-summary");
  const grid = $("#active-grid");
  arrangeActive(activeSessions);              // вернуть скрытые, у которых есть новое сообщение
  const arranged = arrangeActive(activeSessions.filter(s => passes(s)));
  const shown = arranged.visible;
  const any = ACTIVE_FILTERS.some(({ key }) => activeFilter[key].size);
  // Коротко, в одну строку: «11 · 09:08 · 5ч 35% · нед 73% · терминал ● · ?»; полное — в подсказках.
  const sep = () => document.createTextNode(" · ");
  // Сколько всего — уже на вкладке «Активные N»; здесь только отобранное фильтрами.
  const parts = [];
  if (any) {
    const count = el("b", null, i18n("active.shown", { n: shown.length }));
    count.title = i18n("active.shownHint", { shown: shown.length, total: activeSessions.length });
    parts.push(count);
  }
  summary.replaceChildren(...parts);
  if (arranged.hiddenCount) {
    const unhide = el("button", "keys", i18n("active.hidden", { n: arranged.hiddenCount }));
    unhide.type = "button";
    unhide.title = i18n("active.hiddenHint");
    unhide.addEventListener("click", unhideAll);
    if (summary.childNodes.length) summary.append(sep());
    summary.append(unhide);
  }
  if (activeUpdated) {
    if (summary.childNodes.length) summary.append(sep());
    summary.append(el("span", null, i18n("active.updated",
      { time: activeUpdated.toLocaleTimeString(I18N.locale(), { hour: "2-digit", minute: "2-digit" }) })));
  }
  // Сброс в пределах суток — время, дальше — дата.
  const when = iso => {
    const d = new Date(iso);
    return d - Date.now() < 864e5
      ? d.toLocaleTimeString(I18N.locale(), { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(I18N.locale(), { day: "2-digit", month: "2-digit" });
  };
  const lim = AtlasLogic.limitsText(activeLimits, when);
  const short = { five_hour: i18n("active.limit.fiveHour"), seven_day: i18n("active.limit.week") };
  const limSpan = el("span", "limits " + (lim ? lim.tone : "none"), lim
    ? activeLimits.windows.map(w => `${short[w.key] || w.label} ${Math.round(w.used_percentage)}%`).join(" · ")
      + (lim.stale ? i18n("active.limitsStale") : "")
    : i18n("active.limitsNone"));
  // Подпись «лимиты: » из logic.js срезаем: в подсказке своя, полная.
  limSpan.title = lim ? i18n("active.limitsHint", { limits: lim.text.replace(/^[^:]*: /, "") })
    : i18n("active.limitsSetup", { snippet: "\"statusLine\": {\"type\": \"command\", \"command\": "
      + "\"python3.11 ~/Code/session-atlas/tools/statusline.py\"}" });
  summary.append(sep(), limSpan);
  const link = AtlasLogic.terminalStatus(EMBEDDED, hostHealth, tabsAskedAt, Date.now());
  const status = el("span", "link " + (link.ok === false ? "warn" : link.ok ? "ok" : ""), i18n("active.terminal"));
  status.appendChild(el("span", "tdot", "●"));
  status.id = "terminal-link";
  status.title = i18n("active.terminalHint", {
    state: link.ok === null ? i18n("active.terminalChecking") : link.ok ? i18n("active.terminalYes") : i18n("active.terminalNo"),
    reason: link.reason ? ` (${link.reason})` : "" });
  summary.append(sep(), status);
  const keys = el("button", "keys", "?");
  keys.type = "button";
  keys.title = i18n("active.keysHint");
  keys.addEventListener("click", showKeys);
  summary.append(sep(), keys);
  if (state.view !== "active") return;
  refreshFilterButtons(skipKey);
  document.querySelectorAll(".mode button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === activeMode)));
  const closed = () => [closedSection()].filter(Boolean);
  if (!activeSessions.length) {
    grid.replaceChildren(el("p", "empty", i18n("active.noSessions")), ...closed());
    return;
  }
  if (!shown.length) {
    grid.replaceChildren(el("p", "empty", arranged.hiddenCount
      ? i18n("active.allHidden")
      : i18n("active.noMatches")), ...closed());
    return;
  }
  // Пока идёт набор через IME, не трогаем DOM — иначе слово оборвётся. Открытые подсказки
  // команд тоже: перерисовка раз в 5 с пересоздавала поле, и список пропадал.
  if (composing || document.querySelector("#active-grid .suggest:not(.hidden)")) return;
  // Пишут замечания к плану — поле не пересоздаём, иначе пропадут фокус и курсор.
  if (document.activeElement && document.activeElement.matches("#active-grid .planfb textarea")) return;
  // Ничего не поменялось — не трогаем DOM вовсе: так не сбрасывается прокрутка текста.
  const signature = JSON.stringify([shown, activeMode, layout, hostReady, [...hostTabs.keys()],
    [...justSent].map(([sid, sent]) => [sid, AtlasLogic.deliveryState(
      activeSessions.find(x => x.session_id === sid) || {}, sent, Date.now())]), [...dialogs], [...dialogNotes], [...dialogAnswers.values()], [...stopNotes], [...commandOutputs], feedSid, pinnedCards, hiddenCards,
    [...fullReplies.keys()], [...attachments].map(([k, v]) => [k, v.length]),
    recentClosed, closedOpen, [...closedNotes], [...planForms],
    [...planTexts].map(([k, v]) => [k, v.name, (v.text || "").length])]);
  if (!force && signature === lastSignature && Date.now() - lastRenderAt < RERENDER_EVERY_MS) return;
  lastSignature = signature;
  lastRenderAt = Date.now();
  // Сверху — кто ждёт тебя (сначала те, где открыт диалог), снизу — кто работает.
  // «В фоне» — к работающим: ход закончен, но разбудит монитор, агент или /loop, а не ты.
  const act = s => s.activity || s.status;
  const isWorking = s => act(s) === "busy" || act(s) === "background";
  // Порядок — из arrangeSessions: закреплённые, затем по запуску; по свежести не прыгает.
  const waitingYou = shown.filter(s => !isWorking(s));
  const working = shown.filter(isWorking);
  // Прокрутка внутри ответа — по карточке: иначе раз в 5 секунд текст уезжал наверх.
  const inner = new Map([...grid.querySelectorAll(".acard")].map(c => {
    const txt = c.querySelector(".reply .txt:not(.now)");
    return [c.dataset.id, txt ? txt.scrollTop : 0];
  }));
  // Фокус и курсор в поле ответа переживают перерисовку: иначе после отправки карточка
  // не обновлялась, пока не кликнешь мимо поля.
  const focused = document.activeElement && document.activeElement.tagName === "TEXTAREA"
    && grid.contains(document.activeElement) ? document.activeElement : null;
  const caret = focused && { id: focused.dataset.id, start: focused.selectionStart,
                             end: focused.selectionEnd, top: focused.scrollTop };
  const scroll = grid.scrollTop;
  // Хвост переписки в карточках: был внизу — остаётся внизу (видно новое), читал выше — там же.
  const scrolls = new Map([...grid.querySelectorAll(".amsgs[data-sid]")].map(b =>
    [b.dataset.sid, { top: b.scrollTop, bottom: b.scrollHeight - b.scrollTop - b.clientHeight < 24 }]));
  grid.replaceChildren(section(i18n("active.sectionWaiting"), waitingYou), section(i18n("active.sectionWorking"), working), ...closed());
  grid.querySelectorAll(".amsgs[data-sid]").forEach(b => {
    const was = scrolls.get(b.dataset.sid);
    b.scrollTop = !was || was.bottom ? b.scrollHeight : was.top;
  });
  grid.scrollTop = scroll;
  if (caret) {
    const area = grid.querySelector(`.answer textarea[data-id="${CSS.escape(caret.id)}"]`);
    if (area && !area.disabled) {
      area.focus({ preventScroll: true });
      area.setSelectionRange(caret.start, caret.end);
      area.scrollTop = caret.top;
    }
  }
  grid.querySelectorAll(".acard").forEach(c => {
    const txt = c.querySelector(".reply .txt:not(.now)");
    if (txt && inner.get(c.dataset.id)) txt.scrollTop = inner.get(c.dataset.id);
  });
  applySelection();                  // выбор с клавиатуры переживает перерисовку
}

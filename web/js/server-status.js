// Сервер Session Atlas упал: плашка сверху вместо пустых карточек, внутри Obsidian — «Поднять».
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
let serverDown = false;
let serverRaising = false;

// Зовёт api(): false — сеть не ответила (сервер лежит), true — ответ пришёл, пусть и с ошибкой.
const SERVER_RETRY_MS = 5000;
let serverRetry = null;

// Пока сервер лежит — сами спрашиваем /health: на вкладке «Поиск» своего опроса нет, и без
// этого страница, открытая в момент перезапуска сервера, так и оставалась бы пустой.
function watchServer() {
  clearTimeout(serverRetry);
  if (!serverDown) return;
  serverRetry = setTimeout(async () => {
    try {
      const r = await fetch("/health");
      if (r.ok) { serverStatus(true); return; }
    } catch (e) { /* ещё лежит */ }
    watchServer();
  }, SERVER_RETRY_MS);
}

function serverStatus(up) {
  if (up === !serverDown) return;
  serverDown = !up;
  renderServerBanner();
  watchServer();
  if (up) {                                  // вернулся — обновить то, что на экране
    refreshView();
    api("/api/facets").then(bindFilters).catch(() => {});   // и фильтры, если не успели
  }
}

function renderServerBanner(note) {
  const box = $("#server-banner");
  if (!serverDown) { box.classList.add("hidden"); box.replaceChildren(); return; }
  box.classList.remove("hidden");
  const text = el("span", null, i18n("common.serverDown"));
  box.replaceChildren(text);
  if (EMBEDDED) {
    const raise = el("button", "primary", i18n(serverRaising ? "common.raising" : "common.raise"));
    raise.type = "button";
    raise.disabled = serverRaising;
    raise.addEventListener("click", () => {
      serverRaising = true;
      renderServerBanner();
      tellHost("ensure-server", {});
      setTimeout(() => {                       // плагин не ответил — дать нажать ещё раз
        if (!serverRaising) return;
        serverRaising = false;
        renderServerBanner(i18n("common.obsidianNoAnswer"));
      }, 40000);
    });
    box.appendChild(raise);
  } else {
    box.appendChild(el("code", null, "atlas ensure"));
  }
  if (note) box.appendChild(el("span", "note", note));
}

window.addEventListener("message", e => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (!d || d.source !== "session-atlas-host" || d.type !== "server-ensured") return;
  serverRaising = false;
  if (d.ok) serverStatus(true);
  else renderServerBanner(i18n("common.raiseFailed", { reason: d.reason || i18n("common.errorWord") }));
});

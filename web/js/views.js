// Разделы страницы: вкладка сверху и её панель. Новый раздел — свой файл с registerView,
// кнопка в #views и панель в index.html; переключение, адресная строка и обновление при
// возврате на страницу — здесь, общие для всех.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
const VIEWS = {};

/**
 * name — ключ в адресе (#view=name). opts: tab, panel — селекторы; show() — раздел открыт или
 * страница снова видна; hide() — ушли с раздела; refresh() — сервер снова ответил.
 */
function registerView(name, opts) {
  VIEWS[name] = opts;
  $(opts.tab).addEventListener("click", () => setView(name));
}

function setView(view) {
  if (!VIEWS[view]) view = "search";
  const prev = state.view;
  state.view = view;
  Object.entries(VIEWS).forEach(([name, v]) => {
    const on = name === view;
    $(v.tab).setAttribute("aria-selected", String(on));
    $(v.panel).classList.toggle("hidden", !on);
  });
  writeHash();
  if (prev !== view && VIEWS[prev] && VIEWS[prev].hide) VIEWS[prev].hide();
  if (VIEWS[view].show) VIEWS[view].show();
}

// Сервер снова ответил — перечитать то, что на экране.
function refreshView() {
  const v = VIEWS[state.view];
  const fn = v && (v.refresh || v.show);
  if (fn) fn();
}

document.addEventListener("visibilitychange", () => {
  const v = VIEWS[state.view];
  if (!document.hidden && v && v.show) v.show();
});

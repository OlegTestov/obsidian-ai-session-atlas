// Запуск: после того как объявлены функции обеих вкладок.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
buildFilters();
readHash();
refreshLayoutButton();
setView(state.view);
if (state.view !== "active") loadActive();   // счётчик на вкладке виден и из поиска
api("/api/facets").then(bindFilters).then(loadList)
  .then(() => { if (state.current) openCard(state.current); });

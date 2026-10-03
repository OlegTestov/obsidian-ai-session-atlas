// Startup: after the functions of both tabs are declared.
// Classic script: shares one global scope with the other page files.
buildFilters();
readHash();
refreshLayoutButton();
setView(state.view);
if (state.view !== "active") loadActive();   // the tab counter is visible from search too
api("/api/facets").then(bindFilters).then(loadList)
  .then(() => { if (state.current) openCard(state.current); });

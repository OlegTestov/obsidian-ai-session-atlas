// Startup: after the functions of both tabs are declared.
// Classic script: shares one global scope with the other page files.
buildFilters();
$("#search-agent").appendChild(agentFilter("search", () => loadList(), { named: true }));
readHash();
refreshLayoutButton();
initHeaderLimits();
setView(state.view);
api("/api/facets").then(bindFilters).then(loadList)
  .then(() => { if (state.current) openCard(state.current); });

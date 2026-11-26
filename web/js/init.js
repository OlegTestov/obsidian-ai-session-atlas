// Startup: after the functions of both tabs are declared.
// Classic script: shares one global scope with the other page files.
buildFilters();
$("#search-agent").appendChild(agentFilter("search", () => loadList(), { named: true }));
readHash();
workspaceFromGroup(new URLSearchParams(location.hash.slice(1)).get("wg"));
refreshLayoutButton();
initHeaderLimits();
setView(state.view);
api("/api/facets").then(bindFilters).then(loadList)
  .then(() => { if (state.current) openCard(state.current); });

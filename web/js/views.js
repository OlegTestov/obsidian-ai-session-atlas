// Page sections: a tab on top and its panel. A new section is its own file with registerView,
// a button in #views and a panel in index.html; switching, the address bar and refresh on
// return to the page live here, shared by all.
// Classic script: shares one global scope with the other page files.
/* exported registerView, refreshView -- used by other page scripts */
const VIEWS = {};

/**
 * name is the address key (#view=name). opts: tab, panel are selectors; show() runs when the section
 * opens or the page is visible again; hide() when leaving it; refresh() when the server answers again.
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

// The server answered again: reload what is on screen.
function refreshView() {
  const v = VIEWS[state.view];
  const fn = v && (v.refresh || v.show);
  if (fn) fn();
}

document.addEventListener("visibilitychange", () => {
  const v = VIEWS[state.view];
  if (!document.hidden && v && v.show) v.show();
});

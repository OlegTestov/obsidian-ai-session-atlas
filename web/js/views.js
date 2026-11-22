// Page sections: a tab on top and its panel. A new section is its own file with registerView,
// a button in #views and a panel in index.html; switching, the address bar and refresh on
// return to the page live here, shared by all.
// Classic script: shares one global scope with the other page files.
/* exported registerView, refreshView, pageVisible -- used by other page scripts */
const VIEWS = {};
const HOST_SOURCE = "session-atlas-host";
// A plugin iframe waits for the initial size report. A standalone page uses browser visibility.
let paneVisible = !EMBEDDED || new URLSearchParams(location.search).get("host_visibility") !== "1";

function pageVisible() {
  return paneVisible && !document.hidden;
}

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
  if (pageVisible()) VIEWS[view].show?.();
  loadActive();
  syncHeaderLimits();
}

// The server answered again: reload what is on screen.
function refreshView() {
  const v = VIEWS[state.view];
  const fn = v && (v.refresh || v.show);
  if (fn) fn();
}

function viewVisibilityChanged() {
  if (pageVisible()) VIEWS[state.view]?.show?.();
  loadActive();
  syncHeaderLimits();
}

document.addEventListener("visibilitychange", viewVisibilityChanged);
window.addEventListener("message", e => {
  const d = e.data;
  if (!EMBEDDED || e.source !== window.parent || d?.source !== HOST_SOURCE || d.type !== "pane-visibility"
      || typeof d.visible !== "boolean" || d.visible === paneVisible) return;
  paneVisible = d.visible;
  viewVisibilityChanged();
});

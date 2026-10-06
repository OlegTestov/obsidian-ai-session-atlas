// The AI Session Atlas server is down: a banner on top instead of empty cards, with Start inside Obsidian.
// Classic script: shares one global scope with the other page files.
let serverDown = false;
let serverRaising = false;

// Called by api(): false when the network did not answer (server down), true when an answer came, even an error.
const SERVER_RETRY_MS = 5000;
let serverRetry = null;

// While the server is down, poll /health ourselves: the Search tab has no poll of its own, and without
// this a page open during a server restart would stay empty.
function watchServer() {
  window.clearTimeout(serverRetry);
  if (!serverDown) return;
  serverRetry = window.setTimeout(async () => {
    try {
      const r = await window.fetch("/health");
      if (r.ok) { serverStatus(true); return; }
    } catch { /* still down */ }
    watchServer();
  }, SERVER_RETRY_MS);
}

function serverStatus(up) {
  if (up === !serverDown) return;
  serverDown = !up;
  renderServerBanner();
  watchServer();
  if (up) {                                  // back: refresh what is on screen
    refreshView();
    api("/api/facets").then(bindFilters).catch(() => {});   // and the filters, if they did not load
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
      window.setTimeout(() => {                       // the plugin did not answer: allow another press
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

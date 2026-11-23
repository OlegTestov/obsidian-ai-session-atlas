// The parent sends a private port for this session after verifying its tab and process.
const pendingTerminals = new Map();

window.addEventListener("message", event => {
  const data = event.data;
  if (event.source !== window.parent || data?.source !== HOST_SOURCE || data.type !== "card-terminal") return;
  const pending = pendingTerminals.get(data.request);
  const port = event.ports[0];
  if (pending) pending(port);
  else if (port) { port.postMessage({ type: "close" }); port.close(); }
});

function terminalCardPanel(session, pid) {
  const body = el("div", "card-view-body terminal-body");
  const host = el("div", "card-terminal");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", i18n("feed.view.terminal"));
  const status = el("p", "empty");
  body.append(host, status);
  let port = null, renderer = null, request = null, timer = null;
  // Keyboard focus only follows an explicit user action and is spent once: a remount never takes it.
  let wantFocus = false, ended = false;

  function suspend() {
    pendingTerminals.delete(request);
    request = null;
    window.clearTimeout(timer);
    if (port) {
      port.postMessage({ type: "close" });
      port.close();
      port = null;
    }
    renderer?.dispose();
    renderer = null;
    wantFocus = false;
    ended = false;
  }

  function unavailable() {
    suspend();
    status.hidden = false;
    status.textContent = i18n("feed.terminalUnavailable");
  }

  const panel = {
    body, pid, view: "terminal", session,
    mount() {
      if (port || request || (renderer && !ended)) return;
      if (renderer) { renderer.dispose(); renderer = null; ended = false; }   // the PTY ended: connect again
      if (!hostInlineTabs.has(pid) || !window.AtlasCardTerminal) return unavailable();
      status.hidden = false;
      status.textContent = i18n("feed.loading");
      request = window.crypto.randomUUID();
      pendingTerminals.set(request, connected => {
        pendingTerminals.delete(request);
        request = null;
        if (!connected) return unavailable();
        port = connected;
        port.onmessage = ({ data }) => {
          if (data.type === "start") {
            window.clearTimeout(timer);
            try {
              renderer = window.AtlasCardTerminal.open(host, port, data);
              status.hidden = true;
              if (wantFocus) { wantFocus = false; renderer.focus(); }
            } catch (error) {
              console.error(error);
              unavailable();
            }
          } else if (data.type === "data") renderer?.write(data.text);
          else if (data.type === "size") renderer?.resize(data.cols, data.rows);
          else if (data.type === "theme") renderer?.setTheme(data.theme);
          else if (data.type === "exit") {
            if (data.unavailable) return unavailable();
            port.close();
            port = null;
            ended = true;
          }
        };
      });
      if (!tellTabHost("open-card-terminal", { request, ptyPid: pid, claudePid: panel.session.pid,
                                             sessionId: session.session_id, agent: session.agent })) return unavailable();
      timer = window.setTimeout(unavailable, 8000);
    },
    focus() { if (renderer) renderer.focus(); else wantFocus = true; },
    refresh() {},
    suspend,
    dispose: suspend,
  };
  window.addEventListener("pagehide", suspend, { once: true });
  const dispose = panel.dispose;
  panel.dispose = () => { window.removeEventListener("pagehide", suspend); dispose(); };
  return panel;
}

// The card gets its own renderer. The tab stays the owner of the PTY and its terminal replies.
import { SerializeAddon } from "@xterm/addon-serialize";
import { HOST_SOURCE, VIEW_TYPE } from "./constants";
import { MirrorSession } from "./mirror-session";
import { readOpenCodeTab } from "./opencode-tab";

const MAX_INPUT_ROUTE_AGE_MS = 2000;

function snapshotOf(term) {
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const scrollback = term.options.scrollback;
  try {
    const text = serializer.serialize({ scrollback });
    return { text, cols: term.cols, rows: term.rows, scrollback,
      fontSize: term.options.fontSize, fontFamily: term.options.fontFamily, theme: term.options.theme };
  } finally { serializer.dispose(); }
}

async function openCodeTerminalTarget(plugin, data) {
  if (!Number.isInteger(data.ptyPid) || data.ptyPid <= 1 || data.ptyPid !== data.claudePid) return {};
  const tab = (await plugin.terminalTabs()).find(entry => entry.pid === data.ptyPid);
  const view = tab?.leaf.view;
  return matchesOpenCodeRoute(plugin.dataDir(), view, data.sessionId) ? { tab } : {};
}

function matchesOpenCodeRoute(dataDir, view, sessionId, maxAge) {
  if (view?.state?.kind !== "opencode" || !view.pty?.openCodeAttempt) return false;
  const route = readOpenCodeTab(dataDir, view.state.instance, maxAge);
  return !!route?.verified && route.attempt === view.pty.openCodeAttempt && route.current === sessionId;
}

function terminalTarget(plugin, data) {
  return data.agent === "opencode" ? openCodeTerminalTarget(plugin, data) : plugin.checkTarget(data, true);
}

function openTerminalMirror(plugin, event, data) {
  const atlasView = plugin.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => leaf.view)
    .find(view => view.frame?.contentWindow === event.source);
  if (!atlasView || typeof data.request !== "string" || data.request.length > 80) return;
  const source = event.source;
  const current = () => atlasView.frame?.isConnected && atlasView.frame.contentWindow === source;
  const reply = (port) => {
    const message = { source: HOST_SOURCE, type: "card-terminal", request: data.request };
    if (current()) source.postMessage(message, plugin.atlasOrigin(), port ? [port] : []);
    else port?.close();
  };
  terminalTarget(plugin, data).then(({ tab }) => {
    const view = tab?.leaf.view;
    const pty = view?.pty;
    if (!current() || !pty || pty.exited || !view.term || !view.mirrorSubscribers) return reply(null);

    const channel = new MessageChannel();
    const port = channel.port1;
    const dataDir = data.agent === "opencode" ? plugin.dataDir() : null;
    const bound = dataDir
      ? input => view.pty === pty && !pty.exited
        && matchesOpenCodeRoute(dataDir, view, data.sessionId, input ? MAX_INPUT_ROUTE_AGE_MS : undefined)
      : null;
    let routeTimer;
    const session = new MirrorSession({
      term: view.term, serialize: snapshotOf, subscribers: view.mirrorSubscribers,
      post: message => { if (current()) port.postMessage(message); },
      tail: () => view.escTail || "",
      connected: current,
      alive: () => current() && view.pty === pty && !pty.exited,
      bound,
      front: () => plugin.atlasInFront(source),
      pending: on => { view.pendingMirrorInput = Math.max(0, (view.pendingMirrorInput || 0) + (on ? 1 : -1)); },
      writeInput: text => { plugin.touchInput(tab.leaf); pty.write(text); },
      verify: async () => {
        const again = await terminalTarget(plugin, data);
        return again.tab?.leaf.view === view && view.pty === pty;
      },
      fit: (cols, rows) => view.fitMirror(cols, rows),
      onEnd: () => {
        if (routeTimer != null) window.clearInterval(routeTimer);
        atlasView.terminalMirrors.delete(end);
        port.close();
      },
    });
    const end = () => session.end();
    atlasView.terminalMirrors.add(end);
    // A route can change without producing any PTY bytes.
    if (bound) routeTimer = window.setInterval(() => session.checkBinding(), 500);
    port.onmessage = ({ data: command }) => session.command(command);
    session.start(ok => {
      if (ok) reply(channel.port2);
      else { channel.port2.close(); reply(null); }
    });
  }).catch(() => reply(null));
}

export { openTerminalMirror };

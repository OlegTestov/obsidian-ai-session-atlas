// The card gets its own renderer. The tab stays the owner of the PTY and its terminal replies.
import { SerializeAddon } from "@xterm/addon-serialize";
import { HOST_SOURCE, VIEW_TYPE } from "./constants";
import { MirrorSession } from "./mirror-session";

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
  plugin.checkTarget(data).then(({ tab }) => {
    const view = tab?.leaf.view;
    const pty = view?.pty;
    if (!current() || !pty || pty.exited || !view.term || !view.mirrorSubscribers) return reply(null);

    const channel = new MessageChannel();
    const port = channel.port1;
    const session = new MirrorSession({
      term: view.term, serialize: snapshotOf, subscribers: view.mirrorSubscribers,
      post: message => { if (current()) port.postMessage(message); },
      tail: () => view.escTail || "",
      connected: current,
      alive: () => current() && view.pty === pty && !pty.exited,
      front: () => plugin.atlasInFront(source),
      pending: on => { view.pendingMirrorInput = Math.max(0, (view.pendingMirrorInput || 0) + (on ? 1 : -1)); },
      writeInput: text => { plugin.touchInput(tab.leaf); pty.write(text); },
      verify: async () => {
        const again = await plugin.checkTarget(data);
        return again.tab?.leaf.view === view && view.pty === pty;
      },
      fit: (cols, rows) => view.fitMirror(cols, rows),
      onEnd: () => { atlasView.terminalMirrors.delete(end); port.close(); },
    });
    const end = () => session.end();
    atlasView.terminalMirrors.add(end);
    port.onmessage = ({ data: command }) => session.command(command);
    session.start(ok => {
      if (ok) reply(channel.port2);
      else { channel.port2.close(); reply(null); }
    });
  }).catch(() => reply(null));
}

export { openTerminalMirror };

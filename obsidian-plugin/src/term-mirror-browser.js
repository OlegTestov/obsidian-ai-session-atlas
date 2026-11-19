// Browser build for the card in the catalog iframe. Uses the existing xterm version.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { inputMessage } from "./term-input";
import { xtermInternals } from "./term-internals";

// Keep the page's CSP. Only the styles created by this renderer receive the script's nonce.
function terminalDocument(nonce) {
  return new Proxy(document, {
    get(doc, key) {
      if (key === "createElement") return (tag, options) => {
        const node = doc.createElement(tag, options);
        if (tag === "style") node.nonce = nonce;
        if (tag === "span") {
          const set = node.setAttribute;
          node.setAttribute = (name, value) => {
            if (name === "style") node.style.cssText = value;
            else set.call(node, name, value);
          };
        }
        return node;
      };
      const value = doc[key];
      return typeof value === "function" ? value.bind(doc) : value;
    },
  });
}

const nonce = document.currentScript?.nonce;
const doc = terminalDocument(nonce);

function openWithStyles(term, host) {
  // xterm's viewport also uses window.document for its stylesheet during open().
  const create = document.createElement;
  const own = Object.getOwnPropertyDescriptor(document, "createElement");
  document.createElement = function (tag, options) {
    const node = create.call(this, tag, options);
    if (tag === "style") node.nonce = nonce;
    return node;
  };
  try { term.open(host); }
  finally {
    if (own) Object.defineProperty(document, "createElement", own);
    else delete document.createElement;
  }
}
function open(host, port, first) {
  const term = new Terminal({
    cols: first.cols, rows: first.rows, scrollback: first.scrollback, documentOverride: doc,
    fontFamily: first.fontFamily, fontSize: first.fontSize, theme: first.theme,
    macOptionIsMeta: true,
  });
  try { return connect(term, host, port, first); }
  catch (error) { term.dispose(); throw error; }
}

function connect(term, host, port, first) {
  const fit = new FitAddon();
  term.loadAddon(fit);
  openWithStyles(term, host);
  // xterm 6 gives the row factory the global document even with documentOverride.
  // Keep the adapter local to this renderer so truecolor cells use the CSSOM too.
  const internals = xtermInternals(term);
  internals.rows._document = doc;
  const sendInput = text => {
    const message = inputMessage(text);
    if (message) port.postMessage(message);
  };

  // The original xterm already answers TUI queries. Forward only input from the user.
  // xterm 6 emits onUserInput immediately before onData for keys, paste and SGR mouse input.
  let userInput = false;
  internals.onUserInput(() => { userInput = true; });
  term.onData(text => {
    if (userInput && host.contains(document.activeElement)) sendInput(text);
    userInput = false;
  });
  term.onBinary(text => {
    if (host.contains(document.activeElement)) sendInput(text);
  });
  term.attachCustomKeyEventHandler(event => {
    if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return true;
    if (event.type === "keydown") port.postMessage({ type: "input", text: "\x1b\r" });
    return false;
  });
  term.write(first.text);

  let requested = "";
  const requestSize = () => {
    if (!host.clientHeight || !host.clientWidth) return;
    const size = fit.proposeDimensions();
    if (!size || size.cols < 2 || size.rows < 2) return;
    const key = `${size.cols}×${size.rows}`;
    if (key === requested) return;
    requested = key;
    port.postMessage({ type: "size", ...size });
  };
  const watch = new ResizeObserver(requestSize);
  watch.observe(host);
  term.textarea.addEventListener("focus", () => { requested = ""; requestSize(); });
  return {
    write: text => term.write(text),
    resize: (cols, rows) => term.resize(cols, rows),
    setTheme: theme => { term.options.theme = theme; },
    focus: () => term.focus(),
    dispose: () => { watch.disconnect(); term.dispose(); },
  };
}
window.AtlasCardTerminal = { open };

// Selecting and copying in the agent terminal tab. Plain functions over an xterm Terminal, so the
// browser test runs them against the real xterm.js (tests/e2e/terminal.spec.mjs).

/**
 * Under Obsidian's node integration xterm takes itself for Node, not macOS (`"title" in process`),
 * and ignores macOptionClickForcesSelection: ⌥-drag went to the program. While the program holds the
 * mouse (Claude Code's fullscreen view), ⌥ or Shift held selects in the terminal instead.
 * Returns false when xterm no longer has this hook (an xterm update): the browser test catches that.
 */
function selectWithModifier(term) {
  const service = term && term._core && term._core._selectionService;
  if (!service || typeof service.shouldForceSelection !== "function") return false;
  service.shouldForceSelection = (event) => !!(event && (event.altKey || event.shiftKey));
  // As on macOS with forced selection: ⌥-drag selects lines, not a rectangle.
  if (typeof service.shouldColumnSelect === "function") service.shouldColumnSelect = () => false;
  return true;
}

/** ⌘C: by the letter, or by the key's place when the layout is not Latin (Cyrillic "с"). */
function isCopyKey(e) {
  if (!e || e.type !== "keydown" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  const key = String(e.key || "").toLowerCase();
  return key === "c" || (!/^[a-z]$/.test(key) && e.code === "KeyC");
}

/** Through the async clipboard; where Electron refuses it, through a hidden field and "copy". */
function writeClipboard(text, doc = document) {
  const fallback = () => {
    const area = doc.createElement("textarea");
    area.value = text;
    doc.body.appendChild(area);
    try {
      area.select();
      return doc.execCommand("copy");
    } finally {
      area.remove();
    }
  };
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
  if (!clip || typeof clip.writeText !== "function") return Promise.resolve(fallback());
  return clip.writeText(text).then(() => true, () => fallback());
}

/** Copies the terminal's selection; false when nothing is selected. */
function copySelection(term, doc) {
  if (!term || !term.hasSelection()) return false;
  writeClipboard(term.getSelection(), doc);
  return true;
}

/**
 * A page-wide "copy" belongs to this terminal: its tab is the active one, it has a selection, and the
 * keyboard is not in a text field of its own (a field's copy is that field's).
 */
function copyTarget(event, leaf, activeLeaf, term) {
  if (!event || !event.clipboardData || leaf !== activeLeaf || !term || !term.hasSelection()) return false;
  const target = event.target;
  const field = target && /^(INPUT|TEXTAREA)$/.test(target.tagName || "") && !target.classList.contains("xterm-helper-textarea");
  return !field && !(target && target.isContentEditable);
}

/** Pastes the clipboard as typed input: xterm wraps it in bracketed paste when the program asked. */
async function pasteClipboard(term) {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
  if (!term || !clip || typeof clip.readText !== "function") return false;
  const text = await clip.readText().catch(() => "");
  if (!text) return false;
  term.paste(text);
  return true;
}

/** Context menu items: what is offered, and whether copying has a selection to copy. */
function menuItems(term) {
  return [
    { id: "copy", icon: "copy", disabled: !(term && term.hasSelection()) },
    { id: "paste", icon: "clipboard-paste", disabled: false },
  ];
}

export { selectWithModifier, isCopyKey, writeClipboard, copySelection, pasteClipboard, menuItems, copyTarget };

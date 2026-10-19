// Codex caches OSC 11 at startup, so its RGB panel backgrounds outlive a terminal theme.
// Adapt the displayed surfaces through xterm decorations; keep the buffer and PTY input intact.
function surfaceColor(background, history = false) {
  let rgb;
  const hex = /^#([a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(background || "");
  if (hex) {
    const value = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
  } else {
    const match = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(background || "");
    if (match) rgb = match.slice(1, 4).map(Number);
  }
  if (!rgb) return null;
  // Codex tui/style.rs: the composer and submitted prompts use different fills.
  const light = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 128;
  const alpha = light ? (history ? 0.02 : 0.04) : (history ? 0.16 : 0.12);
  return "#" + rgb.map(c => Math.floor(light ? c * (1 - alpha) : 255 * alpha + c * (1 - alpha))
    .toString(16).padStart(2, "0")).join("");
}

function followCodexSurface(term) {
  const view = term.element.ownerDocument.defaultView;
  let frame = null, disposed = false, signature = "", decorations = [];
  const tones = { composer: null, history: null };
  const clear = () => {
    for (const { marker, decoration } of decorations) { decoration.dispose(); marker.dispose(); }
    decorations = [];
  };
  const update = () => {
    frame = null;
    if (disposed) return;
    const buffer = term.buffer.active;
    const targets = { composer: surfaceColor(term.options.theme?.background),
                      history: surfaceColor(term.options.theme?.background, true) };
    const spans = [];
    const scratch = buffer.getNullCell();
    if (targets.composer) {
      // Inspect the current screen and visible scrollback, without walking the whole history.
      const rows = new Set();
      for (const start of [buffer.baseY, buffer.viewportY]) {
        for (let y = start; y < Math.min(buffer.length, start + term.rows); y++) rows.add(y);
      }
      for (const y of rows) {
        const line = buffer.getLine(y);
        const arrow = line?.getCell(0, scratch);
        if (arrow?.getChars() !== "›") continue;
        const history = !!arrow.isBold() && !!arrow.isDim();
        const cell = line.getCell(2, scratch);
        if (!cell?.isBgRGB()) continue;
        const candidate = cell.getBgColor();
        // Submitted prompts use a bold, dim arrow; pickers use an ordinary selection arrow.
        if (history) { tones.history = candidate; continue; }
        const above = buffer.getLine(y - 1);
        const padding = above?.getCell(2, scratch);
        if (above?.translateToString(true).trim() === "" && padding?.isBgRGB() &&
            padding.getBgColor() === candidate) tones.composer = candidate;
      }
      const colors = new Map(Object.entries(tones)
        .filter(([kind, tone]) => tone !== null && tone !== parseInt(targets[kind].slice(1), 16))
        .map(([kind, tone]) => [tone, targets[kind]]));
      if (colors.size) {
        for (let y = buffer.viewportY; y < Math.min(buffer.length, buffer.viewportY + term.rows); y++) {
          const line = buffer.getLine(y);
          let start = -1, color = null;
          for (let x = 0; x <= term.cols; x++) {
            const cell = x < term.cols ? line?.getCell(x, scratch) : null;
            const nextColor = cell?.isBgRGB() ? colors.get(cell.getBgColor()) || null : null;
            if (nextColor === color) continue;
            if (start >= 0) spans.push({ y, x: start, width: x - start, color });
            start = nextColor ? x : -1;
            color = nextColor;
          }
        }
      }
    }
    const next = JSON.stringify([buffer.type, targets, spans]);
    if (next === signature && decorations.every(d => !d.marker.isDisposed && d.marker.line === d.y)) return;
    signature = next;
    clear();
    for (const span of spans) {
      const marker = term.registerMarker(span.y - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const decoration = term.registerDecoration({ marker, x: span.x, width: span.width,
                                                  backgroundColor: span.color, layer: "bottom" });
      if (decoration) decorations.push({ ...span, marker, decoration });
      else marker.dispose();
    }
  };
  // Output, scroll and theme events in one frame share a bounded scan of the visible screen.
  const refresh = () => { if (!disposed && frame === null) frame = view.requestAnimationFrame(update); };
  const events = [term.onWriteParsed(refresh), term.onScroll(refresh), term.onResize(refresh),
    term.buffer.onBufferChange(() => { signature = ""; clear(); refresh(); })];
  refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      for (const event of events) event.dispose();
      clear();
    },
  };
}

export { followCodexSurface, surfaceColor };

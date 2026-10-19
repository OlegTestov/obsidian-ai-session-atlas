// Codex caches OSC 11 at startup, so its RGB panel backgrounds outlive a terminal theme.
// Adapt the displayed surfaces through xterm decorations; keep the buffer and PTY input intact.
function surfaceColor(background) {
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
  // Codex tui/style.rs: black at 4% on light, white at 12% on dark.
  const light = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 128;
  return "#" + rgb.map(c => Math.floor(light ? c * 0.96 : 255 * 0.12 + c * 0.88)
    .toString(16).padStart(2, "0")).join("");
}

function followCodexSurface(term) {
  const view = term.element.ownerDocument.defaultView;
  let frame = null, disposed = false, tone = null, signature = "", decorations = [];
  const clear = () => {
    for (const { marker, decoration } of decorations) { decoration.dispose(); marker.dispose(); }
    decorations = [];
  };
  const update = () => {
    frame = null;
    if (disposed) return;
    const buffer = term.buffer.active;
    const target = surfaceColor(term.options.theme?.background);
    const spans = [];
    const scratch = buffer.getNullCell();
    if (target) {
      // Learn the surface from Codex's actual prompt, also when reattaching an existing PTY.
      for (let y = buffer.baseY; y < Math.min(buffer.length, buffer.baseY + term.rows); y++) {
        const line = buffer.getLine(y);
        if (line?.getCell(0, scratch)?.getChars() !== "›") continue;
        const cell = line.getCell(2, scratch);
        if (!cell?.isBgRGB()) continue;
        const candidate = cell.getBgColor();
        // Pickers also use › for the selected option; only the composer has a blank surface above it.
        const above = buffer.getLine(y - 1);
        const padding = above?.getCell(2, scratch);
        if (above?.translateToString(true).trim() === "" && padding?.isBgRGB() &&
            padding.getBgColor() === candidate) tone = candidate;
      }
      if (tone !== null && tone !== parseInt(target.slice(1), 16)) {
        for (let y = buffer.viewportY; y < Math.min(buffer.length, buffer.viewportY + term.rows); y++) {
          const line = buffer.getLine(y);
          let start = -1;
          for (let x = 0; x <= term.cols; x++) {
            const cell = x < term.cols ? line?.getCell(x, scratch) : null;
            if (cell?.isBgRGB() && cell.getBgColor() === tone) {
              if (start < 0) start = x;
            } else if (start >= 0) {
              // Pickers share this cached surface but may occupy only part of a row.
              spans.push({ y, x: start, width: x - start });
              start = -1;
            }
          }
        }
      }
    }
    const next = JSON.stringify([buffer.type, target, spans]);
    if (next === signature && decorations.every(d => !d.marker.isDisposed && d.marker.line === d.y)) return;
    signature = next;
    clear();
    for (const span of spans) {
      const marker = term.registerMarker(span.y - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const decoration = term.registerDecoration({ marker, x: span.x, width: span.width,
                                                  backgroundColor: target, layer: "bottom" });
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

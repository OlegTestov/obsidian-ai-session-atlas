// Agent UIs can keep explicit neutral RGB colours after the terminal changes its default palette.
// Only adapt unreadable neutral text on the default background; preserve panels and accent colours.
function unreadableNeutrals(background) {
  let rgb;
  const hex = /^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(background || "");
  if (hex) {
    const value = hex[1].length < 5 ? [...hex[1]].map(c => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16));
  } else {
    const match = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(background || "");
    if (match) rgb = match.slice(1, 4).map(Number);
  }
  if (!rgb) return new Set();
  const linear = rgb.map(c => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const bad = new Set();
  for (let grey = 0; grey < 256; grey++) {
    const c = grey / 255, level = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const contrast = (Math.max(level, luminance) + 0.05) / (Math.min(level, luminance) + 0.05);
    if (contrast < 4.5) bad.add(grey * 0x010101);
  }
  return bad;
}

function followTextContrast(term) {
  const view = term.element.ownerDocument.defaultView;
  let frame = null, disposed = false, signature = "", decorations = [];
  const clear = () => {
    for (const { marker, decoration } of decorations) { decoration.dispose(); marker.dispose(); }
    decorations = [];
  };
  let background = null, bad = new Set();
  const update = () => {
    frame = null;
    if (disposed) return;
    const buffer = term.buffer.active, theme = term.options.theme || {};
    if (background !== theme.background) {
      background = theme.background;
      bad = unreadableNeutrals(background);
    }
    const spans = [];
    const scratch = buffer.getNullCell();
    if (theme.foreground && bad.size) {
      for (let y = buffer.viewportY; y < Math.min(buffer.length, buffer.viewportY + term.rows); y++) {
        const line = buffer.getLine(y);
        let start = -1;
        for (let x = 0; x <= term.cols; x++) {
          const cell = x < term.cols ? line?.getCell(x, scratch) : null;
          const adapt = cell && !cell.isInverse() && cell.isBgDefault() && cell.isFgRGB() && bad.has(cell.getFgColor());
          if (adapt && start < 0) start = x;
          else if (!adapt && start >= 0) { spans.push({ y, x: start, width: x - start }); start = -1; }
        }
      }
    }
    const next = JSON.stringify([buffer.type, theme.foreground, spans]);
    if (next === signature && decorations.every(d => !d.marker.isDisposed && d.marker.line === d.y)) return;
    signature = next;
    clear();
    for (const span of spans) {
      const marker = term.registerMarker(span.y - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const decoration = term.registerDecoration({ marker, x: span.x, width: span.width,
        foregroundColor: theme.foreground, layer: "bottom" });
      if (decoration) decorations.push({ ...span, marker, decoration });
      else marker.dispose();
    }
  };
  const refresh = () => { if (!disposed && frame === null) frame = view.requestAnimationFrame(update); };
  const events = [term.onWriteParsed(refresh), term.onScroll(refresh), term.onResize(refresh),
    term.buffer.onBufferChange(() => { signature = ""; clear(); refresh(); })];
  refresh();
  return { refresh, dispose() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    for (const event of events) event.dispose();
    clear();
  } };
}

export { followTextContrast };

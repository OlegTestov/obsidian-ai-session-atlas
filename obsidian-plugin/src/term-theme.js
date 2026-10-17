/** Terminal colours come from the Obsidian theme: light and dark without configuration. */
function themeFromCss(el) {
  const css = getComputedStyle(el);
  let context;
  const v = (name, fallback) => {
    const value = (css.getPropertyValue(name) || "").trim() || fallback;
    if (value === fallback || /^#(?:[a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) return value;
    // xterm accepts legacy RGB/hex, but Obsidian uses color-mix/oklch and hsl.
    // Let this window's browser resolve the colour, including its alpha, into sRGB bytes.
    if (!context) {
      const canvas = (el.ownerDocument || document).createElement("canvas");
      canvas.width = canvas.height = 1;
      context = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!context) return fallback;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = fallback;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
  };
  return {
    background: v("--background-primary", "#1e1e1e"),
    foreground: v("--text-normal", "#dcddde"),
    cursor: v("--text-accent", "#7f6df2"),
    selectionBackground: v("--text-selection", "rgba(127,109,242,.35)"),
  };
}

/** Follows an Obsidian theme change (by hand, or with the system at nightfall) in the terminal colours.
 *  Returns true when the colours changed. */
function applyTheme(term, el) {
  if (!term) return false;
  const next = themeFromCss(el);
  const now = term.options.theme || {};
  if (Object.keys(next).every((k) => now[k] === next[k])) return false;
  term.options.theme = next;
  return true;
}

export { themeFromCss, applyTheme };

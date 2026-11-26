// The same rectangle picker serves the Active toolbar and fixed workspace layouts.
/* exported buildLayoutGrid, LAYOUT_CELLS -- used by other page scripts */
const LAYOUT_CELLS = 5;

function buildLayoutGrid(onPick) {
  const grid = el("div", "lay-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", i18n("active.layoutAria"));
  const hint = el("span");
  const cells = [];
  let size = null;
  const cellAt = (c, r) => cells[(r - 1) * LAYOUT_CELLS + c - 1];
  const paint = (c, r) => {
    cells.forEach(cell => cell.classList.toggle("hot", +cell.dataset.c <= c && +cell.dataset.r <= r));
    hint.textContent = c ? `${i18nN("active.cols", c)} × ${i18nN("active.rows", r)}`
      : i18n("active.hoverAndClick");
  };
  const selectForKeyboard = cell => {
    cells.forEach(button => { button.tabIndex = button === cell ? 0 : -1; });
  };
  for (let r = 1; r <= LAYOUT_CELLS; r++) {
    for (let c = 1; c <= LAYOUT_CELLS; c++) {
      const cell = el("button");
      cell.type = "button";
      cell.dataset.c = c;
      cell.dataset.r = r;
      cell.setAttribute("aria-label", `${c} × ${r}`);
      cell.addEventListener("mouseenter", () => paint(c, r));
      cell.addEventListener("focus", () => { selectForKeyboard(cell); paint(c, r); });
      cell.addEventListener("click", () => onPick({ c, r }));
      cells.push(cell);
      grid.appendChild(cell);
    }
  }
  grid.addEventListener("mouseleave", () => paint(size?.c || 0, size?.r || 0));
  grid.addEventListener("keydown", event => {
    const directions = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
    const offset = directions[event.key];
    if (!offset || !event.target.dataset.c) return;
    event.preventDefault();
    const c = +event.target.dataset.c + offset[0], r = +event.target.dataset.r + offset[1];
    if (c >= 1 && c <= LAYOUT_CELLS && r >= 1 && r <= LAYOUT_CELLS) cellAt(c, r).focus();
  });
  return { grid, hint, update(value) {
    size = value;
    cells.forEach(cell => {
      const { c, r } = cell.dataset;
      const selected = +c === size?.c && +r === size?.r;
      cell.classList.toggle("cur", selected);
      cell.setAttribute("aria-pressed", String(selected));
    });
    selectForKeyboard(cellAt(size?.c || 1, size?.r || 1));
    paint(size?.c || 0, size?.r || 0);
  } };
}

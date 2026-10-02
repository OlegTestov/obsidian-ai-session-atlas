// «Активные»: фильтры-списки с галочками и выбор сетки.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
function passes(s, except) {
  return AtlasLogic.passes(s, activeFilter, except);
}

// Счётчик у значения — сколько сессий оно даст при остальных выбранных фильтрах.
function optionsFor(key) {
  return AtlasLogic.filterOptions(activeSessions, activeFilter, key);
}

// Коротко, чтобы полоса влезала в строку: «Домен» или «Домен · 2»; выбранное — в подсказке.
// Полоса фильтров прокручивается вбок, а прокручиваемый блок обрезает всё, что из него торчит:
// выпадающее окно ставится поверх страницы, под свою кнопку (CSSOM — CSP это разрешает).
function placePop(pop, btn) {
  const r = btn.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = (r.bottom + 4) + "px";
  pop.style.left = Math.max(6, Math.min(window.innerWidth - pop.offsetWidth - 6, r.left)) + "px";
}

// Что выбрано — только в подсказке: на кнопке лишь метка «фильтр включён».
function buttonContent(f) {
  const parts = [f.label];
  if (activeFilter[f.key].size) parts.push(el("span", "fdot", "●"));
  parts.push(" ▾");
  return parts;
}

function buttonHint(f) {
  const picked = [...activeFilter[f.key]].map(v =>
    f.key === "period" ? (PERIODS.find(p => p.value === v) || { label: v }).label : v);
  return picked.length ? `${f.label}: ${picked.join(", ")}` : i18n("active.filterAll", { label: f.label });
}

// Счётчики списка от его же галочек не зависят — сам список при их смене не перерисовываем,
// иначе под курсором пропадает элемент и сбрасывается прокрутка.
function onFilterChange(fromKey) {
  writeHash();
  refreshFilterButtons(fromKey);
  renderActive(fromKey);
}

function fillList(f) {
  const ui = filterUI[f.key];
  const needle = ui.search ? ui.search.value.trim().toLowerCase() : "";
  const items = optionsFor(f.key).filter(o => !needle || String(o.label).toLowerCase().includes(needle));
  ui.list.replaceChildren();
  if (!items.length) { ui.list.appendChild(el("p", "empty", i18n("active.noValues"))); return; }
  items.forEach(o => {
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.checked = activeFilter[f.key].has(o.value);
    box.addEventListener("change", () => {
      box.checked ? activeFilter[f.key].add(o.value) : activeFilter[f.key].delete(o.value);
      onFilterChange(f.key);
    });
    label.append(box, document.createTextNode(o.label), el("span", "n", String(o.count)));
    ui.list.appendChild(label);
  });
}

const parseLayout = AtlasLogic.parseLayout;

function layoutLabel() {
  const l = layout[activeMode];
  if (l) return `${l.c}×${l.r}`;
  return activeMode === "full" ? i18n("active.auto") : "4×5";
}

// Выбор сетки как вставка таблицы: ведёшь мышью по клеткам — подсвечивается прямоугольник.
function buildLayoutPicker() {
  const wrap = el("div", "lay");
  const btn = el("button", "lay-btn");
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.title = i18n("active.layoutHint");
  const pop = el("div", "lay-pop hidden");
  pop.setAttribute("role", "group");
  pop.setAttribute("aria-label", i18n("active.layoutAria"));
  const grid = el("div", "lay-grid");
  const hint = el("span", null, "");
  const cells = [];
  const paint = (c, r) => {
    cells.forEach(b => b.classList.toggle("hot", +b.dataset.c <= c && +b.dataset.r <= r));
    hint.textContent = c ? `${i18nN("active.cols", c)} × ${i18nN("active.rows", r)}`
      : i18n("active.hoverAndClick");
  };
  for (let r = 1; r <= LAYOUT_CELLS; r++) {
    for (let c = 1; c <= LAYOUT_CELLS; c++) {
      const cell = el("button");
      cell.dataset.c = c;
      cell.dataset.r = r;
      cell.setAttribute("aria-label", `${c} × ${r}`);
      cell.addEventListener("mouseenter", () => paint(c, r));
      cell.addEventListener("focus", () => paint(c, r));
      cell.addEventListener("click", () => {
        layout[activeMode] = { c, r };
        closeFilters();
        onLayoutChange();
      });
      cells.push(cell);
      grid.appendChild(cell);
    }
  }
  grid.addEventListener("mouseleave", () => {
    const l = layout[activeMode];
    paint(l ? l.c : 0, l ? l.r : 0);
  });
  const auto = el("button", null, i18n("active.auto"));
  auto.title = activeMode === "full" ? i18n("active.autoFullHint") : i18n("active.autoCompactHint");
  auto.addEventListener("click", () => { layout[activeMode] = null; closeFilters(); onLayoutChange(); });
  const foot = el("div", "lay-foot");
  foot.append(hint, auto);
  pop.append(grid, foot);
  pop.addEventListener("click", e => e.stopPropagation());
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = pop.classList.contains("hidden");
    closeFilters();
    pop.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) placePop(pop, btn);
    if (open) {
      // Поле под предел вида: 5 × 5 у компактного, 4 × 4 у подробного.
      const max = LAYOUT_MAX[activeMode];
      grid.classList.toggle("m5", max === 5);
      cells.forEach(b => b.classList.toggle("off", +b.dataset.c > max || +b.dataset.r > max));
      const l = layout[activeMode];
      cells.forEach(b => b.classList.toggle("cur", !!l && +b.dataset.c === l.c && +b.dataset.r === l.r));
      paint(l ? l.c : 0, l ? l.r : 0);
    }
  });
  wrap.append(btn, pop);
  layoutUI = { btn, pop };
  refreshLayoutButton();
  return wrap;
}

function refreshLayoutButton() {
  if (!layoutUI) return;
  layoutUI.btn.replaceChildren(svgIcon([["rect", { x: 3, y: 3, width: 7, height: 7 }],
    ["rect", { x: 14, y: 3, width: 7, height: 7 }], ["rect", { x: 3, y: 14, width: 7, height: 7 }],
    ["rect", { x: 14, y: 14, width: 7, height: 7 }]]), document.createTextNode(layoutLabel()));
  layoutUI.btn.classList.toggle("on", !!layout[activeMode]);
}

function onLayoutChange() {
  writeHash();
  refreshLayoutButton();
  renderActive(null, true);
}

function closeFilters(except) {
  if (layoutUI && except !== layoutUI) {
    layoutUI.pop.classList.add("hidden");
    layoutUI.btn.setAttribute("aria-expanded", "false");
  }
  Object.values(filterUI).forEach(ui => {
    if (ui === except) return;
    ui.pop.classList.add("hidden");
    ui.btn.setAttribute("aria-expanded", "false");
  });
}

function buildFilters() {
  const bar = $("#active-filters");
  ACTIVE_FILTERS.forEach(f => {
    const wrap = el("div", "ms");
    const btn = el("button", "ms-btn");
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    const pop = el("div", "ms-pop hidden");
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", f.label);
    const search = f.key === "period" ? null : el("input");
    if (search) {
      search.type = "search";
      search.placeholder = i18n("active.find");
      search.addEventListener("input", () => fillList(f));
      pop.appendChild(search);
    }
    const actions = el("div", "ms-actions");
    const all = el("button", null, i18n("active.allVisible"));
    const none = el("button", null, i18n("active.reset"));
    all.addEventListener("click", () => {
      optionsFor(f.key).forEach(o => activeFilter[f.key].add(o.value)); fillList(f); onFilterChange();
    });
    none.addEventListener("click", () => {
      activeFilter[f.key].clear(); fillList(f); onFilterChange();
    });
    actions.append(all, none);
    const list = el("div", "ms-list");
    pop.append(actions, list);
    pop.addEventListener("click", e => e.stopPropagation());   // клик внутри не закрывает
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const open = pop.classList.contains("hidden");
      closeFilters(filterUI[f.key]);
      pop.classList.toggle("hidden", !open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) { fillList(f); placePop(pop, btn); if (search) search.focus(); }
    });
    wrap.append(btn, pop);
    bar.appendChild(wrap);
    filterUI[f.key] = { btn, pop, list, search };
  });
  const mode = el("div", "mode");
  mode.setAttribute("role", "group");
  mode.setAttribute("aria-label", i18n("active.viewAria"));
  [["compact", i18n("active.modeCompact"), i18n("active.modeCompactHint")],
   ["full", i18n("active.modeFull"), i18n("active.modeFullHint")]].forEach(([value, label, hint]) => {
    const b = el("button", null, label);
    b.title = hint;
    b.dataset.mode = value;
    b.addEventListener("click", () => {
      activeMode = value; writeHash(); refreshLayoutButton(); renderActive(null, true);
      if (value === "full") loadActive();      // подробному виду нужен хвост переписки
    });
    mode.appendChild(b);
  });
  bar.appendChild(mode);
  bar.appendChild(buildLayoutPicker());
  bar.appendChild(newSessionButton());
  const reset = el("button", "chip", i18n("active.reset"));
  reset.id = "active-reset";
  reset.addEventListener("click", () => {
    ACTIVE_FILTERS.forEach(({ key }) => activeFilter[key].clear());
    closeFilters();
    onFilterChange();
  });
  const summary = el("span");
  summary.id = "active-summary";
  bar.append(reset, summary);
  wheelScroll(bar);                       // не влезла в узкое окно — крутится колесом вбок
  // Окно стоит поверх страницы: полоса сдвинулась или окно сменило размер — закрыть.
  bar.addEventListener("scroll", () => closeFilters());
  window.addEventListener("resize", () => closeFilters());
  refreshFilterButtons();
}

function refreshFilterButtons(skipKey) {
  ACTIVE_FILTERS.forEach(f => {
    const ui = filterUI[f.key];
    if (!ui) return;
    ui.btn.replaceChildren(...buttonContent(f));
    ui.btn.title = buttonHint(f);
    ui.btn.classList.toggle("on", activeFilter[f.key].size > 0);
    // Открытый список обновляем на месте: опрос раз в 5 секунд не должен его закрывать.
    if (f.key !== skipKey && !ui.pop.classList.contains("hidden")) {
      const top = ui.list.scrollTop;
      fillList(f);
      ui.list.scrollTop = top;
    }
  });
  const any = ACTIVE_FILTERS.some(({ key }) => activeFilter[key].size);
  $("#active-reset").classList.toggle("hidden", !any);
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closeFilters(); });

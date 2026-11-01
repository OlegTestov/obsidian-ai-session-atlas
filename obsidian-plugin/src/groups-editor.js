// The group editor under a chip, as Chrome's: the name field, nine colours and the group's actions.
// Obsidian's Menu cannot hold a text field, so this is a small popover of its own. Changes apply as
// you type or click; Escape, Enter or a click outside closes it.
import { setIcon } from "obsidian";
import { COLORS, MAX_NAME, cleanName } from "./groups-model";

const EDITOR = "sa-group-editor";
// Open editors' close functions: the plugin closes them on unload (registered once per plugin).
const closers = new Set();
const registered = new WeakSet();

function closeOpenEditors(doc) {
  for (const el of doc.querySelectorAll(`.${EDITOR}`)) if (el.closeEditor) el.closeEditor();
}

function openGroupEditor(plugin, id, anchor, { focusName = false } = {}) {
  const doc = anchor.ownerDocument || document;
  closeOpenEditors(doc);
  const group = () => plugin.groups.groups[id];
  if (!group()) return null;
  if (!registered.has(plugin)) {
    registered.add(plugin);
    plugin.register(() => { for (const close of [...closers]) close(); });
  }
  const t = (key, vars) => plugin.t(key, vars);
  const box = doc.body.createDiv({ cls: EDITOR });
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", t("group.editor.label"));

  const name = box.createEl("input", { cls: "sa-group-editor-name", type: "text" });
  name.placeholder = t("group.editor.namePlaceholder");
  name.maxLength = MAX_NAME;
  name.value = group().name;
  name.setAttribute("aria-label", t("group.editor.name"));
  name.addEventListener("input", () => {
    if (!group()) return close();
    plugin.updateGroup(id, { name: cleanName(name.value) });
  });

  const swatches = box.createDiv({ cls: "sa-group-editor-colors" });
  swatches.setAttribute("role", "radiogroup");
  swatches.setAttribute("aria-label", t("group.editor.color"));
  const buttons = COLORS.map((color) => {
    const b = swatches.createEl("button", { cls: `sa-group-swatch sa-c-${color}` });
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", t(`group.color.${color}`));
    b.title = t(`group.color.${color}`);
    b.addEventListener("click", () => {
      if (!group()) return close();
      plugin.updateGroup(id, { color });
      paint();
    });
    return b;
  });
  const paint = () => {
    const now = group();
    buttons.forEach((b, i) => {
      const on = !!now && COLORS[i] === now.color;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  // Arrows walk the colours, as in a radio group.
  swatches.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    if (!group()) return close();
    const i = (COLORS.indexOf(group().color) + step + COLORS.length) % COLORS.length;
    plugin.updateGroup(id, { color: COLORS[i] });
    paint();
    buttons[i].focus();
  });
  paint();

  const actions = box.createDiv({ cls: "sa-group-editor-actions" });
  const action = (icon, label, run, cls) => {
    const row = actions.createEl("button", { cls: "sa-group-editor-action" + (cls ? " " + cls : "") });
    row.type = "button";
    setIcon(row.createSpan({ cls: "sa-group-editor-icon" }), icon);
    row.createSpan({ text: label });
    row.addEventListener("click", () => { close(); run(); });
    return row;
  };
  for (const kind of ["claude", "codex"]) {
    if (plugin.agentEnabled(kind)) action(kind === "claude" ? "bot" : "codex-bot", t(`group.editor.new.${kind}`),
                                          () => plugin.openInGroup(kind, id));
  }
  action(group().collapsed ? "chevrons-left-right" : "chevrons-right-left",
         t(group().collapsed ? "group.editor.unfold" : "group.editor.fold"), () => plugin.toggleGroupFolded(id));
  action("ungroup", t("group.editor.ungroup"), () => plugin.ungroup(id));
  action("x", t("group.editor.close"), () => plugin.closeGroup(id), "mod-warning");

  const place = () => {
    const r = anchor.getBoundingClientRect();
    // Under a chip: below the whole tab strip, so the group's line under it stays in sight.
    const strip = typeof anchor.closest === "function" ? anchor.closest(".workspace-tab-header-container") : null;
    const below = strip ? Math.max(r.bottom, strip.getBoundingClientRect().bottom) : r.bottom;
    const width = box.offsetWidth;
    const view = doc.defaultView || window;
    box.setCssProps({ "--sa-editor-left": `${Math.max(8, Math.min(view.innerWidth - width - 8, r.left))}px`,
                      "--sa-editor-top": `${below + 6}px` });
  };
  place();

  let closed = false;
  const view = doc.defaultView || window;
  const onDown = (event) => { if (!box.contains(event.target) && event.target !== anchor) close(); };
  // A click into the catalog's frame never reaches this document: the window loses focus instead.
  const onBlur = () => close();
  const onFocusOut = (event) => { if (event.relatedTarget && !box.contains(event.relatedTarget)) close(); };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Enter" && event.target === name) { event.preventDefault(); close(true); }
  };
  const close = (refocus) => {
    if (closed) return;
    closed = true;
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("keydown", onKey, true);
    view.removeEventListener("blur", onBlur);
    closers.delete(box.closeEditor);
    box.remove();
    if (refocus && anchor.isConnected) anchor.focus();
  };
  box.closeEditor = () => close();
  closers.add(box.closeEditor);
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("keydown", onKey, true);
  view.addEventListener("blur", onBlur);
  box.addEventListener("focusout", onFocusOut);
  if (focusName) { name.focus(); name.select(); } else buttons[COLORS.indexOf(group().color)].focus();
  return box;
}

export { openGroupEditor, EDITOR };

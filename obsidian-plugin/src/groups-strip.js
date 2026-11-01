// Session groups in Obsidian's tab strip: a coloured chip before a group's first tab, a line of the
// group's colour under its tabs, and a folded group that shows only its chip. Obsidian rebuilds the
// strip's children on every change and drops anything foreign there, so the chip lives inside the
// first tab's header, drawn in that header's left margin. Mixed into the plugin class.
import { runs, tabOutside } from "./groups-model";

const CHIP = "sa-group-chip";
const LINE = "sa-group-line";
const MARKS = ["sa-grouped", "sa-group-first", "sa-group-last", "sa-group-folded", "sa-group-folded-head"];
const CHIP_GAP_PX = 6;

/** The tab strips: Obsidian's tab containers with their leaves, in order. */
function strips(workspace) {
  const out = new Map();
  if (!workspace || typeof workspace.iterateAllLeaves !== "function") return out;
  workspace.iterateAllLeaves((leaf) => {
    const parent = leaf.parent;
    if (parent && Array.isArray(parent.children) && leaf.tabHeaderEl && !out.has(parent)) {
      out.set(parent, parent.children.filter((x) => x && x.tabHeaderEl));
    }
  });
  return out;
}

function colorClass(el, color) {
  for (const c of [...el.classList]) if (c.startsWith("sa-c-")) el.classList.remove(c);
  if (color) el.classList.add(`sa-c-${color}`);
}

class GroupStripMethods {
  /** Redraws every strip; coalesced, since Obsidian fires several layout events per change. */
  scheduleGroupRender() {
    if (this.groupRenderPending) return;
    this.groupRenderPending = true;
    window.setTimeout(() => {
      this.groupRenderPending = false;
      if (this._loaded !== false) this.renderGroups();
    }, 0);
  }

  renderGroups() {
    const state = this.groups;
    if (!state) return;
    for (const [parent, leaves] of strips(this.app.workspace)) {
      const ids = leaves.map((l) => l.id);
      const members = {};
      ids.forEach((id) => { if (state.members[id]) members[id] = state.members[id]; });
      const marks = new Map();
      for (const run of runs(ids, members)) {
        const group = state.groups[run.group];
        if (!group) continue;
        for (let i = run.start; i <= run.end; i++) {
          marks.set(leaves[i], { group, first: i === run.start, last: i === run.end, count: run.end - run.start + 1 });
        }
      }
      for (const leaf of leaves) this.markHeader(leaf, marks.get(leaf) || null);
      this.snapshotStrip(parent, ids);
    }
  }

  markHeader(leaf, mark) {
    const header = leaf.tabHeaderEl;
    header.classList.remove(...MARKS);
    colorClass(header, mark ? mark.group.color : null);
    let chip = header.querySelector(`:scope > .${CHIP}`);
    let line = header.querySelector(`:scope > .${LINE}`);
    if (!mark) {
      if (chip) chip.remove();
      if (line) line.remove();
      header.removeAttribute("data-sa-group");
      return;
    }
    const folded = mark.group.collapsed;
    header.classList.add("sa-grouped");
    header.setAttribute("data-sa-group", mark.group.id);
    if (mark.first) header.classList.add("sa-group-first");
    if (mark.last) header.classList.add("sa-group-last");
    if (folded) header.classList.add(mark.first ? "sa-group-folded-head" : "sa-group-folded");
    // The group's line: an element above the active tab's rounded corners, which cover a background.
    if (!line) {
      line = (header.ownerDocument || document).createElement("div");
      line.className = LINE;
      header.prepend(line);
    }
    if (!mark.first) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) chip = this.createChip(header);
    this.fillChip(chip, mark.group, folded ? mark.count : 0);
    // The header leaves room for the chip in its left margin: Obsidian sizes the tab itself. A strip not
    // laid out (a folded sidebar) measures 0: the last width stays until it is shown again.
    if (chip.offsetWidth) header.setCssProps({ "--sa-chip-width": `${chip.offsetWidth + CHIP_GAP_PX}px` });
    // Level with the tab's icon and title: the middle of its content, not of the header, whose bottom
    // padding is the larger one.
    const inner = header.querySelector(":scope > .workspace-tab-header-inner");
    if (inner && inner.offsetHeight) header.setCssProps({ "--sa-chip-top": `${inner.offsetTop + inner.offsetHeight / 2}px` });
  }

  createChip(header) {
    const doc = header.ownerDocument || document;
    const chip = doc.createElement("div");
    chip.className = CHIP;
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    // Its own drag, cancelled below: otherwise the browser drags the header, the group's first tab.
    chip.draggable = true;
    header.prepend(chip);
    // The header is Obsidian's: a click there selects the tab, a drag moves it. The chip has its own.
    const stop = (event) => event.stopPropagation();
    chip.addEventListener("pointerdown", stop);
    chip.addEventListener("mousedown", stop);
    chip.addEventListener("auxclick", (event) => { event.preventDefault(); stop(event); });
    chip.addEventListener("dragstart", (event) => { event.preventDefault(); stop(event); });
    chip.addEventListener("dblclick", stop);
    chip.addEventListener("click", (event) => {
      stop(event);
      const id = header.getAttribute("data-sa-group");
      if (id) this.toggleGroupFolded(id);
    });
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      stop(event);
      const id = header.getAttribute("data-sa-group");
      if (id) this.editGroup(id, chip);
    });
    chip.addEventListener("keydown", (event) => {
      const id = header.getAttribute("data-sa-group");
      if (!id) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.toggleGroupFolded(id); }
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); this.editGroup(id, chip); }
    });
    return chip;
  }

  fillChip(chip, group, foldedCount) {
    colorClass(chip, group.color);
    chip.classList.toggle("is-unnamed", !group.name);
    chip.replaceChildren();
    if (group.name) chip.createSpan({ cls: "sa-group-chip-name", text: group.name });
    if (foldedCount) chip.createSpan({ cls: "sa-group-chip-count", text: String(foldedCount) });
    const name = group.name || this.t(`group.color.${group.color}`);
    chip.setAttribute("aria-label", this.t(group.collapsed ? "group.chip.folded" : "group.chip.open",
                                           { name, n: foldedCount || this.groupLeaves(group.id).length }));
    chip.setAttribute("aria-expanded", String(!group.collapsed));
  }

  /** The chip of a group's first run, for the editor to sit under. */
  groupChip(id) {
    for (const leaf of this.groupLeaves(id)) {
      const chip = leaf.tabHeaderEl && leaf.tabHeaderEl.querySelector(`:scope > .${CHIP}`);
      if (chip) return chip;
    }
    return null;
  }

  /** Folds or unfolds; a group never folds over the tab in front: another tab comes forward first. */
  toggleGroupFolded(id, fold) {
    const group = this.groups.groups[id];
    if (!group) return;
    const want = fold === undefined ? !group.collapsed : fold;
    if (want) {
      for (const [parent, leaves] of strips(this.app.workspace)) {
        const ids = leaves.map((l) => l.id);
        const current = leaves.indexOf(parent.children[parent.currentTab]);
        if (current < 0 || this.groups.members[ids[current]] !== id) continue;
        const other = tabOutside(ids, this.groups.members, id, current);
        // Only the pane you work in takes the focus; another pane just shows another tab.
        const here = parent.children.includes(this.app.workspace.activeLeaf);
        if (other >= 0 && !here) {
          parent.selectTabIndex(parent.children.indexOf(leaves[other]));
        } else if (other >= 0) {
          this.app.workspace.setActiveLeaf(leaves[other], { focus: true });
        } else {
          // Every tab here is in the group: an empty tab takes the front, as Chrome does.
          const blank = this.app.workspace.createLeafInParent(parent, parent.children.length);
          if (typeof blank.setDimension === "function") blank.setDimension(null);   // a tab, not a split
          this.app.workspace.setActiveLeaf(blank, { focus: true });
        }
      }
    }
    group.collapsed = want;
    this.saveGroups();
    this.renderGroups();
  }

  /** A tab of a folded group came to the front (a shortcut, Go to, a notice): the group unfolds. */
  unfoldForLeaf(leaf) {
    const id = leaf && this.groups && this.groups.members[leaf.id];
    const group = id && this.groups.groups[id];
    if (group && group.collapsed) {
      group.collapsed = false;
      this.saveGroups();
    }
    this.scheduleGroupRender();
  }
}

export { GroupStripMethods, strips, CHIP };

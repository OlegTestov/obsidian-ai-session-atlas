// Ordinary tab drops and whole-group drags share document listeners, but never membership rules.
import { groupDropIndex, movedBlock } from "./groups-model";
import { strips } from "./groups-strip";

class GroupDragMethods {
  /** Listeners per document, removed when its popout window closes (else they keep it in memory). */
  watchTabDrags(doc) {
    if (!this.dragDocs) this.dragDocs = new Map();
    if (!doc || this.dragDocs.has(doc)) return;
    const on = [["dragstart", (event) => this.noteTabDrag(event)],
                ["dragover", (event) => this.noteDragOver(event)],
                ["drop", (event) => {
                  if (this.groupDrag) this.dropGroup(event);
                  else if (this.dragging) this.droppedTab = this.draggedTab;
                }],
                ["dragend", () => this.endTabDrag()]];
    for (const [type, fn] of on) doc.addEventListener(type, fn, true);
    this.dragDocs.set(doc, on);
  }

  unwatchTabDrags(doc) {
    const on = doc && this.dragDocs && this.dragDocs.get(doc);
    if (!on) return;
    for (const [type, fn] of on) doc.removeEventListener(type, fn, true);
    this.dragDocs.delete(doc);
  }

  /**
   * A drop that leaves the order as it was changes no layout: the drop rule runs here instead. A
   * cancelled drag (no drop) is forgotten at once, or a later layout change would apply it.
   */
  endTabDrag() {
    if (this.groupDrag) { this.clearGroupDrag(); return; }
    this.dragging = false;
    if (this.droppedTab) window.setTimeout(() => { if (this._loaded !== false) this.onGroupLayout(); }, 0);
    else this.draggedTab = this.dragOver = null;
  }

  /** The tab under the pointer while a tab is dragged: its group decides a drop at a group's edge. */
  noteDragOver(event) {
    if (this.groupDrag) { this.dragGroupOver(event); return; }
    if (!this.dragging) return;
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    const header = target ? target.closest(".workspace-tab-header") : null;
    this.dragOver = header ? header.getAttribute("data-sa-group") || "" : undefined;
  }

  noteTabDrag(event) {
    // A group drag whose chip left the page never got its dragend: forget it, or this drag moves that group.
    if (this.groupDrag) this.clearGroupDrag();
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    if (target && target.closest(".sa-group-chip")) { this.startGroupDrag(event, target.closest(".sa-group-chip")); return; }
    // Ordinary headers keep Obsidian's single-tab drag.
    const header = target && !target.closest(".sa-group-chip") ? target.closest(".workspace-tab-header") : null;
    const leaf = header ? this.findLeafByTabHeader(header) : null;
    this.draggedTab = leaf ? leaf.id : null;
    this.dragging = !!leaf;
    this.dragOver = undefined;
    this.droppedTab = null;
  }


  startGroupDrag(event, chip) {
    const header = chip.closest(".workspace-tab-header");
    const leaf = this.findLeafByTabHeader(header);
    const id = leaf && this.groups.members[leaf.id];
    if (!id || !this.groups.groups[id]) { event.preventDefault(); return; }
    this.draggedTab = this.dragOver = this.droppedTab = null;
    this.dragging = false;
    this.groupDrag = { id, parent: leaf.parent, chip };
    chip.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.setData("application/x-session-atlas-group", id);
      event.dataTransfer.effectAllowed = "move";
    }
  }

  groupTarget(event) {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    const header = target && target.closest(".workspace-tab-header");
    const leaf = header && this.findLeafByTabHeader(header);
    if (leaf && Array.isArray(leaf.parent?.children)) {
      if (this.groups.members[leaf.id] === this.groupDrag.id) return null;
      const before = event.clientX < header.getBoundingClientRect().left + header.getBoundingClientRect().width / 2;
      const children = leaf.parent.children;
      const index = groupDropIndex(children.map(l => l.id), this.groups.members, leaf.id, before);
      const marker = children[before ? index : index - 1]?.tabHeaderEl;
      return { parent: leaf.parent, index, marker, before };
    }
    const container = target && target.closest(".workspace-tab-header-container");
    if (container) for (const [parent, leaves] of strips(this.app.workspace)) {
      if (leaves[0]?.tabHeaderEl.closest(".workspace-tab-header-container") === container) {
        return { parent, index: parent.children.length, marker: leaves[leaves.length - 1]?.tabHeaderEl, before: false };
      }
    }
    return null;
  }

  dragGroupOver(event) {
    if (this.groupDrop?.marker) this.groupDrop.marker.classList.remove("sa-group-drop-before", "sa-group-drop-after");
    this.groupDrop = this.groupTarget(event);
    if (!this.groupDrop) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.groupDrop.marker?.classList.add(this.groupDrop.before ? "sa-group-drop-before" : "sa-group-drop-after");
  }

  dropGroup(event) {
    const target = this.groupTarget(event);
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      this.moveGroupTo(this.groupDrag.id, this.groupDrag.parent, target.parent, target.index);
    }
    this.clearGroupDrag();
  }

  clearGroupDrag() {
    this.groupDrag?.chip.classList.remove("is-dragging");
    this.groupDrop?.marker?.classList.remove("sa-group-drop-before", "sa-group-drop-after");
    this.groupDrag = this.groupDrop = null;
  }

  /** Move a whole block, including into another pane, without treating any member as a tab drop. */
  moveGroupTo(id, source, target, index) {
    if (!this.groups.groups[id] || !Array.isArray(source?.children) || !Array.isArray(target?.children)) return false;
    const block = source.children.filter(l => this.groups.members[l.id] === id);
    if (!block.length) return false;
    const ws = this.app.workspace, front = ws.activeLeaf;
    const fronts = new Map([source, target].map(p => [p, p.children[p.currentTab]]));
    let at = index;
    if (source === target) {
      const desired = movedBlock(source.children.map(l => l.id), block.map(l => l.id), index);
      at = desired.indexOf(block[0].id);
      if (desired.every((x, i) => x === source.children[i].id)) return false;
    }
    this.groupMoving = true;
    try {
      for (const leaf of block) source.removeChild(leaf);
      for (const [offset, leaf] of block.entries()) {
        if (typeof leaf.setDimension === "function") leaf.setDimension(null);
        target.insertChild(at + offset, leaf);
      }
      for (const [parent, leaf] of fronts) {
        if (leaf && parent.children.includes(leaf)) parent.selectTabIndex(parent.children.indexOf(leaf));
      }
      if (front && block.includes(front)) {
        target.selectTabIndex(target.children.indexOf(front));
        ws.setActiveLeaf(front, { focus: true });
      }
      if (typeof ws.requestSaveLayout === "function") ws.requestSaveLayout();
      this.renderGroups();                         // snapshots the completed order before layout events run
    } finally { this.groupMoving = false; }
    return true;
  }

  /** Keyboard alternative for a focused chip: Alt+Left/Right moves past the adjacent tab/group. */
  moveGroupBy(id, direction, parent) {
    const leaves = parent?.children;
    if (!Array.isArray(leaves)) return;
    const indices = leaves.map((leaf, i) => this.groups.members[leaf.id] === id ? i : -1).filter(i => i >= 0);
    if (!indices.length) return;
    const next = direction < 0 ? indices[0] - 1 : indices[indices.length - 1] + 1;
    if (!leaves[next]) return;
    const at = groupDropIndex(leaves.map(l => l.id), this.groups.members, leaves[next].id, direction < 0);
    this.moveGroupTo(id, parent, parent, at);
  }
}

export { GroupDragMethods };

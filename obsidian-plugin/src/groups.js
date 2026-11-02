// Session groups, as Chrome's tab groups: tabs are put into named, coloured groups that fold to a
// chip. Membership is by leaf id (Obsidian keeps it in the layout), so a group outlives a restart.
// Groups live in the plugin data: {groups: {id: {name, color, collapsed}}, members: {leaf id: group id}}.
// Mixed into the plugin class.
import { Menu } from "obsidian";
import { ConfirmCloseModal } from "./guard";
import { cleanGroups, createGroup, joinIndex, changedLeaves, dropChanges, prune, liveGroups, dropIfEmpty } from "./groups-model";
import { strips } from "./groups-strip";
import { openGroupEditor } from "./groups-editor";

const SAVE_DELAY_MS = 300;

class GroupMethods {
  initGroups() {
    this.groups = cleanGroups(this.settings && this.settings.tabGroups);
    this.stripOrder = new Map();
    this.groupMenus = new WeakSet();
    const ws = this.app.workspace;
    this.registerEvent(ws.on("layout-change", () => this.onGroupLayout()));
    this.registerEvent(ws.on("active-leaf-change", (leaf) => this.unfoldForLeaf(leaf)));
    this.registerEvent(ws.on("leaf-menu", (menu, leaf) => this.addGroupItems(menu, leaf)));
    // Which tab a drag carries: the drop rule applies to it alone (Obsidian's own drag of a header).
    // Popout windows have their own documents.
    this.watchTabDrags(document);
    this.registerEvent(ws.on("window-open", (win) => this.watchTabDrags(win && win.doc)));
    this.registerEvent(ws.on("window-close", (win) => this.unwatchTabDrags(win && win.doc)));
    this.register(() => { for (const doc of [...(this.dragDocs ? this.dragDocs.keys() : [])]) this.unwatchTabDrags(doc); });
    ws.onLayoutReady(() => {
      this.groupsReady = true;
      if (typeof ws.iterateAllLeaves === "function") {
        ws.iterateAllLeaves((leaf) => this.watchTabDrags(leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument));
      }
      this.onGroupLayout();
    });
    this.register(() => this.clearGroupMarks());
    // A change still waiting for the debounced write is written now: a reload reads the saved data.
    this.register(() => this.flushGroups());
    for (const [id, run] of [["group-new", (leaf) => this.newGroupFor(leaf)],
                             ["group-remove", (leaf) => this.leaveGroup(leaf)],
                             ["group-fold", (leaf) => this.toggleGroupFolded(this.groups.members[leaf.id])]]) {
      this.addCommand({ id, name: this.t(`group.command.${id}`), checkCallback: (checking) => {
        const leaf = this.activeLeaf();
        const grouped = !!(leaf && this.groups.members[leaf.id]);
        if (!leaf || !leaf.tabHeaderEl || (id === "group-new" ? false : !grouped)) return false;
        if (!checking) run(leaf);
        return true;
      } });
    }
  }

  saveGroups() {
    this.settings.tabGroups = this.groups;
    window.clearTimeout(this.groupSaveTimer);
    this.groupSavePending = true;
    this.groupSaveTimer = window.setTimeout(() => this.flushGroups(), SAVE_DELAY_MS);
  }

  /** Writes a pending change now; the promise lets the plugin's own reload wait for the disk. */
  flushGroups() {
    window.clearTimeout(this.groupSaveTimer);
    if (!this.groupSavePending) return Promise.resolve();
    this.groupSavePending = false;
    return this.saveData(this.settings).catch((error) => console.error("AI Session Atlas: could not save groups", error));
  }

  /** The plugin unloads: the strip looks as Obsidian draws it. */
  clearGroupMarks() {
    for (const leaves of strips(this.app.workspace).values()) for (const leaf of leaves) this.markHeader(leaf, null);
  }

  /** A tab dragged in or out of a group, tabs closed, a new tab between grouped ones. */
  onGroupLayout() {
    if (!this.groupsReady) return;
    let changed = false;
    const present = new Set();
    for (const [parent, leaves] of strips(this.app.workspace)) {
      const ids = leaves.map((l) => l.id);
      ids.forEach((id) => present.add(id));
      const before = this.stripOrder.get(parent);
      if (!before) continue;
      const { moved, added } = changedLeaves(before, ids, this.draggedTab);
      // Dropped where it already stood (onto the chip, or onto the loose tab beside the group): the
      // order is the same, yet the tab under the pointer still decides, as for a move.
      if (!moved.length && this.droppedTab && ids.includes(this.droppedTab)) moved.push(this.droppedTab);
      if (!moved.length && !added.length) continue;
      const changes = dropChanges(ids, this.groups.members, moved, added, this.draggedTab, this.dragOver);
      for (const [leaf, group] of Object.entries(changes)) {
        if (group) {
          this.groups.members[leaf] = group;
          if (this.groups.groups[group]) this.groups.groups[group].collapsed = false;   // dropped into a folded group
        } else {
          delete this.groups.members[leaf];
        }
        changed = true;
      }
    }
    if (this.draggedTab && !this.dragging) this.draggedTab = this.dragOver = this.droppedTab = null;
    for (const parent of [...this.stripOrder.keys()]) if (!parent.children || !parent.children.length) this.stripOrder.delete(parent);
    if (prune(this.groups, present)) changed = true;
    if (changed) this.saveGroups();
    this.scheduleGroupRender();
  }

  /** Listeners per document, removed when its popout window closes (else they keep it in memory). */
  watchTabDrags(doc) {
    if (!this.dragDocs) this.dragDocs = new Map();
    if (!doc || this.dragDocs.has(doc)) return;
    const on = [["dragstart", (event) => this.noteTabDrag(event)],
                ["dragover", (event) => this.noteDragOver(event)],
                ["drop", () => { if (this.dragging) this.droppedTab = this.draggedTab; }],
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
    this.dragging = false;
    if (this.droppedTab) window.setTimeout(() => { if (this._loaded !== false) this.onGroupLayout(); }, 0);
    else this.draggedTab = this.dragOver = null;
  }

  /** The tab under the pointer while a tab is dragged: its group decides a drop at a group's edge. */
  noteDragOver(event) {
    if (!this.dragging) return;
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    const header = target ? target.closest(".workspace-tab-header") : null;
    this.dragOver = header ? header.getAttribute("data-sa-group") || "" : undefined;
  }

  noteTabDrag(event) {
    const target = event.target && typeof event.target.closest === "function" ? event.target : null;
    // The chip cancels its own drag: no tab moves.
    const header = target && !target.closest(".sa-group-chip") ? target.closest(".workspace-tab-header") : null;
    const leaf = header ? this.findLeafByTabHeader(header) : null;
    this.draggedTab = leaf ? leaf.id : null;
    this.dragging = !!leaf;
    this.dragOver = undefined;
    this.droppedTab = null;
  }

  snapshotStrip(parent, ids) {
    this.stripOrder.set(parent, ids);
  }

  groupOf(leaf) {
    const id = leaf && this.groups && this.groups.members[leaf.id];
    return id ? this.groups.groups[id] || null : null;
  }

  /** A group's tabs in strip order. */
  groupLeaves(id) {
    const out = [];
    for (const leaves of strips(this.app.workspace).values()) {
      for (const leaf of leaves) if (this.groups.members[leaf.id] === id) out.push(leaf);
    }
    return out;
  }

  /** The tab moves inside its own strip, as a drag in Obsidian moves it; the tab in front stays in front. */
  moveLeafTo(leaf, index) {
    const parent = leaf.parent;
    if (!parent || typeof parent.removeChild !== "function" || typeof parent.insertChild !== "function") return;
    const from = parent.children.indexOf(leaf);
    if (from < 0 || from === index) return;
    const front = parent.children[parent.currentTab];
    parent.removeChild(leaf);
    if (typeof leaf.setDimension === "function") leaf.setDimension(null);
    parent.insertChild(index, leaf);
    const at = parent.children.indexOf(front);
    if (at >= 0 && typeof parent.selectTabIndex === "function") parent.selectTabIndex(at);
  }

  /** Ordinary agent launches must not inherit the active tab's group by insertion position. */
  placeOutsideGroup(leaf) {
    if (!this.groups || !leaf) return;
    const leaves = leaf.parent && leaf.parent.children;
    if (!Array.isArray(leaves)) return;
    const at = leaves.indexOf(leaf);
    if (at < 0) return;
    const members = this.groups.members;
    const left = leaves[at - 1], right = leaves[at + 1];
    const group = members[leaf.id] || (left && right && members[left.id] === members[right.id] && members[left.id]);
    if (!group) return;
    // Layout events may already have assigned membership, or may still be pending.
    const index = joinIndex(leaves.map((l) => l.id), members, leaf.id, group);
    if (index !== null) this.moveLeafTo(leaf, index);
    this.leaveGroup(leaf);
  }

  joinGroup(leaf, id) {
    const group = this.groups.groups[id];
    if (!leaf || !group || this.groups.members[leaf.id] === id) return;
    // From another group: out of it first, so that group stays whole.
    const old = this.groups.members[leaf.id] ? this.takeOut(leaf) : null;
    this.groups.members[leaf.id] = id;
    group.collapsed = false;                     // a tab added to a folded group would vanish
    const parent = leaf.parent;
    if (parent && Array.isArray(parent.children)) {
      const index = joinIndex(parent.children.map((l) => l.id), this.groups.members, leaf.id, id);
      if (index !== null) this.moveLeafTo(leaf, index);
    }
    dropIfEmpty(this.groups, old);
    this.saveGroups();
    this.renderGroups();
  }

  newGroupFor(leaf) {
    const group = createGroup(this.groups);
    this.joinGroup(leaf, group.id);
    // As in Chrome: the new group's editor opens at once, ready for a name.
    window.setTimeout(() => this.editGroup(group.id, null, { focusName: true }), 0);
    return group;
  }

  /** Out of its group; a tab from the middle goes right after the group, so the group stays whole. */
  leaveGroup(leaf) {
    if (!leaf || !this.groups.members[leaf.id]) return;
    dropIfEmpty(this.groups, this.takeOut(leaf));
    this.saveGroups();
    this.renderGroups();
  }

  takeOut(leaf) {
    const id = this.groups.members[leaf.id];
    const parent = leaf.parent;
    const ids = parent && Array.isArray(parent.children) ? parent.children.map((l) => l.id) : [];
    let last = -1;
    ids.forEach((x, i) => { if (this.groups.members[x] === id) last = i; });
    delete this.groups.members[leaf.id];
    delete this.groups.gone[leaf.id];
    if (last > ids.indexOf(leaf.id)) this.moveLeafTo(leaf, last);
    return id;
  }

  ungroup(id) {
    for (const leaf of Object.keys(this.groups.members)) {
      if (this.groups.members[leaf] === id) { delete this.groups.members[leaf]; delete this.groups.gone[leaf]; }
    }
    delete this.groups.groups[id];
    this.saveGroups();
    this.renderGroups();
  }

  updateGroup(id, change) {
    const group = this.groups.groups[id];
    if (!group) return;
    Object.assign(group, change);
    this.saveGroups();
    this.renderGroups();
  }

  /** Every tab of the group closes after one question; agents in them end like a closed tab's. */
  closeGroup(id) {
    const group = this.groups.groups[id];
    const leaves = this.groupLeaves(id);
    if (!group || !leaves.length) return;
    const agents = leaves.filter((l) => this.guardKind(l) === "terminal").length;
    new ConfirmCloseModal(this.app, {
      title: this.t("group.close.title", { name: group.name || this.t(`group.color.${group.color}`) }),
      text: this.t(agents ? "group.close.textAgents" : "group.close.text", { n: leaves.length, agents }),
      keep: this.t("close.keep"),
      close: this.t("group.close.confirm"),
      onConfirm: () => {
        for (const leaf of leaves) leaf.detach();
        this.ungroup(id);                        // closed on purpose: not kept for another layout
      },
    }).open();
  }

  /** A new agent tab right after the group's last tab, in the group. */
  async openInGroup(kind, id) {
    const leaves = this.groupLeaves(id);
    if (leaves.length) this.app.workspace.setActiveLeaf(leaves[leaves.length - 1], { focus: false });
    await this.openAgent(kind, { group: id });
  }

  editGroup(id, anchor, opts = {}) {
    const chip = anchor || this.groupChip(id);
    if (!chip || !this.groups.groups[id]) return;
    openGroupEditor(this, id, chip, opts);
  }

  /** Tab menu items: into a new or an existing group, or out of the group. */
  addGroupItems(menu, leaf) {
    // A shown agent tab gets both its own tab menu call and Obsidian's leaf-menu: one set of items.
    if (!this.groups || !menu || !leaf || !leaf.tabHeaderEl || this.groupMenus.has(menu)) return;
    this.groupMenus.add(menu);
    const own = this.groups.members[leaf.id] || null;
    const others = liveGroups(this.groups).filter((g) => g.id !== own);
    menu.addItem((item) => item.setSection("action").setTitle(this.t("group.menu.new")).setIcon("group")
      .onClick(() => this.newGroupFor(leaf)));
    if (others.length) {
      menu.addItem((item) => {
        item.setSection("action").setTitle(this.t(own ? "group.menu.move" : "group.menu.add")).setIcon("folder-input");
        const sub = typeof item.setSubmenu === "function" ? item.setSubmenu() : null;
        for (const g of others) {
          const add = (entry) => {
            entry.setTitle((sub ? "" : "→ ") + (g.name || this.t(`group.color.${g.color}`))).setIcon("circle")
              .onClick(() => this.joinGroup(leaf, g.id));
            if (entry.dom) entry.dom.classList.add("sa-group-menu-item", `sa-c-${g.color}`);
          };
          if (sub) sub.addItem(add);
          else menu.addItem((entry) => add(entry.setSection("action")));
        }
      });
    }
    if (own) {
      menu.addItem((item) => item.setSection("action").setTitle(this.t("group.menu.remove")).setIcon("ungroup")
        .onClick(() => this.leaveGroup(leaf)));
    }
  }

  /** The same menu for a card on the catalog page: shown over the page, where it was asked for. */
  async groupMenuForPage(source, data) {
    const tab = (await this.terminalTabs()).find((t) => t.pid === data.ptyPid);
    if (!tab) return;
    let left = 0;
    let top = 0;
    for (const leaf of this.app.workspace.getLeavesOfType("session-atlas")) {
      const frame = leaf.view && leaf.view.frame;
      if (frame && frame.contentWindow === source) ({ left, top } = frame.getBoundingClientRect());
    }
    const menu = new Menu();
    this.addGroupItems(menu, tab.leaf);
    // The card shows the new group at once, not at the next poll.
    menu.onHide(() => window.setTimeout(() => this.replyTabs(source), 0));
    menu.showAtPosition({ x: left + Math.max(0, Number(data.x) || 0), y: top + Math.max(0, Number(data.y) || 0) });
  }

  /** What the catalog shows on the session's card. */
  tabGroupInfo(leaf) {
    const group = this.groupOf(leaf);
    return group ? { id: group.id, name: group.name, color: group.color } : null;
  }
}

export { GroupMethods };

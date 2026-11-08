// Session groups: the rules on plain strips (groups-model.js) and the plugin's moves on a stand-in
// workspace (groups.js). The drawing on Obsidian's real tab strip is checked live (tools/live, tabGroups).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { loadSrc } from "./helpers/load-src.mjs";
import { setGlobal } from "./helpers/globals.mjs";

setGlobal("window", { setTimeout: () => 0, clearTimeout() {} });

const realLoad = Module._load;
class Menu {}
class View { onTabMenu(menu) { menu.native = (menu.native || 0) + 1; } }
class Modal { constructor(app) { this.app = app; } open() { this.onOpen && this.onOpen(); } }
Module._load = (r, p, i) => (r === "obsidian" ? { Menu, Modal, View, setIcon() {} } : realLoad(r, p, i));
const model = loadSrc("groups-model");
const { GroupMethods } = loadSrc("groups");
const { ConfirmCloseModal } = loadSrc("guard");
const { translate } = loadSrc("i18n");
const { GroupNavigationMethods } = loadSrc("groups-navigation");
const { GroupDragMethods } = loadSrc("groups-drag");
Module._load = realLoad;
const { COLORS, GONE_KEEP_MS, cleanGroups, nextColor, createGroup, runs, joinIndex, changedLeaves, dropChanges, prune, liveGroups,
        tabOutside, editorTop } = model;

describe("group model", () => {
  it("next/previous tab skips folded groups, wraps, and keeps explicit navigation separate", () => {
    const members={a:"G",b:"G"}, groups={G:{collapsed:true}};
    const next=model.visibleNeighbour;
    assert.equal(next(["x","a","b","y"],members,groups,0,1),3);
    assert.equal(next(["x","a","b","y"],members,groups,3,-1),0);
    assert.equal(next(["x","a","b","y"],members,groups,3,1),0);
    assert.equal(next(["x","a","b"],members,groups,0,1),0);
    assert.equal(next(["a","b"],members,groups,0,1),-1);
    groups.G.collapsed=false;
    assert.equal(next(["x","a","b","y"],members,groups,0,1),1);
  });
  it("a group drop snaps to the outside of another group, never splitting it", () => {
    const drop=model.groupDropIndex, move=model.movedBlock;
    const strip=["x","a","b","n","c","d","z"], members={a:"G",b:"G",c:"H",d:"H"};
    assert.equal(drop(strip,members,"d",true),4);
    assert.equal(drop(strip,members,"c",false),6);
    assert.deepEqual(move(strip,["a","b"],6),["x","n","c","d","a","b","z"]);
    assert.deepEqual(move(strip,["c","d"],1),["x","c","d","a","b","n","z"]);
    assert.deepEqual(move(strip,["a","b"],2),strip);
    assert.equal(drop(strip,members,"missing",true),null);
  });
  it("a saved name that is not a string does not stop the plugin", () => {
    const state = cleanGroups({ groups: { g: { name: { toString: null }, color: "red" }, h: { name: 42 } } });
    assert.equal(state.groups.g.name, "");
    assert.equal(state.groups.h.name, "");
  });

  it("the editor opens below the tab strip, or above it when the window has no room below", () => {
    assert.equal(editorTop(30, 40, 200, 900), 46);
    assert.equal(editorTop(700, 740, 200, 900), 494);       // a bottom pane: above its strip
    assert.equal(editorTop(100, 140, 2000, 900), 8);         // taller than the window: from the top
  });

  it("drops malformed saved data and unknown colours", () => {
    const g = cleanGroups({ groups: { a: { name: " Back\nend ", color: "teal", collapsed: "yes" }, b: null },
                            members: { x: "a", y: "missing", z: 5 } });
    assert.deepEqual(g.groups.a, { id: "a", name: "Back end", color: COLORS[0], collapsed: false });
    assert.deepEqual(g.members, { x: "a" });
    assert.deepEqual(cleanGroups(null), { groups: {}, members: {}, gone: {} });
    assert.deepEqual(cleanGroups({ groups: { a: {} }, members: { x: "a" }, gone: { x: 5, y: 6, z: "no" } }).gone, { x: 5 });
  });

  it("a new group takes the first free colour, then the least used one; groups of gone tabs do not count", () => {
    const state = { groups: {}, members: {}, gone: {} };
    const picked = Array.from({ length: COLORS.length + 2 }, (_, i) => {
      const g = createGroup(state);
      state.members[`t${i}`] = g.id;
      return g.color;
    });
    assert.deepEqual(picked.slice(0, COLORS.length), COLORS);
    assert.equal(picked[COLORS.length], COLORS[0]);
    assert.equal(nextColor({ groups: { a: { id: "a", color: "blue" } }, members: { t: "a" }, gone: {} }), "red");
    assert.equal(nextColor({ groups: { a: { id: "a", color: "blue" } }, members: { t: "a" }, gone: { t: 1 } }), "blue");
  });

  it("runs are side-by-side tabs of one group", () => {
    assert.deepEqual(runs(["n", "a", "b", "c", "d"], { a: "G", b: "G", d: "G", c: "H" }),
                     [{ group: "G", start: 1, end: 2 }, { group: "H", start: 3, end: 3 }, { group: "G", start: 4, end: 4 }]);
  });

  it("a joining tab goes right after the group's last tab, or stays when the group is elsewhere", () => {
    assert.equal(joinIndex(["a", "b", "n", "x"], { a: "G", b: "G" }, "x", "G"), 2);
    assert.equal(joinIndex(["x", "a", "b"], { a: "G", b: "G" }, "x", "G"), 2);
    assert.equal(joinIndex(["a", "x"], { a: "G" }, "x", "G"), 1);           // already in place
    assert.equal(joinIndex(["x", "n"], {}, "x", "G"), null);
  });

  it("only the dragged tab counts as moved; tabs new to the strip are added", () => {
    assert.deepEqual(changedLeaves(["a", "b", "x", "y"], ["a", "x", "b", "y"], "x"), { moved: ["x"], added: [] });
    assert.deepEqual(changedLeaves(["a", "b", "x", "y"], ["a", "x", "b", "y"], null), { moved: [], added: [] });
    assert.deepEqual(changedLeaves(["a", "b"], ["a", "b"], "a"), { moved: [], added: [] });       // dropped in place
    assert.deepEqual(changedLeaves(["a", "b"], ["a", "x", "b"], "x"), { moved: ["x"], added: [] }); // from another strip
    assert.deepEqual(changedLeaves(["a", "b"], ["a", "n", "b"], null), { moved: [], added: ["n"] });
  });

  it("dropped between two tabs of a group, a tab joins; dragged away from its group, it leaves", () => {
    const m = { a: "G", b: "G" };
    assert.deepEqual(dropChanges(["a", "x", "b"], m, ["x"], []), { x: "G" });
    assert.deepEqual(dropChanges(["x", "a", "b"], m, ["x"], []), {});                // at the edge: stays out
    assert.deepEqual(dropChanges(["b", "n", "a"], m, ["b"], []), { b: null });       // away from a: leaves
    assert.deepEqual(dropChanges(["n", "a", "b"], m, ["b"], []), {});                // still next to a
    assert.deepEqual(dropChanges(["a", "n", "b"], m, [], ["n"]), { n: "G" });        // a new tab inside the group
    assert.deepEqual(dropChanges(["y", "z"], { y: "H" }, ["y"], []), {});            // alone here: keeps its group
    assert.deepEqual(dropChanges(["c", "x", "d"], { c: "H", d: "H", x: "G" }, ["x"], []), { x: "H" });
  });

  it("at a group's edge the tab under the pointer decides: a group's tab joins, a loose tab leaves", () => {
    assert.deepEqual(dropChanges(["a", "x"], { a: "G" }, ["x"], [], "x", "G"), { x: "G" });          // one-tab group grows
    assert.deepEqual(dropChanges(["x", "a", "b"], { a: "G", b: "G" }, ["x"], [], "x", "G"), { x: "G" });
    assert.deepEqual(dropChanges(["a", "x"], { a: "G" }, ["x"], [], "x", ""), {});                   // dropped on a loose tab
    assert.deepEqual(dropChanges(["a", "x"], { a: "G" }, ["x"], [], "x", undefined), {});            // on the empty strip
    assert.deepEqual(dropChanges(["a", "x"], { a: "G" }, ["x"], [], "y", "G"), {});                  // not the dragged tab
    assert.deepEqual(dropChanges(["b", "a", "n"], { a: "G", b: "G" }, ["a"], [], "a", ""), { a: null }); // onto n: leaves
    assert.deepEqual(dropChanges(["b", "a", "n"], { a: "G", b: "G" }, ["a"], [], "a", "G"), {});        // onto b: stays
    assert.deepEqual(dropChanges(["a", "x", "h"], { a: "G", h: "H", x: "H" }, ["x"], [], "x", "G"), { x: "G" });
    assert.deepEqual(dropChanges(["n", "a"], { a: "G" }, ["a"], [], "a", ""), {});                     // the group's only tab
  });

  it("keeps a missing tab's group for another layout, forgets it after two weeks; a group without tabs goes", () => {
    const state = { groups: { G: { id: "G" }, H: { id: "H" }, E: { id: "E" } }, members: { a: "G", b: "H" }, gone: {} };
    assert.equal(prune(state, new Set(["a"]), 1000), true);
    assert.deepEqual(state.members, { a: "G", b: "H" });
    assert.deepEqual(state.gone, { b: 1000 });
    assert.deepEqual(Object.keys(state.groups), ["G", "H"]);
    assert.deepEqual(liveGroups(state).map((g) => g.id), ["G"]);
    assert.equal(prune(state, new Set(["a"]), 2000), false);
    assert.equal(prune(state, new Set(["a", "b"]), 3000), true);   // the layout came back
    assert.deepEqual(state.gone, {});
    prune(state, new Set(["a"]), 4000);
    prune(state, new Set(["a"]), 4000 + GONE_KEEP_MS + 1);
    assert.deepEqual(state.members, { a: "G" });
    assert.deepEqual(Object.keys(state.groups), ["G"]);
  });

  it("folding over the tab in front shows the nearest tab after the group, else before", () => {
    const m = { a: "G", b: "G" };
    assert.equal(tabOutside(["n", "a", "b", "z"], m, "G", 1), 3);
    assert.equal(tabOutside(["n", "a", "b"], m, "G", 2), 0);
    assert.equal(tabOutside(["a", "b"], m, "G", 0), -1);
  });
});

/** A stand-in strip: leaves with ids in a parent that moves children as Obsidian does. */
function world(ids) {
  const parent = { children: [], currentTab: 0,
    removeChild(l) { const i = this.children.indexOf(l); this.children.splice(i, 1); if (this.currentTab >= this.children.length) this.currentTab = this.children.length - 1; },
    insertChild(i, l) { this.children.splice(i, 0, l); l.parent = this; },
    selectTabIndex(i) { this.currentTab = i; } };
  for (const id of ids) parent.insertChild(parent.children.length, { id, tabHeaderEl: {}, parent, detach() {} });
  const workspace = { iterateAllLeaves(fn) { parent.children.slice().forEach(fn); } };
  const plugin = Object.create(GroupMethods.prototype);
  for (const methods of [GroupNavigationMethods, GroupDragMethods]) for (const key of Object.getOwnPropertyNames(methods.prototype)) {
    if (key !== "constructor") plugin[key] = methods.prototype[key];
  }
  Object.assign(plugin, { app: { workspace }, settings: {}, groups: cleanGroups(null), stripOrder: new Map(),
                          groupMenus: new WeakSet(), groupsReady: true, saved: 0,
                          saveData: async () => { plugin.saved++; }, renderGroups() {}, scheduleGroupRender() {},
                          editGroup() {}, t: (k) => k });
  plugin.snapshot = () => plugin.stripOrder.set(parent, parent.children.map((l) => l.id));
  const leaf = (id) => parent.children.find((l) => l.id === id);
  const order = () => parent.children.map((l) => l.id);
  return { plugin, parent, leaf, order };
}

describe("group moves in the strip", () => {
  it("whole-group moves keep membership, order, collapse and the active tab", () => {
    const {plugin,parent,leaf,order}=world(["x","a","b","n","c","d","z"]);
    const g=createGroup(plugin.groups,{id:"G"}),h=createGroup(plugin.groups,{id:"H"});
    plugin.groups.members={a:g.id,b:g.id,c:h.id,d:h.id};
    plugin.app.workspace.activeLeaf=leaf("a");parent.currentTab=1;
    plugin.app.workspace.setActiveLeaf=(l)=>{plugin.app.workspace.activeLeaf=l;};
    const members={...plugin.groups.members};
    assert.equal(plugin.moveGroupTo(g.id,parent,parent,6),true);
    assert.deepEqual(order(),["x","n","c","d","a","b","z"]);
    assert.equal(parent.children[parent.currentTab],leaf("a"));
    assert.deepEqual(plugin.groups.members,members);
    g.collapsed=true;
    plugin.app.workspace.activeLeaf=leaf("x");parent.currentTab=0;
    plugin.moveGroupBy(g.id,-1,parent);
    assert.deepEqual(order(),["x","n","a","b","c","d","z"]);
    assert.equal(g.collapsed,true);
    assert.equal(plugin.app.workspace.activeLeaf,leaf("x"));
  });
  it("a whole group can move to another pane without changing which tab is active", () => {
    const source=world(["x","a","b"]),target=world(["n"]);
    const {plugin,leaf,parent}=source;
    const g=createGroup(plugin.groups,{id:"G"});plugin.groups.members={a:g.id,b:g.id};
    const active=leaf("a");plugin.app.workspace.activeLeaf=active;
    // Removing an active pane's tab lets Obsidian choose a neighbour before the move completes.
    const remove = parent.removeChild;
    parent.removeChild = function (l) {
      remove.call(this, l);
      if (plugin.app.workspace.activeLeaf === l) plugin.app.workspace.activeLeaf = this.children[this.currentTab];
    };
    plugin.app.workspace.setActiveLeaf=l=>{plugin.app.workspace.activeLeaf=l;};
    plugin.moveGroupTo(g.id,parent,target.parent,1);
    assert.deepEqual(source.order(),["x"]);
    assert.deepEqual(target.order(),["n","a","b"]);
    assert.equal(active.parent,target.parent);
    assert.equal(plugin.app.workspace.activeLeaf,active);
    assert.equal(target.parent.children[target.parent.currentTab],active);
    assert.deepEqual(plugin.groups.members,{a:g.id,b:g.id});
  });
  it("navigation commands skip folded tabs and background note menus keep their own leaf", () => {
    const {plugin,parent,leaf}=world(["x","a","b","y"]);
    const g=createGroup(plugin.groups,{id:"G"});g.collapsed=true;plugin.groups.members={a:g.id,b:g.id};
    const original=View.prototype.onTabMenu, unload=[], calls=[];
    const next={checkCallback(checking){calls.push([this,checking]);return true;}};
    const previous={callback(){calls.push([this]);}};
    plugin.app.commands={commands:{"workspace:next-tab":next,"workspace:previous-tab":previous}};
    plugin.app.workspace.activeLeaf=leaf("x");
    plugin.activeLeaf=()=>plugin.app.workspace.activeLeaf;
    plugin.app.workspace.setActiveLeaf=l=>{plugin.app.workspace.activeLeaf=l;};
    plugin.register=fn=>unload.push(fn);
    plugin.initGroupNavigation();
    assert.equal(next.checkCallback(true),true);
    assert.deepEqual(calls,[[next,true]]);
    next.checkCallback(false);assert.equal(plugin.activeLeaf(),leaf("y"));
    previous.callback();assert.equal(plugin.activeLeaf(),leaf("x"));
    const note=Object.assign(new View(),{app:plugin.app,leaf:leaf("b")});
    let target=null;plugin.addGroupItems=(_menu,l)=>{target=l;};
    const menu={};note.onTabMenu(menu);
    assert.equal(target,leaf("b"));assert.equal(menu.native,1);assert.equal(plugin.activeLeaf(),leaf("x"));
    unload.forEach(fn=>fn());assert.equal(View.prototype.onTabMenu,original);
    assert.equal(next.checkCallback(true),true);
    assert.equal(calls.length,2);
    assert.equal(parent.currentTab,0);
  });
  it("navigation hooks wrapped again by another plugin are not stacked and keep no old instance", () => {
    const setup = () => {
      const w = world(["x", "a", "b", "y"]);
      const g = createGroup(w.plugin.groups, { id: "G" }); g.collapsed = true; w.plugin.groups.members = { a: g.id, b: g.id };
      w.plugin.activeLeaf = () => w.plugin.app.workspace.activeLeaf;
      w.plugin.app.workspace.activeLeaf = w.leaf("x");
      w.plugin.app.workspace.setActiveLeaf = (l) => { w.plugin.app.workspace.activeLeaf = l; };
      w.unload = []; w.plugin.register = (fn) => w.unload.push(fn);
      w.items = 0; w.plugin.addGroupItems = () => { w.items++; };
      return w;
    };
    const originalMenu = View.prototype.onTabMenu;
    let native = 0;
    const next = { callback() { native++; } };
    const commands = { commands: { "workspace:next-tab": next } };
    const first = setup(); first.plugin.app.commands = commands;
    first.plugin.initGroupNavigation();
    // Another plugin wraps both after us, so our unload cannot restore them.
    const ours = next.callback;
    const foreign = function () { return ours.apply(this, arguments); };
    next.callback = foreign;
    const oursMenu = View.prototype.onTabMenu;
    const foreignMenu = function (menu) { return oursMenu.call(this, menu); };
    View.prototype.onTabMenu = foreignMenu;
    first.unload.forEach((fn) => fn());
    first.plugin._loaded = false;
    const second = setup(); second.plugin.app.commands = commands;
    second.plugin.initGroupNavigation();
    assert.equal(next.callback, foreign);                        // our wrapper is still in the chain: not added again
    assert.equal(View.prototype.onTabMenu, foreignMenu);
    let selected = 0; const select = second.leaf("x").parent.selectTabIndex.bind(second.leaf("x").parent);
    second.leaf("x").parent.selectTabIndex = (i) => { selected++; select(i); };
    next.callback();
    assert.equal(selected, 1);                                   // one wrapper of ours, not two
    assert.equal(second.plugin.activeLeaf(), second.leaf("y"));
    const note = Object.assign(new View(), { app: second.plugin.app, leaf: second.leaf("b") });
    note.onTabMenu({});
    assert.deepEqual([first.items, second.items], [0, 1]);
    second.unload.forEach((fn) => fn());
    next.callback(); note.onTabMenu({});                         // still in the chain, but inert
    assert.equal(native, 1);
    assert.deepEqual([first.items, second.items], [0, 1]);
    View.prototype.onTabMenu = originalMenu;
  });
  it("an ordinary tab drag after a group drag that never ended moves only that tab", () => {
    const { plugin, leaf } = world(["a", "b", "c"]);
    const g = createGroup(plugin.groups, { id: "G" }); plugin.groups.members = { a: g.id, b: g.id };
    const classes = new Set(["is-dragging"]);
    const chip = { classList: { remove: (c) => classes.delete(c), add: (c) => classes.add(c) } };
    plugin.groupDrag = { id: g.id, parent: leaf("a").parent, chip };    // its dragend never came
    const header = {};
    const target = { closest: (sel) => (sel === ".workspace-tab-header" ? header : null) };
    plugin.findLeafByTabHeader = (h) => (h === header ? leaf("c") : null);
    plugin.noteTabDrag({ target });
    assert.equal(plugin.groupDrag, null);
    assert.equal(classes.has("is-dragging"), false);
    assert.equal(plugin.dragging, true);
    assert.equal(plugin.draggedTab, "c");
  });
  it("ordinary tabs at a group's boundary keep their position and do not join the next group", () => {
    const { plugin, leaf, order } = world(["a", "b", "new", "c", "d"]);
    plugin.groups.members = { a: "G", b: "G", c: "H", d: "H" };
    plugin.placeOutsideGroup(leaf("new"));
    assert.deepEqual(order(), ["a", "b", "new", "c", "d"]);
    assert.equal(plugin.groups.members.new, undefined);
  });
  for (const assigned of [false, true]) it(`ordinary agent tabs stay outside groups (layout already ran: ${assigned})`, () => {
    const { plugin, leaf, order } = world(["a", "new", "b", "note"]);
    const g = createGroup(plugin.groups);
    plugin.groups.members = { a: g.id, b: g.id, ...(assigned ? { new: g.id } : {}) };
    plugin.stripOrder.set(leaf("a").parent, ["a", "b", "note"]);
    plugin.placeOutsideGroup(leaf("new"));
    plugin.onGroupLayout();
    assert.deepEqual(order(), ["a", "b", "new", "note"]);
    assert.deepEqual(plugin.groups.members, { a: g.id, b: g.id });
    plugin.placeOutsideGroup(leaf("note"));
    assert.deepEqual(order(), ["a", "b", "new", "note"]);
  });
  it("a tab joining a group moves next to it; the tab in front stays in front", () => {
    const { plugin, parent, leaf, order } = world(["atlas", "a", "n", "b"]);
    parent.currentTab = 2;                                  // n in front
    const g = createGroup(plugin.groups, { name: "Backend" });
    plugin.joinGroup(leaf("a"), g.id);
    plugin.joinGroup(leaf("b"), g.id);
    assert.deepEqual(order(), ["atlas", "a", "b", "n"]);
    assert.equal(parent.children[parent.currentTab].id, "n");
    assert.deepEqual(plugin.groups.members, { a: g.id, b: g.id });
    g.collapsed = true;
    plugin.joinGroup(leaf("n"), g.id);                       // a tab joining a folded group would vanish
    assert.equal(g.collapsed, false);
  });

  it("a tab taken out of the middle goes after the group, and an emptied group is gone", () => {
    const { plugin, leaf, order } = world(["a", "b", "c", "n"]);
    const g = createGroup(plugin.groups);
    for (const id of ["a", "b", "c"]) plugin.joinGroup(leaf(id), g.id);
    plugin.leaveGroup(leaf("b"));
    assert.deepEqual(order(), ["a", "c", "b", "n"]);
    plugin.leaveGroup(leaf("a"));
    plugin.leaveGroup(leaf("c"));
    assert.deepEqual(plugin.groups, { groups: {}, members: {}, gone: {} });
  });

  it("a layout change applies Chrome's drop rule to the dragged tab only", () => {
    const { plugin, parent, leaf, order } = world(["a", "b", "x", "y"]);
    const g = createGroup(plugin.groups);
    plugin.joinGroup(leaf("a"), g.id);
    plugin.joinGroup(leaf("b"), g.id);
    plugin.snapshot();
    const x = leaf("x");
    parent.removeChild(x);
    parent.insertChild(1, x);                               // dropped between a and b of a folded group
    g.collapsed = true;
    plugin.draggedTab = "x";
    plugin.onGroupLayout();
    assert.equal(plugin.groups.members.x, g.id);
    assert.equal(g.collapsed, false);
    assert.equal(plugin.groups.members.y, undefined);
    assert.deepEqual(order(), ["a", "x", "b", "y"]);
  });

  it("a tab dropped where it stood follows the tab under the pointer; a cancelled drag changes nothing", () => {
    const { plugin, leaf, order } = world(["n", "a", "b"]);
    const g = createGroup(plugin.groups);
    plugin.joinGroup(leaf("a"), g.id);
    plugin.joinGroup(leaf("b"), g.id);
    const drop = (id, over, dropped = true) => {
      plugin.snapshot();
      Object.assign(plugin, { draggedTab: id, dragOver: over, droppedTab: dropped ? id : null, dragging: false });
      plugin.onGroupLayout();
    };
    drop("n", g.id, false);                                  // Escape over the chip
    assert.equal(plugin.groups.members.n, undefined);
    drop("n", g.id);                                         // onto the chip: joins at the group's start
    assert.equal(plugin.groups.members.n, g.id);
    assert.deepEqual(order(), ["n", "a", "b"]);
    assert.equal(plugin.droppedTab, null);
    delete plugin.groups.members.n;                          // loose again, in the same place
    drop("a", "");                                           // the first tab onto the loose tab beside it
    assert.equal(plugin.groups.members.a, undefined);
    assert.equal(plugin.groups.members.b, g.id);
  });

  it("a cancelled drag leaves nothing behind: a later layout change does not group that tab", () => {
    const { plugin, parent, leaf } = world(["a", "x"]);
    const g = createGroup(plugin.groups);
    plugin.joinGroup(leaf("a"), g.id);
    plugin.snapshot();
    Object.assign(plugin, { draggedTab: "x", dragging: true, dragOver: g.id, droppedTab: null });
    plugin.endTabDrag();                                     // Escape over a's header: no drop
    parent.insertChild(2, { id: "y", tabHeaderEl: {}, parent, detach() {} });   // a new tab after x
    plugin.onGroupLayout();
    assert.equal(plugin.groups.members.x, undefined);
    assert.equal(plugin.draggedTab, null);
  });

  it("a group change waiting to be saved is written when the plugin unloads", async () => {
    const { plugin } = world(["a"]);
    createGroup(plugin.groups, { name: "Renamed" });
    plugin.saveGroups();                                     // the debounced write has not run yet
    assert.equal(plugin.saved, 0);
    plugin.flushGroups();
    assert.equal(plugin.saved, 1);
    plugin.flushGroups();                                    // nothing pending: no second write
    assert.equal(plugin.saved, 1);
  });

  it("unloading the plugin writes the pending change and lets go of every document", () => {
    const { plugin } = world(["a"]);
    const onUnload = [];
    const doc = { on: new Map(), addEventListener(t, f) { this.on.set(t, f); }, removeEventListener(t, f) { if (this.on.get(t) === f) this.on.delete(t); } };
    setGlobal("document", doc);
    Object.assign(plugin.app.workspace, { on: () => ({}), onLayoutReady() {} });
    Object.assign(plugin, { register: (fn) => onUnload.push(fn), registerEvent() {}, addCommand() {}, markHeader() {} });
    plugin.initGroups();
    assert.equal(doc.on.size, 4);
    createGroup(plugin.groups, { name: "Renamed" });
    plugin.saveGroups();
    for (const fn of onUnload) fn();
    assert.equal(plugin.saved, 1);
    assert.equal(doc.on.size, 0);
  });

  it("a closed popout's document is let go: its drag listeners are removed", () => {
    const { plugin } = world(["a"]);
    const doc = { on: new Map(), addEventListener(t, f) { this.on.set(t, f); }, removeEventListener(t, f) { if (this.on.get(t) === f) this.on.delete(t); } };
    plugin.watchTabDrags(doc);
    plugin.watchTabDrags(doc);                               // once per document
    assert.deepEqual([...doc.on.keys()].sort(), ["dragend", "dragover", "dragstart", "drop"]);
    plugin.unwatchTabDrags(doc);
    assert.equal(doc.on.size, 0);
    plugin.watchTabDrags(doc);                               // the same window opened again
    assert.equal(doc.on.size, 4);
  });

  it("a closed tab's group is no longer offered; moving to another group keeps the old one whole", () => {
    const { plugin, parent, leaf, order } = world(["a", "b", "c", "d"]);
    const g = createGroup(plugin.groups, { name: "G" });
    const h = createGroup(plugin.groups, { name: "H" });
    for (const id of ["a", "b", "c"]) plugin.joinGroup(leaf(id), g.id);
    plugin.joinGroup(leaf("b"), h.id);                      // from the middle of G to H
    assert.deepEqual(order(), ["a", "c", "b", "d"]);
    plugin.joinGroup(leaf("a"), h.id);
    assert.deepEqual(order(), ["c", "b", "a", "d"]);
    assert.deepEqual(Object.keys(plugin.groups.groups).sort(), [g.id, h.id].sort());
    plugin.snapshot();
    parent.removeChild(leaf("c"));                          // G's last tab closes
    plugin.onGroupLayout();
    const titles = [];
    const item = () => { const it = { setSection: () => it, setTitle: (t) => { titles.push(t); return it; }, setIcon: () => it,
                                      onClick: () => it, setSubmenu: () => ({ addItem: (fn) => fn(item()) }) }; return it; };
    plugin.addGroupItems({ addItem: (fn) => fn(item()) }, leaf("d"));
    assert.ok(!titles.includes("G"), titles.join());
  });

  it("the menu offers a new group, the other groups and leaving, once per menu", () => {
    const { plugin, leaf } = world(["a", "b"]);
    const g = createGroup(plugin.groups, { name: "Backend" });
    const docs = createGroup(plugin.groups, { name: "Docs" });
    plugin.joinGroup(leaf("a"), g.id);
    plugin.joinGroup(leaf("b"), docs.id);
    const titles = [];
    const sub = [];
    const item = (into) => {
      const it = { setSection: () => it, setTitle: (t) => { into.push(t); return it; }, setIcon: () => it, onClick: () => it,
                   setSubmenu: () => ({ addItem: (fn) => fn(item(sub)) }) };
      return it;
    };
    const menu = { addItem: (fn) => fn(item(titles)) };
    plugin.addGroupItems(menu, leaf("a"));
    plugin.addGroupItems(menu, leaf("a"));
    assert.deepEqual(titles, ["group.menu.new", "group.menu.move", "group.menu.remove"]);
    assert.deepEqual(sub, ["Docs"]);
  });
});

// Closing a group closes the tabs only: sessions in Claude Code background jobs run on, and the
// question says how many.
describe("closing a group with background sessions", () => {
  const shown = [];
  const realOpen = ConfirmCloseModal.prototype.open;
  const plugin = Object.create(GroupMethods.prototype);
  const leaf = (kind, job) => ({ kind, job, detach() { this.detached = true; } });
  let leaves = [];
  plugin.app = {};
  plugin.groups = { groups: { g1: { name: "News", color: "blue" } } };
  plugin.groupLeaves = () => leaves;
  plugin.guardKind = (l) => l.kind;
  plugin.backgroundJobsOf = (ls) => ls.map((l) => l.job || null);
  plugin.t = (key, vars) => translate("ru", key, vars);
  const close = () => {
    ConfirmCloseModal.prototype.open = function () { shown.push(this); };
    try { plugin.closeGroup("g1"); } finally { ConfirmCloseModal.prototype.open = realOpen; }
    return shown[shown.length - 1];
  };

  it("counts the background sessions among the group's agents", () => {
    leaves = [leaf("terminal", "ab12cd34"), leaf("terminal", null), leaf("terminal", "ffee0011"), leaf(null, null)];
    const m = close();
    assert.equal(m.text, "Закроются все вкладки группы: 4. Сессий агентов завершится: 1. Фоновые сессии Claude Code (2) "
      + "продолжат работать: чтобы остановить, закрывайте их вкладки по одной.");
  });
  it("every agent in the group is a background session: no line about sessions that end", () => {
    leaves = [leaf("terminal", "ab12cd34"), leaf("terminal", "ffee0011"), leaf(null, null)];
    assert.equal(close().text, "Закроются все вкладки группы: 3. Фоновые сессии Claude Code (2) продолжат работать: "
      + "чтобы остановить, закрывайте их вкладки по одной.");
  });
  it("no background session: the usual text", () => {
    leaves = [leaf("terminal", null), leaf(null, null)];
    const m = close();
    assert.equal(m.text, "Закроются все вкладки группы: 2. Сессии агентов в них (1) завершатся.");
  });
  it("no agents: the processes are not even checked", () => {
    let asked = 0;
    plugin.backgroundJobsOf = (ls) => { asked++; return ls.map(() => "ab12cd34"); };
    leaves = [leaf(null, null)];
    assert.equal(close().text, "Закроются все вкладки группы: 1.");
    assert.equal(asked, 0);
  });
});

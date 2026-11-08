// Host integration: keep Obsidian's shortcuts and menus, adding group semantics at their entry points.
import { View } from "obsidian";
import { visibleNeighbour } from "./groups-model";

// The wrappers outlive a plugin instance when another plugin wraps the same function after us:
// they read the current instance from here (kept on Obsidian's View class, so it survives module
// reloads), so each one is installed once and holds no old instance.
const HOOKS = Symbol.for("session-atlas.group-navigation");
const fallback = {};
function hubOf() {
  const host = View || fallback;
  return host[HOOKS] || (host[HOOKS] = { plugin: null, installed: new WeakMap() });
}

/** Wraps target[key] once; restores it on unload only while our wrapper is still on top. */
function hook(plugin, target, key, make) {
  if (!target) return;
  const hub = hubOf();
  const keys = hub.installed.get(target) || new Set();
  if (keys.has(key)) return;                              // a wrapper of ours is still in the chain
  const original = target[key];
  if (typeof original !== "function") return;
  const wrapper = make(original);
  target[key] = wrapper;
  keys.add(key);
  hub.installed.set(target, keys);
  plugin.register(() => {
    if (target[key] !== wrapper) return;                  // wrapped again by someone else: stays, inert
    target[key] = original;
    keys.delete(key);
  });
}

class GroupNavigationMethods {
  initGroupNavigation() {
    const hub = hubOf();
    hub.plugin = this;
    this.register(() => { if (hub.plugin === this) hub.plugin = null; });
    const live = () => (hub.plugin && hub.plugin._loaded !== false ? hub.plugin : null);
    for (const [id, step] of [["workspace:next-tab", 1], ["workspace:previous-tab", -1]]) {
      const command = this.app.commands && this.app.commands.commands && this.app.commands.commands[id];
      if (!command) continue;
      const key = typeof command.checkCallback === "function" ? "checkCallback" : "callback";
      hook(this, command, key, (original) => function (...args) {
        const checking = key === "checkCallback" && args[0];
        const plugin = live();
        if (!checking && plugin && plugin.navigateOutsideFolded(step)) return true;
        return original.apply(this, args);
      });
    }
    // Every built-in view calls View.onTabMenu, including a background note. leaf-menu alone only
    // fires for the visible tab. The existing per-menu WeakSet prevents duplicate entries.
    hook(this, View && View.prototype, "onTabMenu", (original) => function (menu, ...args) {
      const result = original.call(this, menu, ...args);
      const plugin = live();
      if (plugin && this.app === plugin.app) plugin.addGroupItems(menu, this.leaf);
      return result;
    });
  }

  navigateOutsideFolded(direction) {
    const ws = this.app.workspace, leaf = this.activeLeaf();
    const parent = leaf && leaf.parent;
    if (!parent || !Array.isArray(parent.children) || !this.groups) return false;
    const leaves = parent.children;
    const hasFolded = leaves.some(l => this.groups.groups[this.groups.members[l.id]]?.collapsed);
    if (!hasFolded) return false;                    // leave the ordinary command entirely to Obsidian
    const next = visibleNeighbour(leaves.map(l => l.id), this.groups.members, this.groups.groups,
                                  leaves.indexOf(leaf), direction);
    if (next >= 0 && leaves[next] !== leaf) {
      parent.selectTabIndex(next);
      ws.setActiveLeaf(leaves[next], { focus: true });
    }
    return true;
  }
}

export { GroupNavigationMethods };

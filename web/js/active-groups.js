// Active: session groups from the Obsidian tabs (the plugin's groups, as Chrome's tab groups).
// A card shows its tab's group; clicking the label opens the plugin's group menu over the page.
// Classic script: shares one global scope with the other page files.
/* exported unselectGroup, groupFilterLabel, readTabGroups, withTabGroup, groupPill, GROUP_COLORS -- used by other page scripts */
const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
let hostGroups = new Map();     // PTY proxy PID → {id, name, color} of the tab's group
const groupFilterGroups = new Map();    // current groups, plus selected missing groups for readable labels
let hostGroupsOn = false;       // the plugin knows groups (older plugins send none)

function readTabGroups(d) {
  hostGroupsOn = d.groups === true;
  hostGroups = new Map(d.tabs.filter(t => hostGroupsOn && t && Number.isInteger(t.ptyPid) && t.group && typeof t.group === "object")
    .map(t => [t.ptyPid, { id: String(t.group.id || ""), name: String(t.group.name || "").slice(0, 40),
                           color: GROUP_COLORS.includes(t.group.color) ? t.group.color : "grey" }]));
  const ids = new Set();
  for (const g of hostGroups.values()) { groupFilterGroups.set(g.id, g); ids.add(g.id); }
  if (hostGroupsOn && legacyGroupNames.length) {
    const unresolved = [];
    for (const name of legacyGroupNames) {
      const matches = [...groupFilterGroups.values()].filter(g => ids.has(g.id) && groupLabel(g) === name);
      if (matches.length) {
        activeFilter.group.delete(`legacy:${name}`);
        matches.forEach(g => activeFilter.group.add(g.id));
      }
      else {
        const id = `legacy:${name}`;
        groupFilterGroups.set(id, { id, name, color: "grey" });
        activeFilter.group.add(id);
        unresolved.push(name);
      }
    }
    legacyGroupNames = unresolved;
    writeHash();
  }
  for (const id of groupFilterGroups.keys()) if (!ids.has(id) && !activeFilter.group.has(id)) groupFilterGroups.delete(id);
}

function unselectGroup(id) {
  activeFilter.group.delete(id);
  legacyGroupNames = legacyGroupNames.filter(name => `legacy:${name}` !== id);
}

/** Same names stay readable: colour distinguishes groups; an ordinal resolves same-name/same-colour. */
function groupFilterLabel(id) {
  const g = groupFilterGroups.get(id);
  if (!g) return i18n("active.group.missing");
  const name = groupLabel(g);
  const peers = [...groupFilterGroups.values()].filter(x => groupLabel(x) === name);
  if (peers.length < 2) return name;
  const same = peers.filter(x => x.color === g.color).sort((a, b) => a.id.localeCompare(b.id));
  return `${name} · ${i18n(`active.group.color.${g.color}`)}` + (same.length > 1 ? ` · ${same.findIndex(x => x.id === id) + 1}` : "");
}

/** The group's name; an unnamed group is called by its colour, as the plugin does. */
function groupLabel(g) {
  return g.name || i18n("active.group.unnamed", { color: i18n(`active.group.color.${g.color}`) });
}

function withTabGroup(s, pid) {
  const g = pid ? hostGroups.get(pid) : null;
  return g ? Object.assign({}, s, { tab_group: g, tab_group_label: groupLabel(g) }) : s;
}

/**
 * The card's group label: the group's colour and name, or a faint "+ Group" on a card whose tab has
 * none. A click shows the plugin's menu (new group, another group, out of the group) where it was clicked.
 */
function groupPill(s, pid) {
  if (!hostGroupsOn || !pid) return null;
  const g = s.tab_group;
  const b = el("button", g ? `pill grp g-${g.color}` : "pill grp add", g ? groupLabel(g) : i18n("active.group.add"));
  b.type = "button";
  b.title = g ? i18n("active.group.hint", { name: groupLabel(g) }) : i18n("active.group.addHint");
  b.addEventListener("click", e => {
    e.stopPropagation();
    // From the keyboard a click has no pointer: the menu opens under the label.
    const r = b.getBoundingClientRect();
    const at = e.detail === 0 ? { x: r.left, y: r.bottom } : { x: e.clientX, y: e.clientY };
    tellTabHost("group-menu", { ptyPid: pid, x: Math.round(at.x), y: Math.round(at.y) });
  });
  return b;
}

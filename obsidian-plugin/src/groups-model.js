// Session groups, the data part: no Obsidian here, so every rule is tested with plain arrays.
// A group is {id, name, color, collapsed}; members map a tab (leaf id) to its group. A tab strip is
// a list of leaf ids in order; a group's tabs stand side by side in it, as in Chrome.

// Chrome's nine colours, in the order a new group takes them; grey last: it reads as "disabled".
const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
const MAX_NAME = 40;

// A tab missing from the layout keeps its group this long: another workspace layout may bring it back.
const GONE_KEEP_MS = 14 * 24 * 3600 * 1000;

function emptyGroups() {
  return { groups: {}, members: {}, gone: {} };
}

/** Saved data as it came from data.json: anything malformed is dropped, not trusted. */
function cleanGroups(raw) {
  const out = emptyGroups();
  const groups = raw && typeof raw.groups === "object" && raw.groups ? raw.groups : {};
  for (const [id, g] of Object.entries(groups)) {
    if (!g || typeof g !== "object" || typeof id !== "string") continue;
    out.groups[id] = { id, name: cleanName(g.name), color: COLORS.includes(g.color) ? g.color : COLORS[0],
                       collapsed: g.collapsed === true };
  }
  const members = raw && typeof raw.members === "object" && raw.members ? raw.members : {};
  for (const [leaf, id] of Object.entries(members)) {
    if (typeof id === "string" && out.groups[id]) out.members[leaf] = id;
  }
  const gone = raw && typeof raw.gone === "object" && raw.gone ? raw.gone : {};
  for (const [leaf, at] of Object.entries(gone)) if (out.members[leaf] && Number.isFinite(at)) out.gone[leaf] = at;
  return out;
}

function cleanName(name) {
  return (typeof name === "string" ? name : "").replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_NAME);
}

/**
 * Where the editor opens: below the tab strip, or above it when the window has no room below (a pane
 * at the bottom), never above the window's top.
 */
function editorTop(stripTop, stripBottom, height, viewHeight) {
  const below = stripBottom + 6;
  if (below + height <= viewHeight - 8) return below;
  return Math.max(8, stripTop - height - 6);
}

/** The first colour no group has; when all are taken, the least used one. */
function nextColor(state) {
  const used = new Map(COLORS.map((c) => [c, 0]));
  for (const g of liveGroups(state)) used.set(g.color, (used.get(g.color) || 0) + 1);
  let best = COLORS[0];
  for (const c of COLORS) if (used.get(c) < used.get(best)) best = c;
  return best;
}

function newGroupId(now = Date.now(), random = Math.random) {
  return `g-${now.toString(36)}-${Math.floor(random() * 0x100000000).toString(36)}`;
}

function createGroup(state, { name = "", color = null, id = newGroupId() } = {}) {
  const group = { id, name: cleanName(name), color: COLORS.includes(color) ? color : nextColor(state), collapsed: false };
  state.groups[id] = group;
  return group;
}

function membersOf(state, id) {
  return Object.keys(state.members).filter((leaf) => state.members[leaf] === id);
}

/**
 * Runs of side-by-side tabs of one group in a strip: [{group, start, end}] (end inclusive).
 * The chip goes on the first tab of each run.
 */
function runs(strip, members) {
  const out = [];
  for (let i = 0; i < strip.length; i++) {
    const g = members[strip[i]];
    if (!g) continue;
    const last = out[out.length - 1];
    if (last && last.group === g && last.end === i - 1) last.end = i;
    else out.push({ group: g, start: i, end: i });
  }
  return out;
}

/**
 * Where a tab joining a group goes: right after the group's last tab in this strip, or null when
 * the group has no tab here (the tab then stays where it is). Index as for insertChild after the
 * tab itself is taken out of the strip.
 */
function joinIndex(strip, members, leaf, group) {
  const rest = strip.filter((x) => x !== leaf);
  let last = -1;
  rest.forEach((x, i) => { if (members[x] === group) last = i; });
  return last < 0 ? null : last + 1;
}

/**
 * What a layout change did to a strip: the dragged tab, when it moved here (its neighbours changed or
 * it came from another strip), and tabs new to the strip. Only a drag says which tab moved: moving x
 * one place left and its neighbour one place right give the same strip.
 */
function changedLeaves(before, after, dragged) {
  const had = new Set(before);
  const near = (list, x) => { const i = list.indexOf(x); return `${list[i - 1]}|${list[i + 1]}`; };
  const moved = dragged && after.includes(dragged) && (!had.has(dragged) || near(before, dragged) !== near(after, dragged))
    ? [dragged] : [];
  const added = after.filter((x) => !had.has(x) && x !== dragged);
  return { moved, added };
}

/**
 * A tab dragged to a new place, as in Chrome: dropped between two tabs of one group, it joins that
 * group; dropped away from its own group's tabs (while the group has tabs in this strip), it leaves.
 * At a group's edge the pointer decides: `over` is the group of the tab it was over at the drop ("" a
 * tab outside groups, undefined no tab). Dropped onto a group's tab or chip, the dragged tab joins,
 * so a one-tab group can grow; dropped onto a tab outside groups, it leaves its own.
 * A new tab joins only when it lands between two tabs of one group. Returns {leaf: group | null}.
 */
function dropChanges(strip, members, moved, added, dragged = null, over = undefined) {
  const out = {};
  const around = (leaf) => {
    const i = strip.indexOf(leaf);
    return [i > 0 ? members[strip[i - 1]] || null : null, i < strip.length - 1 ? members[strip[i + 1]] || null : null];
  };
  for (const leaf of [...moved, ...added]) {
    const [left, right] = around(leaf);
    const own = members[leaf] || null;
    if (left && left === right) {
      if (own !== left) out[leaf] = left;
      continue;
    }
    const pointed = leaf === dragged;
    if (pointed && over && (left === over || right === over)) {
      if (own !== over) out[leaf] = over;
      continue;
    }
    if (!own || ((left === own || right === own) && !(pointed && over === ""))) continue;
    const others = strip.some((x) => x !== leaf && members[x] === own);
    if (others) out[leaf] = null;
  }
  return out;
}

/**
 * Tabs missing from the layout: marked gone, forgotten after GONE_KEEP_MS (a workspace switch takes
 * every tab away and brings them back later). A group without members is dropped. True on a change.
 */
function prune(state, present, now = Date.now()) {
  let changed = false;
  if (!state.gone) state.gone = {};
  for (const leaf of Object.keys(state.members)) {
    if (present.has(leaf)) {
      if (state.gone[leaf] !== undefined) { delete state.gone[leaf]; changed = true; }
    } else if (state.gone[leaf] === undefined) {
      state.gone[leaf] = now;
      changed = true;
    } else if (now - state.gone[leaf] > GONE_KEEP_MS) {
      delete state.members[leaf];
      delete state.gone[leaf];
      changed = true;
    }
  }
  for (const leaf of Object.keys(state.gone)) if (!state.members[leaf]) { delete state.gone[leaf]; changed = true; }
  const used = new Set(Object.values(state.members));
  for (const id of Object.keys(state.groups)) {
    if (!used.has(id)) { delete state.groups[id]; changed = true; }
  }
  return changed;
}

/** A group its last tab just left (taken out, moved to another group) is dropped at once. */
function dropIfEmpty(state, id) {
  if (id && !Object.values(state.members).includes(id)) delete state.groups[id];
}

/** Groups with a tab in the layout now: the ones menus offer and colours count. */
function liveGroups(state) {
  const live = new Set();
  for (const [leaf, id] of Object.entries(state.members)) if (!state.gone || state.gone[leaf] === undefined) live.add(id);
  return Object.values(state.groups).filter((g) => live.has(g.id));
}

/**
 * The tab to show when a group folds while one of its tabs is in front: the nearest tab after the
 * group, else before it (Chrome does the same). -1 when every tab of the strip is in the group.
 */
function tabOutside(strip, members, group, current) {
  for (let i = current + 1; i < strip.length; i++) if (members[strip[i]] !== group) return i;
  for (let i = current - 1; i >= 0; i--) if (members[strip[i]] !== group) return i;
  return -1;
}

export { COLORS, MAX_NAME, GONE_KEEP_MS, liveGroups, dropIfEmpty, emptyGroups, cleanGroups, cleanName, nextColor, newGroupId, createGroup, membersOf,
         runs, joinIndex, changedLeaves, dropChanges, prune, tabOutside, editorTop };

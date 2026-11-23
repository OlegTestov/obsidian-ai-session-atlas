// Agent filters, labels and badges for Search, Active and Statistics.
// Classic script: shares one global scope with the other page files.
/* exported agentFilter, agentQuery, agentFiltered, agentPassesView, resetAgents, closeAgentFilters -- used by other page scripts */
/* exported agentBadge, agentIcon, agentLabel, agentName, agentShort, agentPick, agentControls, withTabScreen, setOpenCodeAvailable -- used by other page scripts */
// The same dropdown as the Active filters (.ms), but all agents are ticked by default and one
// always stays ticked. The pick is remembered per view in this browser: losing it is harmless.
const AGENTS_KEY = "atlas.agents";
const AGENT_VIEWS = ["search", "active", "stats"];
const agentPick = (() => {
  const saved = loadStored(AGENTS_KEY, {});
  const out = {};
  AGENT_VIEWS.forEach(v => { out[v] = AtlasLogic.savedAgentSelection(saved && saved[v]); });
  return out;
})();
let opencodeAvailable = window.ATLAS_OPENCODE_AVAILABLE === true;
const agentUI = {};                  // view → {btn, pop, list, fill}

function agentName(agent) {
  return AtlasLogic.findAgent(agent)?.label || i18n("agent.unknown");
}

function agentIcon(kind) {
  if (!Object.hasOwn(AtlasAgentMarks, kind)) return document.createDocumentFragment();
  const mark = AtlasAgentMarks[kind];
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "agent-icon");
  svg.setAttribute("data-agent", kind);
  svg.setAttribute("viewBox", mark.viewBox);
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  for (const { d, opacity } of mark.paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    if (opacity) path.setAttribute("opacity", opacity);
    svg.appendChild(path);
  }
  return svg;
}

function agentLabel(kind) {
  const label = el("span", "agent-label");
  label.append(agentIcon(kind), el("span", "agent-name", agentName(kind)));
  return label;
}

// Reply author on cards and in the feed: "Claude" or "Codex".
function agentShort(s) {
  return AtlasLogic.findAgent(AtlasLogic.agentOf(s))?.short || i18n("agent.unknown");
}

// Each agent's own slash commands and argument pickers (the server lists them per agent); the
// plan-mode dialog is Claude Code's only.
function agentControls(s) {
  const agent = AtlasLogic.agentOf(s);
  const commands = AtlasLogic.requireAgent(agent, { claude: true, codex: true }, "card input");
  return { commands: commands && !s.pending, plan: agent === "claude", agent };
}

// Codex writes no approval into its rollout, so the server sees a waiting Codex session as busy or
// idle. The plugin reads the tab's screen: "waiting" there makes the card wait for you, like a
// Claude dialog, and only then is the dialog read. Messages queued in the terminal UI are on its
// screen only. The server's own row stays untouched. screen: {state, queued} from the plugin.
function withTabScreen(s, screen) {
  if (s.pending || AtlasLogic.agentOf(s) !== "codex" || !screen) return s;
  const extra = {};
  if (screen.state === "waiting") {
    Object.assign(extra, { status: "waiting", activity: "waiting",
                           waiting_for: s.waiting_for || "permission prompt" });
  }
  if ((screen.queued || []).length && !(s.queued || []).length) {
    extra.queued = screen.queued.map(text => ({ text, at: null }));
  }
  return Object.keys(extra).length ? Object.assign({}, s, extra) : s;
}

function agentBadge(s) {
  const a = AtlasLogic.agentOf(s);
  const b = el("span", AtlasLogic.findAgent(a) ? "agent-badge " + a : "agent-badge", agentName(a));
  b.title = i18n("agent.badgeHint", { agent: agentName(a) });
  return b;
}

function shownAgents(view) {
  return AtlasLogic.AGENTS.filter(kind => kind !== "opencode" || opencodeAvailable);
}

function setOpenCodeAvailable(available) {
  if (typeof available !== "boolean" || available === opencodeAvailable) return;
  opencodeAvailable = available;
  for (const view of AGENT_VIEWS) refreshAgentButton(view);
}

function viewSelection(view) {
  const visible = shownAgents(view);
  const selected = visible.filter(kind => agentPick[view].includes(kind));
  return selected.length ? selected : visible;
}

function agentFiltered(view) {
  return shownAgents(view).length > viewSelection(view).length;
}

/** Omit the parameter when every visible agent is selected. */
function agentQuery(view) {
  return agentFiltered(view) ? AtlasLogic.agentParam(viewSelection(view)) : "";
}

function agentPassesView(view, s) {
  return viewSelection(view).includes(AtlasLogic.agentOf(s));
}

function setAgents(view, list) {
  agentPick[view] = AtlasLogic.agentSelection(list);
  store(AGENTS_KEY, Object.fromEntries(AGENT_VIEWS.map(v => {
    const selected = viewSelection(v);
    const originalPair = AtlasLogic.AGENTS.length === 3 && selected.join(",") === "claude,codex"
      && !shownAgents(v).includes("opencode");
    return [v, originalPair || selected.length === 1 ? selected : AtlasLogic.storedAgentSelection(agentPick[v])];
  })));
  refreshAgentButton(view);
}

function resetAgents(view) {
  setAgents(view, AtlasLogic.AGENTS);
}

/**
 * The dropdown for one view. onChange runs after a click. opts.counts() gives {agent: n} when known;
 * opts.named shows the selection on the button itself.
 */
function agentFilter(view, onChange, opts) {
  const counts = opts && opts.counts;
  const wrap = el("div", "ms agent-ms");
  const btn = el("button", "ms-btn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  const pop = el("div", "ms-pop hidden");
  pop.setAttribute("role", "group");
  pop.setAttribute("aria-label", i18n("agent.filter"));
  const list = el("div", "ms-list");
  pop.appendChild(list);
  const fill = () => {
    const n = counts ? counts() : null;
    const selected = viewSelection(view);
    list.replaceChildren(...shownAgents(view).map(a => {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = selected.includes(a);
      box.disabled = box.checked && selected.length === 1;
      if (box.disabled) label.title = i18n("agent.lastOne");
      box.addEventListener("change", () => {
        setAgents(view, AtlasLogic.toggleAgent(selected, a, box.checked));
        onChange();
      });
      label.append(box, agentLabel(a));
      if (n) label.appendChild(el("span", "n", String(n[a] || 0)));
      return label;
    }));
  };
  const ui = { btn, pop, list, fill, named: !!(opts && opts.named) };
  pop.addEventListener("click", e => e.stopPropagation());   // a click inside does not close it
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = pop.classList.contains("hidden");
    closeFilters(ui);
    pop.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) { fill(); placePop(pop, btn); }
  });
  wrap.append(btn, pop);
  agentUI[view] = ui;
  refreshAgentButton(view);
  return wrap;
}

// Like the Active filter buttons: a short label, a dot while filtering, the pick in the tooltip.
function refreshAgentButton(view) {
  const ui = agentUI[view];
  if (!ui) return;
  const label = i18n("agent.filter");
  const on = agentFiltered(view);
  const visible = viewSelection(view);
  let content = label;
  if (ui.named) {
    if (visible.length === 1) content = agentLabel(visible[0]);
    else {
      content = el("span", "agent-label");
      content.append(...visible.map(agentIcon));
    }
  }
  ui.btn.replaceChildren(content, ...(on ? [el("span", "fdot", "●")] : []), " ▾");
  ui.btn.title = ui.named || on ? `${label}: ${visible.map(agentName).join(", ")}`
    : i18n("active.filterAll", { label });
  if (ui.named) ui.btn.setAttribute("aria-label", ui.btn.title);
  ui.btn.classList.toggle("on", on);
  if (!ui.pop.classList.contains("hidden")) ui.fill();   // an open list follows the poll
}

function closeAgentFilters(except) {
  Object.values(agentUI).forEach(ui => {
    if (ui === except) return;
    ui.pop.classList.add("hidden");
    ui.btn.setAttribute("aria-expanded", "false");
  });
}

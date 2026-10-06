// Agent filter (Claude Code / Codex) for Search, Active and Statistics, and the agent badge.
// Classic script: shares one global scope with the other page files.
/* exported agentFilter, agentQuery, agentFiltered, agentPassesView, resetAgents, closeAgentFilters -- used by other page scripts */
/* exported agentBadge, agentName, agentShort, agentPick, agentControls, withTabScreen -- used by other page scripts */
// The same dropdown as the Active filters (.ms), but both agents are ticked by default and one
// always stays ticked. The pick is remembered per view in this browser: losing it is harmless.
const AGENTS_KEY = "atlas.agents";
const AGENT_VIEWS = ["search", "active", "stats"];
const agentPick = (() => {
  const saved = loadStored(AGENTS_KEY, {});
  const out = {};
  AGENT_VIEWS.forEach(v => { out[v] = AtlasLogic.agentSelection(saved && saved[v]); });
  return out;
})();
const agentUI = {};                  // view → {btn, pop, list, fill}

function agentName(agent) {
  if (agent === "claude") return i18n("agent.claude");
  return agent === "codex" ? i18n("agent.codex") : String(agent);
}

// Reply author on cards and in the feed: "Claude" or "Codex".
function agentShort(s) {
  return i18n(AtlasLogic.agentOf(s) === "codex" ? "agent.codexShort" : "agent.claudeShort");
}

// Controls only Claude Code understands: its slash commands with their argument pickers and the
// plan-mode dialog. A Codex card keeps the reply field, Stop and the tab buttons.
function agentControls(s) {
  const claude = AtlasLogic.agentOf(s) === "claude";
  return { commands: claude, plan: claude };
}

// Codex writes no approval into its rollout, so the server sees a waiting Codex session as busy or
// idle. The plugin reads the tab's screen: "waiting" there makes the card wait for you, like a
// Claude dialog, and only then is the dialog read. The server's own row stays untouched.
function withTabScreen(s, screen) {
  if (AtlasLogic.agentOf(s) !== "codex" || screen !== "waiting") return s;
  return Object.assign({}, s, { status: "waiting", activity: "waiting",
                                waiting_for: s.waiting_for || "permission prompt" });
}

function agentBadge(s) {
  const a = AtlasLogic.agentOf(s);
  const b = el("span", "agent-badge " + a, agentName(a));
  b.title = i18n("agent.badgeHint", { agent: agentName(a) });
  return b;
}

function agentFiltered(view) {
  return agentPick[view].length < AtlasLogic.AGENTS.length;
}

/** The `agent` request parameter of a view: "" when both agents are picked. */
function agentQuery(view) {
  return AtlasLogic.agentParam(agentPick[view]);
}

function agentPassesView(view, s) {
  return AtlasLogic.agentPasses(s, agentPick[view]);
}

function setAgents(view, list) {
  agentPick[view] = AtlasLogic.agentSelection(list);
  store(AGENTS_KEY, agentPick);
  refreshAgentButton(view);
}

function resetAgents(view) {
  setAgents(view, AtlasLogic.AGENTS);
}

/**
 * The dropdown for one view. onChange runs after a click. opts.counts() gives {agent: n} when known;
 * opts.named shows the pick on the button, for a place that already has an "Agent" heading.
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
    list.replaceChildren(...AtlasLogic.AGENTS.map(a => {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = agentPick[view].includes(a);
      box.disabled = box.checked && agentPick[view].length === 1;
      if (box.disabled) label.title = i18n("agent.lastOne");
      box.addEventListener("change", () => {
        setAgents(view, AtlasLogic.toggleAgent(agentPick[view], a, box.checked));
        onChange();
      });
      label.append(box, document.createTextNode(agentName(a)));
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
  const text = ui.named ? agentPick[view].map(agentName).join(", ") : label;
  ui.btn.replaceChildren(text, ...(on ? [el("span", "fdot", "●")] : []), " ▾");
  ui.btn.title = on ? `${label}: ${agentPick[view].map(agentName).join(", ")}`
    : i18n("active.filterAll", { label });
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

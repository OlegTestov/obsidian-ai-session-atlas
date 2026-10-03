// Shared code: API, date formatting, the address bar, search filter chips.
// Classic script: shares one global scope with the other page files.
/* exported tellHost, LOW_CONFIDENCE, facets, api, fmtDateTime, ago, segmented -- used by other page scripts */
/* exported loadStored, store, segButtons, hitSummary, renderPlan, writeHash -- used by other page scripts */
/* exported readHash, query, renderChips -- used by other page scripts */
const TOKEN = window.ATLAS_TOKEN;          // from the page's inline script
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag);
  if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// Inside Obsidian the page lives in a frame: the action goes to the plugin, which opens
// a terminal tab next to it instead of a person copying the command by hand.
const EMBEDDED = window.parent !== window;

function tellHost(type, payload) {
  if (!EMBEDDED) return false;
  window.parent.postMessage(Object.assign({ source: "session-atlas", type }, payload), "*");
  return true;
}
const LOW_CONFIDENCE = 0.6;

let state = { q:"", project:"", topic:"", domains:new Set(), since:"", automation:false,
              scope:"prompts", order:"date", view:"search", current:null };
let facets = { projects:[], project_domains:{}, topics:[], topic_domains:{}, domains:[] };
let lastResetNote = "";

async function api(path, body, signal) {
  const opts = body
    ? { method:"POST", headers:{ "Content-Type":"application/json", "X-Atlas-Token":TOKEN,
                                  "X-Atlas-Lang":I18N.lang() },
        body:JSON.stringify(body) }
    : { headers:{ "X-Atlas-Lang":I18N.lang() } };   // server answers in the page language
  if (signal) opts.signal = signal;
  let r;
  try {
    r = await window.fetch(path, opts);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    serverStatus(false);                     // the network did not answer: the server is down
    throw new Error(i18n("common.serverNoAnswer"));
  }
  serverStatus(true);
  const data = await r.json().catch(() => ({ error:i18n("common.badResponse") }));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

// Times in the database are UTC. Showing the raw string would be off by the timezone offset.
function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(I18N.locale(),
    { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

function ago(iso) {
  if (!iso) return i18n("common.timeUnknown");
  const h = (Date.now() - new Date(iso)) / 36e5;
  const min = Math.round(h * 60);
  if (min < 1) return i18n("common.justNow");
  if (h < 1) return i18n("common.minAgo", { n: min });
  if (h < 24) return i18n("common.hoursAgo", { n: Math.round(h) });
  const d = Math.round(h / 24);
  if (d < 31) return i18n("common.daysAgo", { n: d });
  return new Date(iso).toLocaleDateString(I18N.locale());
}

// The snippet arrives in pieces {t, hit}: « » markers would clash with quotes in the text.
function segmented(tag, cls, segs) {
  const box = el(tag, cls);
  (segs || []).forEach(s =>
    box.appendChild(s.hit ? el("mark", null, s.t) : document.createTextNode(s.t)));
  return box;
}

// Single-browser conveniences (chosen view, drafts): losing them is harmless, so everything is in try.
function loadStored(key, fallback) {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) || "null");
    return v === null ? fallback : v;
  } catch { return fallback; }
}

function store(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ }
}

// A button switch: one option is selected. Not segmented, which is about highlighting.
function segButtons(options, current, onPick, cls) {
  const box = el("div", "seg " + (cls || ""));
  box.setAttribute("role", "radiogroup");
  options.forEach(o => {
    const b = el("button", o.value === current ? "on" : null, o.label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(o.value === current));
    b.addEventListener("click", () => onPick(o.value));
    box.appendChild(b);
  });
  return box;
}

const FIELD_NAMES = { title:i18n("search.fieldTitle"), user_text:i18n("search.fieldPrompts"),
  assistant_text:i18n("search.fieldReplies"), commands:i18n("search.fieldCommands"),
  paths:i18n("search.fieldFiles"), tickets:i18n("search.fieldTickets"),
  summaries:i18n("search.fieldSummaries"), subagent_text:i18n("search.fieldSubagents") };

function hitSummary(fields) {
  return Object.entries(fields || {})
    .filter(([f]) => f !== "title")
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${FIELD_NAMES[f] || f} ${n}`).join(" · ");
}

// How the query was understood: otherwise it is unclear why one word form finds another and "13" does not find "1359".
function renderPlan(plan, error) {
  const box = $("#qplan");
  box.replaceChildren();
  box.classList.toggle("err", !!error);
  if (error) { box.textContent = error; return; }
  if (!plan || !plan.length) return;
  const text = s => box.appendChild(document.createTextNode(s));
  text(i18n("search.planLead"));
  plan.filter(t => !t.negate).forEach((t, i) => {
    if (i) text(i18n(t.or_with_previous ? "search.planOr" : "search.planAnd"));
    box.appendChild(el("span", "term", t.text));
    text(` (${t.how})`);
  });
  plan.filter(t => t.negate).forEach((t, i) => {
    text(i ? ", " : i18n("search.planWithout"));
    box.appendChild(el("span", "term neg", t.text));
  });
}

// --- state in the address bar ------------------------------------------------

function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.project) p.set("p", state.project);
  if (state.topic) p.set("t", state.topic);
  if (state.domains.size) p.set("d", [...state.domains].join(","));
  if (state.since) p.set("since", state.since);
  if (state.automation) p.set("auto", "1");
  if (state.scope !== "prompts") p.set("scope", state.scope);
  if (state.order !== "date") p.set("o", state.order);
  if (state.view !== "search") p.set("view", state.view);
  ACTIVE_FILTERS.forEach(({ key, hash }) => {
    if (activeFilter[key].size) p.set(hash, [...activeFilter[key]].join("|"));
  });
  if (activeMode === "full") p.set("am", "full");
  if (layout.compact) p.set("lc", `${layout.compact.c}x${layout.compact.r}`);
  if (layout.full) p.set("lf", `${layout.full.c}x${layout.full.r}`);
  if (state.current) p.set("s", state.current);
  const next = "#" + p.toString();
  if (location.hash !== next) history.replaceState(null, "", next);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get("q") || "";
  state.project = p.get("p") || "";
  state.topic = p.get("t") || "";
  state.domains = new Set((p.get("d") || "").split(",").filter(Boolean));
  state.since = p.get("since") || "";
  state.automation = p.get("auto") === "1";
  state.scope = p.get("scope") === "all" ? "all" : "prompts";
  state.order = p.get("o") === "relevance" ? "relevance" : "date";
  state.view = p.get("view") || "search";        // setView replaces an unknown section with search
  ACTIVE_FILTERS.forEach(({ key, hash }) => {
    activeFilter[key] = new Set((p.get(hash) || "").split("|").filter(Boolean));
  });
  activeMode = p.get("am") === "full" ? "full" : "compact";
  layout.compact = parseLayout(p.get("lc"), LAYOUT_MAX.compact);
  layout.full = parseLayout(p.get("lf"), LAYOUT_MAX.full);
  state.current = p.get("s") || null;
  $("#q").value = state.q;
  $("#since").value = state.since;
  $("#automation").checked = state.automation;
  $("#scope").checked = state.scope === "all";
  $("#order").value = state.order;
}

function query() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.project) p.set("project", state.project);
  if (state.topic) p.set("topic", state.topic);
  state.domains.forEach(d => p.append("domain", d));
  if (state.automation) p.set("automation", "1");
  if (state.scope !== "prompts") p.set("scope", state.scope);
  if (state.q && state.order !== "date") p.set("order", state.order);
  if (state.since) p.set("since", new Date(Date.now() - state.since * 864e5).toISOString());
  return p.toString();
}

// --- active filter chips -----------------------------------------------------

function renderChips(countText) {
  const box = $("#chips");
  box.replaceChildren();
  const add = (label, value, clear) => {
    const c = el("button", "chip");
    c.append(el("b", null, label + ": "), document.createTextNode(value),
             el("span", null, "✕"));
    c.addEventListener("click", () => { clear(); refillDependentFilters(); loadList(); });
    box.appendChild(c);
  };
  if (state.q) add(i18n("search.chipSearch"), state.q, () => { state.q = ""; $("#q").value = ""; });
  [...state.domains].forEach(d => add(i18n("search.chipDomain"), d, () => {
    state.domains.delete(d);
    const cb = Array.from(document.querySelectorAll("#domains input")).find(c => c.value === d);
    if (cb) cb.checked = false;
  }));
  if (state.project) add(i18n("search.chipProject"), state.project, () => { state.project = ""; });
  if (state.topic) add(i18n("search.chipTopic"), state.topic, () => { state.topic = ""; });
  if (state.since) {
    const label = $("#since").selectedOptions[0] ? $("#since").selectedOptions[0].text
      : i18n("search.chipPeriod");
    add(i18n("search.chipPeriod"), label, () => { state.since = ""; $("#since").value = ""; });
  }
  if (state.automation) add(i18n("search.chipView"), i18n("search.chipWithBackground"),
    () => { state.automation = false; $("#automation").checked = false; });
  if (state.scope === "all") add(i18n("search.chipScope"), i18n("search.chipWholeIndex"),
    () => { state.scope = "prompts"; $("#scope").checked = false; });

  if (box.childElementCount) {
    const reset = el("button", "chip", i18n("search.resetAll"));
    reset.addEventListener("click", () => {
      state.q = ""; state.project = ""; state.topic = ""; state.domains = new Set();
      state.since = ""; state.automation = false; state.scope = "prompts";
      document.querySelectorAll("#domains input").forEach(c => { c.checked = false; });
      $("#q").value = ""; $("#since").value = "";
      $("#automation").checked = false; $("#scope").checked = false;
      refillDependentFilters(); loadList();
    });
    box.appendChild(reset);
  }
  if (lastResetNote) box.appendChild(el("span", "hint", lastResetNote));
  box.appendChild(el("span", "count", countText));
}

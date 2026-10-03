// Search tab: the list, the filters on the left and event handlers.
// Classic script: shares one global scope with the other page files.
// --- list --------------------------------------------------------------------

// Search runs on every key press: answers arrive out of order, and the answer to "13" could land
// over the answer to "1359". Only the answer to the last sent query is drawn.
registerView("search", { tab: "#view-search", panel: "#app", refresh: () => loadList() });

let listSeq = 0;
let listAbort = null;

async function loadList(keepScroll) {
  writeHash();
  const scrollTop = keepScroll ? $("#list").scrollTop : 0;
  const seq = ++listSeq;
  if (listAbort) listAbort.abort();
  listAbort = new AbortController();
  const box = $("#list");
  box.setAttribute("aria-busy", "true");
  $("#order-box").classList.toggle("hidden", !state.q);
  let data;
  try { data = await api("/api/sessions?" + query(), null, listAbort.signal); }
  catch (e) {
    if (seq !== listSeq || e.name === "AbortError") return;
    box.removeAttribute("aria-busy");
    box.replaceChildren(el("p", "empty", i18n("common.error", { msg: e.message })));
    return;
  }
  if (seq !== listSeq) return;
  box.removeAttribute("aria-busy");
  box.dataset.q = state.q;

  renderPlan(data.plan, data.error);
  const shownNote = data.shown < data.count
    ? i18n("search.shownOf", { shown: data.shown, count: data.count })
    : i18nN("search.sessions", data.count);
  renderChips(shownNote);
  $("#stat").textContent = data.indexing ? i18n("search.indexing")
    : i18n("search.indexedAt", { when: ago(data.indexed_through) });
  // A long pass runs in the background: redraw the list when it ends, unless you are typing.
  if (data.indexing) window.setTimeout(() => { if (seq === listSeq) loadList(true); }, 2500);
  const lead = [];
  if (data.elsewhere) {
    const note = el("div", "elsewhere", i18nN("search.elsewhere", data.elsewhere));
    const wide = el("button", null, i18n("search.searchEverywhere"));
    wide.addEventListener("click", () => {
      state.scope = "all"; $("#scope").checked = true; loadList();
    });
    note.appendChild(wide);
    lead.push(note);
  }
  if (!data.count) {
    if (data.error) { box.replaceChildren(el("p", "empty", data.error)); return; }
    const filtered = state.q || state.domains.size || state.project || state.topic || state.since;
    box.replaceChildren(...lead, el("p", "empty", filtered
      ? i18n("search.nothingFiltered")
      : i18n("search.nothing")));
    return;
  }

  const frag = document.createDocumentFragment();
  lead.forEach(n => frag.appendChild(n));
  for (const s of data.results) {
    const row = el("div", "row");
    row.tabIndex = 0;
    row.dataset.id = s.session_id;
    row.setAttribute("aria-selected", String(s.session_id === state.current));
    const head = s.title_segments ? segmented("div", "t", s.title_segments)
      : el("div", "t", s.title || s.session_id);
    head.appendChild(el("span", "when", "  · " + ago(s.last_activity_at)));
    row.appendChild(head);

    if (s.matches && s.matches.length && s.matches[0].segments.length) {
      const m = s.matches[0];
      const f = segmented("div", "frag", m.segments);
      f.prepend(el("span", "field", FIELD_NAMES[m.field] || m.field));
      row.appendChild(f);
      const summary = hitSummary(s.hit_fields);
      if (summary) row.appendChild(el("div", "hits", i18n("search.hits", { list: summary })));
    } else if (s.card_line) {
      row.appendChild(el("div", "frag", s.card_line));
    } else if (s.last_prompt) {
      row.appendChild(el("div", "frag", s.last_prompt));
    }

    const meta = el("div", "meta");
    const projects = s.projects || [];
    if (projects.length) {
      meta.appendChild(el("span", "pill acc", projects[0]
        + (projects.length > 1 ? ` +${projects.length - 1}` : "")));
    }
    // The misc topic value (in either language) comes from the data, not interface text.
    if (s.topic && !/^(разное|misc)$/.test(s.topic)) meta.appendChild(el("span", "pill acc", s.topic));
    (s.domains || []).forEach(d => meta.appendChild(el("span", "pill", d)));
    if (s.sensitivity === "sensitive")
      meta.appendChild(el("span", "pill warn", i18n("search.sensitive")));
    // A ticket matching the query comes first and highlighted: otherwise "1359" shows ABC-1082 and ABC-13.
    const wanted = (data.plan || []).filter(t => !t.negate).map(t => t.text.toLowerCase());
    const isHit = t => wanted.some(w => t.toLowerCase().includes(w));
    const tickets = [...(s.tickets || [])].sort((a, b) => isHit(b) - isHit(a));
    tickets.slice(0, 3).forEach(t => meta.appendChild(el("span", isHit(t) ? "pill acc" : "pill", t)));
    meta.appendChild(el("span", null, i18nN("search.turns", s.human_turns)));
    if (s.cost_usd != null) meta.appendChild(el("span", null, "$" + s.cost_usd.toFixed(2)));
    row.appendChild(meta);

    row.addEventListener("click", () => openCard(s.session_id));
    row.addEventListener("keydown", e => { if (e.key === "Enter") openCard(s.session_id); });
    frag.appendChild(row);
  }
  box.replaceChildren(frag);
  if (keepScroll) box.scrollTop = scrollTop;
}


// --- filters -----------------------------------------------------------------

function fitsDomains(owned) {
  if (!state.domains.size) return true;
  return (owned || []).some(d => state.domains.has(d));
}

function refillSelect(sel, values, map, stateKey, label) {
  const keep = state[stateKey];
  const allowed = values.filter(v => fitsDomains(map[v]));
  sel.replaceChildren(new Option(i18n("search.all"), ""));
  allowed.forEach(v => sel.appendChild(new Option(v, v)));
  if (keep && allowed.includes(keep)) {
    sel.value = keep;
  } else if (keep) {
    // The selection must not change silently: say what was cleared and why.
    lastResetNote = i18n("search.filterReset", { label, value: keep });
    state[stateKey] = "";
    sel.value = "";
  }
}

function refillDependentFilters() {
  lastResetNote = "";
  refillSelect($("#project"), facets.projects, facets.project_domains, "project", i18n("search.project"));
  refillSelect($("#topic"), facets.topics, facets.topic_domains, "topic", i18n("search.topic"));
}

function bindFilters(data) {
  facets = data;
  const box = $("#domains");
  box.replaceChildren();
  data.domains.forEach(d => {
    const l = el("label");
    const c = document.createElement("input");
    c.type = "checkbox"; c.value = d; c.checked = state.domains.has(d);
    c.addEventListener("change", () => {
      c.checked ? state.domains.add(d) : state.domains.delete(d);
      refillDependentFilters();
      loadList();
    });
    l.append(c, document.createTextNode(d));
    box.appendChild(l);
  });
  refillDependentFilters();
  bindAutoClassify(data.auto_classify);
  // AI features off: hide the model buttons, the server rejects them anyway.
  const llm = data.llm_enabled === true;
  $("#classify").hidden = !llm;
  $("#auto-classify-label").hidden = !llm;
  const btn = $("#classify");
  if (data.classify_job) {
    setClassifyRunning(data.unclassified);
    watchClassify(data.classify_job);
  } else if (!classifyJobId) {
    btn.textContent = data.unclassified
      ? i18n("search.classifyN", { n: data.unclassified })
      : i18n("search.classifyUpToDate");
    btn.disabled = !data.unclassified;
  }
}

let classifyJobId = null;

// Auto-classification: the server labels new sessions once an hour. Off by default.
function bindAutoClassify(auto) {
  const box = $("#auto-classify");
  if (!auto) return;
  box.checked = !!auto.enabled;
  const when = iso => (iso ? fmtDateTime(iso) : i18n("search.autoNever"));
  $("#auto-classify-label").title = auto.enabled
    ? i18n("search.autoOnTitle", { max: auto.max_per_run, last: when(auto.last_run),
                                   next: when(auto.next_run) })
    : i18n("search.autoOffTitle", { interval: auto.interval_minutes, max: auto.max_per_run });
}

$("#auto-classify").addEventListener("change", async e => {
  const want = e.target.checked;
  try {
    bindAutoClassify(await api("/api/auto-classify", { enabled: want }));
  } catch (err) {
    e.target.checked = !want;
    modal(i18n("search.autoClassify"), i18n("common.saveFailed", { msg: err.message }), "");
  }
});

function setClassifyRunning(left) {
  const btn = $("#classify");
  btn.disabled = true;
  btn.textContent = left ? i18n("search.classifyingLeft", { n: left }) : i18n("search.classifying");
}

// The job runs on the server, so the dialog closes at once and the job is tracked in the background.
async function watchClassify(jobId) {
  if (classifyJobId === jobId) return;
  classifyJobId = jobId;
  for (let i = 0; i < 400; i++) {
    let job;
    try { job = await api("/api/job/" + jobId); }
    catch { break; }
    if (job.state === "done" || job.state === "failed") {
      classifyJobId = null;
      const facets = await api("/api/facets");
      bindFilters(facets);
      await loadList();
      const btn = $("#classify");
      if (job.state === "failed") {
        btn.textContent = i18n("search.classifyFailedBtn");
        modal(i18n("search.classifyFailed"), job.error || "", "");
      }
      return;
    }
    // The remaining count comes from the facets: pending honestly drops after each batch.
    try { setClassifyRunning((await api("/api/facets")).unclassified); } catch { /* keep the last count */ }
    await new Promise(r => window.setTimeout(r, 5000));
  }
  classifyJobId = null;
}

// --- events ------------------------------------------------------------------

let timer;
$("#q").addEventListener("input", e => {
  state.q = e.target.value.trim();
  window.clearTimeout(timer); timer = window.setTimeout(loadList, 220);
});
$("#project").addEventListener("change", e => { state.project = e.target.value; loadList(); });
$("#topic").addEventListener("change", e => { state.topic = e.target.value; loadList(); });
$("#since").addEventListener("change", e => { state.since = e.target.value; loadList(); });
$("#automation").addEventListener("change", e => {
  state.automation = e.target.checked; loadList();
});
$("#order").addEventListener("change", e => { state.order = e.target.value; loadList(); });
$("#scope").addEventListener("change", e => {
  state.scope = e.target.checked ? "all" : "prompts"; loadList();
});
$("#m-close").addEventListener("click", () => $("#modal").close());
$("#help-btn").addEventListener("click", () => {
  buildHelp();
  $("#help").showModal();
  // Otherwise focus moves to the scrolling body and it gets an outline.
  $("#help-close").focus();
});
$("#help-close").addEventListener("click", () => $("#help").close());
$("#rename-cancel").addEventListener("click", () => $("#rename").close());

// A click outside closes the menu. One listener for the whole app: the card redraws
// often, and adding a listener on every open leaks.
document.addEventListener("click", e => {
  const menu = document.getElementById("menu");
  if (menu) menu.classList.add("hidden");
  closeFilters();                 // the Active dropdown filters close on the same outside click
  selectCardByClick(e);           // a click on an Active card selects it for the keyboard
});

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault(); $("#q").focus(); $("#q").select();
  } else if (e.key === "Escape" && document.activeElement === $("#q") && $("#q").value) {
    e.preventDefault();
    $("#q").value = ""; state.q = ""; loadList();
  }
});

$("#reindex").addEventListener("click", async e => {
  e.target.disabled = true; e.target.textContent = i18n("search.reindexing");
  try {
    await api("/api/reindex", {});
    bindFilters(await api("/api/facets"));
    await loadList();
  } finally { e.target.disabled = false; e.target.textContent = i18n("search.reindex"); }
});

$("#classify").addEventListener("click", async () => {
  let prev;
  try { prev = await api("/api/classify/preview", {}); }
  catch (e) { modal(i18n("common.errorTitle"), e.message, ""); return; }
  if (!prev.pending) { modal(i18n("search.classifyTitle"), i18n("search.nothingToClassify"), ""); return; }
  modal(i18n("search.classifySessions"),
    i18nN("search.classifyNote", prev.pending,
          { chars: prev.estimated_chars, model: prev.model, note: prev.note }),
    prev.samples.join("\n\n— — —\n\n"),
    i18n("search.confirmRun"), async () => {
      $("#m-ok").disabled = true;
      try {
        const job = await api("/api/classify", { confirmed:true });
        $("#modal").close();                  // the work runs on the server, no need to wait for it
        setClassifyRunning(prev.pending);
        watchClassify(job.job_id);
      } catch (e) {
        $("#m-note").textContent = i18n("common.error", { msg: e.message }); $("#m-ok").disabled = false;
      }
    });
});

// Session card on the Search tab.
// Classic script: shares one global scope with the other page files.
// --- card --------------------------------------------------------------------

function kv(pairs) {
  const dl = el("dl", "kv");
  for (const [k, v] of pairs) {
    if (v == null || v === "") continue;
    dl.appendChild(el("dt", null, k));
    dl.appendChild(el("dd", null, String(v)));
  }
  return dl;
}

// The main block is built locally: it must not depend on a model call.
function stateBlock(st) {
  const b = el("div", "block lead");
  b.appendChild(el("h4", null, i18n("card.whereStopped")));
  if (!st) { b.appendChild(el("p", "note", i18n("card.stateUnreadable"))); return b; }
  const quote = (label, text) => {
    if (!text) return;
    const q = el("div", "quote");
    q.appendChild(el("i", null, label));
    q.appendChild(document.createTextNode(text));
    b.appendChild(q);
  };
  quote(i18n("card.lastPrompt"), st.last_prompt);
  quote(i18n("card.lastAnswer"), st.last_answer);
  if (st.compaction_summary) {
    quote(i18n("card.compactionSummary", { n: st.compactions }), st.compaction_summary);
  }
  b.appendChild(kv([
    [i18n("card.folder"), st.cwd], [i18n("card.branch"), st.branch],
    [i18n("card.filesEdited"), st.files], [i18n("card.commandsRun"), st.commands],
  ]));
  return b;
}

function summaryBlock(art, cardLine, confidence) {
  const b = el("div", "block");
  const h = el("h4", null, i18n("card.done"));
  b.appendChild(h);
  if (!art || !art.payload) {
    if (cardLine) {
      b.appendChild(el("p", null, cardLine));
      const src = el("p", "note", confidence != null
        ? i18n("card.shortByClassifierConf", { c: confidence.toFixed(2) })
        : i18n("card.shortByClassifier"));
      if (confidence != null && confidence < LOW_CONFIDENCE) src.classList.add("low");
      b.appendChild(src);
    } else {
      b.appendChild(el("p", "note", i18n("card.noSummary")));
    }
    return b;
  }
  h.textContent = i18n("card.doneHead",
    { state: i18n(art.fresh ? "card.fresh" : "card.stale"), model: art.model });
  let data = null;
  try { data = JSON.parse(art.payload); } catch { /* not JSON: data stays null */ }
  if (data) {
    b.appendChild(kv([[i18n("card.did"), data.did], [i18n("card.result"), data.result],
                      [i18n("card.open"), data.open], [i18n("card.outcome"), data.work_outcome]]));
  } else {
    b.appendChild(el("pre", null, art.payload));
  }
  return b;
}

function classifyBlock(s) {
  const b = el("div", "block");
  const low = s.topic_confidence != null && s.topic_confidence < LOW_CONFIDENCE;
  const h = el("h4", null, i18n("card.classification"));
  if (s.topic_source) h.appendChild(el("span", "src", "  ·  " + s.topic_source));
  b.appendChild(h);
  b.appendChild(kv([
    [i18n("search.topic"), (s.topic || i18n("card.topicNone"))
      + (s.topic_stale ? i18n("card.topicStaleSuffix") : "")],
    [i18n("search.domain"), (s.domains || []).join(", ") || i18n("card.domainNone")],
    [i18n("card.confidence"), s.topic_confidence == null ? "—" : s.topic_confidence.toFixed(2)],
    [i18n("card.sensitivity"), s.sensitivity],
  ]));
  if (low) {
    b.appendChild(el("p", "note low", i18n("card.lowConfidence")));
  }

  const row = el("div", "fix");
  const domain = document.createElement("select");
  domain.appendChild(new Option(i18n("card.domainKeep"), ""));
  // Domains come from the user's settings (the server sends them in the facets).
  (facets.domain_options || facets.domains || []).forEach(d => domain.appendChild(new Option(d, d)));
  const topic = document.createElement("input");
  topic.type = "text"; topic.placeholder = i18n("card.topicPlaceholder"); topic.value = s.topic || "";
  const sens = document.createElement("select");
  sens.appendChild(new Option(i18n("card.sensKeep"), ""));
  ["unclassified", "normal", "sensitive"].forEach(v => sens.appendChild(new Option(v, v)));
  const save = el("button", null, i18n("common.save"));
  const done = el("span", "ok");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api("/api/override", { session_id:s.session_id, domain:domain.value || null,
                                   topic:topic.value.trim() || null,
                                   sensitivity:sens.value || null });
      done.textContent = i18n("common.saved");
      bindFilters(await api("/api/facets"));
      await loadList();
      await openCard(s.session_id);
    } catch (e) { done.textContent = i18n("common.error", { msg: e.message }); }
    finally { save.disabled = false; }
  });
  row.append(domain, topic, sens, save, done);
  b.appendChild(row);
  b.appendChild(el("p", "note", i18n("card.manualNote")));
  return b;
}

// One primary button, one secondary, the rest in a menu: the decision to continue
// the work must not look like a choice among four equal options.
function actionBar(s) {
  const bar = el("div", null); bar.id = "bar";
  const resume = el("button", "primary", i18n("card.resume"));
  resume.addEventListener("click", () => showResume(s));
  const fresh = el("button", null, i18n("card.newFromThis"));
  fresh.addEventListener("click", () => startArtifact(s.session_id, "handoff", true));
  const more = el("button", "ghost", "…");
  more.setAttribute("aria-label", i18n("card.moreActions"));

  const menu = el("div", null); menu.id = "menu"; menu.classList.add("hidden");
  const item = (label, fn) => {
    const btn = el("button", null, label);
    btn.addEventListener("click", () => { menu.classList.add("hidden"); fn(); });
    menu.appendChild(btn);
  };
  const llm = facets.llm_enabled === true;
  if (llm) {
    item(i18n("card.handoffOnly"), () => startArtifact(s.session_id, "handoff", false));
    item(i18n("card.detailedSummary"), () => startArtifact(s.session_id, "catalog_summary", false));
  }
  item(i18n("card.exactFork"), () => showResume(s, true));
  item(i18n("delete.menu"), () => deleteSession(s));
  menu.lastChild.classList.add("danger");
  more.addEventListener("click", e => { e.stopPropagation(); menu.classList.toggle("hidden"); });

  bar.append(...(llm ? [resume, fresh, more, menu] : [resume, more, menu]));
  return bar;
}

async function openCard(id) {
  state.current = id;
  writeHash();
  document.querySelectorAll(".row").forEach(r =>
    r.setAttribute("aria-selected", String(r.dataset.id === id)));
  const card = $("#card");
  const body = el("div", null); body.id = "card-body";
  card.replaceChildren(body);
  body.replaceChildren(el("p", "empty", "…"));
  let s;
  try { s = await api("/api/session/" + encodeURIComponent(id)); }
  catch (e) { body.replaceChildren(el("p", "empty", i18n("common.error", { msg: e.message }))); return; }

  const frag = document.createDocumentFragment();
  const h3 = el("h3", null, s.title || id);
  h3.title = i18n("card.dblclickRename");
  h3.addEventListener("dblclick", () => renameSession(s));
  frag.appendChild(h3);
  const sub = el("p", "sub");
  sub.append(document.createTextNode(
    i18n("card.subUpdated", { kind: s.session_kind, when: ago(s.last_activity_at) })
    + (s.title_source === "manual" ? i18n("card.manualName") : "") + "  "));
  const ren = el("button", "ghost", i18n("card.rename"));
  ren.addEventListener("click", () => renameSession(s));
  sub.appendChild(ren);
  frag.appendChild(sub);

  frag.appendChild(stateBlock(s.state));
  frag.appendChild(summaryBlock(s.summary, s.card_line, s.topic_confidence));

  if (s.files && s.files.length) {
    // Collapsed, like prompts and metadata: a long list does not push the rest down.
    const b = el("details", "block");
    b.appendChild(el("summary", null, i18n("card.editedFiles", { n: s.files.length })));
    const ul = el("ul", "files");
    s.files.forEach(f => ul.appendChild(el("li", null, f.resolved_path)));
    b.appendChild(ul);
    frag.appendChild(b);
  }
  if (s.links && s.links.length) {
    const b = el("div", "block");
    b.appendChild(el("h4", null, i18n("card.links")));
    const ul = el("ul", "files");
    s.links.forEach(l => ul.appendChild(el("li", null, l.kind + ": " + l.url)));
    b.appendChild(ul);
    frag.appendChild(b);
  }

  frag.appendChild(classifyBlock(s));

  const prompts = el("details", "block");
  prompts.appendChild(el("summary", null, i18n("card.userPrompts")));
  prompts.addEventListener("toggle", async () => {
    if (!prompts.open || prompts.dataset.loaded) return;
    prompts.dataset.loaded = "1";
    const data = await api("/api/prompts/" + encodeURIComponent(id));
    data.prompts.forEach(p => prompts.appendChild(el("pre", null, p)));
  });
  frag.appendChild(prompts);

  // Technical details go down and collapsed: continuing the work does not need them.
  const tech = el("details", "block");
  tech.appendChild(el("summary", null, i18n("card.metadata")));
  tech.appendChild(kv([
    [i18n("card.id"), s.session_id],
    [i18n("search.period"), `${fmtDateTime(s.started_at)} → ${fmtDateTime(s.last_activity_at)}`],
    [i18n("card.projects"), (s.projects || []).join(", ")],
    [i18n("card.turns"),
     `${s.human_turns} / ${s.machine_turns} / ${s.subagent_turns}`],
    [i18n("card.apiCost"), s.cost_usd == null ? i18n("card.costNone") : "$" + s.cost_usd.toFixed(2)],
    [i18n("card.tickets"), (s.tickets || []).join(", ")],
  ]));
  frag.appendChild(tech);

  body.replaceChildren(frag);
  card.replaceChildren(body, actionBar(s));
}

// The title goes both to the catalog and to the transcript itself: Claude Code reads the same record.
// An own dialog, not prompt(): in Obsidian the page lives in Electron, where prompt is unsupported
// and a click silently does nothing.
function renameSession(s) {
  const input = $("#rename-input");
  const error = $("#rename-error");
  input.value = s.title || "";
  error.textContent = "";
  $("#rename").showModal();
  input.focus();
  input.select();

  const save = async () => {
    const title = input.value.trim();
    if (!title || title === (s.title || "")) { $("#rename").close(); return; }
    $("#rename-save").disabled = true;
    try {
      const r = await api("/api/rename", { session_id:s.session_id, title, to_claude:true });
      $("#rename").close();
      await loadList();
      await openCard(s.session_id);
      if (r.error) modal(i18n("card.renamedInCatalog"), r.error, "");
    } catch (e) {
      error.textContent = i18n("common.failed", { msg: e.message });
    } finally { $("#rename-save").disabled = false; }
  };

  $("#rename-save").onclick = save;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } };
}

// Quick jump by name: ⌘K (Ctrl+K) from any section, live and recently closed sessions.
// Classic script: shares one global scope with the other page files.
// ⌘K is free: Obsidian's menu does not use it, and key presses inside the iframe do not reach
// Obsidian's hotkeys; "insert link" on ⌘K works only in the note editor.
let jumpItems = [];
let jumpActive = 0;

function jumpSources() {
  const live = activeSessions.map(s => ({
    kind: "live", id: s.session_id, title: s.title || s.session_id.slice(0, 8),
    sub: [s.topic, ...(s.projects || []), ...(s.domains || [])].filter(Boolean).join(" "),
    note: (STATUS[s.activity || s.status] || STATUS.idle).label,
  }));
  const closed = recentClosed.map(c => ({
    kind: "closed", id: c.session_id, title: c.title || c.session_id.slice(0, 8), sub: c.summary || "",
    note: i18n("closed.closedAgo", { ago: ago(c.last_activity_at) }),
  }));
  return live.concat(closed);
}

function jumpDialog() {
  let dlg = $("#jump");
  if (dlg) return dlg;
  dlg = el("dialog");
  dlg.id = "jump";
  dlg.setAttribute("aria-label", i18n("jump.label"));
  const input = el("input");
  input.type = "search";
  input.placeholder = i18n("jump.placeholder");
  input.autocomplete = "off";
  const list = el("div", "jlist");
  list.setAttribute("role", "listbox");
  dlg.append(input, list, el("p", "jhint", i18n("jump.hint")));
  input.addEventListener("input", () => { jumpActive = 0; renderJump(); });
  input.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!jumpItems.length) return;
      jumpActive = (jumpActive + (e.key === "ArrowDown" ? 1 : -1) + jumpItems.length) % jumpItems.length;
      renderJump();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (jumpItems[jumpActive]) jumpTo(jumpItems[jumpActive]);
    }
  });
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });   // click outside the dialog
  document.body.appendChild(dlg);
  return dlg;
}

function renderJump() {
  const dlg = jumpDialog();
  jumpItems = AtlasLogic.jumpMatches(jumpSources(), dlg.querySelector("input").value, 12);
  const list = dlg.querySelector(".jlist");
  list.replaceChildren(...(jumpItems.length ? jumpItems.map((it, i) => {
    const row = el("div", "jrow" + (i === jumpActive ? " on" : "") + (it.kind === "closed" ? " closed" : ""));
    row.setAttribute("role", "option");
    row.append(el("span", "jt", it.title), el("span", "jn", it.note));
    row.addEventListener("mousedown", e => { e.preventDefault(); jumpTo(it); });
    return row;
  }) : [el("p", "empty", i18n("jump.empty"))]));
  const on = list.querySelector(".jrow.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

function openJump() {
  const dlg = jumpDialog();
  if (dlg.open) return;
  dlg.querySelector("input").value = "";
  jumpActive = 0;
  renderJump();
  dlg.showModal();
  dlg.querySelector("input").focus();
}

// Live: select its card; hidden or filtered out: bring it back on screen.
function jumpTo(it) {
  $("#jump").close();
  if (it.kind === "closed") { setView("search"); openCard(it.id); return; }
  if (state.view !== "active") setView("active");
  const shown = () => document.querySelector(`#active-grid .acard[data-id="${CSS.escape(it.id)}"]`);
  if (!shown()) {
    delete hiddenCards[it.id];
    store(HIDDEN_KEY, hiddenCards);
    ACTIVE_FILTERS.forEach(({ key }) => activeFilter[key].clear());
    writeHash();
    lastSignature = "";
    renderActive(null, true);
  }
  selectedCard = it.id;
  applySelection(true);
}

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K" || e.code === "KeyK")) {
    e.preventDefault();
    openJump();
  }
});

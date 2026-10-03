// Active: a new session from a folder in the list and a first prompt, in an Obsidian terminal tab.
// Classic script: shares one global scope with the other page files.
/* exported newSessionButton -- used by other page scripts */
const LAST_DIR_KEY = "atlas.newSessionDir";   // convenience only: where the last session started

function newSessionButton() {
  const b = el("button", "chip newsess", i18n("newsess.button"));
  b.type = "button";
  b.title = i18n("newsess.button.hint");
  b.addEventListener("click", e => { e.stopPropagation(); openNewSession(); });
  return b;
}

function rememberedDir() {
  try { return window.localStorage.getItem(LAST_DIR_KEY) || ""; } catch { return ""; }
}

function rememberDir(path) {
  try { window.localStorage.setItem(LAST_DIR_KEY, path); } catch { /* private window */ }
}

async function openNewSession() {
  const dlg = $("#newsess");
  const select = $("#ns-dir");
  $("#ns-note").textContent = "";
  $("#ns-cmd").textContent = "";
  $("#ns-cmd").classList.add("hidden");
  $("#ns-copy").classList.add("hidden");
  $("#ns-go").disabled = false;
  select.replaceChildren(el("option", null, i18n("newsess.loadingDirs")));
  dlg.showModal();
  $("#ns-prompt").focus();
  let dirs = [];
  try { dirs = (await api("/api/workdirs")).workdirs || []; }
  catch (e) { $("#ns-note").textContent = i18n("newsess.dirsFailed", { msg: e.message }); return; }
  const groups = [[i18n("newsess.recent"), dirs.filter(d => d.recent)], [i18n("newsess.other"), dirs.filter(d => !d.recent)]];
  select.replaceChildren();
  groups.forEach(([name, list]) => {
    if (!list.length) return;
    const g = el("optgroup");
    g.label = name;
    list.forEach(d => {
      const o = el("option", null, d.label + (d.sessions ? ` · ${d.sessions}` : ""));
      o.value = d.path;
      g.appendChild(o);
    });
    select.appendChild(g);
  });
  const last = rememberedDir();
  if (last && dirs.some(d => d.path === last)) select.value = last;
}

async function launchNewSession() {
  const cwd = $("#ns-dir").value;
  const prompt = $("#ns-prompt").value;
  if (!cwd) return;
  $("#ns-go").disabled = true;
  $("#ns-note").textContent = i18n("newsess.preparing");
  let r;
  try { r = await api("/api/new-session", { cwd, prompt }); }
  catch (e) {
    $("#ns-note").textContent = i18n("newsess.notStarted", { msg: e.message });
    $("#ns-go").disabled = false;
    return;
  }
  rememberDir(cwd);
  if (tellHost("new-session", { session_id: r.session_id, command: r.command, cwd: r.cwd,
                                title: r.title })) {
    $("#ns-prompt").value = "";
    $("#newsess").close();
    // The process and its file appear within a couple of seconds; then the session joins the grid.
    window.setTimeout(loadActive, 3000);
    window.setTimeout(loadActive, 8000);
    return;
  }
  // In a browser nobody can open a tab, so show a terminal command.
  $("#ns-note").textContent = i18n("newsess.outside");
  $("#ns-cmd").textContent = r.command;
  $("#ns-cmd").classList.remove("hidden");
  $("#ns-copy").classList.remove("hidden");
}

$("#ns-go").addEventListener("click", launchNewSession);
$("#ns-close").addEventListener("click", () => $("#newsess").close());
$("#ns-copy").addEventListener("click", () => navigator.clipboard.writeText($("#ns-cmd").textContent));
$("#ns-prompt").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launchNewSession(); }
});

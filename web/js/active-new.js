// Active: a new session in a chosen folder (folder-pick.js) with a first prompt, in an Obsidian terminal tab.
// Classic script: shares one global scope with the other page files.
/* exported newSessionButton, fillNewSessionAgents, hostAgents -- used by other page scripts */
const LAST_DIR_KEY = "atlas.newSessionDir";   // convenience only: where the last session started
const LAST_AGENT_KEY = "atlas.newSessionAgent";
// Agents enabled in the plugin (the "tabs" reply); null until the host has answered.
let hostAgents = null;

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

// The agent choice appears only when there is a choice: Codex is offered when the plugin has it on.
function fillNewSessionAgents() {
  const offered = AtlasLogic.newSessionAgents(hostAgents);
  let remembered = "";
  try { remembered = window.localStorage.getItem(LAST_AGENT_KEY) || ""; } catch { /* private window */ }
  const select = $("#ns-agent");
  select.replaceChildren(...offered.map(a => { const o = el("option", null, agentName(a)); o.value = a; return o; }));
  select.value = AtlasLogic.newSessionAgent(offered, remembered);
  $("#ns-agent-row").hidden = offered.length < 2;
}

async function openNewSession() {
  const dlg = $("#newsess");
  $("#ns-note").textContent = "";
  $("#ns-cmd").textContent = "";
  $("#ns-cmd").classList.add("hidden");
  $("#ns-copy").classList.add("hidden");
  $("#ns-go").disabled = false;
  fillNewSessionAgents();
  dlg.showModal();
  $("#ns-prompt").focus();
  try { await folderPickOpen(rememberedDir()); }
  catch (e) { $("#ns-note").textContent = i18n("newsess.dirsFailed", { msg: e.message }); }
}

async function launchNewSession() {
  const cwd = folderPickValue().trim();
  const prompt = $("#ns-prompt").value;
  const agent = AtlasLogic.newSessionAgent(AtlasLogic.newSessionAgents(hostAgents), $("#ns-agent").value);
  if (!cwd) { $("#ns-note").textContent = i18n("newsess.noFolder"); folderPickFocus(); return; }
  $("#ns-go").disabled = true;
  $("#ns-note").textContent = i18n("newsess.preparing");
  let r;
  try { r = await api("/api/new-session", { cwd, prompt, agent }); }
  catch (e) {
    $("#ns-note").textContent = i18n("newsess.notStarted", { msg: e.message });
    $("#ns-go").disabled = false;
    return;
  }
  rememberDir(r.cwd);
  try { window.localStorage.setItem(LAST_AGENT_KEY, agent); } catch { /* private window */ }
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
["#ns-prompt", "#ns-dir"].forEach(sel => $(sel).addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); launchNewSession(); }
}));

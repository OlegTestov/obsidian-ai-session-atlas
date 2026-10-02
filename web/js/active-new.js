// «Активные»: новая сессия — папка из списка и первый запрос, вкладка терминала в Obsidian.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
const LAST_DIR_KEY = "atlas.newSessionDir";   // только удобство: где запускал в прошлый раз

function newSessionButton() {
  const b = el("button", "chip newsess", i18n("newsess.button"));
  b.type = "button";
  b.title = i18n("newsess.button.hint");
  b.addEventListener("click", e => { e.stopPropagation(); openNewSession(); });
  return b;
}

function rememberedDir() {
  try { return localStorage.getItem(LAST_DIR_KEY) || ""; } catch (e) { return ""; }
}

function rememberDir(path) {
  try { localStorage.setItem(LAST_DIR_KEY, path); } catch (e) { /* приватное окно */ }
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
    // Процесс и его файл появляются за пару секунд — тогда сессия встанет в сетку.
    setTimeout(loadActive, 3000);
    setTimeout(loadActive, 8000);
    return;
  }
  // В браузере открыть вкладку некому — команда для терминала.
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

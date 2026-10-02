// «Активные»: после перезапуска Obsidian — вернуть сессии, что были открыты во вкладках.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// Список ведёт плагин: страница спрашивает его и открывает каждую через `claude --resume`.
let restorable = [];
let restorableReady = false;
let restoring = false;
const RESTORE_GAP_MS = 800;           // вкладки открываются по одной: Terminal не любит залпы

function requestRestorable() {
  if (hostReady && !restorableReady) tellTabHost("list-restorable", {});
}

function handleRestoreMessage(d) {
  if (d.type !== "restorable" || !Array.isArray(d.sessions)) return false;
  restorableReady = !!d.ready;
  restorable = d.sessions.filter(x => x && typeof x.session_id === "string");
  renderRestoreBanner();
  return true;
}

function renderRestoreBanner(note) {
  const box = $("#restore-banner");
  if (!restorable.length && !note) { box.classList.add("hidden"); box.replaceChildren(); return; }
  box.classList.remove("hidden");
  if (!restorable.length) { box.replaceChildren(el("span", null, note)); return; }
  const n = restorable.length;
  const names = restorable.slice(0, 4).map(x => i18n("active.quoted", { text: x.title || x.session_id.slice(0, 8) }))
    .join(", ") + (n > 4 ? i18n("active.restoreMore", { n: n - 4 }) : "");
  const text = el("span", null, n === 1
    ? i18n("active.restoreOne", { names })
    : i18nN("active.restoreMany", n, { names }));
  const go = el("button", "primary", n === 1 ? i18n("active.restore") : i18n("active.restoreAll"));
  go.type = "button";
  go.disabled = restoring;
  go.title = i18n("active.restoreHint");
  go.addEventListener("click", restoreAll);
  const skip = el("button", "ghost", i18n("active.restoreSkip"));
  skip.type = "button";
  skip.disabled = restoring;
  skip.addEventListener("click", () => {
    tellTabHost("forget-restorable", {});
    restorable = [];
    renderRestoreBanner();
  });
  box.replaceChildren(text, go, skip);
  if (note) box.appendChild(el("span", "note", note));
}

async function restoreAll() {
  if (restoring || !EMBEDDED) return;
  restoring = true;
  renderRestoreBanner(i18n("active.opening"));
  const done = [];
  const failed = [];
  for (const x of restorable.slice()) {
    try {
      const card = await api("/api/session/" + encodeURIComponent(x.session_id));
      const a = card.actions || {};
      if (!a.resume_command || !a.can_open_terminal) { failed.push(x.title || x.session_id); continue; }
      tellHost("resume", { session_id: x.session_id, cwd: a.resume_cwd, command: a.resume_command,
                           title: x.title || card.title || "Claude" });
      done.push(x.session_id);
      await new Promise(r => setTimeout(r, RESTORE_GAP_MS));
    } catch (e) {
      failed.push(x.title || x.session_id);
    }
  }
  restoring = false;
  tellTabHost("forget-restorable", { sessionIds: done });
  restorable = restorable.filter(x => !done.includes(x.session_id));
  renderRestoreBanner(failed.length
    ? i18n("active.restoreFailed", { names: failed.join(", ") })
    : i18n("active.restoreDone", { n: done.length }));
  setTimeout(loadActive, 4000);
  setTimeout(() => { if (!restorable.length) renderRestoreBanner(); }, 8000);
}

// --- перенос сессии из iTerm/VS Code во вкладку Obsidian ---
// Resume рядом с живым процессом дал бы два процесса над одним транскриптом: сервер сначала
// завершает сессию там, где она идёт, и только потом она открывается здесь.

function canMove(s, pid) {
  // Приложение неизвестно — может, это и есть Obsidian: не предлагаем завершать вслепую.
  return EMBEDDED && hostReady && !pid && !!s.host_app && s.host_app !== "Obsidian";
}

function moveButton(s, mini) {
  const b = el("button", "primary" + (mini ? " mini" : ""), i18n("active.move"));
  b.type = "button";
  b.title = i18n("active.moveHint", { app: s.host_app || i18n("active.otherTerminal") });
  b.addEventListener("click", e => { e.stopPropagation(); confirmMove(s); });
  return b;
}

function confirmMove(s) {
  const busy = ["busy", "background"].includes(s.activity || s.status);
  modal(i18n("active.moveTitle"),
    i18n(busy ? "active.moveBodyBusy" : "active.moveBody",
         { title: s.title || s.session_id, app: s.host_app || i18n("active.otherTerminal") }),
    "", i18n("active.move"), async () => {
      $("#m-ok").disabled = true;
      $("#m-note").textContent = i18n("active.moveEnding");
      let r;
      try { r = await api("/api/relocate", { session_id: s.session_id, pid: s.pid }); }
      catch (e) {
        $("#m-note").textContent = i18n("active.moveFailed", { msg: e.message });
        $("#m-ok").disabled = false;
        return;
      }
      if (!r.command) {
        $("#m-note").textContent = i18n("active.moveNoFolder");
        return;
      }
      tellHost("resume", { session_id: s.session_id, cwd: r.cwd, command: r.command,
                           title: s.title || "Claude" });
      $("#modal").close();
      setTimeout(loadActive, 3000);
      setTimeout(loadActive, 8000);
    });
  $("#m-copy").classList.add("hidden");
  $("#m-close").focus();
}

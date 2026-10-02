// «Активные»: недавно закрытые сессии — процесс завершён, а работа была за последние часы.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// Карточка пропадает вместе с процессом; отсюда сессию продолжают одной кнопкой.
const CLOSED_OPEN_KEY = "atlas.closedOpen";
let recentClosed = [];
let closedOpen = loadStored(CLOSED_OPEN_KEY, true);
const closedNotes = new Map();          // id сессии → {text, pending, at}: «открываю…» / почему не вышло

async function continueClosed(c) {
  closedNotes.set(c.session_id, { text: i18n("closed.opening"), pending: true, at: Date.now() });
  renderActive(null, true);
  try {
    const card = await api("/api/session/" + encodeURIComponent(c.session_id));
    const a = card.actions || {};
    if (!EMBEDDED || !a.resume_command || !a.can_open_terminal) {
      closedNotes.delete(c.session_id);
      showResume(card);                    // вне Obsidian или без папки — окно с командой
      renderActive(null, true);
      return;
    }
    tellHost("resume", { session_id: c.session_id, cwd: a.resume_cwd, command: a.resume_command,
                         title: c.title || card.title || "Claude" });
    setTimeout(loadActive, 4000);
  } catch (e) {
    closedNotes.set(c.session_id, { text: i18n("closed.failed", { msg: e.message }), pending: false, at: Date.now() });
    renderActive(null, true);
  }
}

function closedRow(c) {
  const row = el("div", "crow");
  const title = el("span", "ct", c.title || c.session_id.slice(0, 8));
  title.title = c.summary || c.title || "";
  const turns = c.human_turns == null ? null
    : i18nN("logic.turns", c.human_turns);
  const meta = [i18n("closed.closedAgo", { ago: ago(c.last_activity_at) }), turns,
                c.cost_usd != null ? "$" + Math.round(c.cost_usd) : null].filter(Boolean).join(" · ");
  const note = closedNotes.get(c.session_id);
  const info = el("span", "cm", (note && note.text) || meta);
  info.title = i18n("closed.lastMessage", { time: fmtDateTime(c.last_activity_at) })
    + (c.cwd_last ? i18n("closed.folder", { cwd: c.cwd_last }) : "");
  const go = el("button", "primary", i18n("closed.continue"));
  go.type = "button";
  go.title = i18n("closed.continue.hint");
  go.addEventListener("click", () => continueClosed(c));
  const find = el("button", null, i18n("closed.inSearch"));
  find.type = "button";
  find.title = i18n("closed.inSearch.hint");
  find.addEventListener("click", () => { setView("search"); openCard(c.session_id); });
  row.append(title, info, go, find);
  return row;
}

/** Секция внизу «Активных»; null — закрытых за последние часы нет. */
function closedSection() {
  const list = recentClosed;
  if (!list.length) return null;
  const sec = el("section", "asec closed" + (closedOpen ? "" : " folded"));
  const h = el("h3");
  const toggle = el("button", "fold", (closedOpen ? "▾ " : "▸ ") + i18n("closed.title"));
  toggle.type = "button";
  toggle.title = i18n("closed.title.hint");
  toggle.addEventListener("click", () => {
    closedOpen = !closedOpen;
    store(CLOSED_OPEN_KEY, closedOpen);
    renderActive(null, true);
  });
  h.append(toggle, el("span", "n", String(list.length)));
  sec.appendChild(h);
  if (closedOpen) {
    const box = el("div", "clist");
    list.forEach(c => box.appendChild(closedRow(c)));
    sec.appendChild(box);
  }
  return sec;
}

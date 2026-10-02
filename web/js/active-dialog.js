// «Активные»: диалог сессии (разрешение или вопрос) прямо в карточке.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// Текст диалога читает плагин с экрана вкладки: в транскрипте его ещё нет, пока диалог открыт.
const dialogs = new Map();            // id сессии → {dialog, reason}
const dialogAnswers = new Map();      // nonce → id сессии
const dialogNotes = new Map();        // id сессии → {note, cls}
const DIALOG_TIMEOUT_MS = 6000;

const isWaitingSession = s => (s.activity || s.status) === "waiting";

// Ждущим сессиям с вкладкой в Obsidian — прочитать диалог. Ответ придёт сообщением.
function requestDialogs() {
  const waiting = new Set();
  activeSessions.filter(isWaitingSession).forEach(s => {
    waiting.add(s.session_id);
    const pid = tabFor(s);
    if (pid) tellTabHost("read-dialog", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id });
  });
  [...dialogs.keys()].forEach(sid => { if (!waiting.has(sid)) dialogs.delete(sid); });
}

// Сообщения плагина о диалогах. true — сообщение разобрано здесь.
function handleDialogMessage(d) {
  if (d.type === "dialog" && typeof d.sessionId === "string") {
    dialogs.set(d.sessionId, { dialog: d.dialog || null, reason: d.reason || null });
    renderActive();
    return true;
  }
  if (d.type === "answered" && dialogAnswers.has(d.nonce)) {
    const sid = dialogAnswers.get(d.nonce);
    dialogAnswers.delete(d.nonce);
    if (d.ok) {
      dialogs.delete(sid);
      dialogNotes.set(sid, { note: i18n("active.answerSent"), cls: "ok" });
      setTimeout(() => { dialogNotes.delete(sid); loadActive(); }, 1500);
    } else {
      dialogNotes.set(sid, { note: i18n("active.notSent", { reason: d.reason || i18n("active.errorWord") }), cls: "bad" });
      requestDialogs();                   // экран мог смениться — перечитать
    }
    lastSignature = "";
    renderActive(null, true);
    return true;
  }
  return false;
}

function answerDialogOption(s, pid, option) {
  const nonce = Math.random().toString(36).slice(2);
  dialogAnswers.set(nonce, s.session_id);
  dialogNotes.set(s.session_id, { note: i18n("active.sending"), cls: "" });
  tellTabHost("answer-dialog", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id,
                                 option: option.n, text: option.text, nonce });
  lastSignature = "";
  renderActive(null, true);
  setTimeout(() => {
    if (!dialogAnswers.has(nonce)) return;
    dialogAnswers.delete(nonce);
    dialogNotes.set(s.session_id, { note: i18n("active.noHostReply"), cls: "bad" });
    renderActive(null, true);
  }, DIALOG_TIMEOUT_MS);
}

// Блок диалога в карточке. null — сессия не ждёт решения.
function dialogBlock(s, pid, full) {
  if (!isWaitingSession(s)) return null;
  // Ждёт из-за панели команды, чей ответ уже в карточке, — там и кнопка «Закрыть панель».
  const own = commandOutputs.get(s.session_id);
  if (own && own.panel) return null;
  const box = el("div", "dialog");
  const got = dialogs.get(s.session_id);
  const note = dialogNotes.get(s.session_id);
  const busy = [...dialogAnswers.values()].includes(s.session_id);
  if (!hostReady || !pid) {
    box.appendChild(el("div", "q", s.waiting_for === "permission prompt"
      ? i18n("active.permissionInTab")
      : i18n("active.questionInTab")));
    return box;
  }
  if (!got) {
    box.appendChild(el("div", "q dim", note ? note.note : i18n("active.readingDialog")));
    return box;
  }
  const d = got.dialog;
  if (!d) {
    box.appendChild(el("div", "q", got.reason || i18n("active.dialogNotRead")));
    return box;
  }
  if (d.kind === "plan") return planBlock(s, pid, d, full, busy, note, box);
  if (d.kind === "panel") {
    // Панель команды (/usage, /effort…). Если её ответ уже в карточке — там и кнопка закрыть.
    box.appendChild(el("div", "t", i18n("active.panelOpen", { title: d.title })));
    box.appendChild(el("pre", "det" + (full ? "" : " short"), full ? d.panel : d.title));
    const close = el("button", null, i18n("active.closePanel"));
    close.type = "button";
    close.addEventListener("click", e => { e.stopPropagation(); closePanel(s, pid); });
    const opts = el("div", "opts");
    opts.appendChild(close);
    box.appendChild(opts);
    return box;
  }
  const head = el("div", "t", d.kind === "permission" ? i18n("active.permission", { title: d.title }) : d.title);
  box.appendChild(head);
  if (d.details.length) {
    // Компактно — первая строка (команда или путь): без неё «Да» нажимать вслепую.
    const pre = el("pre", "det" + (full ? "" : " short"), full ? d.details.join("\n") : d.details[0]);
    pre.title = d.details.join("\n");
    box.appendChild(pre);
  }
  if (d.question && full) box.appendChild(el("div", "q", d.question));
  if (!d.answerable) {
    box.appendChild(el("div", "q dim", d.reason || i18n("active.dialogTabOnly")));
    return box;
  }
  const opts = el("div", "opts");
  d.options.forEach((o, i) => {
    // Сжимается только длинная подпись: «1. Yes» и «3. No» видны целиком всегда.
    const cls = [i === 0 ? "primary" : "", o.text.length > 18 ? "long" : ""].join(" ").trim();
    const b = el("button", cls || null, `${o.n}. ${o.text}`);
    b.type = "button";
    b.title = (o.detail ? o.detail + " · " : "") + i18n("active.pressesKey", { n: o.n });
    b.disabled = busy;
    b.addEventListener("click", () => answerDialogOption(s, pid, o));
    opts.appendChild(b);
    if (o.detail && full) opts.appendChild(el("span", "od", o.detail));
  });
  box.appendChild(opts);
  if (note) box.appendChild(el("div", "note " + (note.cls || ""), note.note));
  return box;
}

// --- «Стоп»: одно Esc во вкладку, как в терминале; только с подтверждением ---
const stopRequests = new Map();       // nonce → id сессии
const stopNotes = new Map();          // id сессии → текст

const canStop = s => ["busy", "waiting"].includes(s.activity || s.status);

function stopButton(s, pid, mini) {
  if (!canStop(s)) return null;
  const b = el("button", "stop" + (mini ? " mini" : ""), i18n("active.stop"));
  b.type = "button";
  b.disabled = !hostReady || !pid;
  b.title = b.disabled ? i18n("active.stopNeedsTab")
    : (s.activity || s.status) === "waiting" ? i18n("active.stopDialogHint")
    : i18n("active.stopStepHint");
  b.addEventListener("click", e => { e.stopPropagation(); confirmStop(s, pid); });
  return mini ? iconify(b, STOP_SVG, i18n("active.stop")) : b;
}

function confirmStop(s, pid) {
  const waiting = (s.activity || s.status) === "waiting";
  modal(waiting ? i18n("active.stopDialogTitle") : i18n("active.stopSessionTitle"),
    i18n(waiting ? "active.stopDialogBody" : "active.stopSessionBody", { title: s.title || s.session_id }),
    s.progress ? i18n("active.nowText", { text: s.progress }) : "",
    waiting ? i18n("active.closeDialog") : i18n("active.interrupt"), () => {
      $("#modal").close();
      const nonce = Math.random().toString(36).slice(2);
      stopRequests.set(nonce, s.session_id);
      stopNotes.set(s.session_id, i18n("active.stopping"));
      tellTabHost("interrupt", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id, nonce });
      lastSignature = "";
      renderActive(null, true);
    });
  $("#m-copy").classList.add("hidden");
  $("#m-close").focus();                // случайный Enter не должен прерывать
}

function handleStopMessage(d) {
  if (d.type !== "stopped" || !stopRequests.has(d.nonce)) return false;
  const sid = stopRequests.get(d.nonce);
  stopRequests.delete(d.nonce);
  stopNotes.set(sid, d.ok ? i18n("active.stopped")
    : i18n("active.notStopped", { reason: d.reason || i18n("active.errorWord") }));
  setTimeout(() => { stopNotes.delete(sid); lastSignature = ""; loadActive(); }, d.ok ? 1500 : 5000);
  lastSignature = "";
  renderActive(null, true);
  return true;
}

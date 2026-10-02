// «Активные»: быстрые команды Claude Code из поля ответа.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// /context, /usage и другие отвечают на экране вкладки, а не в транскрипте: плагин читает
// экран и присылает ответ — он показывается в карточке. /effort и /model без аргумента
// открыли бы во вкладке ползунок или список, поэтому выбор — кнопками прямо здесь.
const commandOutputs = new Map();     // id сессии → {command, text, panel, at}

// Выбор аргумента: значения — как их понимает сама команда (проверено на живом CLI).
const ARG_CHOICES = {
  "/effort": [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"],
              ["max", "max"]],
  // Алиасы: Claude Code сам подставит свежую модель семейства, и они есть на любом тарифе.
  "/model": [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["default", i18n("cmd.model.default")]],
};

function argChoices(text) {
  return ARG_CHOICES[(text || "").trim()] || null;
}

function handleCommandOutput(d) {
  if (d.type !== "command-output" || typeof d.sessionId !== "string") return false;
  commandOutputs.set(d.sessionId, { command: String(d.command || ""), text: String(d.text || ""),
                                    panel: !!d.panel, at: new Date().toISOString() });
  justSent.delete(d.sessionId);          // команда дошла: её ответ — на экране вкладки
  lastSignature = "";
  renderActive(null, true);
  return true;
}

// Закрыть открытую командой панель — то же одно Esc, что «Стоп», но без подтверждения:
// панель ничего не выполняет.
function closePanel(s, pid) {
  const nonce = Math.random().toString(36).slice(2);
  stopRequests.set(nonce, s.session_id);
  tellTabHost("interrupt", { ptyPid: pid, claudePid: s.pid, sessionId: s.session_id, nonce });
  const out = commandOutputs.get(s.session_id);
  if (out) out.panel = false;
  lastSignature = "";
  renderActive(null, true);
}

function commandOutputBlock(s, pid) {
  const out = commandOutputs.get(s.session_id);
  if (!out) return null;
  const box = el("div", "cmdout");
  const head = el("div", "who", i18n("cmd.output", { cmd: out.command, ago: ago(out.at) }));
  const waitingPanel = out.panel && (s.activity || s.status) === "waiting";
  if (waitingPanel && pid) {
    const close = el("button", null, i18n("cmd.closePanel"));
    close.type = "button";
    close.title = i18n("cmd.closePanel.hint");
    close.addEventListener("click", e => { e.stopPropagation(); closePanel(s, pid); });
    head.appendChild(close);
  }
  const dismiss = el("button", "ghost", "×");
  dismiss.type = "button";
  dismiss.title = i18n("cmd.dismiss.hint");
  dismiss.addEventListener("click", e => {
    e.stopPropagation();
    commandOutputs.delete(s.session_id);
    lastSignature = "";
    renderActive(null, true);
  });
  head.appendChild(dismiss);
  box.appendChild(head);
  box.appendChild(el("pre", null, out.text || i18n("cmd.noOutput")));
  return box;
}

// Кнопки выбора для «/effort» и «/model»; show(text) — перестроить под текущий текст поля.
function argChooser(area, submit) {
  const row = el("div", "argpick hidden");
  const show = text => {
    const choices = argChoices(text);
    row.classList.toggle("hidden", !choices);
    if (!choices) { row.replaceChildren(); return; }
    const cmd = text.trim();
    row.replaceChildren(el("span", "lbl", cmd === "/effort" ? i18n("cmd.effort") : i18n("cmd.model")),
      ...choices.map(([value, label]) => {
        const b = el("button", null, label);
        b.type = "button";
        b.title = i18n("cmd.choice.hint", { cmd, value });
        b.addEventListener("mousedown", e => e.preventDefault());   // фокус остаётся в поле
        b.addEventListener("click", () => { area.value = `${cmd} ${value}`; row.classList.add("hidden"); submit(); });
        return b;
      }));
  };
  return { row, show };
}

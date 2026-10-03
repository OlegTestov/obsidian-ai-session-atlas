// Active: quick Claude Code commands from the reply field.
// Classic script: shares one global scope with the other page files.
/* exported handleCommandOutput, commandOutputBlock, argChooser -- used by other page scripts */
// /context, /usage and others answer on the tab's screen, not in the transcript: the plugin reads
// the screen and sends the answer, which the card shows. /effort and /model without an argument
// would open a slider or a list in the tab, so buttons pick the value right here.
const commandOutputs = new Map();     // session id → {command, text, panel, at}

// Argument choice: values as the command itself understands them (checked on the live CLI).
const ARG_CHOICES = {
  "/effort": [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"],
              ["max", "max"]],
  // Aliases: Claude Code picks the latest model of the family, and they exist on every plan.
  "/model": [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["default", i18n("cmd.model.default")]],
};

function argChoices(text) {
  return ARG_CHOICES[(text || "").trim()] || null;
}

function handleCommandOutput(d) {
  if (d.type !== "command-output" || typeof d.sessionId !== "string") return false;
  commandOutputs.set(d.sessionId, { command: String(d.command || ""), text: String(d.text || ""),
                                    panel: !!d.panel, at: new Date().toISOString() });
  justSent.delete(d.sessionId);          // the command arrived: its answer is on the tab's screen
  lastSignature = "";
  renderActive(null, true);
  return true;
}

// Closing a panel a command opened is the same single Esc as Stop, but without confirmation:
// the panel runs nothing.
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

// Choice buttons for "/effort" and "/model"; show(text) rebuilds them for the field's current text.
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
        b.addEventListener("mousedown", e => e.preventDefault());   // focus stays in the field
        b.addEventListener("click", () => { area.value = `${cmd} ${value}`; row.classList.add("hidden"); submit(); });
        return b;
      }));
  };
  return { row, show };
}

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

/**
 * The picker for the field's text, or null: {cmd, label, items: [{text, label, hint}], optional}.
 * Claude Code: /effort, /model. Codex: /model lists its models (its own cache), "/model <slug>"
 * that model's efforts; the model alone may be sent as is (optional), Codex keeps it for the session.
 */
function argChoices(text, agent) {
  const t = (text || "").trim();
  if (agent !== "codex") {
    const choices = ARG_CHOICES[t];
    return choices ? { cmd: t, label: i18n(t === "/effort" ? "cmd.effort" : "cmd.model"),
                       items: choices.map(([value, label]) => ({ text: `${t} ${value}`, label,
                                                                 hint: i18n("cmd.choice.hint", { cmd: t, value }) })) }
      : null;
  }
  const models = codexModels();
  if (t === "/model" && models.length) {
    return { cmd: t, label: i18n("cmd.model"),
             items: models.map(m => ({ text: `/model ${m.slug}`, label: m.name, hint: i18n("cmd.codexModel.hint"),
                                       next: m.efforts.length > 0 })) };
  }
  const m = /^\/model (\S+)$/.exec(t);
  const model = m && models.find(x => x.slug === m[1]);
  if (!model || !model.efforts.length) return null;
  return { cmd: t, label: i18n("cmd.effort"), optional: true,
           items: model.efforts.map(e => ({ text: `${t} --reasoning=${e}`, label: e,
                                            hint: i18n("cmd.codexModel.hint") })) };
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

// Choice buttons for the agent's pickers; show(text) rebuilds them for the field's current text.
// A choice with `next` fills the field and shows the next step (a Codex model, then its effort).
function argChooser(area, submit, agent) {
  const row = el("div", "argpick hidden");
  const show = text => {
    const pick = argChoices(text, agent);
    row.classList.toggle("hidden", !pick);
    if (!pick) { row.replaceChildren(); return; }
    row.replaceChildren(el("span", "lbl", pick.label), ...pick.items.map(item => {
      const b = el("button", null, item.label);
      b.type = "button";
      b.title = item.hint;
      b.addEventListener("mousedown", e => e.preventDefault());   // focus stays in the field
      b.addEventListener("click", () => {
        area.value = item.text;
        if (item.next) { show(item.text); return; }
        row.classList.add("hidden");
        submit();
      });
      return b;
    }));
  };
  return { row, show };
}

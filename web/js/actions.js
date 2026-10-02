// Действия с сессией (восстановить, хендофф, описание) и справка.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// --- действия ---------------------------------------------------------------

function modal(title, note, body, okLabel, onOk) {
  $("#m-title").textContent = title;
  $("#m-note").textContent = note || "";
  $("#m-body").textContent = body || "";
  const ok = $("#m-ok");
  ok.textContent = okLabel || i18n("common.ok");
  ok.disabled = false;
  ok.classList.toggle("hidden", !onOk);
  ok.classList.remove("danger");
  ok.onclick = onOk || null;
  $("#m-copy").classList.remove("hidden");
  $("#m-copy").onclick = () => navigator.clipboard.writeText($("#m-body").textContent);
  $("#modal").showModal();
}

function showResume(s, fork) {
  const a = s.actions || {};
  const command = fork ? a.fork_command : a.resume_command;
  if (!command) {
    modal(i18n("card.resume"), i18n("actions.noCwd"), "");
    return;
  }
  const note = (fork ? i18n("actions.forkNote") : "")
    + (a.warnings || []).join(" ");
  const run = EMBEDDED
    ? () => {
        tellHost("resume", { session_id:s.session_id, cwd:a.resume_cwd, command,
                             title:s.title || s.session_id });
        $("#m-note").textContent = i18n("actions.openingTab");
      }
    : async () => {
        try {
          const r = await api("/api/terminal", { session_id:s.session_id, command });
          $("#m-note").textContent = r.message;
        } catch (e) { $("#m-note").textContent = i18n("common.failed", { msg: e.message }); }
      };
  modal(i18n(fork ? "card.exactFork" : "actions.resumeSession"), note, command,
    i18n(EMBEDDED ? "actions.openInObsidian" : "actions.openInTerminal"), run);
  if (!a.can_open_terminal) $("#m-ok").disabled = true;
}

// Две стадии: сначала показываем, что именно уйдёт наружу, и только потом зовём модель.
async function startArtifact(id, kind, thenLaunch) {
  let prev;
  try { prev = await api("/api/preview", { session_id:id, artifact_kind:kind }); }
  catch (e) { modal(i18n("common.errorTitle"), e.message, ""); return; }
  const where = prev.is_local_backend ? i18n("actions.localModel")
    : i18n("actions.externalModel", { model: prev.model });
  const mb = (prev.chars / 1e6).toFixed(2);
  const parts = (prev.sections || [])
    .map(x => `${x.title}: ${x.items}`).join(" · ");
  const note = i18n("actions.previewNote", { chars: prev.chars.toLocaleString(I18N.locale()), mb,
      k: Math.round(prev.chars / 4000), where, parts, sensitivity: prev.sensitivity })
    + (prev.truncated ? i18n("actions.truncated") : "")
    + (prev.full_path ? i18n("actions.fullPath", { path: prev.full_path }) : "");
  modal(i18n(kind === "handoff" ? "actions.handoffPreview" : "actions.summaryPreview"),
    note, prev.text, i18n("actions.confirmSend"), async () => {
      $("#m-ok").disabled = true;
      $("#m-note").textContent = i18n("actions.modelWorking");
      try {
        const job = await api("/api/job", { session_id:id, artifact_kind:kind, confirmed:true });
        await poll(job.job_id, id, kind, thenLaunch);
      } catch (e) {
        $("#m-note").textContent = i18n("common.error", { msg: e.message });
        $("#m-ok").disabled = false;
      }
    });
}

async function poll(jobId, id, kind, thenLaunch) {
  for (let i = 0; i < 200; i++) {
    const job = await api("/api/job/" + jobId);
    if (job.state === "done") {
      const result = JSON.parse(job.result);
      if (thenLaunch) return launch(id);
      modal(i18n(kind === "handoff" ? "actions.handoffReady" : "actions.summaryReady"),
            result.path ? i18n("actions.file", { path: result.path }) : "", readable(result.payload));
      openCard(id);
      return;
    }
    if (job.state === "failed") {
      $("#m-note").textContent = i18n("common.error", { msg: job.error }); $("#m-ok").disabled = false; return;
    }
    if (job.state === "cancel_requested") { $("#m-note").textContent = i18n("actions.cancelled"); return; }
    await new Promise(r => setTimeout(r, 2500));
  }
  $("#m-note").textContent = i18n("actions.tooLong");
}

function readable(payload) {
  try {
    const d = JSON.parse(payload);
    return i18n("actions.readable",
      { did: d.did, result: d.result, open: d.open || "—", outcome: d.work_outcome });
  } catch (_) { return payload; }
}

async function launch(id) {
  const r = await api("/api/launch", { session_id:id });
  const body = r.command || i18n("actions.noCwdLaunch", { path: r.handoff_path });
  if (EMBEDDED && r.command) {
    modal(i18n("actions.newFromThisTitle"), i18n("actions.compressed"), body,
      i18n("actions.openInObsidian"), () => {
        tellHost("new-session", { session_id:r.new_session_id, command:r.command, cwd:r.cwd,
                                  title:i18n("actions.newTabTitle", { id: id.slice(0, 8) }) });
        $("#m-note").textContent = i18n("actions.openingTab");
      });
    return;
  }
  modal(i18n("actions.newFromThisTitle"), i18n("actions.compressedCopy"), body);
}

// --- справка ---

// Пишется через DOM, а не разметкой в строке: на странице действует CSP и запрет innerHTML.
function buildHelp() {
  const box = $("#help-body");
  if (box.childElementCount) return;
  const h = (text) => box.appendChild(el("h4", null, text));
  const p = (text) => box.appendChild(el("p", null, text));
  const list = (items) => {
    const ul = el("ul");
    items.forEach(t => ul.appendChild(el("li", null, t)));
    box.appendChild(ul);
  };
  const table = (rows) => {
    const t = el("table");
    rows.forEach(([a, b]) => {
      const tr = el("tr");
      tr.appendChild(el("td", null, a));
      tr.appendChild(el("td", null, b));
      t.appendChild(tr);
    });
    box.appendChild(t);
  };

  const keys = (prefix, n) => Array.from({ length: n }, (_, i) => i18n(`${prefix}${i + 1}`));

  box.appendChild(el("h3", null, i18n("nav.helpTitle")));

  h(i18n("help.whatH"));
  p(i18n("help.whatP"));

  h(i18n("help.findH"));
  list(keys("help.find", 8));

  h(i18n("help.activeH"));
  list(keys("help.active", 14));

  h(i18n("help.cardH"));
  list(keys("help.card", 3));

  h(i18n("help.whichH"));
  table([
    [i18n("card.resume"), i18n("help.whichResume")],
    [i18n("card.newFromThis"), i18n("help.whichNew")],
    [i18n("help.whichHandoffBtn"), i18n("help.whichHandoff")],
    [i18n("help.whichSummaryBtn"), i18n("help.whichSummary")],
    [i18n("help.whichForkBtn"), i18n("help.whichFork")],
  ]);

  h(i18n("help.bottomH"));
  list(keys("help.bottom", 2));

  h(i18n("help.outH"));
  p(i18n("help.outP"));
}

// Удаление сессии: сначала список того, что исчезнет, потом одно явное подтверждение.
const DELETE_KINDS = [["transcript", "delete.kind.transcript"], ["subagents", "delete.kind.subagents"],
  ["file_history", "delete.kind.file_history"], ["session_env", "delete.kind.session_env"],
  ["tasks", "delete.kind.tasks"], ["todos", "delete.kind.todos"], ["handoff", "delete.kind.handoff"]];

function sizeText(bytes) {
  if (bytes < 1024) return i18n("delete.bytes", { n: bytes });
  if (bytes < 1024 * 1024) return i18n("delete.kb", { n: Math.round(bytes / 1024) });
  return i18n("delete.mb", { n: (bytes / 1024 / 1024).toFixed(1) });
}

async function deleteSession(s) {
  let plan;
  try { plan = await api("/api/delete/preview", { session_id: s.session_id }); }
  catch (e) { modal(i18n("common.errorTitle"), e.message, ""); return; }
  const title = i18n("delete.title", { title: s.title || s.session_id.slice(0, 8) });
  if (plan.running) { modal(title, i18n("delete.running"), ""); $("#m-copy").classList.add("hidden"); return; }
  const lines = DELETE_KINDS.flatMap(([kind, label]) => {
    const items = plan.items.filter(i => i.kind === kind);
    if (!items.length) return [];
    const files = items.reduce((n, i) => n + i.files, 0);
    const bytes = items.reduce((n, i) => n + i.bytes, 0);
    return [`• ${i18n(label)} — ${i18nN("delete.files", files)}, ${sizeText(bytes)}`];
  });
  if (plan.history_lines) lines.push("• " + i18nN("delete.history", plan.history_lines));
  if (plan.indexed) lines.push("• " + i18n("delete.catalog"));
  modal(title, i18n("delete.note", { size: sizeText(plan.bytes) }), lines.join("\n"),
    i18n("delete.confirm"), async () => {
      $("#m-ok").disabled = true;
      try {
        await api("/api/delete", { session_id: s.session_id, confirmed: true });
      } catch (e) {
        $("#m-note").textContent = i18n("common.error", { msg: e.message });
        $("#m-ok").disabled = false;
        return;
      }
      $("#modal").close();
      if (state.current === s.session_id) {
        state.current = null;
        writeHash();
        const body = el("div", null);
        body.id = "card-body";
        body.appendChild(el("p", "empty", i18n("delete.done")));
        $("#card").replaceChildren(body);
      }
      loadList(true);
    });
  $("#m-ok").classList.add("danger");
  $("#m-copy").classList.add("hidden");
  $("#m-close").focus();                 // случайный Enter закрывает окно, а не удаляет
}

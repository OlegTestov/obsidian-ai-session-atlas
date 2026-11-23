// Native OpenCode catalog actions. The host launches only commands checked by the server.
/* exported openCodeActionBar -- used by card.js */
const openCodeCopyRequests = new Map();
const openCodeCopyPending = new Set();

function openCodeInTab(data, title, request) {
  return new Promise(resolve => {
    const finish = ok => {
      window.removeEventListener("message", reply);
      window.clearTimeout(timer);
      resolve(ok);
    };
    const reply = event => {
      const result = event.data;
      if (event.source === window.parent && result?.source === HOST_SOURCE
          && result.type === "launch-result" && result.request === request) finish(result.ok === true);
    };
    const timer = window.setTimeout(() => finish(false), 17000);
    window.addEventListener("message", reply);
    tellHost("resume", { ...data, title, launchRequest: request });
  });
}

function openCodeSessionLines(rows) {
  return rows.map(row => `• ${row.title} (${row.session_id})`).join("\n");
}

async function openCodeLaunch(s, copy) {
  const key = s.session_id;
  const heading = i18n(copy ? "card.exactFork" : "actions.resumeSession");
  if (!copy) {
    try {
      const data = await api("/api/opencode/resume", { session_id: key });
      if (!EMBEDDED) modal(heading, "", data.command);
      else if (!await openCodeInTab(data, s.title, crypto.randomUUID())) modal(heading, i18n("opencode.openFailed"), "");
    } catch (e) { modal(heading, e.message, ""); }
    return;
  }

  const storage = "atlas.opencode.copy." + key;
  const savedRequest = () => openCodeCopyRequests.get(key) || loadStored(storage, null);
  const remember = value => {
    openCodeCopyRequests.set(key, value);
    store(storage, value);
  };
  const forget = requestId => {
    if (openCodeCopyRequests.get(key) === requestId) openCodeCopyRequests.delete(key);
    // Another catalog page may have saved a new request while this reply was pending.
    if (loadStored(storage, null) === requestId) store(storage, null);
  };
  const submit = (confirmation = null) => {
    return async () => {
      if (openCodeCopyPending.has(key)) return;
      openCodeCopyPending.add(key);
      const ok = $("#m-ok");
      const current = ok.onclick;
      const isCurrent = () => $("#modal").open && ok.onclick === current;
      const requestId = savedRequest() || crypto.randomUUID();
      ok.disabled = true;
      remember(requestId);
      try {
        const data = await api("/api/opencode/fork", { session_id: key, request_id: requestId,
          confirm_unknown: confirmation });
        if (data.status === "unknown") {
          forget(requestId);
          if (!isCurrent()) return;
          const candidates = data.candidates === null ? i18n("opencode.forkCandidatesUnavailable")
            : data.candidates.length ? openCodeSessionLines(data.candidates) : i18n("opencode.noForkCandidates");
          modal(heading, i18n("opencode.forkUncertain"), candidates,
            i18n(data.confirmation_id ? "opencode.createAnother" : "opencode.createCopy"),
            submit(data.confirmation_id));
          $("#m-copy").classList.add("hidden");
          $("#m-close").focus();
          return;
        }
        if (!isCurrent()) return;
        if (!EMBEDDED) {
          modal(heading, "", data.command);
          forget(requestId);
          return;
        }
        const title = i18n("opencode.copyOf", { title: s.title });
        if (await openCodeInTab(data, title, requestId)) {
          forget(requestId);
          if (isCurrent()) closeAfterHandOff();
        } else if (isCurrent()) {
          $("#m-note").textContent = i18n("opencode.copyRetry");
          ok.textContent = i18n("actions.openInObsidian");
          ok.onclick = submit();
          ok.disabled = false;
        }
      } catch (e) {
        const missing = e.state === "session_missing";
        if (missing) forget(requestId);
        if (isCurrent()) {
          $("#m-note").textContent = e.message;
          ok.disabled = false;
          if (missing) {
            ok.onclick = submit();
            ok.textContent = i18n("opencode.createCopy");
          }
        }
      } finally {
        openCodeCopyPending.delete(key);
      }
    };
  };
  const retry = Boolean(savedRequest());
  modal(heading, i18n(retry && EMBEDDED ? "opencode.copyRetry" : "opencode.copyNote"), "",
    i18n(retry && EMBEDDED ? "actions.openInObsidian" : "opencode.createCopy"), submit());
  $("#m-copy").classList.add("hidden");
}

async function openCodeArchive(s, button) {
  const archived = !s.actions?.archived;
  button.disabled = true;
  try {
    await api("/api/opencode/archive", { session_id: s.session_id, archived });
    if (state.current === s.session_id) {
      await openCard(s.session_id);
    }
    loadList(true);
  } catch (e) {
    modal(button.textContent, e.message, "");
  } finally { button.disabled = false; }
}

async function openCodeDelete(s) {
  const title = i18n("delete.title", { title: s.title || s.session_id });
  try {
    const plan = await api("/api/delete/preview", { session_id: s.session_id });
    if (plan.disabled_reason) {
      modal(title, plan.disabled_reason, "");
      $("#m-copy").classList.add("hidden");
      return;
    }
    const children = plan.children;
    const details = [
      plan.database && i18n("opencode.deleteDatabase", { path: plan.database }),
      children.length ? openCodeSessionLines(children) : i18n("opencode.noChildren"),
    ].filter(Boolean).join("\n\n");
    modal(title, i18n("opencode.deleteNote"), details, i18n("delete.confirm"), async () => {
      $("#m-ok").disabled = true;
      try {
        const result = await api("/api/delete", { session_id: s.session_id, confirmed: true,
          children: children.map(row => row.session_id), service_generation: plan.service_generation });
        const extras = result.extra_deleted || [];
        const notice = i18n(extras.length ? "opencode.deleteExtras" : "delete.done");
        $("#modal").close();
        if (state.current === s.session_id) {
          state.current = null;
          writeHash();
          $("#card").replaceChildren(el("p", "empty", notice));
        }
        loadList(true);
        if (extras.length) {
          modal(title, notice, openCodeSessionLines(extras));
          $("#m-copy").classList.add("hidden");
        }
      } catch (e) {
        $("#m-note").textContent = e.message;
        $("#m-ok").disabled = false;
      }
    });
    $("#m-ok").classList.add("danger");
    $("#m-copy").classList.add("hidden");
    $("#m-close").focus();
  } catch (e) { modal(title, e.message, ""); }
}

function openCodeActionBar(bar, s) {
  const makeButton = (key, cls, run, reason) => {
    const button = el("button", cls, i18n(key));
    button.title = reason || "";
    button.disabled = Boolean(reason);
    button.addEventListener("click", () => run(button));
    return button;
  };
  const resume = makeButton("card.resume", "primary", () => openCodeLaunch(s, false), s.actions?.resume_error);
  const fork = makeButton("card.exactFork", null, () => openCodeLaunch(s, true),
    s.actions?.empty ? i18n("opencode.emptyFork") : s.actions?.resume_error);
  const archive = makeButton(s.actions?.archived ? "opencode.unarchive" : "opencode.archive",
    null, button => openCodeArchive(s, button));
  const remove = makeButton("delete.menu", "danger", () => openCodeDelete(s));
  bar.append(resume, fork, archive, remove);
  const open = activeSessions.find(tab => tab.session_id === s.session_id);
  if (open) bar.append(makeButton("opencode.hide", null, () => hideCard(open)));
  remove.disabled = true;
  const refreshDelete = async () => {
    if (!bar.isConnected) return;
    if (!document.hidden && bar.getClientRects().length) {
      try {
        const plan = await api("/api/delete/preview", { session_id: s.session_id, passive: true });
        remove.disabled = Boolean(plan.disabled_reason);
        remove.title = plan.disabled_reason || "";
      } catch {
        // Clicking Delete still runs the full preview.
        remove.disabled = Boolean(remove.title);
      }
    }
    if (bar.isConnected) window.setTimeout(refreshDelete, 15000);
  };
  window.setTimeout(refreshDelete, 0);
  return bar;
}

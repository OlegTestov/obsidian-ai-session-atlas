// Active: after an Obsidian restart, bring back the sessions that were open in tabs; after the plugin
// was turned off and on, bring back tabs onto the agents that kept running (hostHeld).
// Classic script: shares one global scope with the other page files.
/* exported requestRestorable, handleRestoreMessage, canMove, moveButton -- used by other page scripts */
// The plugin keeps the list: the page asks it and opens each one through `claude --resume`.
let restorable = [];
let restorableReady = false;
let restoring = false;
const RESTORE_GAP_MS = 800;           // tabs open one by one: Terminal does not like bursts

function requestRestorable() {
  if (hostReady && !restorableReady) tellTabHost("list-restorable", {});
}

function handleRestoreMessage(d) {
  if (d.type !== "restorable" || !Array.isArray(d.sessions)) return false;
  restorableReady = !!d.ready;
  // Not ready: the plugin has not yet seen which sessions came back by themselves. Showing the list
  // then hid it a second later, with sessions still alive in it.
  restorable = restorableReady ? d.sessions.filter(x => x && typeof x.session_id === "string") : [];
  renderRestoreBanner();
  return true;
}

/** Tabs closed with the plugin while their agents run: open them on the same processes, or end them. */
function heldRow() {
  const held = [...hostHeld.entries()];
  if (!held.length) return null;
  const n = held.length;
  const pids = held.map(([pid]) => pid);
  const names = held.slice(0, 4).map(([, title]) => i18n("active.quoted", { text: title || "Terminal" }))
    .join(", ") + (n > 4 ? i18n("active.restoreMore", { n: n - 4 }) : "");
  const back = el("button", "primary", i18n(n === 1 ? "active.heldBack" : "active.heldBackAll"));
  back.type = "button";
  back.title = i18n("active.heldBackHint");
  const end = el("button", "ghost", i18n("active.heldEnd"));
  end.type = "button";
  end.title = i18n("active.heldEndHint");
  back.addEventListener("click", () => {
    back.disabled = end.disabled = true;
    tellTabHost("reattach-held", { ptyPids: pids });
    window.setTimeout(loadActive, 1500);
  });
  end.addEventListener("click", () => {
    modal(i18n("active.heldEndTitle"), i18nN("active.heldEndBody", n, { names }), "", i18n("active.heldEnd"), () => {
      tellTabHost("release-held", { ptyPids: pids });
      $("#modal").close();
      window.setTimeout(loadActive, 1500);
    });
    $("#m-copy").classList.add("hidden");
    $("#m-close").focus();
  });
  const row = el("div", "held-row");
  row.append(el("span", null, i18nN("active.heldMany", n, { names })), back, end);
  return row;
}

function renderRestoreBanner(note) {
  const box = $("#restore-banner");
  const held = heldRow();
  if (!restorable.length && !note && !held) { box.classList.add("hidden"); box.replaceChildren(); return; }
  box.classList.remove("hidden");
  if (!restorable.length) { box.replaceChildren(...[held, note ? el("span", null, note) : null].filter(Boolean)); return; }
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
  box.replaceChildren(...[held, text, go, skip].filter(Boolean));
  if (note) box.appendChild(el("span", "note", note));
}

async function restoreAll() {
  if (restoring || !EMBEDDED) return;
  restoring = true;
  renderRestoreBanner(i18n("active.opening"));
  const done = [];
  const failed = [];
  // A session whose process outlived Obsidian (an old tab's PTY left running) is alive somewhere:
  // a resume next to it would put two processes on one transcript. Its card offers Move instead.
  let alive = new Set();
  try {
    const now = await api(AtlasLogic.activeUrl(1, ""));
    alive = new Set((now.sessions || []).map(s => s.session_id));
  } catch { /* the server did not answer: each resume below fails on its own */ }
  const elsewhere = [];
  for (const x of restorable.slice()) {
    if (alive.has(x.session_id)) { elsewhere.push(x); continue; }
    try {
      const card = await api("/api/session/" + encodeURIComponent(x.session_id));
      const a = card.actions || {};
      if (!a.resume_command || !a.can_open_terminal) { failed.push(x.title || x.session_id); continue; }
      tellHost("resume", { session_id: x.session_id, cwd: a.resume_cwd, command: a.resume_command,
                           title: x.title || card.title || agentShort(card) });
      done.push(x.session_id);
      await new Promise(r => window.setTimeout(r, RESTORE_GAP_MS));
    } catch {
      failed.push(x.title || x.session_id);
    }
  }
  restoring = false;
  const settled = done.concat(elsewhere.map(x => x.session_id));
  tellTabHost("forget-restorable", { sessionIds: settled });
  restorable = restorable.filter(x => !settled.includes(x.session_id));
  const notes = [i18n("active.restoreDone", { n: done.length })];
  if (elsewhere.length) {
    notes.push(i18n("active.restoreElsewhere", { names: elsewhere.map(x => i18n("active.quoted",
      { text: x.title || x.session_id.slice(0, 8) })).join(", ") }));
  }
  if (failed.length) notes.push(i18n("active.restoreFailed", { names: failed.join(", ") }));
  renderRestoreBanner(notes.join(" · "));
  window.setTimeout(loadActive, 4000);
  window.setTimeout(() => { if (!restorable.length) renderRestoreBanner(); }, 8000);
}

// --- moving a session from iTerm/VS Code into an Obsidian tab ---
// Resume next to a live process would give two processes on one transcript: the server first
// ends the session where it runs, and only then it opens here.

function canMove(s, pid) {
  // Unknown app: it may be Obsidian itself, so ending it blindly is not offered.
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
                           title: s.title || agentShort(s) });
      $("#modal").close();
      window.setTimeout(loadActive, 3000);
      window.setTimeout(loadActive, 8000);
    });
  $("#m-copy").classList.add("hidden");
  $("#m-close").focus();
}

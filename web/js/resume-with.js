// "Resume with…" on the session card: continue the session in Claude Code or Codex.
// The session's own agent is the ordinary resume. The other agent gets a new session of its own that
// the server writes from this conversation (atlas/convert.py); it opens like any resume, in a tab.
// Classic script: shares one global scope with the other page files.
/* exported resumeWithButton, refreshResumeWith, closeResumeWith, lineageBlock, convertedBadge -- used by other page scripts */

(function (root) {
  const AGENTS = ["claude", "codex"];

  /**
   * Menu items. Inside Obsidian an agent the plugin has turned off is shown disabled (Claude Code is on
   * unless the plugin says otherwise, Codex only when it says so); outside there is no plugin to ask.
   * The session's own agent is always available: it is the ordinary resume.
   */
  function choices(own, host, embedded) {
    return AGENTS.map((agent) => {
      const on = !embedded || (agent === "claude" ? !(host && host.claude === false) : !!(host && host.codex === true));
      return { agent, own: agent === own, enabled: agent === own || on };
    });
  }

  /** Arrow keys move over enabled items only and wrap around; Home/End jump. -1: nothing to focus. */
  function menuStep(enabled, from, key) {
    const idx = enabled.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return -1;
    if (key === "Home") return idx[0];
    if (key === "End") return idx[idx.length - 1];
    const pos = idx.indexOf(from);
    if (key === "ArrowDown") return pos < 0 ? idx[0] : idx[(pos + 1) % idx.length];
    if (key === "ArrowUp") return pos < 0 ? idx[idx.length - 1] : idx[(pos - 1 + idx.length) % idx.length];
    return from;
  }

  root.ResumeWith = { choices, menuStep };
})(window);

let rwSession = null;          // the card whose menu is open

function rwMenu() { return document.getElementById("rw-menu"); }

function resumeWithButton(s) {
  const btn = el("button", null, i18n("rw.button"));
  btn.id = "rw-button";
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "rw-menu");
  const menu = el("div", "hidden");
  menu.id = "rw-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", i18n("rw.menuLabel"));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) openResumeWith(s, "Home", e.detail === 0);
    else closeResumeWith();
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    openResumeWith(s, e.key === "ArrowUp" ? "End" : "Home", true);
  });
  menu.addEventListener("keydown", menuKeys);
  return [btn, menu];
}

function openResumeWith(s, start, focus) {
  const menu = rwMenu(), btn = document.getElementById("rw-button");
  if (!menu || !btn) return;
  const other = document.getElementById("menu");
  if (other) other.classList.add("hidden");
  rwSession = s;
  fillResumeWith(s, menu);
  menu.classList.remove("hidden");
  // Under its button, but inside the bar on a narrow pane (CSSOM: allowed by the CSP).
  const room = btn.offsetParent ? btn.offsetParent.clientWidth - menu.offsetWidth - 8 : btn.offsetLeft;
  menu.style.left = Math.max(8, Math.min(btn.offsetLeft, room)) + "px";
  btn.setAttribute("aria-expanded", "true");
  // The plugin has not said yet which agents it has on: ask, the answer refreshes the menu.
  if (EMBEDDED && typeof hostAgents !== "undefined" && hostAgents === null) tellHost("list-tabs", {});
  if (focus) focusItem(start);
}

function closeResumeWith(refocus) {
  const menu = rwMenu(), btn = document.getElementById("rw-button");
  if (menu) menu.classList.add("hidden");
  if (btn) btn.setAttribute("aria-expanded", "false");
  if (refocus && btn) btn.focus();
}

/** The plugin's agent switches arrived: an open menu shows them at once. */
function refreshResumeWith() {
  const menu = rwMenu();
  if (!menu || menu.classList.contains("hidden") || !rwSession) return;
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.agent : null;
  fillResumeWith(rwSession, menu);
  const again = focused && menu.querySelector(`[data-agent="${focused}"]`);
  if (again && !again.disabled) again.focus();
}

function fillResumeWith(s, menu) {
  const host = typeof hostAgents === "undefined" ? null : hostAgents;
  menu.replaceChildren(...ResumeWith.choices(AtlasLogic.agentOf(s), host, EMBEDDED).map((c) => {
    const name = agentName(c.agent);
    const hint = c.own ? i18n("rw.own") : c.enabled ? i18n("rw.other") : i18n("rw.off", { agent: name });
    const item = el("button", "rw-item");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.dataset.agent = c.agent;
    item.append(el("span", "rw-name", name), el("span", "rw-hint", hint));
    if (!c.enabled) {
      item.disabled = true;
      item.setAttribute("aria-disabled", "true");
      item.title = hint;
    }
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      closeResumeWith();
      if (c.own) showResume(s);
      else confirmResumeWith(s, c.agent);
    });
    return item;
  }));
}

function menuItems() {
  const menu = rwMenu();
  return menu ? [...menu.querySelectorAll(".rw-item")] : [];
}

function focusItem(key) {
  const items = menuItems();
  const at = ResumeWith.menuStep(items.map((i) => !i.disabled), items.indexOf(document.activeElement), key);
  if (at >= 0) items[at].focus();
}

function menuKeys(e) {
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    focusItem(e.key);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeResumeWith(true);
  } else if (e.key === "Tab") {
    closeResumeWith();
  }
}

// Two steps, as for anything that writes: first what will be created and where, then the file.
async function confirmResumeWith(s, agent) {
  let plan;
  try { plan = await api("/api/resume-with/plan", { session_id: s.session_id, agent }); }
  catch (e) { modal(i18n("common.errorTitle"), e.message, ""); return; }
  const name = agentName(agent);
  const note = i18n("rw.note", { agent: name, from: agentName(AtlasLogic.agentOf(s)), n: plan.messages,
                                 k: Math.max(1, Math.round(plan.chars / 2100)) })
    + (plan.omitted ? i18n("rw.omitted") : "");
  modal(i18n("rw.title", { agent: name }), note, i18n("rw.folder", { folder: plan.folder }),
    i18n(EMBEDDED ? "rw.createOpen" : "rw.create"), async () => {
      $("#m-ok").disabled = true;
      $("#m-note").textContent = i18n("rw.creating");
      let r;
      try { r = await api("/api/resume-with", { session_id: s.session_id, agent, confirmed: true }); }
      catch (e) {
        $("#m-note").textContent = i18n("rw.failed", { msg: e.message });
        $("#m-ok").disabled = false;
        return;
      }
      $("#m-body").textContent = r.command;
      if (EMBEDDED) {
        tellHost("resume", { session_id: r.session_id, cwd: r.cwd, command: r.command,
                             title: r.title || s.title || r.session_id });
        closeAfterHandOff();
      } else {
        $("#m-note").textContent = i18n("rw.createdOutside", { agent: name });
        $("#m-ok").classList.add("hidden");
      }
      window.setTimeout(() => loadList(true), 1500);       // the copy joins the list, linked to this one
    });
}

// --- lineage: where a copy came from, where this session went on ---

function lineageBlock(s) {
  const from = s.converted_from, to = s.converted_to || [];
  if (!from && !to.length) return null;
  const box = el("p", "lineage");
  const link = (id, text) => {
    const b = el("button", "ghost linkish", text);
    b.type = "button";
    b.addEventListener("click", () => openCard(id));
    return b;
  };
  if (from) {
    box.append(el("span", null, i18n("rw.from", { agent: agentName(from.agent) }) + " "),
               link(from.session_id, from.title || from.session_id.slice(0, 8)));
  }
  if (to.length) {
    if (from) box.appendChild(el("br"));
    box.appendChild(el("span", null, i18n("rw.to") + " "));
    to.forEach((c, i) => {
      if (i) box.appendChild(document.createTextNode(", "));
      box.appendChild(link(c.session_id, `${agentName(c.agent)} · ${fmtDateTime(c.at)}`));
    });
  }
  return box;
}

function convertedBadge(s) {
  const from = s.converted_from;
  const b = el("span", "pill conv", i18n("rw.badge", { agent: agentName(from.agent) }));
  b.title = i18n("rw.badgeHint", { agent: agentName(from.agent), title: from.title || from.session_id });
  return b;
}

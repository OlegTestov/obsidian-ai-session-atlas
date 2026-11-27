// Saved boards are shared by Atlas windows. Which board is open belongs to the view's hash.
/* exported currentWorkspace, activeLayout, setWorkspaceFromHash, writeWorkspaceHash, syncWorkspaces, renderWorkspaceBar -- used by Active */
/* exported workspaceGrid, workspaceSessions, workspaceFor, chooseWorkspace, workspaceBoard, workspaceBoards, saveWorkspaces -- used by the grid and editor */
/* exported workspaceRef, workspaceSession, workspaceMove, workspacePendingChanged, workspaceNewSession -- used by the editor and session launch */
/* exported workspaceSlotOccupied -- shared by Active and the editor */
/* exported workspaceText, workspaceButton, workspaceSlotLabel, workspaceNotice, workspaceState -- shared with the editor */
const workspaceState = { revision: -1, boards: [], id: null };
const workspaceScroll = new Map();
const workspaceAliases = new Map();
const workspaceLaunches = new Map();
const WORKSPACE_LAUNCH_GRACE_MS = 60000;
let workspaceReservations = new Set();
let workspaceWrite = null;
let workspaceBarSignature = "";
let workspaceLoading = false;

const workspaceText = (key, vars) => i18n(`workspace.${key}`, vars);
const workspaceBoards = () => workspaceState.boards;
const workspaceBoard = id => workspaceBoards().find(board => board.id === id);
const currentWorkspace = () => workspaceBoard(workspaceState.id);
const activeLayout = () => {
  const board = currentWorkspace();
  return board ? { c: board.columns, r: board.rows } : layout[activeMode];
};

function setWorkspaceFromHash(params) {
  workspaceState.id = params.get("ws");
}

function writeWorkspaceHash(params) {
  if (workspaceState.id) params.set("ws", workspaceState.id);
}

function chooseWorkspace(id, focus = false) {
  if (id && !workspaceBoard(id)) return;
  const grid = $("#active-grid");
  if (id !== workspaceState.id) {
    workspaceScroll.set(workspaceState.id, grid.scrollTop);
    workspaceState.id = id;
    workspaceNotice("");
    writeHash();
    closeFilters();
    refreshLayoutButton();
    renderActive(null, true);
    grid.scrollTop = workspaceScroll.get(id) || 0;
  }
  if (focus) $("#workspace-tabs").querySelector('[aria-current="page"]')?.focus();
}

function applyWorkspaces(data) {
  if (!Number.isInteger(data.revision) || data.revision <= workspaceState.revision) return false;
  workspaceState.revision = data.revision;
  workspaceState.boards = data.boards;
  if (workspaceState.id && !currentWorkspace()) {
    workspaceState.id = null;
    writeHash();
  }
  refreshLayoutButton();
  return true;
}

async function syncWorkspaces() {
  if (workspaceLoading) return;
  workspaceLoading = true;
  try {
    if (applyWorkspaces(await api("/api/workspaces"))) renderActive(null, true);
    refreshWorkspaceEditor();
    await settleWorkspaceIdentities();
  } catch { /* keep the last known layout, and let Active's next poll retry */ }
  finally { workspaceLoading = false; }
}

/* exported refreshWorkspaceHost -- used when the terminal host sends new instance IDs */
function refreshWorkspaceHost(references) {
  workspaceReservations = new Set(Array.isArray(references) ? references : []);
  refreshWorkspaceEditor(true);
  void settleWorkspaceIdentities().catch(() => {});
}

async function saveWorkspaces(update, expected = workspaceState.revision) {
  if (workspaceWrite) throw new Error(workspaceText("saving"));
  if (expected !== workspaceState.revision || expected < 0) throw new Error(workspaceText("stale"));
  const previous = workspaceBoards();
  const boards = previous.map(board => ({ ...board, slots:[...board.slots] }));
  update(boards);
  const commit = async () => {
    try {
      const data = await api("/api/workspaces", { revision: expected, boards });
      applyWorkspaces(data);
      renderActive(null, true);
      return { previous, revision:data.revision };
    } catch (error) {
      if (error.status === 409) await syncWorkspaces();
      throw error;
    }
  };
  workspaceWrite = commit().finally(() => { workspaceWrite = null; });
  return workspaceWrite;
}

// A new tab has a stable managed instance before the agent supplies its own session ID.
function workspaceRef(session) {
  const instance = hostWorkspaceInstances.get(tabFor(session));
  return (session.pending || session.opencode_placeholder) && instance
    ? `atlas-tab:${instance}` : session.session_id;
}

function workspaceSession(reference, sessions = activeSessions) {
  if (!reference) return undefined;
  const id = workspaceAliases.get(reference) || reference;
  if (!id.startsWith("atlas-tab:")) return sessions.find(session => session.session_id === id);
  const instance = id.slice("atlas-tab:".length);
  return sessions.find(session => hostWorkspaceInstances.get(tabFor(session)) === instance);
}

function workspaceFor(reference, boards = workspaceBoards()) {
  for (const board of boards) {
    const index = board.slots.findIndex(id => id && (id === reference
      || workspaceRefForSlot(id) === reference));
    if (index >= 0) return { board, index };
  }
  return null;
}

function workspaceRefForSlot(id) {
  const session = workspaceSession(id);
  return session ? workspaceRef(session) : id;
}

function workspaceMove(boards, reference, boardId, index, swap) {
  const source = workspaceFor(reference, boards);
  const board = boards.find(item => item.id === boardId);
  const other = board?.slots[index];
  if (source) source.board.slots[source.index] = swap ? other : null;
  if (board) board.slots[index] = reference;
}

function workspacePendingChanged(before, after) {
  if (workspaceFor(before)) workspaceAliases.set(before, after);
}

async function settleWorkspaceIdentities() {
  if (workspaceWrite) return;
  const updates = new Map();
  for (const board of workspaceBoards()) for (const id of board.slots) {
    if (!id) continue;
    const session = workspaceSession(id);
    if (session && !session.pending && !session.opencode_placeholder && id !== session.session_id) {
      updates.set(id, session.session_id);
    }
  }
  if (!updates.size) return;
  await saveWorkspaces(boards => {
    const used = new Set(boards.flatMap(board => board.slots).filter(id => id && !updates.has(id)));
    for (const board of boards) board.slots = board.slots.map(id => {
      if (!updates.has(id)) return id;
      const real = updates.get(id);
      if (used.has(real)) return null;
      used.add(real);
      return real;
    });
  });
  for (const reference of updates.keys()) workspaceAliases.delete(reference);
}

function workspaceSlotOccupied(reference) {
  if (!reference) return false;
  const launchUntil = workspaceLaunches.get(reference);
  if (launchUntil && launchUntil <= Date.now()) workspaceLaunches.delete(reference);
  return workspaceLaunches.has(reference) || workspaceReservations.has(reference) || Boolean(workspaceSession(reference));
}

async function workspaceNewSession(boardId, sessionId, instance) {
  const reference = sessionId || (instance && `atlas-tab:${instance}`);
  if (!reference) {
    workspaceNotice(workspaceText("launchUnassigned"));
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    while (workspaceWrite) await workspaceWrite.catch(() => {});
    const board = workspaceBoard(boardId);
    if (!board) return;
    const free = board.slots.findIndex(id => !workspaceSlotOccupied(id));
    if (free < 0) { workspaceNotice(workspaceText("workspaceFull", {workspace:board.name})); return; }
    // Keep the position while the terminal is open but the first transcript is still on its way.
    const until = Date.now() + WORKSPACE_LAUNCH_GRACE_MS;
    workspaceLaunches.set(reference, until);
    window.setTimeout(() => {
      if (workspaceLaunches.get(reference) === until) workspaceLaunches.delete(reference);
    }, WORKSPACE_LAUNCH_GRACE_MS);
    try {
      await saveWorkspaces(boards => workspaceMove(boards, reference, boardId, free, false));
      return;
    } catch (error) {
      workspaceLaunches.delete(reference);
      if (attempt === 0 && error.status === 409) {
        try {
          if (applyWorkspaces(await api("/api/workspaces"))) {
            renderActive(null, true);
            refreshWorkspaceEditor();
          }
        }
        catch (refreshError) { workspaceNotice(refreshError.message); return; }
        continue;
      }
      workspaceNotice(error.message);
    }
  }
}

function workspaceSessions(board, visible) {
  return board.slots.map(id => workspaceSession(id, visible)).filter(Boolean);
}

function workspaceGrid(board, shown) {
  const grid = el("div", `agrid workspace-grid${activeMode === "full" ? " full" : ""} c${board.columns} r${board.rows}`);
  board.slots.forEach((reference, index) => {
    const session = workspaceSession(reference, shown);
    if (session) {
      const card = activeCard(session);
      card.dataset.workspaceSlot = String(index);
      grid.appendChild(card);
    } else {
      const slot = el("div", "workspace-empty");
      slot.dataset.workspaceSlot = String(index);
      const hidden = workspaceSession(reference);
      if (hidden) {
        slot.appendChild(workspaceButton("showHidden", () => unhideCard(hidden.session_id)));
      } else if (workspaceSlotOccupied(reference)) {
        slot.appendChild(el("span", "ws-meta", workspaceText("reserved")));
      } else {
        const add = workspaceButton("add", () => openWorkspaceManager({ boardId:board.id, index }));
        add.setAttribute("aria-label", workspaceText("addHere", { place:workspaceSlotLabel(board,index) }));
        slot.appendChild(add);
      }
      grid.appendChild(slot);
    }
  });
  return grid;
}

function workspaceSlotLabel(board, index) {
  return workspaceText("slot", {workspace:board.name,n:index + 1});
}

function workspaceButton(key, run, className) {
  const button = el("button", className, workspaceText(key));
  button.type = "button";
  button.addEventListener("click", run);
  return button;
}

function workspaceNotice(message) {
  $("#workspace-notice").textContent = message;
}

function workspaceDialog(label, contents) {
  const dialog = el("dialog", "workspace-popup");
  dialog.setAttribute("aria-label", label);
  const close = el("button", "ghost", i18n("common.close"));
  close.type = "button";
  close.addEventListener("click", () => dialog.close());
  dialog.append(el("h3", null, label), contents, close);
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  document.body.appendChild(dialog);
  dialog.showModal();
}

function renderWorkspaceBar() {
  const board = currentWorkspace();
  $("#active").classList.toggle("workspace-view", Boolean(board));
  const signature = JSON.stringify([workspaceState.revision, board?.id]);
  if (signature !== workspaceBarSignature) {
    workspaceBarSignature = signature;
    $(".ws-tab-menu:popover-open")?.hidePopover();
    const tabs = $("#workspace-tabs");
    const options = [{ id:null, name:workspaceText("all") }, ...workspaceBoards()];
    tabs.replaceChildren(...options.map(item => {
      const tab = workspaceButton("all", () => chooseWorkspace(item.id, true));
      tab.textContent = item.name;
      tab.title = item.name;
      if (item.id) bindWorkspaceTabMenu(tab, item);
      if (item.id === (board?.id || null)) tab.setAttribute("aria-current", "page");
      return tab;
    }));
    const create = workspaceButton("new", () => openWorkspaceEditor(null, {selectAfter:true}));
    const manage = workspaceButton("manage", () => openWorkspaceManager());
    create.disabled = manage.disabled = workspaceState.revision < 0;
    const attention = workspaceButton("attention", showWorkspaceAttention);
    attention.id = "workspace-attention";
    const history = workspaceButton("closed", () => {
      const list = el("div", "clist");
      recentClosed.forEach(session => list.appendChild(closedRow(session)));
      workspaceDialog(workspaceText("closed"), list);
    });
    history.id = "workspace-history";
    $("#workspace-actions").replaceChildren(create, manage, attention, history);
  }
  const count = workspaceWaiting().length;
  const attention = $("#workspace-attention");
  attention.hidden = !count;
  attention.textContent = `${workspaceText("attention")} · ${count}`;
  $("#workspace-history").hidden = !board || !recentClosed.length;
}

function workspaceWaiting() {
  return activeSessions.filter(s => (s.activity || s.status) === "waiting");
}

function showWorkspaceAttention() {
  const list = el("div", "workspace-attention");
  for (const session of workspaceWaiting()) {
    const button = workspaceButton("attention", () => {
      list.closest("dialog").close();
      jumpTo({kind:"live",id:session.session_id});
    });
    button.textContent = session.title || session.session_id;
    list.appendChild(button);
  }
  workspaceDialog(workspaceText("attention"), list);
}

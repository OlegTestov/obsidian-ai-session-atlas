// The workspace manager edits the same fixed slots rendered by Active.
/* exported openWorkspaceManager, openWorkspaceEditor, refreshWorkspaceEditor, workspaceFromGroup, bindWorkspaceTabMenu -- used by Active and the tab host */
let manager = null;
let workspaceGroupRequest = null;
const WORKSPACE_HISTORY_ARROW = [["path", {d:"M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2"}]];

function workspaceAction(label, run, className) {
  const button = el("button", className, label);
  button.type = "button";
  button.addEventListener("click", run);
  return button;
}

function workspaceModal(title, cls) {
  const dialog = el("dialog", cls);
  dialog.setAttribute("aria-label", title);
  const header = el("header", "ws-dialog-header");
  const close = workspaceAction("×", () => dialog.close(), "ghost ws-close");
  close.setAttribute("aria-label", i18n("common.close"));
  header.append(el("h3", null, title), close);
  dialog.append(header);
  document.body.appendChild(dialog);
  dialog.addEventListener("close", () => dialog.remove(), {once:true});
  return dialog;
}

function openWorkspaceManager(target = null) {
  if (manager?.dialog.open) return;
  const dialog = workspaceModal(workspaceText("title"), "ws-manager");
  const create = workspaceButton("new", () => openWorkspaceEditor(), "primary");
  dialog.querySelector("header").lastChild.before(create);
  const status = el("p", "ws-status");
  status.setAttribute("role", "status");
  const clear = workspaceButton("clearSelection", () => managerSelect(null));
  const undo = workspaceButton("undo", () => void stepWorkspaceHistory(false));
  const redo = workspaceButton("redo", () => void stepWorkspaceHistory(true));
  for (const button of [undo, redo]) {
    button.title = button.textContent;
    button.setAttribute("aria-label", button.textContent);
    button.replaceChildren(svgIcon(WORKSPACE_HISTORY_ARROW));
  }
  const history = el("div", "ws-history-actions");
  history.append(undo, redo);
  const bar = el("div", "ws-interaction");
  bar.append(status,clear,history);
  const filter = el("input");
  filter.type = "search";
  filter.placeholder = workspaceText("find");
  filter.setAttribute("aria-label", workspaceText("findUnassigned"));
  filter.addEventListener("input", drawWorkspacePool);
  const pool = el("section", "ws-pool");
  const poolHeader = el("header", "ws-board-header");
  const poolTitle = el("h4", null, workspaceText("unassigned"));
  poolTitle.id = "ws-unassigned";
  const count = el("span", "ws-meta");
  poolHeader.append(poolTitle,count);
  pool.setAttribute("aria-labelledby", poolTitle.id);
  const returnButton = workspaceButton("returnSession", () => void managerMove(manager.selection?.ref, null));
  returnButton.setAttribute("aria-label", workspaceText("returnUnassigned"));
  const sessions = el("div", "ws-unassigned");
  pool.append(poolHeader,returnButton,filter,sessions);
  const boards = el("div", "ws-board-list");
  const columns = el("div", "ws-columns");
  columns.append(pool,boards);
  dialog.append(bar,columns);
  manager = {dialog, status, filter, count, sessions, boards, returnButton, clear, undo, redo,
    selection:target, dragged:null, drop:null, signature:null, undoStack:[], redoStack:[],
    historyRevision:workspaceState.revision, busy:false};
  bindWorkspaceDrop(pool, () => void managerMove(manager.dragged, null), () => !!workspaceFor(manager.dragged));
  dialog.addEventListener("close", () => { if (manager?.dialog === dialog) manager = null; }, {once:true});
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !manager.selection || (event.target === filter && filter.value)) return;
    event.preventDefault();
    managerSelect(null);
  });
  refreshWorkspaceEditor();
  managerSelect(target);
  dialog.showModal();
  filter.focus();
}

const workspaceSessionTitle = session => session.pending
  ? i18n("active.pendingTitle", {agent:agentName(AtlasLogic.agentOf(session))}) : session.title || session.session_id;
const workspaceSessionDetail = session => [agentName(AtlasLogic.agentOf(session)), ...(session.projects || [])].join(" · ");

function refreshWorkspaceEditor(tabsUpdated = false) {
  if (tabsUpdated && workspaceGroupRequest) workspaceGroupRequest.waitForTabs = false;
  maybeOpenWorkspaceGroup();
  if (!manager) return;
  const signature = JSON.stringify([workspaceState.revision, workspaceBoards().map(board => board.slots.map(workspaceSlotOccupied)), activeSessions.map(s =>
    [s.session_id, s.title, s.projects, AtlasLogic.agentOf(s), workspaceRef(s)])]);
  if (signature === manager.signature || manager.dragged || manager.busy) return;
  manager.signature = signature;
  if (manager.historyRevision !== workspaceState.revision) {
    manager.undoStack.length = manager.redoStack.length = 0;
    manager.historyRevision = workspaceState.revision;
  }
  const focused = document.activeElement?.dataset.wsRef;
  drawWorkspacePool();
  drawWorkspaceBoards();
  paintWorkspaceSelection();
  if (focused) manager.dialog.querySelector(`[data-ws-ref="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
}

function drawWorkspacePool() {
  if (!manager) return;
  const query = manager.filter.value.trim().toLocaleLowerCase(I18N.lang());
  const unassigned = activeSessions.filter(s => !workspaceFor(workspaceRef(s)));
  const matches = unassigned.filter(s => `${workspaceSessionTitle(s)} ${workspaceSessionDetail(s)}`
    .toLocaleLowerCase(I18N.lang()).includes(query));
  manager.count.textContent = String(unassigned.length);
  manager.sessions.replaceChildren(...(matches.length ? matches.map(s => workspaceSessionButton(s)) :
    [el("p", "ws-meta", workspaceText(unassigned.length ? "nothingFound" : "allPlaced"))]));
  paintWorkspaceSelection();
}

function drawWorkspaceBoards() {
  manager.boards.replaceChildren(...workspaceBoards().map(board => {
    const section = el("section", "ws-board");
    section.dataset.board = board.id;
    const header = el("header", "ws-board-header");
    const name = el("div");
    const title = el("h4", null, board.name);
    title.id = `ws-board-${board.id}`;
    section.setAttribute("aria-labelledby", title.id);
    const used = board.slots.filter(workspaceSlotOccupied).length;
    name.append(title,el("p", "ws-meta", workspaceText("layout", {columns:board.columns, rows:board.rows, used, total:board.slots.length})));
    header.append(name,workspaceButton("settings", () => openWorkspaceEditor(board.id)));
    const slots = el("div", `ws-slots c${board.columns}`);
    board.slots.forEach((id,index) => {
      const session = workspaceSession(id);
      const reserved = !session && workspaceSlotOccupied(id);
      const slot = el("div", "ws-slot" + (session || reserved ? " occupied" : ""));
      slot.dataset.slot = String(index);
      const number = el("span", "ws-position", String(index + 1));
      number.setAttribute("aria-hidden", "true");
      if (reserved) {
        slot.append(number, el("span", "ws-meta", workspaceText("reserved")));
        slots.appendChild(slot);
        return;
      }
      const activate = () => managerActivate(board.id,index,session && workspaceRef(session));
      slot.append(number,session ? workspaceSessionButton(session,board.id,index)
        : workspaceButton("add", activate, "ws-add"));
      slot.addEventListener("click", e => { if (!e.target.closest("button")) activate(); });
      bindWorkspaceDrop(slot, () => void managerMove(manager.dragged,board.id,index));
      slots.appendChild(slot);
    });
    section.append(header,slots);
    return section;
  }));
}

function workspaceSessionButton(session, boardId, index) {
  const ref = workspaceRef(session);
  const title = workspaceSessionTitle(session);
  const detail = workspaceSessionDetail(session);
  const button = workspaceAction("", () => managerActivate(boardId,index,ref), "ws-item");
  const handle = el("span", "ws-handle", "⋮⋮");
  handle.setAttribute("aria-hidden", "true");
  button.append(el("span", "ws-title", title),el("small", null, detail),handle);
  button.title = title;
  button.setAttribute("aria-description", detail);
  button.dataset.wsRef = ref;
  button.draggable = true;
  button.addEventListener("dragstart", event => {
    managerSelect(null);
    manager.dragged = ref;
    event.dataTransfer.setData("text/plain", title);
    event.dataTransfer.effectAllowed = "move";
    button.classList.add("ws-dragged");
  });
  button.addEventListener("dragend", () => {
    button.classList.remove("ws-dragged");
    clearWorkspaceDrop();
    refreshWorkspaceEditor();
  });
  return button;
}

function bindWorkspaceDrop(target, run, allowed = () => true) {
  target.addEventListener("dragover", event => {
    if (!manager?.dragged || !allowed()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (manager.drop !== target) {
      manager.drop?.removeAttribute("data-drop");
      manager.drop = target;
      target.setAttribute("data-drop", "");
    }
  });
  target.addEventListener("dragleave", event => {
    if (manager?.drop === target && !target.contains(event.relatedTarget)) {
      target.removeAttribute("data-drop");
      manager.drop = null;
    }
  });
  target.addEventListener("drop", event => {
    if (!manager?.dragged || !allowed()) return;
    event.preventDefault();
    run();
    clearWorkspaceDrop();
  });
}

function clearWorkspaceDrop() {
  if (!manager) return;
  manager.drop?.removeAttribute("data-drop");
  manager.drop = manager.dragged = null;
}

function paintWorkspaceSelection() {
  if (!manager) return;
  const ref = manager.selection?.ref;
  for (const button of manager.dialog.querySelectorAll(".ws-item,.ws-add")) {
    const slot = button.closest(".ws-slot");
    const board = workspaceBoard(slot?.closest("[data-board]").dataset.board);
    const index = Number(slot?.dataset.slot);
    const place = board && workspaceSlotLabel(board,index);
    const occupied = button.dataset.wsRef;
    const destination = !!ref && !!slot && occupied !== ref;
    slot?.toggleAttribute("data-destination", destination);
    const selected = occupied ? occupied === ref
      : Boolean(board && board.id === manager.selection?.boardId && index === manager.selection?.index);
    slot?.toggleAttribute("data-selected", selected);
    if (destination) button.removeAttribute("aria-pressed");
    else button.setAttribute("aria-pressed", String(selected));
    if (occupied) {
      const session = workspaceSessionTitle(workspaceSession(occupied) || {session_id:occupied});
      button.setAttribute("aria-label", workspaceText(destination ? "placeOnOccupied" : "moveSession", {place,session}));
      const handle = button.querySelector(".ws-handle");
      handle.textContent = selected ? "✓" : "⋮⋮";
    } else {
      button.textContent = workspaceText(ref ? "slotFree" : "add");
      button.setAttribute("aria-label", workspaceText(ref ? "placeHere" : "addHere", {place}));
    }
  }
  manager.returnButton.hidden = !ref || !workspaceFor(ref);
  manager.clear.hidden = !manager.selection;
  manager.undo.disabled = !manager.undoStack.length || manager.busy;
  manager.redo.disabled = !manager.redoStack.length || manager.busy;
}

function managerSelect(selection) {
  if (!manager) return;
  const former = manager.selection;
  manager.selection = selection;
  paintWorkspaceSelection();
  const session = selection?.ref && workspaceSession(selection.ref);
  const board = selection?.boardId && workspaceBoard(selection.boardId);
  manager.status.textContent = session ? workspaceText(workspaceFor(selection.ref) ? "selectedAssigned" : "selectedSession",
    {session:workspaceSessionTitle(session)}) : board ? workspaceText("selectedSlot", {place:workspaceSlotLabel(board,selection.index)})
    : workspaceText("help");
  if (!selection && former?.ref) manager.dialog.querySelector(`[data-ws-ref="${CSS.escape(former.ref)}"]`)?.focus({preventScroll:true});
}

function managerActivate(boardId, index, ref) {
  if (manager.busy) return;
  const selected = manager.selection;
  if (ref && selected?.boardId) void managerMove(ref,selected.boardId,selected.index);
  else if (ref && selected?.ref === ref) managerSelect(null);
  else if (selected?.ref && boardId) void managerMove(selected.ref,boardId,index);
  else if (ref) managerSelect({ref});
  else managerSelect(selected?.boardId === boardId && selected.index === index ? null : {boardId,index});
}

async function managerMove(ref, boardId, index) {
  const session = ref && workspaceSession(ref);
  const board = workspaceBoard(boardId);
  const source = ref && workspaceFor(ref);
  if (!session || manager.busy || (!board && !source) || (board && source?.board.id === boardId && source.index === index)) return;
  const target = board && workspaceSession(board.slots[index]);
  if (!target && board && workspaceSlotOccupied(board.slots[index])) return;
  const expected = workspaceState.revision;
  const place = board ? workspaceSlotLabel(board,index) : workspaceText("unassigned");
  const title = workspaceSessionTitle(session);
  const apply = () => managerCommit(boards => workspaceMove(boards,ref,boardId,index,Boolean(source && target)),
    workspaceText(board ? "moved" : "removed", {session:title,place}),expected,ref);
  if (!target) { await apply(); return; }
  const from = source ? workspaceSlotLabel(source.board,source.index) : workspaceText("unassigned");
  const list = el("ul", "ws-transfer");
  list.append(el("li", null,workspaceText("preview",{session:title,place})),
    el("li", null,workspaceText("preview",{session:workspaceSessionTitle(target),place:from})));
  confirmWorkspaceAction(source ? "swapAsk" : "replaceAsk", list, source ? "swap" : "replace", apply);
}

async function managerCommit(update, message, expected, focus) {
  const context = manager;
  if (!context || context.busy) return false;
  context.busy = true;
  try {
    const {previous,revision} = await saveWorkspaces(update, expected);
    if (revision !== expected) {
      context.undoStack.push(previous);
      context.redoStack.length = 0;
    }
    context.historyRevision = revision;
    context.selection = null;
    context.status.textContent = message;
    return true;
  } catch (error) {
    context.status.textContent = error.message;
    return false;
  } finally {
    context.busy = false;
    refreshWorkspaceEditor();
    if (focus) context.dialog.querySelector(`[data-ws-ref="${CSS.escape(focus)}"]`)?.focus();
  }
}

async function stepWorkspaceHistory(redo) {
  const context = manager;
  if (!context || context.busy) return;
  const [from, to] = redo ? [context.redoStack, context.undoStack] : [context.undoStack, context.redoStack];
  const last = from.at(-1);
  if (!last) return;
  context.busy = true;
  try {
    const {previous,revision} = await saveWorkspaces(boards => boards.splice(0,boards.length,...last), context.historyRevision);
    from.pop();
    to.push(previous);
    context.historyRevision = revision;
    context.selection = null;
    context.status.textContent = workspaceText(redo ? "redone" : "undone");
  } catch (error) { context.status.textContent = error.message; }
  finally { context.busy = false; refreshWorkspaceEditor(); }
}

function confirmWorkspaceAction(question, contents, action, apply) {
  const dialog = workspaceModal(workspaceText(question), "ws-editor");
  const buttons = el("div", "ws-dialog-actions");
  const cancel = workspaceAction(i18n("common.cancel"), () => dialog.close());
  const proceed = workspaceButton(action, () => { dialog.close(); void apply(); }, "primary");
  buttons.append(cancel,proceed);
  dialog.append(contents,buttons);
  dialog.showModal();
  cancel.focus();
}

function confirmWorkspaceDeletion(board, {expected = workspaceState.revision, removed, failed} = {}) {
  const message = workspaceText("deleted", {workspace:board.name});
  confirmWorkspaceAction("deleteAsk", el("p", null, workspaceText("deleteHint", {workspace:board.name})),
    "delete", async () => {
      const update = boards => {
        const index = boards.findIndex(item => item.id === board.id);
        if (index < 0) throw new Error(workspaceText("stale"));
        boards.splice(index, 1);
      };
      try {
        if (manager) {
          if (!await managerCommit(update, message, expected)) return;
        } else {
          await saveWorkspaces(update, expected);
          workspaceNotice(message);
        }
        removed?.();
      } catch (error) {
        if (failed) failed(error);
        else workspaceNotice(error.message);
      }
    });
}

function bindWorkspaceTabMenu(tab, board) {
  tab.setAttribute("aria-haspopup", "menu");
  const open = event => {
    event.preventDefault();
    $(".ws-tab-menu:popover-open")?.hidePopover();
    tab.focus({preventScroll:true});
    const menu = el("div", "ws-tab-menu");
    menu.setAttribute("popover", "manual");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", board.name);
    menu.toggleAttribute("data-current-tab", tab.getAttribute("aria-current") === "page");
    const remove = workspaceButton("delete", () => {
      menu.hidePopover();
      confirmWorkspaceDeletion(board, {
        removed: () => $("#workspace-tabs [aria-current='page']")?.focus({preventScroll:true}),
      });
    });
    remove.setAttribute("role", "menuitem");
    menu.append(remove);
    const outside = new AbortController();
    document.addEventListener("pointerdown", click => {
      if (!menu.contains(click.target)) menu.hidePopover();
    }, {capture:true, signal:outside.signal});
    menu.addEventListener("keydown", key => {
      if (key.key !== "Escape" && key.key !== "Tab") return;
      if (key.key === "Escape") key.preventDefault();
      menu.hidePopover();
      tab.focus({preventScroll:true});
    });
    menu.addEventListener("toggle", event => {
      if (event.newState === "closed") {
        outside.abort();
        menu.remove();
      }
    });
    document.body.appendChild(menu);
    menu.showPopover();
    const {left,bottom} = tab.getBoundingClientRect();
    const x = event.type === "contextmenu" ? event.clientX : left;
    const y = event.type === "contextmenu" ? event.clientY : bottom;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
    remove.focus({preventScroll:true});
  };
  tab.addEventListener("contextmenu", open);
  tab.addEventListener("keydown", event => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event);
  });
}

function selectedGroupSessions(group, capacity) {
  const rows = el("fieldset", "ws-group-sessions");
  rows.appendChild(el("legend", null, workspaceText("groupSessions")));
  const entries = group?.sessions.map((session,index) => {
    const label = el("label");
    const input = el("input");
    input.type = "checkbox";
    input.checked = index < capacity;
    label.append(input,document.createTextNode(workspaceSessionTitle(session)));
    rows.appendChild(label);
    return { input, ref:workspaceRef(session) };
  }) || [];
  return { rows, entries };
}

function openWorkspaceEditor(id = null, { size, selectAfter = false, group } = {}) {
  const board = workspaceBoard(id);
  if (id && !board) return;
  const startingRevision = workspaceState.revision;
  const dialog = workspaceModal(workspaceText(board ? "edit" : "new"), "ws-editor");
  const form = el("form", "ws-editor-form");
  const label = el("label", "ws-label", workspaceText("name"));
  const name = el("input");
  name.required = true;
  name.maxLength = 80;
  name.value = board?.name || group?.name || "";
  label.appendChild(name);
  let gridSize = size || (board ? {c:board.columns,r:board.rows} : {c:3,r:2});
  const note = el("p", "ws-meta");
  note.setAttribute("role", "status");
  const save = el("button", "primary", board ? i18n("common.save") : workspaceText("create"));
  save.type = "submit";
  const {rows, entries} = selectedGroupSessions(group,gridSize.c * gridSize.r);
  const selected = () => entries.filter(entry => entry.input.checked).map(entry => entry.ref);
  const review = () => {
    const capacity = gridSize.c * gridSize.r;
    const removed = board?.slots.slice(capacity).map(id => workspaceSession(id)).filter(Boolean) || [];
    note.textContent = removed.length ? workspaceText("resizeReview", {sessions:removed.map(workspaceSessionTitle).join(", ")}) : "";
    if (group) note.textContent = workspaceText("groupCapacity", { selected:selected().length, capacity });
    save.disabled = selected().length > capacity;
  };
  const picker = buildLayoutGrid(value => { gridSize = value; picker.update(value); review(); });
  picker.update(gridSize);
  const choice = el("div", "ws-layout-choice");
  choice.append(el("h4", null,i18n("active.layoutAria")),picker.grid,picker.hint);
  const actions = el("div", "ws-dialog-actions");
  if (board) actions.appendChild(workspaceButton("delete", () => confirmWorkspaceDeletion(board, {
    expected:startingRevision, removed:() => dialog.close(), failed:error => { note.textContent = error.message; },
  }), "ghost ws-delete"));
  actions.append(workspaceAction(i18n("common.cancel"), () => dialog.close()),save);
  form.append(label,choice);
  if (entries.length) { form.appendChild(rows); rows.addEventListener("change", review); }
  form.append(note,actions);
  review();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const title = name.value.trim();
    if (!title || save.disabled) { name.focus(); return; }
    save.disabled = true;
    const key = id || crypto.randomUUID();
    const template = {id:key,name:title,columns:gridSize.c,rows:gridSize.r};
    const update = boards => {
      const target = boards.find(item => item.id === key) || {slots:[]};
      Object.assign(target,template,{slots:Array.from({length:gridSize.c * gridSize.r},(_,index) => target.slots[index] || null)});
      if (!id) boards.push(target);
      selected().forEach((ref,index) => workspaceMove(boards,ref,key,index,false));
    };
    try {
      const message = workspaceText(board ? "saved" : "created", {workspace:title});
      if (manager) { if (!await managerCommit(update,message,startingRevision)) { note.textContent = manager.status.textContent; return; } }
      else await saveWorkspaces(update,startingRevision);
      dialog.close();
      if (selectAfter) chooseWorkspace(key,true);
    } catch (error) { note.textContent = error.message; }
    finally { save.disabled = false; }
  });
  dialog.appendChild(form);
  dialog.showModal();
  name.focus();
  name.select();
}

function workspaceFromGroup(id, waitForTabs = false) {
  if (typeof id !== "string" || !id || id.length > 64) return;
  workspaceGroupRequest = {id,waitForTabs};
  maybeOpenWorkspaceGroup();
}

function maybeOpenWorkspaceGroup() {
  if (!workspaceGroupRequest || workspaceGroupRequest.waitForTabs || !hostReady || workspaceState.revision < 0 || !activeUpdated) return;
  const {id} = workspaceGroupRequest;
  workspaceGroupRequest = null;
  const sessions = activeSessions.filter(session => session.tab_group?.id === id)
    .sort((a,b) => a.tab_group.order - b.tab_group.order);
  const name = sessions[0]?.tab_group_label || "";
  openWorkspaceEditor(null, {selectAfter:true,group:{name,sessions}});
}

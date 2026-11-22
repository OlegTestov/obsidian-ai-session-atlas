// Active: the card, the last reply and the quick reply field.
// Classic script: shares one global scope with the other page files.
/* exported activeCard, decisionStrip, HIDE_SVG, STOP_SVG -- used by other page scripts */
/** The strip on top of a card whose session waits for a decision: what is asked, when known. */
function decisionStrip(s) {
  const got = dialogs.get(s.session_id);
  const title = got && got.dialog && got.dialog.title;
  const strip = el("div", "decide", "❓ " + i18n("active.decisionStrip") + (title ? " · " + title : ""));
  strip.setAttribute("role", "status");
  strip.title = s.waiting_for ? `${i18n("active.status.waitingHint")} (${s.waiting_for})` : i18n("active.status.waitingHint");
  return strip;
}

function activeCard(s) {
  if (s.agent === "opencode") return openCodeActiveCard(s);
  if (s.pending) return pendingActiveCard(s);
  const full = activeMode === "full";
  const act = s.activity || s.status;
  const card = el("article", "acard" + (act === "busy" ? " busy" : act === "background" ? " busy bg"
    : act === "waiting" ? " waiting" : ""));
  card.dataset.id = s.session_id;
  if (!AtlasLogic.findAgent(AtlasLogic.agentOf(s))) {
    card.append(el("div", "t", s.title || s.session_id), agentBadge(s));
    return card;
  }
  if (act === "waiting") card.appendChild(decisionStrip(s));
  const head = el("div", "head");
  head.appendChild(pinButton(s));
  const unread = unreadMark(s, card);
  if (unread) head.appendChild(unread);
  // The tab shows a Claude Code background job: the tab's own server icon, and "· background" by the status.
  const bgJob = hostBackground.get(tabFor(s)) || null;
  if (bgJob) {
    const icon = el("span", "bgico");
    icon.appendChild(svgIcon(SERVER_SVG));
    icon.title = i18n("active.bgSessionHint", { job: bgJob });
    head.appendChild(icon);
  }
  const title = el("div", "t", s.title || s.session_id);
  title.title = s.indexed ? i18n("active.openInSearch") : i18n("active.notIndexed");
  if (s.indexed) title.addEventListener("click", () => {
    setView("search"); openCard(s.session_id);
  });
  const status = STATUS[act] || STATUS.idle;
  const state = el("span", "state");
  const reasons = backgroundReasons(s.background);
  // After Stop and until the next poll, the status is the stop result, not the old "working".
  state.append(el("span", "dot"), document.createTextNode(stopNotes.get(s.session_id)
    || (act === "background" && !full ? i18n("active.status.backgroundShort") : status.label)));
  state.title = s.waiting_for ? `${status.hint} (${s.waiting_for})`
    : act === "background" ? `${status.hint}: ${reasons.join(", ")}` : status.hint;
  if (bgJob) {
    state.appendChild(el("span", "bgword", " · " + i18n("active.bgShort")));
    state.title += "\n" + i18n("active.bgSessionHint", { job: bgJob });
  }
  head.append(title, state);
  card.appendChild(head);

  const about = s.card_line || (s.last_prompt ? String(s.last_prompt).slice(0, 220) : "")
    || i18n("active.noDescription");
  const desc = el("div", "d", about);
  desc.title = about;
  card.appendChild(desc);
  const tasks = AtlasLogic.tasksSummary(s.tasks);
  if (tasks && full) card.appendChild(tasksLine(tasks));

  const tags = el("div", "tags");
  const pid = tabFor(s);
  const group = groupPill(s, pid);
  if (group) tags.appendChild(group);
  if (s.tab_group) card.classList.add("grouped", `g-${s.tab_group.color}`);
  tags.appendChild(agentBadge(s));
  if (tasks && !full) {                  // compact view has no room for a separate line: the label goes into the tags
    const pill = el("span", "pill task" + (tasks.finished ? " done" : ""),
                    (tasks.current ? "▶ " : "") + i18n("active.tasksPill", { count: tasks.count }));
    pill.title = (tasks.current ? i18n("active.tasksNow", { task: tasks.current }) + "\n\n" : "") + tasks.hint;
    tags.appendChild(pill);
  }
  if (s.background && s.background.goal) {
    const goal = el("span", "pill acc", "goal");
    goal.title = i18n("active.goalHint", { goal: s.background.goal });
    tags.appendChild(goal);
  }
  if (act === "background" && full) reasons.forEach(r => tags.appendChild(el("span", "pill acc", r)));
  const projects = s.projects || [];
  if (projects.length) tags.appendChild(el("span", "pill acc", projects[0]
    + (projects.length > 1 ? ` +${projects.length - 1}` : "")));
  if (s.topic && !/^(разное|misc)$/.test(s.topic)) tags.appendChild(el("span", "pill acc", s.topic));
  (s.domains || []).forEach(d => tags.appendChild(el("span", "pill", d)));
  if (s.sensitivity === "sensitive") tags.appendChild(el("span", "pill warn", i18n("active.sensitive")));
  (s.tickets || []).slice(0, 3).forEach(t => tags.appendChild(el("span", "pill", t)));
  wheelScroll(tags);
  card.appendChild(tags);

  const whenHint = i18n("active.whenHint", { start: fmtDateTime(s.started_at),
                                             last: fmtDateTime(s.last_message_at) });
  const turns = s.human_turns == null ? i18n("active.turnsNone")
    : i18nN("active.turns", s.human_turns);
  // Now ≈ is Claude Code's last total plus later replies priced by tokens; otherwise as of a date.
  const cost = AtlasLogic.costText(s, iso => fmtShort(iso).split(",")[0]);
  const claudeCost = () => (s.cost_usd != null
      ? i18n("active.costRecorded", { cost: s.cost_usd.toFixed(2), at: s.cost_recorded_at
          ? i18n("active.costRecordedAt", { date: fmtDateTime(s.cost_recorded_at) }) : "" })
      : i18n("active.costNotRecorded"))
    + (s.cost_now != null ? i18n("active.costNow", { cost: s.cost_now.toFixed(2) }) : "")
    + (s.cost_partial ? i18n("active.costPartial") : "");
  // Codex records no total: only the estimate from the thread's token count, if the price is known.
  const costs = {
    claude: claudeCost,
    codex: () => s.cost_now != null ? i18n("active.costCodex", { cost: s.cost_now.toFixed(2) })
      : i18n("active.costCodexNone"),
  };
  const costHint = AtlasLogic.requireAgent(AtlasLogic.agentOf(s), costs, "live cost")();

  const heldPid = pid ? null : heldFor(s);
  const [go, close] = tabButtons(s, pid, heldPid, s.title || s.session_id);

  if (full) {
    // Detailed: buttons in the header row, dates and money on one line to leave room for the reply.
    iconify(go, GO_SVG, i18n("active.go"));
    iconify(close, CLOSE_SVG, i18n("active.close"));
    const stopFull = stopButton(s, pid, true);
    if (stopFull) head.appendChild(stopFull);
    head.appendChild(cardViewPicker(s, pid));
    head.appendChild(hideButton(s, true));
    if (bgJob) head.appendChild(bringBackButton(bgJob, true));
    head.append(canMove(s, pid || heldPid) ? moveButton(s, true) : go, close);
    const parts = AtlasLogic.infoParts(s, ago, shortStart);
    const info = infoLine("info", [...parts.when, ...parts.nums], parts.context);
    info.title = `${whenHint}. ${turns} · ${cost}. ${costHint}`;
    // The dialog sits right on the reply field, so it rises with the field as it grows.
    const dialog = dialogBlock(s, pid, true);
    card.append(info);
    const cmdOut = commandOutputBlock(s, pid);
    if (cmdOut) card.appendChild(cmdOut);
    card.appendChild(el("div", "card-view-slot"));
    if (dialog) {
      card.classList.add("has-dialog");
      card.appendChild(dialog);
    }
    card.appendChild(freeAnswerForm(s, pid) || answerForm(s, pid));
    return card;
  }
  const parts = AtlasLogic.infoParts(s, ago, shortStart);
  const when = infoLine("when", parts.when, null);
  when.title = whenHint;
  const nums = infoLine("nums", parts.nums, parts.context);
  nums.title = `${turns} · ${cost}. ${costHint}`;
  const foot = el("div", "foot");
  const stopCompact = stopButton(s, pid, false);
  if (stopCompact) foot.appendChild(stopCompact);
  foot.appendChild(hideButton(s, false));
  if (bgJob) foot.classList.add("bgfoot");              // fitBringBack: icon only when the row does not fit
  foot.append(canMove(s, pid || heldPid) ? moveButton(s, false) : go, close);
  if (bgJob) foot.appendChild(bringBackButton(bgJob, false));
  card.append(when, nums);
  const dialog = dialogBlock(s, pid, false);
  if (dialog) {
    card.classList.add("has-dialog");      // compact: the description and tags give their room to the dialog
    card.appendChild(dialog);
  }
  card.appendChild(foot);
  return card;
}

function openCodeActiveCard(s) {
  const card = el("article", "acard opencode-tab");
  card.dataset.id = s.session_id;
  const title = el("div", "t", s.title);
  const folder = el("div", "d", s.cwd || "");
  folder.title = s.cwd || "";
  const tags = el("div", "tags");
  tags.appendChild(agentBadge(s));
  const foot = el("div", "foot");
  foot.append(...tabButtons(s, tabFor(s), null, s.title));
  card.append(title, folder, tags, foot);
  return card;
}

function tabButtons(s, pid, heldPid, title) {
  const go = el("button", "primary", i18n("active.go"));
  const close = el("button", null, i18n("active.close"));
  go.title = i18n("active.goHint");
  close.title = i18n("active.closeHint");
  go.disabled = close.disabled = !pid;
  if (!pid) go.title = close.title = hostReady
    ? (s.host_app ? i18n("active.notInTabApp", { app: s.host_app }) : i18n("active.notInTab"))
    : i18n("active.buttonsInObsidian");
  if (heldPid) {
    go.disabled = false;
    go.title = i18n("active.heldGoHint");
  }
  if (pid || heldPid) go.addEventListener("click", () => {
    tellTabHost("focus-tab", { ptyPid: pid || heldPid });
    if (heldPid) window.setTimeout(loadActive, 1500);
  });
  if (pid) close.addEventListener("click", () => {
    // Obsidian shows the same confirmation as the tab's close button.
    tellTabHost("close-tab", { ptyPid: pid, title });
    window.setTimeout(loadActive, 1500);
  });
  return [go, close];
}

function pendingActiveCard(s) {
  const card = el("article", "acard pending");
  card.dataset.id = s.session_id;
  const pid = tabFor(s);
  const heldPid = pid ? null : heldFor(s);
  const title = i18n("active.pendingTitle", { agent: agentName(s.agent) });
  const head = el("div", "head");
  const status = el("span", "state");
  status.append(el("span", "dot"), i18n("active.pendingStatus"));
  head.append(el("div", "t", title), status);
  card.appendChild(head);
  if (s.cwd) {
    const folder = el("div", "d", s.cwd);
    folder.title = s.cwd;
    card.appendChild(folder);
  }
  const tags = el("div", "tags");
  tags.appendChild(agentBadge(s));
  const full = activeMode === "full";
  card.append(tags, infoLine(full ? "info" : "when", [shortStart(s.started_at)].filter(Boolean), null));
  const [go, close] = tabButtons(s, pid, heldPid, title);
  if (full) {
    if (hostInlineTabs.has(pid)) {
      const open = cardViewMode(s.session_id) === "terminal";
      const terminal = el("button", "mini", i18n("feed.view.terminal"));
      terminal.setAttribute("aria-pressed", String(open));
      terminal.addEventListener("click", () => {
        if (open) cardViews.delete(s.session_id);
        else cardViews.set(s.session_id, "terminal");
        renderActive(null, true);
        if (!open) cardPanels.get(s.session_id)?.focus();
      });
      head.appendChild(terminal);
      if (open) card.appendChild(el("div", "card-view-slot"));
    }
    if (pid || heldPid) head.appendChild(iconify(go, GO_SVG, i18n("active.go")));
    if (pid) {
      head.appendChild(iconify(close, CLOSE_SVG, i18n("active.close")));
      card.appendChild(answerForm(s, pid));
    }
  } else if (pid || heldPid) {
    const foot = el("div", "foot");
    foot.appendChild(go);
    if (pid) foot.appendChild(close);
    card.appendChild(foot);
  }
  return card;
}

// Detailed: a progress bar, "3/7" and what the agent is working on right now.
function tasksLine(t) {
  const line = el("div", "tasks" + (t.finished ? " done" : ""));
  const bar = el("span", "tbar");
  const fill = el("span", "tfill");
  fill.style.width = t.pct + "%";
  bar.appendChild(fill);
  line.append(bar, el("b", null, t.count),
              el("span", "tcur", t.current || (t.finished ? i18n("active.tasksAllDone") : i18n("active.tasksNotStarted"))));
  line.title = t.hint;
  return line;
}

// "26.08 16:36": no comma and no current year, so the card line fits.
const shortStart = iso => (iso ? fmtShort(iso).replace(",", "") : "");

// Parts joined with " · "; the context is a separate coloured piece. If it does not fit, it scrolls with the wheel.
function infoLine(cls, texts, context) {
  const line = el("div", cls + " hscroll", texts.join(" · "));
  if (context) {
    const span = el("span", "ctx " + context.tone, context.text);
    span.title = context.hint;
    line.append(document.createTextNode(texts.length ? " · " : ""), span);
  }
  wheelScroll(line);
  return line;
}

// The mouse wheel over a line that does not fit scrolls it sideways, without a scrollbar.
function wheelScroll(node) {
  node.addEventListener("wheel", e => {
    if (node.scrollWidth <= node.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    node.scrollLeft += e.deltaY;
  }, { passive: false });
}

const STATUS = {
  busy: { label: i18n("active.status.busy"), hint: i18n("active.status.busyHint") },
  background: { label: i18n("active.status.background"),
                hint: i18n("active.status.backgroundHint") },
  waiting: { label: i18n("active.status.waiting"),
             hint: i18n("active.status.waitingHint") },
  idle: { label: i18n("active.status.idle"), hint: i18n("active.status.idleHint") },
};

// Your last message if Claude has not answered it yet: from the transcript or just
// sent from the card (the transcript catches up in a few seconds).
function unansweredPrompt(s) {
  const found = AtlasLogic.unansweredPrompt(s, justSent.get(s.session_id));
  if (found.dropSent) justSent.delete(s.session_id);   // the transcript caught up or Claude answered
  return found.prompt;
}

const DELIVERY_TEXT = {
  sending: i18n("active.delivery.sending"),
  queued: i18n("active.delivery.queued"),
  lost: i18n("active.delivery.lost"),
};

// Typed in the tab while the agent was working: waits for its turn in the agent's queue.
function queuedLine(s, box, shown) {
  const queued = AtlasLogic.queuedNotShown(s, shown);
  if (!queued.length) return;
  const first = queued[0].text.replace(/\s+/g, " ").slice(0, 80);
  const q = el("div", "queued", queued.length > 1
    ? i18n("active.queuedMany", { n: queued.length, text: first }) : i18n("active.queuedOne", { text: first }));
  q.title = queued.map(x => x.text).join("\n—\n");
  box.appendChild(q);
}

const GO_SVG = [["path", { d: "M14 4h6v6" }], ["path", { d: "M20 4 11 13" }],
                ["path", { d: "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }]];
const CLOSE_SVG = [["path", { d: "M6 6l12 12M18 6 6 18" }]];
const HIDE_SVG = [["path", { d: "M5 12h14" }]];
const STOP_SVG = [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 1 }]];
const SERVER_SVG = [["rect", { x: 2, y: 2, width: 20, height: 8, rx: 2 }], ["rect", { x: 2, y: 14, width: 20, height: 8, rx: 2 }],
                    ["path", { d: "M6 6h.01M6 18h.01" }]];

// Icon button in the detailed card header: space is tight, the label goes into the tooltip.
function iconify(button, parts, label) {
  button.replaceChildren(svgIcon(parts));
  button.classList.add("hico");
  button.setAttribute("aria-label", label);
  return button;
}

const PLANE_SVG = [["path", { d: "M22 2 11 13" }], ["path", { d: "M22 2 15 22 11 13 2 9z" }]];
const CLIP_SVG = [["path", { d: "M21.4 11 12.2 20.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7"
  + "l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" }]];

function svgIcon(parts) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  parts.forEach(([tag, attrs]) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    svg.appendChild(node);
  });
  return svg;
}

// A single-line field that grows up to six lines while typing.
const MAX_ROWS = 6;
function autosize(area) {
  area.rows = 1;
  while (area.scrollHeight > area.clientHeight + 1 && area.rows < MAX_ROWS) area.rows += 1;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// An image goes to the server as a file; the plugin pastes its path into the terminal and Claude Code
// turns it into an [Image #N] attachment.
async function attachImages(sid, files) {
  const list = attachments.get(sid) || [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (list.length >= MAX_ATTACH) { setSendNote(sid, i18n("active.maxImages", { n: MAX_ATTACH }), "bad"); break; }
    try {
      const thumb = await readAsDataURL(file);
      const saved = await api("/api/upload", { data: thumb });
      list.push({ path: saved.path, thumb });
    } catch (e) {
      setSendNote(sid, i18n("active.imageFailed", { msg: e.message }), "bad");
    }
  }
  attachments.set(sid, list);
  renderThumbs(sid);
}

function renderThumbs(sid) {
  document.querySelectorAll(`.thumbs[data-id="${CSS.escape(sid)}"]`).forEach(box => thumbsInto(box, sid));
}

function thumbsInto(box, sid) {
  box.replaceChildren();
  (attachments.get(sid) || []).forEach((a, i) => {
    const th = el("div", "th");
    const img = el("img");
    img.src = a.thumb;
    img.alt = i18n("active.imageAlt", { n: i + 1 });
    const drop = el("button", null, "✕");
    drop.title = i18n("active.removeImage");
    drop.addEventListener("click", () => {
      attachments.get(sid).splice(i, 1);
      renderThumbs(sid);
    });
    th.append(img, drop);
    box.appendChild(th);
  });
}

function answerForm(s, pid) {
  const sid = s.session_id;
  const form = el("div", "answer");
  const thumbs = el("div", "thumbs");
  thumbs.dataset.id = sid;
  const area = el("textarea");
  area.rows = 1;
  area.dataset.id = sid;
  area.value = drafts.get(sid) || "";
  area.setAttribute("aria-label", i18n("active.replyAria"));
  const send = el("button", "icon send");
  send.appendChild(svgIcon(PLANE_SVG));
  send.title = i18n("active.sendHint");
  send.setAttribute("aria-label", i18n("active.send"));
  const clip = el("button", "icon clip");
  clip.appendChild(svgIcon(CLIP_SVG));
  clip.title = i18n("active.attachHint");
  clip.setAttribute("aria-label", i18n("active.attach"));
  const picker = el("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/gif,image/webp";
  picker.multiple = true;
  picker.className = "hidden";
  const note = el("div", "note");
  const blocked = !hostReady ? i18n("active.blockedNoHost")
    : !pid ? i18n("active.blockedNoTab")
    : s.status === "waiting" ? i18n("active.blockedDialog")
    : null;
  area.disabled = send.disabled = clip.disabled = !!blocked;
  area.placeholder = blocked || (s.activity === "busy" || s.status === "busy"
    ? i18n("active.placeholderBusy")
    : s.activity === "background" ? i18n("active.placeholderBackground")
    : i18n("active.placeholder"));
  const st = sendState.get(sid);
  if (st) { note.textContent = st.note; if (st.cls) note.classList.add(st.cls); }

  area.addEventListener("input", () => {
    drafts.set(sid, area.value);
    autosize(area);
  });
  area.addEventListener("paste", e => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])]
      .filter(f => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); attachImages(sid, files); }
  });
  area.addEventListener("dragover", e => { e.preventDefault(); form.classList.add("drop"); });
  area.addEventListener("dragleave", () => form.classList.remove("drop"));
  area.addEventListener("drop", e => {
    e.preventDefault();
    form.classList.remove("drop");
    attachImages(sid, [...(e.dataTransfer ? e.dataTransfer.files : [])]);
  });
  clip.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { attachImages(sid, [...picker.files]); picker.value = ""; });

  const controls = agentControls(s);
  if (controls.commands && controls.agent === "codex") ensureCommands("codex"); // its /model picker needs the models
  const submit = () => {
    const text = area.value;
    // "/effort" and "/model" without an argument would open a picker in the tab, so buttons pick here.
    const pick = controls.commands && argChoices(text, controls.agent);
    if (pick && !pick.optional) { chooser.show(text); return; }
    const images = (attachments.get(sid) || []).map(a => a.path);
    if ((!text.trim() && !images.length) || send.disabled) return;
    const nonce = Math.random().toString(36).slice(2);
    pendingSends.set(nonce, sid);
    sentDrafts.set(nonce, { text, images: images.length, pending: s.pending });
    setSendNote(sid, i18n("active.sending"), "");
    commandOutputs.delete(sid);                 // a new reply replaces the previous one
    tellTabHost("send-text", { ptyPid: pid, claudePid: s.pid, sessionId: sid, text, images, nonce });
    window.setTimeout(() => {
      if (!pendingSends.has(nonce)) return;
      pendingSends.delete(nonce);
      setSendNote(sid, i18n("active.noHostReply"), "bad");
    }, SEND_TIMEOUT_MS);
  };
  send.addEventListener("click", submit);
  // Enter sends, Shift+Enter adds a line break; "/" shows command hints, ↑ walks the history.
  const suggest = enhanceComposer(area, sid, submit, controls);
  const chooser = argChooser(area, submit, controls.agent);
  if (controls.commands) {
    area.addEventListener("input", () => chooser.show(area.value));
    chooser.show(area.value);
  }
  const row = el("div", "row2");
  row.append(clip, area, send, picker);
  form.append(suggest, chooser.row, thumbs, row, note);
  window.setTimeout(() => { renderThumbs(sid); if (area.value) autosize(area); }, 0);
  return form;
}

// While the field has focus the global redraw is skipped, so the send state updates in place.
function setSendNote(sid, note, cls, clear) {
  sendState.set(sid, { note, cls });
  const area = document.querySelector(`.answer textarea[data-id="${CSS.escape(sid)}"]`);
  if (!area) return;
  if (clear) { area.value = ""; autosize(area); }
  const box = area.closest(".answer").querySelector(".note");
  box.className = "note" + (cls ? " " + cls : "");
  box.textContent = note;
}

// What wakes the session without you, in words, for the label and the tooltip.
function backgroundReasons(b) {
  return AtlasLogic.backgroundReasons(b, iso => new Date(iso).toLocaleTimeString(I18N.locale(),
    { hour:"2-digit", minute:"2-digit" }));
}

// «Активные»: карточка, последний ответ и поле быстрого ответа.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
function activeCard(s) {
  const full = activeMode === "full";
  const act = s.activity || s.status;
  const card = el("article", "acard" + (act === "busy" ? " busy" : act === "background" ? " busy bg"
    : act === "waiting" ? " waiting" : ""));
  card.dataset.id = s.session_id;
  const head = el("div", "head");
  head.appendChild(pinButton(s));
  const title = el("div", "t", s.title || s.session_id);
  title.title = s.indexed ? i18n("active.openInSearch") : i18n("active.notIndexed");
  if (s.indexed) title.addEventListener("click", () => {
    setView("search"); openCard(s.session_id);
  });
  const status = STATUS[act] || STATUS.idle;
  const state = el("span", "state");
  const reasons = backgroundReasons(s.background);
  // После «Стоп» до следующего опроса статус — итог остановки, а не прежний «работает».
  state.append(el("span", "dot"), document.createTextNode(stopNotes.get(s.session_id)
    || (act === "background" && !full ? i18n("active.status.backgroundShort") : status.label)));
  state.title = s.waiting_for ? `${status.hint} (${s.waiting_for})`
    : act === "background" ? `${status.hint}: ${reasons.join(", ")}` : status.hint;
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
  if (tasks && !full) {                  // компактно отдельной строки нет места — метка в тегах
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

  const whenText = i18n("active.when", { start: fmtShort(s.started_at), ago: ago(s.last_message_at) });
  const whenHint = i18n("active.whenHint", { start: fmtDateTime(s.started_at),
                                             last: fmtDateTime(s.last_message_at) });
  const turns = s.human_turns == null ? i18n("active.turnsNone")
    : i18nN("active.turns", s.human_turns);
  // Сейчас ≈ — последняя сумма Claude Code плюс ответы после неё по токенам; иначе — на дату.
  const cost = AtlasLogic.costText(s, iso => fmtShort(iso).split(",")[0]);
  const costHint = (s.cost_usd != null
      ? i18n("active.costRecorded", { cost: s.cost_usd.toFixed(2), at: s.cost_recorded_at
          ? i18n("active.costRecordedAt", { date: fmtDateTime(s.cost_recorded_at) }) : "" })
      : i18n("active.costNotRecorded"))
    + (s.cost_now != null ? i18n("active.costNow", { cost: s.cost_now.toFixed(2) }) : "")
    + (s.cost_partial ? i18n("active.costPartial") : "");

  const pid = tabFor(s);
  const go = el("button", "primary", i18n("active.go"));
  const close = el("button", null, i18n("active.close"));
  go.title = i18n("active.goHint");
  close.title = i18n("active.closeHint");
  go.disabled = close.disabled = !pid;
  if (!pid) go.title = close.title = hostReady
    ? (s.host_app ? i18n("active.notInTabApp", { app: s.host_app }) : i18n("active.notInTab"))
    : i18n("active.buttonsInObsidian");
  if (pid) {
    go.addEventListener("click", () => tellTabHost("focus-tab", { ptyPid: pid }));
    close.addEventListener("click", () => {
      // Подтверждение показывает сам Obsidian — то же окно, что и у крестика вкладки.
      tellTabHost("close-tab", { ptyPid: pid, title: s.title || s.session_id });
      setTimeout(loadActive, 1500);
    });
  }

  if (full) {
    // Подробно: кнопки в строке заголовка, даты и деньги одной строкой — место под ответ.
    iconify(go, GO_SVG, i18n("active.go"));
    iconify(close, CLOSE_SVG, i18n("active.close"));
    const stopFull = stopButton(s, pid, true);
    if (stopFull) head.appendChild(stopFull);
    head.appendChild(feedButton(s, true));
    head.appendChild(hideButton(s, true));
    head.append(canMove(s, pid) ? moveButton(s, true) : go, close);
    const parts = AtlasLogic.infoParts(s, ago, shortStart);
    const info = infoLine("info", [...parts.when, ...parts.nums], parts.context);
    info.title = `${whenHint}. ${turns} · ${cost}. ${costHint}`;
    const dialog = dialogBlock(s, pid, true);
    card.append(info);
    if (dialog) card.appendChild(dialog);
    const cmdOut = commandOutputBlock(s, pid);
    if (cmdOut) card.appendChild(cmdOut);
    card.append(messagesBlock(s), answerForm(s, pid));
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
  foot.appendChild(feedButton(s, false));
  foot.appendChild(hideButton(s, false));
  foot.append(canMove(s, pid) ? moveButton(s, false) : go, close);
  card.append(when, nums);
  const dialog = dialogBlock(s, pid, false);
  if (dialog) {
    card.classList.add("has-dialog");      // компактно: место описания и тегов — под диалог
    card.appendChild(dialog);
  }
  card.appendChild(foot);
  return card;
}

// Подробно: полоска сделанного, «3/7» и то, над чем агент работает сейчас.
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

// «26.08 16:36» — без запятой и года текущего: строка карточки должна помещаться.
const shortStart = iso => (iso ? fmtShort(iso).replace(",", "") : "");

// Строка частей через « · »; контекст — отдельным цветным куском. Не влезла — крутится колесом.
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

// Колесо мыши над строкой, которая не влезла, листает её вбок — без полосы прокрутки.
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

// Твоё последнее сообщение, если Claude на него ещё не ответил: из транскрипта или только что
// отправленное из карточки (транскрипт догоняет через несколько секунд).
function unansweredPrompt(s) {
  const found = AtlasLogic.unansweredPrompt(s, justSent.get(s.session_id));
  if (found.dropSent) justSent.delete(s.session_id);   // транскрипт догнал или Claude ответил
  return found.prompt;
}

const DELIVERY_TEXT = {
  sending: i18n("active.delivery.sending"),
  queued: i18n("active.delivery.queued"),
  lost: i18n("active.delivery.lost"),
};

function promptBlock(p, s) {
  const box = el("div", "reply mine");
  const delivery = p.sent ? AtlasLogic.deliveryState(s, p, Date.now()) : null;
  const who = el("div", "who" + (delivery === "lost" ? " bad" : ""), i18n("active.you", { ago: ago(p.at),
    state: delivery ? DELIVERY_TEXT[delivery]
      : p.interrupted ? i18n("active.interrupted") : i18n("active.awaitingClaude") }));
  if (delivery === "lost") who.title = i18n("active.lostHint");
  box.appendChild(who);
  const body = el("div", "txt md");
  if (p.text) body.appendChild(renderMarkdown(p.text));
  if (p.images) body.appendChild(el("p", "cutmark",
    i18nN("active.images", p.images)));
  box.appendChild(body);
  return box;
}

// Сколько сообщений в подробной карточке — из настроек плагина (адрес страницы), по умолчанию 10.
const CARD_MESSAGES = Math.max(1, Math.min(30,
  Number(new URLSearchParams(location.search).get("msgs")) || 10));

/** Подробная карточка: хвост переписки — прежние сообщения над последним блоком, общий скролл. */
function messagesBlock(s) {
  const latest = replyBlock(s);
  const earlier = AtlasLogic.cardHistory(s, unansweredPrompt(s), CARD_MESSAGES);
  if (!earlier.length) return latest;
  const box = el("div", "amsgs");
  box.dataset.sid = s.session_id;
  earlier.forEach(m => box.appendChild(historyMessage(m)));
  box.appendChild(latest);
  return box;
}

function historyMessage(m) {
  const mine = m.role === "you";
  const box = el("div", "reply hmsg" + (mine ? " mine" : ""));
  box.appendChild(el("div", "who", mine ? i18n("active.youWas", { ago: ago(m.at) }) : `Claude, ${ago(m.at)}`));
  const body = el("div", "txt md");
  if (!mine && m.len > (m.text || "").length) body.appendChild(el("p", "cutmark", i18n("active.replyStartAbove")));
  if (m.text) body.appendChild(renderMarkdown(m.text));
  if (mine && m.len > (m.text || "").length) body.appendChild(el("p", "cutmark", i18n("active.promptCut")));
  if (m.images) body.appendChild(el("p", "cutmark", i18nN("active.images", m.images)));
  box.appendChild(body);
  return box;
}

// Хвост последнего ответа Claude: вопрос к тебе обычно в конце, начало — отчёт о сделанном.
function replyBlock(s) {
  const mine = unansweredPrompt(s);
  if (mine) {
    const box = promptBlock(mine, s);
    if ((s.activity === "busy" || s.status === "busy") && s.progress) {
      const now = el("div", "txt now md");
      now.appendChild(renderMarkdown(i18n("active.nowMd", { text: s.progress })));
      now.title = i18n("active.lastNote", { ago: ago(s.progress_at) });
      box.appendChild(now);
    }
    return box;
  }
  const box = el("div", "reply");
  const who = el("div", "who", `Claude, ${ago(s.reply_at)}`);
  const full = fullReplies.get(s.session_id);
  const cut = s.reply_len > (s.reply_tail || "").length;
  if (cut) {
    const more = el("button", null, full ? i18n("active.collapse") : i18n("active.showAll", { n: s.reply_len }));
    more.addEventListener("click", async () => {
      if (full) { fullReplies.delete(s.session_id); renderActive(); return; }
      try {
        const r = await api("/api/active/reply/" + encodeURIComponent(s.session_id));
        fullReplies.set(s.session_id, r.text || "");
      } catch (e) { sendState.set(s.session_id, { note: i18n("active.error", { msg: e.message }), cls: "bad" }); }
      renderActive();
    });
    who.appendChild(more);
  }
  box.appendChild(who);
  // Набранное во вкладке, пока Claude работал: ждёт своего хода в очереди Claude Code.
  const queued = s.queued || [];
  if (queued.length) {
    const first = queued[0].text.replace(/\s+/g, " ").slice(0, 80);
    const q = el("div", "queued", queued.length > 1
      ? i18n("active.queuedMany", { n: queued.length, text: first }) : i18n("active.queuedOne", { text: first }));
    q.title = queued.map(x => x.text).join("\n—\n");
    box.appendChild(q);
  }
  if (s.status === "busy" && s.progress) {
    const now = el("div", "txt now md");
    const lead = renderMarkdown(i18n("active.nowMd", { text: s.progress }));
    now.appendChild(lead);
    now.title = i18n("active.lastNote", { ago: ago(s.progress_at) });
    box.appendChild(now);
  }
  const text = full != null ? full : (s.reply_tail || "");
  const body = el("div", full != null ? "txt md all" : "txt md");
  if (cut && full == null) body.appendChild(el("p", "cutmark", i18n("active.replyStartAbove")));
  body.appendChild(text ? renderMarkdown(text) : document.createTextNode(i18n("active.noTextReply")));
  box.appendChild(body);
  return box;
}

const GO_SVG = [["path", { d: "M14 4h6v6" }], ["path", { d: "M20 4 11 13" }],
                ["path", { d: "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }]];
const CLOSE_SVG = [["path", { d: "M6 6l12 12M18 6 6 18" }]];
const FEED_SVG = [["path", { d: "M4 6h16M4 12h16M4 18h10" }]];
const HIDE_SVG = [["path", { d: "M5 12h14" }]];
const STOP_SVG = [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 1 }]];

// Кнопка-иконка в заголовке подробной карточки: там тесно, а подпись — в подсказке.
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

// Однострочное поле, которое растёт до шести строк по мере набора.
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

// Картинка уходит на сервер файлом; в терминал плагин вставит путь — Claude Code сделает
// из него вложение [Image #N].
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
  const box = document.querySelector(`.thumbs[data-id="${CSS.escape(sid)}"]`);
  if (!box) return;
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

  area.addEventListener("input", () => { drafts.set(sid, area.value); autosize(area); });
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

  const submit = () => {
    const text = area.value;
    // «/effort» и «/model» без аргумента открыли бы во вкладке ползунок — выбор кнопками здесь.
    if (argChoices(text)) { chooser.show(text); return; }
    const images = (attachments.get(sid) || []).map(a => a.path);
    if ((!text.trim() && !images.length) || send.disabled) return;
    const nonce = Math.random().toString(36).slice(2);
    pendingSends.set(nonce, sid);
    sentDrafts.set(nonce, { text, images: images.length });
    setSendNote(sid, i18n("active.sending"), "");
    commandOutputs.delete(sid);                 // новый ответ заменит прошлый
    tellTabHost("send-text", { ptyPid: pid, claudePid: s.pid, sessionId: sid, text, images, nonce });
    setTimeout(() => {
      if (!pendingSends.has(nonce)) return;
      pendingSends.delete(nonce);
      setSendNote(sid, i18n("active.noHostReply"), "bad");
    }, SEND_TIMEOUT_MS);
  };
  send.addEventListener("click", submit);
  // Enter — отправить, Shift+Enter — перенос; «/» — подсказки команд, ↑ — история.
  const suggest = enhanceComposer(area, sid, submit);
  const chooser = argChooser(area, submit);
  area.addEventListener("input", () => chooser.show(area.value));
  chooser.show(area.value);
  const row = el("div", "row2");
  row.append(clip, area, send, picker);
  form.append(suggest, chooser.row, thumbs, row, note);
  setTimeout(() => { renderThumbs(sid); if (area.value) autosize(area); }, 0);
  return form;
}

// Пока в поле фокус, общая перерисовка пропускается — состояние отправки обновляем на месте.
function setSendNote(sid, note, cls, clear) {
  sendState.set(sid, { note, cls });
  const area = document.querySelector(`.answer textarea[data-id="${CSS.escape(sid)}"]`);
  if (!area) return;
  if (clear) { area.value = ""; autosize(area); }
  const box = area.closest(".answer").querySelector(".note");
  box.className = "note" + (cls ? " " + cls : "");
  box.textContent = note;
}

// Что разбудит сессию без тебя — словами, для метки и подсказки.
function backgroundReasons(b) {
  return AtlasLogic.backgroundReasons(b, iso => new Date(iso).toLocaleTimeString(I18N.locale(),
    { hour:"2-digit", minute:"2-digit" }));
}

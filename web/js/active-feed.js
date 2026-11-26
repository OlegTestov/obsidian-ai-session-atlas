// The paged conversation, steps and files inside a detailed Active card.
/* exported showConversationSend, removeConversationSend -- used by other page scripts */
const FEED_TURNS = 20;
const cardViews = new Map();
const cardPanels = new Map();
const workspaceReading = new Map();
const MAX_READING_PANELS = 25;
const conversationSends = new Map();  // session id → locally sent messages awaiting their transcript turn
const DELIVERY_TEXT = {
  sending: i18n("active.delivery.sending"),
  queued: i18n("active.delivery.queued"),
  lost: i18n("active.delivery.lost"),
};

function showConversationSend(sid, nonce, draft) {
  if (!conversationSends.has(sid)) conversationSends.set(sid, { messages: new Map(), matched: new Set() });
  conversationSends.get(sid).messages.set(nonce, draft);
  cardPanels.get(sid)?.drawSends?.(true);
}

function removeConversationSend(sid, nonce) {
  const sends = conversationSends.get(sid);
  if (!sends?.messages.delete(nonce)) return;
  if (!sends.messages.size) conversationSends.delete(sid);
  cardPanels.get(sid)?.drawSends?.();
}

function reconcileConversationSends(sid, turns) {
  const sends = conversationSends.get(sid);
  if (!sends) return;
  for (const turn of turns) {
    if (sends.matched.has(turn.id)) continue;
    for (const [nonce, message] of sends.messages) {
      if (AtlasLogic.sentTurnMatches(message, turn)) {
        sends.messages.delete(nonce);
        sends.matched.add(turn.id);
        break;
      }
    }
    if (!sends.messages.size) {
      conversationSends.delete(sid);
      return;
    }
  }
}

// Messages queued in the agent's terminal wait until the current step finishes.
function queuedLine(s, box, shown) {
  const queued = AtlasLogic.queuedNotShown(s, shown);
  if (!queued.length) return;
  const first = queued[0].text.replace(/\s+/g, " ").slice(0, 80);
  const q = el("div", "queued", queued.length > 1
    ? i18n("active.queuedMany", { n: queued.length, text: first }) : i18n("active.queuedOne", { text: first }));
  q.title = queued.map(x => x.text).join("\n—\n");
  box.appendChild(q);
}

function cardViewMode(sid) {
  return cardViews.get(sid) || "turns";
}

function cardViewPicker(s, pid) {
  const select = el("select", "card-view-picker");
  select.setAttribute("aria-label", i18n("feed.mode"));
  select.title = i18n("feed.mode");
  for (const value of ["turns", "terminal", "steps", "files"]) {
    if (s.agent === "opencode" && value === "terminal" && !hostInlineTabs.has(pid)) continue;
    const option = el("option", null, i18n(`feed.view.${value}`));
    option.value = value;
    option.disabled = value === "terminal" && !hostInlineTabs.has(pid);
    if (option.disabled) option.title = i18n("feed.terminalUnavailable");
    select.appendChild(option);
  }
  select.value = visibleCardView(s, pid);
  select.addEventListener("change", () => {
    if (select.value === "turns") cardViews.delete(s.session_id);
    else cardViews.set(s.session_id, select.value);
    const card = select.closest(".acard");
    const placeholder = el("div", "card-view-slot");
    card.querySelector(".card-view-body").replaceWith(placeholder);
    attachCardPanel(card, s, pid);
    if (select.value === "terminal") cardPanels.get(s.session_id)?.focus();
    seeCard(s.session_id);
  });
  return select;
}

function visibleCardView(s, pid) {
  const view = cardViewMode(s.session_id);
  return s.agent === "opencode" && view === "terminal" && !hostInlineTabs.has(pid) ? "turns" : view;
}

function attachCardPanel(card, session, pid) {
  const sid = session.session_id;
  const view = visibleCardView(session, pid);
  const slot = card.querySelector(".card-view-slot");
  const previous = cardPanels.get(sid);
  const parked = workspaceReading.get(sid);
  workspaceReading.delete(sid);
  let panel = previous || parked?.panel;
  if (!panel || view !== panel.view || (view === "terminal" && pid !== panel.pid)) {
    if (panel) panel.dispose();
    panel = view === "terminal" ? terminalCardPanel(session, pid) : conversationPanel(session, view);
  }
  cardPanels.set(sid, panel);
  panel.session = session;
  card.classList.toggle("terminal-mode", view === "terminal");
  slot.replaceWith(panel.body);
  panel.mount();
  if (parked?.panel === panel) panel.body.scrollTop = parked.top;
}

function mountCardPanels(grid, sessions = [], positions) {
  const cards = new Map([...grid.querySelectorAll(".acard .card-view-slot")].map(slot => {
    const card = slot.closest(".acard");
    return [card.dataset.id, card];
  }));
  const keepReading = workspaceBoards().length > 0 && positions;
  const live = new Set(activeSessions.map(s => s.session_id));
  for (const [sid,{panel}] of workspaceReading) if (!keepReading || !live.has(sid)) {
    panel.dispose();
    workspaceReading.delete(sid);
  }
  for (const [sid, panel] of cardPanels) {
    if (cards.has(sid)) continue;
    cardPanels.delete(sid);
    if (keepReading && live.has(sid) && panel.view !== "terminal") {
      panel.suspend();
      workspaceReading.set(sid,{panel,top:positions.get(sid) || 0});
    } else panel.dispose();
  }
  while (workspaceReading.size > MAX_READING_PANELS) {
    const [sid,{panel}] = workspaceReading.entries().next().value;
    panel.dispose();
    workspaceReading.delete(sid);
  }
  for (const session of sessions) {
    const card = cards.get(session.session_id);
    if (card) attachCardPanel(card, session, tabFor(session));
  }
}

function refreshCardPanels() {
  for (const panel of cardPanels.values()) panel.refresh();
}

function conversationPanel(session, view) {
  const body = el("div", "card-view-body");
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", i18n(`feed.view.${view}`));
  const sid = session.session_id;
  const paged = view !== "files";
  let older = [], live = [], hasMore = false, loadingOlder = false, epoch = 0;
  let signature = "", files = {}, filter = "all";
  let refreshing = false, drawn = false, disposed = false, shown = false;
  let fetched = null, fetchedAt = 0;

  const url = `/api/active/feed/${encodeURIComponent(sid)}?turns=${FEED_TURNS}&view=${view}`;
  const watch = new IntersectionObserver(entries => {
    shown = entries[0].isIntersecting;
    if (shown) refresh();
  }, { root: $("#active-grid") });
  const panel = { view, body, session, mount() { if (drawn || (view === "turns" && conversationSends.has(sid))) draw(); watch.observe(body); },
    refresh() { if (shown) { if (drawn) draw(); refresh(); } },
    suspend() { shown = false; watch.disconnect(); },
    dispose() { disposed = true; watch.disconnect(); } };
  if (view === "turns") panel.drawSends = follow => draw(false, follow);

  function draw(prepended = false, follow = false) {
    if (!body.isConnected) return;
    const current = panel.session;
    const turns = older.concat(live);
    const busy = ["busy", "background"].includes(current.activity || current.status);
    const sent = view === "turns" ? [...(conversationSends.get(sid)?.messages.values() || [])] : [];
    const deliveries = sent.map(message => message.acknowledged
      ? DELIVERY_TEXT[AtlasLogic.deliveryState(current, message, Date.now())] : i18n("active.sending"));
    const extra = view === "turns" ? [sent, deliveries, busy && current.progress, current.queued, current.queued_count] : [];
    const key = JSON.stringify([view, filter, view === "files" ? files : turns, hasMore, loadingOlder, extra,
      view === "steps" ? [busy, Math.floor(Date.now() / 30000)] : null]);
    if (key === signature) return;
    signature = key;
    const atEnd = follow || !drawn || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const top = body.scrollTop, height = body.scrollHeight;
    if (!paged) {
      const expanded = body.querySelector(".fread")?.open;
      body.replaceChildren(...renderFiles(files));
      const details = body.querySelector(".fread");
      if (details && expanded) details.open = true;
    } else {
      const head = hasMore ? [earlierButton()] : older.length ? [el("p", "fwho", i18n("feed.start"))] : [];
      if (view === "steps") body.replaceChildren(...head, ...renderSteps(turns, current, filter, value => {
        filter = value;
        draw();
      }));
      else {
        const content = turns.map((t, i) => feedTurn(t, i === turns.length - 1 && !sent.length, current));
        if (!content.length && !sent.length) content.push(el("p", "empty", i18n("feed.noPrompts")));
        body.replaceChildren(...head, ...content);
        queuedLine(current, body, sent);
        if (busy && current.progress) {
          const progress = el("div", "ftxt now md");
          progress.appendChild(renderMarkdown(i18n("active.nowMd", { text: current.progress })));
          body.appendChild(progress);
        }
        sent.forEach((message, i) => {
          const item = feedTurn({ prompt: message.text, prompt_at: message.at,
            images: message.paths.length, steps: [] }, false, current);
          item.querySelector(".fwho").append(" · ", deliveries[i]);
          body.appendChild(item);
        });
      }
    }
    drawn = true;
    if (!paged) body.scrollTop = top;
    else if (prepended) body.scrollTop = top + body.scrollHeight - height;
    else body.scrollTop = atEnd ? body.scrollHeight : top;
  }

  async function refresh() {
    if (disposed || refreshing) return;
    const current = panel.session;
    const activity = current.activity || current.status;
    const revision = JSON.stringify([activity, current.prompt_at, current.reply_at, current.last_activity_at,
      current.interrupted_at, current.transcript_session_id, current.progress_at]);
    // Idle cards do not need to reparse the same transcript on every Active poll.
    const maxAge = activity === "idle" ? 30000 : 4000;
    if (fetched === revision && Date.now() - fetchedAt < maxAge) return;
    refreshing = true;
    try {
      // Only from the last shown turn on (inclusive: it may still be growing); older ones are kept.
      const last = paged ? live.at(-1)?.id : null;
      let data = await api(url + (last ? `&since_id=${encodeURIComponent(last)}` : ""));
      // The anchor is gone (compaction, rewrite, too far behind): load the latest page as on first open.
      const reset = !!(last && data.reset);
      if (reset) data = await api(url);
      if (disposed) return;
      fetched = revision;
      fetchedAt = Date.now();
      if (paged) {
        const turns = data.turns || [];
        if (view === "turns") reconcileConversationSends(sid, turns);
        if (!last || reset) {
          if (live.length) { older = []; epoch++; }
          live = turns;
          hasMore = !!data.has_more;
        } else if (turns.length) live = live.slice(0, -1).concat(turns);
      } else files = data;
      draw();
    } catch (error) {
      if (!disposed && !drawn) body.replaceChildren(el("p", "empty", i18n("feed.error", { msg: error.message })));
    } finally {
      refreshing = false;
    }
  }

  function earlierButton() {
    const button = el("button", "fearlier", i18n(loadingOlder ? "feed.loadingEarlier" : "feed.loadEarlier"));
    button.type = "button";
    button.disabled = loadingOlder;
    button.addEventListener("click", loadOlder);
    return button;
  }

  async function loadOlder() {
    const first = older[0] || live[0];
    const before = first?.id ? `&before_id=${encodeURIComponent(first.id)}`
      : first?.prompt_at ? `&before=${encodeURIComponent(first.prompt_at)}` : "";
    if (disposed || !paged || !hasMore || loadingOlder || !before) return;
    loadingOlder = true;
    const mine = epoch;
    draw(true);
    try {
      const data = await api(url + before);
      if (disposed || mine !== epoch) return;
      const turns = data.turns || [];
      older = turns.concat(older);
      hasMore = !!data.has_more && turns.length > 0;
    } catch { /* The earlier-page button remains available for a retry. */ }
    finally {
      loadingOlder = false;
      if (!disposed) draw(true);
    }
  }

  body.addEventListener("scroll", () => {
    if (body.clientHeight && body.scrollTop < 80) loadOlder();
  }, { passive: true });
  body.appendChild(el("p", "empty", i18n("feed.loading")));
  return panel;
}

function feedTurn(t, last, session) {
  const box = el("section", "fturn");
  const you = el("div", "fwho", i18n("feed.you", { time: fmtShort(t.prompt_at) }));
  box.appendChild(you);
  const prompt = el("div", "ftxt md mine");
  prompt.appendChild(renderMarkdown(t.prompt || ""));
  if (t.images) prompt.appendChild(el("p", "cutmark", i18nN("feed.images", t.images)));
  box.appendChild(prompt);
  if (t.steps.length) {
    const steps = el("div", "fsteps");
    t.steps.forEach(st => {
      const chip = el("span", "pill fstep " + st.kind, st.text);
      if (st.detail.length) chip.title = st.detail.join("\n");
      steps.appendChild(chip);
    });
    box.appendChild(steps);
  }
  if (t.interrupted && !t.reply) box.appendChild(el("div", "fwho bad", i18n("feed.interrupted")));
  if (t.reply) {
    const who = agentShort(session);
    box.appendChild(el("div", "fwho", `${who} · ${fmtShort(t.reply_at)}`
      + (t.interrupted ? " · " + i18n("feed.interrupted") : "")));
    const reply = el("div", "ftxt md");
    if (t.reply_len > t.reply.length) reply.appendChild(el("p", "cutmark", i18n("feed.replyCut")));
    reply.appendChild(renderMarkdown(t.reply));
    box.appendChild(reply);
  } else if (!t.interrupted && last) {
    // Past turns without a reply are commands like /mcp: they need no answer.
    box.appendChild(el("div", "fwho", i18n("feed.noReply")));
  }
  return box;
}

// Pure logic of the Active tab: no DOM or network, tested in node (tests/js/page.test.mjs).
(function (root) {
  const I18 = root.I18N;
  const decimal = text => (I18.lang() === "ru" ? text.replace(".", ",") : text);

  // Russian plural; page strings use i18nN, this one stays for compatibility.
  function pluralRu(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // The ranges do not overlap, so several period checkboxes make sense too.
  // The label is a getter: the language is chosen after the script loads.
  const PERIODS = [
    { value: "hour", get label() { return I18.i18n("logic.period.hour"); } },
    { value: "today", get label() { return I18.i18n("logic.period.today"); } },
    { value: "yesterday", get label() { return I18.i18n("logic.period.yesterday"); } },
    { value: "week", get label() { return I18.i18n("logic.period.week"); } },
    { value: "older", get label() { return I18.i18n("logic.period.older"); } },
  ];

  function periodOf(iso, now) {
    if (!iso) return "older";
    const t = new Date(iso);
    now = now || new Date();
    if (now - t < 36e5) return "hour";
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(now) - day(t)) / 864e5);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days <= 7) return "week";
    return "older";
  }

  function valuesOf(s, key, now) {
    if (key === "domain") return s.domains || [];
    if (key === "project") return s.projects || [];
    if (key === "topic") return s.topic ? [s.topic] : [];
    return [periodOf(s.last_message_at, now)];
  }

  // filters is {key: Set}; except is a filter to ignore (for the counts of its own list).
  function passes(s, filters, except, now) {
    return Object.keys(filters).every(key => {
      const want = filters[key];
      return key === except || !want.size || valuesOf(s, key, now).some(v => want.has(v));
    });
  }

  // List values with counts under the other filters; a selected value stays even at 0.
  function filterOptions(sessions, filters, key, now) {
    const counts = new Map();
    sessions.filter(s => passes(s, filters, key, now))
      .forEach(s => valuesOf(s, key, now).forEach(v => counts.set(v, (counts.get(v) || 0) + 1)));
    if (key === "period") {
      return PERIODS.filter(p => counts.has(p.value) || filters[key].has(p.value))
        .map(p => ({ value: p.value, label: p.label, count: counts.get(p.value) || 0 }));
    }
    return [...new Set([...counts.keys(), ...filters[key]])].sort((a, b) => a.localeCompare(b, "ru"))
      .map(v => ({ value: v, label: v, count: counts.get(v) || 0 }));
  }

  function parseLayout(value, max) {
    const m = /^([1-5])x([1-5])$/.exec(value || "");
    return m && +m[1] <= max && +m[2] <= max ? { c: +m[1], r: +m[2] } : null;
  }

  // What wakes the session without you, in words; the caller formats the time.
  function backgroundReasons(b, fmtTime) {
    if (!b) return [];
    const out = [];
    if (b.shells) out.push(b.shells === 1 ? I18.i18n("logic.bg.shell") : I18.i18n("logic.bg.shells", { n: b.shells }));
    if (b.agents) out.push(I18.i18nN("logic.bg.agents", b.agents));
    if (b.wake_at) out.push(I18.i18n("logic.bg.wake", { time: fmtTime ? fmtTime(b.wake_at) : b.wake_at }));
    if (b.crons) out.push(I18.i18n("logic.bg.cron"));
    return out;
  }

  // Your message without a reply: just sent (until the transcript catches up) or from
  // the transcript. dropSent: the message sent from the card no longer needs keeping.
  function unansweredPrompt(s, sent) {
    const t = iso => (iso ? new Date(iso).getTime() : 0);
    let dropSent = false;
    if (sent && (t(s.reply_at) > t(sent.at) || t(s.prompt_at) >= t(sent.at) - 2000)) {
      dropSent = true;
      sent = null;
    }
    if (sent) return { prompt: { text: sent.text, images: sent.images, at: sent.at, sent: true },
                       dropSent };
    if (s.prompt && t(s.prompt_at) > t(s.reply_at)) {
      return { prompt: { text: s.prompt, images: s.prompt_images || 0, at: s.prompt_at,
                         interrupted: t(s.interrupted_at) >= t(s.prompt_at) }, dropSent };
    }
    return { prompt: null, dropSent };
  }

  // Where a message just sent from the card is until the transcript shows it: queued (typed
  // while Claude worked), still on its way, or lost (the tab rejected input, a dialog took it).
  const DELIVERY_WAIT_MS = 15000;
  function deliveryState(s, sent, now) {
    if (!sent) return null;
    const head = (sent.text || "").trim().slice(0, 40);
    if (head && (s.queued || []).some(q => (q.text || "").trim().startsWith(head))) return "queued";
    if (head && now - new Date(sent.at).getTime() > DELIVERY_WAIT_MS) return "lost";
    return "sending";
  }

  // Slash-command hints while "/word" is typed without a space. Prefix matches come first.
  function commandMatches(list, text) {
    const m = /^\/([^\s]*)$/.exec(text || "");
    if (!m) return [];
    const q = m[1].toLowerCase();
    const starts = list.filter(c => c.name.toLowerCase().startsWith(q));
    const inside = q ? list.filter(c => !c.name.toLowerCase().startsWith(q)
      && c.name.toLowerCase().includes(q)) : [];
    return starts.concat(inside);
  }

  // Sent history, as in a shell: index −1 is your draft, 0 is the last sent message.
  function historyStep(history, index, dir) {
    const next = Math.max(-1, Math.min(history.length - 1, index + (dir === "up" ? 1 : -1)));
    return { index: next, text: next < 0 ? null : history[history.length - 1 - next] };
  }

  // Session context: the window share and tone; from 80% auto-compaction is close.
  function contextLevel(s) {
    if (!s.context_tokens || !s.context_window) return null;
    const pct = Math.round(100 * s.context_tokens / s.context_window);
    return { pct, tone: pct >= 80 ? "warn" : pct >= 60 ? "mid" : "ok",
             text: I18.i18n("logic.context", { pct }),
             hint: I18.i18n("logic.context.hint", { used: Math.round(s.context_tokens / 1000),
                                                    window: Math.round(s.context_window / 1000) })
               + (pct >= 80 ? I18.i18n("logic.context.soon") : "") };
  }

  // "3 h ago" from an age in seconds, the wording of the page's other ages.
  function limitsAge(seconds) {
    const min = Math.round(seconds / 60);
    if (min < 1) return I18.i18n("common.justNow");
    if (min < 60) return I18.i18n("common.minAgo", { n: min });
    const h = Math.round(seconds / 3600);
    return h < 24 ? I18.i18n("common.hoursAgo", { n: h }) : I18.i18n("common.daysAgo", { n: Math.round(h / 24) });
  }

  // Weekly and 5-hour limits as a line for the top bar. Numbers the server does not call live
  // (an old status line file, Codex's last run) carry their age; a window at 100% says so.
  function limitsText(l, fmtWhen) {
    if (!l || !l.windows || !l.windows.length) return null;
    const parts = l.windows.map(w => `${w.label} ${Math.round(w.used_percentage)}%`
      + (w.used_percentage >= 100 ? I18.i18n("logic.limits.reached") : "")
      + (w.resets_at && fmtWhen ? I18.i18n("logic.limits.until", { when: fmtWhen(w.resets_at) }) : ""));
    const top = Math.max(...l.windows.map(w => w.used_percentage));
    const age = l.live === true || l.age_seconds == null ? null : limitsAge(l.age_seconds);
    return { text: I18.i18n("logic.limits", { parts: parts.join(" · ") }),
             tone: top >= 90 ? "warn" : top >= 75 ? "mid" : "ok", age, reached: top >= 100 };
  }

  // The poll of "Active": the chat tail first (the detailed view), then whether to ask Codex itself.
  function activeUrl(messages, agents) {
    const q = (messages > 1 ? [`msgs=${messages}`] : []).concat((agents || []).includes("codex") ? ["codex_usage=1"] : []);
    return "/api/active" + (q.length ? "?" + q.join("&") : "");
  }

  // Card order does not depend on message freshness, otherwise cards jump on every reply:
  // pinned (in pin order), then by start time, newest on top. Cards hidden until the
  // next message drop out: hidden is {id: last_message_at at hiding time}.
  function arrangeSessions(list, pinned, hidden) {
    const pins = pinned || [];
    const hid = hidden || {};
    const isHidden = s => Object.prototype.hasOwnProperty.call(hid, s.session_id)
      && hid[s.session_id] === (s.last_message_at || "");
    const visible = list.filter(s => !isHidden(s));
    const started = s => new Date(s.process_started_at || s.started_at || 0).getTime();
    visible.sort((a, b) => {
      const pa = pins.indexOf(a.session_id), pb = pins.indexOf(b.session_id);
      if (pa !== pb) return (pa < 0 ? 1e9 : pa) - (pb < 0 ? 1e9 : pb);
      return started(b) - started(a) || (a.session_id < b.session_id ? -1 : 1);
    });
    // Hidden cards that got a new message come back; their records are no longer needed.
    const stale = Object.keys(hid).filter(id => {
      const s = list.find(x => x.session_id === id);
      return !s || hid[id] !== (s.last_message_at || "");
    });
    return { visible, hiddenCount: list.length - visible.length, stale };
  }

  // Arrows and j/k over cards: left/right to the neighbour, up/down by a row (cols cards).
  function nextCard(ids, current, key, cols) {
    if (!ids.length) return null;
    const i = ids.indexOf(current);
    if (i < 0) return ids[0];
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, j: 1, k: -1 }[key];
    if (step === undefined) return current;
    return ids[Math.max(0, Math.min(ids.length - 1, i + step))];
  }

  // Cost: as recorded by Claude Code (as of a date) and a current estimate from tokens.
  function costText(s, fmtDay) {
    if (s.cost_now != null && (s.cost_usd == null || s.cost_now - s.cost_usd >= 0.005)) {
      return "≈ $" + s.cost_now.toFixed(2);
    }
    if (s.cost_usd == null) return "$ —";
    return "$" + s.cost_usd.toFixed(2) + (s.cost_recorded_at && fmtDay ? I18.i18n("logic.cost.on", { day: fmtDay(s.cost_recorded_at) }) : "");
  }

  // Short card line: "26.08 16:36 · 12 h ago · 396 turns · ≈$832 · 606k/1M".
  // The full text is in the tooltip. ago and fmtStart come from the page, which owns time formats.
  function shortTokens(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, "") + "M"
      : Math.round(n / 1000) + "k";
  }
  function shortCost(s) {
    const estimate = s.cost_now != null && (s.cost_usd == null || s.cost_now - s.cost_usd >= 0.005);
    const v = estimate ? s.cost_now : s.cost_usd;
    if (v == null) return null;
    return (estimate ? "≈" : "") + "$" + (v >= 10 ? Math.round(v) : v.toFixed(2));
  }
  function infoParts(s, ago, fmtStart) {
    const when = [fmtStart(s.started_at), s.last_message_at ? ago(s.last_message_at) : null]
      .filter(Boolean);
    const nums = [];
    if (s.human_turns != null) nums.push(I18.i18nN("logic.turns", s.human_turns));
    const cost = shortCost(s);
    if (cost) nums.push(cost);
    const ctx = contextLevel(s);
    return { when, nums, context: ctx ? { text: shortTokens(s.context_tokens) + "/"
      + shortTokens(s.context_window), tone: ctx.tone, hint: ctx.hint } : null };
  }

  // Terminal link in words. health is the plugin answer; askedAt is when it was asked without an answer.
  const HOST_REPLY_MS = 3000;
  function terminalStatus(embedded, health, askedAt, now) {
    if (!embedded) return { ok: false, reason: I18.i18n("logic.term.notObsidian") };
    if (!health) {
      if (askedAt && now - askedAt > HOST_REPLY_MS) {
        return { ok: false, reason: I18.i18n("logic.term.noReply") };
      }
      return { ok: null, reason: I18.i18n("logic.term.checking") };
    }
    return { ok: !!health.ok, reason: health.reason || null };
  }

  // Agent tasks: "3/7", what runs now and the full list for the tooltip. null when there are no tasks.
  const TASK_MARK = { completed: "✓", in_progress: "▶", pending: "○" };
  function tasksSummary(t) {
    if (!t || !t.total) return null;
    const current = (t.active || [])[0] || null;
    const hint = (t.items || []).map(i => `${TASK_MARK[i.status] || "○"} ${i.subject}`).join("\n");
    return { count: `${t.done}/${t.total}`, current, hint, pct: Math.round(t.done / t.total * 100),
             finished: t.done === t.total };
  }

  // Feed, Steps: how long a call ran: "0.8 s", "42 s", "3 min", "1 h 05 min".
  function durationText(sec) {
    if (sec == null || sec < 0) return "";
    if (sec < 10) return I18.i18n("logic.dur.sec", { n: decimal(sec.toFixed(1)) });
    if (sec < 60) return I18.i18n("logic.dur.sec", { n: Math.round(sec) });
    const min = Math.round(sec / 60);
    if (min < 60) return I18.i18n("logic.dur.min", { n: min });
    return I18.i18n("logic.dur.hm", { h: Math.floor(min / 60), m: String(min % 60).padStart(2, "0") });
  }
  // Which steps the feed filter keeps. Reasoning text shows only under "all".
  const STEP_FILTERS = { all: null, error: ev => ev.status === "error", bash: ev => ev.kind === "bash",
                         edit: ev => ev.kind === "edit", agent: ev => ev.kind === "agent" };
  function stepPasses(ev, filter) {
    const f = STEP_FILTERS[filter];
    return !f || f(ev);
  }
  // File path in the feed: relative to the session folder, otherwise to home: "~/Code/x/a.py".
  function relPath(path, cwd, home) {
    if (cwd && path.startsWith(cwd.replace(/\/$/, "") + "/")) return path.slice(cwd.replace(/\/$/, "").length + 1);
    if (home && path.startsWith(home + "/")) return "~" + path.slice(home.length);
    return path;
  }

  // Quick jump (⌘K): every query word is in the title or subtitle; live ranks above closed,
  // a title-prefix match ranks above a mid-title one. An empty query lists everything in order.
  function jumpMatches(items, query, limit) {
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    (items || []).forEach((it, i) => {
      const title = String(it.title || "").toLowerCase();
      const hay = title + " " + String(it.sub || "").toLowerCase();
      if (!words.every(w => hay.includes(w))) return;
      const head = words.length && title.startsWith(words[0]) ? 0 : 1;
      scored.push([it.kind === "live" ? 0 : 1, head, i, it]);
    });
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return scored.slice(0, limit || 12).map(x => x[3]);
  }

  /** Earlier messages for the detailed card: everything before what its last block shows
   *  (your unanswered prompt or the last reply), at most limit − 1. */
  function cardHistory(s, unanswered, limit) {
    const shownAt = unanswered ? unanswered.at : s.reply_at;
    const list = (s.history || []).filter(m => !shownAt || !m.at || m.at < shownAt);
    return limit > 1 ? list.slice(-(limit - 1)) : [];
  }

  /** Card order while you are on the tab: existing cards keep their places, new ones go to the end,
   *  departed ones drop out. frozen = null means no order yet: take a fresh sort and remember it. */
  function applyFrozenOrder(sorted, frozen) {
    const ids = sorted.map(s => s.session_id);
    if (!frozen) return { list: sorted, frozen: ids };
    const known = new Map(frozen.map((id, i) => [id, i]));
    const kept = sorted.filter(s => known.has(s.session_id))
      .sort((a, b) => known.get(a.session_id) - known.get(b.session_id));
    const fresh = sorted.filter(s => !known.has(s.session_id));
    const list = kept.concat(fresh);
    return { list, frozen: list.map(s => s.session_id) };
  }

  /** Notes on the Recently closed rows: a session that left the list (opened) loses its note,
   *  otherwise on the next close the row would say "opening…" again. Opening waits at most ttl. */
  const CLOSED_NOTE_TTL_MS = 60000;
  function pruneClosedNotes(notes, closedIds, now, ttl) {
    const still = new Set(closedIds || []);
    for (const [id, note] of notes) {
      const stale = note.pending && now - note.at > (ttl || CLOSED_NOTE_TTL_MS);
      if (!still.has(id) || stale) notes.delete(id);
    }
    return notes;
  }

  // Agents a session can come from. A row without the field predates Codex support: Claude Code.
  const AGENTS = ["claude", "codex"];
  const agentOf = s => (s && s.agent) || "claude";

  /** A stored agent pick: known values in a fixed order; nothing known left means all (the default). */
  function agentSelection(stored) {
    const want = Array.isArray(stored) ? stored : [];
    const known = AGENTS.filter(a => want.includes(a));
    return known.length ? known : AGENTS.slice();
  }

  /** The `agent` request parameter; empty when every agent is picked, so the request stays as before. */
  function agentParam(selected) {
    const sel = agentSelection(selected);
    return sel.length === AGENTS.length ? "" : sel.join(",");
  }

  /** Client-side check (Active). With all picked, a value this page does not know passes too. */
  function agentPasses(s, selected) {
    const sel = agentSelection(selected);
    return sel.length === AGENTS.length || sel.includes(agentOf(s));
  }

  /** A checkbox click. The last ticked agent stays: an empty pick would show an empty page. */
  function toggleAgent(selected, agent, on) {
    const sel = agentSelection(selected);
    const next = AGENTS.filter(a => (a === agent ? on : sel.includes(a)));
    return next.length ? next : sel;
  }

  /** Agents "+ Session" offers: Claude Code always, Codex only when the plugin reports it enabled. */
  function newSessionAgents(hostAgents) {
    return hostAgents && hostAgents.codex === true ? AGENTS.slice() : ["claude"];
  }

  /** The remembered agent while it is still offered, otherwise Claude Code. */
  function newSessionAgent(offered, remembered) {
    return offered.includes(remembered) ? remembered : "claude";
  }

  /**
   * The dialog option answered with typed text, or null: Claude Code's "Type something." field in a
   * question, or Codex's decline that tells it what to do instead. The other options are one key.
   */
  function freeTextOption(d) {
    if (!d || !d.answerable || !Array.isArray(d.options)) return null;
    if (d.agent === "codex") {
      return d.feedback ? d.options.find(o => o.n === d.feedback.n && o.text === d.feedback.label) || null : null;
    }
    return d.kind === "question" ? d.options.find(o => o.freeText) || null : null;
  }

  /** Typed answer as the terminal field takes it: one line (Enter there sends), at most 4000 characters. */
  function freeAnswerText(text) {
    const line = String(text || "").replace(/\s+/g, " ").trim();
    return line.length > 4000 ? "" : line;
  }

  const api = { AGENTS, freeTextOption, freeAnswerText, agentOf, agentSelection, agentParam, agentPasses, toggleAgent, newSessionAgents,
                newSessionAgent, cardHistory, applyFrozenOrder, pruneClosedNotes, CLOSED_NOTE_TTL_MS, pluralRu, tasksSummary, jumpMatches, durationText, stepPasses, relPath, terminalStatus, infoParts, shortTokens, arrangeSessions, contextLevel, limitsText, limitsAge, activeUrl, deliveryState, DELIVERY_WAIT_MS, commandMatches,
                historyStep, PERIODS, periodOf, valuesOf, passes, filterOptions, parseLayout,
                backgroundReasons, unansweredPrompt, nextCard, costText };
  root.AtlasLogic = api;           // own namespace: active.js has wrappers
})(window);

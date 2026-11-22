// Subscription limits shared by Search, Active and Statistics.
/* exported initHeaderLimits, markLimitsRequested, syncHeaderLimits, updateHeaderLimits -- used by other page scripts */
const LIMITS_POLL_MS = 60000;
const LIMITS_SEPARATOR = " · ";
let headerLimitsData = {};
let limitsTimer = null;
let limitsRequest = null;
let limitsRequestedAt = -Infinity;
let limitsSequence = 0;
let appliedLimitsSequence = 0;

function markLimitsRequested() {
  limitsRequestedAt = Date.now();
  return ++limitsSequence;
}

function headerLimitsIdle() {
  return pageVisible() && state.view !== "active";
}

function syncHeaderLimits() {
  window.clearTimeout(limitsTimer);
  if (!headerLimitsIdle()) {
    limitsRequest?.abort();
    return;
  }
  if (!limitsRequest) {
    const delay = Math.max(0, limitsRequestedAt + LIMITS_POLL_MS - Date.now());
    limitsTimer = window.setTimeout(pollHeaderLimits, delay);
  }
}

async function pollHeaderLimits() {
  if (!headerLimitsIdle()) return;
  const request = new AbortController();
  limitsRequest = request;
  const seq = markLimitsRequested();
  try {
    const data = await api("/api/limits", null, request.signal);
    if (!request.signal.aborted) updateHeaderLimits(data, seq);
  } catch {
    // Keep the last numbers while the server is unavailable.
  } finally {
    limitsRequest = null;
    syncHeaderLimits();
  }
}

function updateHeaderLimits({ limits, codex_limits }, seq) {
  if (seq < appliedLimitsSequence) return;
  appliedLimitsSequence = seq;
  headerLimitsData = { limits, codex_limits };
  renderHeaderLimits(headerLimitsData);
}

function headerLimitsModel(data, claudeInstalled) {
  const shortLabels = { five_hour: i18n("active.limit.fiveHour"), seven_day: i18n("active.limit.week") };
  const clock = { hour: "2-digit", minute: "2-digit" };
  const calendar = { day: "2-digit", month: "2-digit" };
  const when = iso => {
    const d = new Date(iso);
    return d - Date.now() < 864e5 ? d.toLocaleTimeString(I18N.locale(), clock)
      : d.toLocaleDateString(I18N.locale(), calendar);
  };
  const stamp = iso => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(I18N.locale(), clock);
    return d.toDateString() === new Date().toDateString() ? time
      : d.toLocaleDateString(I18N.locale(), calendar) + " " + time;
  };
  const pct = w => `${Math.round(w.used_percentage)}%`;
  const full = [];
  const compact = [];
  const hints = [];
  let highest = null;
  for (const [name, raw] of [["Claude", data.limits], ["Codex", data.codex_limits]]) {
    const limits = AtlasLogic.limitsText(raw, when);
    if (!limits) {
      if (name === "Claude") {
        full.push({ text: i18n("active.limitsNone"), tone: "none" });
        if (claudeInstalled) hints.push(i18n("active.limitsSetup", {
          snippet: '"statusLine": {"type": "command", "command": "python3.11 ~/Code/session-atlas/tools/statusline.py"}',
        }));
      }
      continue;
    }
    const tone = limits.tone;
    const windows = raw.windows.map(w => {
      const label = shortLabels[w.key] || w.label;
      return w.used_percentage >= 100 ? i18n("active.limitReached", {
        label, until: w.resets_at ? i18n("logic.limits.until", { when: when(w.resets_at) }) : "",
      }) : `${label} ${pct(w)}`;
    }).join(LIMITS_SEPARATOR) + (limits.age ? i18n("active.limitsAge", { age: limits.age }) : "");
    full.push({ text: i18n(name === "Claude" ? "active.limitsClaude" : "active.limitsCodex", { limits: windows }), tone });
    const peak = raw.windows.reduce((best, w) => w.used_percentage > best.used_percentage ? w : best);
    const summary = { text: `${name} ${pct(peak)}`, tone };
    compact.push(summary);
    if (!highest || peak.used_percentage > highest.used) {
      highest = { ...summary, used: peak.used_percentage };
    }
    const details = limits.text.replace(/^[^:]*: /, "");
    const time = raw.captured_at ? stamp(raw.captured_at) : "?";
    hints.push(name === "Claude"
      ? i18n("active.limitsHint", { limits: details })
        + (limits.age && raw.captured_at ? i18n("active.limitsAsOf", { time }) : "")
      : i18n(raw.source === "live" ? "active.limitsCodexLive" : "active.limitsCodexRun", { limits: details, time }));
  }
  const label = full.map(part => part.text).join(LIMITS_SEPARATOR);
  return { variants: highest ? [full, compact, [highest]] : [full], label, title: [label, ...hints].join("\n") };
}

function pickHeaderLimits(widths, available) {
  return widths.findIndex(width => width <= available);
}

function fitHeaderLimits() {
  const slot = $("#header-limits-slot");
  const versions = Array.from($("#header-limits").children);
  const selected = pickHeaderLimits(versions.map(v => v.getBoundingClientRect().width),
    slot.getBoundingClientRect().width);
  versions.forEach((v, i) => v.classList.toggle("shown", i === selected));
}

function renderHeaderLimits(data) {
  const header = $("#header-limits");
  const model = headerLimitsModel(data, window.ATLAS_CLAUDE_INSTALLED === true);
  header.setAttribute("aria-label", model.label);
  header.replaceChildren(...model.variants.map(parts => {
    const version = el("span", "header-limits-version");
    version.setAttribute("aria-hidden", "true");
    parts.forEach(({ text, tone }, i) => {
      if (i) version.append(LIMITS_SEPARATOR);
      version.append(el("span", "limits " + tone, text));
    });
    return version;
  }));
  fitHeaderLimits();
  setTipText(header, model.title);
}

function initHeaderLimits() {
  renderHeaderLimits(headerLimitsData);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fitHeaderLimits).observe($("#header-limits-slot"));
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(() => renderHeaderLimits(headerLimitsData))
      .observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }
}

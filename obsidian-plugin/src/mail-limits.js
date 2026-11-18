// Only publish the structured status derived from the terminal, never its screen text.
const HOUR = 3600000;
const CLAUDE_ERROR = /^(?:⎿\s+)?You['’]ve hit your (?:5-hour |weekly |usage )?limit\b/i;
const CLAUDE_PAUSED = /^(?:[⏺●•]\s+)?Usage limit reached(?:\s+·|$)/i;
const CODEX_ERROR = /^■\s+You['’]ve hit your (?:usage|rate) limit\b/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE = /^\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+at|,)?\s+/i;
const TIME = /^\s*(?:(tomorrow)(?: at)?\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?(?:\s*\(([A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*)\))?(?![A-Za-z0-9:])/i;

function clockText(text) {
  const date = DATE.exec(text);
  const match = TIME.exec(date ? text.slice(date[0].length) : text);
  if (!match || (!match[3] && !match[4])) return null;
  const [, tomorrow, hour, minute, meridiem, zone] = match;
  const h = Number(hour);
  if (meridiem ? h < 1 || h > 12 : h > 23) return null;
  const month = date ? MONTHS.findIndex(m => date[1].toLowerCase().startsWith(m.toLowerCase())) : null;
  const day = date ? Number(date[2]) : null;
  const prefix = date && month >= 0 ? `${MONTHS[month]} ${day} at ` : tomorrow ? "tomorrow at " : "";
  const label = prefix + hour + (minute ? ":" + minute : "")
    + (meridiem ? " " + meridiem.toUpperCase() : "") + (zone ? ` (${zone})` : "");
  return { label, tomorrow: !!tomorrow, zone, month, day,
    hour: meridiem ? h % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0) : h,
    minute: Number(minute || 0) };
}

// Translate a wall-clock reset to an instant without depending on the host being in that zone.
function resetInstant(clock, now) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: clock.zone, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
    });
    const wallTime = (ms) => {
      const p = Object.fromEntries(fmt.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    };
    const wallNow = wallTime(now);
    const d = new Date(wallNow);
    const year = d.getUTCFullYear();
    let wall = clock.month === null
      ? Date.UTC(year, d.getUTCMonth(), d.getUTCDate() + Number(clock.tomorrow), clock.hour, clock.minute)
      : Date.UTC(year, clock.month, clock.day, clock.hour, clock.minute);
    if (clock.month !== null && d.getUTCMonth() === 11 && clock.month === 0) {
      wall = Date.UTC(year + 1, clock.month, clock.day, clock.hour, clock.minute);
    }
    if (clock.month !== null && (new Date(wall).getUTCMonth() !== clock.month || wall - wallNow > 8 * 24 * HOUR)) return null;
    const instant = (target) => {
      const first = target - (wallNow - Math.floor(now / 1000) * 1000);
      const adjusted = first + target - wallTime(first);
      return wallTime(adjusted) === target ? adjusted : null;
    };
    const today = instant(wall);
    if (today === null || today > now) return today;
    if (clock.month !== null) return today;
    if (clock.tomorrow) return null;
    // Implicit next day only for a reset a few hours away across midnight.
    const next = instant(wall + 24 * HOUR);
    return next !== null && next - now <= 6 * HOUR ? next : today;
  } catch {
    return null; // the provided time-zone label was not recognised
  }
}

function screenLimit(lines, agent) {
  const rows = lines.slice(-32).map(line => line.trim());
  if (agent === "claude") {
    const paused = rows.findLast(line => CLAUDE_PAUSED.test(line));
    const error = rows.findLastIndex(line => CLAUDE_ERROR.test(line));
    const after = rows.slice(error + 1);
    const prompts = after.filter(line => /^❯\s+\S/.test(line));
    if (!paused && (error < 0 || prompts.length > 1 || after.some(line => /esc to interrupt/i.test(line)))) return null;
    const reported = error < 0 ? "" : rows.slice(error, error + 3).join(" ");
    // The detailed error usually supplies the time zone, the pinned footer may omit it.
    return { clock: clockText(reported.split(/\bresets\b/i)[1] || "")
        || clockText((paused || "").split(/\bautomatically at\b/i)[1] || "") };
  }
  if (agent === "codex") {
    const error = rows.findLastIndex(line => CODEX_ERROR.test(line));
    const after = rows.slice(error + 1);
    const prompts = after.filter(line => /^›\s+\S/.test(line) && !/^›\s+\d+\./.test(line));
    if (error < 0 || prompts.length > 1 || after.some(line => /esc to interrupt\)|^• Worked for /.test(line))) return null;
    const text = rows.slice(error, error + 5).join(" ");
    return { clock: clockText(text.split(/\btry again at\b/i)[1] || "") };
  }
  return null;
}

class MailLimits {
  constructor() { this.observed = new Map(); }

  forTab(id, agent, lines, now) {
    const screen = screenLimit(lines, agent);
    if (!screen) {
      this.observed.delete(id);
      return null;
    }
    const label = screen.clock?.label || null;
    let snapshot = this.observed.get(id);
    if (!snapshot || snapshot.reset_text !== label) {
      const reset = screen.clock && resetInstant(screen.clock, now);
      snapshot = { reset_text: label, reset_at: reset == null ? null : new Date(reset).toISOString(),
                   expires_at: new Date(reset ?? now + HOUR).toISOString() };
      this.observed.set(id, snapshot);
    }
    return Date.parse(snapshot.expires_at) > now ? snapshot : null;
  }

  retain(ids) {
    for (const id of this.observed.keys()) if (!ids.has(id)) this.observed.delete(id);
  }
}

export { MailLimits, screenLimit };

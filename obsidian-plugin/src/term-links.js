// Local paths on an agent tab's screen become links: Claude Code and Codex print them as plain text
// (`~/Code/app/docs/plan.md`, `src/main.rs:12`). A path is a link only when it exists on disk, so
// numbers and prose with slashes stay text. Plain functions over an xterm buffer: the browser test
// runs them on the real xterm.js (tests/e2e/terminal-links.spec.mjs); the disk check is open-path.js.

// Characters that end a path. A space does too, but a path may go on past it (`Mobile Documents/…`).
const STOP = new Set(" \t\"'`<>()[]{}|,;«»“”‘’".split(""));
const TRAILING = new Set(".,:;!?…".split(""));
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;
const MAX_SPACES = 6;
// A hover must stay instant: longer lines are not searched, and a line gets this many disk checks.
const MAX_LINE = 2000;
const MAX_CHECKS = 200;
// Only tokens that can be paths are checked on disk: with a slash, `~/`, or a file name with an extension.
const PATHLIKE = /^(?:~\/|\/|\.{1,2}\/|[^/]+\/)|^\.?[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+-]*\.[\p{L}\p{N}]{1,10}$|^\.[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
// Only these go on past a space: `~/…`, `/…`, `./…`, or a word with a slash.
const SPACED_START = /^(?:~\/|\/|\.{1,2}\/|[^/]+\/)/;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*/gi;
// Editor links Codex writes for file citations (its `file_opener`), opened here instead of in an editor.
const EDITOR_LINK = /^(?:vscode|vscode-insiders|cursor|windsurf):\/\/file(\/.*)$/i;

/** The path inside a link the terminal got (OSC 8): file:// or an editor link; null for web links. */
function localTarget(uri) {
  const text = String(uri || "");
  let raw = null;
  if (/^file:\/\//i.test(text)) raw = text.replace(/^file:\/\/[^/]*/i, "");
  else if (EDITOR_LINK.test(text)) raw = text.replace(EDITOR_LINK, "$1");
  if (raw === null) return null;
  try { raw = decodeURIComponent(raw); } catch { /* keep as is */ }
  return raw.replace(LINE_SUFFIX, "") || null;
}

/** Without the punctuation at the end. A loop: a regex here backtracks over long runs of dots. */
function trimTrailing(text) {
  let end = text.length;
  while (end > 0 && TRAILING.has(text[end - 1])) end--;
  return text.slice(0, end);
}

/** Trailing punctuation off, then the line number (`:12:3`, `#L12`): what is shown and what is opened. */
function clean(token) {
  const shown = trimTrailing(token);
  return { shown, file: trimTrailing(shown.replace(LINE_SUFFIX, "")) };
}

/** End of the token that starts at i: the first stop character. */
function tokenEnd(text, i) {
  let j = i;
  while (j < text.length && !STOP.has(text[j])) j++;
  return j;
}

/** The token at i as a path: {end, path} or null. */
function tryToken(text, i, end, check) {
  const { shown, file } = clean(text.slice(i, end));
  if (!file || !PATHLIKE.test(file)) return null;
  const full = check(file);
  return full ? { end: i + shown.length, path: full } : null;
}

/**
 * Paths in one line of text: [{start, end, path, cont}], string indices, end exclusive.
 * `check(raw)` returns the absolute path or null. `next` is the following line: a long path the
 * program broke at the screen edge goes on there; `cont` is then {start, end} in `next`.
 */
function findPaths(text, check, next = null) {
  const out = [];
  if (String(text).length > MAX_LINE) return out;
  let budget = MAX_CHECKS;
  const limited = check;
  check = (raw) => (budget-- > 0 ? limited(raw) : null);
  const urls = [];
  for (const m of String(text).matchAll(URL)) urls.push([m.index, m.index + m[0].length]);
  let i = 0;
  while (i < text.length) {
    if (STOP.has(text[i])) { i++; continue; }
    const end = tokenEnd(text, i);
    if (urls.some(([a, b]) => i >= a && i < b)) { i = end; continue; }
    let found = tryToken(text, i, end, check);
    // Past spaces, for a token that is already a path: the longest form that exists wins
    // (`~/Library/Mobile Documents/…/note.md`). Never into a web address.
    let to = end;
    const extendable = SPACED_START.test(text.slice(i, end));
    for (let n = 0; extendable && n < MAX_SPACES && text[to] === " " && to + 1 < text.length
         && !STOP.has(text[to + 1]) && !urls.some(([a]) => a === to + 1); n++) {
      to = tokenEnd(text, to + 1);
      const longer = tryToken(text, i, to, check);
      if (longer) found = longer;
    }
    // Reaching the line end, it may go on in the next line's first word: the program broke a long
    // path at the screen edge. The joined path wins over its first half (`…/Code/` + `app/x.md`).
    const reach = Math.max(end, to);
    if (next && reach === text.length) {
      const lead = next.length - next.trimStart().length;
      const nextEnd = tokenEnd(next, lead);
      if (nextEnd > lead) {
        const head = text.slice(i, reach);
        const { shown, file } = clean(head + next.slice(lead, nextEnd));
        const full = PATHLIKE.test(file) ? check(file) : null;
        if (full && shown.length > head.length) {
          out.push({ start: i, end: reach, path: full, cont: { start: lead, end: lead + shown.length - head.length } });
          break;
        }
      }
    }
    if (found) {
      out.push({ start: i, end: found.end, path: found.path, cont: null });
      i = found.end;
      continue;
    }
    i = end;
  }
  return out;
}

/** A logical line of the buffer (rows joined where xterm wrapped them): its text and each char's cell. */
function logicalLine(buffer, row) {
  let top = row;
  while (top > 0 && buffer.getLine(top) && buffer.getLine(top).isWrapped) top--;
  let text = "";
  const cells = [];
  let y = top;
  for (let line = buffer.getLine(y); line && (y === top || line.isWrapped); line = buffer.getLine(++y)) {
    const row = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      row.push({ x: x + 1, w: cell.getWidth(), chars: cell.getChars() });
    }
    // A wide character that did not fit leaves an empty last cell before the wrap: not a space.
    const nextLine = buffer.getLine(y + 1);
    if (nextLine && nextLine.isWrapped) while (row.length && row[row.length - 1].chars === "") row.pop();
    for (const c of row) {
      const chars = c.chars || " ";
      // Every UTF-16 unit of a character (an emoji, a letter with a combining mark) maps to its cell.
      for (let k = 0; k < chars.length; k++) cells.push({ x: c.x, w: c.w, y: y + 1 });
      text += chars;
    }
  }
  const trimmed = text.replace(/\s+$/, "");
  return { top, bottom: y - 1, text: trimmed, cells: cells.slice(0, trimmed.length) };
}

/** Links on one screen row (1-based y), with paths that began on the line above. */
function linksOnRow(buffer, y, check) {
  const row = y - 1;
  if (!buffer.getLine(row)) return [];
  const cur = logicalLine(buffer, row);
  const after = buffer.getLine(cur.bottom + 1) ? logicalLine(buffer, cur.bottom + 1) : null;
  const before = cur.top > 0 ? logicalLine(buffer, cur.top - 1) : null;
  const segments = [];
  const span = (line, a, b, target) => {
    for (let k = a; k < b; k++) {
      const cell = line.cells[k];
      const last = segments[segments.length - 1];
      const right = cell.x + cell.w - 1;            // a wide character covers both its cells
      if (last && last.path === target && last.y === cell.y && cell.x <= last.x2 + 1 && last.line === line) {
        last.x2 = Math.max(last.x2, right);
      } else segments.push({ line, y: cell.y, x1: cell.x, x2: right, path: target });
    }
  };
  if (before) {
    for (const m of findPaths(before.text, check, cur.text)) if (m.cont) span(cur, m.cont.start, m.cont.end, m.path);
  }
  for (const m of findPaths(cur.text, check, after && after.text)) {
    span(cur, m.start, m.end, m.path);
    if (m.cont && after) span(after, m.cont.start, m.cont.end, m.path);
  }
  return segments.filter((s) => s.y === y).map(({ y: sy, x1, x2, path: target }) => ({ y: sy, x1, x2, path: target }));
}

/**
 * An xterm link provider for local paths: the underline and the hint. `check(raw, cwd)` gives the
 * absolute path of one that exists; `cwd()` the folder relative paths are read from (may be a promise).
 * A click is not taken from here: xterm drops the hovered link whenever the program redraws the
 * screen (Claude Code's status line does all the time), and a click then went nowhere.
 */
function pathLinkProvider(term, { cwd, hover, leave, check }) {
  return {
    provideLinks(y, callback) {
      Promise.resolve(typeof cwd === "function" ? cwd() : cwd).catch(() => null).then((dir) => {
        const links = linksOnRow(term.buffer.active, y, (raw) => check(raw, dir)).map((s) => ({
          range: { start: { x: s.x1, y: s.y }, end: { x: s.x2, y: s.y } },
          text: s.path,
          decorations: { pointerCursor: true, underline: true },
          activate: () => {},                         // pathClicks opens it
          hover: (event) => hover && hover(s.path, event),
          leave: () => leave && leave(s.path),
        }));
        callback(links.length ? links : undefined);
      }, () => callback(undefined));
    },
  };
}

/** The path under a point of the terminal's screen, or null. */
function pathAtPoint(term, clientX, clientY, check) {
  const screen = term.element && term.element.querySelector(".xterm-screen");
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  const col = Math.floor((clientX - rect.left) / (rect.width / term.cols)) + 1;
  const row = Math.floor((clientY - rect.top) / (rect.height / term.rows));
  if (col < 1 || col > term.cols || row < 0 || row >= term.rows) return null;
  const buffer = term.buffer.active;
  const hit = linksOnRow(buffer, buffer.viewportY + row + 1, check).find((s) => s.x1 <= col && col <= s.x2);
  return hit ? hit.path : null;
}

const CLICK_SLOP_PX = 4;

/**
 * Clicks on paths, read from the point clicked: a left click that is not a drag or a selection
 * (⌥ or Shift held) opens the path under it. `taken(event)` tells a click a link the program
 * marked (OSC 8) already handled: asked after xterm's own handlers. Returns a function that removes
 * the listeners.
 */
function pathClicks(term, { cwd, open, check, taken }) {
  const el = term.element;
  let down = null;
  const onDown = (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
  const onUp = (e) => {
    const start = down;
    down = null;
    if (!start || e.button !== 0 || e.altKey || e.shiftKey) return;
    if (Math.abs(e.clientX - start.x) > CLICK_SLOP_PX || Math.abs(e.clientY - start.y) > CLICK_SLOP_PX) return;
    window.setTimeout(() => {
      if (taken && taken(e)) return;
      Promise.resolve(typeof cwd === "function" ? cwd() : cwd).catch(() => null).then((dir) => {
        const full = pathAtPoint(term, e.clientX, e.clientY, (raw) => check(raw, dir));
        if (full) open(full, e);
      });
    }, 0);
  };
  // Capture: before xterm hands the click to a program that holds the mouse.
  el.addEventListener("mousedown", onDown, true);
  el.addEventListener("mouseup", onUp, true);
  return () => {
    el.removeEventListener("mousedown", onDown, true);
    el.removeEventListener("mouseup", onUp, true);
  };
}

export { pathAtPoint, pathClicks, findPaths, localTarget, linksOnRow, logicalLine, pathLinkProvider, clean };

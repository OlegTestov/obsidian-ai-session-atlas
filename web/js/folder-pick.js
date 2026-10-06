// The folder field of "+ Session": an editable path with suggestions (WAI-ARIA combobox, list autocomplete).
// Suggestions: the folders sessions ran in (with their counts) and the real subfolders of what is typed
// (POST /api/folders). The field takes a pasted absolute path, `~/…` or the vault form `<vault>/…`;
// the server resolves and checks it on Start. Classic script: shares one global scope with the other page files.
/* exported folderPickOpen, folderPickValue, folderPickFocus -- used by other page scripts */

(function (root) {
  const fold = (s) => String(s || "").toLocaleLowerCase();
  const SEP = /[/\s._-]/;

  /** Characters of the word in order, gaps allowed: "bilapi" finds "billing-api". */
  function inOrder(word, text) {
    let at = 0;
    for (const c of word) {
      at = text.indexOf(c, at);
      if (at < 0) return false;
      at += 1;
    }
    return true;
  }

  /** Lower is better, Infinity is no match: whole text, its start, a part's start, inside, scattered. */
  function wordScore(word, text) {
    if (text === word) return 0;
    if (text.startsWith(word)) return 1;
    let best = Infinity;
    for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
      best = Math.min(best, SEP.test(text[i - 1]) ? 2 : 3);
    }
    if (best < Infinity) return best;
    return inOrder(word, text) ? 4 : Infinity;
  }

  /** Every word of the query must match the folder's field text; the worst word decides. */
  function score(query, item) {
    const text = fold(item.text);
    const words = fold(query).split(/\s+/).filter(Boolean);
    return words.length ? Math.max(...words.map((w) => wordScore(w, text))) : 0;
  }

  /** Known folders matching the query, best first; ties: recent, more sessions, the server's order. */
  function rankKnown(query, known) {
    if (!query.trim()) return known.slice();
    return known.map((k, i) => ({ k, i, s: score(query, k) }))
      .filter((x) => x.s < Infinity)
      .sort((a, b) => a.s - b.s || (b.k.recent ? 1 : 0) - (a.k.recent ? 1 : 0)
        || (b.k.sessions || 0) - (a.k.sessions || 0) || a.i - b.i)
      .map((x) => x.k);
  }

  /** A path being typed (subfolders first) or a name to look up (known folders first). */
  function looksLikePath(text) {
    const q = text.trim();
    return q.startsWith("/") || q.startsWith("~") || q.includes("/");
  }

  /**
   * The list under the field. Empty field: the known folders as the server orders them (recent first).
   * Otherwise subfolders from the listing and known folders that match, without repeats. A listing for an
   * earlier text still helps while the new one is on its way: only its folders that continue the text stay.
   */
  function suggest(text, known, listing, limit = 50) {
    const q = text.trim();
    const byPath = new Map(known.map((k) => [k.path, k]));
    const asItem = (d, kind) => {
      const k = byPath.get(d.path);
      return { path: d.path, text: d.text, kind, sessions: k ? k.sessions || 0 : 0, recent: !!(k && k.recent) };
    };
    if (!q) return known.slice(0, limit).map((k) => asItem(k, "known"));
    let dirs = [];
    if (listing && Array.isArray(listing.dirs)) {
      dirs = listing.text === text ? listing.dirs : listing.dirs.filter((d) => fold(d.text).startsWith(fold(q)));
    }
    const fromDirs = dirs.map((d) => asItem(d, "dir"));
    const fromKnown = rankKnown(q, known).map((k) => asItem(k, "known"));
    const out = [];
    const seen = new Set();
    for (const it of looksLikePath(q) ? fromDirs.concat(fromKnown) : fromKnown.concat(fromDirs)) {
      if (seen.has(it.path)) continue;
      seen.add(it.path);
      out.push(it);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Arrow keys over the list, wrapping; -1 is "nothing highlighted" (the text as typed). */
  function step(count, active, key) {
    if (!count) return -1;
    if (key === "ArrowDown") return active < 0 ? 0 : (active + 1) % count;
    if (key === "ArrowUp") return active <= 0 ? count - 1 : active - 1;
    return active;
  }

  /** Tab goes into the folder: its text with a slash, so the next list is what is inside it. */
  function completion(item) {
    return item.text.endsWith("/") ? item.text : item.text + "/";
  }

  /** The list's height: down to the Start row (and the window's edge), never under a few rows. */
  function listMaxHeight(fieldBottom, stopAt, min = 96, max = 320) {
    return Math.round(Math.max(min, Math.min(max, stopAt - fieldBottom - 8)));
  }

  /** The line under the field: the resolved folder, or what is wrong once nothing else helps. */
  function hint(text, listing, items) {
    if (!text.trim() || !listing || listing.text !== text) return { kind: "", text: "" };
    if (listing.folder) {
      const shown = listing.folder.path !== text.trim() ? listing.folder.path : "";
      return { kind: "ok", text: shown };
    }
    if (listing.error && !items.length) return { kind: "bad", text: listing.error };
    return { kind: "", text: "" };
  }

  root.FolderPick = { score, rankKnown, looksLikePath, suggest, step, completion, listMaxHeight, hint };
})(window);

let fpKnown = [];          // /api/workdirs: folders sessions ran in, then project roots
let fpListing = null;      // the last /api/folders answer
let fpItems = [];
let fpActive = -1;
let fpSeq = 0;
let fpTimer = 0;
let fpWanted = false;      // the list should show whenever it has items: typing, focus, arrows; not after Esc or a pick

function fpInput() { return document.getElementById("ns-dir"); }
function fpList() { return document.getElementById("ns-dir-list"); }

function folderPickValue() { return fpInput().value; }
function folderPickFocus() { fpInput().focus(); }

function fpIsOpen() { return !fpList().hidden; }

function fpClose() {
  fpWanted = false;
  fpList().hidden = true;
  fpActive = -1;
  fpInput().setAttribute("aria-expanded", "false");
  fpInput().removeAttribute("aria-activedescendant");
}

// The folder's name stays readable; a long parent path gives way first (ellipsis, full path on hover).
function fpOptionText(it) {
  const cut = it.text.replace(/\/$/, "").lastIndexOf("/") + 1;
  const box = el("span", "fp-text");
  box.append(el("span", "fp-dir", it.text.slice(0, cut)), el("span", "fp-name", it.text.slice(cut)));
  return box;
}

function fpRender(open) {
  const input = fpInput();
  const list = fpList();
  fpItems = FolderPick.suggest(input.value, fpKnown, fpListing);
  if (fpActive >= fpItems.length) fpActive = -1;
  list.replaceChildren(...fpItems.map((it, i) => {
    const row = el("li", "fp-opt" + (it.recent ? " recent" : ""));
    row.id = `ns-dir-opt-${i}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", i === fpActive ? "true" : "false");
    row.title = it.path;
    row.append(fpOptionText(it), el("span", "fp-side", it.sessions ? i18nN("newsess.sessions", it.sessions) : ""));
    row.addEventListener("mousedown", (e) => e.preventDefault());     // the field keeps focus
    row.addEventListener("click", () => fpPick(it));
    return row;
  }));
  if (open) fpWanted = true;
  const show = fpWanted && fpItems.length > 0 && document.activeElement === input;
  list.hidden = !show;
  input.setAttribute("aria-expanded", show ? "true" : "false");
  if (show && fpActive >= 0) {
    input.setAttribute("aria-activedescendant", `ns-dir-opt-${fpActive}`);
    list.children[fpActive].scrollIntoView({ block: "nearest" });
  } else input.removeAttribute("aria-activedescendant");
  if (show) fpFit();
  fpShowHint();
}

// The list overlays the prompt but stops above the Start row and inside the window.
function fpFit() {
  const field = fpInput().getBoundingClientRect();
  const actions = document.querySelector("#newsess .actions").getBoundingClientRect();
  const stopAt = Math.min(actions.top, window.innerHeight);
  fpList().style.maxHeight = FolderPick.listMaxHeight(field.bottom, stopAt) + "px";
}

function fpShowHint() {
  const h = FolderPick.hint(fpInput().value, fpListing, fpItems);
  const line = document.getElementById("ns-dir-hint");
  line.textContent = h.text;
  line.className = "fp-hint" + (h.kind ? " " + h.kind : "");
  if (h.kind === "bad") fpInput().setAttribute("aria-invalid", "true");
  else fpInput().removeAttribute("aria-invalid");
}

async function fpFetch() {
  const text = fpInput().value;
  const seq = ++fpSeq;
  if (!text.trim()) { fpListing = null; fpRender(false); return; }
  let r;
  try { r = await api("/api/folders", { text }); } catch { return; }
  if (seq !== fpSeq || fpInput().value !== text) return;      // only the answer to the latest text
  fpListing = r;
  fpRender(false);
}

function fpSchedule() {
  window.clearTimeout(fpTimer);
  fpTimer = window.setTimeout(fpFetch, 120);
}

function fpSet(text, open) {
  fpInput().value = text;
  fpActive = -1;
  fpRender(open);
  fpSchedule();
}

function fpPick(it) {
  fpSet(it.text, false);
  fpClose();
}

/** Fills the field when the dialog opens; the known folders arrive once the server answers. */
async function folderPickOpen(remembered) {
  fpKnown = [];
  fpListing = null;
  fpInput().value = "";
  fpClose();
  fpShowHint();
  const quick = document.getElementById("ns-dir-quick");
  quick.replaceChildren();
  const r = await api("/api/workdirs");
  fpKnown = r.workdirs || [];
  quick.replaceChildren(...(r.roots || []).map((root) => {
    const b = el("button", "chip fp-root", root.kind === "home" ? i18n("newsess.home")
      : i18n("newsess.vaultRoot", { name: root.text }));
    b.type = "button";
    b.title = root.path;
    b.addEventListener("click", () => { fpInput().focus(); fpPick(root); });
    return b;
  }));
  // As the select did: the last folder a session started in, else the most recent one.
  const last = fpKnown.find((k) => k.path === remembered);
  const start = last ? last.text : remembered || (fpKnown[0] && fpKnown[0].text) || "";
  // Typing started before the folders arrived: the default would land inside the typed text.
  const typing = document.activeElement === fpInput() || fpInput().value;
  if (start && !typing) fpSet(start, false);
  else fpRender(false);
}

fpInput().addEventListener("input", () => { fpActive = -1; fpRender(true); fpSchedule(); });
fpInput().addEventListener("focus", () => fpRender(true));
fpInput().addEventListener("click", () => { if (!fpIsOpen()) fpRender(true); });
fpInput().addEventListener("blur", () => fpClose());
fpInput().addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const open = fpIsOpen();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!open) { fpRender(true); return; }
    fpActive = FolderPick.step(fpItems.length, fpActive, e.key);
    fpRender(true);
  } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (open && fpActive >= 0) fpPick(fpItems[fpActive]);
    else fpClose();
  } else if (e.key === "Escape" && open) {
    e.preventDefault();               // closes the list, not the dialog
    e.stopPropagation();
    fpClose();
  } else if (e.key === "Tab" && !e.shiftKey && open && fpActive >= 0) {
    e.preventDefault();
    fpSet(FolderPick.completion(fpItems[fpActive]), true);
  }
});

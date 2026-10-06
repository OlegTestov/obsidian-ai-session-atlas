// Active: the reply field with slash-command hints, sent history and drafts.
// Classic script: shares one global scope with the other page files.
/* exported rememberSent, enhanceComposer -- used by other page scripts */
// localStorage here is a single-browser convenience: losing it is harmless, so everything is in try.
const DRAFTS_KEY = "atlas.drafts";
const HISTORY_KEY = "atlas.sentHistory";
const HISTORY_MAX = 50;
let commandList = null;

// Drafts survive a reload of the page and of the Obsidian tab.
(function restoreDrafts() {
  const saved = loadStored(DRAFTS_KEY, {});
  if (saved && typeof saved === "object") {
    Object.entries(saved).forEach(([sid, text]) => {
      if (typeof text === "string" && text) drafts.set(sid, text);
    });
  }
})();

function saveDrafts() {
  store(DRAFTS_KEY, Object.fromEntries([...drafts].filter(([, text]) => text)));
}

function rememberSent(text) {
  if (!text || !text.trim()) return;
  const history = loadStored(HISTORY_KEY, []).filter(t => t !== text);
  history.push(text);
  store(HISTORY_KEY, history.slice(-HISTORY_MAX));
}

async function ensureCommands() {
  if (commandList) return commandList;
  try { commandList = (await api("/api/commands")).commands || []; }
  catch { commandList = []; }
  return commandList;
}

// The arrow walks the history only when the caret is at the text edge: otherwise it is for editing.
function onEdge(area, dir) {
  const before = area.value.slice(0, area.selectionStart);
  const after = area.value.slice(area.selectionEnd);
  return dir === "up" ? !before.includes("\n") : !after.includes("\n");
}

/**
 * Reply field behaviour. Returns the hint dropdown, which the caller places next to the field.
 * opts.commands === false: no slash-command hints (the list is Claude Code's).
 */
function enhanceComposer(area, sid, submit, opts) {
  const hints = !opts || opts.commands !== false;
  const pop = el("div", "suggest hidden");
  pop.setAttribute("role", "listbox");
  let items = [];
  let active = 0;
  let histIndex = -1;
  let own = "";

  const close = () => { items = []; pop.classList.add("hidden"); };
  const render = () => {
    pop.replaceChildren(...items.map((c, i) => {
      const row = el("div", "sug" + (i === active ? " on" : ""));
      row.setAttribute("role", "option");
      row.append(el("b", null, "/" + c.name), el("span", null, c.description || ""));
      // mousedown, not click: otherwise the field loses focus before the choice.
      row.addEventListener("mousedown", e => { e.preventDefault(); pick(i); });
      return row;
    }));
    pop.classList.toggle("hidden", !items.length);
    const on = pop.querySelector(".sug.on");
    if (on) on.scrollIntoView({ block: "nearest" });   // with the arrows, follow the selected row
  };
  const pick = i => {
    area.value = "/" + items[i].name + " ";
    drafts.set(sid, area.value);
    saveDrafts();
    close();
    autosize(area);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  };
  const suggest = async () => {
    if (!hints) return;
    const text = area.value;
    const list = await ensureCommands();
    if (area.value !== text) return;           // typing continued while the list loaded
    items = AtlasLogic.commandMatches(list, text);
    active = Math.min(active, Math.max(0, items.length - 1));
    render();
  };

  area.addEventListener("input", () => { histIndex = -1; saveDrafts(); suggest(); });
  area.addEventListener("blur", () => window.setTimeout(() => {
    if (document.activeElement !== area) close();       // a click on the list keeps the focus
  }, 150));
  area.addEventListener("keydown", e => {
    if (e.isComposing) return;
    if (items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        render();
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();                   // Esc closes the hints instead of leaving the field
        close();
        return;
      }
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey) {
      const dir = e.key === "ArrowUp" ? "up" : "down";
      const browsing = histIndex >= 0 || (dir === "up" && !area.value);
      if (browsing && onEdge(area, dir)) {
        const history = loadStored(HISTORY_KEY, []);
        if (histIndex === -1) own = area.value;
        const st = AtlasLogic.historyStep(history, histIndex, dir);
        if (st.index !== histIndex) {
          e.preventDefault();
          histIndex = st.index;
          area.value = st.text === null ? own : st.text;
          drafts.set(sid, area.value);
          autosize(area);
          area.setSelectionRange(area.value.length, area.value.length);
        }
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  return pop;
}

// Active from the keyboard: arrows and j/k pick a card, Enter opens the reply field, g is Go to.
// Classic script: shares one global scope with the other page files.
/* exported showKeys, selectCardByClick -- used by other page scripts */
let selectedCard = null;              // id of the selected session: survives a redraw

const cardEls = () => [...document.querySelectorAll("#active-grid .acard")];

// Keys in a 20-character column, then what they do.
const KEYS_HELP = [
  [i18n("keys.help.arrows"), i18n("keys.help.select")],
  ["Enter", i18n("keys.help.answer")],
  ["g", i18n("keys.help.go")],
  ["f", i18n("keys.help.feed")],
  ["p / h", i18n("keys.help.pinHide")],
  ["Esc", i18n("keys.help.esc")],
  ["⌘K", i18n("keys.help.jump")],
].map(([keys, what]) => keys.padEnd(20) + what).join("\n");

function showKeys() {
  modal(i18n("keys.title"), i18n("keys.intro"), KEYS_HELP);
  $("#m-copy").classList.add("hidden");       // no reason to copy the help
}

function applySelection(scroll) {
  const cards = cardEls();
  if (selectedCard && !cards.some(c => c.dataset.id === selectedCard)) selectedCard = null;
  cards.forEach(c => {
    const on = c.dataset.id === selectedCard;
    c.classList.toggle("sel", on);
    if (on && scroll) c.scrollIntoView({ block: "nearest" });
  });
}

// Columns in the grid of the section holding the selection: up/down moves by a row of that grid.
function columnsAt(id) {
  const card = cardEls().find(c => c.dataset.id === id) || cardEls()[0];
  const grid = card && card.closest(".agrid");
  if (!grid) return 1;
  return getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
}

function focusAnswer(id) {
  const find = () => document.querySelector(`.answer textarea[data-id="${CSS.escape(id)}"]`);
  if (!find() && activeMode !== "full") {
    // The compact view has no field: replies are written in the detailed one.
    const full = document.querySelector('.mode button[data-mode="full"]');
    if (full) full.click();
  }
  const area = find();
  if (area && !area.disabled) area.focus();
}

document.addEventListener("keydown", e => {
  if (state.view !== "active" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const target = e.target;
  if (target && target.tagName === "TEXTAREA" && e.key === "Escape") {
    // From the field back to the cards; the selection stays on this one.
    selectedCard = target.dataset.id || selectedCard;
    target.blur();
    applySelection();
    return;
  }
  if (target && /^(TEXTAREA|INPUT|SELECT|BUTTON)$/.test(target.tagName)) return;
  if (document.querySelector(".ms-pop:not(.hidden), .lay-pop:not(.hidden)")) return;
  const ids = cardEls().map(c => c.dataset.id);
  if (!ids.length) return;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "j", "k"].includes(e.key)) {
    e.preventDefault();
    selectedCard = AtlasLogic.nextCard(ids, selectedCard, e.key, columnsAt(selectedCard));
    applySelection(true);
  } else if (e.key === "Enter" && selectedCard) {
    e.preventDefault();
    focusAnswer(selectedCard);
  } else if (e.key === "g" && selectedCard) {
    const card = cardEls().find(c => c.dataset.id === selectedCard);
    const go = card && [...card.querySelectorAll("button")].find(b => b.textContent === i18n("active.go"));
    if (go && !go.disabled) { e.preventDefault(); go.click(); }
  } else if (e.key === "p" && selectedCard) {
    e.preventDefault();
    togglePin(selectedCard);
  } else if (e.key === "h" && selectedCard) {
    const s = activeSessions.find(x => x.session_id === selectedCard);
    if (s) { e.preventDefault(); hideCard(s); }
  } else if (e.key === "f" && selectedCard) {
    e.preventDefault();
    if (feedSid === selectedCard) closeFeed(); else openFeed(selectedCard);
  } else if (e.key === "Escape" && feedSid) {
    closeFeed();                          // the feed closes first, then the selection clears
  } else if (e.key === "Escape" && selectedCard) {
    selectedCard = null;
    applySelection();
  }
});

// A click on a card also selects it, so the arrows continue from there. The document click listener
// is one per page (search.js), and it calls this function.
function selectCardByClick(e) {
  const card = e.target && e.target.closest && e.target.closest("#active-grid .acard");
  if (!card) return;
  selectedCard = card.dataset.id;
  applySelection();
}

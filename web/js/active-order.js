// Active: pinned cards and cards hidden until the next message. Stored in the browser.
// Classic script: shares one global scope with the other page files.
/* exported arrangeActive, unhideAll, pinButton, hideButton -- used by other page scripts */
const PINS_KEY = "atlas.pinned";
const HIDDEN_KEY = "atlas.hidden";
let pinnedCards = loadStored(PINS_KEY, []);
let hiddenCards = loadStored(HIDDEN_KEY, {});
if (!Array.isArray(pinnedCards)) pinnedCards = [];
if (!hiddenCards || typeof hiddenCards !== "object") hiddenCards = {};

// While you are on the tab, cards keep their places: nothing jumps while you read or type.
// A new session goes to the end. The waiting/working sections stay live meanwhile.
// A fresh order applies when you return to the tab (resortActive).
let frozenOrder = null;

function resortActive() {
  frozenOrder = null;
}

function arrangeActive(list) {
  const r = AtlasLogic.arrangeSessions(list, pinnedCards, hiddenCards);
  // Hidden cards that got a new message (or whose session left) are dropped.
  // Remove only against the full list: a filtered-out session has not left.
  if (list === activeSessions) {
    if (r.stale.length) {
      r.stale.forEach(id => { delete hiddenCards[id]; });
      store(HIDDEN_KEY, hiddenCards);
    }
    const f = AtlasLogic.applyFrozenOrder(r.visible, frozenOrder);
    frozenOrder = f.frozen;
    r.visible = f.list;
  } else if (frozenOrder) {
    r.visible = AtlasLogic.applyFrozenOrder(r.visible, frozenOrder).list;   // a filter does not reset the order
  }
  return r;
}

function rerenderOrder(resort) {
  if (resort) resortActive();
  lastSignature = "";
  renderActive(null, true);
}

function togglePin(sid) {
  pinnedCards = pinnedCards.includes(sid) ? pinnedCards.filter(x => x !== sid) : pinnedCards.concat(sid);
  store(PINS_KEY, pinnedCards);
  rerenderOrder(true);                    // pinned by you: the card moves to the top at once
}

function hideCard(s) {
  hiddenCards[s.session_id] = s.last_message_at || "";
  store(HIDDEN_KEY, hiddenCards);
  if (typeof selectedCard !== "undefined" && selectedCard === s.session_id) selectedCard = null;
  rerenderOrder();
}

function unhideAll() {
  hiddenCards = {};
  store(HIDDEN_KEY, hiddenCards);
  rerenderOrder();
}

function pinButton(s) {
  const on = pinnedCards.includes(s.session_id);
  const b = el("button", "pin" + (on ? " on" : ""), on ? "★" : "☆");
  b.type = "button";
  b.title = on ? i18n("active.unpin") : i18n("active.pinHint");
  b.setAttribute("aria-pressed", String(on));
  b.addEventListener("click", e => { e.stopPropagation(); togglePin(s.session_id); });
  return b;
}

function hideButton(s, mini) {
  const b = el("button", "hidebtn" + (mini ? " mini" : ""), i18n("active.hide"));
  b.type = "button";
  b.title = i18n("active.hideHint");
  b.addEventListener("click", e => { e.stopPropagation(); hideCard(s); });
  return mini ? iconify(b, HIDE_SVG, i18n("active.hideAria")) : b;
}

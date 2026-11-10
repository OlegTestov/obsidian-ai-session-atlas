// Active: unread marks. A session that finished its turn while you were away from its tab gets a dot;
// the plugin keeps the set (it polls with the page closed too), the page shows it and reports what you open.
// Marks change in place: a redraw would drop a text selection or the focus in the card you click.
// Classic script: shares one global scope with the other page files.
/* exported hostUnread, readHostUnread, unreadMark, seeCard, unreadButton -- used by other page scripts */
let hostUnread = new Set();
let hostFront = false;                   // the plugin says the Atlas tab is in front of a focused window

function readHostUnread(d) {
  hostUnread = new Set(Array.isArray(d.unread) ? d.unread.filter(id => typeof id === "string") : []);
  hostFront = d.front === true;
  // The feed open on the right is being read while the page is in view: its session stays seen.
  const inView = !document.hidden && (hostFront || document.hasFocus());
  if (feedSid && hostUnread.has(feedSid) && inView) seeCard(feedSid);
  else applyUnread();
}

function unreadDot() {
  const dot = el("span", "unread-dot");
  dot.title = i18n("active.unreadHint");
  dot.setAttribute("aria-label", i18n("active.unread"));
  return dot;
}

/** The dot before the title of an unread card; the card gets the class for its accent. */
function unreadMark(s, card) {
  if (!hostUnread.has(s.session_id)) return null;
  card.classList.add("unread");
  return unreadDot();
}

const shownCards = () => [...document.querySelectorAll("#active-grid .acard")];

/** Brings the dots and the "N new" button in line with hostUnread without redrawing the cards. */
function applyUnread() {
  for (const card of shownCards()) {
    const on = hostUnread.has(card.dataset.id);
    const dot = card.querySelector(".head .unread-dot");
    card.classList.toggle("unread", on);
    if (on && !dot) {
      const head = card.querySelector(".head");
      if (head) head.insertBefore(unreadDot(), head.children[1] || null);   // after the pin
    } else if (!on && dot) dot.remove();
  }
  const old = document.querySelector("#active-summary .unread-all");
  const fresh = unreadButton(shownCards().map(c => c.dataset.id));
  if (old && fresh) { if (old.dataset.ids !== fresh.dataset.ids) old.replaceWith(fresh); }
  else if (old) {
    const before = old.previousSibling, after = old.nextSibling;
    if (before && before.nodeType === Node.TEXT_NODE) before.remove();
    else if (after && after.nodeType === Node.TEXT_NODE) after.remove();
    old.remove();
  } else if (fresh) {
    renderActive();                      // rebuilds the summary line; unchanged cards are left alone
  }
}

const SEEN_RESEND_MS = 5000;
const seenSentAt = new Map();            // id → when the page last told the plugin, for an unmarked card
const seenLater = new Map();             // id → {timer, at}: sends the latest click at the end of the window

/** `at` is when you clicked: a held click must not cover a turn that ended while it waited. */
function sendSeen(id, at) {
  const held = seenLater.get(id);
  if (held) window.clearTimeout(held.timer);
  seenLater.delete(id);
  seenSentAt.set(id, Date.now());
  tellTabHost("seen", { ids: [id], at });
}

/** You opened the card: the plugin hears it even before it marked it, and the mark goes at once. */
function seeCard(id) {
  if (!id) return;
  const marked = hostUnread.delete(id);
  const clicked = Date.now();
  // Clicks inside an unmarked card repeat: one message per 5 s, the last click still reaches the plugin
  // (it compares the time of that click with the turn's end).
  const wait = SEEN_RESEND_MS - (clicked - (seenSentAt.get(id) || 0));
  const held = seenLater.get(id);
  if (marked || wait <= 0) sendSeen(id, clicked);
  else if (held) held.at = clicked;
  else seenLater.set(id, { at: clicked, timer: window.setTimeout(() => sendSeen(id, seenLater.get(id).at), wait) });
  if (marked) applyUnread();
}

/** "2 new" in the summary line counts the cards on screen; a click marks them seen. */
function unreadButton(shownIds) {
  const ids = shownIds.filter(id => hostUnread.has(id)).sort();   // one order for the redraw and the in-place update
  if (!ids.length) return null;
  const button = el("button", "keys unread-all", i18n("active.unreadN", { n: ids.length }));
  button.type = "button";
  button.title = i18n("active.unreadAllHint");
  button.dataset.ids = ids.join(" ");
  button.addEventListener("click", () => {
    tellTabHost("seen", { ids, at: Date.now() });
    ids.forEach(id => hostUnread.delete(id));
    applyUnread();
  });
  return button;
}

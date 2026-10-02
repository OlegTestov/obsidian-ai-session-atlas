// «Активные»: закреплённые карточки и скрытые до следующего сообщения. Хранится в браузере.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
const PINS_KEY = "atlas.pinned";
const HIDDEN_KEY = "atlas.hidden";
let pinnedCards = loadStored(PINS_KEY, []);
let hiddenCards = loadStored(HIDDEN_KEY, {});
if (!Array.isArray(pinnedCards)) pinnedCards = [];
if (!hiddenCards || typeof hiddenCards !== "object") hiddenCards = {};

// Пока ты на вкладке, карточки не переставляются: читаешь или печатаешь — ничего не прыгает.
// Новая сессия встаёт в конец. Секции «ждут тебя / работают» при этом живые.
// Свежий порядок — когда возвращаешься на вкладку (resortActive).
let frozenOrder = null;

function resortActive() {
  frozenOrder = null;
}

function arrangeActive(list) {
  const r = AtlasLogic.arrangeSessions(list, pinnedCards, hiddenCards);
  // Скрытые, у которых появилось новое сообщение (или сессия ушла), больше не держим.
  // Удаляем только по полному списку: отфильтрованная сессия не «ушла».
  if (list === activeSessions) {
    if (r.stale.length) {
      r.stale.forEach(id => { delete hiddenCards[id]; });
      store(HIDDEN_KEY, hiddenCards);
    }
    const f = AtlasLogic.applyFrozenOrder(r.visible, frozenOrder);
    frozenOrder = f.frozen;
    r.visible = f.list;
  } else if (frozenOrder) {
    r.visible = AtlasLogic.applyFrozenOrder(r.visible, frozenOrder).list;   // фильтр порядок не снимает
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
  rerenderOrder(true);                    // закрепил сам — карточка сразу встаёт наверх
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

// «Активные» с клавиатуры: стрелки и j/k — выбор карточки, Enter — поле ответа, g — «Перейти».
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
let selectedCard = null;              // id выбранной сессии: переживает перерисовку

const cardEls = () => [...document.querySelectorAll("#active-grid .acard")];

// Клавиши — столбцом в 20 знаков, затем что они делают.
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
  $("#m-copy").classList.add("hidden");       // копировать справку незачем
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

// Столбцов в сетке той секции, где стоит выбор: вверх-вниз — на ряд именно этой сетки.
function columnsAt(id) {
  const card = cardEls().find(c => c.dataset.id === id) || cardEls()[0];
  const grid = card && card.closest(".agrid");
  if (!grid) return 1;
  return getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
}

function focusAnswer(id) {
  const find = () => document.querySelector(`.answer textarea[data-id="${CSS.escape(id)}"]`);
  if (!find() && activeMode !== "full") {
    // В компактном виде поля нет: ответ пишется в подробном.
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
    // Из поля — обратно к карточкам, выбор остаётся на этой.
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
    closeFeed();                          // сначала закрывается лента, потом снимается выбор
  } else if (e.key === "Escape" && selectedCard) {
    selectedCard = null;
    applySelection();
  }
});

// Клик по карточке тоже выбирает её: дальше можно стрелками. Слушатель клика на документе
// один на страницу (search.js), он и зовёт эту функцию.
function selectCardByClick(e) {
  const card = e.target && e.target.closest && e.target.closest("#active-grid .acard");
  if (!card) return;
  selectedCard = card.dataset.id;
  applySelection();
}

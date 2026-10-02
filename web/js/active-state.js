// «Активные»: состояние, опрос сервера и связь с плагином Obsidian.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// --- вкладка «Активные» -------------------------------------------------------

const ACTIVE_POLL_MS = 5000;
const HOST_SOURCE = "session-atlas-host";
let activeSessions = [];
let hostTabs = new Map();       // PID прокси PTY → заголовок вкладки терминала
let hostReady = false;          // плагин ответил: значит, «Перейти» и «Закрыть» доступны
let hostHealth = null;          // {ok, reason} от плагина: исправна ли связь с терминалом
let tabsAskedAt = null;         // когда спросили вкладки и ещё не получили ответ
let activeTimer = null;
let activeUpdated = null;
let activeLimits = null;        // лимиты подписки из строки состояния Claude Code

// Фильтры «Активных»: в каждом списке можно отметить несколько значений, как в Excel.
const ACTIVE_FILTERS = [
  { key:"domain", label:i18n("active.filter.domain"), hash:"ad" },
  { key:"project", label:i18n("active.filter.project"), hash:"ap" },
  { key:"topic", label:i18n("active.filter.topic"), hash:"at" },
  { key:"period", label:i18n("active.filter.period"), hash:"aw" },
];
const PERIODS = AtlasLogic.PERIODS;
const activeFilter = { domain:new Set(), project:new Set(), topic:new Set(), period:new Set() };
const filterUI = {};
let activeMode = "compact";           // compact | full
// Раскладка «столбцы × ряды» для каждого вида отдельно; null — авто (как было).
const layout = { compact: null, full: null };
// Компактные карточки мелкие — им до 5 × 5; подробным с полем ответа — до 4 × 4.
const LAYOUT_MAX = { compact: 5, full: 4 };
const LAYOUT_CELLS = 5;
let layoutUI = null;
const drafts = new Map();             // id сессии → недописанный ответ: переживает опрос
const fullReplies = new Map();        // id сессии → ответ целиком, если раскрыли
const sendState = new Map();          // id сессии → {note, cls}
const pendingSends = new Map();       // nonce → id сессии
const SEND_TIMEOUT_MS = 6000;
const sentDrafts = new Map();         // nonce → что именно отправили
const attachments = new Map();        // id сессии → [{path, thumb}] — картинки к ответу
// Только что отправленное: транскрипт догонит через секунды, а видеть своё хочется сразу.
const justSent = new Map();           // id сессии → {text, images, at}
const MAX_ATTACH = 5;
let lastSignature = "";
let composing = false;                // идёт набор через IME
document.addEventListener("compositionstart", () => { composing = true; });
document.addEventListener("compositionend", () => { composing = false; });
let lastRenderAt = 0;

// Короткая дата для карточки: год только если не текущий.
function fmtShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const opts = { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "2-digit";
  return d.toLocaleString(I18N.locale(), opts);
}

const pluralRu = AtlasLogic.pluralRu;

// Кнопки вкладки — только когда плагин на связи: вне Obsidian нажимать их некуда.
function tellTabHost(type, payload) {
  if (!hostReady) return false;
  window.parent.postMessage(Object.assign({ source: "session-atlas", type }, payload), "*");
  return true;
}

// Вкладка Атласа снова на экране (плагин сообщает; вне Obsidian — видимость страницы).
function backOnScreen() {
  if (state.view !== "active") return;
  resortActive();
  rerenderOrder();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) backOnScreen(); });

window.addEventListener("message", e => {
  if (e.source !== window.parent) return;
  const d = e.data;
  if (d && d.source === HOST_SOURCE && d.type === "shown") { backOnScreen(); return; }
  if (d && d.source === HOST_SOURCE && d.type === "sent" && pendingSends.has(d.nonce)) {
    const sid = pendingSends.get(d.nonce);
    pendingSends.delete(d.nonce);
    const draft = sentDrafts.get(d.nonce);
    sentDrafts.delete(d.nonce);
    if (d.ok) {
      if (draft) justSent.set(sid, Object.assign({ at: new Date().toISOString() }, draft));
      if (draft) rememberSent(draft.text);
      drafts.delete(sid);
      saveDrafts();
      attachments.delete(sid);
      renderThumbs(sid);
      // Подписи «отправлено» нет: отправку видно по твоему сообщению в карточке.
      setSendNote(sid, "", "", true);
      sendState.delete(sid);
      lastSignature = "";                  // показать отправленное сразу, не ждать изменений
      renderActive(null, true);
      setTimeout(loadActive, 1500);        // статус сменится на «работает»
    } else {
      setSendNote(sid, i18n("active.notSent", { reason: d.reason || i18n("active.errorWord") }), "bad");
    }
    return;
  }
  if (d && d.source === HOST_SOURCE
      && (handleDialogMessage(d) || handleStopMessage(d) || handleRestoreMessage(d)
          || handleCommandOutput(d))) return;
  if (!d || d.source !== HOST_SOURCE || d.type !== "tabs" || !Array.isArray(d.tabs)) return;
  hostTabs = new Map(d.tabs.filter(t => t && Number.isInteger(t.ptyPid))
    .map(t => [t.ptyPid, String(t.title || "")]));
  hostReady = true;
  tabsAskedAt = null;
  // Плагин до 1.5 причину не присылает: раз ответил — связь есть.
  hostHealth = d.health && typeof d.health === "object"
    ? { ok: !!d.health.ok, reason: typeof d.health.reason === "string" ? d.health.reason : null }
    : { ok: true, reason: null };
  requestDialogs();                      // вкладки известны — можно читать диалоги ждущих
  requestRestorable();                   // и спросить, что закрыл перезапуск Obsidian
  renderActive();
});

// Процесс claude — потомок прокси PTY своей вкладки: ищем её PID среди предков.
function tabFor(s) {
  return (s.ancestors || []).find(pid => hostTabs.has(pid)) || null;
}

registerView("active", { tab: "#view-active", panel: "#active",
                         show: () => { resortActive(); loadActive(); },
                         hide: () => clearTimeout(activeTimer) });

async function loadActive() {
  clearTimeout(activeTimer);
  try {
    // Хвост переписки нужен только подробным карточкам: компактным его не считаем.
    const data = await api("/api/active" + (activeMode === "full" && CARD_MESSAGES > 1 ? `?msgs=${CARD_MESSAGES}` : ""));
    activeSessions = data.sessions || [];
    activeLimits = data.limits || null;
    recentClosed = data.recent_closed || [];
    AtlasLogic.pruneClosedNotes(closedNotes, recentClosed.map(c => c.session_id), Date.now());
    activeUpdated = new Date();
  } catch (e) {
    // Упал сервер — карточки остаются как были, о нём говорит плашка сверху.
    if (!serverDown || !activeSessions.length) {
      $("#active-grid").replaceChildren(el("p", "empty", i18n("active.error", { msg: e.message })));
    }
  }
  $("#active-count").textContent = activeSessions.length ? String(activeSessions.length) : "";
  if (EMBEDDED) {                             // ответ придёт сообщением и перерисует карточки
    if (!tabsAskedAt) tabsAskedAt = Date.now();
    tellHost("list-tabs", {});
  }
  renderActive();
  refreshFeed(false);                        // открытая лента обновляется вместе с карточками
  if (state.view === "active") activeTimer = setTimeout(loadActive, ACTIVE_POLL_MS);
}

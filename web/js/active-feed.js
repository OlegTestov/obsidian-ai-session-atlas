// «Активные»: лента сессии в боковой панели — вся сессия: сначала конец, раньше — порциями,
// когда долистал до верха. Живой конец обновляется от опорного хода, так что новые ходы
// дописываются без дыр, а порции раньше опоры подгружены один раз.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
let feedSid = null;
let feedSignature = "";
let feedSeq = 0;
const FEED_TURNS = 20;                 // порция: столько ходов за раз
let feedOlder = [];                    // подгруженные раньше опоры, по порядку
let feedLive = [];                     // от опоры до конца, обновляются
let feedAnchor = null;                 // время первого хода живой части
let feedHasMore = false;
let feedLoadingOlder = false;

function resetFeedPages() {
  feedOlder = [];
  feedLive = [];
  feedAnchor = null;
  feedHasMore = false;
  feedLoadingOlder = false;
}
const FEED_VIEW_KEY = "atlas.feedView";
let feedView = loadStored(FEED_VIEW_KEY, "turns");      // по умолчанию — ходы, как было
let openedFeedView = null;                               // вид, в котором нарисовано сейчас

function renderFeedViews() {
  const seg = segButtons(FEED_VIEWS, feedView, v => {
    feedView = v;
    store(FEED_VIEW_KEY, v);
    resetFeedPages();                  // у ходов и шагов разные данные — листаем заново
    renderFeedViews();
    refreshFeed(true);
  }, "fviews");
  seg.title = i18n("feed.views.hint");
  $("#feed-views").replaceChildren(seg);
}

function feedButton(s, mini) {
  const b = el("button", "feedbtn" + (mini ? " mini" : ""), i18n("feed.button"));
  b.type = "button";
  b.title = i18n("feed.button.hint");
  b.setAttribute("aria-pressed", String(feedSid === s.session_id));
  b.addEventListener("click", e => {
    e.stopPropagation();
    if (feedSid === s.session_id) closeFeed(); else openFeed(s.session_id);
  });
  return mini ? iconify(b, FEED_SVG, i18n("feed.button.label")) : b;
}

function openFeed(sid) {
  feedSid = sid;
  resetFeedPages();
  feedSignature = "";
  $("#feed").classList.remove("hidden");
  $("#active").classList.add("with-feed");
  $("#feed-body").replaceChildren(el("p", "empty", i18n("feed.loading")));
  renderFeedViews();
  lastSignature = "";
  renderActive(null, true);            // кнопка «лента» у карточки — нажатой
  refreshFeed(true);
}

function closeFeed() {
  feedSid = null;
  $("#feed").classList.add("hidden");
  $("#active").classList.remove("with-feed");
  lastSignature = "";
  renderActive(null, true);
}

async function refreshFeed(scrollToEnd) {
  if (!feedSid) return;
  const sid = feedSid;
  const seq = ++feedSeq;
  const s = activeSessions.find(x => x.session_id === sid);
  $("#feed-title").textContent = s ? (s.title || sid) : sid;
  const view = FEED_VIEWS.some(v => v.value === feedView) ? feedView : "turns";
  const paged = view !== "files";
  let data;
  try { data = await api(`/api/active/feed/${encodeURIComponent(sid)}?turns=${FEED_TURNS}`
                         + (view === "turns" ? "" : `&view=${view}`)
                         + (paged && feedAnchor ? `&since=${encodeURIComponent(feedAnchor)}` : "")); }
  catch (e) {
    if (seq === feedSeq) $("#feed-body").replaceChildren(el("p", "empty", i18n("feed.error", { msg: e.message })));
    return;
  }
  if (seq !== feedSeq || sid !== feedSid || view !== feedView) return;   // пока ждали, всё сменилось
  if (paged) {
    feedLive = data.turns || [];
    if (!feedAnchor) {                 // первая порция: от её начала — живой конец
      feedAnchor = feedLive.length ? feedLive[0].prompt_at : null;
      feedHasMore = !!data.has_more;
    }
  }
  drawFeed(view, s, data, scrollToEnd, false);
}

/** Нарисовать ленту из того, что уже загружено. prepended — сверху добавили ранние ходы:
 *  держим на месте то, что было на экране. */
function drawFeed(view, s, data, scrollToEnd, prepended) {
  const turns = feedOlder.concat(feedLive);
  // «Идёт N мин» у шага стареет — шаги перерисовываются и без новых данных.
  const signature = JSON.stringify([view, stepFilter, view === "files" ? data.files : turns, feedHasMore,
    view === "steps" ? Math.floor(Date.now() / 30000) : 0]);
  if (signature === feedSignature) return;            // не трогаем DOM — не сбиваем прокрутку
  feedSignature = signature;
  const body = $("#feed-body");
  const switched = openedFeedView !== view;
  openedFeedView = view;
  const atEnd = scrollToEnd || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const top = body.scrollTop;
  const height = body.scrollHeight;
  if (view === "files") body.replaceChildren(...renderFiles(data));
  else {
    const head = feedHasMore ? [earlierButton()] : feedOlder.length ? [el("p", "fwho", i18n("feed.start"))] : [];
    if (view === "steps") body.replaceChildren(...head, ...renderSteps(turns, s));
    else body.replaceChildren(...head, ...(turns.length
      ? turns.map((t, i) => feedTurn(t, i === turns.length - 1))
      : [el("p", "empty", i18n("feed.noPrompts"))]));
  }
  if (view === "files") body.scrollTop = switched ? 0 : top;     // файлы читают сверху
  else if (prepended) body.scrollTop = top + (body.scrollHeight - height);
  else if (atEnd) body.scrollTop = body.scrollHeight;
}

function earlierButton() {
  const b = el("button", "fearlier", feedLoadingOlder ? i18n("feed.loadingEarlier") : i18n("feed.loadEarlier"));
  b.type = "button";
  b.disabled = feedLoadingOlder;
  b.addEventListener("click", loadOlderTurns);
  return b;
}

async function loadOlderTurns() {
  const view = feedView;
  if (!feedSid || view === "files" || !feedHasMore || feedLoadingOlder) return;
  const oldest = feedOlder[0] || feedLive[0];
  if (!oldest || !oldest.prompt_at) return;
  const sid = feedSid;
  feedLoadingOlder = true;
  feedSignature = "";
  drawFeed(view, activeSessions.find(x => x.session_id === sid), {}, false, true);   // кнопка — «загружаю…»
  let data = null;
  try {
    data = await api(`/api/active/feed/${encodeURIComponent(sid)}?turns=${FEED_TURNS}`
                     + (view === "turns" ? "" : `&view=${view}`) + `&before=${encodeURIComponent(oldest.prompt_at)}`);
  } catch (e) { /* кнопка останется — можно нажать ещё раз */ }
  feedLoadingOlder = false;
  if (sid !== feedSid || view !== feedView) return;
  if (data) {
    feedOlder = (data.turns || []).concat(feedOlder);
    feedHasMore = !!data.has_more && (data.turns || []).length > 0;
  }
  feedSignature = "";
  drawFeed(view, activeSessions.find(x => x.session_id === sid), {}, false, true);
}

// Долистал до верха — следующая порция сама, без нажатия.
$("#feed-body").addEventListener("scroll", () => {
  if ($("#feed-body").scrollTop < 80) loadOlderTurns();
});

function feedTurn(t, last) {
  const box = el("section", "fturn");
  const you = el("div", "fwho", i18n("feed.you", { time: fmtShort(t.prompt_at) }));
  box.appendChild(you);
  const prompt = el("div", "ftxt md mine");
  prompt.appendChild(renderMarkdown(t.prompt || ""));
  if (t.images) prompt.appendChild(el("p", "cutmark", i18nN("feed.images", t.images)));
  box.appendChild(prompt);
  if (t.steps.length) {
    const steps = el("div", "fsteps");
    t.steps.forEach(st => {
      const chip = el("span", "pill fstep " + st.kind, st.text);
      if (st.detail.length) chip.title = st.detail.join("\n");
      steps.appendChild(chip);
    });
    box.appendChild(steps);
  }
  if (t.interrupted && !t.reply) box.appendChild(el("div", "fwho bad", i18n("feed.interrupted")));
  if (t.reply) {
    box.appendChild(el("div", "fwho", `Claude · ${fmtShort(t.reply_at)}`
      + (t.interrupted ? " · " + i18n("feed.interrupted") : "")));
    const reply = el("div", "ftxt md");
    if (t.reply_len > t.reply.length) reply.appendChild(el("p", "cutmark", i18n("feed.replyCut")));
    reply.appendChild(renderMarkdown(t.reply));
    box.appendChild(reply);
  } else if (!t.interrupted && last) {
    // У прошлых ходов без ответа — команды вроде /mcp: отвечать на них и не нужно.
    box.appendChild(el("div", "fwho", i18n("feed.noReply")));
  }
  return box;
}

$("#feed-close").addEventListener("click", closeFeed);

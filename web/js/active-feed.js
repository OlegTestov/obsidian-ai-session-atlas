// Active: the session feed in the side panel, the whole session: the end first, earlier parts in pages
// on scrolling to the top. The live end refreshes from an anchor turn, so new turns
// append without gaps, and pages before the anchor load once.
// Classic script: shares one global scope with the other page files.
/* exported feedButton -- used by other page scripts */
let feedSid = null;
let feedSignature = "";
let feedSeq = 0;
const FEED_TURNS = 20;                 // page: this many turns at a time
let feedOlder = [];                    // loaded before the anchor, in order
let feedLive = [];                     // from the anchor to the end, refreshed
let feedAnchor = null;                 // time of the first turn of the live part
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
let feedView = loadStored(FEED_VIEW_KEY, "turns");      // turns by default
let openedFeedView = null;                               // the view currently drawn

function renderFeedViews() {
  const seg = segButtons(FEED_VIEWS, feedView, v => {
    feedView = v;
    store(FEED_VIEW_KEY, v);
    resetFeedPages();                  // turns and steps have different data: scroll from scratch
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
  renderActive(null, true);            // the card's feed button shows as pressed
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
  if (seq !== feedSeq || sid !== feedSid || view !== feedView) return;   // everything changed while waiting
  if (paged) {
    feedLive = data.turns || [];
    if (!feedAnchor) {                 // first page: the live end starts at its beginning
      feedAnchor = feedLive.length ? feedLive[0].prompt_at : null;
      feedHasMore = !!data.has_more;
    }
  }
  drawFeed(view, s, data, scrollToEnd, false);
}

/** Draw the feed from what is already loaded. prepended: earlier turns were added on top,
 *  so keep what was on screen in place. */
function drawFeed(view, s, data, scrollToEnd, prepended) {
  const turns = feedOlder.concat(feedLive);
  // A step's "running N min" ages, so steps redraw even without new data.
  const signature = JSON.stringify([view, stepFilter, view === "files" ? data.files : turns, feedHasMore,
    view === "steps" ? Math.floor(Date.now() / 30000) : 0]);
  if (signature === feedSignature) return;            // leave the DOM alone so the scroll does not jump
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
  if (view === "files") body.scrollTop = switched ? 0 : top;     // files read top-down
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
  drawFeed(view, activeSessions.find(x => x.session_id === sid), {}, false, true);   // the button reads "loading…"
  let data = null;
  try {
    data = await api(`/api/active/feed/${encodeURIComponent(sid)}?turns=${FEED_TURNS}`
                     + (view === "turns" ? "" : `&view=${view}`) + `&before=${encodeURIComponent(oldest.prompt_at)}`);
  } catch { /* the button stays and can be pressed again */ }
  feedLoadingOlder = false;
  if (sid !== feedSid || view !== feedView) return;
  if (data) {
    feedOlder = (data.turns || []).concat(feedOlder);
    feedHasMore = !!data.has_more && (data.turns || []).length > 0;
  }
  feedSignature = "";
  drawFeed(view, activeSessions.find(x => x.session_id === sid), {}, false, true);
}

// Scrolled to the top: the next page loads by itself, no click needed.
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
    // Past turns without a reply are commands like /mcp: they need no answer.
    box.appendChild(el("div", "fwho", i18n("feed.noReply")));
  }
  return box;
}

$("#feed-close").addEventListener("click", closeFeed);

// Search cards share the Active dialogue renderer, with their own lazy, paged reader.
/* exported catalogFeed -- used by card.js */
function catalogFeed(session) {
  const details = el("details", "block catalog-feed");
  details.appendChild(el("summary", null, i18n("feed.button.label")));
  const body = el("div", "catalog-feed-body");
  body.tabIndex = 0;
  body.setAttribute("role", "region");
  body.setAttribute("aria-label", i18n("feed.button.label"));
  details.appendChild(body);
  let turns = [], loaded = false, loading = false, hasMore = false, positioned = false;
  let error = "";

  function draw() {
    const head = [];
    if (error) head.push(el("p", "empty", i18n("feed.error", { msg: error })));
    if (!loaded || hasMore) {
      const key = loading ? (loaded ? "feed.loadingEarlier" : "feed.loading")
        : error ? "feed.retry" : "feed.loadEarlier";
      const button = el("button", "fearlier", i18n(key));
      button.type = "button";
      button.disabled = loading;
      button.addEventListener("click", load);
      head.push(button);
    }
    body.replaceChildren(...head, ...turns.map((turn, i) => feedTurn(turn, i === turns.length - 1, session)),
      ...(loaded && !turns.length ? [el("p", "empty", i18n("feed.noPrompts"))] : []));
  }

  function positionEnd() {
    window.requestAnimationFrame(() => {
      if (!positioned && loaded && details.open && details.isConnected) {
        body.scrollTop = body.scrollHeight;
        positioned = true;
      }
    });
  }

  async function load() {
    if (loading || !details.open || !details.isConnected || (loaded && !hasMore)) return;
    const before = loaded ? turns[0]?.prompt_at : null;
    if (loaded && !before) return;
    loading = true;
    error = "";
    // Keep the messages still while fetching an earlier page.
    const button = body.querySelector(".fearlier");
    if (button) { button.disabled = true; button.textContent = i18n(loaded ? "feed.loadingEarlier" : "feed.loading"); }
    else draw();
    try {
      const data = await api(`/api/active/feed/${encodeURIComponent(session.session_id)}?turns=20`
        + (before ? `&before=${encodeURIComponent(before)}` : ""));
      if (!details.isConnected) return;
      const page = data.turns || [];
      turns = page.concat(turns);
      hasMore = !!data.has_more && page.length > 0;
      loaded = true;
    } catch (e) {
      if (!details.isConnected) return;
      error = e.message;
    } finally { loading = false; }
    if (!details.isConnected) return;
    const top = body.scrollTop, height = body.scrollHeight;
    draw();
    if (before && details.open) body.scrollTop = top + body.scrollHeight - height;
    else positionEnd();
  }

  details.addEventListener("toggle", () => {
    if (!details.open) return;
    if (!loaded) load(); else positionEnd();
  });
  body.addEventListener("scroll", () => {
    if (positioned && !error && body.scrollTop < 80) load();
  });
  return details;
}

// Active: the conversation in a detailed card stays at the newest message, the way chat apps do.
// Scrolling up to read turns that off for this card and shows a "to newest" button; scrolling back
// to the bottom turns it on again. The state follows the reader's own scrolling, so a redraw, a
// late image or a tab that was hidden never moves the text under the reader.
/* exported stickChats, nearBottom -- called by active.js and the tests */

const STICK_SLACK_PX = 24;
const readingAbove = new Set();       // session ids whose chat the reader scrolled up in
const chatTops = new Map();           // session id → where the reader left it
let chatObservers = [];

/** true at the bottom (within a few pixels), false above it, null when the box has no size yet. */
function nearBottom(top, height, client) {
  if (!client) return null;
  return height - top - client < STICK_SLACK_PX;
}

function toNewest(box) {
  box.scrollTop = box.scrollHeight;
}

/** After each redraw: put every chat back where the reader left it, or at the newest message. */
function stickChats(grid) {
  chatObservers.forEach(o => o.disconnect());
  chatObservers = [];
  grid.querySelectorAll(".amsgs[data-sid]").forEach(box => {
    const sid = box.dataset.sid;
    const jump = el("button", "tonewest", i18n("active.toNewest"));
    jump.type = "button";
    jump.title = i18n("active.toNewest.hint");
    jump.hidden = !readingAbove.has(sid);
    jump.addEventListener("click", () => {
      readingAbove.delete(sid);
      jump.hidden = true;
      toNewest(box);
    });
    box.appendChild(jump);
    if (readingAbove.has(sid)) box.scrollTop = chatTops.get(sid) || 0;
    else toNewest(box);
    box.addEventListener("scroll", () => {
      const bottom = nearBottom(box.scrollTop, box.scrollHeight, box.clientHeight);
      if (bottom === null) return;            // a hidden tab has no layout: nothing to judge
      if (bottom) readingAbove.delete(sid);
      else { readingAbove.add(sid); chatTops.set(sid, box.scrollTop); }
      jump.hidden = bottom;
    }, { passive: true });
    // Content that grows after the redraw (images, fonts, a tab shown again) keeps the newest in view.
    const watch = new ResizeObserver(() => { if (!readingAbove.has(sid)) toNewest(box); });
    watch.observe(box);
    [...box.children].forEach(child => watch.observe(child));
    chatObservers.push(watch);
  });
}

// Own tooltips instead of the system ones: those have a delay of about two seconds that cannot be
// configured. Works for any element with a title; the attribute is hidden while hovering.
// Classic script: shares one global scope with the other page files.
const TIP_DELAY_MS = 1000;
let tipTimer = null;
let tipTarget = null;
let tipBox = null;

function hideTip() {
  window.clearTimeout(tipTimer);
  tipTimer = null;
  tipTarget = null;
  if (tipBox) tipBox.classList.add("hidden");
}

function showTip(target) {
  if (!document.body.contains(target) || !target.dataset.tip) return;
  if (!tipBox) {
    tipBox = el("div", "tip hidden");
    tipBox.setAttribute("role", "tooltip");
    document.body.appendChild(tipBox);
  }
  tipBox.textContent = target.dataset.tip;
  tipBox.classList.remove("hidden");
  // Position through JS properties: the CSP forbids the style attribute, not the CSSOM.
  const r = target.getBoundingClientRect();
  const w = tipBox.offsetWidth, h = tipBox.offsetHeight;
  const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  const below = r.bottom + 6 + h < window.innerHeight;
  tipBox.style.left = left + "px";
  tipBox.style.top = (below ? r.bottom + 6 : Math.max(6, r.top - h - 6)) + "px";
}

document.addEventListener("mouseover", e => {
  const t = e.target && e.target.closest ? e.target.closest("[title], [data-tip]") : null;
  if (t === tipTarget) return;
  hideTip();
  if (!t) return;
  if (t.hasAttribute("title")) {             // the system tooltip must not pop up over ours
    const text = t.getAttribute("title");
    t.removeAttribute("title");
    if (text) t.dataset.tip = text;
  }
  if (!t.dataset.tip) return;
  tipTarget = t;
  tipTimer = window.setTimeout(() => showTip(t), TIP_DELAY_MS);
});
document.addEventListener("mousedown", hideTip, true);
document.addEventListener("keydown", hideTip, true);
document.addEventListener("scroll", hideTip, true);

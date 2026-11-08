// Booot motion helpers: the JS half of design/motion.css.
// Plain ES module, no dependencies. Every helper is a no-op-safe enhancement:
// the UI must already be correct without it.

const reduced = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** confirm: play the shiver on `el` (restarts cleanly on rapid repeats). */
export function confirm(el) {
  if (!el) return;
  el.classList.remove("m-confirm");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add("m-confirm");
  const clear = () => el.classList.remove("m-confirm");
  // Flip buttons keep .m-confirm until mouseleave (freezes the hover preview).
  if (el.classList.contains("flip-btn")) el.addEventListener("mouseleave", clear, { once: true });
  else el.addEventListener("animationend", clear, { once: true });
}

/**
 * flip: wire a .flip-btn. `labels` = { a: "Edit", b: "Preview" }.
 * onChange(mode) runs after each toggle. Returns { set(mode) }.
 */
export function wireFlip(btn, labels, onChange) {
  const front = btn.querySelector(".flip-face--front");
  const back = btn.querySelector(".flip-face--back");
  const render = (mode) => {
    btn.dataset.mode = mode;
    front.textContent = mode === "a" ? labels.a : labels.b;
    back.textContent = mode === "a" ? labels.b : labels.a;
    btn.setAttribute("aria-pressed", String(mode === "b"));
  };
  render(btn.dataset.mode || "a");
  btn.addEventListener("click", () => {
    const next = btn.dataset.mode === "a" ? "b" : "a";
    render(next);
    confirm(btn);
    onChange?.(next);
  });
  return { set: render };
}

/** count: tick a number from its current value up/down to `to`. */
export function countUp(el, to, { decimals = 0, suffix = "", duration = 420 } = {}) {
  if (!el) return;
  const from = parseFloat(el.dataset.value ?? el.textContent) || 0;
  el.dataset.value = String(to);
  const fmt = (v) => v.toFixed(decimals) + suffix;
  if (reduced() || from === to) { el.textContent = fmt(to); return; }
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = fmt(from + (to - from) * ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** draw: draw an SVG path/line in from start to end. */
export function drawIn(pathEl) {
  if (!pathEl?.getTotalLength) return;
  pathEl.style.setProperty("--path-length", String(Math.ceil(pathEl.getTotalLength())));
  pathEl.classList.remove("m-draw");
  void pathEl.getBoundingClientRect();
  pathEl.classList.add("m-draw");
}

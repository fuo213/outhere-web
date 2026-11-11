/**
 * Itinerary panel controller: the sticky sketchbook profile at the top of the
 * trip panel's scroll area, and the "active day" that follows your reading.
 *
 * - The profile (itinerary-profile.js) is position: sticky inside
 *   #notebookPanel. Day sections scroll underneath it and fade out behind its
 *   lower edge.
 * - An IntersectionObserver watches a 1 px line just below the profile. The
 *   day section crossing that line is the active day: its band on the profile
 *   is highlighted and a small marker names it.
 * - Clicking a band scrolls to that day.
 * - While a route is being drawn the profile collapses to a compact strip.
 *
 * Shared signal (contract with the map; see CLAUDE.md "Active day signal"):
 *   window event `booot:active-day`, detail { dayIndex, dayId, source }.
 *   We dispatch with source "panel" whenever the active day changes because of
 *   the panel, and listen for any other source (the map sends "map") to scroll
 *   that day into view without echoing it back.
 */

import { buildItinerary, drawProfile, drawEmpty, captionFor } from "./itinerary-profile.js";

export const ACTIVE_DAY_EVENT = "booot:active-day";
const FAILED_AFTER_MS = 20000; // elevation that hasn't arrived by now isn't coming

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const S = {
  fig: null, scroll: null, tail: null,
  model: null, tripId: null,
  sections: [],
  active: null,
  compact: false,
  lock: null, lockTimer: 0,
  io: null, lineY: 0,
  pendingSince: new Map(), // route _id -> first time we saw it without elevation
  reveal: new Set(),
  failTimer: 0,
  onDrawRoute: null,
  onRetryElevation: null,
  failedNow: new Set(), // route ids whose fetch reported a failure (no need to wait out the timer)
  paintedW: 0, paintedH: 0,
};

/** Wire the figure + scroll container once (trip-panel.js initTripPanel). */
export function initItineraryPanel({ figure, scroll, tail, onDrawRoute, onRetryElevation }) {
  S.fig = figure;
  S.scroll = scroll;
  S.tail = tail;
  S.onDrawRoute = onDrawRoute;
  S.onRetryElevation = onRetryElevation;
  // A fetch that failed says so: show "Try again" now instead of after the timer.
  window.addEventListener("booot:elevation-failed", (e) => { if (e.detail?.id) { S.failedNow.add(e.detail.id); paint(); } });

  new ResizeObserver(() => {
    const w = S.fig.clientWidth, h = S.scroll.clientHeight;
    if (w === S.paintedW && h === S.paintedH) return;
    paint();
  }).observe(S.scroll);

  // The paper fade only shows once something is actually scrolling under it.
  const stuck = () => S.fig.classList.toggle("is-stuck", S.scroll.scrollTop > 2);
  scroll.addEventListener("scroll", stuck, { passive: true });
  stuck();

  figure.addEventListener("click", (e) => {
    if (e.target.closest("[data-action='draw-route']")) { S.onDrawRoute?.(); return; }
    if (e.target.closest("[data-action='retry-elevation']")) { retryFailed(); return; }
    const hit = e.target.closest(".day-hit");
    if (hit) scrollToDay(+hit.dataset.i, "panel");
  });

  window.addEventListener(ACTIVE_DAY_EVENT, (e) => {
    const d = e.detail || {};
    if (d.source === "panel") return; // our own echo
    if (!S.model || S.model.mode !== "days") return;
    let i = d.dayId ? S.model.days.findIndex((x) => x.id === d.dayId) : -1;
    if (i < 0 && Number.isInteger(d.dayIndex)) i = d.dayIndex;
    if (i >= 0 && i < S.sections.length) scrollToDay(i, d.source || "map");
  });
}

/**
 * Re-read the trip after any render. `sections` are the day <section>s in
 * day order (index = day index).
 */
export function updateItinerary(trip, sections, model = buildItinerary(trip)) {
  if (!S.fig) return;
  const tripId = trip?.properties?.trip_id || null;
  if (tripId !== S.tripId) {
    S.tripId = tripId;
    S.pendingSince.clear();
    S.scroll.scrollTop = 0;
    setActive(null, "panel");
  }
  // Elevation bookkeeping: what's loading, what just arrived, what isn't coming.
  const now = Date.now();
  const pending = new Set(model.pendingIds || []);
  S.reveal = new Set();
  for (const [id] of S.pendingSince) {
    if (!pending.has(id)) { S.pendingSince.delete(id); S.reveal.add(id); }
  }
  const pendingRoutes = new Set([...pending].map(routeIdOf));
  for (const id of S.failedNow) if (!pendingRoutes.has(id)) S.failedNow.delete(id);
  for (const id of pending) if (!S.pendingSince.has(id)) S.pendingSince.set(id, now);
  clearTimeout(S.failTimer);
  if (pending.size) {
    const next = Math.min(...[...pending].map((id) => S.pendingSince.get(id) + FAILED_AFTER_MS)) - now;
    if (next > 0) S.failTimer = setTimeout(() => paint(), next + 50);
  }

  S.model = model;
  S.sections = sections || [];
  if (S.active != null && S.active >= S.sections.length) setActive(null, "panel");
  paint();
  S.reveal = new Set(); // reveal plays once
}

/** Collapse to the compact strip while drawing (or restore). */
export function setItineraryCompact(on) {
  if (S.compact === on) return;
  S.compact = on;
  paint();
}

export function getActiveDayIndex() {
  return S.active;
}

// ---------------------------------------------------------------------------

/** The route behind a drawn piece (1.2 trips draw the line cut per day: `<route>~<day>`). */
const routeIdOf = (pieceId) => String(pieceId).split("~")[0];

function failedIds() {
  const now = Date.now(), out = new Set();
  for (const [id, t] of S.pendingSince) if (now - t >= FAILED_AFTER_MS || S.failedNow.has(routeIdOf(id))) out.add(id);
  return out;
}

/** "Try again": ask for the missing elevation and show those stretches as loading again. */
function retryFailed() {
  const ids = new Set([...failedIds()].map(routeIdOf));
  const now = Date.now();
  for (const id of ids) {
    S.failedNow.delete(id);
    if (S.onRetryElevation?.(id) === false) continue;
    for (const piece of S.pendingSince.keys()) if (routeIdOf(piece) === id) S.pendingSince.set(piece, now);
  }
  clearTimeout(S.failTimer);
  S.failTimer = setTimeout(() => paint(), FAILED_AFTER_MS + 50);
  paint();
}

function profileHeight(narrow) {
  const h = S.scroll.clientHeight || 600;
  return narrow ? Math.max(150, Math.min(196, Math.round(h * 0.3))) : Math.max(176, Math.min(248, Math.round(h * 0.34)));
}

function paint() {
  const fig = S.fig, m = S.model;
  if (!fig || !m) return;
  const cs = getComputedStyle(fig);
  const W = Math.floor(fig.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  S.paintedW = fig.clientWidth;
  S.paintedH = S.scroll.clientHeight;
  if (W < 160) return; // panel closed or still laying out; the ResizeObserver will call back

  fig.dataset.mode = m.mode;
  fig.classList.toggle("is-compact", S.compact && m.mode !== "empty");
  if (m.mode === "empty") {
    fig.innerHTML = `<div class="itin-empty">
      ${drawEmpty(W - 24)}
      <p class="itin-empty-title">Your elevation profile draws itself here.</p>
      <p class="itin-empty-hint">${m.line ? "Draw your line on the map, then drop camps on it." : "Draw a route on the map, then drag it into a day."}</p>
      <button type="button" class="btn btn--quiet btn--sm" data-action="draw-route">${m.line ? "Draw your line" : "Draw route"}</button>
    </div>`;
  } else {
    const failed = failedIds();
    const svg = drawProfile(m, W, {
      height: profileHeight(W < 420),
      compact: S.compact,
      active: S.active,
      failedIds: failed,
      reveal: reduceMotion() ? new Set() : S.reveal,
    });
    // Where a stretch has no elevation, the caption offers to ask again.
    const retry = failed.size ? ` <button type="button" class="btn btn--ghost btn--sm itin-retry" data-action="retry-elevation">Try again</button>` : "";
    const caption = failed.size && m.hasElevation ? `${captionFor(m)} No elevation for one stretch.` : captionFor(m, { failed: failed.size > 0 });
    fig.innerHTML = `<div class="itin-profile-art">${svg}</div>${S.compact ? "" : `<p class="itin-caption">${caption}${retry}</p>`}`;
  }
  applyActive();
  // Layout settles after innerHTML; measure on the next frame.
  requestAnimationFrame(() => { armObserver(); sizeTail(); pickActive(); });
}

function armObserver() {
  S.io?.disconnect();
  S.io = null;
  if (!S.sections.length || S.model?.mode !== "days") return;
  const H = S.scroll.clientHeight;
  S.lineY = Math.min(H - 2, S.fig.offsetHeight + 12);
  const bottom = Math.max(0, H - S.lineY - 1);
  S.io = new IntersectionObserver(() => pickActive(), {
    root: S.scroll,
    rootMargin: `-${S.lineY}px 0px -${bottom}px 0px`,
    threshold: 0,
  });
  S.sections.forEach((s) => S.io.observe(s));
}

/** Room under the last day so it can reach the line (and become active). */
function sizeTail() {
  if (!S.tail) return;
  const last = S.sections.at(-1);
  if (!last || S.model?.mode !== "days") { S.tail.style.height = "0px"; return; }
  const below = S.tail.getBoundingClientRect().top - last.getBoundingClientRect().top;
  const need = S.scroll.clientHeight - S.lineY - below - 8;
  S.tail.style.height = `${Math.max(0, Math.round(need))}px`;
}

function pickActive() {
  // While drawing (compact strip) the line jumps up; keep the day you were on.
  if (S.compact || S.lock != null || !S.sections.length || S.model?.mode !== "days") return;
  const y = S.scroll.getBoundingClientRect().top + S.lineY;
  let idx = null;
  for (let i = 0; i < S.sections.length; i++) {
    const r = S.sections[i].getBoundingClientRect();
    if (r.top <= y && y < r.bottom) { idx = i; break; }
  }
  if (idx == null && y >= S.sections.at(-1).getBoundingClientRect().bottom) idx = S.sections.length - 1;
  setActive(idx, "panel");
}

function setActive(i, source) {
  if (i === S.active) return;
  S.active = i;
  applyActive();
  if (source === "panel") {
    const day = i == null ? null : S.model?.days?.[i];
    window.dispatchEvent(new CustomEvent(ACTIVE_DAY_EVENT, {
      detail: { dayIndex: i, dayId: day?.id ?? null, source: "panel" },
    }));
  }
}

function applyActive() {
  const i = S.active;
  if (S.fig) {
    if (i == null) delete S.fig.dataset.active; else S.fig.dataset.active = String(i);
    S.fig.querySelectorAll("[data-i]").forEach((el) => el.classList.toggle("is-active", +el.dataset.i === i));
  }
  S.sections.forEach((s, k) => s.classList.toggle("is-active", k === i));
}

/** Scroll so day i sits just under the profile, and make it active. */
export function scrollToDay(i, source = "panel") {
  const sec = S.sections[i];
  if (!sec) return;
  clearTimeout(S.lockTimer);
  S.lock = i;
  setActive(i, source);
  const target = S.scroll.scrollTop + sec.getBoundingClientRect().top - S.scroll.getBoundingClientRect().top - S.lineY + 6;
  const smooth = !reduceMotion();
  S.scroll.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
  const release = () => { clearTimeout(S.lockTimer); S.scroll.removeEventListener("scrollend", release); S.lock = null; };
  if (smooth) {
    S.scroll.addEventListener("scrollend", release, { once: true });
    S.lockTimer = setTimeout(release, 1200);
  } else {
    S.lockTimer = setTimeout(release, 60);
  }
  // Move keyboard focus with it, without a second scroll.
  sec.focus({ preventScroll: true });
}

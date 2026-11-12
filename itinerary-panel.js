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

import { buildItinerary, drawProfile, drawEmpty, captionFor, profileX, profileFrame, lineSpotAtMile, fmt } from "./itinerary-profile.js";

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
  scrub: null, // { mi, pinned, dragId, echo } a spot being read or a camp being dragged on the profile
  drag: null, // { id, m, view } a camp being dragged: view = the preview model drawn meanwhile
  paintedHeight: 0,
  onAddCamp: null, onMoveCamp: null, onOpenStop: null, onPreviewCamp: null, onCancelPreview: null,
};

/** Wire the figure + scroll container once (trip-panel.js initTripPanel). */
export function initItineraryPanel({ figure, scroll, tail, onDrawRoute, onRetryElevation, onAddCamp, onMoveCamp, onOpenStop, onPreviewCamp, onCancelPreview }) {
  S.onPreviewCamp = onPreviewCamp;
  S.onCancelPreview = onCancelPreview;
  S.onAddCamp = onAddCamp;
  S.onMoveCamp = onMoveCamp;
  S.onOpenStop = onOpenStop;
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

  initScrub(figure);

  figure.addEventListener("click", (e) => {
    if (e.target.closest("[data-action='add-camp']")) { addCampFromScrub(); return; }
    if (e.target.closest("[data-action='draw-route']")) { S.onDrawRoute?.(); return; }
    if (e.target.closest("[data-action='retry-elevation']")) { retryFailed(); return; }
    const hit = e.target.closest(".day-hit");
    if (hit) scrollToDay(+hit.dataset.i, "panel", { frame: true });
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
    S.scrub = null;
    S.drag = null;
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
  if (S.drag) return; // a camp is being dragged: its preview owns the drawing until release
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
    S.paintedHeight = profileHeight(W < 420);
    const svg = drawProfile(m, W, {
      height: S.paintedHeight,
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
  paintScrub();
  // Layout settles after innerHTML; measure on the next frame.
  requestAnimationFrame(() => { armObserver(); sizeTail(); pickActive(); });
}

// ---------------------------------------------------------------------------
// Reading and editing along the profile (1.2 line trips)
//   hover / tap / drag   a cursor with the mile and elevation under it
//   tap (or click)       pins it, with "Add a camp here"
//   drag a camp          moves it along the line (one undo step)
// The day under the pointer says which pass of an out-and-back is meant.
// ---------------------------------------------------------------------------

const art = () => S.fig?.querySelector(".itin-profile-art");
const lineMode = () => !!(S.model?.line && S.model.mode === "days" && !S.compact);
/** The model on the page: a dragged camp's preview, else the trip's. */
const drawn = () => S.drag?.view || S.model;
const SNAP_PX = 10; // an echo (the line passing a camp's spot again) pulls the pointer this far

/**
 * The spot on the line under a pointer event, from its x on the drawing.
 * Pointer x is read against the trip's own model (not a drag preview), so a
 * dragged camp never shifts the ground under the pointer. Near an echo the
 * spot snaps onto it (`echo` set).
 */
function spotAt(e) {
  const el = art();
  if (!el || !S.model) return null;
  const rect = el.getBoundingClientRect();
  const geo = profileX(S.model, rect.width);
  const px = e.clientX - rect.left;
  let mi = geo.mi(px);
  let echo = null;
  for (const ec of S.model.echoes || []) {
    if (ec.mi == null || (S.drag && ec.campId === S.drag.id)) continue;
    const dx = Math.abs(geo.X(ec.mi) - px);
    if (dx <= SNAP_PX && (!echo || dx < Math.abs(geo.X(echo.mi) - px))) echo = ec;
  }
  if (echo) mi = echo.mi;
  const spot = lineSpotAtMile(S.model, mi);
  if (!spot) return null;
  if (echo && !spot.rest) spot.m = echo.m;
  return { ...spot, echo, x: geo.X(mi), W: rect.width };
}

/** Repaint only the drawing (keeps the .itin-profile-art element, so pointer capture holds). */
function paintArt(model) {
  const el = art();
  if (!el || !model) return;
  const W = el.getBoundingClientRect().width;
  const svg = drawProfile(model, W, { height: S.paintedHeight || profileHeight(W < 420), active: S.active, failedIds: failedIds() });
  const old = el.querySelector("svg");
  if (old) old.outerHTML = svg; else el.insertAdjacentHTML("afterbegin", svg);
  applyActive();
}

function initScrub(figure) {
  let down = null; // { id|null, x0, y0, moved, pointerId, el }
  let raf = 0, last = null;
  const clearSel = () => { const sel = window.getSelection?.(); if (sel && !sel.isCollapsed) sel.removeAllRanges(); };

  // One frame per pointer burst: the dragged camp follows the pointer along
  // the line, the days re-split and the map moves the tent; the trip itself
  // only changes on release (one undo step).
  const frame = () => {
    raf = 0;
    const e = last;
    if (!e || !down) return;
    const sp = spotAt(e);
    if (!sp) return;
    if (down.id) {
      if (sp.rest) { S.scrub = { mi: sp.mi, pinned: false, dragId: down.id, rest: true }; paintScrub(); return; }
      if (!S.drag) { S.drag = { id: down.id, m: null, view: null }; S.fig.classList.add("is-dragging-camp"); }
      if (S.drag.m == null || Math.abs(S.drag.m - sp.m) > 0.5) {
        S.drag.m = sp.m;
        S.drag.view = S.onPreviewCamp?.(down.id, sp.m) || null;
        if (S.drag.view) paintArt(S.drag.view);
      }
      S.scrub = { mi: sp.mi, pinned: false, dragId: down.id, echo: sp.echo };
    } else {
      S.scrub = { mi: sp.mi, pinned: true, dragId: null, echo: sp.echo };
    }
    paintScrub();
  };
  const schedule = (e) => { last = { clientX: e.clientX, clientY: e.clientY }; if (!raf) raf = requestAnimationFrame(frame); };

  figure.addEventListener("pointermove", (e) => {
    if (!lineMode()) return;
    if (down) {
      if (e.pointerId !== down.pointerId) return;
      if (Math.hypot(e.clientX - down.x0, e.clientY - down.y0) > 4) down.moved = true;
      if (!down.moved && down.id) return;
      e.preventDefault();
      schedule(e);
      return;
    }
    if (e.pointerType === "mouse" && !S.scrub?.pinned) {
      const sp = e.target.closest(".itin-profile-art") && !e.target.closest(".itin-scrub-box") ? spotAt(e) : null;
      S.scrub = sp ? { mi: sp.mi, pinned: false, dragId: null, echo: sp.echo } : null;
      paintScrub();
    }
  });
  figure.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !down && S.scrub && !S.scrub.pinned) { S.scrub = null; paintScrub(); } });
  figure.addEventListener("pointerdown", (e) => {
    if (!lineMode() || e.button > 0 || e.target.closest(".itin-scrub-box")) return;
    const el = e.target.closest(".itin-profile-art");
    if (!el) return;
    // Pressing the drawing never starts a text selection (that was the
    // highlighted page text left behind after dragging a camp) or moves focus.
    e.preventDefault();
    clearSel();
    const grab = e.target.closest(".camp-grab");
    down = { id: grab?.dataset.id || null, x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId, el };
    try { el.setPointerCapture(e.pointerId); } catch { /* not capturable: fine */ }
    figure.classList.add("is-pressing");
    if (!grab) { const sp = spotAt(e); if (sp) { S.scrub = { mi: sp.mi, pinned: true, dragId: null, echo: sp.echo }; paintScrub(); } }
  });
  const release = () => {
    figure.classList.remove("is-pressing", "is-dragging-camp");
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    try { down?.el.releasePointerCapture(down.pointerId); } catch { /* already released */ }
  };
  /** Esc or pointercancel mid-drag: the camp goes back, nothing is saved. */
  const cancelDrag = () => {
    const wasPreview = !!S.drag?.view;
    release();
    down = null;
    S.drag = null;
    S.scrub = null;
    if (wasPreview) S.onCancelPreview?.(); else paintScrub();
    paint();
  };
  const finish = (e, cancelled) => {
    if (!down || e.pointerId !== down.pointerId) return;
    if (cancelled) { cancelDrag(); return; }
    const d = down;
    release();
    down = null;
    clearSel();
    // A tap on the drawing (pointer capture swallows the click) still goes to that day.
    if (!d.id && !d.moved) { const sp = spotAt(e); if (sp) scrollToDay(sp.day.i, "panel", { frame: true }); return; }
    if (d.id) {
      if (!d.moved) { S.scrub = null; paintScrub(); S.onOpenStop?.(d.id); return; } // a tap on a camp opens it
      // Commit where the preview is (the last frame), or where the pointer let go.
      const sp = spotAt(e);
      const m = sp && !sp.rest ? sp.m : S.drag?.m;
      const had = !!S.drag?.view;
      S.drag = null;
      S.scrub = null;
      if (m != null) S.onMoveCamp?.(d.id, m);
      else { if (had) S.onCancelPreview?.(); paint(); }
    }
  };
  figure.addEventListener("pointerup", (e) => finish(e, false));
  figure.addEventListener("pointercancel", (e) => finish(e, true));
  figure.addEventListener("lostpointercapture", (e) => { if (down && e.pointerId === down.pointerId && down.id && down.moved) cancelDrag(); });
  // Belt and braces: nothing on the profile starts a selection or a native drag.
  figure.addEventListener("selectstart", (e) => { if (e.target.closest?.(".itin-profile-art") || down) e.preventDefault(); });
  figure.addEventListener("dragstart", (e) => { if (e.target.closest?.(".itin-profile-art")) e.preventDefault(); });
  // Esc cancels a drag, or lets go of a pinned spot; a press outside the profile lets go too.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (down?.id && down.moved) { e.preventDefault(); e.stopPropagation(); cancelDrag(); return; }
    if (S.scrub && !down) { S.scrub = null; paintScrub(); }
  }, true);
  document.addEventListener("pointerdown", (e) => { if (S.scrub?.pinned && !figure.contains(e.target)) { S.scrub = null; paintScrub(); } });
}

/**
 * Draw the cursor and its readout box from S.scrub (also after every repaint).
 * The box is small and sits at the spot on the line (above it when there is
 * room, else below), always inside the drawing.
 */
function paintScrub() {
  const el = art();
  el?.querySelector(".itin-scrub")?.remove();
  el?.querySelector(".itin-scrub-box")?.remove();
  if (!el || !S.scrub || !lineMode()) return;
  const model = drawn();
  const W = el.getBoundingClientRect().width;
  const H = el.querySelector("svg")?.getBoundingClientRect().height || S.paintedHeight || 200;
  const fr = profileFrame(model, W, { height: S.paintedHeight || H });
  const sp = lineSpotAtMile(S.model, S.scrub.mi);
  if (!sp) return;
  const x = profileX(S.model, W).X(S.scrub.mi);
  const dragging = S.scrub.dragId ? S.model.days.flatMap((d) => d.stops).find((st) => st.id === S.scrub.dragId) : null;
  // Where the box hangs from: the dragged tent (in the preview) or the line under the cursor.
  let y;
  if (dragging && S.drag?.view) {
    const st = S.drag.view.days.flatMap((d) => d.stops).find((q) => q.id === S.scrub.dragId);
    y = st ? fr.yAt(st.mi) - 14 : fr.yAt(S.scrub.mi);
  } else y = profileFrame(S.model, W, { height: S.paintedHeight || H }).yAt(S.scrub.mi);
  const mile = `<span class="itin-scrub-num">${(sp.m / 1609.344).toFixed(1)}</span>`;
  const ft = sp.ft == null ? "" : `<span class="itin-scrub-ft">${fmt.ft(sp.ft)}</span>`;
  const campName = dragging ? escapeText(dragging.name || (S.model.campNo?.has(dragging.id) ? `Camp ${S.model.campNo.get(dragging.id)}` : "Camp")) : "";
  const echo = S.scrub.echo ? `<span class="itin-scrub-site">${escapeText(S.scrub.echo.name || `Camp ${S.scrub.echo.n}`)}’s spot</span>` : "";
  let lines;
  if (dragging) {
    lines = sp.rest || S.scrub.rest
      ? `<span class="itin-scrub-head">${campName}</span><span class="itin-scrub-sub">Not on a rest day</span>`
      : `<span class="itin-scrub-head">${campName} to mile ${mile}</span>${echo}`;
  } else {
    lines = `${echo}<span class="itin-scrub-head">Mile ${mile}</span><span class="itin-scrub-sub">${[ft, sp.rest ? "Rest day" : `Day ${sp.day.n}`].filter(Boolean).join(" · ")}</span>`;
  }
  const add = S.scrub.pinned && !S.scrub.dragId && !sp.rest ? `<button type="button" class="btn btn--quiet btn--sm itin-scrub-add" data-action="add-camp">Add a camp here</button>` : "";
  const dot = dragging ? "" : `<span class="itin-scrub-dot" style="top:${y.toFixed(1)}px"></span>`;
  el.insertAdjacentHTML("beforeend", `<div class="itin-scrub${dragging ? " is-dragging" : ""}" style="left:${x.toFixed(1)}px"><span class="itin-scrub-line"></span>${dot}</div>
    <div class="itin-scrub-box${S.scrub.pinned ? " is-pinned" : ""}" role="group" aria-label="Spot on the line">${lines}${add}</div>`);
  // Place the box: centred on the spot, above it if it fits, clamped inside the drawing.
  const box = el.querySelector(".itin-scrub-box");
  const bw = box.offsetWidth, bh = box.offsetHeight, gap = 10, pad = 2;
  const left = Math.max(pad, Math.min(W - bw - pad, x - bw / 2));
  let top = y - gap - bh;
  if (top < pad) top = Math.min(H - bh - pad, y + gap + (dragging ? 14 : 0));
  box.style.left = `${left.toFixed(1)}px`;
  box.style.top = `${Math.max(pad, top).toFixed(1)}px`;
}

const escapeText = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function addCampFromScrub() {
  const sc = S.scrub;
  const sp = sc && lineSpotAtMile(S.model, sc.mi);
  S.scrub = null;
  paintScrub();
  if (sp && !sp.rest) S.onAddCamp?.(sc.echo ? sc.echo.m : sp.m);
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

function setActive(i, source, frame = false) {
  if (i === S.active && !frame) return;
  S.active = i;
  applyActive();
  if (source === "panel") {
    const day = i == null ? null : S.model?.days?.[i];
    window.dispatchEvent(new CustomEvent(ACTIVE_DAY_EVENT, {
      detail: { dayIndex: i, dayId: day?.id ?? null, source: "panel", ...(frame ? { frame: true } : {}) },
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
export function scrollToDay(i, source = "panel", { frame = false } = {}) {
  const sec = S.sections[i];
  if (!sec) return;
  clearTimeout(S.lockTimer);
  S.lock = i;
  setActive(i, source, frame);
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

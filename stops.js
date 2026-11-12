/**
 * Stops on a 1.2 trip: the stop tool and the stop menu.
 *
 * Stop tool (toolbar pin, keys 1-6): pick a kind and click the map.
 *   camp, break   time stops: attach to the pass of the line under the click
 *                 (within the snap distance; on overlapping passes the first
 *                 pass after the previous camp), else they're off route.
 *   water, hazard, viewpoint (scenic), note
 *                 place stops: a spot on the map, snapped onto the line when
 *                 clicked on it. The itinerary lists them on every pass.
 * Stop menu (click a stop on the map, or its row in the itinerary): name,
 * nights (camp), water source + reliability, notes, Out / Back on an
 * overlapping section, Day hike from here, Move, Delete.
 */

import { map } from "./app.js"; // circular; runtime only
import { TripManager, escapeHTML, escapeAttr, frameFeature } from "./trip-panel.js"; // circular; runtime only
import { startRouteDrawing, cancelDrawing, isDrawingRoute, isDeleteMode, showPlanningHint, hidePlanningHint } from "./planning.js"; // circular; runtime only
import { snapshot, showToast, closeLineMenu } from "./route-edit.js"; // circular; runtime only
import { metersPerPixel } from "./routing.js";
import { glyphIcon } from "./sketch.js";
import { offRouteConsequence } from "./line-panel.js"; // circular; runtime only
import {
  isLineTrip, mainRoute, lineIndex, choosePass, locateM, nearestOnLine, passesNear, resolveAttach,
  buildPlan, stopKind, round6, OVERLAP_M, MI, pointAtM,
  sameSiteCandidate, linkSameSite, unlinkSameSite, shareCampFields, campEchoes,
} from "./line-model.js";
import { moveStopAlong } from "./line-edit.js";

export const STOP_KINDS = [
  { kind: "camp", label: "Camp", key: "1" },
  { kind: "break", label: "Break", key: "2" },
  { kind: "water", label: "Water", key: "3" },
  { kind: "hazard", label: "Hazard", key: "4" },
  { kind: "scenic", label: "View", key: "5", long: "Viewpoint" },
  { kind: "note", label: "Note", key: "6" },
];
const KIND_LABEL = { camp: "Camp", break: "Break", water: "Water", hazard: "Hazard", scenic: "Viewpoint", note: "Note" };
export const WATER_SOURCES = ["spring", "pothole", "tank", "river", "lake", "cache", "other"];
export const RELIABILITY = ["reliable", "seasonal", "unreliable", "unknown"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Glyph (sketch.js) for a stop kind. */
export const glyphForKind = (k) => ({ camp: "camp", break: "rest", water: "water", hazard: "hazard", scenic: "scenic", note: "note" }[k] || "scenic");

let active = false;
let kind = "camp";
let moving = null; // stop _id being moved: the next click places it
let keyHandler = null;
/** Camps just added next to an earlier camp: their menu asks "Same as Camp N?" until answered. */
const askSame = new Set();

export const isStopToolActive = () => active;

const snapRadius = (lat, zoom) => Math.min(200, Math.max(10, 24 * metersPerPixel(lat, zoom)));

// ---------------------------------------------------------------------------
// Tool lifecycle
// ---------------------------------------------------------------------------

export function startStopTool(k = kind) {
  if (!TripManager.currentTrip) return;
  if (isDrawingRoute || isDeleteMode) cancelDrawing();
  active = true;
  moving = null;
  setKind(k);
  document.getElementById("addStopBtn")?.classList.add("active");
  document.getElementById("addStopBtn")?.setAttribute("aria-pressed", "true");
  document.getElementById("stopKindSelector")?.classList.add("visible");
  document.getElementById("planningToolbar")?.classList.add("active");
  map.getCanvas().style.cursor = "crosshair";
  hintForTool();
  keyHandler = (e) => {
    const t = e.target;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
    const hit = STOP_KINDS.find((s) => s.key === e.key);
    if (hit) { e.preventDefault(); setKind(hit.kind); hintForTool(); }
  };
  document.addEventListener("keydown", keyHandler);
}

export function exitStopTool() {
  if (!active && !moving) return;
  active = false;
  moving = null;
  document.getElementById("addStopBtn")?.classList.remove("active");
  document.getElementById("addStopBtn")?.setAttribute("aria-pressed", "false");
  document.getElementById("stopKindSelector")?.classList.remove("visible");
  document.getElementById("planningToolbar")?.classList.remove("active");
  map.getCanvas().style.cursor = "";
  hidePlanningHint();
  if (keyHandler) document.removeEventListener("keydown", keyHandler);
  keyHandler = null;
}

function setKind(k) {
  kind = k;
  document.querySelectorAll("#stopKindSelector .point-type-btn").forEach((b) => {
    const on = b.dataset.stopKind === k;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function hintForTool() {
  const hasLine = !!mainRoute(TripManager.currentTrip);
  const time = kind === "camp" || kind === "break";
  showPlanningHint(!hasLine ? "Draw your line first; stops away from it are off route."
    : time ? `Click your line to add a ${kind}. Days number themselves from your camps.`
      : `Click where the ${KIND_LABEL[kind].toLowerCase()} is. On the line, it's listed on every pass.`);
}

export function initStops() {
  document.getElementById("addStopBtn")?.addEventListener("click", () => (active ? exitStopTool() : startStopTool()));
  document.querySelectorAll("#stopKindSelector .point-type-btn").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    setKind(b.dataset.stopKind);
    hintForTool();
  }));
}

// ---------------------------------------------------------------------------
// Placing stops
// ---------------------------------------------------------------------------

/** Map click while the stop tool (or a Move) is active. Returns true if handled. */
export function handleMapClickForStop(e) {
  if (!active && !moving) return false;
  const pt = [e.lngLat.lng, e.lngLat.lat];
  if (moving) { moveStopTo(moving, pt, map.getZoom()); return true; }
  // A click on an existing stop opens it instead of stacking a new one.
  const pad = 6, bbox = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  const layers = ["trip-chart-points", "trip-chart-points-minor"].filter((id) => map.getLayer(id));
  const hit = map.queryRenderedFeatures(bbox, { layers })[0];
  if (hit?.properties?._id) { openStopMenu(hit.properties._id); return true; }
  addStopAt(kind, pt, { zoom: map.getZoom() });
  return true;
}

/** Where a stop of `k` lands for a click at pt: { coord, attach|null }. */
function placement(k, pt, { zoom = map.getZoom(), atM = null, exclude = null } = {}) {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  if (!route) return { coord: pt, attach: null };
  const ix = lineIndex(route);
  const rid = route.properties._id;
  const radius = snapRadius(pt[1], zoom);
  if (k === "camp" || k === "break") {
    if (atM != null) return { coord: ix.coords.length ? resolveAttach(ix, locateM(ix, atM)).coord : pt, attach: { route_id: rid, ...locateM(ix, atM) } };
    // First pass after the previous camp (the last camp along the line).
    const plan = buildPlan(trip);
    const others = plan.camps.filter((c) => c.id !== exclude);
    const prev = others.at(-1);
    // Dropped on an existing camp's spot: the pass beside that camp gives way
    // to the line's other pass there (the way back of an out-and-back).
    const pick = choosePass(ix, pt, radius, prev ? prev.m : -1, others);
    if (!pick) return { coord: pt, attach: null };
    return { coord: pick.coord, attach: { route_id: rid, ...locateM(ix, pick.m) } };
  }
  const near = nearestOnLine(ix, pt);
  return { coord: near.d <= radius ? near.coord : pt, attach: null };
}

/** Create a stop of kind k at pt and open its menu. */
export function addStopAt(k, pt, { zoom, atM = null } = {}) {
  const trip = TripManager.currentTrip;
  if (!trip) return null;
  const { coord, attach } = placement(k, pt, { zoom, atM });
  snapshot(`add ${KIND_LABEL[k].toLowerCase()}`);
  let props;
  if (k === "camp") props = { type: "camp", point_type: "camp", name: "", notes: "", nights: 1, water_nearby: false, water_notes: "" };
  else if (k === "break") props = { type: "break", point_type: "break", name: "", notes: "" };
  else props = { type: "waypoint", subtype: k, name: "", notes: "" };
  if (k === "water") Object.assign(props, { water_source: "other", reliability: "unknown" });
  if (attach) props.attach = attach;
  TripManager.addFeature({ type: "Point", coordinates: round6(coord) }, props);
  const id = props._id;
  if (k === "camp" && attach) {
    const trip2 = TripManager.currentTrip;
    if (sameSiteCandidate(buildPlan(trip2), id)) askSame.add(id);
  }
  if ((k === "camp" || k === "break") && !attach && mainRoute(trip)) showToast(`That ${k} is off your route. Click on the line to attach it.`, { undoable: true, warn: true });
  openStopMenu(id);
  return id;
}

/** A camp at metre m of the line (the elevation profile uses this): same camp as the map menu's "Add a camp here". */
export function addCampAtM(m) {
  const route = mainRoute(TripManager.currentTrip);
  if (!route) return null;
  return addStopAt("camp", pointAtM(lineIndex(route), m), { atM: m });
}

/** Move a camp (or break) along the line to metre m: one undo step, days follow. */
export function moveStopAlongLine(id, m) {
  const trip = TripManager.currentTrip;
  const f = findStop(id);
  if (!trip || !f) return;
  const k = stopKind(f.properties);
  snapshot(`move ${KIND_LABEL[k].toLowerCase()}`);
  if (!moveStopAlong(trip, id, m)) return;
  askSame.delete(id);
  closeStopMenu(); // its popup still shows the old mile
  TripManager.render();
  TripManager.save();
  const plan = buildPlan(TripManager.currentTrip);
  const c = plan.camps.find((x) => x.id === id);
  showToast(`Moved ${c ? `Camp ${c.n}` : `the ${KIND_LABEL[k].toLowerCase()}`} to mile ${(m / MI).toFixed(1)}`, { undoable: true });
  // Dropped on another camp's site (another pass of the same ground): ask.
  if (k === "camp" && sameSiteCandidate(plan, id)) { askSame.add(id); frameFeature(id); openStopMenu(id); }
}

function moveStopTo(id, pt, zoom) {
  const f = findStop(id);
  moving = null;
  if (!active) { map.getCanvas().style.cursor = ""; hidePlanningHint(); } else hintForTool();
  if (!f) return;
  const k = stopKind(f.properties);
  const { coord, attach } = placement(k, pt, { zoom, exclude: id });
  snapshot(`move ${KIND_LABEL[k].toLowerCase()}`);
  f.geometry = { type: "Point", coordinates: round6(coord) };
  if (attach) f.properties.attach = attach; else delete f.properties.attach;
  delete f.properties.pass;
  TripManager.render();
  TripManager.save();
  showToast(attach || (k !== "camp" && k !== "break") ? `Moved the ${KIND_LABEL[k].toLowerCase()}` : `Moved it off your route`, { undoable: true, warn: !attach && (k === "camp" || k === "break") });
  openStopMenu(id);
}

const findStop = (id) => TripManager.currentTrip?.features.find((f) => f.properties._id === id) || null;

// ---------------------------------------------------------------------------
// The stop menu
// ---------------------------------------------------------------------------

let popup = null;
let popupId = null;
let changed = false;

export function closeStopMenu() { popup?.remove(); popup = null; popupId = null; }

/** Open the menu for stop `id` (fly to it when it's off-screen). */
export function openStopMenu(id, { fly = false } = {}) {
  const f = findStop(id);
  if (!f) return;
  closeStopMenu();
  closeLineMenu();
  const trip = TripManager.currentTrip;
  const p = f.properties;
  const k = stopKind(p);
  const plan = isLineTrip(trip) ? buildPlan(trip) : null;
  const entry = plan?.stopsById.get(id);
  const camp = plan?.camps.find((c) => c.id === id);
  const title = k === "camp" ? (camp ? `Camp ${camp.n}` : "Camp") : KIND_LABEL[k] || "Stop";
  const time = k === "camp" || k === "break";
  const mi = entry && !entry.offRoute ? `${(entry.m / MI).toFixed(1)} mi` : "";
  const offRoute = time && plan?.route && (!p.attach || entry?.offRoute);
  // Out / Back: the passes of the line at this stop.
  let passHTML = "";
  if (time && plan?.route && p.attach && entry && entry.passes >= 2) {
    const labels = entry.passes === 2 ? ["Out", "Back"] : Array.from({ length: entry.passes }, (_, i) => `Pass ${i + 1}`);
    passHTML = `<div class="stop-menu__row"><span class="stop-menu__label">On the way</span><span class="seg" role="group" aria-label="Which pass">${labels.map((l, i) => `<button type="button" class="seg__btn" data-pass="${i}" aria-pressed="${entry.pass === i}">${l}</button>`).join("")}</span></div>`;
  }
  const nights = Math.max(1, parseInt(p.nights, 10) || 1);
  // "Same as Camp 1?" for a camp added beside an earlier one (an out-and-back's second night there).
  const cand = k === "camp" && plan && askSame.has(id) ? sameSiteCandidate(plan, id) : null;
  if (k === "camp" && askSame.has(id) && !cand) askSame.delete(id);
  const sameHTML = cand
    ? `<div class="stop-menu__ask" role="group" aria-label="Same campsite?"><span class="stop-menu__ask-q">Same as Camp ${cand.n}${cand.name ? `, ${escapeHTML(cand.name)}` : ""}?</span><span class="stop-menu__ask-btns"><button type="button" class="btn btn--quiet btn--sm" data-same="yes">Yes, same site</button><button type="button" class="btn btn--ghost btn--sm" data-same="no">No</button></span></div>`
    : camp?.sameAs ? `<div class="stop-menu__row"><span class="stop-menu__label">Same site as Camp ${camp.sameAs}</span><button type="button" class="btn btn--ghost btn--sm" data-same="unlink">Separate</button></div>`
      : camp?.again?.length ? `<p class="stop-menu__note">You sleep here again at Camp ${camp.again.join(", ")}. Name and notes are shared.</p>` : "";
  // The line comes back past this camp (an out-and-back): offer the same site again.
  const echo = camp && !cand ? campEchoes(plan).find((e) => e.campId === id) : null;
  const againHTML = echo ? `<button type="button" class="btn btn--ghost btn--sm stop-menu__again" data-act="again" data-m="${Math.round(echo.m)}">Camp here again ${echo.m > camp.m ? "on the way back" : "on the way out"}</button>` : "";
  const sel = (name, opts, val) => `<select class="input input--sm" data-field="${name}">${opts.map((o) => `<option value="${o}"${o === val ? " selected" : ""}>${cap(o)}</option>`).join("")}</select>`;
  const html = `
    <form class="stop-menu" data-kind="${escapeAttr(k)}" autocomplete="off">
      <div class="stop-menu__head">
        ${glyphIcon(glyphForKind(k), { size: 24, seed: 7 })}
        <span class="stop-menu__title">${escapeHTML(title)}</span>
        ${mi ? `<span class="stop-menu__at">${escapeHTML(mi)}</span>` : ""}
      </div>
      ${sameHTML}
      ${againHTML}
      ${offRoute ? `<p class="stop-menu__warn">Off your route. ${escapeHTML(offRouteConsequence(k))}</p>` : ""}
      <input class="input input--sm" data-field="name" type="text" value="${escapeAttr(p.name || "")}" placeholder="Name (optional)" aria-label="Name" />
      ${k === "camp" ? `<div class="stop-menu__row"><span class="stop-menu__label">Nights</span><span class="stepper"><button type="button" class="stepper__btn" data-step="-1" aria-label="One night fewer"${nights <= 1 ? " disabled" : ""}>−</button><span class="stepper__num" aria-live="polite">${nights}</span><button type="button" class="stepper__btn" data-step="1" aria-label="One more night">+</button></span></div>` : ""}
      ${k === "water" ? `<div class="stop-menu__row"><span class="stop-menu__label">Source</span>${sel("water_source", WATER_SOURCES, p.water_source || "other")}</div>
        <div class="stop-menu__row"><span class="stop-menu__label">Reliability</span>${sel("reliability", RELIABILITY, p.reliability || "unknown")}</div>` : ""}
      ${passHTML}
      <textarea class="input input--sm stop-menu__notes" data-field="notes" rows="2" placeholder="${k === "water" ? "Flow, treatment, last report" : "Notes"}" aria-label="Notes">${escapeHTML(p.notes || "")}</textarea>
      <div class="stop-menu__actions">
        ${plan?.route ? `<button type="button" class="btn btn--quiet btn--sm" data-act="spur">Day hike from here</button>` : ""}
        ${trip.features.some((s) => s.properties.type === "dayhike_spur" && s.properties.from_stop === id) ? `<button type="button" class="btn btn--ghost btn--sm" data-act="unspur">Delete day hike</button>` : ""}
        <button type="button" class="btn btn--ghost btn--sm" data-act="move">Move</button>
        <button type="button" class="btn btn--ghost btn--sm stop-menu__delete" data-act="delete">Delete</button>
      </div>
    </form>`;
  popup = new maplibregl.Popup({ className: "stop-popup", closeButton: true, closeOnClick: true, maxWidth: "280px", offset: 18 })
    .setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  popupId = id;
  changed = false;
  const el = popup.getElement();
  popup.on("close", () => { if (popupId === id) { popup = null; popupId = null; } });
  if (fly) map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 13), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });

  const edit = (fn) => {
    if (!changed) { snapshot(`edit ${title.toLowerCase()}`); changed = true; }
    fn(f.properties);
    if (k === "camp") shareCampFields(TripManager.currentTrip, id); // name and notes follow the same campsite
    TripManager.render();
    TripManager.save();
  };
  el.addEventListener("submit", (e) => e.preventDefault());
  el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeStopMenu(); });
  el.querySelectorAll("[data-field]").forEach((inp) => {
    const field = inp.dataset.field;
    inp.addEventListener(inp.tagName === "SELECT" ? "change" : "input", () => edit((q) => { q[field] = inp.value; }));
  });
  el.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step) {
      edit((q) => { q.nights = Math.max(1, Math.min(14, (parseInt(q.nights, 10) || 1) + +step.dataset.step)); });
      openStopMenu(id); // redraw with the new number (and Camp numbering)
      return;
    }
    const same = e.target.closest("[data-same]")?.dataset.same;
    if (same) { answerSameSite(id, same, cand); return; }
    const pass = e.target.closest("[data-pass]");
    if (pass) { choosePassFor(id, +pass.dataset.pass); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "delete") deleteStop(id);
    else if (act === "move") startMove(id);
    else if (act === "again") campAgainAt(id, +e.target.closest("[data-m]").dataset.m);
    else if (act === "spur") startSpurFrom(id);
    else if (act === "unspur") deleteSpursOf(id);
  });
}

/** "Camp here again on the way back": a new camp at metre m, linked to camp `id` as one site. */
function campAgainAt(id, m) {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  const site = findStop(id);
  if (!route || !site) return;
  const ix = lineIndex(route);
  const at = locateM(ix, m);
  snapshot("camp here again");
  const props = { type: "camp", point_type: "camp", name: site.properties.name || "", notes: site.properties.notes || "", nights: 1, water_nearby: false, water_notes: "", attach: { route_id: route.properties._id, ...at } };
  // Silent add (no render yet): the link goes in first.
  props._id = crypto.randomUUID();
  trip.features.push({ type: "Feature", geometry: { type: "Point", coordinates: round6(resolveAttach(ix, at).coord) }, properties: props });
  (trip.unassigned ||= []).push(props._id);
  const siteM = buildPlan(trip).camps.find((c) => c.id === id)?.m ?? 0;
  if (m > siteM) linkSameSite(trip, props._id, id); else linkSameSite(trip, id, props._id);
  TripManager.render();
  TripManager.save();
  const plan = buildPlan(trip);
  const n = (cid) => plan.camps.find((c) => c.id === cid)?.n || "";
  showToast(`Added Camp ${n(props._id)} at mile ${(m / MI).toFixed(1)}, the same site as Camp ${n(id)}`, { undoable: true });
  openStopMenu(props._id);
}

function answerSameSite(id, answer, cand) {
  const trip = TripManager.currentTrip;
  askSame.delete(id);
  if (answer === "yes" && cand) {
    snapshot("same campsite");
    changed = true;
    if (cand.later) {
      // The camp you just placed comes first along the line: it becomes the
      // site, keeping the later camp's name and notes.
      const me = findStop(id), other = findStop(cand.id);
      if (me && other) { me.properties.name = other.properties.name || ""; me.properties.notes = other.properties.notes || ""; }
      linkSameSite(trip, cand.id, id);
    } else linkSameSite(trip, id, cand.id);
    TripManager.render();
    TripManager.save();
    showToast(`Camp ${buildPlan(trip).camps.find((c) => c.id === id)?.n || ""} is the same site as Camp ${cand.n}. Name and notes are shared.`, { undoable: true });
  } else if (answer === "unlink") {
    snapshot("separate campsites");
    changed = true;
    unlinkSameSite(trip, id);
    TripManager.render();
    TripManager.save();
  }
  openStopMenu(id);
}

/** Re-attach a time stop to pass i of the line at its spot (Out / Back). */
function choosePassFor(id, i) {
  const f = findStop(id);
  const route = mainRoute(TripManager.currentTrip);
  if (!f || !route) return;
  const ix = lineIndex(route);
  const passes = passesNear(ix, f.geometry.coordinates, OVERLAP_M);
  const q = passes[i];
  if (!q) return;
  snapshot("change pass");
  f.properties.attach = { route_id: route.properties._id, ...locateM(ix, q.m) };
  f.geometry = { type: "Point", coordinates: round6(q.coord) };
  TripManager.render();
  TripManager.save();
  openStopMenu(id);
}

function deleteStop(id) {
  const trip = TripManager.currentTrip;
  const idx = trip?.features.findIndex((f) => f.properties._id === id);
  if (idx == null || idx < 0) return;
  const p = trip.features[idx].properties;
  snapshot(`delete ${KIND_LABEL[stopKind(p)]?.toLowerCase() || "stop"}`);
  closeStopMenu();
  // Its day hikes go with it (one undo brings both back).
  const spurs = trip.features.filter((f) => f.properties.type === "dayhike_spur" && f.properties.from_stop === id).map((f) => f.properties._id);
  removeFeatures(trip, [id, ...spurs]);
  showToast(`Deleted the ${KIND_LABEL[stopKind(p)]?.toLowerCase() || "stop"}${spurs.length ? ` and its day hike${spurs.length > 1 ? "s" : ""}` : ""}`, { undoable: true });
}

function deleteSpursOf(id) {
  const trip = TripManager.currentTrip;
  const spurs = trip.features.filter((f) => f.properties.type === "dayhike_spur" && f.properties.from_stop === id).map((f) => f.properties._id);
  if (!spurs.length) return;
  snapshot("delete day hike");
  closeStopMenu();
  removeFeatures(trip, spurs);
  showToast(`Deleted the day hike${spurs.length > 1 ? "s" : ""}`, { undoable: true });
}

function removeFeatures(trip, ids) {
  const drop = new Set(ids);
  trip.features = trip.features.filter((f) => !drop.has(f.properties._id));
  trip.unassigned = (trip.unassigned || []).filter((x) => !drop.has(x));
  for (const d of trip.days || []) d.features = (d.features || []).filter((x) => !drop.has(x));
  TripManager.render();
  TripManager.save();
}

function startMove(id) {
  closeStopMenu();
  moving = id;
  map.getCanvas().style.cursor = "crosshair";
  showPlanningHint("Click where it goes. Esc keeps it where it is.");
}

/** Day hike from a stop: draw a spur from it (same snapping); it returns the same day. */
function startSpurFrom(id) {
  const f = findStop(id);
  if (!f) return;
  closeStopMenu();
  exitStopTool();
  startRouteDrawing({ mode: "spur", seed: f.geometry.coordinates, fromStop: id });
}

/** Esc while moving: cancel the move. */
export function cancelStopMove() {
  if (!moving) return false;
  moving = null;
  if (!active) { map.getCanvas().style.cursor = ""; hidePlanningHint(); }
  return true;
}


/**
 * Editing the line of a 1.2 trip: "Redraw from here", extending from the
 * end, "Return the same way", and trip-level undo.
 *
 * Editing is a change of plan, not drag-to-reshape. The stitching itself
 * (kept legs, re-attached stops, the linked way back) is line-edit.js, pure.
 */

import { map } from "./app.js"; // circular; runtime only
import { TripManager, escapeHTML } from "./trip-panel.js"; // circular; runtime only
import { startRouteDrawing, isDrawingRoute, isDeleteMode, fetchElevationProfile, routeBetween } from "./planning.js"; // circular; runtime only
import { isStopToolActive, addStopAt } from "./stops.js"; // circular; runtime only
import { isLineTrip, mainRoute, lineIndex, sliceM, passesNear, nearestOnLine, hav, MI, buildPlan } from "./line-model.js";
import { redrawLine, appendReturn, sectionAt, sectionCoords, sectionEnds, deleteSection, deleteLine } from "./line-edit.js";

/** "Camp 2" for camps a redraw took off the route (session only; the flag
 *  in the itinerary falls back to the camp's name or "A camp"). */
const lostLabels = new Map();
export const offRouteLabel = (id) => lostLabels.get(id) || "";

// ---------------------------------------------------------------------------
// Undo (trip snapshots)
// ---------------------------------------------------------------------------

const undoStack = [];
let undoTripId = null;

/** Snapshot the open trip before a change. `label` names it in the toast. */
export function snapshot(label) {
  const trip = TripManager.currentTrip;
  if (!trip) return;
  if (undoTripId !== trip.properties.trip_id) { undoStack.length = 0; undoTripId = trip.properties.trip_id; }
  undoStack.push({ label, json: JSON.stringify(trip) });
  if (undoStack.length > 40) undoStack.shift();
}

export function canUndo() {
  return undoStack.length > 0 && undoTripId === TripManager.currentTrip?.properties.trip_id;
}

export function undo() {
  if (!canUndo()) return false;
  const { label, json } = undoStack.pop();
  TripManager.currentTrip = JSON.parse(json);
  closeLineMenu();
  clearSelection();
  TripManager.render();
  TripManager.save();
  // A snapshot taken before its elevation arrived has none: ask again.
  const route = isLineTrip(TripManager.currentTrip) ? mainRoute(TripManager.currentTrip) : null;
  if (route && !Array.isArray(route.properties.elevation_profile)) fetchElevationProfile(route.geometry.coordinates, route.properties._id);
  showToast(`Undid: ${label}`);
  return true;
}

// ---------------------------------------------------------------------------
// Toast (one line, bottom of the map, with Undo)
// ---------------------------------------------------------------------------

let toastTimer = 0;
export function showToast(text, { undoable = false, ms = 6000, warn = false } = {}) {
  const el = document.getElementById("editToast");
  if (!el) return;
  el.innerHTML = `<span class="edit-toast__text">${escapeHTML(text)}</span>${undoable ? `<button type="button" class="btn btn--ghost btn--sm edit-toast__undo">Undo</button>` : ""}`;
  el.classList.toggle("edit-toast--warn", warn);
  el.classList.add("visible");
  el.querySelector(".edit-toast__undo")?.addEventListener("click", () => { undo(); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), ms);
}

// ---------------------------------------------------------------------------
// Committing line edits (the data side is line-edit.js)
// ---------------------------------------------------------------------------

/**
 * Replace the line from cutM to the end (or to the rejoin point) with the
 * drawn legs, then say what happened. `newLegs`: [{ coords, mode, reason,
 * wayIds }]. `rejoinM`: metre on the OLD line where the drawing rejoined.
 */
export function commitRedraw({ cutM, rejoinM = null, newLegs, routing }) {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  if (!route || !newLegs.length) return;
  snapshot(cutM >= lineIndex(route).total - 1 ? "extend the line" : "redraw");
  const res = redrawLine(trip, { cutM, rejoinM, newLegs, routing });
  if (!res) return;
  for (const l of res.lost) lostLabels.set(l.id, l.label);

  TripManager.render();
  TripManager.save();
  // Only the drawn legs are fetched; kept stretches reuse the old profile.
  fetchElevationProfile(route.geometry.coordinates, route.properties._id, { reuse: res.reuse });

  const parts = [];
  if (res.lost.length) {
    const names = res.lost.map((l) => l.name || l.label);
    parts.push(`${names.join(", ")} ${names.length === 1 ? "is" : "are"} off your route now`);
  } else {
    parts.push(res.extending ? "Extended the line" : res.rejoined ? "Redrew a section" : "Redrew from here");
  }
  if (res.regenerated) parts.push("The way back follows the new way out");
  if (res.returnNote === "kept") parts.push("You edited the way back by hand, so it stays as it is");
  if (res.returnNote === "removed") parts.push("The way back went with it. Add it again with Return the same way");
  if (res.reattached) parts.push(`${res.reattached} stop${res.reattached === 1 ? "" : "s"} moved onto the new line`);
  showToast(parts.join(". "), { undoable: true, warn: res.lost.length > 0, ms: parts.length > 1 ? 9000 : 6000 });
}

/** Append the way back: every outbound leg reversed, linked by mirror_of. */
export function returnSameWay() {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  if (!route || route.properties.return_same_way) return;
  snapshot("return the same way");
  if (!appendReturn(trip)) return;
  // The profile is mirrored with the line; fetch only when there is none yet.
  if (!Array.isArray(route.properties.elevation_profile)) fetchElevationProfile(route.geometry.coordinates, route.properties._id);
  TripManager.render();
  TripManager.save();
  showToast("Added the way back", { undoable: true });
}

/** Start "Redraw from here" at metre m of the line. */
export function startRedraw(m) {
  const route = mainRoute(TripManager.currentTrip);
  if (!route) return;
  closeLineMenu();
  const ix = lineIndex(route);
  const cutM = Math.max(0, Math.min(ix.total, m));
  startRouteDrawing({
    mode: "redraw",
    seed: sliceM(ix, cutM, cutM)[0],
    cutM,
    ix,
    onCommit: (args) => commitRedraw({ cutM, ...args }),
  });
}

/** Draw on from the line's end (the draw tool on a trip that has a line). */
export function startExtend() {
  const route = mainRoute(TripManager.currentTrip);
  if (!route) return false;
  const ix = lineIndex(route);
  startRouteDrawing({
    mode: "redraw",
    seed: ix.coords.at(-1),
    cutM: ix.total,
    ix,
    onCommit: (args) => commitRedraw({ cutM: ix.total, ...args }),
  });
  return true;
}

// ---------------------------------------------------------------------------
// The line menu: click the line → Redraw from here / Return the same way
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Selection: one section (between two adjacent hidden anchors) or the whole line
// ---------------------------------------------------------------------------

let selection = null; // null | { leg } | { whole: true }
const SEL_SRC = "line-selection", SEL_CASING = "line-selection-casing", SEL_LINE = "line-selection-line";

function selectionCoords() {
  const route = isLineTrip(TripManager.currentTrip) ? mainRoute(TripManager.currentTrip) : null;
  if (!route || !selection) return null;
  // The selection belongs to one line: if the geometry was replaced (an edit,
  // another trip) it is stale and goes.
  if (selection.ref !== route.geometry.coordinates) { selection = null; return null; }
  return selection.whole ? route.geometry.coordinates : sectionCoords(route, selection.leg);
}

/** Draw (or clear) the highlight. Runtime layers vanish with setStyle, so this re-runs on styledata. */
function paintSelection() {
  if (!map.getStyle()) return;
  const coords = selectionCoords();
  const data = { type: "FeatureCollection", features: coords && coords.length >= 2 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] : [] };
  const src = map.getSource(SEL_SRC);
  if (src) { src.setData(data); return; }
  if (!data.features.length) return;
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue("--accent").trim(), paper = cs.getPropertyValue("--surface-raised").trim();
  map.addSource(SEL_SRC, { type: "geojson", data });
  // Above the trip line, below the glyphs and labels.
  const before = ["trip-chart-hit"].find((id) => map.getLayer(id));
  map.addLayer({ id: SEL_CASING, type: "line", source: SEL_SRC, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": paper, "line-width": 10, "line-opacity": 0.9 } }, before);
  map.addLayer({ id: SEL_LINE, type: "line", source: SEL_SRC, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": accent, "line-width": 5 } }, before);
}

function setSelection(sel) {
  const route = mainRoute(TripManager.currentTrip);
  selection = sel && route ? { ...sel, ref: route.geometry.coordinates } : null;
  paintSelection();
}
export function clearSelection() { if (selection) { selection = null; paintSelection(); } }

/** Delete what is selected (Delete / Backspace, or the menu). Undoable. */
export async function deleteSelection() {
  const trip = TripManager.currentTrip;
  const sel = selection;
  const route = isLineTrip(trip) ? mainRoute(trip) : null;
  if (!sel || !route || sel.ref !== route.geometry.coordinates) { clearSelection(); return; }
  closeLineMenu();
  if (sel.whole) { commitDelete("delete the line", () => deleteLine(trip)); clearSelection(); return; }
  const sec = sectionAt(route, lineIndex(route).legs[sel.leg]?.startM ?? -1);
  if (!sec || sec.leg !== sel.leg) { clearSelection(); return; }
  // A middle section is rejoined by routing between its two anchors, the way the draw tool does.
  let bridge = null;
  if (sec.where === "middle") {
    const [a, b] = sectionEnds(route, sel.leg);
    const vs = route.properties.vertex_snapped || [];
    bridge = await routeBetween(a, b, { aSnapped: vs[sel.leg] !== false, bSnapped: vs[sel.leg + 1] !== false });
    if (TripManager.currentTrip !== trip || mainRoute(trip) !== route || selection !== sel) return; // the trip changed while routing
  }
  clearSelection();
  commitDelete(sec.where === "middle" ? "delete a section" : sec.where === "only" ? "delete the line" : "trim the line", () => deleteSection(trip, sel.leg, { bridge }));
}

function commitDelete(label, run) {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  const id = route?.properties._id;
  snapshot(label);
  const res = run();
  if (!res) { undoStack.pop(); return; }
  for (const l of res.lost) lostLabels.set(l.id, l.label);
  TripManager.render();
  TripManager.save();
  if (res.removed !== "line") fetchElevationProfile(route.geometry.coordinates, id, { reuse: res.reuse });
  const parts = [{ line: "Deleted the line", first: "Trimmed the start of the line", last: "Trimmed the end of the line", middle: "Deleted a section and joined the line back up" }[res.removed]];
  if (res.lost.length) {
    const names = res.lost.map((l) => l.name || l.label);
    parts.push(`${names.join(", ")} ${names.length === 1 ? "is" : "are"} off your route now`);
  }
  if (res.reattached) parts.push(`${res.reattached} stop${res.reattached === 1 ? "" : "s"} moved onto the line`);
  showToast(parts.join(". "), { undoable: true, warn: res.lost.length > 0, ms: parts.length > 1 ? 9000 : 6000 });
}

let linePopup = null;
export function closeLineMenu() { linePopup?.remove(); linePopup = null; }

function onLineClick(e) {
  const trip = TripManager.currentTrip;
  if (!isLineTrip(trip) || isDrawingRoute || isDeleteMode || isStopToolActive()) return;
  const pad = 4, bbox = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  // Stops and day numerals have their own clicks.
  const pointLayers = ["trip-chart-points", "trip-chart-points-minor", "trip-chart-days", "trip-gap-pins"].filter((id) => map.getLayer(id));
  if (map.queryRenderedFeatures(bbox, { layers: pointLayers }).length) return;
  const hit = map.queryRenderedFeatures(bbox, { layers: ["trip-chart-hit"].filter((id) => map.getLayer(id)) })[0];
  if (!hit) { clearSelection(); return; } // clicking elsewhere clears the selection
  const route = mainRoute(trip);
  const ix = lineIndex(route);
  const pt = [e.lngLat.lng, e.lngLat.lat];
  // On overlapping passes, take the pass in the day that was clicked.
  const plan = buildPlan(trip);
  const day = plan.days[hit.properties.day_index];
  const passes = passesNear(ix, pt, 60);
  const inDay = day ? passes.find((p) => p.m >= day.fromM - 1 && p.m <= day.toM + 1) : null;
  const at = inDay || passes[0] || nearestOnLine(ix, pt);
  // Clicking the line selects the section under the cursor (unless the whole
  // line is selected, which the menu then offers to delete).
  if (selection?.whole && selectionCoords()) setSelection({ whole: true });
  else { const sec = sectionAt(route, at.m); setSelection(sec ? { leg: sec.leg } : null); }
  openLineMenu(at.m, at.coord, ix, route);
}

function openLineMenu(m, coord, ix, route) {
  closeLineMenu();
  const mi = (m / MI).toFixed(1);
  const loop = hav(ix.coords[0], ix.coords.at(-1)) < 60;
  const back = !route.properties.return_same_way && !loop;
  const html = `
    <div class="line-menu" role="menu">
      <p class="line-menu__at">Mile <span class="line-menu__num">${mi}</span></p>
      <button type="button" class="line-menu__item" data-act="camp" role="menuitem">Add a camp here</button>
      <button type="button" class="line-menu__item" data-act="redraw" role="menuitem">Redraw from here</button>
      ${back ? `<button type="button" class="line-menu__item" data-act="back" role="menuitem">Return the same way</button>` : ""}
      <hr class="line-menu__sep">
      ${selection?.whole
        ? `<button type="button" class="line-menu__item line-menu__item--danger" data-act="delete-line" role="menuitem">Delete whole line</button>
           <button type="button" class="line-menu__item" data-act="select-section" role="menuitem">Select this section instead</button>`
        : `<button type="button" class="line-menu__item line-menu__item--danger" data-act="delete-section" role="menuitem">Delete this section</button>
           <button type="button" class="line-menu__item" data-act="select-line" role="menuitem">Select whole line</button>`}
    </div>`;
  linePopup = new maplibregl.Popup({ className: "line-popup", closeButton: false, closeOnClick: true, maxWidth: "220px", offset: 8 })
    .setLngLat(coord).setHTML(html).addTo(map);
  linePopup.getElement().addEventListener("click", (ev) => {
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    closeLineMenu();
    if (act === "redraw") startRedraw(m);
    else if (act === "back") returnSameWay();
    else if (act === "camp") addStopAt("camp", coord, { atM: m });
    else if (act === "delete-section") deleteSelection();
    else if (act === "delete-line") { setSelection({ whole: true }); deleteSelection(); }
    else if (act === "select-line") setSelection({ whole: true });
    else if (act === "select-section") { const sec = sectionAt(route, m); setSelection(sec ? { leg: sec.leg } : null); }
  });
}

let inited = false;
export function initRouteEdit() {
  if (inited) return;
  inited = true;
  map.on("click", onLineClick);
  map.on("styledata", () => { if (selection && !map.getSource(SEL_SRC)) paintSelection(); });
  document.addEventListener("keydown", (e) => {
    if (isDrawingRoute) return; // the drawing has its own undo
    const t = e.target;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
    if (selection && !isDeleteMode && !isStopToolActive() && (e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (selection && e.key === "Escape") { closeLineMenu(); clearSelection(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (undo()) e.preventDefault();
    }
  });
}

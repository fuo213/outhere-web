/**
 * Editing the line of a 1.2 trip: "Redraw from here", extending from the
 * end, "Return the same way", and trip-level undo.
 *
 * Editing is a change of plan, not drag-to-reshape: a redraw cuts the line at
 * a point, the drawing tool (planning.js) draws the new path from there, and
 * commitRedraw() stitches it back:
 *   kept legs before the cut   unchanged geometry, same leg index + offset
 *   the cut leg                trimmed at the cut
 *   new legs                   from the drawing
 *   rejoin (optional)          the old leg where you clicked back onto the
 *                              faint line, trimmed; legs after it kept, their
 *                              stops keep their offsets (indices shift)
 * Time stops on removed legs re-attach if the new line passes within
 * NEAR_M, otherwise they lose `attach` (off route) and the itinerary flags
 * them. Stops are never deleted by an edit.
 */

import { map } from "./app.js"; // circular; runtime only
import { TripManager, escapeHTML } from "./trip-panel.js"; // circular; runtime only
import { startRouteDrawing, isDrawingRoute, isDeleteMode, fetchElevationProfile } from "./planning.js"; // circular; runtime only
import { isStopToolActive, addStopAt } from "./stops.js"; // circular; runtime only
import {
  isLineTrip, mainRoute, lineIndex, sliceM, locateM, resolveAttach, passesNear, nearestOnLine,
  isTimeStop, round6, hav, MI, NEAR_M, buildPlan,
} from "./line-model.js";

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
  TripManager.render();
  TripManager.save();
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
// Building a new line from leg records
// ---------------------------------------------------------------------------

const samePos = (a, b) => a[0] === b[0] && a[1] === b[1];
const len = (c) => { let s = 0; for (let i = 1; i < c.length; i++) s += hav(c[i - 1], c[i]); return s; };

/**
 * Legs → route geometry + 1.1/1.2 properties. Each leg: { coords, seg }
 * where seg holds mode / reason / osm_way_ids / mirror_of.
 */
function assemble(legRecs) {
  const coords = [], segments = [];
  legRecs.forEach((leg, k) => {
    const pts = leg.coords.map(round6);
    let s = coords.length - 1;
    if (s < 0 || !samePos(coords[s], pts[0])) { s = coords.length; coords.push(pts[0]); }
    for (let j = 1; j < pts.length; j++) coords.push(pts[j]);
    const seg = { mode: leg.seg.mode || "trail", from_vertex: k, to_vertex: k + 1, coord_range: [s, coords.length - 1], length_m: Math.round(len(pts) * 10) / 10 };
    if (leg.seg.reason && seg.mode === "straight") seg.reason = leg.seg.reason;
    if (seg.mode === "trail" && Array.isArray(leg.seg.osm_way_ids)) seg.osm_way_ids = leg.seg.osm_way_ids;
    if (Number.isInteger(leg.seg.mirror_of)) seg.mirror_of = leg.seg.mirror_of;
    segments.push(seg);
  });
  if (coords.length < 2 && coords.length) coords.push([...coords[0]]);
  const vertex_coords = legRecs.length ? [round6(legRecs[0].coords[0]), ...legRecs.map((l) => round6(l.coords.at(-1)))] : [];
  return {
    geometry: { type: "LineString", coordinates: coords },
    props: {
      segments,
      vertex_coords,
      vertex_snapped: vertex_coords.map((_, i) => segments[Math.min(i, segments.length - 1)]?.mode === "trail"),
      vertex_types: vertex_coords.map(() => "route"),
      main_route_distance_mi: len(coords) / MI,
    },
  };
}

/** Old leg k as a record (optionally trimmed to [m0, m1] of the old line). */
function oldLeg(ix, segs, k, m0 = null, m1 = null) {
  const L = ix.legs[k];
  const a = m0 ?? L.startM, b = m1 ?? L.endM;
  const coords = m0 == null && m1 == null ? ix.coords.slice(L.a, L.b + 1) : sliceM(ix, a, b);
  const seg = { ...(segs[k] || { mode: "trail" }) };
  if (m0 != null || m1 != null) delete seg.mirror_of; // a trimmed leg is no longer a mirror
  return { coords: coords.length >= 2 ? coords : [coords[0], coords[0]], seg, old: k };
}

/** Mirrored return legs for the outbound legs of `recs` (those without mirror_of). */
function mirrorLegs(recs) {
  const out = [];
  for (let k = recs.length - 1; k >= 0; k--) {
    if (Number.isInteger(recs[k].seg.mirror_of)) continue;
    const s = recs[k].seg;
    out.push({ coords: [...recs[k].coords].reverse(), seg: { mode: s.mode, reason: s.reason, osm_way_ids: s.osm_way_ids ? [...s.osm_way_ids].reverse() : undefined, mirror_of: k } });
  }
  return out;
}

/**
 * Replace the line from cutM to the end (or to the rejoin point) with the
 * drawn legs. `newLegs`: [{ coords, mode, reason, wayIds }]. `rejoinM`:
 * metre on the OLD line where the drawing rejoined, or null.
 */
export function commitRedraw({ cutM, rejoinM = null, newLegs, routing }) {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  if (!route || !newLegs.length) return;
  snapshot(cutM >= lineIndex(route).total - 1 ? "extend the line" : "redraw");
  const rp = route.properties;
  const ix = lineIndex(route);
  const segs = rp.segments || [];
  const total = ix.total;
  const extending = cutM >= total - 0.5;
  const firstMirror = segs.findIndex((s) => Number.isInteger(s.mirror_of));
  const cut = locateM(ix, Math.min(cutM, total));
  const cutLeg = extending ? ix.legs.length - 1 : cut.leg;
  const cutOff = extending ? ix.legs.at(-1).len : cut.offset_m;

  // 1. Kept legs before the cut (+ the trimmed cut leg).
  const recs = [];
  const map0 = new Map(); // old leg → { newLeg, shift } for stops that keep their place
  for (let k = 0; k < cutLeg; k++) { map0.set(k, { leg: recs.length, shift: 0, maxOff: Infinity }); recs.push(oldLeg(ix, segs, k)); }
  if (cutOff >= ix.legs[cutLeg].len - 0.5) { map0.set(cutLeg, { leg: recs.length, shift: 0, maxOff: Infinity }); recs.push(oldLeg(ix, segs, cutLeg)); }
  else if (cutOff > 0.5) { map0.set(cutLeg, { leg: recs.length, shift: 0, maxOff: cutOff }); recs.push(oldLeg(ix, segs, cutLeg, ix.legs[cutLeg].startM, cutM)); }
  const newStartM = recs.reduce((s, r) => s + len(r.coords), 0);

  // 2. The drawn legs (pinned exactly to the cut and the rejoin points).
  const cutPt = sliceM(ix, cutM, cutM)[0];
  newLegs.forEach((l, j) => {
    const c = l.coords.slice();
    if (j === 0 && hav(c[0], cutPt) > 0.5) c.unshift(cutPt);
    recs.push({ coords: c, seg: { mode: l.mode, reason: l.reason, osm_way_ids: l.wayIds } });
  });

  // 3. Rejoin: the rest of the old line from there on.
  const map1 = new Map();
  if (rejoinM != null) {
    const rj = locateM(ix, rejoinM);
    const last = recs.at(-1);
    const rjPt = sliceM(ix, rejoinM, rejoinM)[0];
    if (hav(last.coords.at(-1), rjPt) > 0.5) last.coords.push(rjPt);
    const L = ix.legs[rj.leg];
    if (L.len - rj.offset_m > 0.5) { map1.set(rj.leg, { leg: recs.length, shift: rj.offset_m, minOff: rj.offset_m }); recs.push(oldLeg(ix, segs, rj.leg, rejoinM, L.endM)); }
    for (let k = rj.leg + 1; k < ix.legs.length; k++) { map1.set(k, { leg: recs.length, shift: 0, minOff: -Infinity }); recs.push(oldLeg(ix, segs, k)); }
  }
  // Mirror links survive only while their outbound leg is kept untouched.
  const remapOld = new Map();
  recs.forEach((r, i) => { if (r.old != null && !(map0.get(r.old)?.maxOff < Infinity) && !(map1.get(r.old)?.minOff > -Infinity)) remapOld.set(r.old, i); });
  for (const r of recs) if (Number.isInteger(r.seg.mirror_of)) {
    if (remapOld.has(r.seg.mirror_of)) r.seg.mirror_of = remapOld.get(r.seg.mirror_of); else delete r.seg.mirror_of;
  }
  // "Return the same way" stays linked: redrawing the way out (no rejoin,
  // cut before the return) regenerates the way back from the new outbound.
  let regenerated = false;
  if (rp.return_same_way && rejoinM == null && !extending && (firstMirror < 0 || cutLeg < firstMirror)) {
    recs.push(...mirrorLegs(recs));
    regenerated = true;
  }

  // 4. Write the new line.
  const oldStops = trip.features.filter((f) => isTimeStop(f.properties) && f.properties.attach && (!f.properties.attach.route_id || f.properties.attach.route_id === rp._id))
    .map((f) => ({ f, at: { ...f.properties.attach }, coord: resolveAttach(ix, f.properties.attach)?.coord || f.geometry.coordinates, pass: f.properties.pass }));
  const plan0 = buildPlan(trip);
  const campNo = new Map(plan0.camps.map((c) => [c.id, c.n]));
  const built = assemble(recs);
  route.geometry = built.geometry;
  Object.assign(rp, built.props);
  delete rp.elevation_profile; delete rp.elevation_gain_ft; delete rp.elevation_loss_ft;
  if (routing) rp.routing = routing;
  if (recs.some((r) => Number.isInteger(r.seg.mirror_of))) rp.return_same_way = true; else delete rp.return_same_way;
  const nix = lineIndex(route);

  // 5. Stops: keep, shift, re-attach or flag.
  const lost = [];
  let reattached = 0;
  for (const s of oldStops) {
    const { leg, offset_m } = s.at;
    const k0 = map0.get(leg), k1 = map1.get(leg);
    if (k0 && offset_m <= k0.maxOff + 0.01) { s.f.properties.attach = { route_id: rp._id, leg: k0.leg, offset_m }; continue; }
    if (k1 && offset_m >= k1.minOff - 0.01) { s.f.properties.attach = { route_id: rp._id, leg: k1.leg, offset_m: Math.round((offset_m - k1.shift) * 10) / 10 }; continue; }
    const passes = passesNear(nix, s.coord, NEAR_M);
    if (passes.length) {
      const fresh = passes.filter((p) => p.m >= newStartM - 1);
      const pick = s.pass === "back" ? (fresh.at(-1) || passes.at(-1)) : (fresh[0] || passes[0]);
      s.f.properties.attach = { route_id: rp._id, ...locateM(nix, pick.m) };
      reattached++;
    } else {
      delete s.f.properties.attach;
      s.f.geometry = { type: "Point", coordinates: round6(s.coord) };
      const p = s.f.properties;
      const label = p.type === "camp" ? `Camp ${campNo.get(p._id) || ""}`.trim() : "A break";
      lostLabels.set(p._id, label);
      lost.push(p.name || label);
    }
  }

  TripManager.render();
  TripManager.save();
  fetchElevationProfile(route.geometry.coordinates, rp._id);
  const what = extending ? "Extended the line" : rejoinM != null ? "Redrew a section" : "Redrew from here";
  if (lost.length) showToast(`${lost.join(", ")} ${lost.length === 1 ? "is" : "are"} off your route now`, { undoable: true, warn: true, ms: 9000 });
  else showToast(`${what}${regenerated ? ", the way back follows it" : ""}${reattached ? `. ${reattached} stop${reattached === 1 ? "" : "s"} moved onto the new line` : ""}`, { undoable: true });
}

/** Append the way back: every outbound leg reversed, linked by mirror_of. */
export function returnSameWay() {
  const trip = TripManager.currentTrip;
  const route = mainRoute(trip);
  if (!route || route.properties.return_same_way) return;
  snapshot("return the same way");
  const ix = lineIndex(route);
  const segs = route.properties.segments || [];
  const recs = ix.legs.map((L) => oldLeg(ix, segs, L.k));
  const built = assemble([...recs, ...mirrorLegs(recs)]);
  const rp = route.properties;
  const prof = rp.elevation_profile;
  route.geometry = built.geometry;
  Object.assign(rp, built.props);
  rp.return_same_way = true;
  if (Array.isArray(prof) && prof.length >= 2) {
    // The way back climbs what the way out descended: mirror the profile.
    const both = [...prof, ...[...prof].reverse().slice(1)];
    const n = Math.min(100, both.length);
    rp.elevation_profile = Array.from({ length: n }, (_, j) => both[Math.round((j * (both.length - 1)) / (n - 1))]);
    const g = rp.elevation_gain_ft || 0, l = rp.elevation_loss_ft || 0;
    rp.elevation_gain_ft = g + l; rp.elevation_loss_ft = g + l;
  } else {
    fetchElevationProfile(route.geometry.coordinates, rp._id);
  }
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
  if (!hit) return;
  const route = mainRoute(trip);
  const ix = lineIndex(route);
  const pt = [e.lngLat.lng, e.lngLat.lat];
  // On overlapping passes, take the pass in the day that was clicked.
  const plan = buildPlan(trip);
  const day = plan.days[hit.properties.day_index];
  const passes = passesNear(ix, pt, 60);
  const inDay = day ? passes.find((p) => p.m >= day.fromM - 1 && p.m <= day.toM + 1) : null;
  const at = inDay || passes[0] || nearestOnLine(ix, pt);
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
  });
}

let inited = false;
export function initRouteEdit() {
  if (inited) return;
  inited = true;
  map.on("click", onLineClick);
  document.addEventListener("keydown", (e) => {
    if (isDrawingRoute) return; // the drawing has its own undo
    const t = e.target;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
      if (undo()) e.preventDefault();
    }
  });
}

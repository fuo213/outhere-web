/**
 * Line edits of a 1.2 trip, pure (no DOM, no map): the data side of
 * "Redraw from here", drawing on from the end, and "Return the same way".
 * route-edit.js wraps these with undo, rendering and the toast.
 *
 * redrawLine() stitches a drawn path into the line:
 *   kept legs before the cut   unchanged geometry, same leg index + offset
 *   the cut leg                trimmed at the cut
 *   new legs                   from the drawing
 *   rejoin (optional)          the old leg where the drawing came back onto
 *                              the line, trimmed; legs after it kept, their
 *                              stops keep their offsets (indices shift)
 * On an out-and-back whose way back is still fully linked to the way out
 * (every return leg is a mirror), changing the way out regenerates the whole
 * way back from the new outbound. A way back that was edited by hand is
 * never regenerated.
 * Time stops on removed legs re-attach if the new line passes within NEAR_M,
 * otherwise they lose `attach` (off route). Stops are never deleted.
 */

import {
  mainRoute, lineIndex, sliceM, locateM, resolveAttach, passesNear, buildPlan,
  isTimeStop, round6, hav, MI, NEAR_M, OVERLAP_M,
} from "./line-model.js";
import { gainLoss } from "./elevation.js";

const samePos = (a, b) => a[0] === b[0] && a[1] === b[1];
const len = (c) => { let s = 0; for (let i = 1; i < c.length; i++) s += hav(c[i - 1], c[i]); return s; };
const r1 = (v) => Math.round(v * 10) / 10;

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
    const seg = { mode: leg.seg.mode || "trail", from_vertex: k, to_vertex: k + 1, coord_range: [s, coords.length - 1], length_m: r1(len(pts)) };
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
 * How the way back relates to the way out.
 * @returns {{ firstMirror: number, linked: boolean }} firstMirror = index of
 *   the first return leg (-1: no return); linked = the return is exactly the
 *   outbound legs reversed (nothing redrawn by hand).
 */
export function returnLink(segs) {
  const firstMirror = (segs || []).findIndex((s) => Number.isInteger(s.mirror_of));
  if (firstMirror < 0) return { firstMirror, linked: false };
  const linked = segs.length === 2 * firstMirror &&
    segs.slice(firstMirror).every((s, j) => s.mirror_of === firstMirror - 1 - j);
  return { firstMirror, linked };
}

/**
 * A time stop whose stretch of line is gone: it stays where it is, off route
 * (no `attach`, no `pass`), and is reported so the UI can say so. Shared by
 * redrawLine and deleteLine; stops are never deleted.
 */
function detachStop(f, coord, campNo) {
  const p = f.properties;
  delete p.attach;
  delete p.pass;
  f.geometry = { type: "Point", coordinates: round6(coord) };
  return { id: p._id, kind: p.type, name: p.name || "", label: p.type === "camp" ? `Camp ${campNo.get(p._id) || ""}`.trim() : "A break" };
}

/**
 * The section (stretch between two adjacent hidden anchors = one leg) under
 * metre m of the line.
 * @returns {null | { leg, startM, endM, count, where: "only"|"first"|"last"|"middle" }}
 */
export function sectionAt(route, m) {
  if (!route) return null;
  const ix = lineIndex(route);
  const L = ix.legs[locateM(ix, Math.max(0, Math.min(ix.total, m))).leg];
  if (!L) return null;
  const n = ix.legs.length;
  const where = n === 1 ? "only" : L.k === 0 ? "first" : L.k === n - 1 ? "last" : "middle";
  return { leg: L.k, startM: L.startM, endM: L.endM, count: n, where };
}

/** Coordinates of a section, for highlighting. */
export function sectionCoords(route, leg) {
  const ix = lineIndex(route);
  const L = ix.legs[leg];
  return L ? ix.coords.slice(L.a, L.b + 1) : [];
}

/** The two anchors a section joins: [from, to] ([lon, lat]). */
export function sectionEnds(route, leg) {
  const c = sectionCoords(route, leg);
  return c.length ? [c[0], c.at(-1)] : null;
}

/**
 * Delete one section of the line. Mutates the trip. Built on redrawLine so
 * stops, elevation reuse and a linked way back behave exactly as they do for
 * "Redraw from here":
 *   first / last  the line is trimmed to the neighbouring anchor
 *   middle        the anchors either side are joined by `bridge` (a drawn
 *                 leg { coords, mode, reason?, wayIds? }; the caller routes it,
 *                 and a missing bridge is a straight segment)
 *   only section  the whole line goes (deleteLine)
 * @returns {null | (redrawLine result & { removed: "first"|"last"|"middle"|"line" })}
 */
export function deleteSection(trip, leg, { bridge = null } = {}) {
  const route = mainRoute(trip);
  const L = route ? lineIndex(route).legs[leg] : null;
  if (!L) return null;
  const sec = sectionAt(route, L.startM);
  if (sec.leg !== leg) return null; // a zero-length leg can't be picked by metre
  if (sec.where === "only") { const r = deleteLine(trip); return r && { ...r, removed: "line" }; }
  let res;
  if (sec.where === "last") res = redrawLine(trip, { cutM: sec.startM, newLegs: [] });
  else if (sec.where === "first") res = redrawLine(trip, { cutM: 0, rejoinM: sec.endM, newLegs: [] });
  else {
    const ends = sectionEnds(route, leg);
    res = redrawLine(trip, { cutM: sec.startM, rejoinM: sec.endM, newLegs: [bridge?.coords?.length >= 2 ? bridge : { coords: ends, mode: "manual" }] });
  }
  return res && { ...res, removed: sec.where };
}

/**
 * Replace one section with a drawn leg between the same two anchors (a straight
 * gap snapped to trails). Stops, elevation reuse and a linked way back behave
 * as they do for "Redraw from here". Mutates the trip.
 * @param {{coords, mode, reason?, wayIds?}} leg2
 */
export function replaceSection(trip, leg, leg2) {
  const route = mainRoute(trip);
  const L = route ? lineIndex(route).legs[leg] : null;
  if (!L || !(leg2?.coords?.length >= 2)) return null;
  const sec = sectionAt(route, L.startM);
  if (sec.leg !== leg) return null;
  const res = redrawLine(trip, { cutM: sec.startM, rejoinM: sec.where === "last" || sec.where === "only" ? null : sec.endM, newLegs: [leg2] });
  return res && { ...res, removed: "replaced" };
}

/**
 * Delete the whole line. Its time stops stay where they are as off-route
 * stops (no `attach`); place stops and spurs are untouched. Mutates the trip.
 * @returns {null | { lost: [{ id, kind, name, label }], removed: "line" }}
 */
export function deleteLine(trip) {
  const route = mainRoute(trip);
  if (!route) return null;
  const rp = route.properties;
  const ix = lineIndex(route);
  const campNo = new Map(buildPlan(trip).camps.map((c) => [c.id, c.n]));
  const lost = [];
  for (const f of trip.features) {
    const p = f.properties;
    if (!isTimeStop(p) || !p.attach || (p.attach.route_id && p.attach.route_id !== rp._id)) continue;
    lost.push(detachStop(f, resolveAttach(ix, p.attach)?.coord || f.geometry.coordinates, campNo));
  }
  trip.features = trip.features.filter((f) => f !== route);
  return { lost, removed: "line", extending: false, rejoined: false, regenerated: false, returnNote: null, reattached: 0, reuse: null };
}

/**
 * Replace the line from cutM to the end (or to the rejoin point) with the
 * drawn legs. Mutates the trip.
 * @param {object} trip
 * @param {{ cutM: number, rejoinM?: number|null, newLegs: Array<{coords, mode, reason?, wayIds?}>, routing?: object }} edit
 *   rejoinM: metre on the OLD line where the drawing rejoined, or null.
 * @returns {null | { extending, rejoined, regenerated, returnNote, reattached, lost, reuse }}
 *   returnNote: null | "kept" (hand-edited way back left as it is) |
 *               "removed" (hand-edited way back was after the cut and went with it)
 *   lost: [{ id, kind, name, label }] time stops now off route
 *   reuse: null | { profile, total, spans } the old elevation profile and
 *          where it still applies: spans [{ n0, n1, o0, o1 }] map metres
 *          n0..n1 of the new line onto o0..o1 of the old one (o1 < o0 on a
 *          regenerated way back), so only the drawn legs need fetching
 */
export function redrawLine(trip, { cutM, rejoinM = null, newLegs, routing }) {
  const route = mainRoute(trip);
  // newLegs may be empty for a trim: drop the line from cutM on (no rejoin), or
  // up to rejoinM (cutM 0). Nothing to draw and nothing to cut is no edit.
  if (!route || !Array.isArray(newLegs)) return null;
  if (!newLegs.length && !(rejoinM != null || (cutM > 0.5 && cutM < lineIndex(route).total - 0.5))) return null;
  const rp = route.properties;
  const ix = lineIndex(route);
  const segs = rp.segments || [];
  const total = ix.total;
  const extending = cutM >= total - 0.5;
  const { firstMirror, linked } = returnLink(segs);
  const outN = firstMirror < 0 ? ix.legs.length : firstMirror; // outbound legs
  const cut = locateM(ix, Math.min(cutM, total));
  const cutLeg = extending ? ix.legs.length - 1 : cut.leg;
  const cutOff = extending ? ix.legs.at(-1).len : cut.offset_m;
  const rj = rejoinM != null ? locateM(ix, rejoinM) : null;
  const hasReturn = !!rp.return_same_way && firstMirror >= 0;
  const outboundEdit = hasReturn && !extending && cutLeg < outN && (!rj || rj.leg < outN);
  const regenerate = outboundEdit && linked;
  const returnNote = outboundEdit && !linked ? (rj ? "kept" : "removed") : null;

  // Stops as they stand on the old line.
  const oldStops = trip.features
    .filter((f) => isTimeStop(f.properties) && f.properties.attach && (!f.properties.attach.route_id || f.properties.attach.route_id === rp._id))
    .map((f) => ({ f, at: { ...f.properties.attach }, coord: resolveAttach(ix, f.properties.attach)?.coord || f.geometry.coordinates, pass: f.properties.pass }));
  const campNo = new Map(buildPlan(trip).camps.map((c) => [c.id, c.n]));

  // 1. Kept legs before the cut (+ the trimmed cut leg).
  const recs = [];
  const keeps = []; // { old, leg, lo, hi }: old leg offsets [lo, hi] live on new leg `leg`
  const keep = (old, lo, hi) => keeps.push({ old, leg: recs.length, lo, hi });
  for (let k = 0; k < cutLeg; k++) { keep(k, 0, ix.legs[k].len); recs.push(oldLeg(ix, segs, k)); }
  if (cutOff >= ix.legs[cutLeg].len - 0.5) { keep(cutLeg, 0, ix.legs[cutLeg].len); recs.push(oldLeg(ix, segs, cutLeg)); }
  else if (cutOff > 0.5) { keep(cutLeg, 0, cutOff); recs.push(oldLeg(ix, segs, cutLeg, ix.legs[cutLeg].startM, cutM)); }
  const newStartM = recs.reduce((s, r) => s + len(r.coords), 0);

  // 2. The drawn legs (pinned exactly to the cut and the rejoin points).
  const cutPt = sliceM(ix, cutM, cutM)[0];
  newLegs.forEach((l, j) => {
    const c = l.coords.slice();
    if (j === 0 && hav(c[0], cutPt) > 0.5) c.unshift(cutPt);
    recs.push({ coords: c, seg: { mode: l.mode, reason: l.reason, osm_way_ids: l.wayIds } });
  });

  // 3. Rejoin: the rest of the old line from there on (when the way back
  //    will be regenerated, only the rest of the way out).
  if (rj) {
    const last = recs.at(-1); // none when the start of the line is trimmed off
    const rjPt = sliceM(ix, rejoinM, rejoinM)[0];
    if (last && hav(last.coords.at(-1), rjPt) > 0.5) last.coords.push(rjPt);
    const L = ix.legs[rj.leg];
    if (rj.offset_m < 0.5) { keep(rj.leg, 0, L.len); recs.push(oldLeg(ix, segs, rj.leg)); } // a joint: the whole leg, links intact
    else if (L.len - rj.offset_m > 0.5) { keep(rj.leg, rj.offset_m, L.len); recs.push(oldLeg(ix, segs, rj.leg, rejoinM, L.endM)); }
    const stop = regenerate ? outN : ix.legs.length;
    for (let k = rj.leg + 1; k < stop; k++) { keep(k, 0, ix.legs[k].len); recs.push(oldLeg(ix, segs, k)); }
  }
  // Mirror links on kept return legs survive only while their outbound leg
  // is kept whole.
  const whole = new Map(keeps.filter((q) => q.lo === 0 && q.hi >= ix.legs[q.old].len - 1e-6).map((q) => [q.old, q.leg]));
  for (const r of recs) if (Number.isInteger(r.seg.mirror_of)) {
    if (whole.has(r.seg.mirror_of)) r.seg.mirror_of = whole.get(r.seg.mirror_of); else delete r.seg.mirror_of;
  }
  // 4. A linked way back follows the new way out.
  const nOut = recs.length;
  if (regenerate) recs.push(...mirrorLegs(recs));

  // 5. Write the new line.
  const built = assemble(recs);
  route.geometry = built.geometry;
  Object.assign(rp, built.props);
  const oldProfile = Array.isArray(rp.elevation_profile) && rp.elevation_profile.length >= 2 ? rp.elevation_profile : null;
  delete rp.elevation_profile; delete rp.elevation_gain_ft; delete rp.elevation_loss_ft; delete rp.elevation_source;
  if (routing) rp.routing = routing;
  if (recs.some((r) => Number.isInteger(r.seg.mirror_of))) rp.return_same_way = true; else delete rp.return_same_way;
  const nix = lineIndex(route);
  // Where the old elevation profile still describes the new line.
  const spans = [];
  for (const q of keeps) {
    const o = ix.legs[q.old].startM, L = nix.legs[q.leg];
    spans.push({ n0: L.startM, n1: L.endM, o0: o + q.lo, o1: o + q.hi });
    if (regenerate) { const B = nix.legs[2 * nOut - 1 - q.leg]; spans.push({ n0: B.startM, n1: B.endM, o0: o + q.hi, o1: o + q.lo }); }
  }
  const reuse = oldProfile ? { profile: oldProfile, total, spans } : null;
  const newFirstMirror = rp.segments.findIndex((s) => Number.isInteger(s.mirror_of));
  const turnM = newFirstMirror >= 0 ? nix.legs[newFirstMirror].startM : Infinity;

  // 6. Stops: keep, shift, re-attach or flag.
  const place = (old, off) => keeps.find((q) => q.old === old && off >= q.lo - 0.01 && off <= q.hi + 0.01);
  const lost = [];
  let reattached = 0;
  for (const s of oldStops) {
    const { leg, offset_m } = s.at;
    const p = s.f.properties;
    const wasReturn = firstMirror >= 0 && leg >= firstMirror;
    if (!(regenerate && wasReturn)) {
      const q = place(leg, offset_m);
      if (q) { p.attach = { route_id: rp._id, leg: q.leg, offset_m: r1(Math.max(0, offset_m - q.lo)) }; continue; }
    } else {
      // On the regenerated way back: the same spot on the mirror of the kept
      // outbound leg, when that stretch of the way out survived.
      const o = segs[leg].mirror_of;
      const y = ix.legs[o].len - offset_m; // offset on the outbound leg
      const q = place(o, y);
      if (q) { p.attach = { route_id: rp._id, leg: 2 * nOut - 1 - q.leg, offset_m: r1(Math.max(0, q.hi - y)) }; continue; }
    }
    const near = passesNear(nix, s.coord, NEAR_M);
    if (near.length) {
      // Only passes about as close as the nearest compete (not the next switchback).
      const d0 = Math.min(...near.map((n) => n.d));
      const cands = near.filter((n) => n.d <= d0 + OVERLAP_M);
      const pick = wasReturn || s.pass === "back"
        ? (cands.filter((n) => n.m >= turnM - 1).at(-1) || cands.at(-1))
        : (cands.find((n) => n.m >= newStartM - 1 && n.m <= turnM + 1) || cands.find((n) => n.m >= newStartM - 1) || cands[0]);
      p.attach = { route_id: rp._id, ...locateM(nix, pick.m) };
      reattached++;
    } else {
      lost.push(detachStop(s.f, s.coord, campNo));
    }
  }
  return { extending, rejoined: !!rj, regenerated: regenerate, returnNote, reattached, lost, reuse };
}

/**
 * Append the way back: every outbound leg reversed, linked by mirror_of.
 * The elevation profile (evenly spaced by distance) is mirrored in full: the
 * way back climbs what the way out descended.
 * @returns {boolean} false when there is no line or it already returns
 */
export function appendReturn(trip) {
  const route = mainRoute(trip);
  if (!route || route.properties.return_same_way) return false;
  const ix = lineIndex(route);
  const rp = route.properties;
  const segs = rp.segments || [];
  const recs = ix.legs.map((L) => oldLeg(ix, segs, L.k));
  const built = assemble([...recs, ...mirrorLegs(recs)]);
  const prof = rp.elevation_profile;
  route.geometry = built.geometry;
  Object.assign(rp, built.props);
  rp.return_same_way = true;
  if (Array.isArray(prof) && prof.length >= 2) {
    rp.elevation_profile = [...prof, ...[...prof].reverse().slice(1)];
    // 3DEP figures were counted on a finer series than the stored profile:
    // the way back climbs what the way out lost, so both become their sum.
    const dem = rp.elevation_source === "usgs-3dep" || rp.elevation_source === "mixed";
    const sum = (rp.elevation_gain_ft || 0) + (rp.elevation_loss_ft || 0);
    const { gain, loss } = dem ? { gain: sum, loss: sum } : gainLoss(rp.elevation_profile);
    rp.elevation_gain_ft = gain; rp.elevation_loss_ft = loss;
  }
  return true;
}

/**
 * Move a time stop (camp or break) to metre `m` of the line, on whichever pass
 * that metre belongs to. The stop keeps its id, name and notes; its pass label
 * is recomputed by syncLineTrip. Returns false when there is nothing to move.
 */
export function moveStopAlong(trip, id, m) {
  const route = mainRoute(trip);
  const f = trip.features.find((x) => x.properties?._id === id);
  if (!route || !f || !isTimeStop(f.properties)) return false;
  const ix = lineIndex(route);
  const at = locateM(ix, Math.max(0, Math.min(ix.total, m)));
  f.properties.attach = { route_id: route.properties._id, ...at };
  f.geometry = { type: "Point", coordinates: round6(resolveAttach(ix, at).coord) };
  delete f.properties.pass;
  return true;
}

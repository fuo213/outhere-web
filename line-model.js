/**
 * The line + stops trip model (trip format 1.2), pure: no DOM, no map.
 *
 * A 1.2 trip has one main `route` (the line). Clicks only guided its
 * routing; they live on as hidden anchors (`vertex_coords` / `segments`).
 * Everything else is a stop:
 *   time stops   camp, break    attach: { route_id, leg, offset_m } (absent = off route)
 *   place stops  waypoint       subtype water | hazard | scenic | note (no attach)
 *
 * Days build themselves: camps number in order along the line; Day N runs
 * from camp N-1 (or Start) to camp N (or Finish); `nights` > 1 adds rest days.
 *
 * Anchors resolve per leg (segment index + metres into that leg), never by
 * global nearest point, so a stop on one pass of an out-and-back stays on
 * that pass when the line is edited.
 */

import { gainLoss } from "./elevation.js";

export const MI = 1609.344;
/** "Within the snap distance" for checks that have no zoom (listing place
 *  stops on passes, re-attaching stops after a redraw). Matches the drawing
 *  snap's upper bound (planning.js SNAP_MAX_M is 200; 24 px at z14 ≈ 150 m). */
export const NEAR_M = 120;
/** Two passes of the line closer than this are the same trail walked twice
 *  (an out-and-back), not neighbouring switchbacks: Out / Back applies. */
export const OVERLAP_M = 30;
/** A place stop is listed once per visit. Passes closer than this along the
 *  line (switchbacks beside a spring) are one visit; an out-and-back's two
 *  passes, further apart than this, are two (see visitsNear). */
export const SEPARATE_VISIT_M = 1000;

const RAD = Math.PI / 180;
const R = 6371008.8;

export function hav(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const round6 = (c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

export const TIME_KINDS = ["camp", "break"];
export const PLACE_KINDS = ["water", "hazard", "scenic", "note"];

/** Stop kind of a feature: camp | break | water | hazard | scenic | note | null. */
export function stopKind(p) {
  if (!p) return null;
  if (p.type === "camp" || p.type === "break") return p.type;
  if (p.type === "waypoint") return PLACE_KINDS.includes(p.subtype) ? p.subtype : p.subtype || "note";
  return null;
}
export const isTimeStop = (p) => p?.type === "camp" || p?.type === "break";

/** A 1.2 (line + stops) trip. Older trips keep the day-assignment model. */
export const isLineTrip = (trip) => trip?.properties?.schema_version === "1.2";

export function mainRoute(trip) {
  return (trip?.features || []).find((f) => f.properties?.type === "route" && f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2) || null;
}

// ---------------------------------------------------------------------------
// Line index: cumulative metres + per-leg ranges
// ---------------------------------------------------------------------------

const ixCache = new WeakMap(); // coordinates array → index

/**
 * { coords, cum (m), total, legs: [{ k, a, b, startM, endM, len }] }.
 * Legs come from `segments[].coord_range`; a route without segments is one leg.
 */
export function lineIndex(route) {
  const coords = route.geometry.coordinates;
  const segs = route.properties.segments;
  const cached = ixCache.get(coords);
  if (cached && cached.segs === segs && cached.nSegs === (segs?.length || 0)) return cached;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav(coords[i - 1], coords[i]));
  const n = coords.length;
  const legs = (Array.isArray(segs) && segs.length ? segs : [{ coord_range: [0, n - 1] }]).map((s, k) => {
    let [a, b] = Array.isArray(s.coord_range) ? s.coord_range : [0, n - 1];
    a = Math.max(0, Math.min(n - 1, a)); b = Math.max(a, Math.min(n - 1, b));
    return { k, a, b, startM: cum[a], endM: cum[b], len: cum[b] - cum[a] };
  });
  const ix = { coords, cum, total: cum[n - 1], legs, segs, nSegs: segs?.length || 0 };
  ixCache.set(coords, ix);
  return ix;
}

/** Index of the coordinate interval containing metre m (binary search). */
function intervalAt(ix, m) {
  const { cum } = ix;
  let lo = 0, hi = cum.length - 1;
  if (m <= 0) return 1;
  if (m >= cum[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
  return hi;
}

export function pointAtM(ix, m) {
  const { coords, cum } = ix;
  if (coords.length === 1) return coords[0];
  const i = intervalAt(ix, m);
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? Math.max(0, Math.min(1, (m - cum[i - 1]) / span)) : 0;
  return [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])];
}

/** Coordinates of the line between metres m0 and m1 (endpoints interpolated). */
export function sliceM(ix, m0, m1) {
  const { coords, cum } = ix;
  m0 = Math.max(0, m0); m1 = Math.min(ix.total, m1);
  const out = [pointAtM(ix, m0)];
  for (let i = 0; i < coords.length; i++) if (cum[i] > m0 + 1e-6 && cum[i] < m1 - 1e-6) out.push(coords[i]);
  out.push(pointAtM(ix, m1));
  return out;
}

/** Global metre of an attach, or null when its leg doesn't exist. */
export function resolveAttach(ix, attach) {
  if (!attach || !Number.isInteger(attach.leg)) return null;
  const leg = ix.legs[attach.leg];
  if (!leg) return null;
  const m = leg.startM + Math.max(0, Math.min(leg.len, attach.offset_m || 0));
  return { m, coord: pointAtM(ix, m), leg: attach.leg };
}

/** { leg, offset_m } for a global metre (a joint belongs to the leg that starts there). */
export function locateM(ix, m) {
  let leg = ix.legs.find((l) => m < l.endM - 1e-6) || ix.legs.at(-1);
  if (m < leg.startM) leg = ix.legs[0];
  return { leg: leg.k, offset_m: Math.round(Math.max(0, Math.min(leg.len, m - leg.startM)) * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Projection: nearest point and passes
// ---------------------------------------------------------------------------

/** Distance and foot (metre along the line) for every coordinate interval. */
function feet(ix, p) {
  const { coords, cum } = ix;
  const kx = Math.cos(p[1] * RAD) * 111320, ky = 110574;
  const out = [];
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * kx, ay = (coords[i - 1][1] - p[1]) * ky;
    const bx = (coords[i][0] - p[0]) * kx, by = (coords[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    out.push({ i, d: Math.hypot(ax + t * dx, ay + t * dy), m: cum[i - 1] + t * (cum[i] - cum[i - 1]) });
  }
  return out;
}

export function nearestOnLine(ix, p) {
  let best = { d: Infinity, m: 0 };
  for (const f of feet(ix, p)) if (f.d < best.d) best = f;
  return { m: best.m, d: best.d, coord: pointAtM(ix, best.m) };
}

/**
 * Every pass of the line within radius of p, in walking order: runs of
 * consecutive intervals within the radius, each reduced to its closest foot.
 * Runs that are close in walking distance (a zigzag dipping out) merge.
 */
export function passesNear(ix, p, radius = NEAR_M) {
  const runs = [];
  let cur = null;
  for (const f of feet(ix, p)) {
    if (f.d > radius) { cur = null; continue; }
    if (cur && f.i === cur.lastI + 1) { cur.lastI = f.i; if (f.d < cur.d) { cur.d = f.d; cur.m = f.m; } continue; }
    cur = { d: f.d, m: f.m, lastI: f.i };
    runs.push(cur);
  }
  const merged = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && r.m - last.m < radius * 2.5) { if (r.d < last.d) { last.d = r.d; last.m = r.m; } continue; }
    merged.push({ ...r });
  }
  return merged.map((r) => ({ m: r.m, d: r.d, coord: pointAtM(ix, r.m) }));
}

/**
 * Separate visits of the line to a place, in walking order. The closest
 * pass always counts. Another pass is its own visit only when it is more
 * than SEPARATE_VISIT_M along the line from every visit already counted AND
 * comes about as close as the closest one (the same trail walked again, as
 * on an out-and-back). Neighbouring switchbacks are one visit.
 */
export function visitsNear(ix, p, radius = NEAR_M) {
  const passes = passesNear(ix, p, radius).sort((a, b) => a.d - b.d);
  const visits = [];
  for (const q of passes) {
    if (!visits.length) { visits.push(q); continue; }
    if (q.d > visits[0].d + OVERLAP_M) break; // sorted by distance: the rest are further still
    if (visits.every((v) => Math.abs(v.m - q.m) > SEPARATE_VISIT_M)) visits.push(q);
  }
  return visits.sort((a, b) => a.m - b.m);
}

/**
 * Where a time stop dropped at p goes: the first pass after `afterM` (the
 * previous camp), else the first pass. Null when no pass is within radius.
 */
export function choosePass(ix, p, radius, afterM = -1) {
  const near = passesNear(ix, p, radius);
  if (!near.length) return null;
  // Only passes as close as the nearest one compete (overlapping trail); a
  // neighbouring switchback a little further away is not what was clicked.
  const d0 = Math.min(...near.map((q) => q.d));
  const passes = near.filter((q) => q.d <= d0 + OVERLAP_M);
  const pick = passes.find((q) => q.m > afterM + 1) || passes[0];
  return { ...pick, passes, passIndex: passes.indexOf(pick) };
}

// ---------------------------------------------------------------------------
// The plan: camps, days, stops per day
// ---------------------------------------------------------------------------

const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Day-by-day plan of a 1.2 trip.
 * @returns {{ route, ix, total, camps, days, offRoute, stops }}
 *   camps:    [{ f, id, n, m, nights }] in walking order (attached only)
 *   days:     [{ i, n, kind: "move"|"rest", key, fromM, toM, from, to, camp, date, stops, spurs }]
 *             from/to: { label, id|null } ("Start", "Camp 1"…, "Finish")
 *             stops:   [{ id, f, kind, m, dayM, pass, passes, offRoute }] in walking order
 *   offRoute: time stops whose attach is missing or broken
 */
export function buildPlan(trip) {
  const route = mainRoute(trip);
  const plan = { route, ix: null, total: 0, camps: [], days: [], offRoute: [], stopsById: new Map() };
  if (!route) return plan;
  const ix = lineIndex(route);
  plan.ix = ix;
  plan.total = ix.total;
  const rid = route.properties._id;
  const points = trip.features.filter((f) => f.geometry?.type === "Point" && stopKind(f.properties));

  // Resolve time stops.
  const timed = [];
  for (const f of points) {
    const p = f.properties;
    if (!isTimeStop(p)) continue;
    const r = p.attach && (!p.attach.route_id || p.attach.route_id === rid) ? resolveAttach(ix, p.attach) : null;
    if (r) timed.push({ f, id: p._id, kind: p.type, m: r.m, coord: r.coord });
    else plan.offRoute.push({ f, id: p._id, kind: p.type, near: nearestOnLine(ix, f.geometry.coordinates) });
  }
  timed.sort((a, b) => a.m - b.m);
  plan.camps = timed.filter((t) => t.kind === "camp").map((t, k) => ({ ...t, n: k + 1, nights: Math.max(1, parseInt(t.f.properties.nights, 10) || 1) }));
  const campNo = new Map(plan.camps.map((c) => [c.id, c.n]));
  plan.campLabel = (id) => (campNo.has(id) ? `Camp ${campNo.get(id)}` : "Camp");

  // Days: Start → camp 1 → … → Finish, rest days after multi-night camps.
  const ends = [{ label: "Start", id: null, m: 0 }, ...plan.camps.map((c) => ({ label: c.f.properties.name || `Camp ${c.n}`, short: `Camp ${c.n}`, id: c.id, m: c.m, camp: c })), { label: "Finish", id: null, m: ix.total }];
  const start = trip.properties?.dates?.start || null;
  for (let j = 0; j + 1 < ends.length; j++) {
    const a = ends[j], b = ends[j + 1];
    const last = j + 2 === ends.length;
    // A camp at the very end of the line: no zero-length walk out after it.
    if (last && plan.camps.length && b.m - a.m < 30) break;
    plan.days.push({ kind: "move", key: `to:${b.id || "finish"}`, fromM: a.m, toM: b.m, from: a, to: b, camp: b.camp || null });
    const c = b.camp;
    if (c) for (let r = 1; r < c.nights; r++) plan.days.push({ kind: "rest", key: `rest:${c.id}:${r}`, fromM: c.m, toM: c.m, from: b, to: b, camp: c });
  }
  plan.days.forEach((d, i) => { d.i = i; d.n = i + 1; d.date = start ? addDays(start, i) : null; d.stops = []; d.spurs = []; });
  const moveDayAt = (m) => plan.days.find((d) => d.kind === "move" && m >= d.fromM - 1e-6 && m < d.toM - 1e-6) ||
    plan.days.filter((d) => d.kind === "move").at(-1) || plan.days[0];
  const arrivalDay = (campId) => plan.days.find((d) => d.kind === "move" && d.camp?.id === campId);

  const addStop = (day, entry) => { if (!day) return; day.stops.push({ ...entry, dayM: entry.m - day.fromM }); };

  for (const t of timed) {
    const passes = passesNear(ix, t.coord, OVERLAP_M);
    const pIdx = passes.findIndex((q) => Math.abs(q.m - t.m) < OVERLAP_M * 2.5);
    const entry = { id: t.id, f: t.f, kind: t.kind, m: t.m, passes: passes.length, pass: pIdx, offRoute: false };
    plan.stopsById.set(t.id, entry);
    addStop(t.kind === "camp" ? arrivalDay(t.id) : moveDayAt(t.m), entry);
  }
  for (const o of plan.offRoute) {
    const entry = { id: o.id, f: o.f, kind: o.kind, m: o.near.m, nearD: o.near.d, offRoute: true, passes: 0, pass: -1 };
    plan.stopsById.set(o.id, entry);
    addStop(moveDayAt(o.near.m), entry);
  }
  // Place stops: listed once per visit (see visitsNear).
  for (const f of points) {
    const p = f.properties;
    if (isTimeStop(p)) continue;
    const kind = stopKind(p);
    const passes = visitsNear(ix, f.geometry.coordinates, NEAR_M);
    if (!passes.length) {
      const near = nearestOnLine(ix, f.geometry.coordinates);
      const entry = { id: p._id, f, kind, m: near.m, nearD: near.d, offRoute: true, passes: 0, pass: -1 };
      plan.stopsById.set(p._id, entry);
      addStop(moveDayAt(near.m), entry);
      continue;
    }
    passes.forEach((q, k) => {
      const entry = { id: p._id, f, kind, m: q.m, passes: passes.length, pass: k, offRoute: false };
      if (k === 0) plan.stopsById.set(p._id, entry);
      addStop(moveDayAt(q.m), entry);
    });
  }
  // Day-hike spurs belong to the day of the stop they leave from.
  for (const f of trip.features) {
    const p = f.properties;
    if (p?.type !== "dayhike_spur" || f.geometry?.type !== "LineString") continue;
    const from = p.from_stop && plan.stopsById.get(p.from_stop);
    let day = null, m;
    if (from) {
      m = from.m;
      if (from.kind === "camp" && !from.offRoute) {
        const arr = arrivalDay(from.id);
        day = plan.days.find((d) => d.kind === "rest" && d.camp?.id === from.id) || arr;
      } else day = moveDayAt(m);
    } else {
      m = nearestOnLine(ix, f.geometry.coordinates[0]).m;
      day = moveDayAt(m);
    }
    if (!day) continue;
    let len = 0; const c = f.geometry.coordinates;
    for (let k = 1; k < c.length; k++) len += hav(c[k - 1], c[k]);
    day.spurs.push({ id: p._id, f, m, rt: (2 * len) / MI, fromStop: p.from_stop || null });
  }
  for (const d of plan.days) d.stops.sort((a, b) => a.m - b.m || (a.kind === "camp") - (b.kind === "camp"));
  return plan;
}

/** Out / Back label for a stop's pass on an overlapping section, or "". */
export function passLabel(entry) {
  if (!entry || entry.passes < 2 || entry.pass < 0) return "";
  if (entry.passes === 2) return entry.pass === 0 ? "out" : "back";
  return `pass ${entry.pass + 1}`;
}

// ---------------------------------------------------------------------------
// Keeping trip.days (mobile reads it) and stop geometry in step with the plan
// ---------------------------------------------------------------------------

/**
 * Rewrite trip.days / unassigned from the plan (day ids and notes follow
 * each day's key: the camp it ends at, or its rest index), move attached
 * stops onto their resolved positions, and stamp camp dates. Idempotent.
 */
export function syncLineTrip(trip, plan = buildPlan(trip)) {
  if (!isLineTrip(trip)) return plan;
  const old = trip.days || [];
  const byKey = new Map(old.filter((d) => d._key).map((d) => [d._key, d]));
  const routeId = plan.route?.properties._id;
  trip.days = plan.days.map((d, i) => {
    const prev = byKey.get(d.key) || (!old.some((o) => o._key) ? old[i] : null);
    const ids = [];
    if (d.kind === "move" && routeId) ids.push(routeId);
    if (d.kind === "rest" && d.camp) ids.push(d.camp.id);
    for (const s of d.stops) if (!ids.includes(s.id)) ids.push(s.id);
    for (const s of d.spurs) if (!ids.includes(s.id)) ids.push(s.id);
    return { id: prev?.id || crypto.randomUUID(), date: d.date, features: ids, notes: prev?.notes || "", _key: d.key };
  });
  const used = new Set(trip.days.flatMap((d) => d.features));
  trip.unassigned = trip.features.map((f) => f.properties._id).filter((id) => !used.has(id));
  const start = trip.properties.dates?.start;
  if (start) trip.properties.dates = { start, end: addDays(start, Math.max(0, trip.days.length - 1)) };

  if (plan.ix) {
    for (const f of trip.features) {
      const p = f.properties;
      if (!isTimeStop(p) || !p.attach) continue;
      const r = resolveAttach(plan.ix, p.attach);
      if (r) f.geometry = { type: "Point", coordinates: round6(r.coord) };
    }
  }
  if (plan.route) {
    const spurMi = plan.days.reduce((a, d) => a + d.spurs.reduce((b, s) => b + s.rt, 0), 0);
    if (spurMi > 0) plan.route.properties.dayhike_distance_mi = spurMi; else delete plan.route.properties.dayhike_distance_mi;
  }
  for (const c of plan.camps) {
    const d = plan.days.find((x) => x.kind === "move" && x.camp?.id === c.id);
    c.f.properties.date = d?.date || "";
    c.f.properties.night_number = c.n;
  }
  for (const s of plan.stopsById.values()) {
    if (s.kind === "camp" || s.kind === "break") {
      const lbl = passLabel(s);
      if (lbl === "out" || lbl === "back") s.f.properties.pass = lbl; else delete s.f.properties.pass;
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// A legacy-shaped view of the trip for the map chart and the profile
// ---------------------------------------------------------------------------

function sliceProfile(profile, total, m0, m1) {
  if (!Array.isArray(profile) || profile.length < 2 || !(total > 0)) return null;
  const n = profile.length;
  const at = (m) => {
    const t = Math.max(0, Math.min(1, m / total)) * (n - 1);
    const k = Math.min(n - 2, Math.floor(t));
    return profile[k] + (t - k) * (profile[k + 1] - profile[k]);
  };
  // Same density as the stored profile (no cap: a day keeps every sample it spans).
  const k = Math.max(2, Math.round(((m1 - m0) / total) * (n - 1)) + 1);
  return Array.from({ length: k }, (_, j) => Math.round(at(m0 + ((m1 - m0) * j) / (k - 1))));
}

/**
 * The trip as the day-assignment code expects it: the line cut into one
 * route feature per walking day (ids `<route>~<day>`), legs re-ranged so the
 * per-leg styling and gap pins still work, elevation sliced per day, breaks
 * drawn with the rest glyph. Each day carries `_stops` (miles into the day,
 * per pass) for the profile. Never saved.
 */
export function displayTrip(trip, plan = buildPlan(trip)) {
  const route = plan.route;
  if (!route) return { ...trip, days: [], unassigned: trip.unassigned || [] };
  const ix = plan.ix;
  const rp = route.properties;
  const prof = rp.elevation_profile;
  const pieces = new Map();
  const features = [];
  for (const d of plan.days) {
    if (d.kind !== "move") continue;
    const coords = [], segments = [];
    for (const leg of ix.legs) {
      const a = Math.max(d.fromM, leg.startM), b = Math.min(d.toM, leg.endM);
      if (b - a < 0.05 && !(leg.len === 0 && a === b)) continue;
      const pts = sliceM(ix, a, b);
      let s = coords.length - 1;
      if (s < 0) { s = 0; coords.push(pts[0]); }
      for (let k = 1; k < pts.length; k++) coords.push(pts[k]);
      const seg = { ...(rp.segments?.[leg.k] || { mode: "trail" }), coord_range: [s, coords.length - 1], length_m: Math.round((b - a) * 10) / 10 };
      segments.push(seg);
    }
    if (coords.length < 2) continue;
    const ep = sliceProfile(prof, ix.total, d.fromM, d.toM);
    const { gain, loss } = ep ? gainLoss(ep) : { gain: 0, loss: 0 };
    const id = `${rp._id}~${d.i}`;
    pieces.set(d.i, id);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        type: "route", _id: id, name: rp.name, segments, routing: rp.routing,
        main_route_distance_mi: (d.toM - d.fromM) / MI,
        ...(ep ? { elevation_profile: ep, elevation_gain_ft: gain, elevation_loss_ft: loss } : {}),
      },
    });
  }
  for (const f of trip.features) {
    const p = f.properties;
    if (f === route) continue;
    if (p.type === "break") { features.push({ ...f, properties: { ...p, point_type: "rest" } }); continue; }
    features.push(f);
  }
  const days = plan.days.map((d, i) => {
    const ids = [];
    if (pieces.has(d.i)) ids.push(pieces.get(d.i));
    if (d.kind === "rest" && d.camp) ids.push(d.camp.id);
    for (const s of d.stops) if (!ids.includes(s.id)) ids.push(s.id);
    for (const s of d.spurs) ids.push(s.id);
    return {
      id: trip.days?.[i]?.id || d.key, date: d.date, features: ids, notes: "",
      _stops: d.stops.map((s) => ({ id: s.id, kind: s.kind === "break" ? "rest" : s.kind, name: s.f.properties.name || "", notes: s.f.properties.notes || "", dayMi: Math.max(0, s.dayM) / MI })),
    };
  });
  return { type: "FeatureCollection", properties: trip.properties, features, days, unassigned: [] };
}

// ---------------------------------------------------------------------------
// Migration: typed vertices (1.1) → attached stops (1.2), when it's cheap
// ---------------------------------------------------------------------------

/**
 * Can this 1.0/1.1 trip switch to the line + stops model? Exactly one routed
 * line (drawn in the planner, not imported). Never done on open: the trip
 * panel offers it (trip-panel.js), with undo.
 */
export function canConvertToLine(trip) {
  if (!trip?.features || isLineTrip(trip)) return false;
  const routes = trip.features.filter((f) => f.properties?.type === "route");
  if (routes.length !== 1 || routes[0].geometry?.type !== "LineString" || routes[0].geometry.coordinates.length < 2) return false;
  const segs = routes[0].properties.segments;
  return Array.isArray(segs) && segs.length > 0 && !segs.some((sg) => sg.mode === "imported");
}

/**
 * Turn an eligible 1.0/1.1 trip (canConvertToLine) into a 1.2 trip, in place:
 *   camp points        attached stops at their vertex (leg + offset)
 *   rest points        one more night at the camp before them
 *   dayhike points     the marker sat at the spur's far end; the day hike now
 *                      leaves from a stop on the line at the spur's branch
 *                      point: the camp there if there is one (the marker's
 *                      name and notes move onto the spur), otherwise the
 *                      marker itself becomes a break at the branch point
 * @returns {boolean} converted
 */
export function convertTypedVertices(trip) {
  if (!canConvertToLine(trip)) return false;
  const route = trip.features.find((f) => f.properties?.type === "route");
  const rp = route.properties;
  const routeIdx = trip.features.indexOf(route);
  const ix = lineIndex(route);
  const vt = Array.isArray(rp.vertex_types) ? rp.vertex_types : [];
  const r1 = (v) => Math.round(v * 10) / 10;
  const attachAtVertex = (vi) => {
    const k = rp.segments.findIndex((sg) => sg.to_vertex === vi);
    if (k >= 0) return { route_id: rp._id, leg: k, offset_m: r1(ix.legs[k].len) };
    const k0 = rp.segments.findIndex((sg) => sg.from_vertex === vi);
    return k0 >= 0 ? { route_id: rp._id, leg: k0, offset_m: 0 } : null;
  };
  /** The main-line vertex a day hike at vertex vi branches from. */
  const branchVertex = (vi) => { let j = vi - 1; while (j > 0 && vt[j] === "dayhike") j--; return j; };
  const spurs = trip.features.filter((f) => f.properties.type === "dayhike_spur" && f.properties.route_index === routeIdx && f.geometry?.type === "LineString");
  const pts = trip.features.filter((f) => f.geometry?.type === "Point" && f.properties.route_index === routeIdx && Number.isInteger(f.properties.route_vertex_index))
    .sort((a, b) => a.properties.route_vertex_index - b.properties.route_vertex_index);
  const remove = new Set();
  const stopAtVertex = new Map(); // vertex → converted camp/break feature there
  let lastCamp = null;
  for (const f of pts) {
    const p = f.properties;
    const t = p.point_type || p.type;
    const vi = p.route_vertex_index;
    if (t === "camp") {
      const attach = attachAtVertex(vi);
      p.type = "camp"; p.point_type = "camp"; p.nights = p.nights || 1;
      if (attach) p.attach = attach;
      lastCamp = p;
      stopAtVertex.set(vi, f);
    } else if (t === "rest") {
      if (lastCamp) { lastCamp.nights = (lastCamp.nights || 1) + 1; remove.add(f); }
      else { const attach = attachAtVertex(vi); p.type = "break"; p.point_type = "break"; if (attach) p.attach = attach; stopAtVertex.set(vi, f); }
    } else if (t === "dayhike") {
      // The marker is at the spur's far end; the spur starts on the line.
      const spur = spurs.find((sp) => !sp.properties.from_stop && hav(sp.geometry.coordinates.at(-1), f.geometry.coordinates) < 60) ||
        spurs.find((sp) => !sp.properties.from_stop && hav(sp.geometry.coordinates[0], f.geometry.coordinates) < 60);
      const bv = vt.length ? branchVertex(vi) : -1;
      let attach = bv >= 0 ? attachAtVertex(bv) : null;
      if (!attach && spur) {
        // No vertex to go by: project the spur's first point onto the line.
        const near = nearestOnLine(ix, spur.geometry.coordinates[0]);
        if (near.d <= NEAR_M) attach = { route_id: rp._id, ...locateM(ix, near.m) };
      }
      const host = stopAtVertex.get(bv);
      if (spur && host) {
        // It leaves from the camp (or break) already at the branch point.
        const sp = spur.properties;
        if (p.name && (!sp.name || sp.name_auto)) { sp.name = p.name; delete sp.name_auto; }
        if (p.notes && !sp.notes) sp.notes = p.notes;
        sp.from_stop = host.properties._id;
        remove.add(f);
      } else {
        p.type = "break"; p.point_type = "break";
        if (attach) {
          p.attach = attach;
          f.geometry = { type: "Point", coordinates: round6(resolveAttach(ix, attach).coord) };
          stopAtVertex.set(bv, f);
        }
        if (spur) {
          const sp = spur.properties;
          // The marker named the destination: that's the day hike's name.
          if (p.name && (!sp.name || sp.name_auto)) { sp.name = p.name; delete sp.name_auto; p.name = ""; }
          sp.from_stop = p._id;
        }
      }
    }
    delete p.route_vertex_index;
  }
  const gone = new Set([...remove].map((f) => f.properties._id));
  trip.features = trip.features.filter((f) => !remove.has(f));
  trip.unassigned = (trip.unassigned || []).filter((id) => !gone.has(id));
  for (const d of trip.days || []) d.features = (d.features || []).filter((id) => !gone.has(id));
  rp.vertex_types = vt.map(() => "route");
  const newIdx = trip.features.indexOf(route);
  for (const sp of trip.features) if (sp.properties.type === "dayhike_spur") sp.properties.route_index = newIdx;
  trip.properties.schema_version = "1.2";
  return true;
}

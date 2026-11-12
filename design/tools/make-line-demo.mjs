#!/usr/bin/env node
// Build the line + stops (trip format 1.2) copy of the Spanish Bottom demo
// that embed mode (?embed=1) opens, from the 1.1 recorded demo, using the
// app's own routing and elevation code:
//
//   FLATBUSH_DIR=<dir containing node_modules/flatbush> \
//   MAZE_GRAPH=<maze-district.trails-graph.<hash>.json> \
//   MAZE_ELEV=<maze-district.trails-elev.<hash>.json> \
//   node design/tools/make-line-demo.mjs
//
// MAZE_GRAPH is the deployed Maze graph (routing_graph.url in
// https://tiles.booot.org/catalog.json, region maze-district) with its
// elevation sidecar (MAZE_ELEV, routing_graph.elevation.url). The script
// reads only those local files, plus USGS EPQS for off-trail stretches (below).
//
// How the line is built. Each of the six day recordings is resampled every
// 17 m and map-matched to the graph (25 m). Stretches that follow mapped
// trails become real routed legs: the recording is cut into anchors, each
// anchor is snapped (TrailGraph.snap) and each leg is TrailGraph.route()
// between two anchors, exactly what clicking those points with snapping on
// does. Anchors are placed by splitting until the routed path stays within
// 35 m of the recording (so a loop or an out-and-back keeps its turnaround).
// Stretches 150 m or longer with no trail nearby stay as the recorded
// geometry, an `imported` leg. The unrecorded 75 to 660 m between two days
// is a routed leg too where both ends are on a trail, else a manual straight.
// Elevation is profileForRoute() (elevation-dem.js), the code the planner
// runs: 3DEP from the sidecar on routed legs; on the off-trail legs the app
// has no 3DEP sampler (its fill is Open-Meteo), so the script's `fill` asks
// USGS EPQS, the same dataset, for those ~90 points. Camps attach at the end of the leg where their day's
// recording ended; the Maze Overlook loop is its own day on the line, ending
// at camp 2's site (`same_place_as`). Day notes carry over in order.
import { register, createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const flatDir = process.env.FLATBUSH_DIR || process.cwd();
const graphPath = process.env.MAZE_GRAPH;
if (!graphPath) throw new Error("set MAZE_GRAPH, MAZE_ELEV and FLATBUSH_DIR (see the header)");
// routing.js imports Flatbush from a CDN URL; map it to the local npm copy.
const flatbushUrl = pathToFileURL(createRequire(pathToFileURL(`${flatDir}/`).href).resolve("flatbush")).href;
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith("https://cdn.jsdelivr.net/npm/flatbush")) return { url: ${JSON.stringify(flatbushUrl)}, shortCircuit: true };
    return next(spec, ctx);
  }`));

const { lineIndex, syncLineTrip, buildPlan, displayTrip, round6 } = await import("../../line-model.js");
const { TrailGraph, haversine } = await import("../../routing.js");
const { TrailElevation, profileForRoute } = await import("../../elevation-dem.js");
const { resample } = await import("../../gpx-match.js");
const { fetchElevations } = await import("../../elevation.js");
const { buildItinerary } = await import("../../itinerary-profile.js");
const { deriveNameFromRuns } = await import("../../route-names.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const src = JSON.parse(readFileSync(join(root, "spanish-bottom-2026.trip.geojson"), "utf8"));
const OUT = join(root, "spanish-bottom-2026.line.trip.geojson");

const elevPath = process.env.MAZE_ELEV;
if (!elevPath) throw new Error("set MAZE_ELEV (the sidecar file)");
const catalogInfo = { version: graphPath.match(/trails-graph\.([0-9a-f]+)\.json$/)?.[1] || "dev-maze-district", regionId: "maze-district", state: "utah" };
const graph = new TrailGraph(JSON.parse(readFileSync(graphPath, "utf8")), catalogInfo);
const elevation = new TrailElevation(JSON.parse(readFileSync(elevPath, "utf8")), graph);

const byId = new Map(src.features.map((f) => [f.properties._id, f]));
const routes = src.features.filter((f) => f.properties.type === "route");
const spur = src.features.find((f) => f.properties.type === "dayhike_spur");
const camps = src.features.filter((f) => f.properties.type === "camp");
const waypoints = src.features.filter((f) => f.properties.type === "waypoint");
if (routes.length !== 6 || camps.length !== 3) throw new Error("unexpected demo shape");

const STEP_M = 17, MATCH_M = 25, ANCHOR_M = 40, DEV_M = 35, OFF_MIN_M = 150, ROUTE_BUDGET_MS = 2000;

// ---- Legs from one recording ---------------------------------------------
// A leg: { mode: "trail"|"imported"|"manual", coords, wayIds, runs, a, b } with
// a / b the snap results at its ends (null where the end is not on the graph).
const snapAt = (c, r = ANCHOR_M) => graph.snap(c[0], c[1], r);
const lenOf = (cs) => cs.reduce((m, c, i) => (i ? m + haversine(cs[i - 1][0], cs[i - 1][1], c[0], c[1]) : 0), 0);
const toLine = (s) => [s.lon, s.lat];
// Largest distance from a sample to the polyline (local metres, vertex-wise on a 5 m resample).
function maxDev(samples, line) {
  const dense = resample(line, 5).map((p) => p.c);
  let worst = 0, at = 0;
  samples.forEach((p, i) => {
    const kx = Math.cos(p[1] * Math.PI / 180) * 111320, ky = 110574;
    let d = Infinity;
    for (const q of dense) d = Math.min(d, Math.hypot((q[0] - p[0]) * kx, (q[1] - p[1]) * ky));
    if (d > worst) { worst = d; at = i; }
  });
  return { worst, at };
}

function routedLegs(S, near, i, j, out) {
  // Anchor indices must be snappable; walk inwards to the nearest ones.
  let a = i, b = j;
  while (a < b && !snapAt(S[a])) a++;
  while (b > a && !snapAt(S[b])) b--;
  const A = snapAt(S[a]), B = snapAt(S[b]);
  const recLen = lenOf(S.slice(a, b + 1));
  const r = A && B && a < b ? graph.route(A, B, { budgetMs: ROUTE_BUDGET_MS }) : null;
  let ok = false, worstAt = Math.round((a + b) / 2);
  if (r && !r.aborted) {
    const line = [toLine(A), ...r.coords, toLine(B)];
    // Only samples that sit on a trail judge the fit: the others are GPS wander.
    const idx = [];
    for (let k = a; k <= b; k++) if (near[k]) idx.push(k);
    const { worst, at } = maxDev(idx.map((k) => S[k]), line);
    const shortPiece = b - a < 8; // anchors ~100 m apart: trust the router if it stays close
    ok = worst <= DEV_M && r.length_m <= (shortPiece ? 1.6 : 1.3) * recLen + 50 && r.length_m >= 0.6 * recLen - 50;
    if (!ok && worst > DEV_M) worstAt = idx[at];
  }
  if (ok) {
    out.push({ mode: "trail", coords: r.coords, wayIds: r.wayIds, runs: r.runs, a: A, b: B, from: a, to: b });
    return;
  }
  if (b - a >= 8) {
    // Split at the worst-fitting sample (the turnaround of an out-and-back, a shortcut A* took).
    let m = Math.max(a + 3, Math.min(b - 3, worstAt));
    while (m < b && !snapAt(S[m])) m++;
    if (m > a && m < b) { routedLegs(S, near, a, m, out); routedLegs(S, near, m, b, out); return; }
  }
  if (process.env.DEBUG_FIT) console.error("unfit", a, b, ((b - a) * STEP_M) | 0, "m", r ? (r.aborted ? "aborted" : `route ${r.length_m | 0} vs rec ${recLen | 0}, dev ${maxDev(S.slice(a, b + 1), [toLine(A), ...r.coords, toLine(B)]).worst | 0}`) : A && B ? "no route" : "no snap");
  out.push({ mode: "imported", coords: S.slice(a, b + 1), wayIds: [], runs: [], a: A, b: B, from: a, to: b, unfit: true });
}

function legsForRecording(rec) {
  const S = resample(rec.geometry.coordinates.map(round6), STEP_M).map((p) => p.c);
  const near = S.map((c) => graph.snap(c[0], c[1], MATCH_M));
  // Runs of off-trail samples long enough to count; shorter gaps are GPS wander off a trail.
  const off = [];
  let cur = null;
  near.forEach((s, k) => {
    if (!s) { if (!cur) cur = [k, k]; else cur[1] = k; } else if (cur) { off.push(cur); cur = null; }
  });
  if (cur) off.push(cur);
  const longOff = off.filter(([a, b]) => (b - a + 2) * STEP_M >= OFF_MIN_M);
  const legs = [];
  let from = 0;
  const pieces = [];
  for (const [a, b] of longOff) {
    // The off-trail leg runs from the last on-trail sample before to the first after.
    const lo = Math.max(0, a - 1), hi = Math.min(S.length - 1, b + 1);
    if (lo > from) pieces.push(["on", from, lo]);
    pieces.push(["off", lo, hi]);
    from = hi;
  }
  if (from < S.length - 1) pieces.push(["on", from, S.length - 1]);
  for (const [kind, i, j] of pieces) {
    if (kind === "on") routedLegs(S, near, i, j, legs);
    else {
      const A = snapAt(S[i], MATCH_M), B = snapAt(S[j], MATCH_M);
      legs.push({ mode: "imported", coords: S.slice(i, j + 1), wayIds: [], runs: [], a: A, b: B, from: i, to: j });
    }
  }
  // Off-trail legs start and end on the line: the previous leg's end, the next anchor.
  const endOf = (l) => l.coords.at(-1);
  legs.forEach((l, k) => {
    l.snappedA = !!l.a; l.snappedB = !!l.b;
    if (l.mode === "trail") return;
    l.coords = [...l.coords];
    l.coords[0] = k ? endOf(legs[k - 1]) : l.a ? toLine(l.a) : l.coords[0];
    if (l.b) l.coords[l.coords.length - 1] = toLine(l.b);
  });
  return legs;
}

// ---- One line from the six recordings ------------------------------------
const ROUTE_ID = "b0070000-0000-4000-8000-00000000e1e1";
const coords = [];
const segments = [];
const vertexCoords = [];
const vertexSnapped = [];
const recLegs = []; // per recording: [first leg index, last leg index]
const addLeg = (l) => {
  const pts = l.coords.map(round6);
  let start = coords.length - 1;
  if (start < 0) { coords.push(pts[0]); start = 0; vertexCoords.push(pts[0]); vertexSnapped.push(!!l.snappedA); }
  else if (coords[start][0] !== pts[0][0] || coords[start][1] !== pts[0][1]) {
    // Legs share anchors, so this is rounding at most; anything more is a bug.
    if (haversine(...coords[start], ...pts[0]) > 2) throw new Error(`leg ${segments.length} starts ${haversine(...coords[start], ...pts[0]).toFixed(1)} m from the line's end`);
    pts[0] = coords[start];
  }
  for (let k = 1; k < pts.length; k++) coords.push(pts[k]);
  const k = segments.length;
  segments.push({
    mode: l.mode, from_vertex: k, to_vertex: k + 1, coord_range: [start, coords.length - 1],
    length_m: Math.round(lenOf(pts) * 10) / 10,
    ...(l.mode === "trail" ? { osm_way_ids: l.wayIds } : {}),
  });
  vertexCoords.push(pts.at(-1));
  vertexSnapped.push(!!l.snappedB);
  l.index = k;
};
const allRuns = [];
const stats = [];
let prevEnd = null; // { c, snap } where the line stands
for (const [k, rec] of routes.entries()) {
  const legs = legsForRecording(rec);
  if (prevEnd) {
    // The unrecorded stretch from the last day's end to this recording's start.
    const first = legs[0];
    const gapA = prevEnd.snap, gapB = first.snappedA ? first.a : null;
    const target = first.coords[0];
    let join = null;
    if (gapA && gapB) {
      const r = graph.route(gapA, gapB, { budgetMs: ROUTE_BUDGET_MS });
      const straight = haversine(...prevEnd.c, ...target);
      if (r && !r.aborted && r.length_m <= 1.5 * straight + 100) join = { mode: "trail", coords: r.coords, wayIds: r.wayIds, runs: r.runs, snappedA: true, snappedB: true };
    }
    if (!join) join = { mode: "manual", coords: [prevEnd.c, target], wayIds: [], runs: [], snappedA: !!gapA, snappedB: first.snappedA };
    if (join.mode === "trail") join.coords = [prevEnd.c, ...join.coords.slice(1, -1), target];
    join.coords = join.coords.map(round6);
    addLeg(join);
    stats.push({ rec: k, join: join.mode, joinM: Math.round(lenOf(join.coords)) });
  }
  const firstIx = segments.length;
  for (const l of legs) { addLeg(l); if (l.runs?.length) allRuns.push(...l.runs); }
  recLegs.push([firstIx, segments.length - 1]);
  const last = legs.at(-1);
  prevEnd = { c: round6(coords.at(-1)), snap: last.snappedB ? last.b : null };
  const m = (mode) => legs.filter((l) => l.mode === mode).reduce((a, l) => a + lenOf(l.coords), 0) / 1609.344;
  stats.push({ rec: k, name: rec.properties.name, legs: legs.length, routed_mi: +m("trail").toFixed(2), recorded_leg_mi: +m("imported").toFixed(2), unfit: legs.filter((l) => l.unfit).length });
}

const route = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: coords },
  properties: {
    type: "route",
    _id: ROUTE_ID,
    name: "Spanish Bottom loop",
    planned: false,
    notes: "",
    vertex_types: vertexCoords.map(() => "route"),
    vertex_snapped: vertexSnapped,
    vertex_coords: vertexCoords,
    segments,
    routing: { engine: "booot-graph", graph: `${graph.state}/${graph.region}`, graph_version: graph.version, ...(graph.osmTimestamp ? { osm_timestamp: graph.osmTimestamp } : {}) },
    source: { ...routes[0].properties.source, recorded_at: "2026-05-03" },
  },
};
const ix = lineIndex(route);
route.properties.main_route_distance_mi = Math.round((ix.total / 1609.344) * 100) / 100;

// ---- Elevation: the planner's own path (elevation-dem.js) -----------------
// The planner's `fill` for stretches the sidecar can't answer is Open-Meteo
// (~90 m DEM). Mixed into 10 m 3DEP it adds a step at every seam, which the
// hysteresis counts as climbing (+1,400 ft on this line), so the demo's fill
// asks USGS's own point service for the same dataset instead.
let fillPoints = 0;
async function epqs([lon, lat]) {
  const url = `https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Meters&includeDate=false`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(40000) });
      const v = Number((await res.json()).value);
      if (res.ok && Number.isFinite(v) && v > -1000) return v;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`EPQS gave no elevation at ${lon},${lat}`);
}
const fill = async (pts) => {
  fillPoints += pts.length;
  const out = new Array(pts.length);
  let next = 0;
  // The service answers in seconds per point: eight at a time.
  await Promise.all(Array.from({ length: 8 }, async () => { while (next < pts.length) { const i = next++; out[i] = await epqs(pts[i]); } }));
  return out;
};
const dem = await profileForRoute(route, graph, { elevation, fill });
if (!dem) throw new Error("no 3DEP profile for the line");
route.properties.elevation_profile = dem.profile_ft;
route.properties.elevation_gain_ft = dem.gain_ft;
route.properties.elevation_loss_ft = dem.loss_ft;
route.properties.elevation_source = "usgs-3dep"; // every sample is 3DEP: the sidecar on trail legs, USGS EPQS on the rest

// ---- Stops ---------------------------------------------------------------
// Floor, not round: an offset past the leg end by even 0.05 m makes redrawLine re-attach the camp to another pass.
const atLegEnd = (k) => ({ route_id: ROUTE_ID, leg: k, offset_m: Math.floor(ix.legs[k].len * 10) / 10 });
const camp = (f, rec, extra = {}) => {
  const leg = recLegs[rec][1];
  const p = { ...f.properties };
  for (const key of ["route_index", "route_vertex_index", "date"]) delete p[key];
  return { type: "Feature", geometry: { type: "Point", coordinates: coords[ix.legs[leg].b] }, properties: { ...p, nights: 1, attach: atLegEnd(leg), ...extra } };
};
const [c1, c2, c3] = camps;
const camp2Again = {
  type: "Feature",
  geometry: { type: "Point", coordinates: coords[ix.legs[recLegs[3][1]].b] },
  properties: {
    type: "camp", point_type: "camp", _id: "b0070000-0000-4000-8000-00000000c2c2",
    name: "same site as camp 2", notes: "Back at camp 2 for a second night (May 5).",
    nights: 1, water_nearby: false, water_notes: "", same_place_as: c2.properties._id, attach: atLegEnd(recLegs[3][1]),
  },
};
// The planner prefixes camps with their number ("Camp 1, Shot Canyon Route"),
// so the names drop the recorded "Camp N" part.
const stops = [
  camp(c1, 1, { name: "Shot Canyon Route" }),
  camp(c2, 2, { name: "Pete's Mesa Route", notes: "At-large. Two nights here (May 4 and 5)." }),
  camp2Again,
  camp(c3, 4, { name: "" }),
];
const places = waypoints.map((w) => {
  const p = { ...w.properties };
  if (p.subtype === "water") Object.assign(p, { water_source: "spring", reliability: "unreliable" });
  return { ...w, properties: p };
});
const spurOut = { ...spur, properties: { ...spur.properties, from_stop: c2.properties._id, route_index: 0 } };

const trip = {
  type: "FeatureCollection",
  properties: {
    ...src.properties,
    schema_version: "1.2",
    dates: { start: "2026-05-03", end: "2026-05-07" },
  },
  days: [],
  unassigned: [],
  features: [route, spurOut, ...stops, ...places],
};
syncLineTrip(trip);
const plan = buildPlan(trip);
if (trip.days.length !== src.days.length) throw new Error(`expected ${src.days.length} days, got ${trip.days.length}`);
trip.days.forEach((d, i) => { d.notes = src.days[i].notes || ""; });

writeFileSync(OUT, JSON.stringify(trip) + "\n");
console.log(`wrote ${OUT}`);
console.log(`${(ix.total / 1609.344).toFixed(2)} mi, ${ix.legs.length} legs, ${dem.profile_ft.length} elevation samples, +${dem.gain_ft} / -${dem.loss_ft} ft (${Math.round(dem.coverage * 100)}% from the sidecar, ${fillPoints} EPQS points)`);
for (const st of stats) console.log("  ", JSON.stringify(st));
for (const d of plan.days) console.log(`  day ${d.n} ${d.date} ${d.kind} ${((d.toM - d.fromM) / 1609.344).toFixed(2)} mi  ${d.from?.label || ""} -> ${d.to?.label || ""}  stops ${d.stops.map((s) => s.f.properties.name).join(" | ")}  spurs ${d.spurs.length}`);
// What the app shows per day (the line cut per day, gain and loss from its slice of the profile).
const it = buildItinerary(displayTrip(trip, plan));
const sum = (d, k) => d.pieces.reduce((a, p) => a + p[k], 0);
for (const d of it.days) console.log(`  shown day ${d.n} ${d.date}: ${d.routeMiles.toFixed(2)} mi  +${sum(d, "gain")} / -${sum(d, "loss")} ft`);
console.log(`  shown total: ${it.routeMiles.toFixed(2)} mi  +${it.gain} / -${it.loss} ft`);

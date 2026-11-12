#!/usr/bin/env node
// Build the line + stops (trip format 1.2) copy of the Spanish Bottom demo
// that embed mode (?embed=1) opens, from the 1.1 recorded demo:
//
//   node design/tools/make-line-demo.mjs
//
// The six day recordings become one line: one leg per recording, each leg
// starting where the previous one ended (the short unrecorded stretches, 75 to
// 660 m, become the straight start of the next leg). Camps attach at the end
// of the leg where their day's recording ended; the Maze Overlook loop is its
// own day on the line, ending back at camp 2. Elevation is the recordings'
// profiles stitched end to end. Day notes carry over in order.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lineIndex, syncLineTrip, buildPlan, round6 } from "../../line-model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const src = JSON.parse(readFileSync(join(root, "spanish-bottom-2026.trip.geojson"), "utf8"));
const OUT = join(root, "spanish-bottom-2026.line.trip.geojson");

const byId = new Map(src.features.map((f) => [f.properties._id, f]));
const routes = src.features.filter((f) => f.properties.type === "route");
const spur = src.features.find((f) => f.properties.type === "dayhike_spur");
const camps = src.features.filter((f) => f.properties.type === "camp");
const waypoints = src.features.filter((f) => f.properties.type === "waypoint");
if (routes.length !== 6 || camps.length !== 3) throw new Error("unexpected demo shape");

// ---- One line, one imported leg per recording ----------------------------
const ROUTE_ID = "b0070000-0000-4000-8000-00000000e1e1";
const coords = [];
const segments = [];
const vertexCoords = [];
for (const [k, r] of routes.entries()) {
  const c = r.geometry.coordinates.map(round6);
  // Each leg starts at the previous leg's last point; for k > 0 the gap to
  // this recording's first point is the leg's straight opening stretch.
  const start = coords.length ? coords.length - 1 : 0;
  if (!coords.length) vertexCoords.push(c[0]);
  for (const p of c) coords.push(p);
  const seg0 = r.properties.segments[0];
  segments.push({
    mode: "imported",
    from_vertex: k,
    to_vertex: k + 1,
    coord_range: [start, coords.length - 1],
    ...(seg0.osm_way_ids ? { osm_way_ids: seg0.osm_way_ids } : {}),
  });
  vertexCoords.push(c.at(-1));
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
    segments,
    vertex_coords: vertexCoords,
    vertex_types: vertexCoords.map(() => "route"),
    source: { ...routes[0].properties.source, recorded_at: "2026-05-03" },
  },
};
const ix = lineIndex(route);
for (const L of ix.legs) segments[L.k].length_m = Math.round(L.len * 10) / 10;
route.properties.main_route_distance_mi = Math.round((ix.total / 1609.344) * 100) / 100;

// ---- Elevation: each recording's profile over its own leg ----------------
const N = Math.min(800, Math.max(100, Math.round(ix.total / 100) + 1));
const profile = [];
for (let i = 0; i < N; i++) {
  const m = (ix.total * i) / (N - 1);
  const L = ix.legs.find((l) => m <= l.endM + 1e-6) || ix.legs.at(-1);
  // The leg's recording starts after the short straight joining stretch.
  const rec = routes[L.k];
  const recStartM = L.k === 0 ? L.startM : ix.cum[L.a + 1];
  const prof = rec.properties.elevation_profile;
  let ft;
  if (m < recStartM) {
    const prev = routes[L.k - 1].properties.elevation_profile.at(-1);
    const t = (m - L.startM) / Math.max(1e-6, recStartM - L.startM);
    ft = prev + t * (prof[0] - prev);
  } else {
    const t = Math.min(1, (m - recStartM) / Math.max(1e-6, L.endM - recStartM)) * (prof.length - 1);
    const j = Math.floor(t), f = t - j;
    ft = prof[j] + f * ((prof[Math.min(prof.length - 1, j + 1)]) - prof[j]);
  }
  profile.push(Math.round(ft));
}
route.properties.elevation_profile = profile;
route.properties.elevation_gain_ft = routes.reduce((a, r) => a + (r.properties.elevation_gain_ft || 0), 0);
route.properties.elevation_loss_ft = routes.reduce((a, r) => a + (r.properties.elevation_loss_ft || 0), 0);
route.properties.elevation_source = "gpx";

// ---- Stops ---------------------------------------------------------------
const atLegEnd = (k) => ({ route_id: ROUTE_ID, leg: k, offset_m: Math.round(ix.legs[k].len * 10) / 10 });
const camp = (f, leg, extra = {}) => {
  const p = { ...f.properties };
  for (const key of ["route_index", "route_vertex_index", "date"]) delete p[key];
  return { type: "Feature", geometry: { type: "Point", coordinates: coords[ix.legs[leg].b] }, properties: { ...p, nights: 1, attach: atLegEnd(leg), ...extra } };
};
const [c1, c2, c3] = camps;
const camp2Again = {
  type: "Feature",
  geometry: { type: "Point", coordinates: coords[ix.legs[3].b] },
  properties: {
    type: "camp", point_type: "camp", _id: "b0070000-0000-4000-8000-00000000c2c2",
    name: "Back at camp 2", notes: "Same camp, second night (May 5).",
    nights: 1, water_nearby: false, water_notes: "", attach: atLegEnd(3),
  },
};
const stops = [
  camp(c1, 1),
  camp(c2, 2, { notes: "At-large. Two nights here (May 4 and 5)." }),
  camp2Again,
  camp(c3, 4),
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
console.log(`${(ix.total / 1609.344).toFixed(2)} mi, ${ix.legs.length} legs, ${profile.length} elevation samples`);
for (const d of plan.days) console.log(`  day ${d.n} ${d.date} ${d.kind} ${((d.toM - d.fromM) / 1609.344).toFixed(2)} mi  ${d.from?.label || ""} -> ${d.to?.label || ""}  stops ${d.stops.map((s) => s.f.properties.name).join(" | ")}  spurs ${d.spurs.length}`);

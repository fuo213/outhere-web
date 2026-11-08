#!/usr/bin/env node
// Unit tests for GPX trail matching + route names. No build step.
//
//   FLATBUSH_DIR=<dir containing node_modules/flatbush> node design/tools/test-gpx-match.mjs
//   (optional) ZION_GRAPH=<path to zion.trails-graph.*.json> adds a real-graph test
//
// routing.js imports Flatbush from a CDN URL; a loader hook maps it to the
// local npm copy so the same TrailGraph code runs here.
import { register, createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const dir = process.env.FLATBUSH_DIR || process.cwd();
const req = createRequire(pathToFileURL(`${dir}/`).href);
const flatbushUrl = pathToFileURL(req.resolve("flatbush")).href;
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith("https://cdn.jsdelivr.net/npm/flatbush")) return { url: ${JSON.stringify(flatbushUrl)}, shortCircuit: true };
    return next(spec, ctx);
  }`));

const { TrailGraph } = await import("../../routing.js");
const { matchTrack, resample } = await import("../../gpx-match.js");
const { deriveNameFromRuns, deriveImportedName, isGenericRouteName } = await import("../../route-names.js");

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok  ", name); };

// --- names -----------------------------------------------------------------
test("generic names", () => {
  for (const g of ["May 3 · 1.3 mi", "1.3 mi", "Wayne County Hiking", "Garmin Connect Activity", "2026-05-03", ""]) assert.ok(isGenericRouteName(g), g);
  for (const g of ["Maze Overlook scramble", "Angels Landing"]) assert.ok(!isGenericRouteName(g), g);
});
test("names from runs match the planner rules", () => {
  const runs = [{ name: "West Rim Trail", highway: "path", m: 3000 }, { name: "Angels Landing Trail", highway: "path", m: 700 }];
  assert.equal(deriveNameFromRuns(runs), "West Rim Trail to Angels Landing");
  assert.equal(deriveImportedName(runs), "West Rim Trail to Angels Landing");
});
test("loop names", () => {
  const runs = [{ name: "Canyon Trail", highway: "path", m: 3000 }, { name: "Maze Overlook Trail", highway: "path", m: 500 }, { name: "Canyon Trail", highway: "path", m: 2000 }];
  assert.equal(deriveImportedName(runs, { loop: true, farthest: { name: "Maze Overlook Trail", highway: "path" } }), "Out to Maze Overlook");
  assert.equal(deriveImportedName(runs, { loop: true, farthest: { name: "Canyon Trail", highway: "path" } }), "Canyon Trail loop");
  assert.equal(deriveImportedName([{ name: "", highway: "path", m: 900 }], { loop: true }), "");
});

// --- synthetic graph ---------------------------------------------------------
// Local metric frame near Zion: x east, y north. Alpha Trail runs east along y=0
// for 2 km; Beta Route leaves at x=2000 going north 1 km; Gamma Trail runs
// parallel to Alpha, 12 m north of it, from x=500 to x=900 (unnamed-path decoy).
const LAT0 = 37.25, LON0 = -112.95, KX = Math.cos(LAT0 * Math.PI / 180) * 111320, KY = 110574;
const ll = ([x, y]) => [LON0 + x / KX, LAT0 + y / KY];
const S = 1e6;
function buildGraph(lines) { // lines: [{name, highway, osm, pts: [[x,y], ...]}]
  const nodes = [], edges = [], ways = [];
  const nodeId = new Map();
  const node = (p) => { const k = p.join(","); if (!nodeId.has(k)) { nodeId.set(k, nodes.length); nodes.push(ll(p).map((v) => Math.round(v * S))); } return nodeId.get(k); };
  lines.forEach((ln, w) => {
    ways.push([ln.osm, ln.name, ln.highway]);
    const a = node(ln.pts[0]), b = node(ln.pts.at(-1));
    let [px, py] = nodes[a];
    const d = [];
    for (const p of ln.pts.slice(1, -1)) { const [x, y] = ll(p).map((v) => Math.round(v * S)); d.push(x - px, y - py); px = x; py = y; }
    edges.push([a, b, w, 0, d]);
  });
  const flat = []; let px = 0, py = 0;
  for (const [x, y] of nodes) { flat.push(x - px, y - py); px = x; py = y; }
  return new TrailGraph({ format: "booot-trail-graph", v: 1, scale: S, ways_fields: ["osm_id", "name", "highway"], ways, nodes: flat, edges, gaps: [] }, { regionId: "test" });
}
const line = (a, b, step = 25) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / step); return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]); };
const g = buildGraph([
  { name: "Alpha Trail", highway: "path", osm: 101, pts: [[0, 0], [1000, 0], [2000, 0]] },
  { name: "Beta Route", highway: "path", osm: 102, pts: [[2000, 0], [2000, 1000]] },
  { name: "Gamma Trail", highway: "path", osm: 103, pts: [[500, 12], [900, 12]] },
  { name: "Cedar Road", highway: "unclassified", osm: 104, pts: [[0, -300], [0, 0]] },
]);
const jitter = (pts, amp, seed = 7) => { let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5; return pts.map(([x, y]) => [x + r() * 2 * amp, y + r() * 2 * amp]); };
const track = (pts) => pts.map((p) => ll(p));

test("resample spacing and weights", () => {
  const s = resample(track(line([0, 0], [1000, 0])), 17);
  assert.ok(Math.abs(s.reduce((a, b) => a + b.m, 0) - 1000) < 2);
  assert.ok(s.length > 55 && s.length < 62);
});
test("Alpha then Beta: 'Alpha Trail to Beta Route', ways in order", () => {
  const pts = jitter([...line([0, 0], [2000, 0]), ...line([2000, 0], [2000, 700]).slice(1)], 4);
  const m = matchTrack(g, track(pts));
  assert.deepEqual(m.runs.map((r) => r.name), ["Alpha Trail", "Beta Route"]);
  assert.ok(Math.abs(m.runs[0].m - 2000) < 60 && Math.abs(m.runs[1].m - 700) < 60);
  assert.deepEqual(m.wayIds, [101, 102]);
  assert.ok(!m.loop);
  assert.equal(deriveImportedName(m.runs, m), "Alpha Trail to Beta Route");
});
test("parallel decoy 12 m away does not flicker", () => {
  const m = matchTrack(g, track(jitter(line([100, 3], [1500, 3]), 3)));
  assert.deepEqual(m.runs.map((r) => r.name), ["Alpha Trail"]);
});
test("walking in reverse reverses the order", () => {
  const pts = jitter([...line([2000, 700], [2000, 0]), ...line([2000, 0], [0, 0]).slice(1)], 4);
  const m = matchTrack(g, track(pts));
  assert.deepEqual(m.runs.map((r) => r.name), ["Beta Route", "Alpha Trail"]);
  assert.deepEqual(m.wayIds, [102, 101]);
});
test("off-network stretch is unmatched, not misnamed", () => {
  const m = matchTrack(g, track([...line([0, 0], [200, 0]), ...line([200, 0], [200, 400]).slice(1)]));
  assert.deepEqual(m.runs.map((r) => r.name), ["Alpha Trail", ""]);
  assert.ok(m.matchedM < m.totalM);
});
test("out-and-back is a loop; farthest point names it", () => {
  const out = line([0, 0], [2000, 0]), up = line([2000, 0], [2000, 800]).slice(1);
  const pts = [...out, ...up, ...up.slice().reverse().slice(1), ...out.slice().reverse().slice(1)];
  const m = matchTrack(g, track(jitter(pts, 3)));
  assert.ok(m.loop);
  assert.equal(m.farthest.name, "Beta Route");
  assert.equal(deriveImportedName(m.runs, m), "Alpha Trail loop");
});
test("one-way climb with switchbacks is not a loop", () => {
  // 3 km of walking that ends 400 m from where it began, farthest point at the end
  const pts = [];
  for (let k = 0; k < 10; k++) pts.push(...line([k % 2 ? 0 : 300, k * 40], [k % 2 ? 300 : 0, k * 40 + 40]));
  const m = matchTrack(g, track(pts));
  assert.ok(m.totalM > 2500 && m.endM < 0.2 * m.totalM);
  assert.ok(!m.loop);
});
test("lollipop recorded from 600 m off camp is a loop", () => {
  const out = line([0, 600], [0, 0]), way = [...line([0, 0], [1500, 0]).slice(1), ...line([1500, 0], [1500, 600]).slice(1), ...line([1500, 600], [1500, 0]).slice(1), ...line([1500, 0], [0, 0]).slice(1)];
  const m = matchTrack(g, track([...out, ...way]));
  assert.ok(m.endM > 500 && m.loop);
  const m2 = matchTrack(g, track([...line([600, 0], [2000, 0]), ...line([2000, 0], [2000, 700]).slice(1), ...line([2000, 700], [2000, 0]).slice(1), ...line([2000, 0], [700, 0]).slice(1)]));
  assert.ok(m2.endM > 90 && m2.loop);
});
test("outside the graph", () => {
  const far = [[-110.0, 38.0], [-110.0, 38.01], [-110.0, 38.02]];
  const m = matchTrack(g, far);
  assert.deepEqual(m.wayIds, []);
  assert.equal(deriveImportedName(m.runs, m), "");
});

// --- real graph (optional) -------------------------------------------------------
if (process.env.ZION_GRAPH && existsSync(process.env.ZION_GRAPH)) {
  const zg = new TrailGraph(JSON.parse(readFileSync(process.env.ZION_GRAPH, "utf8")), { regionId: "zion" });
  test("Zion: Angels Landing route recorded with GPS noise", () => {
    const a = zg.snap(-112.9506, 37.2594, 200); // Grotto trailhead
    const b = zg.snap(-112.9473, 37.2698, 300); // near Angels Landing summit
    assert.ok(a && b);
    const r = zg.route(a, b);
    const noisy = jitter(r.coords.map(([x, y]) => [(x - LON0) * KX, (y - LAT0) * KY]), 4);
    const m = matchTrack(zg, noisy.map(([x, y]) => ll([x, y])));
    const name = deriveImportedName(m.runs, m);
    console.log("      Zion matched:", name, m.runs.map((r) => `${r.name || "-"} ${Math.round(r.m)}m`).join("; "));
    assert.ok(/Angels Landing|West Rim/.test(name), name);
    assert.ok(m.matchedM / m.totalM > 0.9);
    assert.ok(!m.loop, "a one-way switchback climb is not a loop");
  });
}
console.log(`${n} tests passed`);

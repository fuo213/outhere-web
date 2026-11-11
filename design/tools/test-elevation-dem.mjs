#!/usr/bin/env node
// Unit tests for elevation-dem.js (3DEP profiles from the graph's sidecar).
//
//   FLATBUSH_DIR=<dir containing node_modules/flatbush> node design/tools/test-elevation-dem.mjs
//   (optional) MAZE_GRAPH=<maze-district.trails-graph.json> with its
//   .trails-elev.json next to it adds a real-data test
//
// Same loader hook as test-gpx-match.mjs: routing.js imports Flatbush from a CDN.
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
const { TrailElevation, elevationInfoFor, loadElevation, profileForRoute, sampleRoute, smooth } = await import("../../elevation-dem.js");
const { hysteresisGainLoss } = await import("../../gpx-core.js");

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("ok  ", name); };
const near = (a, b, tol, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} not within ${tol} of ${b}`);
const FT = 3.28084;

// A tiny world near Zion: node 0 —(edge 0, 1 km east)— node 1 —(edge 1, 500 m north)— node 2.
const LAT = 37.25, LON = -113, KX = 111320 * Math.cos((LAT * Math.PI) / 180), KY = 110574;
const q = (xM, yM) => [Math.round((LON + xM / KX) * 1e6), Math.round((LAT + yM / KY) * 1e6)];
const ll = (xM, yM) => q(xM, yM).map((v) => v / 1e6);
const [n0, n1, n2] = [q(0, 0), q(1000, 0), q(1000, 500)];
const mid = q(500, 0);
const graphDoc = {
  format: "booot-trail-graph", v: 1, region: "test", state: "utah", scale: 1e6,
  ways_fields: ["osm_id", "name", "highway"], ways: [[1, "East Trail", "path"], [2, "North Trail", "path"]],
  nodes: [n0[0], n0[1], n1[0] - n0[0], n1[1] - n0[1], n2[0] - n1[0], n2[1] - n1[1]],
  edges: [[0, 1, 0, 1000, [mid[0] - n0[0], mid[1] - n0[1]]], [1, 2, 1, 500, []]],
  gaps: [],
};
const graph = new TrailGraph(graphDoc, { url: "https://x/utah/graphs/test.trails-graph.abc.json", version: "abc12345" });

// Edge 0 climbs 1500 → 1600 m in 101 samples (1 m per 10 m); edge 1 is flat at 1600 m.
const enc = (zs) => { const d = zs.map((z) => Math.round(z * 10)); return [d[0], ...d.slice(1).map((v, i) => v - d[i])]; };
const elevDoc = (edges, extra = {}) => ({ format: "booot-trail-elev", v: 1, graph_version: "abc12345", spacing_m: 10, units_per_m: 10, smooth_m: 100, hysteresis_m: 3, source: "USGS 3DEP 1/3 arc-second", edges, ...extra });
const climb = Array.from({ length: 101 }, (_, i) => 1500 + i);
const flat = Array.from({ length: 51 }, () => 1600);
const elev = new TrailElevation(elevDoc([enc(climb), enc(flat)]), graph);

const line = (pts) => pts.map(([x, y]) => ll(x, y));
const route = (coords, segments) => ({ geometry: { type: "LineString", coordinates: coords }, properties: { segments } });

await test("decode: linear read along an edge, either end", () => {
  near(elev.at(0, 0), 1500, 0.01);
  near(elev.at(0, graph.eLen[0]), 1600, 0.01);
  near(elev.at(0, graph.eLen[0] / 2), 1550, 0.2);
  near(elev.at(1, 123), 1600, 0.01);
});

await test("an edge without DEM answers null", () => {
  const e = new TrailElevation(elevDoc([enc(climb), []]), graph);
  assert.equal(e.at(1, 100), null);
  near(e.at(0, 0), 1500, 0.01);
});

await test("rejects the wrong format, edge count or graph version", () => {
  assert.throws(() => new TrailElevation({ format: "nope", v: 1, edges: [] }, graph));
  assert.throws(() => new TrailElevation(elevDoc([enc(climb)]), graph), /edges/);
  assert.throws(() => new TrailElevation(elevDoc([enc(climb), enc(flat)], { graph_version: "ffffffff" }), graph), /graph/);
  // A dev-override graph has no content hash to compare.
  const dev = new TrailGraph(graphDoc, { version: "dev-test" });
  assert.ok(new TrailElevation(elevDoc([enc(climb), enc(flat)], { graph_version: "ffffffff" }), dev));
});

await test("where the sidecar lives: catalog block, dev override, nothing", () => {
  assert.equal(elevationInfoFor({ url: "g", version: "abc", elevation: { url: "https://t/e.json", version: "e1" } }).url, "https://t/e.json");
  assert.equal(elevationInfoFor({ url: "http://localhost:8000/dev-graphs/zion.trails-graph.json", version: "dev-zion" }).url, "http://localhost:8000/dev-graphs/zion.trails-elev.json");
  assert.equal(elevationInfoFor({ url: "https://tiles.booot.org/utah/graphs/zion.trails-graph.abc.json", version: "abc" }), null);
  assert.equal(elevationInfoFor({ url: "g", version: "abc", elevation: null }), null);
  assert.equal(elevationInfoFor(null), null);
});

await test("a fully routed route: profile, gain and loss from the sidecar, no fill", async () => {
  const coords = line([[0, 0], [500, 0], [1000, 0], [1000, 500]]);
  let asked = 0;
  const r = await profileForRoute(route(coords, [{ mode: "trail", coord_range: [0, 3] }]), graph, { elevation: elev, fill: async () => { asked++; return []; } });
  assert.equal(asked, 0);
  assert.equal(r.source, "usgs-3dep");
  assert.equal(r.coverage, 1);
  near(r.gain_ft, 100 * FT, 3, "gain");
  assert.equal(r.loss_ft, 0);
  assert.equal(r.profile_ft.length, 61); // 1,500 m at one sample per 25 m
  near(r.spacing_m, 25, 0.1);
  near(r.profile_ft[0], 1500 * FT, 1);
  near(r.profile_ft.at(-1), 1600 * FT, 1);
  near(r.profile_ft[20], 1550 * FT, 3, "half way up the climb");
  const custom = await profileForRoute(route(coords, [{ mode: "trail", coord_range: [0, 3] }]), graph, { elevation: elev, samples: 16 });
  assert.equal(custom.profile_ft.length, 16);
  near(custom.spacing_m, 100, 0.2);
});

await test("walked backwards it is all loss", async () => {
  const coords = line([[1000, 0], [0, 0]]);
  const r = await profileForRoute(route(coords, [{ mode: "trail", coord_range: [0, 1] }]), graph, { elevation: elev });
  near(r.loss_ft, 100 * FT, 3);
  assert.equal(r.gain_ft, 0);
});

await test("mixed route: only the off-trail stretch is sent to fill", async () => {
  // Trail leg along edge 0, then a manual leg 300 m off across country.
  const coords = line([[0, 0], [1000, 0], [1300, -300]]);
  const segs = [{ mode: "trail", coord_range: [0, 1] }, { mode: "manual", coord_range: [1, 2] }];
  let asked = null;
  const fill = async (pts) => { asked = pts; return pts.map(() => 1600); };
  const r = await profileForRoute(route(coords, segs), graph, { elevation: elev, fill });
  assert.equal(r.source, "mixed");
  assert.ok(asked.length >= 2 && asked.length <= 100, `asked for ${asked.length}`);
  for (const p of asked) assert.ok(p[0] >= ll(1000, 0)[0] - 1e-9, "fill points are on the manual leg");
  near(r.coverage, 1000 / (1000 + Math.hypot(300, 300)), 0.02);
  near(r.gain_ft, 100 * FT, 5);
  // Without a fill, or when it fails, the caller keeps its own source.
  assert.equal(await profileForRoute(route(coords, segs), graph, { elevation: elev }), null);
  assert.equal(await profileForRoute(route(coords, segs), graph, { elevation: elev, fill: async () => { throw new Error("429"); } }), null);
  assert.equal(await profileForRoute(route(coords, segs), graph, { elevation: elev, fill: async () => [1] }), null);
});

await test("nothing to offer → null (no trail legs, off the graph, no sidecar)", async () => {
  const coords = line([[0, 0], [1000, 0]]);
  assert.equal(await profileForRoute(route(coords, [{ mode: "manual", coord_range: [0, 1] }]), graph, { elevation: elev }), null);
  assert.equal(await profileForRoute(route(coords, [{ mode: "imported", coord_range: [0, 1] }]), graph, { elevation: elev }), null);
  assert.equal(await profileForRoute(route(coords, undefined), graph, { elevation: elev }), null);
  const far = line([[0, 400], [1000, 400]]); // "trail" leg nowhere near an edge
  assert.equal(await profileForRoute(route(far, [{ mode: "trail", coord_range: [0, 1] }]), graph, { elevation: elev, fill: async (p) => p.map(() => 0) }), null);
  // Production graph info without an elevation block: no request at all.
  let fetched = 0;
  assert.equal(await profileForRoute(route(coords, [{ mode: "trail", coord_range: [0, 1] }]), graph, { fetchFn: async () => { fetched++; return { ok: false, status: 404 }; } }), null);
  assert.equal(fetched, 0);
});

await test("loadElevation: fetches once, a 404 or a stale file resolves null", async () => {
  const mk = (url) => new TrailGraph(graphDoc, { url: "g", version: "abc12345", elevation: { url } });
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => elevDoc([enc(climb), enc(flat)]) }; };
  const g1 = mk("https://t/one.json");
  assert.ok(await loadElevation(g1, { fetchFn: ok }));
  assert.ok(await loadElevation(g1, { fetchFn: ok }));
  assert.equal(calls, 1);
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await loadElevation(mk("https://t/missing.json"), { fetchFn: async () => ({ ok: false, status: 404 }) }), null);
    assert.equal(await loadElevation(mk("https://t/stale.json"), { fetchFn: async () => ({ ok: true, json: async () => elevDoc([enc(climb), enc(flat)], { graph_version: "00000000" }) }) }), null);
  } finally { console.warn = warn; }
});

await test("smoothing removes DEM chatter that the 3 m hysteresis alone would count", () => {
  // A level trail with ±2.5 m cell noise every 20 m: raw counts climbing, smoothed doesn't.
  const noisy = Array.from({ length: 201 }, (_, i) => 1500 + (i % 4 < 2 ? 2.5 : -2.5));
  assert.ok(hysteresisGainLoss(noisy, 3).gain > 200);
  const sm = smooth(noisy, 10, 100);
  assert.equal(sm[0], noisy[0]);
  assert.equal(sm.at(-1), noisy.at(-1));
  assert.ok(hysteresisGainLoss(sm, 3).gain < 5);
  // A real climb survives.
  const ramp = Array.from({ length: 201 }, (_, i) => 1500 + i * 0.5);
  near(hysteresisGainLoss(smooth(ramp, 10, 100), 3).gain, 100, 0.01);
});

await test("sampleRoute walks every ~10 m and leaves off-trail samples unknown", () => {
  const coords = line([[0, 0], [1000, 0], [1300, -300]]);
  const s = sampleRoute(coords, [{ mode: "trail", coord_range: [0, 1] }, { mode: "manual", coord_range: [1, 2] }], elev);
  assert.ok(s.step <= 10 && s.step > 9.9);
  assert.ok(!Number.isNaN(s.z[0]) && Number.isNaN(s.z.at(-1)));
  near(s.total, 1000 + Math.hypot(300, 300), 2);
});

const mg = process.env.MAZE_GRAPH;
if (mg && existsSync(mg) && existsSync(mg.replace(".trails-graph.", ".trails-elev."))) {
  await test("real data: a Maze route gets a full 3DEP profile", async () => {
    const g = new TrailGraph(JSON.parse(readFileSync(mg, "utf8")), { version: "dev-maze-district" });
    const el = new TrailElevation(JSON.parse(readFileSync(mg.replace(".trails-graph.", ".trails-elev."), "utf8")), g);
    // Maze Overlook down to the South Fork (the demo trip's first day).
    const a = g.snap(-110.001099, 38.234699, 200), b = g.snap(-109.98856, 38.223929, 200);
    assert.ok(a && b, "snap");
    const r = g.route(a, b);
    assert.ok(r, "route");
    const t0 = performance.now();
    const p = await profileForRoute({ coords: r.coords, segments: [{ mode: "trail", coord_range: [0, r.coords.length - 1] }] }, g, { elevation: el });
    console.log(`      ${(r.length_m / 1609.344).toFixed(2)} mi, +${p.gain_ft} / -${p.loss_ft} ft, ${p.profile_ft.length} samples, ${(performance.now() - t0).toFixed(1)} ms`);
    assert.equal(p.source, "usgs-3dep");
    assert.ok(p.loss_ft > 400 && p.loss_ft < 1200, `loss ${p.loss_ft}`);
    assert.ok(Math.min(...p.profile_ft) > 4000 && Math.max(...p.profile_ft) < 5600);
  });
}

console.log(`\n${n} tests passed`);

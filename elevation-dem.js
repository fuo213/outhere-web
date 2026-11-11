/**
 * Elevation for routed legs from our own USGS 3DEP data, no API call.
 *
 * The pipeline samples the ~10 m 3DEP DEM along every edge of a region's
 * routing graph and ships it next to the graph as `booot-trail-elev` v1
 * (outhere graph_elevation.py, SNAPPING_DESIGN.md §5): one array per graph
 * edge, evenly spaced samples (ends included), decimetre ints, first value
 * absolute then deltas; `[]` where the DEM has nothing. The catalog points
 * at it from `routing_graph.elevation`.
 *
 * profileForRoute() is the one entry point. It walks the route line every
 * ~10 m; samples on `trail` legs are read from the sidecar through the graph
 * (nearest edge within a few metres); samples it can't read (straight and
 * manual legs, edges without DEM) are handed to `fill` (Open-Meteo today).
 * The series is then smoothed along the route (`smooth_m` from the file,
 * 100 m: raw 10 m cells over-count gain by ~50% in canyon country because a
 * trail drawn a few metres off climbs the wall) and gain/loss are counted
 * with the same 3 m hysteresis as recorded GPX tracks (gpx-core.js), so
 * drawn and recorded routes are comparable.
 *
 * It returns null whenever it has nothing better than the caller's existing
 * source (no sidecar, no trail legs, under a quarter of the line matched):
 * the caller then does what it did before.
 *
 * Pure: no DOM, no map; `fetch` is injectable. Order of trust for a route's
 * elevation stays: recorded GPX <ele>, then this, then Open-Meteo.
 */

import { hysteresisGainLoss, HYSTERESIS_M } from "./gpx-core.js";

const FT = 3.28084;
const RAD = Math.PI / 180, R = 6371008.8;
const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const SAMPLE_SPACING_M = 10;   // walk the line at the DEM's resolution
export const SNAP_TOLERANCE_M = 5;    // a trail-leg sample must sit this close to a graph edge
export const DEFAULT_SMOOTH_M = 100;
export const PROFILE_SPACING_M = 25;  // stored profile: one sample per 25 m…
export const PROFILE_MAX_SAMPLES = 1000; // …up to this many
export const FILL_MAX_POINTS = 100;   // one Open-Meteo request
export const MIN_COVERAGE = 0.25;     // below this share of 3DEP samples, leave the route to the caller's source
const MAX_WALK_SAMPLES = 20000;       // 200 km at 10 m; longer lines walk coarser

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

export class TrailElevation {
  /**
   * @param {object} doc   parsed booot-trail-elev v1 JSON
   * @param {object} graph the TrailGraph it was built for (same edge order)
   */
  constructor(doc, graph) {
    if (doc?.format !== "booot-trail-elev" || doc.v !== 1) {
      throw new Error(`unsupported elevation format ${doc?.format}/${doc?.v}`);
    }
    if (!Array.isArray(doc.edges) || doc.edges.length !== graph.E) {
      throw new Error(`elevation has ${doc.edges?.length} edges, graph has ${graph.E}`);
    }
    // A catalog graph carries its hash as `version`; a dev override doesn't.
    const gv = graph.version || "";
    if (doc.graph_version && gv && !gv.startsWith("dev-") && doc.graph_version !== gv) {
      throw new Error(`elevation is for graph ${doc.graph_version}, not ${gv}`);
    }
    const units = doc.units_per_m || 10;
    const E = doc.edges.length;
    const off = new Int32Array(E + 1);
    for (let e = 0; e < E; e++) off[e + 1] = off[e] + doc.edges[e].length;
    const z = new Float32Array(off[E]);
    for (let e = 0; e < E; e++) {
      let acc = 0, p = off[e];
      for (const v of doc.edges[e]) { acc += v; z[p++] = acc / units; }
    }
    this.graph = graph;
    this.off = off;
    this.z = z;
    this.smoothM = Number.isFinite(doc.smooth_m) ? doc.smooth_m : DEFAULT_SMOOTH_M;
    this.hysteresisM = Number.isFinite(doc.hysteresis_m) ? doc.hysteresis_m : HYSTERESIS_M;
    this.source = doc.source || "";
  }

  /** Metres at `along` metres from node A on edge e, or null (no DEM there). */
  at(e, along) {
    const lo = this.off[e], n = this.off[e + 1] - lo;
    if (n < 2) return null;
    const len = this.graph.eLen[e];
    const t = (len > 0 ? Math.max(0, Math.min(1, along / len)) : 0) * (n - 1);
    const k = Math.min(n - 2, Math.floor(t));
    return this.z[lo + k] + (t - k) * (this.z[lo + k + 1] - this.z[lo + k]);
  }
}

/**
 * Where a graph's elevation sidecar lives, or null.
 * Catalog: `routing_graph.elevation.url`. Dev override (`?graph=`, localhost
 * only, see routing.js): the file next to the dev graph, `.trails-graph.`
 * replaced by `.trails-elev.`.
 */
export function elevationInfoFor(graphInfo) {
  if (!graphInfo) return null;
  if (graphInfo.elevation?.url) return graphInfo.elevation;
  if (String(graphInfo.version || "").startsWith("dev-") && /\.trails-graph\./.test(graphInfo.url || "")) {
    return { url: graphInfo.url.replace(".trails-graph.", ".trails-elev."), version: graphInfo.version, format: "booot-trail-elev/1" };
  }
  return null;
}

const cache = new Map(); // sidecar url → Promise<TrailElevation | null>

/**
 * Fetch + decode a graph's sidecar once. Resolves null when the graph has
 * none or it can't be used (missing, stale, wrong format): never rejects.
 */
export function loadElevation(graph, { fetchFn = fetch } = {}) {
  const info = elevationInfoFor(graph?.info);
  if (!info) return Promise.resolve(null);
  if (!cache.has(info.url)) {
    const p = (async () => {
      try {
        const res = await fetchFn(info.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new TrailElevation(await res.json(), graph);
      } catch (err) {
        console.warn("[elevation] no 3DEP data:", err.message);
        return null;
      }
    })();
    cache.set(info.url, p);
  }
  return cache.get(info.url);
}

// ---------------------------------------------------------------------------
// Profile maths
// ---------------------------------------------------------------------------

/**
 * Centred moving average over `windowM` of an evenly spaced series. The
 * window shrinks symmetrically near the ends, so both end values are kept.
 */
export function smooth(series, spacingM, windowM) {
  const n = series.length;
  const half = spacingM > 0 ? Math.round(windowM / spacingM / 2) : 0;
  if (half < 1 || n < 3) return Array.from(series);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + series[i];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(half, i, n - 1 - i);
    out[i] = (pre[i + k + 1] - pre[i - k]) / (2 * k + 1);
  }
  return out;
}

/** Linear read of an evenly spaced series at fraction t (0..1) of its length. */
function readAt(series, t) {
  const x = Math.max(0, Math.min(1, t)) * (series.length - 1);
  const k = Math.min(series.length - 2, Math.floor(x));
  return series[k] + (x - k) * (series[k + 1] - series[k]);
}

/**
 * Walk a route line at even spacing and read what the sidecar has.
 * @returns {{ z: Float64Array (NaN = unknown), pts: number[][], total: number, step: number, known: number }}
 */
export function sampleRoute(coords, segments, elev, { spacingM = SAMPLE_SPACING_M, toleranceM = SNAP_TOLERANCE_M } = {}) {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + hav(coords[i - 1], coords[i]);
  const total = cum[coords.length - 1];
  const n = Math.max(2, Math.min(MAX_WALK_SAMPLES, Math.ceil(total / spacingM) + 1));
  // Which stretches of the line (by coordinate index) are routed on trails.
  const trail = (segments || [])
    .filter((s) => s?.mode === "trail" && Array.isArray(s.coord_range))
    .map((s) => s.coord_range);
  const onTrail = (j) => trail.some(([a, b]) => j >= a && j < b);
  const z = new Float64Array(n).fill(NaN), pts = new Array(n);
  let j = 0, known = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < coords.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / span)) : 0;
    const p = [coords[j][0] + t * (coords[j + 1][0] - coords[j][0]), coords[j][1] + t * (coords[j + 1][1] - coords[j][1])];
    pts[k] = p;
    if (!onTrail(j)) continue;
    const s = elev.graph.snap(p[0], p[1], toleranceM);
    const m = s ? elev.at(s.e, s.along) : null;
    if (m != null) { z[k] = m; known++; }
  }
  return { z, pts, total, step: total / (n - 1), known };
}

/** Indices of the unknown samples to ask `fill` for: the ends of every unknown run, the rest spread evenly. */
function pickFillIndices(z, max) {
  const runs = [];
  for (let i = 0; i < z.length; i++) {
    if (!Number.isNaN(z[i])) continue;
    let e = i;
    while (e + 1 < z.length && Number.isNaN(z[e + 1])) e++;
    runs.push([i, e]);
    i = e;
  }
  const missing = runs.reduce((s, [a, b]) => s + b - a + 1, 0);
  const picked = new Set();
  for (const [a, b] of runs) { picked.add(a); picked.add(b); }
  if (picked.size > max) return null; // too fragmented for one request
  const every = Math.max(1, Math.ceil(missing / Math.max(1, max - picked.size)));
  for (const [a, b] of runs) for (let i = a + every; i < b; i += every) picked.add(i);
  return [...picked].sort((p, q) => p - q);
}

/** Fill NaNs by linear interpolation between the nearest known neighbours. */
function interpolateGaps(z) {
  let last = -1;
  for (let i = 0; i < z.length; i++) {
    if (Number.isNaN(z[i])) continue;
    if (last < 0) for (let k = 0; k < i; k++) z[k] = z[i];
    else for (let k = last + 1; k < i; k++) z[k] = z[last] + ((k - last) / (i - last)) * (z[i] - z[last]);
    last = i;
  }
  if (last >= 0) for (let k = last + 1; k < z.length; k++) z[k] = z[last];
  return last >= 0;
}

/**
 * Elevation profile and gain/loss for a route from the pipeline's 3DEP data.
 *
 * @param {object} route  a route feature, or { coords, segments }
 * @param {object} graph  the decoded TrailGraph of the route's region
 * @param {object} [opts]
 * @param {(points: number[][]) => Promise<number[] | null>} [opts.fill]
 *   metres for [lon, lat] points the sidecar can't answer (≤ FILL_MAX_POINTS
 *   per route). Without it, a route that isn't fully covered returns null.
 * @param {number} [opts.samples]  length of profile_ft (default: one per 25 m, ≤ 1000)
 * @param {TrailElevation} [opts.elevation]  skip loading (tests)
 * @param {Function} [opts.fetchFn]
 * @returns {Promise<null | { profile_ft: number[], gain_ft: number, loss_ft: number,
 *   spacing_m: number, source: "usgs-3dep" | "mixed", coverage: number }>}
 *   profile_ft is evenly spaced by distance, ends included (sample k of n at
 *   k/(n-1) of the length); spacing_m is the distance between its samples.
 */
export async function profileForRoute(route, graph, { fill = null, samples = null, elevation = null, fetchFn = fetch } = {}) {
  const coords = route?.geometry?.coordinates || route?.coords;
  const segments = route?.properties?.segments || route?.segments;
  if (!graph || !Array.isArray(coords) || coords.length < 2) return null;
  if (!segments?.some((s) => s?.mode === "trail")) return null;
  const elev = elevation || await loadElevation(graph, { fetchFn });
  if (!elev) return null;

  const { z, pts, total, step, known } = sampleRoute(coords, segments, elev);
  if (!(total > 0)) return null;
  const coverage = known / z.length;
  if (coverage < MIN_COVERAGE) return null;
  if (known < z.length) {
    if (!fill) return null;
    const idx = pickFillIndices(z, FILL_MAX_POINTS);
    if (!idx) return null;
    let metres = null;
    try { metres = await fill(idx.map((i) => pts[i])); } catch { /* the caller falls back */ }
    if (!Array.isArray(metres) || metres.length !== idx.length || !metres.every(Number.isFinite)) return null;
    idx.forEach((i, k) => { z[i] = metres[k]; });
    interpolateGaps(z);
  }

  const sm = smooth(z, step, elev.smoothM);
  const { gain, loss } = hysteresisGainLoss(sm, elev.hysteresisM);
  const n = Math.max(2, Math.round(samples ?? Math.min(PROFILE_MAX_SAMPLES, Math.round(total / PROFILE_SPACING_M) + 1)));
  const profile = new Array(n);
  for (let k = 0; k < n; k++) profile[k] = Math.round(readAt(sm, k / (n - 1)) * FT);
  return {
    profile_ft: profile,
    gain_ft: Math.round(gain * FT),
    loss_ft: Math.round(loss * FT),
    spacing_m: total / (n - 1),
    source: known === z.length ? "usgs-3dep" : "mixed",
    coverage,
  };
}

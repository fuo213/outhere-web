/**
 * Booot trail routing: client-side A* over the pipeline-built routing graph.
 *
 * The pipeline (outhere/graph_generator.py) emits one compact JSON graph per
 * region preset ("booot-trail-graph" v1, see SNAPPING_DESIGN.md §1.1) and
 * catalog.json points at it via `routing_graph`. This module decodes it into
 * typed arrays (CSR adjacency, one flat Float64 geometry buffer), indexes
 * every segment with flatbush, snaps clicks in meters, and routes with A*
 * (binary heap, admissible haversine heuristic) between points that may lie
 * mid-edge. No other dependencies; nothing here touches the map or the DOM.
 */

import Flatbush from "https://cdn.jsdelivr.net/npm/flatbush@4.4.0/+esm";

const R = 6371008.8; // mean Earth radius (m), same as turf
const RAD = Math.PI / 180;

export function haversine(ax, ay, bx, by) {
  const dLat = (by - ay) * RAD, dLon = (bx - ax) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(ay * RAD) * Math.cos(by * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length of a [lon, lat][] polyline in meters. */
export function lineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  return m;
}

/** Ground meters per CSS pixel at a latitude and MapLibre zoom (512 px tiles). */
export function metersPerPixel(lat, zoom) {
  return (40075016.686 * Math.cos(lat * RAD)) / (512 * 2 ** zoom);
}

// Cost factors (cost = length x factor). A trail up to 1.5x longer beats a
// dirt road, up to 3x longer beats a highway. Minimum factor is 1.0, which
// keeps the haversine heuristic admissible. SNAPPING_DESIGN.md §2.4.
const FACTORS = {
  path: 1, footway: 1, bridleway: 1, steps: 1, pedestrian: 1,
  track: 1.1, cycleway: 1.1,
  service: 1.5, residential: 1.5, unclassified: 1.5, living_street: 1.5, road: 1.5,
  tertiary: 2, tertiary_link: 2,
  secondary: 3, secondary_link: 3, primary: 3, primary_link: 3,
};
const ROADS = new Set([
  "service", "residential", "unclassified", "living_street", "road",
  "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link",
]);
export const costFactor = (highway) => FACTORS[highway] ?? 1;
export const isRoad = (highway) => ROADS.has(highway);

// ---------------------------------------------------------------------------
// Binary min-heap keyed by f-score
// ---------------------------------------------------------------------------

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const K = this.k, V = this.v;
    let i = K.length;
    K.push(key); V.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0];
    const lk = K.pop(), lv = V.pop();
    const n = K.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && K[l] < mk) { m = l; mk = K[l]; }
        if (r < n && K[r] < mk) m = r;
        if (m === i) break;
        K[i] = K[m]; V[i] = V[m]; i = m;
      }
      K[i] = lk; V[i] = lv;
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export class TrailGraph {
  /**
   * @param {object} doc  parsed booot-trail-graph v1 JSON
   * @param {object} info catalog routing_graph block ({url, version, ...}) plus
   *                      `regionId` and `state`
   */
  constructor(doc, info = {}) {
    if (doc?.format !== "booot-trail-graph" || doc.v !== 1) {
      throw new Error(`unsupported graph format ${doc?.format}/${doc?.v}`);
    }
    const S = doc.scale || 1e6;
    this.info = info;
    this.region = doc.region || info.regionId || "";
    this.state = doc.state || info.state || "";
    this.version = info.version || "";
    this.osmTimestamp = doc.osm_timestamp || info.osm_timestamp || "";
    this.gaps = Array.isArray(doc.gaps) ? doc.gaps : [];

    // Way table, normalized by field name.
    const f = Object.fromEntries((doc.ways_fields || []).map((name, i) => [name, i]));
    const ways = doc.ways || [];
    this.wayOsm = ways.map((w) => w[f.osm_id]);
    this.wayName = ways.map((w) => w[f.name] || "");
    this.wayHighway = ways.map((w) => w[f.highway] || "");

    // Nodes: interleaved, delta-encoded ints at 1/scale degrees.
    const nN = doc.nodes.length / 2;
    const nx = new Float64Array(nN), ny = new Float64Array(nN);
    const ix = new Int32Array(nN), iy = new Int32Array(nN);
    for (let i = 0, x = 0, y = 0; i < nN; i++) {
      x += doc.nodes[2 * i]; y += doc.nodes[2 * i + 1];
      ix[i] = x; iy[i] = y; nx[i] = x / S; ny[i] = y / S;
    }

    // Edges: one flat geometry buffer (endpoints included) + per-vertex
    // cumulative meters, so slicing and along-distances are lookups.
    const E = doc.edges.length;
    const eA = new Int32Array(E), eB = new Int32Array(E), eW = new Int32Array(E);
    const eOff = new Int32Array(E + 1);
    let total = 0;
    for (let e = 0; e < E; e++) { eOff[e] = total; total += doc.edges[e][4].length / 2 + 2; }
    eOff[E] = total;
    const xy = new Float64Array(total * 2);
    const cum = new Float64Array(total);
    const eLen = new Float64Array(E), eCost = new Float64Array(E);
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (let e = 0; e < E; e++) {
      const [a, b, w, , d] = doc.edges[e];
      eA[e] = a; eB[e] = b; eW[e] = w;
      let p = eOff[e];
      xy[2 * p] = nx[a]; xy[2 * p + 1] = ny[a]; cum[p] = 0;
      let x = ix[a], y = iy[a];
      for (let i = 0; i < d.length; i += 2) {
        x += d[i]; y += d[i + 1]; p++;
        xy[2 * p] = x / S; xy[2 * p + 1] = y / S;
        cum[p] = cum[p - 1] + haversine(xy[2 * p - 2], xy[2 * p - 1], xy[2 * p], xy[2 * p + 1]);
      }
      p++;
      xy[2 * p] = nx[b]; xy[2 * p + 1] = ny[b];
      cum[p] = cum[p - 1] + haversine(xy[2 * p - 2], xy[2 * p - 1], xy[2 * p], xy[2 * p + 1]);
      eLen[e] = cum[p];
      eCost[e] = eLen[e] * (w >= 0 ? costFactor(this.wayHighway[w]) : 1);
    }
    for (let i = 0; i < nN; i++) {
      if (nx[i] < west) west = nx[i]; if (nx[i] > east) east = nx[i];
      if (ny[i] < south) south = ny[i]; if (ny[i] > north) north = ny[i];
    }
    this.bbox = Array.isArray(doc.bbox) && doc.bbox.length === 4 ? doc.bbox : [west, south, east, north];

    // CSR adjacency
    const deg = new Int32Array(nN + 1);
    for (let e = 0; e < E; e++) { deg[eA[e] + 1]++; deg[eB[e] + 1]++; }
    for (let i = 0; i < nN; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(2 * E), fill = deg.slice(0, nN);
    for (let e = 0; e < E; e++) { adj[fill[eA[e]]++] = e; adj[fill[eB[e]]++] = e; }

    // Connected components (union-find), used to place the gap pin.
    const parent = new Int32Array(nN);
    for (let i = 0; i < nN; i++) parent[i] = i;
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let e = 0; e < E; e++) { const ra = find(eA[e]), rb = find(eB[e]); if (ra !== rb) parent[ra] = rb; }
    const comp = new Int32Array(nN);
    for (let i = 0; i < nN; i++) comp[i] = find(i);

    // Segment index (one box per consecutive vertex pair).
    const segCount = total - E;
    const index = new Flatbush(segCount);
    const segE = new Int32Array(segCount), segI = new Int32Array(segCount);
    for (let e = 0, s = 0; e < E; e++) {
      for (let p = eOff[e]; p < eOff[e + 1] - 1; p++, s++) {
        const x0 = xy[2 * p], y0 = xy[2 * p + 1], x1 = xy[2 * p + 2], y1 = xy[2 * p + 3];
        index.add(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
        segE[s] = e; segI[s] = p;
      }
    }
    index.finish();

    Object.assign(this, { nN, E, nx, ny, eA, eB, eW, eOff, xy, cum, eLen, eCost, deg, adj, comp, index, segE, segI });
    this.dist = new Float64Array(nN);
    this.prevE = new Int32Array(nN);
  }

  /**
   * One throwaway long route across the largest component, run once after
   * decoding, so the browser has compiled snap, A* and slice before the user's
   * first long preview (cold, that first long frame took 2-5 ms; warm, about 1.3 ms).
   * Leaves no state behind: route() resets dist/prevE on every call.
   * @returns {number} milliseconds spent
   */
  warmUp() {
    const t0 = performance.now();
    if (!this.nN) return 0;
    const size = new Int32Array(this.nN);
    let big = 0;
    for (let i = 0; i < this.nN; i++) if (++size[this.comp[i]] > size[big]) big = this.comp[i];
    // The component's west-most and east-most nodes: a route that spans it.
    let w = -1, e = -1;
    for (let i = 0; i < this.nN; i++) {
      if (this.comp[i] !== big) continue;
      if (w < 0 || this.nx[i] < this.nx[w]) w = i;
      if (e < 0 || this.nx[i] > this.nx[e]) e = i;
    }
    for (let k = 0; k < 3; k++) {
      const a = this.snap(this.nx[w], this.ny[w], 50), b = this.snap(this.nx[e], this.ny[e], 50);
      if (a && b) this.route(a, b);
    }
    this.warmUpMs = performance.now() - t0;
    return this.warmUpMs;
  }

  /** True if [lon, lat] lies inside the graph's bbox (small pad for edge clicks). */
  contains(lon, lat, pad = 0.002) {
    const [w, s, e, n] = this.bbox;
    return lon >= w - pad && lon <= e + pad && lat >= s - pad && lat <= n + pad;
  }

  edgeHighway(e) { const w = this.eW[e]; return w >= 0 ? this.wayHighway[w] : ""; }
  edgeName(e) { const w = this.eW[e]; return w >= 0 ? this.wayName[w] : ""; }
  edgeOsmId(e) { const w = this.eW[e]; return w >= 0 ? this.wayOsm[w] : null; }

  /**
   * Nearest point on the network within radiusM (point-to-segment in local
   * meters). With equal distances (within 0.5 m) a trail beats a road.
   * @returns {null | {e, p, t, d, lon, lat, along, comp, name, highway, osmId}}
   */
  snap(lon, lat, radiusM) {
    const kx = Math.cos(lat * RAD) * 111320, ky = 110574;
    const dLon = radiusM / kx, dLat = radiusM / ky;
    const { xy, segE, segI } = this;
    let best = null, bestRoad = false;
    for (const s of this.index.search(lon - dLon, lat - dLat, lon + dLon, lat + dLat)) {
      const p = segI[s];
      const ax = (xy[2 * p] - lon) * kx, ay = (xy[2 * p + 1] - lat) * ky;
      const bx = (xy[2 * p + 2] - lon) * kx, by = (xy[2 * p + 3] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d > radiusM) continue;
      const road = isRoad(this.edgeHighway(segE[s]));
      if (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && bestRoad && !road)) {
        best = { e: segE[s], p, t, d };
        bestRoad = road;
      }
    }
    if (!best) return null;
    const { e, p, t } = best;
    best.lon = xy[2 * p] + t * (xy[2 * p + 2] - xy[2 * p]);
    best.lat = xy[2 * p + 1] + t * (xy[2 * p + 3] - xy[2 * p + 1]);
    best.along = this.cum[p] + t * (this.cum[p + 1] - this.cum[p]);
    best.comp = this.comp[this.eA[e]];
    best.name = this.edgeName(e);
    best.highway = this.edgeHighway(e);
    best.osmId = this.edgeOsmId(e);
    return best;
  }

  /**
   * Every way within radiusM of a point, nearest edge of each way (for
   * map-matching a recording, which wants to pick among nearby ways rather
   * than take the single nearest). Unnamed edges with no way key by edge.
   * @returns {Array<{key, e, d, w, name, highway, osmId}>}
   */
  candidates(lon, lat, radiusM) {
    const kx = Math.cos(lat * RAD) * 111320, ky = 110574;
    const dLon = radiusM / kx, dLat = radiusM / ky;
    const { xy, segE, segI } = this;
    const byKey = new Map();
    for (const s of this.index.search(lon - dLon, lat - dLat, lon + dLon, lat + dLat)) {
      const p = segI[s];
      const ax = (xy[2 * p] - lon) * kx, ay = (xy[2 * p + 1] - lat) * ky;
      const bx = (xy[2 * p + 2] - lon) * kx, by = (xy[2 * p + 3] - lat) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d > radiusM) continue;
      const e = segE[s], w = this.eW[e], key = w >= 0 ? `w${w}` : `e${e}`;
      const cur = byKey.get(key);
      if (!cur || d < cur.d) byKey.set(key, { key, e, d, w, name: this.edgeName(e), highway: this.edgeHighway(e), osmId: this.edgeOsmId(e) });
    }
    return [...byKey.values()];
  }

  /** Point at `along` meters from node A on edge e. */
  _pointAt(e, along) {
    const { cum, xy } = this;
    let lo = this.eOff[e], hi = this.eOff[e + 1] - 1;
    if (along <= 0) return [xy[2 * lo], xy[2 * lo + 1]];
    if (along >= cum[hi]) return [xy[2 * hi], xy[2 * hi + 1]];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= along) lo = mid; else hi = mid; }
    const span = cum[hi] - cum[lo], t = span ? (along - cum[lo]) / span : 0;
    return [xy[2 * lo] + t * (xy[2 * hi] - xy[2 * lo]), xy[2 * lo + 1] + t * (xy[2 * hi + 1] - xy[2 * lo + 1])];
  }

  /** Coordinates along edge e from one along-distance to another (either direction). */
  _slice(e, from, to) {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const out = [this._pointAt(e, lo)];
    for (let p = this.eOff[e]; p < this.eOff[e + 1]; p++) {
      if (this.cum[p] > lo && this.cum[p] < hi) out.push([this.xy[2 * p], this.xy[2 * p + 1]]);
    }
    out.push(this._pointAt(e, hi));
    return from <= to ? out : out.reverse();
  }

  /**
   * Shortest-cost path between two snap results.
   * @param {object} a snap()
   * @param {object} b snap()
   * @param {{budgetMs?: number}} [opts] abort (returns {aborted: true}) past the budget
   * @returns {null | {aborted: true} | {coords, length_m, wayIds, mode: "trail"}}
   *          null when the two points aren't connected in the graph
   */
  route(a, b, { budgetMs = Infinity } = {}) {
    // Different connected components: no path, and no need to search.
    if (a.comp != null && b.comp != null && a.comp !== b.comp) return null;
    const { eA, eB, eLen, eCost, deg, adj, nx, ny, dist, prevE } = this;
    const t0 = budgetMs < Infinity ? performance.now() : 0;
    const factor = (e) => (eLen[e] > 0 ? eCost[e] / eLen[e] : 1);
    const h = (n) => haversine(nx[n], ny[n], b.lon, b.lat); // admissible: min factor 1.0
    dist.fill(Infinity);
    prevE.fill(-1);
    const heap = new Heap();
    const seedAlong = new Map(); // seed node → along on a.e where the path leaves the start edge
    const seed = (n, c, along) => {
      if (c < dist[n]) { dist[n] = c; prevE[n] = -2; seedAlong.set(n, along); heap.push(c + h(n), n); }
    };
    seed(eA[a.e], a.along * factor(a.e), 0);
    seed(eB[a.e], (eLen[a.e] - a.along) * factor(a.e), eLen[a.e]);

    const goalA = eA[b.e], goalB = eB[b.e];
    const endA = b.along * factor(b.e), endB = (eLen[b.e] - b.along) * factor(b.e);
    let best = Infinity, bestNode = -1, bestEndAlong = 0;
    if (a.e === b.e) { best = Math.abs(a.along - b.along) * factor(a.e); bestNode = -3; }

    let pops = 0;
    while (heap.size) {
      const n = heap.pop();
      const dn = dist[n];
      if (dn + h(n) >= best) break;
      if (n === goalA && dn + endA < best) { best = dn + endA; bestNode = n; bestEndAlong = 0; }
      if (n === goalB && dn + endB < best) { best = dn + endB; bestNode = n; bestEndAlong = eLen[b.e]; }
      for (let k = deg[n]; k < deg[n + 1]; k++) {
        const e = adj[k], m = eA[e] === n ? eB[e] : eA[e];
        const c = dn + eCost[e];
        if (c < dist[m]) { dist[m] = c; prevE[m] = e; heap.push(c + h(m), m); }
      }
      if ((++pops & 63) === 0 && budgetMs < Infinity && performance.now() - t0 > budgetMs) {
        return { aborted: true };
      }
    }
    if (bestNode === -1) return null;

    let coords, edges;
    const lens = []; // meters travelled on each edge, parallel to `edges`
    if (bestNode === -3) {
      coords = this._slice(a.e, a.along, b.along);
      edges = [a.e];
      lens.push(Math.abs(a.along - b.along));
    } else {
      const chain = [];
      let n = bestNode;
      while (prevE[n] >= 0) {
        const e = prevE[n];
        const from = eA[e] === n ? eB[e] : eA[e];
        chain.push([e, from]);
        n = from;
      }
      chain.reverse();
      coords = this._slice(a.e, a.along, seedAlong.get(n));
      edges = [a.e];
      lens.push(Math.abs(seedAlong.get(n) - a.along));
      for (const [e, from] of chain) {
        const pts = this._slice(e, 0, eLen[e]);
        if (from !== eA[e]) pts.reverse();
        for (let i = 1; i < pts.length; i++) coords.push(pts[i]);
        edges.push(e);
        lens.push(eLen[e]);
      }
      const tail = this._slice(b.e, bestEndAlong, b.along);
      for (let i = 1; i < tail.length; i++) coords.push(tail[i]);
      edges.push(b.e);
      lens.push(Math.abs(b.along - bestEndAlong));
    }

    // Drop consecutive duplicates (zero-length slices at nodes).
    const clean = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      const p = clean[clean.length - 1];
      if (coords[i][0] !== p[0] || coords[i][1] !== p[1]) clean.push(coords[i]);
    }
    if (clean.length === 1) clean.push([...clean[0]]);

    const wayIds = [];
    for (const e of edges) {
      const id = this.edgeOsmId(e);
      if (id != null && wayIds[wayIds.length - 1] !== id && !wayIds.includes(id)) wayIds.push(id);
    }
    // Name runs along the path (consecutive edges with the same name/highway
    // merged), used to pre-fill route names. Not exported.
    const runs = [];
    edges.forEach((e, i) => {
      const name = this.edgeName(e), highway = this.edgeHighway(e);
      const last = runs[runs.length - 1];
      if (last && last.name === name && last.highway === highway) last.m += lens[i];
      else runs.push({ name, highway, m: lens[i] });
    });
    return { coords: clean, length_m: lineLength(clean), wayIds, runs, mode: "trail" };
  }

  /**
   * Where to put the "fix it in OpenStreetMap" pin for a straight leg A→B.
   * 1. a pipeline `gaps` entry within 25 m of the leg;
   * 2. else the closest approach between the two snapped components near
   *    the leg;
   * 3. else the leg midpoint.
   * @returns {{lon, lat, source: "gaps"|"approach"|"midpoint"}}
   */
  gapFor(aLngLat, bLngLat, aSnap, bSnap) {
    const [ax, ay] = aLngLat, [bx, by] = bLngLat;
    const midLat = (ay + by) / 2;
    const kx = Math.cos(midLat * RAD) * 111320, ky = 110574;
    const distToLeg = (x, y) => {
      const px = (x - ax) * kx, py = (y - ay) * ky, dx = (bx - ax) * kx, dy = (by - ay) * ky;
      const L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
      return Math.hypot(px - t * dx, py - t * dy);
    };

    let best = null;
    for (const g of this.gaps) {
      const d = distToLeg(g[0], g[1]);
      if (d <= 25 && (!best || d < best.d)) best = { d, lon: g[0], lat: g[1], dist_m: g[4], ids: [g[5], g[6]] };
    }
    // `ways`: the (up to) two OSM ways on either side, for "report this gap".
    if (best) {
      return { lon: best.lon, lat: best.lat, source: "gaps", dist_m: best.dist_m, ways: best.ids.map((id) => this.wayByOsmId(id)).filter(Boolean) };
    }

    const snapWay = (s) => (s?.osmId != null ? { osmId: s.osmId, name: s.name || "", highway: s.highway || "" } : null);
    const ways = [snapWay(aSnap), snapWay(bSnap)].filter(Boolean);
    if (aSnap && bSnap && aSnap.comp !== bSnap.comp) {
      const approach = this._closestApproach(aLngLat, bLngLat, aSnap.comp, bSnap.comp);
      if (approach) return { lon: approach.lon, lat: approach.lat, source: "approach", dist_m: approach.d, ways };
    }
    return { lon: (ax + bx) / 2, lat: midLat, source: "midpoint", ways };
  }

  /** {osmId, name, highway} for an OSM way id in this graph, or null. */
  wayByOsmId(osmId) {
    if (osmId == null) return null;
    if (!this._osmIndex) {
      this._osmIndex = new Map();
      this.wayOsm.forEach((id, i) => { if (!this._osmIndex.has(id)) this._osmIndex.set(id, i); });
    }
    const i = this._osmIndex.get(osmId);
    return i === undefined ? { osmId, name: "", highway: "" } : { osmId, name: this.wayName[i], highway: this.wayHighway[i] };
  }

  _closestApproach([ax, ay], [bx, by], compA, compB) {
    const { xy, segE, eA, comp, index } = this;
    const lat = (ay + by) / 2, kx = Math.cos(lat * RAD) * 111320, ky = 110574;
    const legM = Math.hypot((bx - ax) * kx, (by - ay) * ky);
    const padM = Math.max(200, legM * 0.25);
    const w = Math.min(ax, bx) - padM / kx, e = Math.max(ax, bx) + padM / kx;
    const s = Math.min(ay, by) - padM / ky, n = Math.max(ay, by) + padM / ky;
    const inA = index.search(w, s, e, n, (i) => comp[eA[segE[i]]] === compA);
    if (!inA.length) return null;
    const stride = Math.max(1, Math.floor(inA.length / 2000));
    const isB = (i) => comp[eA[segE[i]]] === compB;
    let best = null;
    for (let k = 0; k < inA.length; k += stride) {
      const p = this.segI[inA[k]];
      const x = xy[2 * p], y = xy[2 * p + 1];
      const [nb] = index.neighbors(x, y, 1, padM / ky, isB);
      if (nb === undefined) continue;
      const q = this.segI[nb];
      // Nearest point on the B segment, in local meters.
      const qx0 = (xy[2 * q] - x) * kx, qy0 = (xy[2 * q + 1] - y) * ky;
      const qx1 = (xy[2 * q + 2] - x) * kx, qy1 = (xy[2 * q + 3] - y) * ky;
      const dx = qx1 - qx0, dy = qy1 - qy0, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(qx0 * dx + qy0 * dy) / L2)) : 0;
      const d = Math.hypot(qx0 + t * dx, qy0 + t * dy);
      if (!best || d < best.d) {
        const tx = xy[2 * q] + t * (xy[2 * q + 2] - xy[2 * q]), ty = xy[2 * q + 1] + t * (xy[2 * q + 3] - xy[2 * q + 1]);
        best = { d, lon: (x + tx) / 2, lat: (y + ty) / 2 };
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Loading + graph choice
// ---------------------------------------------------------------------------

const cache = new Map(); // version (or url) → Promise<TrailGraph>

/**
 * Fetch + decode a region's graph once per version. The file is immutable
 * and served without Range so Cloudflare brotli-compresses it; fetch()
 * decompresses transparently.
 * @param {{url, version, regionId, state}} info
 */
export function loadGraph(info) {
  const key = info.version || info.url;
  if (!cache.has(key)) {
    const p = (async () => {
      const res = await fetch(info.url);
      if (!res.ok) throw new Error(`graph HTTP ${res.status}`);
      const doc = await res.json();
      await new Promise((r) => setTimeout(r, 0)); // let the loading state paint
      const g = new TrailGraph(doc, info);
      g.warmUp();
      return g;
    })();
    p.catch(() => cache.delete(key)); // retry on the next attempt
    cache.set(key, p);
  }
  return cache.get(key);
}

/** The already-decoded graph for this info, or null (never triggers a load). */
export function peekGraph(info) {
  return info ? cache.get(info.version || info.url) ?? null : null;
}

/**
 * Dev-only: `?graph=zion:dev-graphs/zion.json,maze-district:...` maps region
 * ids to local graph files before the pipeline deploys them. Honored only
 * on localhost, so it can't change production behavior.
 */
const DEV_OVERRIDES = (() => {
  const out = new Map();
  try {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return out;
    const spec = new URLSearchParams(location.search).get("graph");
    for (const part of (spec || "").split(",")) {
      const i = part.indexOf(":");
      if (i <= 0) continue;
      const id = part.slice(0, i), url = new URL(part.slice(i + 1), location.href).href;
      out.set(id, { url, version: `dev-${id}`, format: "booot-trail-graph/1" });
    }
  } catch { /* not in a browser */ }
  return out;
})();

/** A region's routing_graph block (dev override first), or null. */
export function graphInfoForRegion(region) {
  if (!region) return null;
  const info = DEV_OVERRIDES.get(region.id) || region.routing_graph;
  if (!info?.url) return null;
  return { ...info, regionId: region.id, state: region.state || "" };
}

const regionContains = (r, lon, lat) => {
  const b = r.bounds;
  return b && lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
};
const regionArea = (r) => (r.bounds.east - r.bounds.west) * (r.bounds.north - r.bounds.south);

/**
 * Which region's graph a new route starting at [lon, lat] should use.
 * The active area region wins if it contains the point; otherwise the
 * smallest catalog area region containing it (Maze and Needles overlap).
 * @returns {{region, info} | null} info is null when the region has no graph
 */
export function pickGraphRegion(activeRegion, regions, [lon, lat]) {
  if (activeRegion?.type === "area" && activeRegion.bounds && regionContains(activeRegion, lon, lat)) {
    return { region: activeRegion, info: graphInfoForRegion(activeRegion) };
  }
  const candidates = (regions || [])
    .filter((r) => r.type === "area" && r.available !== false && regionContains(r, lon, lat))
    .sort((p, q) => regionArea(p) - regionArea(q));
  const withGraph = candidates.find((r) => graphInfoForRegion(r));
  if (withGraph) return { region: withGraph, info: graphInfoForRegion(withGraph) };
  if (candidates.length) return { region: candidates[0], info: null };
  if (activeRegion?.type === "area") return { region: activeRegion, info: graphInfoForRegion(activeRegion) };
  return null;
}

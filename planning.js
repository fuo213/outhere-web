/**
 * Booot trip planning: drawing tools.
 *
 * Route drawing with switchable point types (route/camp/dayhike/rest; keys
 * 1-4). Clicks snap to the region's routing graph and every leg is routed
 * along real trails by routing.js (A* over the pipeline-built OSM graph,
 * SNAPPING_DESIGN.md Part 2). A live routed preview follows the cursor.
 *
 * Legs that can't be routed are drawn straight and say why:
 *   manual        Shift-click (or a point placed away from any trail)
 *   straight      no_path: the trails don't connect in OpenStreetMap
 *                 no_graph: no routing graph for this place yet
 *                 cross_region: the leg leaves the route's map region
 * Backspace / Ctrl-Z undoes the last point, Esc cancels, double-click
 * finishes.
 */

import { map } from "./app.js"; // circular with app.js; only used at runtime
import { TripManager, updateDrawingPreview, alignPlanningToolbar, escapeHTML, escapeAttr } from "./trip-panel.js";
import { getActiveRegion, getCatalogRegions, findRegionById } from "./region-picker.js"; // circular; runtime only
import {
  loadGraph, peekGraph, pickGraphRegion, graphInfoForRegion,
  metersPerPixel, lineLength, haversine,
} from "./routing.js";

// Route drawing state (exported as live read-only bindings for app.js / trip-panel.js)
export let isDrawingRoute = false;
export let isDeleteMode = false;

/** Placed points: { coord: [lon, lat], snapped, type, snap } (snap = routing.js snap result or null). */
let verts = [];
/** legs[i] ends at verts[i] (legs[0] is unused). See computeLeg(). */
let legs = [];
let currentPointType = "route";

/**
 * Routing context for the route being drawn: one graph per route.
 * { region, info, graph, status: "loading" | "ready" | "none" | "error", promise }
 */
let ctx = null;
let session = 0;                  // bumps on every start/reset; stale async work checks it
let queue = Promise.resolve();    // clicks, undo and finish run in order (graph may still be loading)

// Snapping (SNAPPING_DESIGN.md §2.4)
const SNAP_PX = 24;
const SNAP_MIN_M = 10;
const SNAP_MAX_M = 200;
const SNAP_MIN_ZOOM = 11;

// Live preview (§2.5)
const PREVIEW_BUDGET_MS = 3; // of the 4 ms/frame budget; the rest is for setData of the preview line
let pendingMove = null;
let rafId = 0;
let previewLeg = null;            // leg-shaped object for the cursor, or null
let previewMemo = new Map();      // `${from}|${edge}|${along/5m}` → route result
const previewStats = { frames: 0, routeMs: [], frameMs: [], aborted: 0, memoHits: 0 };

// Bound handler references so we can add/remove listeners
let _routeMouseMoveHandler = null;
let _routeKeyHandler = null;
let gapPopup = null;

const MI = 1609.344;

// ---------------------------------------------------------------------------
// Routing context (which graph, loaded lazily per region)
// ---------------------------------------------------------------------------

function makeContext(pick) {
  const c = { region: pick?.region || null, info: pick?.info || null, graph: null, status: "none", promise: null };
  if (!c.info) return c;
  const cached = peekGraph(c.info);
  c.status = "loading";
  c.promise = (cached || loadGraph(c.info))
    .then((g) => { c.graph = g; c.status = "ready"; if (c.region) decoded.set(c.region.id, g); })
    .catch((err) => { console.warn("[routing] graph load failed:", err.message); c.status = "error"; })
    .finally(() => { if (ctx === c) { previewMemo.clear(); updateDrawingHint(); schedulePreview(); } });
  return c;
}

/** Pick (on the first click, for full-state regions) and await the route's graph. */
async function ensureContext(lngLat) {
  if (!ctx) ctx = makeContext(pickGraphRegion(getActiveRegion(), getCatalogRegions(), lngLat));
  updateDrawingHint();
  if (ctx.promise) await ctx.promise;
}

/** Start loading the active area region's graph early (draw start, trip open). */
export function prefetchRoutingGraph() {
  const region = getActiveRegion();
  if (region?.type !== "area") return null;
  const info = graphInfoForRegion(region);
  if (!info) return null;
  const run = () => loadGraph(info)
    .then((g) => {
      decoded.set(region.id, g);
      // Saved straight legs can now place their gap pins precisely.
      const hasGaps = TripManager.currentTrip?.features?.some((f) => f.properties?.segments?.some((s) => s.mode === "straight"));
      if (hasGaps) TripManager.render();
      return g;
    })
    .catch(() => null);
  if ("requestIdleCallback" in window) return new Promise((r) => requestIdleCallback(() => r(run()), { timeout: 2000 }));
  return run();
}

function snapRadius(lat, zoom) {
  return Math.min(SNAP_MAX_M, Math.max(SNAP_MIN_M, SNAP_PX * metersPerPixel(lat, zoom)));
}

/** Snap a cursor/click position to the route's graph, or null. */
function snapPoint(lngLat, zoom) {
  const g = ctx?.graph;
  if (!g || zoom < SNAP_MIN_ZOOM || !g.contains(lngLat[0], lngLat[1])) return null;
  return g.snap(lngLat[0], lngLat[1], snapRadius(lngLat[1], zoom));
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

function lastMainIndex(upTo) {
  for (let i = upTo; i >= 0; i--) if (verts[i].type !== "dayhike") return i;
  return 0;
}

function straightLeg(from, to, A, B, kind, mode, reason, { preview = false } = {}) {
  const coords = [A.coord, B.coord];
  const leg = { from, to, kind, mode, coords, length_m: lineLength(coords), wayIds: [] };
  if (reason) leg.reason = reason;
  if (mode === "straight") {
    // Previews skip the gap search: it can cost a few ms and the pin is only
    // shown for placed legs.
    const gap = reason === "no_path" && ctx?.graph && !preview
      ? ctx.graph.gapFor(A.coord, B.coord, A.snap, B.snap)
      : { lon: (A.coord[0] + B.coord[0]) / 2, lat: (A.coord[1] + B.coord[1]) / 2 };
    leg.gap = [gap.lon, gap.lat];
  }
  return leg;
}

/** Why a leg from A to B can't use the route's graph, or null if it can. */
function unroutableReason(A, B) {
  const g = ctx?.graph;
  if (!g) {
    // Another region's graph covers B → the route crossed a boundary;
    // otherwise (no graph here, or ours failed to load) routing is unavailable.
    const other = pickGraphRegion(getActiveRegion(), getCatalogRegions(), B.coord);
    return other?.info && other.info.url !== ctx?.info?.url ? "cross_region" : "no_graph";
  }
  if (!g.contains(...A.coord) || !g.contains(...B.coord)) return "cross_region";
  return null;
}

/**
 * Route one leg between two placed (or preview) points.
 * @returns leg {from, to, kind: "main"|"spur", mode, reason?, coords, length_m, wayIds, gap?}
 *          or {aborted: true} when a preview query blows its budget
 */
function computeLeg(from, to, A, B, { shift = false, budgetMs = Infinity, preview = false } = {}) {
  const kind = B.type === "dayhike" ? "spur" : "main";
  if (shift) return straightLeg(from, to, A, B, kind, "manual");
  // Graph still downloading (preview only; clicks wait for it): neutral straight.
  if (ctx?.status === "loading") return straightLeg(from, to, A, B, kind, "manual");
  const reason = unroutableReason(A, B);
  if (reason) return straightLeg(from, to, A, B, kind, "straight", reason, { preview });
  // A point placed away from every trail is a deliberate off-trail leg.
  if (!A.snap || !B.snap) return straightLeg(from, to, A, B, kind, "manual");
  const r = ctx.graph.route(A.snap, B.snap, { budgetMs });
  if (r?.aborted) return r;
  if (!r) return straightLeg(from, to, A, B, kind, "straight", "no_path", { preview });
  return { from, to, kind, mode: "trail", coords: r.coords, length_m: r.length_m, wayIds: r.wayIds };
}

// ---------------------------------------------------------------------------
// Drawing lifecycle
// ---------------------------------------------------------------------------

export function startRouteDrawing() {
  if (isDrawingRoute) return;       // already drawing — ignore repeat clicks
  if (isDeleteMode) exitDeleteMode(); // drawing and delete mode are exclusive
  isDrawingRoute = true;
  session++;
  verts = [];
  legs = [];
  previewLeg = null;
  previewMemo = new Map();
  queue = Promise.resolve();
  currentPointType = "route";

  // Area regions know their graph up front: start loading it now. For a
  // full-state region the first click decides (smallest area containing it).
  const active = getActiveRegion();
  ctx = active?.type === "area" ? makeContext({ region: active, info: graphInfoForRegion(active) }) : null;

  setActiveToolBtn("addRouteBtn");
  document.getElementById("planningToolbar")?.classList.add("active");
  alignPlanningToolbar();
  showPointTypeSelector();
  setActivePointType("route");
  showRouteModal();
  map.doubleClickZoom.disable();
  // Box zoom swallows shift+mousedown, which would eat the shift-click
  // "straight leg" gesture, so disable it while drawing.
  map.boxZoom.disable();
  map.getCanvas().style.cursor = "crosshair";
  updateRouteDrawing();
  updatePreviewSource();
  updateDrawingHint();

  _routeMouseMoveHandler = handleMouseMoveForRoute;
  map.on("mousemove", _routeMouseMoveHandler);
  map.on("zoomend", updateDrawingHint);

  _routeKeyHandler = handleRouteKeyDown;
  document.addEventListener("keydown", _routeKeyHandler);
}

/** Run drawing work in click order, dropping it if drawing was reset meanwhile. */
function enqueue(fn) {
  const s = session;
  queue = queue.then(() => (s === session && isDrawingRoute ? fn() : undefined))
    .catch((err) => console.error("[routing]", err));
  return queue;
}

export function handleMapClickForRoute(e) {
  if (!isDrawingRoute) return;
  // A click on a gap pin explains that leg instead of placing a point.
  const pinLeg = gapLegAt(e.point);
  if (pinLeg) { showGapCard(pinLeg); return; }
  const lngLat = [e.lngLat.lng, e.lngLat.lat];
  const shift = e.originalEvent.shiftKey;
  const zoom = map.getZoom();
  const type = currentPointType;
  enqueue(() => addVertex(lngLat, { shift, zoom, type }));
}

async function addVertex(lngLat, { shift, zoom, type }) {
  await ensureContext(lngLat);
  const snap = shift ? null : snapPoint(lngLat, zoom);
  const v = { coord: snap ? [snap.lon, snap.lat] : lngLat, snapped: !!snap, type, snap };

  // The two clicks of a finishing double-click land on the same spot: keep one.
  const last = verts[verts.length - 1];
  if (last && last.type === type && haversine(...last.coord, ...v.coord) < 1) return;

  verts.push(v);
  const i = verts.length - 1;
  if (i >= 1) {
    const from = lastMainIndex(i - 1);
    legs[i] = computeLeg(from, i, verts[from], v, { shift });
    // Say why once, without covering the map where the user keeps clicking.
    if (legs[i].reason === "no_path") flashDrawingHint("These trails don\u2019t connect in OpenStreetMap. Click the rust pin to fix it.");
  }
  previewLeg = null;
  previewMemo.clear();
  updateRouteDrawing();
  updatePreviewSource();
  notifyDrawingProgress();
}

function undoLastVertex() {
  if (!verts.length) return;
  verts.pop();
  legs.length = verts.length;
  previewLeg = null;
  previewMemo.clear();
  gapPopup?.remove();
  updateRouteDrawing();
  schedulePreview();
  notifyDrawingProgress();
}

export function handleMapDblClickForRoute(e) {
  if (!isDrawingRoute) return;
  e.preventDefault();
  enqueue(() => finishRouteDrawing());
}

function finishRouteDrawing() {
  const mainLegs = legs.filter((l) => l && l.kind === "main");
  if (verts.length < 2 || !mainLegs.length) {
    resetRouteDrawing();
    cancelDrawing();
    return;
  }

  // 1. Main route: legs concatenated at graph precision (6 dp), duplicate
  //    joints removed, with per-leg provenance (schema 1.1 `segments`).
  const geometryCoords = [];
  const segments = [];
  for (const leg of mainLegs) {
    const pts = leg.coords.map(round6);
    let start = geometryCoords.length - 1;
    if (start < 0 || !samePos(geometryCoords[start], pts[0])) {
      start = geometryCoords.length;
      geometryCoords.push(pts[0]);
    }
    for (let k = 1; k < pts.length; k++) geometryCoords.push(pts[k]);
    segments.push(segmentRecord(leg, [start, geometryCoords.length - 1]));
  }
  if (geometryCoords.length < 2) geometryCoords.push([...geometryCoords[0]]);
  const routing = routingInfo();

  const spurLegs = legs.filter((l) => l && l.kind === "spur");
  const properties = {
    type: "route",
    name: "",
    planned: true,
    notes: "",
    vertex_types: verts.map((v) => v.type),
    vertex_snapped: verts.map((v) => v.snapped),
    vertex_coords: verts.map((v) => round6(v.coord)),
    main_route_distance_mi: lineLength(geometryCoords) / MI,
    dayhike_distance_mi: spurLegs.reduce((s, l) => s + (2 * lineLength(l.coords.map(round6))) / MI, 0),
    segments,
  };
  if (routing) properties.routing = routing;
  const geometry = { type: "LineString", coordinates: geometryCoords };
  const routeIdx = TripManager.addFeature(geometry, properties);

  // Remember computed gap pins so the saved route shows them in the same place.
  const routeFeature = TripManager.currentTrip?.features[routeIdx];
  if (routeFeature) {
    mainLegs.forEach((leg, k) => leg.gap && gapMemo.set(`${routeFeature.properties._id}:${k}`, leg.gap));
    fetchElevationProfile(geometryCoords, routeFeature.properties._id);
  }

  // 2. Day-hike spurs: one direction, branch point → spur end.
  for (const leg of spurLegs) {
    const coords = leg.coords.map(round6);
    const props = {
      type: "dayhike_spur",
      route_index: routeIdx,
      name: "",
      segments: [segmentRecord(leg, [0, coords.length - 1])],
    };
    if (routing) props.routing = routing;
    const idx = TripManager.addFeature({ type: "LineString", coordinates: coords }, props);
    if (leg.gap) gapMemo.set(`${TripManager.currentTrip.features[idx].properties._id}:0`, leg.gap);
  }

  // 3. Point features for special points (camp/dayhike/rest)
  const tripDates = getTripDateRange();
  let dateIndex = 0;
  verts.forEach((v, i) => {
    if (v.type === "route") return;
    const pointProps = {
      type: v.type,
      point_type: v.type,
      route_index: routeIdx,
      route_vertex_index: i,
      date: tripDates[dateIndex] || "",
      name: "",
      notes: "",
    };
    if (v.type === "camp") {
      pointProps.water_nearby = false;
      pointProps.water_notes = "";
      dateIndex++; // camp advances to next day
    } else if (v.type === "rest") {
      dateIndex++; // rest day consumes a day
    }
    // dayhike does NOT advance the date (same-day activity)
    TripManager.addFeature({ type: "Point", coordinates: round6(v.coord) }, pointProps);
  });

  TripManager.render(); // picks up the gap pins memoized above
  resetRouteDrawing();
  cancelDrawing();
}

const round6 = (c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];
const samePos = (a, b) => a[0] === b[0] && a[1] === b[1];

/** schema 1.1 routingSegment for a leg. */
function segmentRecord(leg, coordRange) {
  const seg = {
    mode: leg.mode,
    from_vertex: leg.from,
    to_vertex: leg.to,
    coord_range: coordRange,
    length_m: Math.round(leg.length_m * 10) / 10,
  };
  if (leg.mode === "straight") seg.reason = leg.reason;
  if (leg.mode === "trail") seg.osm_way_ids = leg.wayIds;
  return seg;
}

/** schema 1.1 routingInfo for the route's graph, or null when none was used. */
function routingInfo() {
  const g = ctx?.graph;
  if (!g) return null;
  const info = { engine: "booot-graph", graph: `${g.state || ctx.region?.state || ""}/${g.region || ctx.region?.id || ""}` };
  if (g.version) info.graph_version = g.version;
  if (g.osmTimestamp) info.osm_timestamp = g.osmTimestamp;
  return info;
}

function resetRouteDrawing() {
  isDrawingRoute = false;
  session++;
  verts = [];
  legs = [];
  ctx = null;
  previewLeg = null;
  pendingMove = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  currentPointType = "route";
  map.doubleClickZoom.enable();
  map.boxZoom.enable();
  map.getCanvas().style.cursor = "";
  updateRouteDrawing();
  updatePreviewSource();
  hideSnapTooltip();
  gapPopup?.remove();
  flashUntil = 0;
  clearTimeout(flashTimer);
  hideRouteModal();
  hidePointTypeSelector();
  updateDrawingPreview(null);

  if (_routeMouseMoveHandler) {
    map.off("mousemove", _routeMouseMoveHandler);
    _routeMouseMoveHandler = null;
  }
  map.off("zoomend", updateDrawingHint);
  if (_routeKeyHandler) {
    document.removeEventListener("keydown", _routeKeyHandler);
    _routeKeyHandler = null;
  }
}

// ---------------------------------------------------------------------------
// Live routed preview (one query per animation frame, §2.5)
// ---------------------------------------------------------------------------

function handleMouseMoveForRoute(e) {
  if (!isDrawingRoute) return;
  pendingMove = { lngLat: [e.lngLat.lng, e.lngLat.lat], shift: e.originalEvent.shiftKey, point: e.point };
  schedulePreview();
}

function schedulePreview() {
  if (!rafId && pendingMove && isDrawingRoute) rafId = requestAnimationFrame(runPreview);
}

function runPreview() {
  rafId = 0;
  if (!isDrawingRoute || !pendingMove) return;
  const t0 = performance.now();
  const { lngLat, shift, point } = pendingMove;
  const zoom = map.getZoom();
  const snap = shift ? null : snapPoint(lngLat, zoom);
  const cursor = { coord: snap ? [snap.lon, snap.lat] : lngLat, snapped: !!snap, type: currentPointType, snap };

  previewLeg = null;
  let routeMs = 0;
  if (verts.length) {
    const from = lastMainIndex(verts.length - 1);
    const A = verts[from];
    const key = snap && !shift ? `${from}|${snap.e}|${Math.round(snap.along / 5)}|${cursor.type === "dayhike"}` : null;
    if (key && previewMemo.has(key)) {
      previewLeg = previewMemo.get(key);
      previewStats.memoHits++;
    } else {
      const r0 = performance.now();
      const leg = computeLeg(from, verts.length, A, cursor, { shift, budgetMs: PREVIEW_BUDGET_MS, preview: true });
      routeMs = performance.now() - r0;
      if (leg.aborted) {
        // Too slow for a frame: preview straight; the click routes it properly.
        previewStats.aborted++;
        previewLeg = straightLeg(from, verts.length, A, cursor, cursor.type === "dayhike" ? "spur" : "main", "manual");
      } else {
        previewLeg = leg;
        if (key) {
          if (previewMemo.size > 500) previewMemo.clear();
          previewMemo.set(key, leg);
        }
      }
    }
  }
  updatePreviewSource(cursor);
  updateSnapTooltip(snap, point);

  const frameMs = performance.now() - t0;
  previewStats.frames++;
  pushStat(previewStats.routeMs, routeMs);
  pushStat(previewStats.frameMs, frameMs);
}

function pushStat(arr, v) { arr.push(v); if (arr.length > 2000) arr.shift(); }

/** Debug/verification handle (window.__outhere.routing). */
export const routingDebug = {
  stats: previewStats,
  resetStats() { previewStats.frames = 0; previewStats.routeMs.length = 0; previewStats.frameMs.length = 0; previewStats.aborted = 0; previewStats.memoHits = 0; },
  /** Milliseconds the current graph's post-load warm-up route took. */
  get warmUpMs() { return ctx?.graph?.warmUpMs ?? null; },
  /** Resolves once the current drawing's graph has loaded (or failed). */
  ready: () => (ctx?.promise || Promise.resolve()).then(() => ctx?.status || "none"),
  /** Resolves once queued clicks have been processed. */
  idle: () => queue,
};

// ---------------------------------------------------------------------------
// Map sources
// ---------------------------------------------------------------------------

function legFeature(leg, extra = {}) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: leg.coords },
    properties: { leg_mode: leg.mode, kind: leg.kind, ...extra },
  };
}

function gapFeature(leg, extra = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: leg.gap },
    properties: { gap: true, reason: leg.reason, ...extra },
  };
}

/** Placed legs, gap pins and vertices (changes per click, not per frame). */
function updateRouteDrawing() {
  const source = map.getSource("route-drawing");
  if (!source) return;
  const features = [];
  for (const leg of legs) if (leg) features.push(legFeature(leg));
  for (const leg of legs) if (leg?.gap) features.push(gapFeature(leg));
  verts.forEach((v, i) => features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: v.coord },
    properties: { vertex: true, snapped: v.snapped, point_type: v.type, index: i },
  }));
  source.setData({ type: "FeatureCollection", features });
}

/** Cursor marker + preview leg (changes per frame). */
function updatePreviewSource(cursor = null) {
  const source = map.getSource("route-preview");
  if (!source) return;
  const features = [];
  if (previewLeg) features.push(legFeature(previewLeg, { preview: true }));
  if (cursor) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: cursor.coord },
      properties: { cursor: true, snapped: cursor.snapped },
    });
  }
  source.setData({ type: "FeatureCollection", features });
}

// ---------------------------------------------------------------------------
// Saved routes: per-leg overlay for the trip source
// ---------------------------------------------------------------------------

const gapMemo = new Map(); // `${featureId}:${segmentIndex}` → [lon, lat]

/**
 * Extra features for the "trip" map source: each saved route/spur with
 * `segments` is split into `route_leg` lines (styled per mode) plus
 * `route_gap` pins on straight legs. Legacy routes (no segments) render
 * as before. Unknown modes (e.g. future "imported") render as trail.
 */
export function buildRoutingOverlay(trip) {
  const out = [];
  for (const f of trip?.features || []) {
    const p = f.properties || {};
    if ((p.type !== "route" && p.type !== "dayhike_spur") || !Array.isArray(p.segments) || f.geometry?.type !== "LineString") continue;
    const coords = f.geometry.coordinates;
    const kind = p.type === "route" ? "main" : "spur";
    p.segments.forEach((seg, k) => {
      const [s, e] = Array.isArray(seg.coord_range) ? seg.coord_range : [0, coords.length - 1];
      const legCoords = coords.slice(Math.max(0, s), Math.min(coords.length, e + 1));
      if (legCoords.length < 2) return;
      out.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: legCoords },
        properties: { type: "route_leg", _id: p._id, leg_mode: seg.mode, kind },
      });
      if (seg.mode === "straight") {
        const gap = savedGap(p, k, legCoords);
        out.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: gap },
          properties: { type: "route_gap", _id: p._id, reason: seg.reason || "no_path", length_m: seg.length_m ?? lineLength(legCoords) },
        });
      }
    });
  }
  return out;
}

function savedGap(props, k, legCoords) {
  const key = `${props._id}:${k}`;
  if (gapMemo.has(key)) return gapMemo.get(key);
  const A = legCoords[0], B = legCoords[legCoords.length - 1];
  let gap = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  // With the route's graph already decoded, place the pin like the drawing did.
  const regionId = (props.routing?.graph || "").split("/")[1];
  const g = props.segments[k].reason === "no_path" && regionId ? peekDecoded(regionId) : null;
  if (g) {
    const sa = g.snap(A[0], A[1], 15), sb = g.snap(B[0], B[1], 15);
    const p = g.gapFor(A, B, sa, sb);
    gap = [p.lon, p.lat];
    gapMemo.set(key, gap);
  }
  return gap;
}

const decoded = new Map(); // regionId → TrailGraph (filled as graphs load)
function peekDecoded(regionId) {
  if (decoded.has(regionId)) return decoded.get(regionId);
  const info = graphInfoForRegion(findRegionById(regionId));
  const p = peekGraph(info);
  p?.then((g) => decoded.set(regionId, g)).catch(() => {});
  return null;
}

// ---------------------------------------------------------------------------
// Gap card ("fix it in OpenStreetMap") and snap tooltip (§2.6)
// ---------------------------------------------------------------------------

const GAP_COPY = {
  no_path: "These trails don’t connect in OpenStreetMap.",
  no_graph: "Routing isn’t available here yet.",
  cross_region: "Routes can’t cross between map regions yet.",
};

const osmEditUrl = (lon, lat) => `https://www.openstreetmap.org/edit?editor=id#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`;

function formatMiles(m) {
  const mi = m / MI;
  return mi < 0.1 ? `${Math.round(m * 3.28084)} ft` : `${mi.toFixed(1)} mi`;
}

/** Open the explanation card for a straight leg at its gap pin. */
export function showGapCard({ gap, reason, length_m }) {
  if (!gap) return;
  gapPopup?.remove();
  const link = reason === "no_path"
    ? `<a class="gap-card__link" href="${escapeAttr(osmEditUrl(gap[0], gap[1]))}" target="_blank" rel="noopener">Fix it in OpenStreetMap</a>`
    : "";
  const html = `
    <div class="gap-card" role="note">
      <p class="gap-card__text">${escapeHTML(GAP_COPY[reason] || GAP_COPY.no_path)}</p>
      <p class="gap-card__meta">Drawn straight for <span class="gap-card__num">${escapeHTML(formatMiles(length_m || 0))}</span></p>
      ${link}
    </div>`;
  gapPopup = new maplibregl.Popup({ className: "gap-popup", closeButton: true, closeOnClick: true, maxWidth: "260px", offset: 10 })
    .setLngLat(gap)
    .setHTML(html)
    .addTo(map);
}

function updateSnapTooltip(snap, point) {
  const el = document.getElementById("snapTooltip");
  if (!el) return;
  if (!snap || !point) { hideSnapTooltip(); return; }
  const unnamedTrail = !snap.name && (snap.highway === "path" || snap.highway === "track");
  const text = snap.name || (unnamedTrail ? "Know this trail’s name? Add it in OpenStreetMap" : "");
  if (!text) { hideSnapTooltip(); return; }
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("snap-tooltip--unnamed", unnamedTrail);
  el.style.transform = `translate(${Math.round(point.x + 14)}px, ${Math.round(point.y + 14)}px)`;
  el.classList.add("visible");
}

function hideSnapTooltip() {
  document.getElementById("snapTooltip")?.classList.remove("visible");
}

/** Placed leg whose gap pin is within 10 px of a screen point, or null. */
function gapLegAt(point) {
  for (const leg of legs) {
    if (!leg?.gap) continue;
    const p = map.project(leg.gap);
    if (Math.hypot(p.x - point.x, p.y - point.y) <= 10) return leg;
  }
  return null;
}

let flashUntil = 0;
let flashTimer = 0;
/** A one-off message in the hint slot; the state hint returns after it. */
function flashDrawingHint(text, ms = 6000) {
  flashUntil = performance.now() + ms;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashUntil = 0; updateDrawingHint(); }, ms);
  showDrawingHint(text);
}

/** One-line state hint at the bottom of the map while drawing. */
function updateDrawingHint() {
  if (!isDrawingRoute) { hideDrawingHint(); return; }
  if (performance.now() < flashUntil) return;
  if (ctx?.status === "loading") return showDrawingHint("Loading trails for routing…", "loading");
  if (ctx && (ctx.status === "none" || ctx.status === "error")) {
    return showDrawingHint(ctx.status === "error"
      ? "Couldn’t load trails for routing. Legs are drawn straight."
      : "Routing isn’t available here yet. Legs are drawn straight.");
  }
  if (ctx?.graph && map.getZoom() < SNAP_MIN_ZOOM) return showDrawingHint("Zoom in to snap to trails");
  hideDrawingHint();
}

// ---------------------------------------------------------------------------
// Distance summary for the sidebar preview
// ---------------------------------------------------------------------------

function notifyDrawingProgress() {
  let main = 0, spur = 0, off = 0;
  for (const leg of legs) {
    if (!leg) continue;
    if (leg.kind === "main") main += leg.length_m; else spur += 2 * leg.length_m;
    if (leg.mode === "straight") off += leg.length_m;
  }
  updateDrawingPreview({
    vertexCount: verts.length,
    mainDistanceMi: main / MI,
    dayhikeDistanceMi: spur / MI,
    offTrailMi: off / MI,
    vertexTypes: verts.map((v) => v.type),
  });
}

// ---------------------------------------------------------------------------
// Cancel / shared UI
// ---------------------------------------------------------------------------

export function cancelDrawing() {
  if (isDrawingRoute) {
    resetRouteDrawing();
  }
  if (isDeleteMode) exitDeleteMode();
  setActiveToolBtn(null);
  hideDrawingHint();
  hideRouteModal();
  hidePointTypeSelector();
  document.getElementById("planningToolbar")?.classList.remove("active");
}

export function startDeleteMode() {
  if (isDrawingRoute) cancelDrawing();
  isDeleteMode = true;
  map.getCanvas().style.cursor = "crosshair";
  document.getElementById("planningToolbar")?.classList.add("active");
  alignPlanningToolbar();
  setActiveToolBtn("deleteWaypointBtn");
}

export function exitDeleteMode() {
  isDeleteMode = false;
  map.getCanvas().style.cursor = "";
  document.getElementById("planningToolbar")?.classList.remove("active");
  setActiveToolBtn(null);
}

export function handleDeleteClick(e) {
  if (!TripManager.currentTrip) return;
  const tripLayers = ["trip-camps", "trip-dayhikes", "trip-rest", "trip-waypoints"];
  const features = map.queryRenderedFeatures(e.point, { layers: tripLayers });
  if (!features.length) return;
  const clickedId = features[0].properties._id;
  const idx = TripManager.currentTrip.features.findIndex(
    f => f.properties._id === clickedId
  );
  if (idx !== -1) TripManager.removeFeature(idx);
}

function setActiveToolBtn(id) {
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.id === id);
  });
}

function showDrawingHint(text, variant = "") {
  const el = document.getElementById("drawingHint");
  if (el) {
    el.textContent = text;
    el.classList.toggle("drawing-hint--loading", variant === "loading");
    el.classList.add("visible");
  }
}

function hideDrawingHint() {
  const el = document.getElementById("drawingHint");
  if (el) el.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Route instruction modal
// ---------------------------------------------------------------------------

function showRouteModal() {
  const el = document.getElementById("routeInstructions");
  if (el) el.classList.add("visible");
}

function hideRouteModal() {
  const el = document.getElementById("routeInstructions");
  if (el) el.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Point type selector
// ---------------------------------------------------------------------------

function showPointTypeSelector() {
  const el = document.getElementById("pointTypeSelector");
  if (el) el.classList.add("visible");
}

function hidePointTypeSelector() {
  const el = document.getElementById("pointTypeSelector");
  if (el) el.classList.remove("visible");
}

function setActivePointType(pointType) {
  currentPointType = pointType;
  document.querySelectorAll(".point-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.pointType === pointType);
  });
}

export function initPointTypeSelector() {
  document.querySelectorAll(".point-type-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setActivePointType(btn.dataset.pointType);
    });
  });
}

// ---------------------------------------------------------------------------
// Keyboard: 1-4 switch point type, Backspace / Ctrl-Z / Cmd-Z undo
// (Esc cancel lives in trip-panel.js)
// ---------------------------------------------------------------------------

function handleRouteKeyDown(e) {
  if (!isDrawingRoute) return;

  // Ignore if user is typing in a form input
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;

  const isUndo = (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) ||
    ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z");
  if (isUndo) {
    e.preventDefault();
    enqueue(undoLastVertex);
    return;
  }

  const keyMap = { "1": "route", "2": "camp", "3": "dayhike", "4": "rest" };
  const pointType = keyMap[e.key];
  if (pointType) {
    e.preventDefault();
    setActivePointType(pointType);
    schedulePreview(); // dayhike previews a spur from the last main point
  }
}

// ---------------------------------------------------------------------------
// Elevation profile — Open-Meteo API
// ---------------------------------------------------------------------------

/**
 * Sample a line at even distance spacing (not by vertex index, which
 * under-samples switchbacks and over-samples straight legs).
 * @param {number[][]} coords - [lng, lat] pairs
 * @param {number} maxPoints - at most this many samples, endpoints included
 * @param {number} minSpacingM - don't sample more densely than this
 * @returns {number[][]}
 */
export function sampleByDistance(coords, maxPoints = 100, minSpacingM = 25) {
  if (coords.length < 2) return coords.slice();
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  }
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.min(maxPoints, Math.floor(total / minSpacingM) + 1));
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / span)) : 0;
    out.push([
      coords[j][0] + t * (coords[j + 1][0] - coords[j][0]),
      coords[j][1] + t * (coords[j + 1][1] - coords[j][1]),
    ]);
  }
  return out;
}

/**
 * Fetch elevation for a route's display coords from Open-Meteo, then patch
 * the feature in TripManager with elevation_profile (ft), elevation_gain_ft,
 * and elevation_loss_ft.
 *
 * @param {number[][]} coords - [lng, lat] display coords of the route
 * @param {string} featureId - the feature's _id property
 */
async function fetchElevationProfile(coords, featureId) {
  const sampled = sampleByDistance(coords, 100);
  const lats = sampled.map(c => c[1].toFixed(6)).join(",");
  const lons = sampled.map(c => c[0].toFixed(6)).join(",");

  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.elevation)) throw new Error("Unexpected response shape");

    // Convert meters → feet, round to nearest foot
    const profileFt = data.elevation.map(m => Math.round(m * 3.28084));

    // Compute cumulative gain and loss
    let gain = 0, loss = 0;
    for (let i = 1; i < profileFt.length; i++) {
      const diff = profileFt[i] - profileFt[i - 1];
      if (diff > 0) gain += diff;
      else loss += -diff;
    }

    // Patch the feature in place (no full render cycle needed for the map)
    const trip = TripManager.currentTrip;
    if (!trip) return;
    const feature = trip.features.find(f => f.properties._id === featureId);
    if (!feature) return;

    feature.properties.elevation_profile = profileFt;
    feature.properties.elevation_gain_ft = Math.round(gain);
    feature.properties.elevation_loss_ft = Math.round(loss);

    TripManager.render();
    TripManager.save();
  } catch (err) {
    console.warn("[elevation] fetch failed:", err.message);
  }
}

export function getTripDateRange() {
  if (!TripManager.currentTrip) return [];
  const meta = TripManager.currentTrip.properties;
  if (!meta.dates?.start || !meta.dates?.end) return [];

  const dates = [];
  const start = new Date(meta.dates.start + "T00:00:00");
  const end = new Date(meta.dates.end + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * GPX import, pure half: parse GPX text and build trip route features.
 * No app imports (only parseGPX touches the DOM, via DOMParser), so scripts
 * can reuse buildRouteFeature and the elevation helpers. The panel wiring is
 * in gpx-import.js. Nothing here sends data anywhere.
 *
 * An imported route follows the trip format (schema 1.1):
 *   segments: [{ mode: "imported", ... }]   one leg covering the geometry
 *   source:   { type: "gpx", name, recorded_at, recorded_end }
 * Geometry is lightly simplified (DP, 1.5 m; 2.5 m shaved up to 15% off a switchbacked climb) so a day-long recording stays a
 * sane size; timing is not stored per point. Elevation comes from the file's
 * own <ele> (imported GPX > our DEM > Open-Meteo): a profile sampled by
 * distance like the planner's (here at most 100 points) and gain/loss with a 3 m
 * hysteresis so GPS/barometer noise doesn't count as climbing.
 */

const MI = 1609.344;
const FT = 3.28084;
const R = 6371008.8;
const RAD = Math.PI / 180;

export const SIMPLIFY_TOLERANCE_M = 1.5;
export const HYSTERESIS_M = 3;
const MAX_PROFILE_POINTS = 100;
const MIN_SPACING_M = 25;

const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const round6 = (c) => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

export function cumulative(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav(coords[i - 1], coords[i]));
  return cum;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
const textOf = (el, name) => kids(el, name)[0]?.textContent?.trim() || "";

function readPoints(parent, tag) {
  const out = { coords: [], ele: [], times: [] };
  for (const pt of parent.getElementsByTagNameNS("*", tag)) {
    const lat = parseFloat(pt.getAttribute("lat")), lon = parseFloat(pt.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const ele = parseFloat(textOf(pt, "ele"));
    const t = Date.parse(textOf(pt, "time"));
    out.coords.push([lon, lat]);
    out.ele.push(Number.isFinite(ele) ? ele : null);
    out.times.push(Number.isFinite(t) ? t : null);
  }
  return out;
}

/**
 * Parse GPX text into tracks. One entry per <trk> (all its segments joined)
 * and one per <rte>. Throws on XML that isn't GPX.
 * @returns {{name:string, kind:"track"|"route", coords:number[][], ele:(number|null)[], times:(number|null)[]}[]}
 */
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length || doc.documentElement?.localName !== "gpx") {
    throw new Error("not a GPX file");
  }
  const out = [];
  for (const trk of doc.getElementsByTagNameNS("*", "trk")) {
    out.push({ name: textOf(trk, "name"), kind: "track", ...readPoints(trk, "trkpt") });
  }
  for (const rte of doc.getElementsByTagNameNS("*", "rte")) {
    out.push({ name: textOf(rte, "name"), kind: "route", ...readPoints(rte, "rtept") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry and elevation (pure)
// ---------------------------------------------------------------------------

/** Douglas-Peucker on a local flat projection. Returns the kept indices. */
export function simplifyIndices(coords, tolM = SIMPLIFY_TOLERANCE_M) {
  const n = coords.length;
  if (n <= 2) return coords.map((_, i) => i);
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / n;
  const kx = Math.cos(lat0 * RAD) * 111320, ky = 110574;
  const xy = coords.map((c) => [c[0] * kx, c[1] * ky]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = xy[a], dx = xy[b][0] - ax, dy = xy[b][1] - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wd = tolM;
    for (let i = a + 1; i < b; i++) {
      let d;
      if (!L2) d = Math.hypot(xy[i][0] - ax, xy[i][1] - ay);
      else {
        const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L2));
        d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
      }
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const idx = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

/**
 * Total gain and loss of an elevation series (any unit) counting only swings
 * of at least `h` from the last turning point.
 */
export function hysteresisGainLoss(series, h) {
  let gain = 0, loss = 0;
  if (series.length < 2) return { gain, loss };
  let dir = 0, ext = series[0], base = series[0];
  for (let i = 1; i < series.length; i++) {
    const e = series[i];
    if (dir >= 0 && e > ext) ext = e;
    else if (dir <= 0 && e < ext) ext = e;
    if (dir === 0) {
      if (e - base >= h) { dir = 1; ext = e; }
      else if (base - e >= h) { dir = -1; ext = e; }
    } else if (dir === 1 && ext - e >= h) { gain += ext - base; base = ext; dir = -1; ext = e; }
    else if (dir === -1 && e - ext >= h) { loss += base - ext; base = ext; dir = 1; ext = e; }
  }
  if (dir === 1) gain += ext - base;
  else if (dir === -1) loss += base - ext;
  return { gain, loss };
}

/** Fill gaps in an elevation series by linear interpolation. null if too few values. */
export function fillElevation(ele) {
  const have = ele.filter((v) => v != null).length;
  if (have < Math.max(2, ele.length * 0.5)) return null;
  const out = ele.slice();
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] == null) continue;
    for (let k = last + 1; k < i; k++) out[k] = last < 0 ? out[i] : out[last] + ((out[i] - out[last]) * (k - last)) / (i - last);
    last = i;
  }
  for (let k = last + 1; k < out.length; k++) out[k] = out[last];
  return out;
}

/** Elevation at `count` points evenly spaced by distance along the track (same spacing rule as the planner). */
export function sampleElevation(coords, ele, maxPoints = MAX_PROFILE_POINTS, minSpacingM = MIN_SPACING_M) {
  const cum = cumulative(coords), total = cum.at(-1);
  const n = Math.max(2, Math.min(maxPoints, Math.floor(total / minSpacingM) + 1));
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / span)) : 0;
    out.push(ele[j] + t * (ele[j + 1] - ele[j]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building route features
// ---------------------------------------------------------------------------

/** YYYY-MM-DD in the viewer's local time zone. */
export function localDateISO(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const monthDay = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * One parsed track -> { geometry, properties } for a `route` feature, or null
 * when it has fewer than two usable points.
 * @param {object} track entry from parseGPX
 * @param {string} [fileName] original file name (fallback for source.name)
 */
export function buildRouteFeature(track, fileName = "") {
  if (track.coords.length < 2) return null;
  const keep = simplifyIndices(track.coords);
  const coords = keep.map((i) => round6(track.coords[i]));
  if (coords.length < 2) return null;
  const lengthM = cumulative(coords).at(-1);
  const miles = lengthM / MI;

  const times = track.times.filter((t) => t != null);
  const start = times.length ? times.reduce((a, b) => Math.min(a, b)) : null;
  const end = times.length ? times.reduce((a, b) => Math.max(a, b)) : null;

  const props = {
    type: "route",
    name: "", // set by the caller (needs the rest of the batch to pick a label)
    planned: false, // a recording, not a plan
    notes: "",
    vertex_types: ["route", "route"],
    vertex_snapped: [false, false],
    vertex_coords: [coords[0], coords.at(-1)],
    main_route_distance_mi: Math.round(miles * 100) / 100,
    dayhike_distance_mi: 0,
    segments: [{ mode: "imported", from_vertex: 0, to_vertex: 1, coord_range: [0, coords.length - 1], length_m: Math.round(lengthM * 10) / 10 }],
    source: { type: "gpx", name: track.name || fileName.replace(/\.gpx$/i, "") },
  };
  if (start != null) {
    props.source.recorded_at = new Date(start).toISOString();
    props.source.recorded_end = new Date(end).toISOString();
  }

  // Recorded elevation: profile from the full-resolution track, gain/loss with hysteresis.
  const ele = fillElevation(track.ele);
  if (ele) {
    const { gain, loss } = hysteresisGainLoss(ele, HYSTERESIS_M);
    props.elevation_profile = sampleElevation(track.coords, ele).map((m) => Math.round(m * FT));
    props.elevation_gain_ft = Math.round(gain * FT);
    props.elevation_loss_ft = Math.round(loss * FT);
  }
  return { geometry: { type: "LineString", coordinates: coords }, properties: props, startMs: start };
}

/** "May 3 · 1.4 mi", or the GPX name when it is distinctive. */
export function routeLabel(f, usedNames) {
  const p = f.properties, nm = p.source.name;
  const generic = /\b(county|activity|track|route)\b/i.test(nm) || /^\d/.test(nm);
  if (nm && !generic && !usedNames.has(nm.toLowerCase())) { usedNames.add(nm.toLowerCase()); return nm; }
  const mi = `${p.main_route_distance_mi.toFixed(1)} mi`;
  return f.startMs != null ? `${monthDay(f.startMs)} · ${mi}` : mi;
}

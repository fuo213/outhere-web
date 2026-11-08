/**
 * Auto route names, shared by the planner (planning.js, runs from A*) and GPX
 * import (gpx-match.js, runs from map-matching a recording). Pure: no DOM, no
 * app imports. A "run" is { name, highway, m }: consecutive graph edges with
 * the same OSM name/highway, with the meters travelled on them.
 */

export const ROAD_HIGHWAYS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "living_street"]);
const MAX_NAME = 40;
export const PLACE_WORDS = /\b(Landing|Arch|Overlook|Spring|Springs|Point|Peak|Lake|Falls|Pass|Summit|Rim|Narrows|Bridge|Canyon|Drops)\b/i;
const GENERIC_TAIL = /\s+(Trail|Route|Path|Trailhead)$/i;

/**
 * Name for a route from the OSM names of the trail it follows, weighted by
 * length. Longest named trail; "A to B" when two names cover most of it, in
 * the order they're walked; "via X" when it's mostly road. "" when nothing
 * useful is named (the panel's fallbacks then apply). Pure.
 * @param {Array} runs name runs in walking order ({name, highway, m}), as
 *   returned by TrailGraph.route() or built by gpx-match.js
 */
export function deriveNameFromRuns(runs) {
  const total = runs.reduce((s, r) => s + r.m, 0);
  if (!(total > 0)) return "";
  const sum = (isRoad) => {
    const m = new Map(); // name → { m, first }
    runs.forEach((r, i) => {
      if (!r.name || ROAD_HIGHWAYS.has(r.highway) !== isRoad) return;
      const e = m.get(r.name) || { name: r.name, m: 0, first: i };
      e.m += r.m;
      m.set(r.name, e);
    });
    return [...m.values()].sort((a, b) => b.m - a.m);
  };
  const roadM = runs.filter((r) => ROAD_HIGHWAYS.has(r.highway)).reduce((s, r) => s + r.m, 0);
  const trails = sum(false);
  if (roadM > total / 2) {
    const road = sum(true)[0];
    return road && road.m >= total * 0.25 ? clip(`via ${road.name}`) : "";
  }
  const [a, b] = trails;
  if (!a || a.m < total * 0.2) return "";
  // Name it for where it goes: a different named trail at the very end.
  const dest = [...runs].reverse().find((r) => r.name && !ROAD_HIGHWAYS.has(r.highway));
  // How far the route stays on that trail at the end (unnamed bits in between
  // don't break it; a different name does). A trail it only crossed earlier
  // doesn't count.
  let destM = 0;
  if (dest) {
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i];
      if (r.name === dest.name && r.highway === dest.highway) destM += r.m;
      else if (r.name) break;
      else if (r.m > 100) break;
    }
  }
  if (dest && dest.name !== a.name && (destM >= 161 || destM >= total * 0.05)) {
    const place = PLACE_WORDS.test(dest.name);
    const full = `${a.name} to ${dest.name}`;
    const placeShort = place ? `${a.name} to ${dest.name.replace(GENERIC_TAIL, "")}` : full;
    if (placeShort.length <= MAX_NAME) return placeShort;
    const trimmed = `${a.name.replace(GENERIC_TAIL, "")} to ${dest.name.replace(GENERIC_TAIL, "")}`;
    if (trimmed.length <= MAX_NAME) return trimmed;
  }
  if (b && a.m >= total * 0.25 && b.m >= total * 0.25 && a.m + b.m >= total * 0.7) {
    const [x, y] = a.first < b.first ? [a, b] : [b, a];
    let name = `${x.name} to ${y.name}`;
    if (name.length > MAX_NAME) name = `${x.name.replace(GENERIC_TAIL, "")} to ${y.name.replace(GENERIC_TAIL, "")}`;
    if (name.length <= MAX_NAME) return name;
  }
  return clip(a.name);
}

function clip(name) {
  if (name.length <= MAX_NAME) return name;
  const cut = name.slice(0, MAX_NAME - 1).replace(/\s+\S*$/, "");
  return `${cut || name.slice(0, MAX_NAME - 1)}…`;
}

const stripTail = (n) => n.replace(GENERIC_TAIL, "");

/**
 * Name for an imported recording. Same rules as deriveNameFromRuns, except a
 * loop (start and end within ~150 m) can't be named "A to B" (it ends where it
 * began): it is named for the place it reaches ("Out to Maze Overlook" when the
 * farthest point lies on a place-like trail other than the dominant one) or for its dominant trail
 * ("West Rim Trail loop"). Pure.
 * @param {Array} runs name runs in walking order
 * @param {{loop?: boolean, farthest?: {name, highway}|null}} [opts]
 */
export function deriveImportedName(runs, { loop = false, farthest = null } = {}) {
  if (!loop) return deriveNameFromRuns(runs);
  const total = runs.reduce((s, r) => s + r.m, 0);
  const byName = new Map();
  for (const r of runs) {
    if (!r.name || ROAD_HIGHWAYS.has(r.highway)) continue;
    byName.set(r.name, (byName.get(r.name) || 0) + r.m);
  }
  const far = farthest && farthest.name && !ROAD_HIGHWAYS.has(farthest.highway) ? farthest.name : "";
  const [dom, domM] = [...byName.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (far && far !== dom && PLACE_WORDS.test(far)) return clip(`Out to ${stripTail(far)}`);
  if (!dom || domM < total * 0.2) return "";
  const loopName = `${dom} loop`;
  if (loopName.length <= MAX_NAME) return loopName;
  const short = `${stripTail(dom)} loop`;
  return short.length <= MAX_NAME ? short : clip(dom);
}

/**
 * True for names the importer made up or the device gave: "May 3 · 1.3 mi",
 * "1.3 mi", "Wayne County Hiking", "Garmin Connect Activity", a bare date. Only
 * these get replaced by a matched trail name; a distinctive GPX name stays.
 */
export function isGenericRouteName(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (/^([A-Z][a-z]{2} \d{1,2} · )?[\d.]+ mi$/.test(n)) return true;
  return /\b(county|activity|track|route)\b/i.test(n) || /^\d/.test(n);
}

/**
 * Place search: pure logic over the pipeline's `booot-place-index` v1
 * (see ../outhere/PLACES_AND_SEARCH.md). No DOM, no fetch of its own beyond
 * `loadPlaceIndex`, so it runs under node (design/tools/test-place-search.mjs).
 *
 * Index shape (compact JSON):
 *   { format, v, region, state, bbox, osm_timestamp, scale, kinds[], areas[],
 *     entries: [[name, kindIdx, lonE5, latE5, areaIdx, extra?], ...] }
 * `extra` is "" or "ele=2123" (metres) / "km=4.3".
 *
 * Every name is untrusted OSM text. This module returns plain strings and
 * ranges; the UI must only ever set them with textContent.
 */

export const INDEX_FORMAT = "booot-place-index";
export const INDEX_VERSION = 1;

/** Display label per kind (sentence case, what a hiker would call it). */
export const KIND_LABELS = {
  park: "Park",
  district: "Park section",
  protected: "Protected area",
  town: "Town",
  landform: "Landform",
  locality: "Place",
  peak: "Peak",
  trailhead: "Trailhead",
  camp: "Camp",
  viewpoint: "Viewpoint",
  water: "Water",
  feature: "Feature",
  trail: "Trail",
  stream: "Waterway",
  lake: "Lake",
};

/** Lower number ranks higher when two results match equally well. */
const KIND_PRIORITY = Object.fromEntries(
  ["park", "district", "protected", "town", "landform", "locality", "peak",
    "trailhead", "viewpoint", "camp", "water", "feature", "trail", "stream", "lake"]
    .map((k, i) => [k, i]),
);

const M_TO_FT = 3.28084;
const KM_TO_MI = 0.621371;

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

/**
 * Case- and diacritic-insensitive form of `text` for matching, plus a map
 * from each normalised character back to its index in `text` (so the UI can
 * highlight the original string). Everything that is not a letter or digit
 * becomes one space; runs of them collapse; ends are trimmed.
 * @returns {{ norm: string, map: number[] }}
 */
export function normalizeWithMap(text) {
  const src = String(text ?? "");
  let norm = "";
  const map = [];
  let pendingSpace = false;
  let i = 0;
  for (const ch of src) {
    const folded = ch.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    for (const c of folded) {
      if (/[\p{L}\p{N}]/u.test(c)) {
        if (pendingSpace && norm) { norm += " "; map.push(i); }
        pendingSpace = false;
        norm += c;
        map.push(i);
      } else {
        pendingSpace = true;
      }
    }
    if (!folded) pendingSpace = true;
    i += ch.length;
  }
  return { norm, map };
}

/** Normalised form only. */
export function normalize(text) {
  return normalizeWithMap(text).norm;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode an index document into searchable records, or null when it is not a
 * v1 place index (unknown formats degrade to "no search", never to a crash).
 * Readers ignore unknown top-level keys and extra array items.
 */
export function decodeIndex(doc, { regionId = "", regionName = "" } = {}) {
  if (!doc || doc.format !== INDEX_FORMAT || doc.v !== INDEX_VERSION) return null;
  if (!Array.isArray(doc.entries) || !Array.isArray(doc.kinds)) return null;
  const scale = Number(doc.scale) || 100000;
  const areas = Array.isArray(doc.areas) ? doc.areas : [];
  const out = [];
  for (const row of doc.entries) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    const kind = doc.kinds[row[1]];
    const lon = Number(row[2]) / scale;
    const lat = Number(row[3]) / scale;
    if (!kind || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const a = row[4];
    const entry = {
      name: row[0],
      norm: normalize(row[0]),
      kind,
      lon,
      lat,
      area: a >= 0 && typeof areas[a] === "string" ? areas[a] : "",
      regionId,
      regionName,
    };
    const extra = typeof row[5] === "string" ? row[5] : "";
    for (const kv of extra.split(";")) {
      const [k, v] = kv.split("=");
      const num = Number(v);
      if (k === "ele" && Number.isFinite(num)) entry.ele_m = num;
      if (k === "km" && Number.isFinite(num)) entry.km = num;
    }
    if (entry.norm) out.push(entry);
  }
  return out;
}

/**
 * Combine decoded records of several regions (a full-state map searches the
 * state's regions together). Overlapping regions (Maze and Needles) repeat
 * entries: same name + kind within ~100 m is one result.
 */
export function mergeEntries(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const e of list || []) {
      const key = `${e.norm}|${e.kind}|${Math.round(e.lon * 1000)}|${Math.round(e.lat * 1000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/** Tier of a match: 0 exact, 1 prefix, 2 every word starts a word, 3 substring; -1 none. */
function tierOf(norm, query, tokens) {
  if (norm === query) return 0;
  if (norm.startsWith(query)) return 1;
  // "narrows" finds "The Narrows": a leading article does not count.
  if (norm.startsWith("the ") && norm.startsWith(query, 4)) return 1;
  const words = norm.split(" ");
  const wordStart = (t) => words.some((w) => w.startsWith(t));
  if (tokens.every(wordStart)) return 2;
  if (tokens.every((t) => norm.includes(t))) return 3;
  return -1;
}

/**
 * Search records. Ranking: exact > prefix > word-start > substring, then
 * park-like kinds before trails and creeks, then shorter names, then A-Z.
 * @param {Array} entries decoded records
 * @param {string} rawQuery what the user typed
 * @param {{limit?: number}} opts
 * @returns {Array} matching records (same objects), best first
 */
export function search(entries, rawQuery, { limit = 8 } = {}) {
  const query = normalize(rawQuery);
  if (!query) return [];
  const tokens = query.split(" ");
  const hits = [];
  for (const e of entries) {
    const tier = tierOf(e.norm, query, tokens);
    if (tier >= 0) hits.push({ e, tier });
  }
  hits.sort((a, b) =>
    a.tier - b.tier
    || (KIND_PRIORITY[a.e.kind] ?? 99) - (KIND_PRIORITY[b.e.kind] ?? 99)
    || a.e.norm.length - b.e.norm.length
    || a.e.norm.localeCompare(b.e.norm)
    || a.e.lat - b.e.lat);
  return hits.slice(0, limit).map((h) => h.e);
}

/**
 * [start, end) ranges of `name` (original string) to emphasise for `rawQuery`:
 * the whole-query prefix when the name starts with it, else each query word at
 * a word start (falling back to a substring).
 */
export function highlightRanges(name, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return [];
  const { norm, map } = normalizeWithMap(name);
  const toRange = (s, len) => {
    const start = map[s];
    const last = map[s + len - 1];
    const end = last + (String.fromCodePoint(name.codePointAt(last)).length);
    return [start, end];
  };
  let at = norm.startsWith(query) ? 0 : norm.startsWith("the ") && norm.startsWith(query, 4) ? 4 : -1;
  if (at >= 0) return [toRange(at, query.length)];
  const ranges = [];
  for (const t of query.split(" ")) {
    let idx = -1;
    for (let p = norm.indexOf(t); p >= 0; p = norm.indexOf(t, p + 1)) {
      if (p === 0 || norm[p - 1] === " ") { idx = p; break; }
      if (idx < 0) idx = p;
    }
    if (idx >= 0) ranges.push(toRange(idx, t.length));
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Presentation helpers (strings only)
// ---------------------------------------------------------------------------

/** Parts of the second line of a result: kind, a number, where it is. */
export function describeEntry(e, { fallbackPlace = "" } = {}) {
  const parts = [KIND_LABELS[e.kind] || "Place"];
  if (e.ele_m != null) parts.push(`${Math.round(e.ele_m * M_TO_FT).toLocaleString("en-US")} ft`);
  if (e.km != null && e.km > 0) parts.push(`${(e.km * KM_TO_MI).toFixed(1)} mi`);
  const where = e.area || fallbackPlace;
  return { kind: parts[0], numbers: parts.slice(1), where };
}

/** Plain-text label for aria / title. */
export function describeText(e, opts) {
  const d = describeEntry(e, opts);
  return [e.name, d.kind, ...d.numbers, d.where].filter(Boolean).join(", ");
}

/** Zoom to fly to for a result: big things wide, points close. */
export function zoomFor(e) {
  switch (e.kind) {
    case "park": return 10;
    case "district": return 11;
    case "protected": return 10.5;
    case "landform": return 12;
    case "town": return 12.5;
    case "locality": return 13;
    case "trail":
    case "stream":
      if (e.km >= 15) return 11;
      if (e.km >= 6) return 12;
      if (e.km >= 2) return 13;
      return 14;
    default: return 14;
  }
}

// ---------------------------------------------------------------------------
// Which indexes to load
// ---------------------------------------------------------------------------

/** Localhost-only `?places=zion:dev-places/zion.place-index.json,...`. */
export function parseDevPlaces(search, base, hostname) {
  const out = new Map();
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return out;
  const spec = new URLSearchParams(search).get("places");
  for (const part of (spec || "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const id = part.slice(0, i);
    const path = part.slice(i + 1);
    if (!path) continue;
    try {
      const url = new URL(path, base).href;
      out.set(id, { url, version: `dev-${id}`, format: "booot-place-index/1" });
    } catch { /* ignore a bad spec */ }
  }
  return out;
}

/**
 * The index blocks to search for the active region. An area region uses its
 * own `place_index`; a full-state region uses every area region of the same
 * state that has one (they are small). `dev` (Map id -> info) wins over the
 * catalog. Returns [{ regionId, regionName, info }], possibly empty.
 */
export function indexesForRegion(active, regions, dev = new Map()) {
  if (!active) return [];
  const infoOf = (r) => {
    const i = dev.get(r.id) || r.place_index;
    return i && typeof i.url === "string" ? i : null;
  };
  const pick = (r) => {
    const info = infoOf(r);
    return info ? [{ regionId: r.id, regionName: r.name || r.id, info }] : [];
  };
  if (active.type === "area") return pick(active);
  return (regions || [])
    .filter((r) => r.type === "area" && r.state === active.state && r.available !== false)
    .flatMap(pick);
}

/** Fetch + decode one index. Returns null on any failure (search degrades quietly). */
export async function loadPlaceIndex(entry, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(entry.info.url); // no Range header: the edge compresses full GETs
    if (!res.ok) return null;
    const list = decodeIndex(await res.json(), { regionId: entry.regionId, regionName: entry.regionName });
    return list;
  } catch {
    return null;
  }
}

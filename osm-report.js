/**
 * "Fix the map": report a problem to OpenStreetMap as an OSM Note.
 *
 * Pure (no DOM, no globals; fetch and storage are passed in), so it runs under
 * node for tests. report-ui.js is the dialog on top of it.
 *
 * Notes API: https://wiki.openstreetmap.org/wiki/API_v0.6#Map_Notes_API
 *  - POST {api}/api/0.6/notes.json  body {lat, lon, text}; anonymous is allowed
 *    (an authenticated request attaches the user; see `authHeaders` below).
 *  - GET  {api}/api/0.6/notes.json?bbox=l,b,r,t&closed=0&limit=N
 *  - CORS: the API answers `access-control-allow-origin: *` (also on the
 *    sandbox), so a browser can call it directly. No server of ours.
 *  - Never post tests to production: see config.js OSM_API_BASE and
 *    resolveOsmApiBase() for the dev-only sandbox switch.
 */

export const PRODUCTION_API = "https://api.openstreetmap.org";
export const SANDBOX_API = "https://master.apis.dev.openstreetmap.org";
export const SITE = "https://www.openstreetmap.org";

export const BOOOT_URL = "https://booot.org";
export const SIGNATURE = `Sent from Booot (${BOOOT_URL}), an offline hiking map built on OpenStreetMap.`;

/** Radius (m) for "is there already a note here" and "was this spot reported". */
export const NEARBY_RADIUS_M = 75;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Hosts where the dev-only sandbox switch is honoured: localhost and Pages previews, never production. */
export function isDevHost(hostname) {
  return LOCAL_HOSTS.includes(hostname) || (hostname.endsWith(".outhere-web.pages.dev") && hostname !== "outhere-web.pages.dev");
}

/**
 * API base for notes: production unless `?osmapi=sandbox` AND the page is on
 * localhost or a Pages preview. Anything else falls back to production.
 */
export function resolveOsmApiBase(hostname, search) {
  try {
    if (isDevHost(hostname) && new URLSearchParams(search || "").get("osmapi") === "sandbox") return SANDBOX_API;
  } catch { /* not a browser */ }
  return PRODUCTION_API;
}

/** The website for an API base (production → www.openstreetmap.org, sandbox → itself). */
export const siteFor = (apiBase) => (apiBase === PRODUCTION_API ? SITE : apiBase);

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const fix6 = (n) => Number(n).toFixed(6);

/**
 * iD at openstreetmap.org, centred on the spot. On the OSM website the
 * documented way to select an object is the `way` query parameter
 * (iD API.md, "iD on openstreetmap.org": `/edit?editor=id&way=123`); the
 * `#id=` hash form is documented only for standalone iD. `#map=zoom/lat/lon`
 * is the documented hash form for the position.
 */
export function osmEditUrl({ lat, lon, wayId = null, zoom = 19 }) {
  const way = wayId != null && /^\d+$/.test(String(wayId)) ? `&way=${wayId}` : "";
  return `${SITE}/edit?editor=id${way}#map=${zoom}/${fix6(lat)}/${fix6(lon)}`;
}

export const noteWebUrl = (apiBase, id) => `${siteFor(apiBase)}/note/${Number(id)}`;
export const wayWebUrl = (id) => `${SITE}/way/${Number(id)}`;

// ---------------------------------------------------------------------------
// Note text
// ---------------------------------------------------------------------------

const HIGHWAY_WORDS = {
  path: "path", footway: "footway", track: "track", bridleway: "bridleway", steps: "steps", cycleway: "cycleway",
  service: "service road", residential: "residential road", unclassified: "road", tertiary: "road", secondary: "road", primary: "road",
};

function describeWay(w) {
  const kind = HIGHWAY_WORDS[w.highway] || "way";
  const name = w.name ? `"${w.name}"` : `unnamed ${kind}`;
  const id = w.osmId != null ? ` (${wayWebUrl(w.osmId)})` : "";
  return `${name}${id}`;
}

function fmtMeters(m) {
  if (!Number.isFinite(m)) return "";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Pre-filled text for a trail gap found while route planning. The user edits it
 * before it is sent. Ends with the Booot signature line.
 * @param {{ways?: Array<{osmId, name, highway}>, gapM?: number, legM?: number}} g
 */
export function gapNoteText({ ways = [], gapM = NaN, legM = NaN } = {}) {
  const lines = [];
  const known = ways.filter((w) => w && (w.osmId != null || w.name));
  if (known.length >= 2) {
    lines.push("These two trails look like they should connect, but they don't in OpenStreetMap, so a route can't get from one to the other:");
    lines.push("");
    known.slice(0, 2).forEach((w, i) => lines.push(`${i + 1}. ${describeWay(w)}`));
  } else if (known.length === 1) {
    lines.push(`This trail ends without connecting to the trail next to it: ${describeWay(known[0])}`);
  } else {
    lines.push("Two trails near here look like they should connect, but they don't in OpenStreetMap, so a route can't get from one to the other.");
  }
  lines.push("");
  const facts = [];
  if (Number.isFinite(gapM) && gapM > 0) facts.push(`Gap between the ends: about ${fmtMeters(gapM)}.`);
  if (Number.isFinite(legM) && legM > 0) facts.push(`The route planner had to draw a straight ${fmtMeters(legM)} line across.`);
  facts.push("Found while planning a hiking route.");
  lines.push(facts.join(" "));
  lines.push("");
  lines.push(SIGNATURE);
  return lines.join("\n");
}

export const PROBLEM_KINDS = [
  { id: "name", label: "Wrong or missing trail name", lead: "The name of the trail here is wrong or missing." },
  { id: "missing", label: "A trail is missing", lead: "There is a trail here that is not on the map." },
  { id: "wrong", label: "A trail is wrong or gone", lead: "A trail on the map here looks wrong (wrong path, closed or no longer there)." },
  { id: "other", label: "Something else", lead: "Something here looks wrong on the map." },
];

/**
 * Pre-filled text for a general problem at a spot.
 * @param {{kind?: string, nearby?: {osmId?, name?, highway?} | null}} p
 */
export function problemNoteText({ kind = "other", nearby = null } = {}) {
  const k = PROBLEM_KINDS.find((x) => x.id === kind) || PROBLEM_KINDS[PROBLEM_KINDS.length - 1];
  const lines = [k.lead];
  if (nearby && (nearby.osmId != null || nearby.name)) lines.push(`Nearest mapped trail: ${describeWay(nearby)}.`);
  lines.push("");
  lines.push("What I saw: ");
  lines.push("");
  lines.push(SIGNATURE);
  return lines.join("\n");
}

/** Swap just the lead line when the user changes the problem kind and has not edited the body. */
export function isUntouched(text, kind, nearby) {
  return text === problemNoteText({ kind, nearby });
}

/** True when the note text still has content besides the signature and our template lead lines. */
export function hasUserContent(text) {
  return String(text || "").replace(SIGNATURE, "").trim().length > 0;
}

// ---------------------------------------------------------------------------
// Existing notes (duplicate check)
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
export function distanceM(lat1, lon1, lat2, lon2) {
  const kx = Math.cos(((lat1 + lat2) / 2) * RAD) * 111320, ky = 110574;
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * ky);
}

/** Bbox [w,s,e,n] around a point, radiusM each way. */
export function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 110574, dLon = radiusM / (Math.cos(lat * RAD) * 111320);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export function nearbyNotesUrl(apiBase, lat, lon, radiusM = 150) {
  const b = bboxAround(lat, lon, radiusM).map((n) => n.toFixed(6)).join(",");
  return `${apiBase}/api/0.6/notes.json?bbox=${b}&closed=0&limit=20`;
}

/**
 * Open notes from a notes.json FeatureCollection, nearest first. The note text
 * is untrusted: callers must put it in the page with textContent only.
 * @returns {Array<{id, lat, lon, created, text, comments, distM}>}
 */
export function parseNotes(json, { lat, lon, maxM = 150 } = {}) {
  const out = [];
  for (const f of json?.features || []) {
    const p = f?.properties || {};
    const c = f?.geometry?.coordinates;
    if (p.status !== "open" || !Array.isArray(c) || !Number.isFinite(p.id)) continue;
    const distM = distanceM(lat, lon, c[1], c[0]);
    if (distM > maxM) continue;
    const first = (p.comments || [])[0] || {};
    out.push({ id: p.id, lat: c[1], lon: c[0], created: String(p.date_created || "").slice(0, 10), text: String(first.text || ""), comments: (p.comments || []).length, distM });
  }
  return out.sort((a, b) => a.distM - b.distM);
}

/** Fetch open notes near a spot. Throws NoteError. */
export async function fetchNearbyNotes(fetchFn, apiBase, lat, lon, { signal } = {}) {
  // Read-only, so a timeout is safe (a timed-out POST could still have been saved: no timeout there).
  const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : null;
  const both = signal && timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout || undefined;
  let res;
  try {
    res = await request(fetchFn, nearbyNotesUrl(apiBase, lat, lon), { method: "GET", signal: both });
  } catch (err) {
    if (err?.name === "AbortError" && !signal?.aborted) throw new NoteError("offline", "timeout"); // our timeout, not the caller's cancel
    throw err;
  }
  return parseNotes(await res.json(), { lat, lon });
}

// ---------------------------------------------------------------------------
// Create a note
// ---------------------------------------------------------------------------

export class NoteError extends Error {
  /** @param {"offline"|"rate_limited"|"blocked"|"invalid"|"api"} kind */
  constructor(kind, message, { status = 0, retryAfter = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Plain, user-facing wording per failure kind. */
export const ERROR_COPY = {
  offline: "You appear to be offline, or OpenStreetMap can’t be reached. Your text is kept; try again when you’re back online.",
  rate_limited: "OpenStreetMap is asking for a pause (too many requests). Your text is kept; try again in a few minutes.",
  blocked: "OpenStreetMap won’t take anonymous notes in this area. Your text is kept; you can open the editor or add the note on openstreetmap.org instead.",
  untouched: "Add a few words about what you saw before sending, so a mapper has something to go on.",
  invalid: "OpenStreetMap rejected the note. Check that it has some text, then try again.",
  api: "OpenStreetMap had a problem saving the note. Your text is kept; try again in a moment.",
};

async function request(fetchFn, url, init) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
    throw new NoteError("offline", String(err?.message || err));
  }
  if (res.ok) return res;
  const retryAfter = Number(res.headers?.get?.("retry-after")) || null;
  if (res.status === 429) throw new NoteError("rate_limited", "rate limited", { status: 429, retryAfter });
  if (res.status === 403) throw new NoteError("blocked", "forbidden", { status: 403 });
  if (res.status === 400) throw new NoteError("invalid", "bad request", { status: 400 });
  throw new NoteError("api", `HTTP ${res.status}`, { status: res.status });
}

/**
 * Post a new note. Anonymous by default. To add an authenticated path later
 * (OSM OAuth 2), pass `authHeaders: {Authorization: "Bearer ..."}`; the
 * endpoint, body and error handling stay the same.
 * @returns {Promise<{id: number, url: string}>}
 */
export async function createNote(fetchFn, apiBase, { lat, lon, text }, { authHeaders = {} } = {}) {
  const body = String(text || "").trim();
  if (!body) throw new NoteError("invalid", "empty text");
  const res = await request(fetchFn, `${apiBase}/api/0.6/notes.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ lat: Number(fix6(lat)), lon: Number(fix6(lon)), text: body }),
  });
  const json = await res.json();
  const id = json?.properties?.id;
  if (!Number.isFinite(id)) throw new NoteError("api", "unexpected response");
  return { id, url: noteWebUrl(apiBase, id) };
}

// ---------------------------------------------------------------------------
// Reported-spots store (localStorage, injectable)
// ---------------------------------------------------------------------------

export const REPORTS_KEY = "outhere_osm_reports";

export class ReportedSpots {
  /** @param {{getItem, setItem}|null} storage */
  constructor(storage, key = REPORTS_KEY) {
    this.storage = storage;
    this.key = key;
  }
  _read() {
    try {
      const v = JSON.parse(this.storage?.getItem(this.key) || "[]");
      return Array.isArray(v) ? v.filter((r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Number.isFinite(r.noteId)) : [];
    } catch { return []; }
  }
  /** The report within radiusM of a spot (same API base only), or null. */
  find(lat, lon, apiBase, radiusM = NEARBY_RADIUS_M) {
    let best = null;
    for (const r of this._read()) {
      if (r.api !== apiBase) continue;
      const d = distanceM(lat, lon, r.lat, r.lon);
      if (d <= radiusM && (!best || d < best.d)) best = { d, r };
    }
    return best ? { ...best.r, url: noteWebUrl(apiBase, best.r.noteId) } : null;
  }
  add({ lat, lon, noteId, api, date = new Date().toISOString() }) {
    const list = this._read().filter((r) => !(r.api === api && r.noteId === noteId));
    list.push({ lat: Number(fix6(lat)), lon: Number(fix6(lon)), noteId, api, date });
    try { this.storage?.setItem(this.key, JSON.stringify(list.slice(-200))); } catch { /* storage full or blocked */ }
  }
}

/** "Nov 11" style date for "Reported on ...". */
export function formatReportDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

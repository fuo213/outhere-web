/**
 * Elevation sampling for drawn routes, pure (no DOM, no map; `fetch` is
 * injectable for tests).
 *
 * A route's `elevation_profile` is feet at points spaced evenly by distance
 * along its line, endpoints included, so sample k of n sits at k/(n-1) of the
 * length. Density: about one sample per 100 m, never coarser than the old
 * 100-point profile on short routes, never closer than 25 m, at most 800.
 * The free Open-Meteo elevation API takes at most 100 coordinates per
 * request, so samples are fetched in sequential chunks. A profile is all or
 * nothing: if any chunk still fails after its retries the fetch rejects and
 * nothing is written.
 *
 * Open-Meteo counts every coordinate as a call (free tier: 600 a minute,
 * 5,000 an hour, 10,000 a day per IP), so a dense profile is not free:
 *   - after an edit, samples on stretches of the line that didn't change are
 *     read from the old profile (buildProfile `reuse`); only drawn legs are
 *     fetched;
 *   - a 429 waits out the minute window before retrying.
 */

const RAD = Math.PI / 180, R = 6371008.8;
const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const PROFILE_SPACING_M = 100;
export const PROFILE_MIN_SPACING_M = 25;
export const PROFILE_MAX_SAMPLES = 800;
export const ELEVATION_CHUNK = 100; // Open-Meteo: coordinates per request
const FT = 3.28084;

/** How many samples a line of `totalM` metres gets. */
export function profileSampleCount(totalM) {
  const byMinSpacing = Math.floor(totalM / PROFILE_MIN_SPACING_M) + 1;
  const dense = Math.round(totalM / PROFILE_SPACING_M) + 1;
  return Math.max(2, Math.min(PROFILE_MAX_SAMPLES, byMinSpacing, Math.max(100, dense)));
}

/**
 * Sample a line at even distance spacing (not by vertex index, which
 * under-samples switchbacks and over-samples straight legs).
 * @param {number[][]} coords - [lng, lat] pairs
 * @param {number} maxPoints - at most this many samples, endpoints included
 * @param {number} minSpacingM - don't sample more densely than this
 * @returns {number[][]}
 */
export function sampleByDistance(coords, maxPoints = 100, minSpacingM = PROFILE_MIN_SPACING_M) {
  if (coords.length < 2) return coords.slice();
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav(coords[i - 1], coords[i]));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(points, fetchFn) {
  const lats = points.map((c) => c[1].toFixed(6)).join(",");
  const lons = points.map((c) => c[0].toFixed(6)).join(",");
  const res = await fetchFn(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.elevation) || data.elevation.length !== points.length || !data.elevation.every(Number.isFinite)) {
    throw new Error("Unexpected response shape");
  }
  return data.elevation;
}

/** Waits before a chunk's 2nd, 3rd and 4th attempt (the last clears a 429's minute window). */
export const RETRY_DELAYS_MS = [1000, 8000, 30000];

/**
 * Elevation (metres) for every point, fetched in sequential chunks.
 * Rejects if a chunk still fails after its retries: never a partial result.
 * @param {number[][]} points
 * @param {{ fetchFn?: Function, chunk?: number, retryDelays?: number[], isStale?: () => boolean }} [opts]
 *   isStale: checked between requests; when it returns true the fetch stops
 *   and resolves null (the line changed while we were asking).
 * @returns {Promise<number[] | null>}
 */
export async function fetchElevations(points, { fetchFn = fetch, chunk = ELEVATION_CHUNK, retryDelays = RETRY_DELAYS_MS, isStale = null } = {}) {
  const out = [];
  for (let i = 0; i < points.length; i += chunk) {
    const part = points.slice(i, i + chunk);
    for (let attempt = 0; ; attempt++) {
      if (isStale?.()) return null;
      try {
        out.push(...await fetchChunk(part, fetchFn));
        break;
      } catch (err) {
        if (attempt >= retryDelays.length) throw err; // the whole profile fails
        await sleep(retryDelays[attempt]);
      }
    }
  }
  return out;
}

/** Linear read of an evenly spaced profile at metre m of a line `total` long. */
function profileAt(profile, total, m) {
  const t = Math.max(0, Math.min(1, total > 0 ? m / total : 0)) * (profile.length - 1);
  const k = Math.min(profile.length - 2, Math.floor(t));
  return profile[k] + (t - k) * (profile[k + 1] - profile[k]);
}

/**
 * A full profile (feet) for a line `total` metres long.
 * @param {object} o
 * @param {number} o.total
 * @param {(m: number) => number[]} o.pointAt  [lon, lat] at metre m
 * @param {{ profile: number[], total: number, spans: Array<{n0, n1, o0, o1}> } | null} [o.reuse]
 *   an older profile and the stretches where it still applies (line-edit.js)
 * @param {object} [o.fetchOpts] passed to fetchElevations (fetchFn, isStale, …)
 * @returns {Promise<{ profile: number[], fetched: number } | null>} null when stale
 */
export async function buildProfile({ total, pointAt, reuse = null, fetchOpts = {} }) {
  const n = profileSampleCount(total);
  const profile = new Array(n);
  const missing = [];
  for (let k = 0; k < n; k++) {
    const m = (total * k) / (n - 1);
    const sp = reuse?.spans.find((q) => m >= q.n0 - 0.5 && m <= q.n1 + 0.5);
    if (sp) {
      const t = sp.n1 > sp.n0 ? Math.max(0, Math.min(1, (m - sp.n0) / (sp.n1 - sp.n0))) : 0;
      profile[k] = Math.round(profileAt(reuse.profile, reuse.total, sp.o0 + t * (sp.o1 - sp.o0)));
    } else missing.push(k);
  }
  if (missing.length) {
    const metres = await fetchElevations(missing.map((k) => pointAt((total * k) / (n - 1))), fetchOpts);
    if (!metres) return null;
    missing.forEach((k, j) => { profile[k] = Math.round(metres[j] * FT); });
  }
  return { profile, fetched: missing.length };
}

/** Swings smaller than this from the last turning point are noise, not climbing. */
export const HYSTERESIS_M = 3;

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

/**
 * Gain and loss (feet) of a route's profile in feet, with the 3 m hysteresis
 * (the same rule GPX imports use). Summing every step instead counts DEM
 * noise as climbing: about three times too much on a dense profile in steep
 * terrain. Used for the whole route, each day's slice and a mirrored return.
 */
export function gainLoss(profileFt) {
  const { gain, loss } = hysteresisGainLoss(profileFt, HYSTERESIS_M * FT);
  return { gain: Math.round(gain), loss: Math.round(loss) };
}

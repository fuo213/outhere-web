/**
 * Map-match a recorded track to a region's routing graph, to name imported
 * GPX routes. Pure (no DOM, no app imports); the graph only needs
 * `candidates(lon, lat, radiusM)` (routing.js TrailGraph) and `contains()`.
 *
 * The track is resampled every ~17 m; each sample takes the nearest way within
 * 25 m, but the way the previous sample was on gets a 10 m head start, so a
 * track running beside a parallel trail or crossing a junction doesn't
 * flicker. Consecutive samples on the same name/highway merge into "runs"
 * ({ name, highway, m }) in walking order, exactly what TrailGraph.route()
 * returns, so route-names.js can name them with the planner's rules.
 *
 * Nothing leaves the browser: no timestamps are read, only coordinates.
 */

const R = 6371008.8;
const RAD = Math.PI / 180;

export const MATCH_STEP_M = 17;
export const MATCH_RADIUS_M = 25;
export const MATCH_STICKY_M = 10;
const ROAD_PENALTY_M = 4; // equal distance: the trail beats the road (as snap() does)
const BLIP_M = 40;        // a run this short between two runs of one trail is junction noise
const GAP_M = 150;      // an unmatched stretch this short between two runs of one trail is GPS error
const MIN_WAY_M = 30;     // a way must carry this much of the track to be recorded
export const LOOP_M = 150;
export const LOOP_FRAC = 0.2;

const ROADISH = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "living_street", "road", "tertiary_link", "secondary_link", "primary_link"]);

const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * Points every `stepM` along a [lon, lat][] track (first and last included),
 * each with the meters of track it stands for.
 * @returns {Array<{c: [number, number], m: number}>}
 */
export function resample(coords, stepM = MATCH_STEP_M) {
  const out = [];
  if (!coords || coords.length < 2) return out;
  let next = 0, acc = 0;
  out.push({ c: coords[0], m: 0 });
  for (let i = 1; i < coords.length; i++) {
    const seg = hav(coords[i - 1], coords[i]);
    if (!(seg > 0)) continue;
    while (next + stepM <= acc + seg) {
      next += stepM;
      const t = (next - acc) / seg;
      out.push({ c: [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])], m: 0 });
    }
    acc += seg;
  }
  if (acc - next > 1 || out.length < 2) out.push({ c: coords[coords.length - 1], m: 0 });
  // Each sample stands for half the gap on either side of it.
  const at = out.map((_, k) => (k === out.length - 1 ? acc : k * stepM));
  out.forEach((s, k) => {
    const before = k ? (at[k] - at[k - 1]) / 2 : 0, after = k < out.length - 1 ? (at[k + 1] - at[k]) / 2 : 0;
    s.m = before + after;
  });
  return out;
}

/**
 * Match a track to the graph.
 * @param {object} graph TrailGraph (or anything with candidates()/contains())
 * @param {Array} coords [lon, lat][]
 * @returns {{runs, wayIds, loop, farthest, totalM, matchedM, endM, farM}}
 *   runs: [{name, highway, m}] in walking order, unmatched stretches as name ""
 *   wayIds: OSM way ids that carry the track (>= 30 m), in walking order
 *   loop: comes back to where it started (see below)
 *   farthest: {name, highway} of the way at the sample farthest from the start
 */
export function matchTrack(graph, coords, { stepM = MATCH_STEP_M, radiusM = MATCH_RADIUS_M, stickyM = MATCH_STICKY_M } = {}) {
  const samples = resample(coords, stepM);
  const empty = { runs: [], wayIds: [], loop: false, farthest: null, totalM: 0, matchedM: 0 };
  if (samples.length < 2) return empty;

  // 1. One way (or none) per sample, sticky to the previous sample's way.
  const picks = [];
  let prevKey = null;
  for (const s of samples) {
    let best = null;
    if (graph.contains(s.c[0], s.c[1])) {
      for (const cand of graph.candidates(s.c[0], s.c[1], radiusM)) {
        const score = cand.d + (ROADISH.has(cand.highway) ? ROAD_PENALTY_M : 0) - (cand.key === prevKey ? stickyM : 0);
        if (!best || score < best.score) best = { cand, score };
      }
    }
    picks.push(best ? best.cand : null);
    prevKey = best ? best.cand.key : null;
  }

  // 2. Segments of consecutive samples on one way.
  let segs = [];
  samples.forEach((s, k) => {
    const p = picks[k], key = p ? p.key : null;
    const last = segs[segs.length - 1];
    if (last && last.key === key) { last.m += s.m; last.end = k; }
    else segs.push({ key, p, m: s.m, start: k, end: k });
  });

  // 3. Noise: a short segment between two stretches of the same trail (same
  //    name and highway) joins them; so does a short stretch with no match at
  //    all (GPS error under a canyon wall), which would otherwise split one
  //    trail into dozens of runs.
  const same = (a, b) => a.p && b.p && a.p.name === b.p.name && a.p.highway === b.p.highway;
  for (let i = 1; i < segs.length - 1; i++) {
    const a = segs[i - 1], b = segs[i], c = segs[i + 1];
    if (b.m < (b.p ? BLIP_M : GAP_M) && same(a, c)) {
      a.m += b.m + c.m; a.end = c.end;
      segs.splice(i, 2);
      i--;
    }
  }

  // 4. Runs, way ids, totals.
  const runs = [];
  let matchedM = 0, totalM = 0;
  const wayM = new Map(), order = [];
  for (const sg of segs) {
    const name = sg.p ? sg.p.name : "", highway = sg.p ? sg.p.highway : "";
    totalM += sg.m;
    if (sg.p) matchedM += sg.m;
    const last = runs[runs.length - 1];
    if (last && last.name === name && last.highway === highway) last.m += sg.m;
    else runs.push({ name, highway, m: sg.m });
    if (sg.p && sg.p.osmId != null) {
      if (!wayM.has(sg.p.osmId)) { wayM.set(sg.p.osmId, 0); order.push(sg.p.osmId); }
      wayM.set(sg.p.osmId, wayM.get(sg.p.osmId) + sg.m);
    }
  }
  const wayIds = order.filter((id) => wayM.get(id) >= MIN_WAY_M);

  // 5. Loop test and the way at the farthest point from the start. A track
  //    that ends within 150 m of where it began is a loop; so is a day hike
  //    that ends much nearer its start than its length (straight-line
  //    start-to-end under 20% of the distance walked: out-and-backs and
  //    lollipops, where the recording was started a few hundred meters from camp).
  const start = samples[0].c;
  let far = 0, farM = -1;
  samples.forEach((s, k) => { const d = hav(start, s.c); if (d > farM) { farM = d; far = k; } });
  const endM = hav(start, samples[samples.length - 1].c);
  const loop = totalM > 2 * LOOP_M && (endM <= LOOP_M || endM <= LOOP_FRAC * totalM);
  let farthest = null;
  const fp = picks[far] || picks.slice(Math.max(0, far - 3), far + 4).find(Boolean);
  if (fp) farthest = { name: fp.name, highway: fp.highway };

  return { runs, wayIds, loop, farthest, totalM, matchedM, endM, farM };
}

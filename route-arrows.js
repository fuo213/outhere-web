/**
 * Direction-of-travel passes for the trip chart (pure geometry, no map).
 *
 * `routePasses(coords)` splits a route LineString into pieces. Stretches that
 * retrace earlier ground (out-and-back) are flagged `lane: 1`; everything else
 * is `lane: 0`. A lane-1 piece is drawn offset to the right of its own travel
 * direction, so the way out and the way back land on opposite sides of the
 * shared line. `spurPasses(coords)` does the same for a one-way day-hike spur
 * (walked both ways): the geometry out, then reversed.
 *
 * Computed once when the trip overlay is built (O(n) with a grid), never per
 * frame. No change to trip data or export.
 */

const RAD = Math.PI / 180;
const TOL_M = 3.5;         // within this of an earlier segment = retracing
const MIN_GAP_M = 40;     // ...and at least this far along the path from it
const MIN_RUN_M = 150;    // overlap runs shorter than this are crossings, not retraces
const FILL_M = 60;       // gaps shorter than this between overlaps get absorbed
const MIN_COS = 0.93;     // must run (anti)parallel, so a crossing doesn't count

export function routePasses(coords) {
  const n = coords.length - 1;
  if (n < 1) return [];
  const k = [Math.cos(coords[0][1] * RAD) * 111320, 110574];
  const P = coords.map(([x, y]) => [x * k[0], y * k[1]]);
  const len = [], cum = [0];
  for (let i = 0; i < n; i++) { len.push(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1])); cum.push(cum[i] + len[i]); }

  // Grid of segments (cell 20 m), each registered in every cell it touches.
  const CELL = 20, grid = new Map();
  const key = (cx, cy) => cx * 100003 + cy;
  for (let i = 0; i < n; i++) {
    const steps = Math.max(1, Math.ceil(len[i] / (CELL / 2)));
    const seen = new Set();
    for (let s = 0; s <= steps; s++) {
      const x = P[i][0] + ((P[i + 1][0] - P[i][0]) * s) / steps, y = P[i][1] + ((P[i + 1][1] - P[i][1]) * s) / steps;
      const kk = key(Math.floor(x / CELL), Math.floor(y / CELL));
      if (!seen.has(kk)) { seen.add(kk); (grid.get(kk) || grid.set(kk, []).get(kk)).push(i); }
    }
  }
  const ov = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (len[i] < 0.01) continue;
    const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
    const ux = (P[i + 1][0] - P[i][0]) / len[i], uy = (P[i + 1][1] - P[i][1]) / len[i];
    const cx = Math.floor(mx / CELL), cy = Math.floor(my / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(key(cx + dx, cy + dy)) || []) {
        if (j >= i || len[j] < 0.01 || cum[i] - cum[j + 1] < MIN_GAP_M) continue;
        const ax = P[j][0], ay = P[j][1], bx = P[j + 1][0] - ax, by = P[j + 1][1] - ay;
        const t = Math.max(0, Math.min(1, ((mx - ax) * bx + (my - ay) * by) / (len[j] * len[j])));
        if (Math.hypot(mx - ax - bx * t, my - ay - by * t) > TOL_M) continue;
        if (Math.abs((bx * ux + by * uy) / len[j]) < MIN_COS) continue;
        ov[i] = ov[j] = true;
      }
    }
  }
  // Clean up: absorb short gaps, then drop short runs.
  const runs = (flag) => { const r = []; let s = 0; for (let i = 1; i <= n; i++) if (i === n || ov[i] !== ov[i - 1]) { if (ov[i - 1] === flag) r.push([s, i]); s = i; } return r; };
  const length = ([a, b]) => cum[b] - cum[a];
  for (const [a, b] of runs(false)) if (a > 0 && b < n && length([a, b]) < FILL_M) for (let i = a; i < b; i++) ov[i] = true;
  for (const [a, b] of runs(true)) if (length([a, b]) < MIN_RUN_M) for (let i = a; i < b; i++) ov[i] = false;

  const out = [];
  let s = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || ov[i] !== ov[i - 1]) {
      if (cum[i] - cum[s] > 0) out.push({ coords: coords.slice(s, i + 1), lane: ov[s] ? 1 : 0 });
      s = i;
    }
  }
  return out;
}

export function spurPasses(coords) {
  return [{ coords, lane: 1 }, { coords: coords.slice().reverse(), lane: 1 }];
}

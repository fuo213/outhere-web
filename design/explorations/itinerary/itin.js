/**
 * Itinerary explorations: shared data model + drawing kit.
 *
 * EXPLORATION (2026-11-08). Not used by the app. Loads the Maze demo trip
 * fixture and turns it into day-by-day data, then draws it with a small
 * "hand" toolkit: variable-width ink strokes (wobble baked into the path
 * data, never a jitter filter), colored-pencil shading (procedural hatching
 * plus a paper-grain mask), and one family of custom glyphs.
 *
 * Everything is deterministic (seeded) so screenshots are stable.
 */

export const FIXTURE = new URL("../../fixtures/demo-maze-chocolate-drops.trip.geojson", import.meta.url).href;
export const CONTOURS = new URL("./maze-contours.json", import.meta.url).href;

const R = 6371008.8, RAD = Math.PI / 180, MI = 1609.344;
export const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
export const fmt = {
  mi: (v) => `${v.toFixed(1)} mi`,
  ft: (v) => `${Math.round(v).toLocaleString("en-US")} ft`,
  gain: (v) => `+${Math.round(v).toLocaleString("en-US")}`,
  loss: (v) => `−${Math.round(v).toLocaleString("en-US")}`,
  date: (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
  range: (a, b) => {
    const A = new Date(a + "T12:00:00Z"), B = new Date(b + "T12:00:00Z");
    const m = (d) => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    return m(A) === m(B) ? `${m(A)} ${A.getUTCDate()}–${B.getUTCDate()}, ${B.getUTCFullYear()}` : `${m(A)} ${A.getUTCDate()} – ${m(B)} ${B.getUTCDate()}, ${B.getUTCFullYear()}`;
  },
};
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

function cumMiles(coords) {
  const c = [0];
  for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + hav(coords[i - 1], coords[i]) / MI);
  return c;
}
/** Miles along a polyline to the nearest point to `p`. */
function alongMi(coords, cum, p) {
  const kx = Math.cos(p[1] * RAD) * 111320, ky = 110574;
  let best = 0, bd = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * kx, ay = (coords[i - 1][1] - p[1]) * ky;
    const bx = (coords[i][0] - p[0]) * kx, by = (coords[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bd) { bd = d; best = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
  }
  return best;
}

const KIND = (p) => (p.type === "waypoint" ? p.subtype : p.type);

export async function loadTrip() {
  const trip = await (await fetch(FIXTURE)).json();
  const byId = new Map(trip.features.map((f) => [f.properties._id, f]));
  let mi0 = 0;
  const days = trip.days.map((d, i) => {
    const feats = d.features.map((id) => byId.get(id)).filter(Boolean);
    const route = feats.find((f) => f.properties.type === "route");
    const rp = route.properties;
    const coords = route.geometry.coordinates;
    const cum = cumMiles(coords);
    const miles = cum[cum.length - 1];
    const spurF = feats.find((f) => f.properties.type === "dayhike_spur");
    const stops = feats.filter((f) => f !== route && f !== spurF).map((f) => {
      const p = f.properties;
      const at = alongMi(coords, cum, f.geometry.coordinates);
      return { kind: KIND(p), name: p.name, notes: p.notes, coord: f.geometry.coordinates, dayMi: at, mi: mi0 + at, water: p.water_nearby, waterNotes: p.water_notes, elevation: p.elevation };
    });
    let spur = null;
    if (spurF) {
      const sc = spurF.geometry.coordinates;
      const point = stops.find((s) => s.kind === "dayhike");
      spur = { coords: sc, oneWay: cumMiles(sc).at(-1), rt: cumMiles(sc).at(-1) * 2, name: point?.name || spurF.properties.name, at: mi0 + alongMi(coords, cum, sc[0]) };
    }
    const manual = (rp.segments || []).filter((s) => s.mode !== "trail").map((s) => ({ from: mi0 + cum[s.coord_range[0]], to: mi0 + cum[s.coord_range[1]], mode: s.mode }));
    // merge touching manual legs (a shift-click leg + its 10 m stub)
    const merged = [];
    for (const m of manual) { const last = merged.at(-1); if (last && m.from - last.to < 0.02) last.to = m.to; else merged.push({ ...m }); }
    const day = {
      i, n: i + 1, id: d.id, date: d.date, title: rp.name, notes: d.notes,
      miles, gain: rp.elevation_gain_ft, loss: rp.elevation_loss_ft, profile: rp.elevation_profile,
      coords, cum, startMi: mi0, endMi: mi0 + miles, stops, spur, manual: merged,
      camp: stops.find((s) => s.kind === "camp") || null,
    };
    mi0 += miles;
    return day;
  });
  // Continuous profile: [mi, ft]
  const profile = [];
  for (const d of days) {
    const n = d.profile.length;
    d.profile.forEach((ft, k) => { if (k === 0 && profile.length) return; profile.push([d.startMi + (k / (n - 1)) * d.miles, ft]); });
  }
  const elevAt = (mi) => {
    for (let k = 1; k < profile.length; k++) if (profile[k][0] >= mi) {
      const [m0, f0] = profile[k - 1], [m1, f1] = profile[k];
      return f0 + ((mi - m0) / (m1 - m0 || 1)) * (f1 - f0);
    }
    return profile.at(-1)[1];
  };
  let hi = profile[0], lo = profile[0];
  for (const p of profile) { if (p[1] > hi[1]) hi = p; if (p[1] < lo[1]) lo = p; }
  const P = trip.properties;
  return {
    trip, name: P.name, location: P.location, dates: P.dates, readme: P.readme,
    days, profile, elevAt, high: { mi: hi[0], ft: hi[1] }, low: { mi: lo[0], ft: lo[1] },
    total: { miles: mi0, gain: days.reduce((s, d) => s + d.gain, 0), loss: days.reduce((s, d) => s + d.loss, 0), spur: days.reduce((s, d) => s + (d.spur?.rt || 0), 0) },
  };
}

export async function loadContours() {
  const c = await (await fetch(CONTOURS)).json();
  const kx = Math.cos(c.lat0 * RAD) * 111320, ky = 110574;
  return c.lines.map(([ft, flat]) => {
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([c.origin[0] + (flat[i] * c.unit_m) / kx, c.origin[1] + (flat[i + 1] * c.unit_m) / ky]);
    return { ft, pts, index: ft % 400 === 0 };
  });
}

/** North-up local projection fitting `bbox` [w,s,e,n] into a w×h box. */
export function projector(bbox, w, h, pad = 16) {
  const lat0 = (bbox[1] + bbox[3]) / 2, kx = Math.cos(lat0 * RAD) * 111320, ky = 110574;
  const dx = (bbox[2] - bbox[0]) * kx, dy = (bbox[3] - bbox[1]) * ky;
  const s = Math.min((w - 2 * pad) / dx, (h - 2 * pad) / dy);
  const ox = (w - dx * s) / 2, oy = (h - dy * s) / 2;
  const f = ([lon, lat]) => [ox + (lon - bbox[0]) * kx * s, h - oy - (lat - bbox[1]) * ky * s];
  f.pxPerMile = s * MI;
  return f;
}
export function bboxOf(lines, padM = 0) {
  let w = 180, s = 90, e = -180, n = -90;
  for (const l of lines) for (const [x, y] of l) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const lat0 = (s + n) / 2, kx = Math.cos(lat0 * RAD) * 111320, ky = 110574;
  return [w - padM / kx, s - padM / ky, e + padM / kx, n + padM / ky];
}

// ---------------------------------------------------------------------------
// Geometry helpers (screen space)
// ---------------------------------------------------------------------------

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Smooth 1-D noise in [-1, 1] along arc length s (sum of seeded sines). */
function noise1(seed) {
  const r = rng(seed);
  const waves = [[1 / 38, 0.55], [1 / 13, 0.3], [1 / 5.5, 0.15]].map(([f, a]) => [f * (0.8 + 0.4 * r()), a, r() * 6.283]);
  return (s) => waves.reduce((v, [f, a, ph]) => v + a * Math.sin(s * f * 6.283 + ph), 0);
}

export function simplify(pts, tol = 0.6) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Chaikin corner cutting, keeps endpoints. */
export function chaikin(pts, iter = 2) {
  let p = pts;
  for (let k = 0; k < iter; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(p.at(-1));
    p = out;
  }
  return p;
}
/** Resample a polyline at a fixed spacing (px). */
export function resample(pts, step = 2.5) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const L = Math.hypot(x1 - x0, y1 - y0);
    let d = step - carry;
    while (d <= L) { out.push([x0 + ((x1 - x0) * d) / L, y0 + ((y1 - y0) * d) / L]); d += step; }
    carry = L - (d - step);
  }
  if (out.length < 2 || Math.hypot(out.at(-1)[0] - pts.at(-1)[0], out.at(-1)[1] - pts.at(-1)[1]) > 0.3) out.push(pts.at(-1));
  return out;
}
export const smoothD = (pts) => {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)} ${c1[1].toFixed(2)} ${c2[0].toFixed(2)} ${c2[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
};
/** Wobble a polyline perpendicular to itself (baked hand tremor, sub-pixel). */
export function wobble(pts, { amp = 0.45, seed = 1 } = {}) {
  const n = noise1(seed), r = resample(pts, 2.5);
  let s = 0;
  return r.map((p, i) => {
    if (i) s += Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]);
    const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const o = amp * n(s);
    return [p[0] - (dy / L) * o, p[1] + (dx / L) * o];
  });
}

/**
 * A fineliner stroke as a filled outline: width breathes with pen pressure
 * (±vary), tapers slightly at both ends, tremor baked in. Returns path `d`.
 */
export function inkStroke(pts, { w = 1.4, vary = 0.28, amp = 0.4, seed = 1, taper = 5 } = {}) {
  const r = resample(pts, 2);
  if (r.length < 2) return "";
  const nO = noise1(seed), nW = noise1(seed * 7 + 3);
  const total = r.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) : 0), 0);
  const L = [], Rt = [];
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    if (i) s += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
    const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const end = Math.min(1, s / taper, (total - s) / taper);
    const hw = (w / 2) * (1 + vary * nW(s)) * (0.55 + 0.45 * Math.max(0, end));
    const o = amp * nO(s);
    L.push([r[i][0] + nx * (o + hw), r[i][1] + ny * (o + hw)]);
    Rt.push([r[i][0] + nx * (o - hw), r[i][1] + ny * (o - hw)]);
  }
  const f = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  return `M${f(L[0])}` + L.slice(1).map((p) => `L${f(p)}`).join("") + Rt.reverse().map((p) => `L${f(p)}`).join("") + "Z";
}

/**
 * Colored-pencil hatching clipped by the caller: a field of slightly uneven
 * diagonal strokes (spacing, angle, length and pressure all vary a little).
 */
export function hatch(box, { spacing = 2.6, angle = -58, seed = 3, w = 0.75, minO = 0.35, maxO = 0.75 } = {}) {
  const r = rng(seed);
  const [x0, y0, x1, y1] = box;
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let out = "";
  for (let t = -diag / 2; t < diag / 2; t += spacing * (0.8 + 0.4 * r())) {
    const da = (r() - 0.5) * 0.05;
    const c2 = Math.cos(a + da), s2 = Math.sin(a + da);
    const px = cx - sa * t, py = cy + ca * t;
    const half = diag / 2 + 4;
    const j0 = (r() - 0.5) * 6, j1 = (r() - 0.5) * 6;
    out += `<path d="M${(px - c2 * (half + j0)).toFixed(1)} ${(py - s2 * (half + j0)).toFixed(1)}L${(px + c2 * (half + j1)).toFixed(1)} ${(py + s2 * (half + j1)).toFixed(1)}" stroke-width="${(w * (0.8 + 0.4 * r())).toFixed(2)}" stroke-opacity="${(minO + (maxO - minO) * r()).toFixed(2)}"/>`;
  }
  return out;
}

/** <defs> every drawing needs: paper-grain masks for pencil. */
export function pencilDefs(id = "g") {
  return `
  <filter id="${id}-grain" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="11" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.4 0 0 0 -0.75" result="tooth"/>
    <feComposite in="SourceGraphic" in2="tooth" operator="in"/>
  </filter>
  <filter id="${id}-grain-soft" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="5" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 -0.3" result="tooth"/>
    <feComposite in="SourceGraphic" in2="tooth" operator="in"/>
  </filter>`;
}

// ---------------------------------------------------------------------------
// Glyphs: one hand. 24-unit boxes, origin at the glyph's anchor (bottom
// center for things that stand on the line). Ink strokes are drawn as
// inkStroke outlines, so they share the pen of the route line.
// ---------------------------------------------------------------------------

const P = (d) => d; // marker for readability
const GLYPHS = {
  // A-frame tent: pencil body, inked sides, door and a ground line.
  camp: {
    fill: P("M-9 0 L-0.4 -12.4 L9.2 0 Z"),
    ink: [
      [[-9.8, 0.3], [-5.2, -6.2], [-0.5, -12.8]],
      [[-0.5, -12.8], [4.3, -6.3], [9.6, 0.2]],
      [[-0.5, -12.8], [0.3, -15]],
      [[-2.9, 0.1], [-0.4, -6.6], [2.4, 0.1]],
      [[-6.6, -4.6], [-12.6, 0.4]],
      [[6.2, -4.8], [12.8, 0.3]],
    ],
    door: P("M-2.6 0 L-0.4 -6.2 L2.2 0 Z"),
    color: "--type-camp",
  },
  // Water drop.
  water: {
    fill: P("M0 -14 C-1.6 -10.6 -6 -6.4 -6 -3.6 C-6 -0.3 -3.2 1.6 0 1.6 C3.3 1.6 6 -0.4 6 -3.6 C6 -6.6 1.6 -10.6 0 -14 Z"),
    ink: [
      [[0.1, -14.2], [-2.6, -9.6], [-5.6, -5.6], [-6, -2.6], [-4.4, 0.6], [-0.4, 1.8], [3.6, 0.8], [6, -2.4], [5.6, -5.6], [2.8, -9.4], [0.1, -14.2]],
      [[-3, -3.6], [-2.4, -1.4], [-0.8, -0.4]],
    ],
    color: "--type-water",
  },
  // Spot elevation: a small inked benchmark triangle with pencil inside.
  summit: {
    fill: P("M-5 0 L0 -8.6 L5 0 Z"),
    ink: [[[-5.6, 0.3], [-0.1, -9.2], [5.6, 0.2], [-5.6, 0.3]]],
    color: "--ink-300",
  },
  // Scenic: a hand asterisk (guidebook "point of interest").
  scenic: {
    ink: [[[0, -11], [0.2, -1]], [[-4.4, -8.6], [4.5, -3.4]], [[-4.5, -3.3], [4.4, -8.7]]],
    color: null,
  },
  // Hazard (pour-off / cliff): a step with hachure teeth, like a map's cliff symbol.
  hazard: {
    ink: [
      [[-8, -8], [-0.6, -8.2], [0.1, -0.2], [8, 0]],
      [[-6.4, -8], [-5.2, -5.6]], [[-3.6, -8.1], [-2.4, -5.7]], [[-0.9, -6], [1.6, -5.2]], [[-0.5, -3.2], [2, -2.4]],
    ],
    color: null,
  },
  // Mug with one wisp: a meal stop.
  meal: {
    fill: P("M-5.6 -9.6 L-5.2 -1 Q-5 0 -4 0 L3.8 0 Q4.8 0 5 -1 L5.4 -9.6 Z"),
    ink: [
      [[-6.2, -9.8], [-5.6, -1.4], [-4.4, 0.2], [3.9, 0.2], [5.2, -1.2], [5.8, -9.8]],
      [[-6.6, -9.9], [6.3, -9.7]],
      [[5.6, -7.6], [8.6, -7.4], [9, -4.6], [7.6, -2.8], [5.2, -3]],
      [[-1.4, -12], [-2.4, -14], [-1.2, -16], [-2, -18]],
      [[1.8, -12.2], [1.1, -13.8], [2, -15.4]],
    ],
    color: "--earth-500",
  },
  // Start/finish: a ringed dot.
  start: {
    fill: P("M-3.2 0 A3.2 3.2 0 1 0 3.2 0 A3.2 3.2 0 1 0 -3.2 0 Z"),
    ink: [[[0, -4.6], [3.3, -3.3], [4.6, 0], [3.3, 3.3], [0, 4.6], [-3.3, 3.3], [-4.6, 0], [-3.3, -3.3], [0.4, -4.6]]],
    color: "--ink-700",
    solid: true,
  },
  dayhike: {
    ink: [[[-6, 0], [-2, -9], [3, -10], [6, -4]], [[3.4, -5.6], [6.2, -3.6], [7.2, -7]]],
    color: "--type-dayhike",
  },
};

/**
 * Draw a glyph at (x, y). `s` scales the 24-unit design. Ink uses
 * inkStroke so line quality matches the drawing. `pencil` toggles the fill.
 */
export function glyph(kind, x, y, { s = 1, seed = 1, ink = "var(--ink-900)", grain = "g", pencil = true, w = 1.15 } = {}) {
  const g = GLYPHS[kind] || GLYPHS.scenic;
  let out = `<g class="glyph glyph--${kind}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${s})">`;
  if (g.fill && g.color && pencil) {
    const fillOpacity = g.solid ? 1 : 0.95;
    out += `<path d="${g.fill}" transform="translate(0.7 0.5)" fill="var(${g.color})" fill-opacity="${fillOpacity}" filter="${g.solid ? "" : `url(#${grain}-grain-soft)`}"/>`;
  }
  if (g.door) out += `<path d="${g.door}" fill="var(--ink-700)" fill-opacity="0.55"/>`;
  g.ink.forEach((line, k) => {
    out += `<path d="${inkStroke(chaikin(line, 2), { w: w / s, vary: 0.25, amp: 0.12, seed: seed * 13 + k, taper: 2.5 })}" fill="${ink}"/>`;
  });
  return out + "</g>";
}

/** A glyph as a standalone inline SVG for lists (shares the defs id `gl`). */
export function glyphIcon(kind, { size = 22, seed = 1 } = {}) {
  const anchorY = kind === "start" ? 12 : kind === "hazard" ? 16 : 19;
  const s = { camp: 0.9, water: 1.05, scenic: 1.1, hazard: 1.1, dayhike: 1.2, meal: 1, start: 1.1 }[kind] || 1;
  return `<svg class="stop-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${glyph(kind, 12, anchorY, { s, seed, grain: "gl", w: 1.25 })}</svg>`;
}
export const glyphDefsSVG = () => `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${pencilDefs("gl")}</defs></svg>`;

export const STOP_LABEL = { camp: "Camp", water: "Water", scenic: "Viewpoint", hazard: "Hazard", dayhike: "Day hike", rest: "Rest", resupply: "Resupply" };

// ---------------------------------------------------------------------------
// Page chrome: state switcher shared by the three explorations
// ---------------------------------------------------------------------------

export function wireStates() {
  const params = new URLSearchParams(location.search);
  const set = (st) => {
    document.body.dataset.state = st;
    document.querySelectorAll("[data-set-state]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.setState === st)));
    document.dispatchEvent(new CustomEvent("statechange", { detail: st }));
  };
  document.querySelectorAll("[data-set-state]").forEach((b) => b.addEventListener("click", () => {
    set(b.dataset.setState);
    const u = new URL(location.href); u.searchParams.set("state", b.dataset.setState); history.replaceState(null, "", u);
  }));
  set(params.get("state") || "default");
}

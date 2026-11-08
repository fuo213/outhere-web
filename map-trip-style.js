/**
 * Booot trip route on the map, drawn like itinerary direction B ("Trip
 * chart", design/explorations/itinerary/): a clean inked route on a thin
 * paper casing, a colored-pencil band under each day's stretch, circled day
 * numerals, and one family of hand-drawn glyphs (tent, drop, day-hike arrow,
 * start/end rings, gap pin).
 *
 * Geometry is never altered: lines are the exact routed coordinates (this is
 * for navigation). The hand quality lives only in raster images drawn here at
 * runtime (pencil-grain `line-pattern`, glyphs, numerals, italic labels),
 * registered with `map.addImage` at the device pixel ratio.
 *
 * Active day (shared contract with the trip panel; see CLAUDE.md "Active
 * day"): `window` CustomEvent `booot:active-day`, detail
 * `{ dayIndex, dayId, source }`. The map listens, highlights via
 * feature-state (no source rebuild), and dispatches the same event with
 * `source: "map"` when a day's line is clicked.
 *
 * Hooks: app.js calls `addTripChartLayers()` / `drawingLegLayers()` /
 * `gapPinLayers()` / `initTripChart()`; planning.js `buildRoutingOverlay()`
 * passes its leg features through `tripChartOverlay()`.
 */

import { map } from "./app.js"; // circular; only used at runtime
import { isDrawingRoute, isDeleteMode } from "./planning.js"; // circular; runtime only
import { TripManager } from "./trip-panel.js"; // circular; runtime only

/** Layers that carry trip point features (popups, delete mode). */
export const TRIP_POINT_LAYERS = ["trip-chart-points", "trip-chart-points-minor"];
/** Layers whose features carry `day_index` (click a day's line). */
const DAY_LINE_LAYERS = ["trip-chart-band", "trip-chart-ink", "trip-chart-ink-manual", "trip-chart-ink-gap", "trip-chart-hit"];

const RATIO = () => Math.max(2, Math.ceil(window.devicePixelRatio || 1));
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// ---------------------------------------------------------------------------
// Colors (tokens.css; MapLibre paint can't read CSS variables)
// ---------------------------------------------------------------------------

let C = null;
function colors() {
  const cs = getComputedStyle(document.documentElement);
  const t = (n) => cs.getPropertyValue(n).trim();
  C = {
    ink: t("--ink-900"),
    inkSoft: t("--ink-500"),
    inkPencil: t("--ink-400"),
    body: t("--text-body"),
    paper: t("--surface-raised"),
    surface: t("--surface"),
    // Day pencils: the exploration's palette (itin.css EXPLORATION block).
    pencil: [t("--sage-500"), t("--dust-500")],
    camp: t("--type-camp"),
    water: t("--type-water"),
    dayhike: t("--type-dayhike"),
    dayhikeText: t("--type-dayhike-text"),
    rest: t("--type-rest"),
    accent: t("--accent"),
    ink300: t("--ink-300"),
    ink700: t("--ink-700"),
    earth500: t("--earth-500"),
  };
  return C;
}

// ---------------------------------------------------------------------------
// The "hand": ported from design/explorations/itinerary/itin.js (seeded, so
// images are identical on every load).
// ---------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function noise1(seed) {
  const r = rng(seed);
  const waves = [[1 / 38, 0.55], [1 / 13, 0.3], [1 / 5.5, 0.15]].map(([f, a]) => [f * (0.8 + 0.4 * r()), a, r() * 6.283]);
  return (s) => waves.reduce((v, [f, a, ph]) => v + a * Math.sin(s * f * 6.283 + ph), 0);
}
function chaikin(pts, iter = 2) {
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
function resample(pts, step) {
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
/** Fineliner stroke as a filled outline (pressure, taper, baked tremor). Returns SVG path data. */
function inkStroke(pts, { w = 1.4, vary = 0.28, amp = 0.4, seed = 1, taper = 5 } = {}) {
  const r = resample(pts, 1);
  if (r.length < 2) return "";
  const nO = noise1(seed), nW = noise1(seed * 7 + 3);
  const total = r.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) : 0), 0);
  const L = [], R = [];
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    if (i) s += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
    const a = r[Math.max(0, i - 1)], b = r[Math.min(r.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
    const end = Math.min(1, s / taper, (total - s) / taper);
    const hw = (w / 2) * (1 + vary * nW(s)) * (0.55 + 0.45 * Math.max(0, end));
    const o = amp * nO(s);
    L.push([r[i][0] + nx * (o + hw), r[i][1] + ny * (o + hw)]);
    R.push([r[i][0] + nx * (o - hw), r[i][1] + ny * (o - hw)]);
  }
  const f = (p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  return `M${f(L[0])}` + L.slice(1).map((p) => `L${f(p)}`).join("") + R.reverse().map((p) => `L${f(p)}`).join("") + "Z";
}
const ring = (r, { start = -1.9, ry = 0.96 } = {}) => {
  const out = [];
  for (let k = 0; k <= 26; k++) { const a = start + (k / 24) * Math.PI * 2; out.push([Math.cos(a) * r, Math.sin(a) * r * ry]); }
  return out;
};

// Glyph designs (24-unit boxes, origin at the anchor), from itin.js GLYPHS.
const GLYPHS = {
  camp: {
    fill: "M-9 0 L-0.4 -12.4 L9.2 0 Z",
    ink: [
      [[-9.8, 0.3], [-5.2, -6.2], [-0.5, -12.8]],
      [[-0.5, -12.8], [4.3, -6.3], [9.6, 0.2]],
      [[-0.5, -12.8], [0.3, -15]],
      [[-2.9, 0.1], [-0.4, -6.6], [2.4, 0.1]],
      [[-6.6, -4.6], [-12.6, 0.4]],
      [[6.2, -4.8], [12.8, 0.3]],
    ],
    door: "M-2.6 0 L-0.4 -6.2 L2.2 0 Z",
    color: "camp",
  },
  water: {
    fill: "M0 -14 C-1.6 -10.6 -6 -6.4 -6 -3.6 C-6 -0.3 -3.2 1.6 0 1.6 C3.3 1.6 6 -0.4 6 -3.6 C6 -6.6 1.6 -10.6 0 -14 Z",
    ink: [
      [[0.1, -14.2], [-2.6, -9.6], [-5.6, -5.6], [-6, -2.6], [-4.4, 0.6], [-0.4, 1.8], [3.6, 0.8], [6, -2.4], [5.6, -5.6], [2.8, -9.4], [0.1, -14.2]],
      [[-3, -3.6], [-2.4, -1.4], [-0.8, -0.4]],
    ],
    color: "water",
  },
  scenic: { ink: [[[0, -11], [0.2, -1]], [[-4.4, -8.6], [4.5, -3.4]], [[-4.5, -3.3], [4.4, -8.7]]] },
  hazard: {
    ink: [
      [[-8, -8], [-0.6, -8.2], [0.1, -0.2], [8, 0]],
      [[-6.4, -8], [-5.2, -5.6]], [[-3.6, -8.1], [-2.4, -5.7]], [[-0.9, -6], [1.6, -5.2]], [[-0.5, -3.2], [2, -2.4]],
    ],
  },
  meal: {
    fill: "M-5.6 -9.6 L-5.2 -1 Q-5 0 -4 0 L3.8 0 Q4.8 0 5 -1 L5.4 -9.6 Z",
    ink: [
      [[-6.2, -9.8], [-5.6, -1.4], [-4.4, 0.2], [3.9, 0.2], [5.2, -1.2], [5.8, -9.8]],
      [[-6.6, -9.9], [6.3, -9.7]],
      [[5.6, -7.6], [8.6, -7.4], [9, -4.6], [7.6, -2.8], [5.2, -3]],
      [[-1.4, -12], [-2.4, -14], [-1.2, -16], [-2, -18]],
      [[1.8, -12.2], [1.1, -13.8], [2, -15.4]],
    ],
    color: "earth500",
  },
  dayhike: {
    ink: [[[-6, 0], [-2, -9], [3, -10], [6, -4]], [[3.4, -5.6], [6.2, -3.6], [7.2, -7]]],
    inkColor: "dayhike",
  },
};

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function canvas(w, h, r = RATIO()) {
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * r); c.height = Math.ceil(h * r);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.scale(r, r);
  return [c, g, r];
}
/** Multiply a canvas's alpha by smooth paper-tooth noise (colored pencil). */
function grain(c, { seed = 5, strength = 0.55, cell = 1.6, periodic = false } = {}) {
  const g = c.getContext("2d", { willReadFrequently: true });
  const img = g.getImageData(0, 0, c.width, c.height);
  const r = rng(seed);
  const gw = Math.ceil(c.width / cell) + 1, gh = Math.ceil(c.height / cell) + 1;
  const pw = periodic ? Math.round(c.width / cell) : gw; // grid wraps horizontally when periodic
  const grid = new Float32Array(gw * gh).map(() => r());
  const at = (i, j) => grid[j * gw + (periodic ? ((i % pw) + pw) % pw : i)];
  const d = img.data;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const fx = x / cell, fy = y / cell, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
      const n = (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
      const k = (y * c.width + x) * 4 + 3;
      d[k] = d[k] * Math.min(1, Math.max(0, 1 - strength + strength * 1.6 * n));
    }
  }
  g.putImageData(img, 0, 0);
}
/** Paper halo: the glyph's silhouette, dilated, in paper color, under the glyph. */
function withHalo(src, w, h, r, radius = 1.6) {
  const [c, g] = canvas(w, h, r);
  const [tint, tg] = canvas(w, h, r);
  tg.setTransform(1, 0, 0, 1, 0, 0);
  tg.drawImage(src, 0, 0);
  tg.globalCompositeOperation = "source-in";
  tg.fillStyle = C.paper;
  tg.fillRect(0, 0, tint.width, tint.height);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 0.9;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.drawImage(tint, Math.cos(a) * radius * r, Math.sin(a) * radius * r);
  }
  g.globalAlpha = 1;
  g.drawImage(src, 0, 0);
  return c;
}
const imageData = (c) => c.getContext("2d").getImageData(0, 0, c.width, c.height);

function addImg(id, c, r, extra = {}) {
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, imageData(c), { pixelRatio: r, ...extra });
}

/** Draw one glyph at (x, y) in CSS px on `g` (pencil fill with grain, then ink). */
function drawGlyph(g, r, kind, x, y, { s = 1, seed = 1, w = 1.2 } = {}) {
  const G = GLYPHS[kind];
  if (G.fill && G.color) {
    const [fc, fg] = canvas(g.canvas.width / r, g.canvas.height / r, r);
    fg.translate(x + 0.7 * s, y + 0.5 * s); fg.scale(s, s);
    fg.fillStyle = C[G.color];
    fg.fill(new Path2D(G.fill));
    grain(fc, { seed: seed + 3, strength: 0.4, cell: 1.3 });
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(fc, 0, 0); g.restore();
  }
  g.save();
  g.translate(x, y); g.scale(s, s);
  if (G.door) { g.globalAlpha = 0.55; g.fillStyle = C.ink700; g.fill(new Path2D(G.door)); g.globalAlpha = 1; }
  g.fillStyle = G.inkColor ? C[G.inkColor] : C.ink;
  G.ink.forEach((line, k) => g.fill(new Path2D(inkStroke(chaikin(line, 2), { w: w / s, vary: 0.25, amp: 0.12, seed: seed * 13 + k, taper: 2.5 }))));
  g.restore();
}

// ---------------------------------------------------------------------------
// Static images
// ---------------------------------------------------------------------------

/** Standing glyphs: anchor = bottom center, `PAD` px below the ground line. */
const PAD = 2;
const GLYPH_BOX = { camp: [34, 22, 1.1], water: [18, 19, 0.92], dayhike: [26, 20, 1.45], scenic: [15, 15, 1], hazard: [21, 13, 1], meal: [24, 24, 0.95] };

function addStaticImages() {
  const r = RATIO();
  for (const [kind, [w, h, s]] of Object.entries(GLYPH_BOX)) {
    const [c, g] = canvas(w, h, r);
    drawGlyph(g, r, kind, w / 2, h - PAD, { s, seed: kind.length * 7, w: kind === "dayhike" ? 1.8 : 1.25 });
    addImg(`booot-g-${kind}`, withHalo(c, w, h, r), r);
  }
  // Rest day: dust pencil disc in an ink ring.
  {
    const [c, g] = canvas(16, 16, r);
    const [fc, fg] = canvas(16, 16, r);
    fg.fillStyle = C.rest; fg.beginPath(); fg.arc(8.4, 8.3, 5, 0, Math.PI * 2); fg.fill();
    grain(fc, { seed: 17, strength: 0.4, cell: 1.3 });
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(fc, 0, 0); g.restore();
    g.translate(8, 8); g.fillStyle = C.ink;
    g.fill(new Path2D(inkStroke(ring(5.4), { w: 1.15, vary: 0.25, amp: 0.12, seed: 19, taper: 2 })));
    addImg("booot-g-rest", withHalo(c, 16, 16, r), r);
  }
  // Any other waypoint (resupply, unknown): small ink ring with a muted dot.
  {
    const [c, g] = canvas(14, 14, r);
    g.translate(7, 7); g.fillStyle = C.ink300; g.beginPath(); g.arc(0, 0, 2.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.ink; g.fill(new Path2D(inkStroke(ring(4.4), { w: 1.1, vary: 0.25, amp: 0.1, seed: 23, taper: 2 })));
    addImg("booot-g-dot", withHalo(c, 14, 14, r), r);
  }
  // Start: ringed ink dot. End: the same with a second ring (a target).
  for (const kind of ["start", "end"]) {
    const S = 22;
    const [c, g] = canvas(S, S, r);
    g.translate(S / 2, S / 2);
    g.fillStyle = C.paper; g.beginPath(); g.arc(0, 0, kind === "end" ? 8.2 : 6.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.ink700; g.beginPath(); g.arc(0, 0, 2.9, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.ink;
    g.fill(new Path2D(inkStroke(ring(5.6, { start: -2.2 }), { w: 1.35, vary: 0.25, amp: 0.12, seed: 29, taper: 2 })));
    if (kind === "end") g.fill(new Path2D(inkStroke(ring(8.6, { start: 0.9 }), { w: 1.05, vary: 0.25, amp: 0.12, seed: 31, taper: 2 })));
    addImg(`booot-g-${kind}`, withHalo(c, S, S, r, 1.2), r);
  }
  // Gap pin (no_path): paper disc, hand-drawn rust ring, rust center.
  {
    const S = 22;
    const [c, g] = canvas(S, S, r);
    g.translate(S / 2, S / 2);
    g.fillStyle = C.paper; g.beginPath(); g.arc(0, 0, 7.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.accent;
    g.fill(new Path2D(inkStroke(ring(7, { start: -1.4 }), { w: 1.9, vary: 0.2, amp: 0.12, seed: 37, taper: 2 })));
    g.beginPath(); g.arc(0, 0, 2.5, 0, Math.PI * 2); g.fill();
    addImg("booot-gap", withHalo(c, S, S, r, 1.2), r);
  }
  // Day-hike spur arrowhead (points north; rotated per feature), teal ink.
  {
    const S = 14;
    const [c, g] = canvas(S, S, r);
    g.translate(S / 2, S / 2 - 1); g.fillStyle = C.dayhike;
    g.fill(new Path2D(inkStroke([[-4, 4.2], [0, -2.6], [4, 4.4]], { w: 1.7, vary: 0.15, amp: 0.05, seed: 41, taper: 1.5 })));
    addImg("booot-spur-arrow", withHalo(c, S, S, r, 1.2), r);
  }
  // Colored-pencil band patterns, one per day tone.
  C.pencil.forEach((color, k) => addImg(`booot-pencil-${k}`, ...pencilPattern(color, 300 + k)));
}

/**
 * A seamless colored-pencil stroke for `line-pattern`. MapLibre stretches the
 * image's height to the line width and repeats it along the line, so the
 * image is a cross-section: an even light pass, diagonal hatching whose
 * pressure eases off at the edges, slightly ragged edges, and paper tooth.
 * Everything wraps horizontally (period = image width).
 */
function pencilPattern(color, seed) {
  const W = 72, H = 18; // CSS px; aspect sets the repeat length relative to line width
  const [c, g, r] = canvas(W, H, RATIO());
  const rand = rng(seed);
  // Ragged edges: periodic noise (integer frequencies over W).
  const waves = [1, 2, 3, 5].map((f) => [f, (0.6 / f) * (0.6 + rand()), rand() * 6.283]);
  const edge = (x, ph) => waves.reduce((v, [f, a, p]) => v + a * Math.sin(((x / W) * f * 6.283) + p + ph), 0);
  const top = (x) => 2.0 + 1.1 * edge(x, 0), bot = (x) => H - 2.0 - 1.1 * edge(x, 2.1);
  g.save();
  g.beginPath();
  g.moveTo(0, top(0));
  for (let x = 0; x <= W; x += 1) g.lineTo(x, top(x));
  for (let x = W; x >= 0; x -= 1) g.lineTo(x, bot(x));
  g.closePath();
  g.clip();
  // Pass 1: light even layer.
  g.fillStyle = color; g.globalAlpha = 0.62; g.fillRect(0, 0, W, H);
  // Pass 2: hatching (angle, spacing, pressure vary a little), drawn at x-W, x, x+W to wrap.
  g.strokeStyle = color; g.lineCap = "round";
  const a = (-62 * Math.PI) / 180, dx = Math.cos(a) * H * 1.4, dy = Math.sin(a) * H * 1.4;
  const n = 26; // strokes per period
  for (let k = 0; k < n; k++) {
    const x0 = (k / n) * W + (rand() - 0.5) * 1.2;
    const da = (rand() - 0.5) * 0.08;
    g.lineWidth = 0.9 + 0.5 * rand();
    g.globalAlpha = 0.6 + 0.4 * rand();
    for (const off of [-W, 0, W]) {
      g.beginPath();
      g.moveTo(x0 + off - dx / 2, H / 2 - dy / 2 + da * 10);
      g.lineTo(x0 + off + dx / 2, H / 2 + dy / 2 - da * 10);
      g.stroke();
    }
  }
  g.restore();
  // Pressure eases off toward the edges.
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    const v = Math.abs(y / c.height - 0.5) * 2; // 0 center → 1 edge
    const f = 1 - 0.35 * v * v;
    for (let x = 0; x < c.width; x++) img.data[(y * c.width + x) * 4 + 3] *= f;
  }
  g.putImageData(img, 0, 0);
  grain(c, { seed: seed + 1, strength: 0.45, cell: 1.5, periodic: true });
  return [c, r];
}

// ---------------------------------------------------------------------------
// On-demand images: day numerals and italic labels (styleimagemissing)
// ---------------------------------------------------------------------------

const fontsReady = (document.fonts?.load
  ? Promise.all([
    document.fonts.load('italic 400 12px "DM Sans"'),
    document.fonts.load('500 12px "IBM Plex Mono"'),
  ]).catch(() => {})
  : Promise.resolve());
let fontsLoaded = false;
const drawnEarly = new Set();

function dayMarkImage(n) {
  const S = 26, r = RATIO();
  const [c, g] = canvas(S, S, r);
  g.translate(S / 2, S / 2);
  g.fillStyle = C.paper; g.beginPath(); g.arc(0, 0, 10.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.ink;
  g.fill(new Path2D(inkStroke(ring(10.4), { w: 1.3, vary: 0.25, amp: 0.15, seed: 400 + n, taper: 3 })));
  g.font = `500 12px "IBM Plex Mono", ui-monospace, monospace`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(String(n), 0, 0.8);
  return [withHalo(c, S, S, r, 1), r];
}

/** Italic DM Sans label on a paper halo, the way B sets place names. */
function labelImage(kind, text) {
  const r = RATIO();
  const font = `italic 400 12px "DM Sans", system-ui, sans-serif`;
  const [m] = canvas(1, 1, 1);
  const mg = m.getContext("2d"); mg.font = font;
  const w = Math.ceil(mg.measureText(text).width) + 8, h = 18;
  const [c, g] = canvas(w, h, r);
  g.font = font; g.textBaseline = "middle"; g.lineJoin = "round";
  g.strokeStyle = C.surface; g.lineWidth = 3.5; g.globalAlpha = 0.92;
  g.strokeText(text, 4, h / 2 + 0.5);
  g.globalAlpha = 1;
  g.fillStyle = kind === "dayhike" ? C.dayhikeText : C.body;
  g.fillText(text, 4, h / 2 + 0.5);
  return [c, r];
}

function onImageMissing(e) {
  const id = e.id;
  if (!C) colors();
  let out = null;
  let m = /^booot-day-(\d+)$/.exec(id);
  if (m) out = dayMarkImage(+m[1]);
  else if ((m = /^booot-lbl:(\w+):(.*)$/s.exec(id))) out = labelImage(m[1], m[2]);
  else if (id.startsWith("booot-")) { addStaticImages(); return; }
  if (!out) return;
  if (!map.hasImage(id)) map.addImage(id, imageData(out[0]), { pixelRatio: out[1] });
  if (!fontsLoaded) drawnEarly.add(id);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const fs = (name) => ["boolean", ["feature-state", name], false];
/** active ? a : muted ? m : n */
const byState = (a, m, n) => ["case", fs("active"), a, fs("muted"), m, n];
/** Zoom-interpolated width with a per-state multiplier. */
const zoomWidth = (stops, { active = 1, muted = 1 } = {}) =>
  ["interpolate", ["exponential", 1.4], ["zoom"], ...stops.flatMap(([z, w]) => [z, byState(w * active, w * muted, w)])];

/** Day numeral offsets: 8 compass directions at 19 px (screen y down). */
const DIRS = Array.from({ length: 8 }, (_, k) => [Math.round(Math.sin((k * Math.PI) / 4) * 19), Math.round(-Math.cos((k * Math.PI) / 4) * 19)]);

const INK_W = [[9, 1.4], [11, 1.8], [13, 2.4], [15, 2.9], [17, 3.4]];
const BAND_W = [[9, 8], [11, 12], [13, 18], [15, 25], [17, 30]];
const casingW = (stops) => stops.map(([z, w]) => [z, w + 3]);

/** Adds the images and every trip layer on the "trip" source. Idempotent per style. */
export function addTripChartLayers() {
  colors();
  addStaticImages();
  const src = "trip";
  const t = (type) => ["==", ["get", "type"], type];
  const mode = ["get", "leg_mode"];
  const main = ["==", ["get", "kind"], "main"];
  const inkLine = ["all", t("route_leg"), main, ["!", ["in", mode, ["literal", ["manual", "straight"]]]]];

  // 1. Paper casing under the whole route, so it reads over the topo.
  map.addLayer({
    id: "trip-chart-casing", type: "line", source: src, filter: t("route_line"),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.paper, "line-width": zoomWidth(casingW(INK_W), { active: 1.2 }), "line-opacity": byState(0.95, 0.6, 0.9) },
  });
  // 2. Colored-pencil band under each day's stretch (unassigned routes get none).
  map.addLayer({
    id: "trip-chart-band", type: "line", source: src,
    filter: ["all", t("route_line"), main, [">=", ["get", "day_index"], 0]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-pattern": ["case", ["==", ["get", "tone"], 1], "booot-pencil-1", "booot-pencil-0"],
      "line-width": zoomWidth(BAND_W, { active: 1.15, muted: 0.9 }),
      "line-opacity": byState(1, 0.3, 0.92),
    },
  });
  // 3. Ink: trail legs solid; Shift legs dashed; real OSM gaps dotted rust.
  map.addLayer({
    id: "trip-chart-ink", type: "line", source: src, filter: inkLine,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.ink, "line-width": zoomWidth(INK_W, { active: 1.15, muted: 0.85 }), "line-opacity": byState(1, 0.5, 1) },
  });
  map.addLayer({
    id: "trip-chart-ink-manual", type: "line", source: src, filter: ["all", t("route_leg"), main, ["==", mode, "manual"]],
    layout: { "line-join": "round" },
    paint: { "line-color": C.ink, "line-width": zoomWidth(INK_W, { active: 1.15, muted: 0.85 }), "line-dasharray": [2.2, 1.6], "line-opacity": byState(1, 0.5, 1) },
  });
  map.addLayer({
    id: "trip-chart-ink-gap", type: "line", source: src, filter: ["all", t("route_leg"), ["==", mode, "straight"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.accent, "line-width": zoomWidth(INK_W.map(([z, w]) => [z, w * 1.15])), "line-dasharray": [0, 2], "line-opacity": byState(1, 0.5, 1) },
  });
  // 4. Day-hike spurs: dashed teal ink, an arrowhead where they end.
  map.addLayer({
    id: "trip-chart-spur", type: "line", source: src,
    filter: ["all", t("route_leg"), ["==", ["get", "kind"], "spur"], ["!=", mode, "straight"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.dayhike, "line-width": zoomWidth(INK_W.map(([z, w]) => [z, w * 0.85]), { active: 1.15 }), "line-dasharray": [2, 1.6], "line-opacity": byState(1, 0.45, 1) },
  });
  map.addLayer({
    id: "trip-chart-spur-arrow", type: "symbol", source: src, filter: t("spur_end"),
    layout: {
      "icon-image": "booot-spur-arrow", "icon-rotate": ["get", "bearing"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
    },
    paint: { "icon-opacity": byState(1, 0.45, 1) },
  });
  // Wide invisible line: an easy target for clicking a day.
  map.addLayer({
    id: "trip-chart-hit", type: "line", source: src, filter: ["all", t("route_line"), [">=", ["get", "day_index"], 0]],
    paint: { "line-color": C.ink, "line-width": 16, "line-opacity": 0 },
  });

  // 5. Labels (below the glyphs in the stack so glyphs are placed first and
  //    labels give way to them). Italic DM Sans images; side chosen per feature.
  const labelLayout = (extra = {}) => ({
    "icon-image": ["concat", "booot-lbl:", ["get", "label_kind"], ":", ["get", "name"]],
    "icon-anchor": ["get", "label_anchor"],
    // GeoJSON sources stringify array properties, so offsets come from scalars.
    "icon-offset": ["case",
      ["==", ["get", "label_anchor"], "left"],
      ["case", ["==", ["get", "label_kind"], "camp"], ["literal", [20, -7]], ["literal", [14, -7]]],
      ["case", ["==", ["get", "label_kind"], "camp"], ["literal", [-20, -7]], ["literal", [-14, -7]]]],
    "icon-allow-overlap": false,
    "icon-padding": 0,
    ...extra,
  });
  map.addLayer({
    id: "trip-chart-labels-minor", type: "symbol", source: src, minzoom: 12.5,
    filter: ["all", ["==", ["get", "chart_point"], true], ["!=", ["get", "label_kind"], "camp"], ["has", "name"], ["!=", ["get", "name"], ""]],
    layout: labelLayout({ "symbol-sort-key": ["get", "label_rank"] }),
    paint: { "icon-opacity": byState(1, 0.35, 1) },
  });
  map.addLayer({
    id: "trip-chart-labels", type: "symbol", source: src, minzoom: 10.5,
    filter: ["all", ["==", ["get", "chart_point"], true], ["==", ["get", "label_kind"], "camp"], ["has", "name"], ["!=", ["get", "name"], ""]],
    layout: labelLayout(),
    paint: { "icon-opacity": byState(1, 0.35, 1) },
  });

  // 6. Pins and glyphs, always shown (a navigation map never drops a camp).
  map.addLayer({
    id: "trip-gap-pins", type: "symbol", source: src, filter: t("route_gap"),
    layout: { "icon-image": "booot-gap", "icon-allow-overlap": true },
  });
  map.addLayer({
    id: "trip-chart-rings", type: "symbol", source: src, filter: t("trip_ring"),
    layout: { "icon-image": ["concat", "booot-g-", ["get", "ring"]], "icon-allow-overlap": true },
    paint: { "icon-opacity": byState(1, 0.5, 1) },
  });
  // Minor glyphs (viewpoints, hazards, other waypoints) wait for z12: at
  // trip scale they're noise next to camps and water.
  const MINOR = ["literal", ["scenic", "hazard", "meal", "dot"]];
  const pointLayer = (id, filter, extra = {}) => map.addLayer({
    id, type: "symbol", source: src, filter: ["all", ["==", ["get", "chart_point"], true], filter], ...extra,
    layout: {
      "icon-image": ["concat", "booot-g-", ["get", "glyph"]],
      "icon-anchor": ["case", ["in", ["get", "glyph"], ["literal", ["rest", "dot"]]], "center", "bottom"],
      "icon-offset": ["case", ["in", ["get", "glyph"], ["literal", ["rest", "dot"]]], ["literal", [0, 0]], ["literal", [0, PAD]]],
      "icon-allow-overlap": true,
      "symbol-sort-key": ["get", "glyph_rank"],
    },
    paint: { "icon-opacity": byState(1, 0.45, 1) },
  });
  pointLayer("trip-chart-points-minor", ["in", ["get", "glyph"], MINOR], { minzoom: 12 });
  pointLayer("trip-chart-points", ["!", ["in", ["get", "glyph"], MINOR]]);
  // 7. Circled day numerals at each day's start, set just behind it.
  map.addLayer({
    id: "trip-chart-days", type: "symbol", source: src, filter: t("day_mark"),
    layout: {
      "icon-image": ["concat", "booot-day-", ["to-string", ["get", "n"]]],
      "icon-offset": ["match", ["get", "dir"], ...DIRS.flatMap((d, k) => [k, ["literal", d]]), ["literal", DIRS[0]]],
      "icon-allow-overlap": true,
    },
    paint: { "icon-opacity": byState(1, 0.5, 1) },
  });
}

/**
 * Line layers for legs being drawn (route-drawing) and the live preview
 * (route-preview). Placed legs are inked like the saved route (without a
 * pencil band: they're not in a day yet). The preview is a pencil line,
 * thinner and lighter, so the click reads as inking it.
 */
export function drawingLegLayers(prefix, source, baseFilter, { preview = false } = {}) {
  if (!C) colors();
  const mode = ["get", "leg_mode"];
  const spur = ["==", ["get", "kind"], "spur"];
  const solid = ["!", ["in", mode, ["literal", ["manual", "straight"]]]];
  const inkColor = preview ? ["case", spur, C.dayhike, C.inkPencil] : ["case", spur, C.dayhike, C.ink];
  const w = preview ? INK_W.map(([z, v]) => [z, v * 0.8]) : INK_W;
  const widthExpr = ["interpolate", ["exponential", 1.4], ["zoom"], ...w.flatMap(([z, v]) => [z, v])];
  const layers = [];
  if (!preview) {
    layers.push({
      id: `${prefix}-casing`, type: "line", source, filter: ["all", baseFilter, ["!=", mode, "straight"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.paper, "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], ...w.flatMap(([z, v]) => [z, v + 3])], "line-opacity": 0.9 },
    });
  }
  layers.push(
    {
      id: `${prefix}-trail`, type: "line", source, filter: ["all", baseFilter, solid, ["!", spur]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": inkColor, "line-width": widthExpr, "line-opacity": preview ? 0.9 : 1 },
    },
    {
      id: `${prefix}-spur`, type: "line", source, filter: ["all", baseFilter, spur, ["!=", mode, "straight"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.dayhike, "line-width": widthExpr, "line-dasharray": [2, 1.6], "line-opacity": preview ? 0.75 : 1 },
    },
    {
      id: `${prefix}-manual`, type: "line", source, filter: ["all", baseFilter, ["==", mode, "manual"], ["!", spur]],
      layout: { "line-join": "round" },
      paint: { "line-color": inkColor, "line-width": widthExpr, "line-dasharray": [2.2, 1.6], "line-opacity": preview ? 0.9 : 1 },
    },
    {
      id: `${prefix}-straight`, type: "line", source, filter: ["all", baseFilter, ["==", mode, "straight"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.accent, "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], ...w.flatMap(([z, v]) => [z, v * 1.15])], "line-dasharray": [0, 2], "line-opacity": preview ? 0.75 : 1 },
    },
  );
  return layers;
}

/** Gap pin (no_path) for legs being drawn: the same hand-drawn rust ring. */
export function gapPinLayers(id, source, filter) {
  return [{ id, type: "symbol", source, filter, layout: { "icon-image": "booot-gap", "icon-allow-overlap": true } }];
}

/** Paint for the drawing vertices and the cursor, in the ink language. */
export function vertexPaint() {
  if (!C) colors();
  const pt = ["get", "point_type"];
  return {
    vertices: {
      "circle-radius": ["match", pt, "camp", 6, "dayhike", 5, "rest", 5, 3.5],
      "circle-color": ["match", pt, "camp", C.camp, "dayhike", C.dayhike, "rest", C.rest, C.paper],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": C.ink,
    },
    cursor: {
      "circle-radius": ["case", ["get", "snapped"], 4.5, 5.5],
      "circle-color": ["case", ["get", "snapped"], C.ink, C.paper],
      "circle-stroke-width": ["case", ["get", "snapped"], 2, 1.5],
      "circle-stroke-color": ["case", ["get", "snapped"], C.paper, C.inkSoft],
      "circle-opacity": 0.95,
    },
  };
}

// ---------------------------------------------------------------------------
// Overlay features (built on every TripManager.render(), via planning.js)
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
const local = (lat) => [Math.cos(lat * RAD) * 111320, 110574];
const distM = (a, b) => { const [kx, ky] = local((a[1] + b[1]) / 2); return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky); };
/** Unit vector (east, north) from coords[0] to the first point ≥ `m` meters along. */
function heading(coords, m = 120) {
  const a = coords[0];
  let b = coords[coords.length - 1];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) { acc += distM(coords[i - 1], coords[i]); if (acc >= m) { b = coords[i]; break; } }
  const [kx, ky] = local(a[1]);
  const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}
const bearingDeg = (a, b) => {
  const [kx, ky] = local(a[1]);
  return (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) / RAD + 360) % 360;
};

const GLYPH_OF = (p) => {
  const t = p.type === "waypoint" ? p.subtype : (p.point_type || p.type);
  if (t === "camp" || t === "water" || t === "dayhike" || t === "rest" || t === "scenic" || t === "hazard" || t === "meal") return t;
  return "dot";
};
const GLYPH_RANK = { camp: 0, dayhike: 1, water: 2, rest: 3, hazard: 4, scenic: 5, meal: 6, dot: 7 };

// Day state for highlighting and framing (rebuilt with the overlay).
let fidDay = new Map();     // fid → day index (-1 = unassigned)
let dayBounds = [];         // day index → [w, s, e, n] or null
let activeDay = null;

/**
 * planning.js buildRoutingOverlay() hands its leg + gap features here; this
 * adds day info and the chart's own features (route lines for casing/band,
 * glyph points, labels, day numerals, start/end rings, spur ends).
 */
export function tripChartOverlay(trip, legFeatures) {
  const out = [];
  const nextFid = (() => { let n = 0; return () => `c${n++}`; })();
  fidDay = new Map();
  if (!trip) return out;
  const days = trip.days || [];
  const dayOf = new Map();
  days.forEach((d, i) => (d.features || []).forEach((id) => dayOf.set(id, i)));
  const byId = new Map((trip.features || []).map((f) => [f.properties?._id, f]));
  const push = (f, day) => {
    const fid = nextFid();
    f.properties.fid = fid;
    f.properties.day_index = day;
    f.properties.tone = day >= 0 ? day % 2 : -1;
    fidDay.set(fid, day);
    out.push(f);
  };

  // Legs from planning.js (routes with `segments`).
  const withLegs = new Set();
  for (const f of legFeatures) {
    const day = dayOf.get(f.properties._id) ?? -1;
    if (f.properties.type === "route_leg") withLegs.add(f.properties._id);
    push(f, day);
  }

  const lines = (trip.features || []).filter((f) => (f.properties?.type === "route" || f.properties?.type === "dayhike_spur") && f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2);
  const spurEnds = [];
  for (const f of lines) {
    const p = f.properties;
    const kind = p.type === "route" ? "main" : "spur";
    const day = dayOf.get(p._id) ?? -1;
    const coords = f.geometry.coordinates;
    // Legacy routes (no segments): one ink leg.
    if (!withLegs.has(p._id)) push({ type: "Feature", geometry: f.geometry, properties: { type: "route_leg", _id: p._id, leg_mode: "trail", kind } }, day);
    push({ type: "Feature", geometry: f.geometry, properties: { type: "route_line", _id: p._id, kind } }, day);
    if (kind === "spur") spurEnds.push({ coords, day });
  }

  // Ordered main routes: by day, then unassigned in feature order.
  const mains = lines.filter((f) => f.properties.type === "route");
  const ordered = [];
  days.forEach((d, i) => (d.features || []).forEach((id) => { const f = byId.get(id); if (f && mains.includes(f)) ordered.push([f, i]); }));
  for (const f of mains) if (!ordered.some(([g]) => g === f)) ordered.push([f, -1]);

  const marks = [];
  // Day numerals at each day's start, set back along the way the day leaves.
  dayBounds = days.map(() => null);
  days.forEach((d, i) => {
    const feats = (d.features || []).map((id) => byId.get(id)).filter(Boolean);
    for (const f of feats) {
      const cs = f.geometry?.type === "LineString" ? f.geometry.coordinates : f.geometry?.type === "Point" ? [f.geometry.coordinates] : [];
      for (const [x, y] of cs) {
        const b = dayBounds[i] || (dayBounds[i] = [x, y, x, y]);
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
      }
    }
    const route = feats.find((f) => f.properties?.type === "route" && f.geometry?.type === "LineString");
    const at = route ? route.geometry.coordinates[0] : feats.find((f) => f.geometry?.type === "Point")?.geometry.coordinates;
    if (!at) return;
    // Set behind the start (opposite the way the day leaves), never straight
    // up, where the previous night's tent stands. dir: 0 = N, 1 = NE … 7 = NW.
    let dir = 7;
    if (route) {
      const [ux, uy] = heading(route.geometry.coordinates);
      dir = ((Math.round(Math.atan2(-ux, -uy) / (Math.PI / 4)) % 8) + 8) % 8;
      if (dir === 0) dir = ux > 0 ? 7 : 1;
    }
    marks.push({ at, dir });
    push({ type: "Feature", geometry: { type: "Point", coordinates: at }, properties: { type: "day_mark", n: i + 1, dir } }, i);
  });

  // Points: glyph + label features carrying the original properties (popups,
  // delete mode read them).
  const points = (trip.features || []).filter((f) => f.geometry?.type === "Point" && f.properties?.type !== "route_gap");
  for (const f of points) {
    const p = f.properties;
    const glyph = GLYPH_OF(p);
    if (glyph === "dayhike") {
      // A day-hike point at a spur's end replaces the arrowhead there.
      for (const s of spurEnds) if (distM(s.coords.at(-1), f.geometry.coordinates) < 40) s.hasPoint = true;
    }
    const [anchor] = labelSide(f.geometry.coordinates, lines, marks);
    push({
      type: "Feature", geometry: f.geometry,
      properties: {
        ...p, chart_point: true, glyph, glyph_rank: GLYPH_RANK[glyph] ?? 9,
        label_kind: glyph === "camp" ? "camp" : glyph === "dayhike" ? "dayhike" : "other",
        label_rank: GLYPH_RANK[glyph] ?? 9, label_anchor: anchor,
      },
    }, dayOf.get(p._id) ?? -1);
  }
  for (const s of spurEnds) {
    if (s.hasPoint || s.coords.length < 2) continue;
    const e = s.coords.at(-1);
    let k = s.coords.length - 2;
    while (k > 0 && distM(s.coords[k], e) < 25) k--;
    push({ type: "Feature", geometry: { type: "Point", coordinates: e }, properties: { type: "spur_end", bearing: bearingDeg(s.coords[k], e) } }, s.day);
  }

  // Start / end rings.
  if (ordered.length) {
    const [f0, d0] = ordered[0], [f1, d1] = ordered.at(-1);
    const a = f0.geometry.coordinates[0], b = f1.geometry.coordinates.at(-1);
    const loop = distM(a, b) < 60;
    push({ type: "Feature", geometry: { type: "Point", coordinates: a }, properties: { type: "trip_ring", ring: loop ? "end" : "start" } }, d0);
    if (!loop) push({ type: "Feature", geometry: { type: "Point", coordinates: b }, properties: { type: "trip_ring", ring: "end" } }, d1);
  }

  if (activeDay != null && activeDay >= days.length) activeDay = null;
  queueMicrotask(applyActiveState);
  return out;
}

/**
 * Put a label on the side of its glyph away from the route: compare how much
 * route lies east vs west within ~300 m.
 */
function labelSide(pt, lines, marks) {
  const [kx] = local(pt[1]);
  for (const m of marks) {
    if (distM(m.at, pt) > 30) continue;
    if (m.dir >= 1 && m.dir <= 3) return ["right"];
    if (m.dir >= 5 && m.dir <= 7) return ["left"];
  }
  let east = 0, west = 0;
  for (const f of lines) for (const c of f.geometry.coordinates) {
    if (Math.abs(c[1] - pt[1]) > 0.003 || Math.abs(c[0] - pt[0]) > 0.004) continue;
    const dx = (c[0] - pt[0]) * kx;
    if (dx > 15) east++; else if (dx < -15) west++;
  }
  return east <= west ? ["left"] : ["right"];
}

// ---------------------------------------------------------------------------
// Active day
// ---------------------------------------------------------------------------

function applyActiveState() {
  if (!map.getSource("trip")) return;
  for (const [fid, day] of fidDay) {
    map.setFeatureState({ source: "trip", id: fid }, {
      active: activeDay != null && day === activeDay,
      muted: activeDay != null && day !== activeDay,
    });
  }
}

function setActiveDay(index, { frame = false } = {}) {
  activeDay = Number.isInteger(index) && index >= 0 ? index : null;
  applyActiveState();
  if (frame && activeDay != null) frameDayIfOffscreen(activeDay);
}

/** Ease to the day only when most of it is off-screen (beside the panel). */
function frameDayIfOffscreen(i) {
  const b = dayBounds[i];
  if (!b) return;
  const box = map.getContainer().getBoundingClientRect();
  let right = box.width;
  const panel = document.getElementById("tripPanel");
  if (panel?.classList.contains("open")) {
    const pr = panel.getBoundingClientRect();
    if (pr.left > box.left + 240 && pr.left < box.right) right = pr.left - box.left;
  }
  const p0 = map.project([b[0], b[3]]), p1 = map.project([b[2], b[1]]);
  const area = Math.max(1, (p1.x - p0.x) * (p1.y - p0.y));
  const ix = Math.max(0, Math.min(p1.x, right) - Math.max(p0.x, 0));
  const iy = Math.max(0, Math.min(p1.y, box.height) - Math.max(p0.y, 0));
  if ((ix * iy) / area >= 0.5) return;
  const pad = 64;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], {
    padding: { top: pad, bottom: pad, left: pad, right: pad + (box.width - right) },
    maxZoom: 15,
    duration: reducedMotion() ? 0 : 700,
  });
}

const emitted = new WeakSet();
function emitActiveDay(index) {
  const days = TripManager.currentTrip?.days || [];
  const ev = new CustomEvent("booot:active-day", {
    detail: { dayIndex: index, dayId: index != null ? days[index]?.id ?? null : null, source: "map" },
  });
  emitted.add(ev);
  window.dispatchEvent(ev);
}

function onActiveDayEvent(e) {
  if (emitted.has(e)) return; // our own click
  const d = e.detail || {};
  const days = TripManager.currentTrip?.days || [];
  let index = null;
  if (d.dayId != null) { const k = days.findIndex((x) => x.id === d.dayId); index = k >= 0 ? k : null; }
  else if (Number.isInteger(d.dayIndex)) index = d.dayIndex;
  setActiveDay(index, { frame: true });
}

/** Click a day's line → make it the active day (again → clear). */
function onMapClick(e) {
  if (isDrawingRoute || isDeleteMode || !map.getLayer("trip-chart-hit")) return;
  const pad = 3, bbox = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
  if (map.queryRenderedFeatures(bbox, { layers: [...TRIP_POINT_LAYERS, "trip-gap-pins", "trip-chart-days"] }).length) return;
  const hit = map.queryRenderedFeatures(bbox, { layers: DAY_LINE_LAYERS.filter((id) => map.getLayer(id)) })
    .find((f) => Number.isInteger(f.properties.day_index) && f.properties.day_index >= 0);
  if (!hit) return;
  const index = hit.properties.day_index === activeDay ? null : hit.properties.day_index;
  setActiveDay(index);
  emitActiveDay(index);
}

let inited = false;
/** One-time wiring (map events survive setStyle; layers/images don't). */
export function initTripChart() {
  if (inited) return;
  inited = true;
  map.on("styleimagemissing", onImageMissing);
  window.addEventListener("booot:active-day", onActiveDayEvent);
  map.on("click", onMapClick);
  map.on("mousemove", "trip-chart-hit", () => { if (!isDrawingRoute && !isDeleteMode) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "trip-chart-hit", () => { if (!isDrawingRoute && !isDeleteMode) map.getCanvas().style.cursor = ""; });
  // Click on a day marker focuses that day too.
  map.on("click", "trip-chart-days", (e) => {
    if (isDrawingRoute || isDeleteMode) return;
    const i = e.features[0]?.properties.day_index;
    if (!Number.isInteger(i)) return;
    const index = i === activeDay ? null : i;
    setActiveDay(index);
    emitActiveDay(index);
  });
  fontsReady.then(() => {
    fontsLoaded = true;
    // Redraw numerals/labels drawn before the web fonts arrived.
    for (const id of drawnEarly) if (map.hasImage(id)) { map.removeImage(id); onImageMissing({ id }); }
    drawnEarly.clear();
  });
}

/** Debug handle (window.__outhere.tripChart). */
export const tripChartDebug = {
  get activeDay() { return activeDay; },
  get dayBounds() { return dayBounds; },
};

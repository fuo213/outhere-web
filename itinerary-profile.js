/**
 * Itinerary profile: the trip's elevation drawn as a sketchbook page.
 *
 * Direction A from design/explorations/itinerary/ (sketchbook.html), built
 * from the live trip instead of the fixture:
 *   buildItinerary(trip)            -> day-by-day model (miles, elevation, stops)
 *   drawProfile(model, W, opts)     -> SVG markup at the real pixel width W
 *
 * Pure: no DOM, no map. The panel controller (itinerary-panel.js) owns the
 * sticky header, the active day and the shared `booot:active-day` signal.
 *
 * Elevation comes from each route's `elevation_profile` (feet, samples spaced
 * evenly by distance: about one per 100 m, up to 800 per fetched route and
 * twice that after "Return the same way"; see elevation.js), so sample k
 * of n sits at k/(n-1) of the route's length. Routes whose profile hasn't
 * arrived yet are drawn as a pencil "skeleton" in the same hand.
 */

import { inkStroke, wobble, chaikin, simplify, hatch, pencilDefs, glyph } from "./sketch.js";

const MI = 1609.344, RAD = Math.PI / 180, R = 6371008.8;

const hav = (a, b) => {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const fmt = {
  mi: (v) => `${v.toFixed(1)} mi`,
  ft: (v) => `${Math.round(v).toLocaleString("en-US")} ft`,
  gain: (v) => `+${Math.round(v).toLocaleString("en-US")}`,
  loss: (v) => `−${Math.round(v).toLocaleString("en-US")}`,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function cumMiles(coords) {
  const c = [0];
  for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + hav(coords[i - 1], coords[i]) / MI);
  return c;
}

/** Miles along a polyline to the point nearest `p`, plus that distance (m). */
function project(coords, cum, p) {
  const kx = Math.cos(p[1] * RAD) * 111320, ky = 110574;
  let at = 0, bd = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * kx, ay = (coords[i - 1][1] - p[1]) * ky;
    const bx = (coords[i][0] - p[0]) * kx, by = (coords[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bd) { bd = d; at = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
  }
  return { at, d: bd };
}

/**
 * Drawing kind of a feature: waypoints by subtype (water, hazard, scenic,
 * resupply), everything else by point_type/type (route, camp, dayhike, rest,
 * dayhike_spur). Matches getDisplayType() in trip-panel.js for non-waypoints.
 */
export function kindOf(p) {
  if (p.type === "waypoint") return p.subtype || "scenic";
  return p.point_type || p.type;
}

const isRoute = (f) => f && kindOf(f.properties) === "route" &&
  f.geometry?.type === "LineString" && (f.geometry.coordinates?.length || 0) >= 2;

/** Meal stops are derived from notes for now (no schema field yet). */
export const mentionsMeal = (s) => /\b(breakfast|lunch|dinner|supper|snack)\b/i.test(s || "");

/**
 * Day-by-day model of the trip for the profile and the story.
 * mode: "days" (routes assigned to days), "loose" (routes exist but none is in
 * a day yet: drawn as one neutral stretch), "empty" (nothing drawn yet).
 */
export function buildItinerary(trip) {
  if (!trip) return { mode: "empty", days: [], total: 0 };
  const byId = new Map(trip.features.map((f) => [f.properties._id, f]));
  const dayDefs = (trip.days || []).map((d, i) => ({ d, i, feats: (d.features || []).map((id) => byId.get(id)).filter(Boolean) }));
  const looseRoutes = (trip.unassigned || []).map((id) => byId.get(id)).filter(isRoute);
  const anyAssigned = dayDefs.some((g) => g.feats.some(isRoute));
  const mode = anyAssigned ? "days" : looseRoutes.length ? "loose" : "empty";
  if (mode === "empty") return { mode, days: [], total: 0, looseCount: 0 };

  const groups = mode === "days" ? dayDefs : [{ d: { id: null, date: null }, i: 0, feats: looseRoutes, loose: true }];
  let routeMiles = 0;
  for (const g of groups) {
    g.pieces = g.feats.filter(isRoute).map((f) => {
      const coords = f.geometry.coordinates, cum = cumMiles(coords);
      const prof = f.properties.elevation_profile;
      routeMiles += cum.at(-1);
      return {
        id: f.properties._id, coords, cum, miles: cum.at(-1),
        profile: Array.isArray(prof) && prof.length >= 2 && prof.every(Number.isFinite) ? prof : null,
        segments: Array.isArray(f.properties.segments) ? f.properties.segments : [],
        gain: f.properties.elevation_gain_ft || 0, loss: f.properties.elevation_loss_ft || 0,
      };
    });
  }
  // A day with no route between routed days still gets a little room on the
  // page (a rest day). Unplanned days after the last route take none.
  const emptyW = routeMiles > 0 ? Math.max(routeMiles * 0.06, 0.2) : 1;
  let lastRouted = -1;
  groups.forEach((g, k) => { if (g.pieces.length) lastRouted = k; });

  let mi0 = 0;
  const days = groups.map((g, gk) => {
    const startMi = mi0;
    let off = 0;
    for (const p of g.pieces) { p.startMi = mi0 + off; off += p.miles; }
    const width = g.pieces.length ? off : gk > lastRouted ? 0 : emptyW;
    const along = (pt) => {
      let best = null;
      for (const p of g.pieces) {
        const r = project(p.coords, p.cum, pt);
        if (!best || r.d < best.d) best = { d: r.d, mi: p.startMi + r.at };
      }
      return best ? best.mi : startMi + width / 2;
    };
    // 1.2 trips hand over their stops already placed (per pass, per leg).
    const stops = g.d._stops ? g.d._stops.map((s) => ({ ...s, mi: startMi + s.dayMi })) : g.feats
      .filter((f) => !isRoute(f) && f.geometry?.type === "Point" && Array.isArray(f.geometry.coordinates))
      .map((f) => {
        const p = f.properties;
        const mi = along(f.geometry.coordinates);
        return { id: p._id, kind: kindOf(p), name: p.name || "", notes: p.notes || "", mi, dayMi: mi - startMi };
      });
    const spurs = g.feats
      .filter((f) => kindOf(f.properties) === "dayhike_spur" && f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2)
      .map((f) => {
        const c = f.geometry.coordinates;
        const point = stops.find((s) => s.kind === "dayhike");
        return { id: f.properties._id, at: along(c[0]), rt: 2 * cumMiles(c).at(-1), name: point?.name || f.properties.name || "Day hike" };
      });
    const gaps = [];
    for (const p of g.pieces) {
      for (const s of p.segments) {
        if (s.mode === "trail" || !Array.isArray(s.coord_range)) continue;
        const [a, b] = s.coord_range;
        if (!(a >= 0 && b < p.cum.length && b > a)) continue;
        const gap = { from: p.startMi + p.cum[a], to: p.startMi + p.cum[b], mode: s.mode, reason: s.reason || null };
        const last = gaps.at(-1);
        if (last && gap.from - last.to < 0.02) { last.to = gap.to; if (gap.reason === "no_path") last.reason = "no_path"; }
        else gaps.push(gap);
      }
    }
    mi0 += width;
    return {
      i: g.i, n: g.i + 1, id: g.d.id ?? null, date: g.d.date ?? null, loose: !!g.loose,
      fromM: Number.isFinite(g.d._fromM) ? g.d._fromM : null, // 1.2: metres along the line where the day starts
      startMi, endMi: mi0, routeMiles: off, empty: !g.pieces.length, pieces: g.pieces, stops, spurs, gaps,
    };
  });

  let hi = null, lo = null, hasAll = true, hasAny = false;
  for (const d of days) for (const p of d.pieces) {
    if (!p.profile) { hasAll = false; continue; }
    hasAny = true;
    const n = p.profile.length;
    p.profile.forEach((ft, k) => {
      const mi = p.startMi + (k / (n - 1)) * p.miles;
      if (!hi || ft > hi.ft) hi = { mi, ft };
      if (!lo || ft < lo.ft) lo = { mi, ft };
    });
  }
  // Rest days sit at the elevation where the previous day ended.
  let lastFt = null;
  for (const d of days) {
    if (d.empty) { d.restFt = lastFt; continue; }
    const p = d.pieces.at(-1);
    lastFt = p.profile ? p.profile.at(-1) : null;
  }
  const elevAt = (mi) => {
    for (const d of days) {
      if (d.empty && d.endMi > d.startMi && mi > d.startMi + 1e-9 && mi < d.endMi - 1e-9) return d.restFt;
    }
    for (const d of days) for (const p of d.pieces) {
      if (mi < p.startMi - 1e-9 || mi > p.startMi + p.miles + 1e-9) continue;
      if (!p.profile) return null;
      const n = p.profile.length, t = p.miles ? ((mi - p.startMi) / p.miles) * (n - 1) : 0;
      const k = Math.max(0, Math.min(n - 2, Math.floor(t)));
      return p.profile[k] + (t - k) * (p.profile[k + 1] - p.profile[k]);
    }
    return null;
  };
  return {
    mode, days, total: mi0, routeMiles, hi, lo, elevAt,
    gain: days.reduce((a, d) => a + d.pieces.reduce((b, p) => b + p.gain, 0), 0),
    loss: days.reduce((a, d) => a + d.pieces.reduce((b, p) => b + p.loss, 0), 0),
    hasElevation: hasAny, complete: hasAll,
    pendingIds: days.flatMap((d) => d.pieces.filter((p) => !p.profile).map((p) => p.id)),
    looseCount: mode === "days" ? looseRoutes.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Reading the drawing back: a pixel on the profile is a metre of the line
// ---------------------------------------------------------------------------

/** Horizontal layout shared by drawProfile and the pointer code. */
export function profileX(m, W) {
  const L = 6, Rr = W < 420 ? 8 : 12, plotW = W - L - Rr;
  return { L, plotW, X: (mi) => L + (mi / (m.total || 1)) * plotW, mi: (x) => Math.max(0, Math.min(m.total, ((x - L) / plotW) * (m.total || 1))) };
}

/**
 * The spot on the line under a profile mile. The profile is the days laid end
 * to end (rest days take a little room), so the day under the mile says which
 * pass of an out-and-back is meant. Null when the model has no line metres
 * (a 1.1 trip) or the mile is on no day. A rest day gives its camp's metre
 * with `rest: true` (nothing to place there).
 * @returns {{ m: number, mi: number, ft: number|null, day: object, rest: boolean }|null}
 */
export function lineSpotAtMile(model, mi) {
  if (!model || model.mode !== "days") return null;
  const days = model.days.filter((d) => d.endMi > d.startMi && d.fromM != null);
  let day = days.find((d) => mi >= d.startMi && mi <= d.endMi);
  if (!day) return null;
  // A mile exactly on a boundary belongs to the day that starts there (unless it is the last).
  const next = days.find((d) => d !== day && d.startMi === mi);
  if (next) day = next;
  const rest = day.empty;
  const m = rest ? day.fromM : day.fromM + (Math.max(day.startMi, Math.min(day.endMi, mi)) - day.startMi) * MI;
  return { m, mi, ft: model.elevAt(mi), day, rest };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Pencil tone per day: alternating sage and dust (exploration A's choice). */
export const toneFor = (i, loose = false) => (loose ? "var(--pencil-loose)" : i % 2 ? "var(--pencil-b)" : "var(--pencil-a)");

/** Hand-drawn pencil rule for a day header, in the day's tone. */
export function ruleSVG(i) {
  const pts = wobble([[1, 3], [200, 3.2]], { amp: 0.6, seed: 40 + i });
  return `<svg class="itin-rule" viewBox="0 0 201 6" preserveAspectRatio="none" aria-hidden="true"><path d="M${pts.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L")}" fill="none" stroke="${toneFor(i)}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

const pathD = (pts) => "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L");

/** Mile tick spacing that keeps labels at least ~minPx apart. */
function tickStep(total, plotW, minPx) {
  for (const s of [0.5, 1, 2, 5, 10, 20, 25, 50, 100]) if ((s / total) * plotW >= minPx) return s;
  return 200;
}

/**
 * Draw the profile. `opts`:
 *   height    full-mode height in px (the controller sizes it to the panel)
 *   compact   draw the slim strip used while a route is being drawn
 *   active    0-based index of the active day, or null
 *   failedIds route ids whose elevation is not coming (drawn flat, labeled)
 *   reveal    route ids whose elevation just arrived (ink draws in once)
 */
export function drawProfile(m, W, { height = 220, compact = false, active = null, failedIds = new Set(), reveal = new Set() } = {}) {
  const narrow = W < 420;
  const H = compact ? 46 : height;
  const { L, plotW: _pw } = profileX(m, W);
  const Rr = narrow ? 8 : 12;
  const top = compact ? 12 : narrow ? 60 : 66;
  const base = compact ? H - 6 : H - 30;
  const plotW = W - L - Rr;
  const X = (mi) => L + (mi / (m.total || 1)) * plotW;

  // Vertical domain with a little headroom; flat trips don't get exaggerated wildly.
  let loD = 0, hiD = 1;
  if (m.hasElevation) {
    const range = Math.max(m.hi.ft - m.lo.ft, 160);
    const mid = (m.hi.ft + m.lo.ft) / 2;
    loD = Math.min(m.lo.ft, mid - range / 2) - range * (compact ? 0.08 : 0.28);
    hiD = Math.max(m.hi.ft, mid + range / 2) + range * 0.03;
  }
  const Y = (ft) => top + ((hiD - ft) / (hiD - loD)) * (base - top);
  const flatY = m.hasElevation ? Y((m.hi.ft + m.lo.ft) / 2) : top + (base - top) * 0.55;
  const yAt = (mi) => { const ft = m.elevAt(mi); return ft == null ? flatY : Y(ft); };

  // Ink runs: consecutive pieces with elevation; skeleton pieces separately.
  const runs = [], skeletons = [];
  let cur = null;
  for (const d of m.days) {
    for (const p of d.pieces) {
      if (!p.profile) { cur = null; skeletons.push({ p, failed: failedIds.has(p.id) }); continue; }
      const n = p.profile.length;
      const pts = p.profile.map((ft, k) => [X(p.startMi + (k / (n - 1)) * p.miles), Y(ft)]);
      if (cur && Math.abs(cur.pts.at(-1)[0] - pts[0][0]) < 0.5) { cur.pts.push(...pts.slice(1)); cur.ids.push(p.id); }
      else { cur = { pts, ids: [p.id] }; runs.push(cur); }
    }
    if (d.empty) cur = null;
  }
  for (const r of runs) r.line = chaikin(simplify(r.pts, compact ? 0.6 : 0.35), 1);
  const allLine = runs.flatMap((r) => r.line);
  for (const s of skeletons) s.line = [[X(s.p.startMi), flatY], [X(s.p.startMi + s.p.miles), flatY]];
  const lineMinY = (x0, x1) => {
    let v = Infinity;
    for (const [x, y] of allLine) if (x >= x0 - 2 && x <= x1 + 2) v = Math.min(v, y);
    for (const s of skeletons) if (s.line[1][0] >= x0 && s.line[0][0] <= x1) v = Math.min(v, flatY);
    return v;
  };

  let defs = pencilDefs("ip");
  // Pencil shading clipped to the area under the ink (a hair out of register).
  const areaD = runs.map((r, k) => {
    const t = wobble(r.line, { amp: 0.9, seed: 9 + k }).map(([x, y]) => [x + 0.7, y + 1.4]);
    return `M${t[0][0].toFixed(1)} ${base}` + t.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("") + `L${t.at(-1)[0].toFixed(1)} ${base}Z`;
  }).join("");
  defs += `<clipPath id="ip-area"><path d="${areaD || "M0 0Z"}"/></clipPath>
    <linearGradient id="ip-press" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.8"/><stop offset="1" stop-color="#fff" stop-opacity="0.2"/></linearGradient>
    <mask id="ip-pressure" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="0" y="${top - 10}" width="${W}" height="${base - top + 12}" fill="url(#ip-press)"/></mask>`;

  // Day bands (pencil), with a denser "boost" layer shown on the active day.
  let bands = "", hits = "", tags = "", dividers = "";
  const tagFull = m.mode === "days" && !compact && m.days.every((d) => d.endMi === d.startMi || X(d.endMi) - X(d.startMi) >= (narrow ? 38 : 46));
  for (const d of m.days) {
    const x0 = X(d.startMi), x1 = X(d.endMi), tone = toneFor(d.i, d.loose);
    const isA = active === d.i;
    const first = d === m.days[0];
    if (d.endMi === d.startMi) continue; // an unplanned day after the last route: not on the page
    defs += `<clipPath id="ip-band${d.i}"><rect x="${(x0 + (first ? -2 : 0.9)).toFixed(1)}" y="0" width="${Math.max(0, x1 - x0 - (first ? -2 : 0.9) - 0.9).toFixed(1)}" height="${H}"/></clipPath>`;
    if (!d.empty) {
      bands += `<g class="band${isA ? " is-active" : ""}" data-i="${d.i}" clip-path="url(#ip-band${d.i})"><g clip-path="url(#ip-area)" mask="url(#ip-pressure)">
        <rect x="${(x0 - 2).toFixed(1)}" y="${top - 10}" width="${(x1 - x0 + 4).toFixed(1)}" height="${base - top + 12}" fill="${tone}" fill-opacity="0.26" filter="url(#ip-grain-soft)"/>
        <g stroke="${tone}" fill="none" stroke-linecap="round" filter="url(#ip-grain)">${hatch([x0 - 2, top - 12, x1 + 2, base + 2], { spacing: 2.3, angle: -63 + (d.i % 2) * 6, seed: 21 + d.i, w: 1, minO: 0.55, maxO: 1 })}</g>
        <g class="band-boost" stroke="${tone}" fill="none" stroke-linecap="round" filter="url(#ip-grain)">
          <rect x="${(x0 - 2).toFixed(1)}" y="${top - 10}" width="${(x1 - x0 + 4).toFixed(1)}" height="${base - top + 12}" fill="${tone}" fill-opacity="0.3" stroke="none"/>
          ${hatch([x0 - 2, top - 12, x1 + 2, base + 2], { spacing: 2.2, angle: -57 + (d.i % 2) * 6, seed: 51 + d.i, w: 1, minO: 0.5, maxO: 0.9 })}
        </g>
      </g></g>`;
    } else if (!compact) {
      // A day with no route: a short pencil dash at rest height, nothing to climb.
      if (x1 - x0 < 1) continue;
      const y = d.restFt != null ? Y(d.restFt) : flatY;
      bands += `<g class="band band--empty${isA ? " is-active" : ""}" data-i="${d.i}"><path d="${pathD(wobble([[x0 + 3, y], [x1 - 3, y]], { amp: 0.4, seed: 70 + d.i }))}" stroke="${tone}" stroke-width="2" stroke-linecap="round" fill="none" stroke-dasharray="2 3"/></g>`;
    }
    // Dividers between days: pencil hairlines from the line to the baseline.
    if (!first && !compact) {
      const y = yAt(d.startMi);
      dividers += `<path d="${pathD(wobble([[x0, y + 3], [x0 + 0.3, base]], { amp: 0.3, seed: 60 + d.i }))}" stroke="var(--sketch-ink-soft)" stroke-width="0.8" stroke-dasharray="1.4 2.8" fill="none"/>`;
    }
    if (m.mode !== "days") continue;
    // Hit target + tag: click a band to go to that day.
    const cx = (x0 + x1) / 2, bw = x1 - x0;
    hits += `<rect class="day-hit" data-i="${d.i}" x="${x0.toFixed(1)}" y="0" width="${Math.max(bw, 1).toFixed(1)}" height="${H}" fill="transparent" role="button" tabindex="-1" aria-label="Go to day ${d.n}"><title>Day ${d.n}</title></rect>`;
    if (compact) {
      if (bw >= 16) tags += `<text class="sk-num halo day-tag${isA ? " is-active" : ""}" data-i="${d.i}" x="${(x0 + 4).toFixed(1)}" y="${H - 9}">${d.n}</text>`;
      continue;
    }
    if (tagFull) {
      const tw = narrow ? 34 : 40;
      const tx = Math.max(x0 + 2 + tw / 2, Math.min(x1 - 2 - tw / 2, cx));
      const miles = d.empty ? "rest" : narrow ? d.routeMiles.toFixed(1) : fmt.mi(d.routeMiles);
      const ul = wobble([[tx - 17, 19], [tx + 17, 19.4]], { amp: 0.45, seed: 90 + d.i });
      tags += `<g class="day-tag${isA ? " is-active" : ""}" data-i="${d.i}">
        <text class="sk-label" x="${tx.toFixed(1)}" y="14" text-anchor="middle">Day ${d.n}</text>
        <path class="day-mark" d="${pathD(ul)}" stroke="${tone}" stroke-width="2.4" stroke-linecap="round" fill="none"/>
        <text class="sk-num" x="${tx.toFixed(1)}" y="32" text-anchor="middle">${miles}</text>
      </g>`;
    } else {
      // Crowded (many days): numbers only, and the active day's full label
      // appears on its own row so it never collides with a neighbor.
      if (bw >= 13) tags += `<text class="sk-num day-tag${isA ? " is-active" : ""}" data-i="${d.i}" x="${cx.toFixed(1)}" y="14" text-anchor="middle">${d.n}</text>`;
      const label = `Day ${d.n}${d.empty ? "" : ` · ${fmt.mi(d.routeMiles)}`}`;
      const w = label.length * 6.2;
      const lx = Math.max(w / 2 + 2, Math.min(W - w / 2 - 2, cx));
      tags += `<g class="day-marker${isA ? " is-active" : ""}" data-i="${d.i}">
        <text class="sk-label halo" x="${lx.toFixed(1)}" y="33" text-anchor="middle">${esc(label)}</text>
        <path d="${pathD(wobble([[cx - 6, 20], [cx, 25.5], [cx + 6, 20]], { amp: 0.2, seed: 95 + d.i }))}" stroke="${tone}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </g>`;
    }
  }

  // Ink: the profile line, with off-network legs dotted.
  const gaps = m.days.flatMap((d) => d.gaps);
  const inGap = (mi) => gaps.some((g) => mi > g.from && mi < g.to);
  let ink = "";
  runs.forEach((r, k) => {
    const pieces = [[]];
    for (const p of r.line) {
      const mi = ((p[0] - L) / plotW) * m.total;
      if (inGap(mi)) { if (pieces.at(-1).length) pieces.push([]); continue; }
      pieces.at(-1).push(p);
    }
    const cls = r.ids.some((id) => reveal.has(id)) ? ' class="sk-reveal"' : "";
    ink += `<g${cls}>`;
    pieces.filter((pc) => pc.length > 1).forEach((pc, j) => {
      ink += `<path d="${inkStroke(pc, { w: compact ? 1.3 : 1.75, vary: 0.32, amp: 0.35, seed: 5 + k * 7 + j, taper: 3 })}" fill="var(--sketch-ink)"/>`;
    });
    ink += "</g>";
  });
  for (const g of gaps) {
    if (m.elevAt((g.from + g.to) / 2) == null) continue;
    const n = Math.max(3, Math.round((X(g.to) - X(g.from)) / 2.6));
    for (let k = 1; k < n; k++) { const mi = g.from + ((g.to - g.from) * k) / n; ink += `<circle cx="${X(mi).toFixed(1)}" cy="${yAt(mi).toFixed(1)}" r="0.95" fill="var(--sketch-ink)"/>`; }
  }
  // Skeleton: the stretch whose elevation hasn't arrived, as a pencil rule
  // being inked (loading) or a quiet dotted line (not coming).
  for (const s of skeletons) {
    const [a, b] = s.line;
    const pts = wobble([[a[0] + 2, a[1]], [b[0] - 2, b[1]]], { amp: 0.5, seed: 33 });
    ink += s.failed
      ? `<path d="${pathD(pts)}" stroke="var(--sketch-ink-soft)" stroke-width="1.2" stroke-dasharray="1 3" stroke-linecap="round" fill="none"/>`
      : `<path d="${pathD(pts)}" stroke="var(--sketch-rule)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
         <path class="sk-inking" d="${pathD(pts)}" pathLength="1" stroke="var(--sketch-ink-soft)" stroke-width="1.4" stroke-linecap="round" fill="none"/>`;
  }

  if (compact) {
    const glyphs = m.days.flatMap((d) => d.stops.filter((s) => s.kind === "camp").map((s) => glyph("camp", X(s.mi), yAt(s.mi) + 0.5, { s: 0.6, seed: 31 + d.i, grain: "ip" }))).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(ariaSummary(m))}">
      <defs>${defs}</defs>${bands}${ink}${glyphs}${tags}${hits}</svg>`;
  }

  // Baseline (hand-ruled) with mile ticks.
  let axis = `<path d="${inkStroke(wobble([[L - 2, base + 0.5], [W - Rr + 2, base + 0.5]], { amp: 0.5, seed: 3 }), { w: 0.9, vary: 0.2, amp: 0.2, seed: 4 })}" fill="var(--sketch-ink-soft)"/>`;
  const step = tickStep(m.total, plotW, narrow ? 44 : 40);
  for (let mi = 0; mi <= m.total + 1e-9; mi += step) {
    const x = X(mi);
    const label = `${+mi.toFixed(1)}${mi === 0 ? " mi" : ""}`;
    axis += `<path d="${inkStroke([[x, base + 1], [x + 0.2, base + 5]], { w: 0.8, vary: 0.1, amp: 0.05, seed: Math.round(mi * 10) + 1, taper: 1 })}" fill="var(--sketch-ink-soft)"/>`;
    const anchor = mi === 0 ? "start" : x > W - 24 ? "end" : "middle";
    axis += `<text class="sk-num" x="${x.toFixed(1)}" y="${base + 18}" text-anchor="${anchor}">${label}</text>`;
  }

  // Glyphs on the line, then annotations placed clear of the line and each other.
  let marks = "", notes = "";
  const placed = [[0, 0, W, 36]]; // the day tags row
  const hitsBox = (b) => placed.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
  const reserve = (b) => placed.push(b);
  const noteAbove = (x, yStart, text, cls = "sk-note", anchor = "start", charW = 5.7) => {
    const w = text.length * charW;
    const bx0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    if (bx0 < 0 || bx0 + w > W) return null;
    for (let y = yStart; y > 44; y -= 4) {
      const b = [bx0 - 2, y - 10, bx0 + w + 2, y + 3];
      if (lineMinY(b[0], b[2]) > b[3] + 2 && !hitsBox(b)) { reserve(b); notes += `<text class="${cls} halo" x="${x.toFixed(1)}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`; return y; }
    }
    return null;
  };
  const leader = (x, y0, y1, seed) => { if (y1 - y0 < 4) return; marks += `<path d="${inkStroke(wobble([[x, y0], [x + 0.4, y1]], { amp: 0.2, seed }), { w: 0.7, vary: 0.15, amp: 0.05, seed, taper: 1.5 })}" fill="var(--sketch-ink-soft)"/>`; };

  // Start / finish rings on the first and last stretch with ink.
  if (runs.length) {
    const a = runs[0].line[0], b = runs.at(-1).line.at(-1);
    marks += glyph("start", a[0] + 2.5, a[1], { s: 0.68, seed: 2, grain: "ip" });
    marks += glyph("start", b[0] - 2.5, b[1], { s: 0.68, seed: 3, grain: "ip" });
  }
  const camps = [];
  for (const d of m.days) for (const s of d.stops) {
    if (d.empty) continue;
    const x = X(s.mi), y = yAt(s.mi);
    if (s.kind === "camp") { marks += glyph("camp", x, y + 0.5, { s: narrow ? 0.85 : 1, seed: 31 + d.i, grain: "ip" }); camps.push(s.mi); reserve([x - 11, y - 16, x + 11, y + 1]); }
    else if (s.kind === "water") { marks += glyph("water", x, y - 5, { s: 0.78, seed: 41 + d.i, grain: "ip" }); reserve([x - 5, y - 17, x + 5, y - 4]); }
    else if (s.kind === "rest") { marks += glyph("rest", x, y - 4, { s: 0.7, seed: 45 + d.i, grain: "ip" }); reserve([x - 6, y - 12, x + 6, y - 3]); }
    else if (s.kind === "hazard") { marks += glyph("hazard", x, y - 4, { s: 0.7, seed: 47 + d.i, grain: "ip" }); reserve([x - 6, y - 11, x + 6, y - 3]); }
    else if ((s.kind === "scenic" || s.kind === "resupply") && s.dayMi > 0.05) {
      marks += glyph(s.kind, x, y - 5, { s: 0.75, seed: 61 + Math.round(s.mi * 10), grain: "ip" });
      reserve([x - 5, y - 14, x + 5, y - 5]);
    }
    if (mentionsMeal(s.notes) && s.kind !== "camp") { marks += glyph("meal", x - 12, y - 4, { s: 0.62, seed: 81, grain: "ip" }); reserve([x - 17, y - 16, x - 6, y - 4]); }
  }
  // Day-hike spurs: a teal out-and-back arrow from where they leave the route.
  for (const d of m.days) for (const sp of d.spurs) {
    const x = X(sp.at), y = yAt(sp.at) - 17;
    if (x + 34 > W) continue;
    const out = chaikin([[x + 3, y - 1], [x + 9, y - 14], [x + 22, y - 20], [x + 32, y - 14]], 3);
    const back = chaikin([[x + 29, y - 8], [x + 20, y - 12], [x + 11, y - 7], [x + 6, y + 2]], 3);
    marks += `<path d="${inkStroke(out, { w: 1.15, vary: 0.2, amp: 0.1, seed: 101, taper: 2 })}" fill="var(--type-dayhike)"/>`;
    marks += `<path d="${inkStroke(chaikin([[x + 27.6, y - 17.8], [x + 32.4, y - 13.8], [x + 26.6, y - 11.6]], 1), { w: 1.1, vary: 0.1, amp: 0.05, seed: 102, taper: 1 })}" fill="var(--type-dayhike)"/>`;
    marks += `<path d="${inkStroke(back, { w: 0.85, vary: 0.2, amp: 0.1, seed: 103, taper: 2 })}" fill="var(--type-dayhike)" opacity="0.75"/>`;
    reserve([x, y - 22, x + 34, y + 2]);
    const text = `${sp.name}, ${sp.rt.toFixed(1)} mi rt`;
    const fits = !narrow && x + 37 + text.length * 5.4 < W;
    noteAbove(x + 37, y - 10, fits ? text : `${sp.rt.toFixed(1)} mi rt`, "sk-note sk-note--teal");
  }
  if (m.hasElevation) {
    const hx = X(m.hi.mi), hy = Y(m.hi.ft);
    const campAtHigh = camps.some((c) => Math.abs(c - m.hi.mi) < m.total * 0.03);
    if (!campAtHigh) { marks += glyph("summit", hx, hy - 6, { s: 0.75, seed: 91, grain: "ip" }); reserve([hx - 5, hy - 14, hx + 5, hy - 5]); }
    if (noteAbove(hx + (campAtHigh ? 12 : 7), hy - 8, fmt.ft(m.hi.ft), "sk-num", "start", 6.6) == null) noteAbove(hx - 7, hy - 8, fmt.ft(m.hi.ft), "sk-num", "end", 6.6);
    if (runs.length && Math.abs(runs[0].pts[0][1] - hy) > 6) noteAbove(runs[0].line[0][0] + 8, runs[0].line[0][1] - 6, fmt.ft(m.elevAt(m.days.find((d) => !d.empty)?.startMi ?? 0) ?? m.lo.ft), "sk-num", "start", 6.6);
    const lx = X(m.lo.mi), ly = Y(m.lo.ft);
    if (ly + 17 < base - 2) {
      const w = fmt.ft(m.lo.ft).length * 6.6;
      const b = [lx - w / 2 - 2, ly + 7, lx + w / 2 + 2, ly + 20];
      if (b[0] > 0 && b[2] < W && !hitsBox(b)) { reserve(b); notes += `<text class="sk-num halo" x="${lx.toFixed(1)}" y="${(ly + 17).toFixed(1)}" text-anchor="middle">${fmt.ft(m.lo.ft)}</text>`; }
    }
  }
  if (!narrow) {
    // Names for camps and viewpoints, lettered beside their glyph when there's room.
    const lineMaxY = (x0, x1) => { let v = -Infinity; for (const [x, y] of allLine) if (x >= x0 - 2 && x <= x1 + 2) v = Math.max(v, y); return v; };
    const place = (x, y, text, g) => {
      const w = text.length * 5.5;
      const cands = [[g, -5, "start"], [-g, -5, "end"], [g, 15, "start"], [-g, 15, "end"], [0, -26, "middle", true], [0, 30, "middle", true]];
      for (const [dx, dy, anchor, lead] of cands) {
        const tx = x + dx, ty = y + dy;
        const bx0 = anchor === "end" ? tx - w : anchor === "middle" ? tx - w / 2 : tx;
        const bb = [bx0 - 2, ty - 10, bx0 + w + 2, ty + 3];
        if (bb[0] < 0 || bb[2] > W || bb[1] < 38 || bb[3] > base - 2 || hitsBox(bb)) continue;
        if (!(lineMinY(bb[0], bb[2]) > bb[3] + 2 || lineMaxY(bb[0], bb[2]) < bb[1] - 2)) continue;
        reserve(bb);
        notes += `<text class="sk-note sk-ann halo" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${esc(text)}</text>`;
        if (lead) dy < 0 ? leader(x, ty + 3, y - 15, 200 + Math.round(x)) : leader(x, y + 3, ty - 11, 200 + Math.round(x));
        return true;
      }
      return false;
    };
    for (const d of m.days) for (const s of d.stops) {
      if (d.empty || !s.name || !(s.kind === "scenic" || s.kind === "camp") || s.dayMi < 0.05) continue;
      const name = s.kind === "camp" ? s.name.replace(/^At-large camp /, "") : s.name;
      if (name.length > 28) continue;
      place(X(s.mi), yAt(s.mi), name, s.kind === "camp" ? 13 : 7);
    }
  }
  for (const g of gaps) {
    if (g.reason !== "no_path" || m.elevAt(g.to) == null) continue;
    const x = X(g.to) + 1, y = yAt(g.to);
    const text = narrow ? "gap" : "not connected in OSM";
    const w = text.length * 5.6;
    const b = [x + 4, y + 9, x + 8 + w, y + 23];
    if (b[2] > W || b[3] > base - 2 || hitsBox(b)) continue;
    reserve(b);
    notes += `<text class="sk-note halo" x="${(x + 6).toFixed(1)}" y="${(y + 20).toFixed(1)}">${text}</text>`;
    leader(x + 3, y + 4, y + 11, 300);
  }
  // Skeleton labels: say what's happening, once.
  const pend = skeletons.find((s) => !s.failed), fail = skeletons.find((s) => s.failed);
  for (const [s, text] of [[pend, "Elevation loading…"], [fail, "No elevation for this stretch"]]) {
    if (!s) continue;
    const x = Math.max(X(s.p.startMi) + 4, 4);
    const t = narrow && text.length > 20 ? "No elevation" : text;
    if (x + t.length * 5.7 > W) noteAbove(W - 4, flatY - 8, t, "sk-note", "end");
    else noteAbove(x, flatY - 8, t);
  }

  // Camps on a 1.2 line can be grabbed and dragged along the profile.
  let grabs = "";
  if (m.line) {
    for (const d of m.days) for (const s of d.stops) {
      if (d.empty || s.kind !== "camp") continue;
      grabs += `<circle class="camp-grab" data-id="${esc(s.id)}" cx="${X(s.mi).toFixed(1)}" cy="${yAt(s.mi).toFixed(1)}" r="16" fill="transparent"><title>${esc(s.name || "Camp")}: drag to move</title></circle>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(ariaSummary(m))}">
    <defs>${defs}</defs>
    ${bands}${dividers}${axis}${ink}${marks}${tags}${notes}${hits}${grabs}
  </svg>`;
}

function ariaSummary(m) {
  const days = m.mode === "days" ? `${m.days.length} day${m.days.length === 1 ? "" : "s"}` : "not split into days yet";
  const elev = m.hasElevation ? `, high point ${fmt.ft(m.hi.ft)}, low point ${fmt.ft(m.lo.ft)}` : ", elevation not loaded yet";
  return `Elevation profile: ${fmt.mi(m.routeMiles)}, ${days}${elev}`;
}

/** One-line caption under the drawing. */
export function captionFor(m, { failed = false } = {}) {
  const { gain, loss } = m;
  const parts = [];
  if (m.mode === "loose") parts.push("This route isn’t in a day yet. Drag it into a day to split the profile.");
  else if (m.hasElevation) parts.push(`Elevation, ${fmt.gain(gain)} / ${fmt.loss(loss)} ft over ${fmt.mi(m.routeMiles)}. Vertical scale exaggerated.`);
  else if (failed) parts.push(`${fmt.mi(m.routeMiles)} drawn. Elevation didn\u2019t load.`);
  else parts.push(`${fmt.mi(m.routeMiles)} drawn. Elevation fills in once it loads.`);
  if (m.looseCount) parts.push(`${m.looseCount} route${m.looseCount === 1 ? "" : "s"} not in a day yet.`);
  return parts.join(" ");
}

/** Calm empty state: a ruled baseline and a faint dotted ridge to come. */
export function drawEmpty(W) {
  const H = 64, base = 50;
  const ridge = chaikin([[8, base - 4], [W * 0.18, base - 18], [W * 0.32, base - 10], [W * 0.5, base - 30], [W * 0.66, base - 16], [W * 0.82, base - 24], [W - 10, base - 6]], 3);
  const dots = [];
  for (let k = 0; k < ridge.length; k += 3) dots.push(`<circle cx="${ridge[k][0].toFixed(1)}" cy="${ridge[k][1].toFixed(1)}" r="0.9"/>`);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
    <g fill="var(--sketch-rule)">${dots.join("")}</g>
    <path d="${inkStroke(wobble([[4, base + 0.5], [W - 4, base + 0.5]], { amp: 0.5, seed: 3 }), { w: 0.9, vary: 0.2, amp: 0.2, seed: 4 })}" fill="var(--sketch-ink-soft)"/>
  </svg>`;
}

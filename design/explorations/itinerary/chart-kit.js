/**
 * Plan-view "trip chart": the route drawn like a hand-inked trail map over
 * real 3DEP contours. Used by direction B (whole-trip chart) and direction C
 * (per-day sketches). EXPLORATION (2026-11-08).
 */
import { projector, bboxOf, simplify, chaikin, wobble, inkStroke, glyph, pencilDefs, esc } from "./itin.js";

export const tone = (i) => (i % 2 ? "var(--pencil-b)" : "var(--pencil-a)");

/** Hand-drawn circled numeral (DM Sans numeral in an inked ring). */
export function dayMark(x, y, n, { r = 8, seed = 1, active = true } = {}) {
  const ring = [];
  for (let k = 0; k <= 26; k++) { const a = -1.9 + (k / 24) * Math.PI * 2; ring.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.96]); }
  return `<g class="day-mark" opacity="${active ? 1 : 0.5}">
    <circle cx="${x}" cy="${y}" r="${r - 0.6}" fill="var(--surface)"/>
    <path d="${inkStroke(ring, { w: 0.95, vary: 0.25, amp: 0.15, seed, taper: 3 })}" fill="var(--sketch-ink)"/>
    <text x="${x}" y="${y + 3.8}" text-anchor="middle" class="ch-num-mark">${n}</text>
  </g>`;
}

/**
 * @param m        trip model (itin.js loadTrip)
 * @param contours loadContours()
 * @param o        { W, H, days: [indices to frame], focus: day index | null,
 *                   labels, scale, north, pad, id, mini }
 */
export function drawChart(m, contours, o) {
  const { W, H, id = "c", focus = null, labels = true, mini = false } = o;
  const frameDays = (o.days ?? m.days.map((d) => d.i)).map((i) => m.days[i]);
  const lines = frameDays.flatMap((d) => [d.coords, ...(d.spur ? [d.spur.coords] : [])]);
  const bb = bboxOf(lines, o.padM ?? 260);
  const pr = projector(bb, W, H, o.pad ?? 10);
  const toPx = (cs, tol = 0.5) => simplify(cs.map(pr), tol);

  let defs = pencilDefs(id) + `
    <radialGradient id="${id}-fade" cx="50%" cy="50%" r="62%"><stop offset="0.55" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <mask id="${id}-vign" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="url(#${id}-fade)"/></mask>
    <clipPath id="${id}-box"><rect width="${W}" height="${H}"/></clipPath>`;

  // Contours: fine hairlines, index contours a touch heavier. They fade at
  // the edges like a sketch that stops where the artist's interest does.
  let cont = "";
  const inView = ([x, y]) => x > -20 && x < W + 20 && y > -20 && y < H + 20;
  for (const c of contours) {
    const px = c.pts.map(pr);
    if (!px.some(inView)) continue;
    const s = chaikin(simplify(px, mini ? 1 : 0.7), 1);
    cont += `<path d="M${s.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L")}" stroke-width="${c.index ? (mini ? 0.7 : 0.85) : (mini ? 0.4 : 0.5)}" stroke-opacity="${c.index ? 0.9 : 0.65}"/>`;
  }

  // Route: colored-pencil band per day under a fineliner line.
  let pencil = "", ink = "", marks = "", text = "";
  const routePx = [], placed = [], later = [];
  for (const d of m.days) {
    const px = toPx(d.coords, 0.4);
    routePx.push(...px);
    const isF = focus == null || focus === d.i;
    const smooth = chaikin(px, 2);
    const band = wobble(smooth, { amp: 0.8, seed: 70 + d.i });
    const bd = `M${band.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L")}`;
    const bw = mini ? 7 : focus === d.i ? 12 : 10;
    // Two passes, like real colored pencil: a light even layer, then a grainy one that catches the paper tooth.
    pencil += `<g class="ch-band${focus === d.i ? " is-active" : ""}" opacity="${isF ? 1 : 0.3}">
      <path d="${bd}" stroke="${tone(d.i)}" stroke-width="${bw - 2}" stroke-opacity="0.32"/>
      <path d="${bd}" stroke="${tone(d.i)}" stroke-width="${bw}" stroke-opacity="0.9" filter="url(#${id}-grain-soft)"/>
    </g>`;
    // ink, with off-network legs dotted
    const segs = (d.manual || []);
    if (!segs.length) ink += `<path d="${inkStroke(smooth, { w: isF ? (mini ? 1.25 : 1.45) : 0.9, vary: 0.3, amp: 0.3, seed: 5 + d.i })}" fill="var(--sketch-ink)" opacity="${isF ? 1 : 0.45}"/>`;
    else {
      // split by along-distance
      const cum = d.cum, total = d.miles;
      const pieces = [[]];
      let gapPts = [];
      d.coords.forEach((c, k) => {
        const mi = d.startMi + cum[k];
        const inGap = segs.some((g) => mi > g.from + 1e-6 && mi < g.to - 1e-6);
        const p = pr(c);
        if (inGap) { gapPts.push(p); if (pieces.at(-1).length) { pieces.at(-1).push(p); pieces.push([]); } }
        else { if (gapPts.length && !pieces.at(-1).length) gapPts.push(p); pieces.at(-1).push(p); }
      });
      void total;
      pieces.filter((pc) => pc.length > 1).forEach((pc, k) => { ink += `<path d="${inkStroke(chaikin(simplify(pc, 0.4), 2), { w: isF ? (mini ? 1.25 : 1.45) : 0.9, vary: 0.3, amp: 0.3, seed: 15 + k })}" fill="var(--sketch-ink)" opacity="${isF ? 1 : 0.45}"/>`; });
      for (const g of segs) {
        const a = pr(d.coords[d.cum.findIndex((v) => d.startMi + v >= g.from - 1e-6)]);
        const b = pr(d.coords[d.cum.findIndex((v) => d.startMi + v >= g.to - 1e-6)]);
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(2, Math.round(L / 3));
        for (let k = 0; k <= n; k++) ink += `<circle cx="${(a[0] + ((b[0] - a[0]) * k) / n).toFixed(1)}" cy="${(a[1] + ((b[1] - a[1]) * k) / n).toFixed(1)}" r="${mini ? 0.8 : 0.95}" fill="var(--sketch-ink)" opacity="${isF ? 1 : 0.45}"/>`;
        if (labels && !mini) text += `<text class="ch-note halo" x="${((a[0] + b[0]) / 2 - 6).toFixed(1)}" y="${((a[1] + b[1]) / 2 + 3).toFixed(1)}" text-anchor="end">not in OSM</text>`;
      }
    }
    if (d.spur) {
      const sp = chaikin(toPx(d.spur.coords, 0.4), 2);
      const isS = focus == null || focus === d.i;
      // dashed teal ink: draw short inkStroke dashes along the spur
      const r = sp; let acc = 0, on = true, cur = [r[0]];
      for (let k = 1; k < r.length; k++) {
        acc += Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]);
        cur.push(r[k]);
        if (acc > (on ? 6 : 3)) { if (on && cur.length > 1) ink += `<path d="${inkStroke(cur, { w: 1.45, vary: 0.2, amp: 0.1, seed: k, taper: 1.2 })}" fill="var(--type-dayhike)" opacity="${isS ? 1 : 0.4}"/>`; on = !on; acc = 0; cur = [r[k]]; }
      }
      const e = sp.at(-1), pe = sp[Math.max(0, sp.length - 4)];
      const ang = Math.atan2(e[1] - pe[1], e[0] - pe[0]);
      const ah = (t) => [e[0] - Math.cos(ang + t) * 5.5, e[1] - Math.sin(ang + t) * 5.5];
      ink += `<path d="${inkStroke([ah(0.5), e, ah(-0.5)], { w: 1.15, vary: 0.1, amp: 0.05, seed: 9, taper: 1 })}" fill="var(--type-dayhike)" opacity="${isS ? 1 : 0.4}"/>`;
      if (labels && !mini) later.push([e[0], e[1], [`${d.spur.name}, ${d.spur.rt.toFixed(1)} mi rt`, d.spur.name], "ch-note ch-note--teal", 8]);
    }
  }

  // Collision-aware labels (checked against the route and each other)
  function label(x, y, str, cls, g = 10) {
    if (Array.isArray(str)) { for (const s1 of str) { const r = label(x, y, s1, cls, g); if (r) return r; } return ""; }
    const w = str.length * 5.5;
    const cands = [[g, 4, "start"], [-g, 4, "end"], [g * 0.6, -g, "start"], [-g * 0.6, -g, "end"], [g * 0.6, g + 8, "start"], [-g * 0.6, g + 8, "end"], [0, -g - 6, "middle"], [0, g + 14, "middle"], [g * 1.8, 4, "start"], [-g * 1.8, 4, "end"]];
    for (const [dx, dy, anchor] of cands) {
      const tx = x + dx, ty = y + dy, bx0 = anchor === "end" ? tx - w : anchor === "middle" ? tx - w / 2 : tx;
      const bb = [bx0 - 2, ty - 10, bx0 + w + 2, ty + 3];
      if (bb[0] < 2 || bb[2] > W - 2 || bb[1] < 2 || bb[3] > H - 2) continue;
      if (placed.some((q) => bb[0] < q[2] && bb[2] > q[0] && bb[1] < q[3] && bb[3] > q[1])) continue;
      if (routePx.some(([px, py]) => px > bb[0] && px < bb[2] && py > bb[1] && py < bb[3])) continue;
      placed.push(bb);
      return `<text class="${cls} halo" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${esc(str)}</text>`;
    }
    return "";
  }

  // Start / finish
  const start = pr(m.days[0].coords[0]);
  marks += glyph("start", start[0], start[1], { s: mini ? 0.7 : 0.85, seed: 2, grain: id });
  placed.push([start[0] - 6, start[1] - 6, start[0] + 6, start[1] + 6]);
  // Stops
  for (const d of m.days) for (const s of d.stops) {
    const [x, y] = pr(s.coord);
    const isF = focus == null || focus === d.i;
    if (!inView([x, y])) continue;
    const op = isF ? 1 : 0.4;
    if (s.kind === "camp") { marks += `<g opacity="${op}">${glyph("camp", x, y + 4, { s: mini ? 0.75 : 0.95, seed: 31 + d.i, grain: id })}</g>`; placed.push([x - 11, y - 12, x + 11, y + 5]); }
    else if (s.kind === "water") { marks += `<g opacity="${op}">${glyph("water", x, y + 5, { s: mini ? 0.6 : 0.75, seed: 41 + d.i, grain: id })}</g>`; placed.push([x - 5, y - 6, x + 5, y + 6]); }
    else if (s.kind === "scenic" && s.mi > 0.05) { marks += `<g opacity="${op}">${glyph("scenic", x, y + 5, { s: mini ? 0.6 : 0.75, seed: 61 + Math.round(s.mi), grain: id })}</g>`; placed.push([x - 4, y - 4, x + 4, y + 5]); }
  }
  if (labels) {
    for (const a of later) text += label(...a);
    text += label(start[0], start[1], "Maze Overlook", "ch-ann", 9);
    for (const d of m.days) for (const s of d.stops) {
      const [x, y] = pr(s.coord);
      if (!inView([x, y]) || (focus != null && focus !== d.i && mini)) continue;
      if (s.kind === "camp") text += label(x, y, s.name.replace(/^At-large camp /, ""), "ch-ann", 12);
      else if (s.kind === "scenic" && s.mi > 0.05 && !mini) text += label(x, y, s.name, "ch-ann", 8);
    }
  }
  // Day numerals at each day's midpoint, offset from the line
  let nums = "";
  if (!mini) for (const d of m.days) {
    const px = toPx(d.coords, 0.4);
    const k = Math.floor(px.length * 0.5), p = px[k], q = px[Math.min(px.length - 1, k + 2)], o2 = px[Math.max(0, k - 2)];
    const ang = Math.atan2(q[1] - o2[1], q[0] - o2[0]) + Math.PI / 2;
    let best = null;
    for (const sgn of [1, -1]) for (const dist of [17, 22, 28]) {
      const x = p[0] + Math.cos(ang) * dist * sgn, y = p[1] + Math.sin(ang) * dist * sgn;
      const bb = [x - 9, y - 9, x + 9, y + 9];
      if (bb[0] < 2 || bb[2] > W - 2 || bb[1] < 2 || bb[3] > H - 2) continue;
      if (placed.some((qq) => bb[0] < qq[2] && bb[2] > qq[0] && bb[1] < qq[3] && bb[3] > qq[1])) continue;
      if (routePx.some(([rx, ry]) => rx > bb[0] && rx < bb[2] && ry > bb[1] && ry < bb[3])) continue;
      best = [x, y]; break;
    }
    if (best) { placed.push([best[0] - 9, best[1] - 9, best[0] + 9, best[1] + 9]); nums += dayMark(best[0], best[1], d.n, { seed: 400 + d.i, active: focus == null || focus === d.i }); }
  }

  // Scale bar + north arrow (hand-ruled)
  let furn = "";
  if (o.scale !== false && !mini) {
    const mile = pr.pxPerMile, x0 = 12, y0 = H - 14;
    furn += `<path d="${inkStroke(wobble([[x0, y0], [x0 + mile, y0]], { amp: 0.3, seed: 81 }), { w: 1, vary: 0.2, amp: 0.1, seed: 82 })}" fill="var(--sketch-ink-soft)"/>`;
    for (const f of [0, 0.5, 1]) furn += `<path d="${inkStroke([[x0 + mile * f, y0 - (f === 0.5 ? 2.5 : 4)], [x0 + mile * f + 0.2, y0 + 0.5]], { w: 0.85, vary: 0.1, amp: 0.05, seed: 83 + f * 4, taper: 1 })}" fill="var(--sketch-ink-soft)"/>`;
    furn += `<text class="ch-num halo" x="${x0 + mile + 6}" y="${y0 + 3.5}">1 mi</text>`;
    const nx = W - 18, ny = H - 30;
    furn += `<path d="${inkStroke([[nx, ny + 16], [nx + 0.3, ny - 2]], { w: 0.9, vary: 0.2, amp: 0.05, seed: 91, taper: 1 })}" fill="var(--sketch-ink-soft)"/>`;
    furn += `<path d="M${nx - 3.6} ${ny + 5} L${nx + 0.2} ${ny - 3} L${nx + 0.2} ${ny + 3.4} Z" fill="var(--sketch-ink-soft)"/>`;
    furn += `<text class="ch-label" x="${nx}" y="${ny + 29}" text-anchor="middle">N</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(o.aria || "Trip chart")}">
    <defs>${defs}</defs>
    <g clip-path="url(#${id}-box)">
      <g mask="url(#${id}-vign)" fill="none" stroke="var(--earth-600)" stroke-linecap="round" stroke-linejoin="round">${cont}</g>
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">${pencil}</g>
      ${ink}${marks}${nums}${text}${furn}
    </g>
  </svg>`;
}

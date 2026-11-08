/**
 * Page scaffolding shared by the three itinerary explorations: exploration
 * bar, map stand-in, panel header/footer, and the day "story" markup.
 * EXPLORATION (2026-11-08).
 */
import { esc, fmt, glyphIcon, glyphDefsSVG, projector, bboxOf, simplify, smoothD, STOP_LABEL } from "./itin.js";

export const DIRECTIONS = [
  { href: "sketchbook.html", key: "sketchbook", label: "A · Sketchbook profile" },
  { href: "chart.html", key: "chart", label: "B · Trip chart" },
  { href: "journal.html", key: "journal", label: "C · Field journal" },
];

export function expBar(current) {
  return `<header class="exp-bar">
    <strong>Itinerary explorations</strong>
    <nav aria-label="Directions">${DIRECTIONS.map((d) => `<a href="${d.href}"${d.key === current ? ' aria-current="page"' : ""}>${d.label}</a>`).join("")}</nav>
    <div class="exp-states" role="group" aria-label="Show state">
      <button data-set-state="default">Default</button>
      <button data-set-state="hover">Hover day 2</button>
      <button data-set-state="drag">Drag into a day</button>
      <button data-set-state="empty">Empty day</button>
    </div>
  </header>${glyphDefsSVG()}`;
}

export function panelHead(m) {
  const d = m.dates;
  return `<div class="panel-head">
    <div class="panel-head-top">
      <h1 class="trip-title">${esc(m.name)}</h1>
      <button class="close-btn" aria-label="Close planning panel"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg></button>
    </div>
    <p class="trip-sub">${esc(m.location)}</p>
    <div class="chips">
      <span class="chip">${esc(fmt.range(d.start, d.end))}</span>
      <span class="chip">${m.days.length} days</span>
      <span class="chip">${fmt.mi(m.total.miles)}</span>
      <span class="chip">${fmt.gain(m.total.gain)} ft</span>
    </div>
  </div>`;
}

export function panelFoot() {
  return `<div class="panel-foot">
    <button class="btn btn--primary btn--block">Download trip (.geojson)</button>
    <div class="row">
      <button class="btn btn--ghost btn--sm">Export notes (.md)</button>
      <button class="btn btn--ghost btn--sm">Load trip</button>
      <button class="btn btn--ghost btn--sm">New trip</button>
    </div>
  </div>`;
}

export function tray() {
  return `<div class="tray">
    <div class="t-label">Unassigned</div>
    <div class="tray-row">
      <span class="pill is-ghost" data-type="camp">Water cache</span>
      <span class="pill" data-type="dayhike">Pictograph Fork</span>
    </div>
  </div>`;
}

/** Stops list for one day (glyphs drawn in the same hand as the figure). */
export function stopsHTML(day, { compact = false } = {}) {
  const items = []; // [walking-order mile, html]
  for (const s of day.stops) {
    if (s.kind === "dayhike") continue; // shown with its spur
    const cls = s.kind === "camp" ? "is-camp" : s.kind === "water" ? "is-water" : "";
    let note = s.notes || "";
    if (s.kind === "camp" && s.waterNotes) note += (note ? " " : "") + `Water: ${s.waterNotes}`;
    items.push([s.dayMi + (s.kind === "camp" ? 0.01 : 0), `<li class="stop" data-kind="${s.kind}">
      ${glyphIcon(s.kind, { seed: Math.round(s.mi * 100), size: 24 })}
      <span class="stop-name ${cls}">${esc(s.name || STOP_LABEL[s.kind])}</span>
      <span class="stop-at">${s.dayMi.toFixed(1)} mi</span>
      ${note && !compact ? `<span class="stop-note">${esc(note)}</span>` : ""}
    </li>`]);
  }
  for (const g of day.manual) {
    items.push([g.from - day.startMi, `<li class="stop stop--gap" data-kind="gap">
      <svg class="stop-glyph" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><g fill="var(--ink-700)">${[3, 7.5, 12, 16.5, 21].map((x) => `<circle cx="${x}" cy="${(14 - (x - 12) * 0.3).toFixed(1)}" r="1.15"/>`).join("")}</g></svg>
      <span class="stop-name">Off-network leg</span>
      <span class="stop-at">${(g.to - g.from).toFixed(1)} mi</span>
      ${compact ? "" : `<span class="stop-note">These trails don\u2019t connect in OpenStreetMap, so this bit is drawn by hand. <a href="#" class="osm-link">Fix it in OSM</a></span>`}
    </li>`]);
  }
  if (day.spur) {
    items.push([day.spur.at - day.startMi + 0.02, `<li class="stop" data-kind="dayhike">
      ${glyphIcon("dayhike", { seed: 77, size: 24 })}
      <span class="stop-name is-dayhike">${esc(day.spur.name)}</span>
      <span class="stop-at">${day.spur.rt.toFixed(1)} mi rt</span>
      ${compact ? "" : `<span class="stop-note">${esc(day.stops.find((s) => s.kind === "dayhike")?.notes || "")}</span>`}
    </li>`]);
  }
  items.sort((x, y) => x[0] - y[0]);
  return `<ol class="stops">${items.map((x) => x[1]).join("")}</ol>`;
}

export const editRow = () => `<div class="edit-row">
  <button class="btn btn--ghost btn--sm">Edit notes</button>
  <button class="btn btn--ghost btn--sm">Add stop</button>
</div>`;

export function emptyDayHTML(m) {
  const last = m.days.at(-1);
  const d = new Date(last.date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
  return { n: m.days.length + 1, date: d.toISOString().slice(0, 10) };
}

/** Quiet map stand-in: contours + the route as the app would draw it. */
export function renderMapStandIn(el, m, contours) {
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  const routeLines = m.days.map((d) => d.coords);
  const bb = bboxOf(routeLines, 900);
  const pr = projector(bb, w, h, 60);
  const cs = contours.map((c) => `<path d="${smoothD(simplify(c.pts.map(pr), 0.8))}" stroke-width="${c.index ? 0.9 : 0.5}"/>`).join("");
  const route = m.days.map((d) => `<path d="${smoothD(simplify(d.coords.map(pr), 0.5))}"/>`).join("");
  const spur = m.days.filter((d) => d.spur).map((d) => `<path d="${smoothD(d.spur.coords.map(pr))}" stroke-dasharray="4 4"/>`).join("");
  const camps = m.days.filter((d) => d.camp).map((d) => { const [x, y] = pr(d.camp.coord); return `<circle cx="${x}" cy="${y}" r="5"/>`; }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <g fill="none" stroke="var(--earth-500)" opacity="0.8">${cs}</g>
    <g fill="none" stroke="var(--type-route)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${route}</g>
    <g fill="none" stroke="var(--type-dayhike)" stroke-width="3" stroke-linecap="round">${spur}</g>
    <g fill="var(--type-camp)" stroke="var(--surface-raised)" stroke-width="2">${camps}</g>
  </svg><span class="stage-map-label">Map stand-in</span>`;
}

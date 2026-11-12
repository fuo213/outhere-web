/**
 * The day story for a 1.2 (line + stops) trip. Days aren't assigned: they
 * build themselves from the camps on the line (line-model.js buildPlan), so
 * this renders the plan rather than drag-and-drop day lists. Same section
 * anatomy as the 1.1 story (label, date, pencil rule, totals; title; notes;
 * stop rows), so the sticky profile and the active-day signal work unchanged.
 */

import { escapeHTML, buildDayNotes, isEditingNotes, editDayNotes, showDayOnMap, isDayOnMap, frameFeature } from "./trip-panel.js"; // circular; runtime only
import { openStopMenu, glyphForKind } from "./stops.js"; // circular; runtime only
import { returnSameWay, offRouteLabel } from "./route-edit.js"; // circular; runtime only
import { ruleSVG } from "./itinerary-profile.js";
import { glyphIcon } from "./sketch.js";
import { MI, passLabel, hav } from "./line-model.js";

const KIND_LABEL = { camp: "Camp", break: "Break", water: "Water", hazard: "Hazard", scenic: "Viewpoint", note: "Note" };
const NAME_CLASS = { camp: "is-camp", water: "is-water", break: "is-rest" };
const seedOf = (id) => [...String(id || "x")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 997;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

function formatDateLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/**
 * What being off the route means for a time stop, per kind: a camp's night
 * stops counting (its day disappears); a break is still listed, at the
 * nearest mile.
 */
export function offRouteConsequence(kind, n = 1) {
  if (kind === "camp") return n === 1 ? "Its night doesn\u2019t count until it\u2019s back on the line." : "Their nights don\u2019t count until they\u2019re back on the line.";
  return n === 1 ? "It\u2019s listed at the nearest mile until you move it back onto the line." : "They\u2019re listed at the nearest mile until you move them back onto the line.";
}

/** Label of a day end: "Start", "Camp 2", "Finish". */
const endLabel = (e) => e.short || e.label;

/**
 * Render the days into `container`. Returns the <section>s in day order.
 * @param {object} trip   the real trip (days synced by syncLineTrip)
 * @param {object} plan   buildPlan(trip)
 * @param {object} model  buildItinerary(displayTrip(trip)) (miles, elevation per day)
 */
export function renderLineDays(container, trip, plan, model) {
  container.innerHTML = "";
  if (!plan.route) {
    container.insertAdjacentHTML("beforeend", `<p class="line-empty">Draw your line on the map. Then drop camps on it: the days build themselves.</p>`);
    return [];
  }
  // Stops an edit pushed off the line: said once at the top, worded per kind.
  for (const kind of ["camp", "break"]) {
    const off = plan.offRoute.filter((o) => o.kind === kind);
    if (!off.length) continue;
    const names = off.map((o) => o.f.properties.name || offRouteLabel(o.id) || (kind === "camp" ? "A camp" : "A break"));
    container.insertAdjacentHTML("beforeend", `<p class="line-flag" role="status">${escapeHTML(names.join(", "))} ${names.length === 1 ? "is" : "are"} off your route now. ${escapeHTML(offRouteConsequence(kind, names.length))}</p>`);
  }
  const loop = hav(plan.ix.coords[0], plan.ix.coords.at(-1)) < 60;
  const sections = plan.days.map((d) => buildSection(d, trip, plan, model.days?.[d.i], { last: d.i === plan.days.length - 1, loop }));
  sections.forEach((s) => container.appendChild(s));
  return sections;
}

function buildSection(d, trip, plan, mday, { last, loop }) {
  const day = trip.days[d.i];
  const section = document.createElement("section");
  section.className = "itin-day itin-day--line" + (isDayOnMap(day?.id) ? " day-active" : "");
  section.dataset.dayId = day?.id || "";
  section.dataset.dayIndex = String(d.i);
  section.tabIndex = -1;
  const labelId = `day-label-${d.i}`;
  section.setAttribute("aria-labelledby", labelId);

  let sum = "";
  if (d.kind === "move") {
    const mi = (d.toM - d.fromM) / MI;
    sum = `${mi.toFixed(1)} mi`;
    const gain = mday?.pieces?.reduce((a, p) => a + (p.gain || 0), 0) || 0;
    const loss = mday?.pieces?.reduce((a, p) => a + (p.loss || 0), 0) || 0;
    if (gain || loss) sum += ` · +${Math.round(gain).toLocaleString("en-US")}<span class="loss"> −${Math.round(loss).toLocaleString("en-US")}</span> ft`;
  }
  const title = d.kind === "rest"
    ? `Rest day at ${endLabel(d.to)}`
    : `${endLabel(d.from)} to ${endLabel(d.to)}`;
  section.innerHTML = `
    <header class="itin-day-head">
      <h3 class="itin-day-label" id="${labelId}">Day ${d.n}</h3>
      ${d.date ? `<span class="itin-day-date">${escapeHTML(formatDateLabel(d.date))}</span>` : ""}
      ${ruleSVG(d.i)}
      ${sum ? `<span class="itin-day-sum">${sum}</span>` : ""}
    </header>`;

  const list = document.createElement("div");
  list.className = "day-feature-list";
  const head = document.createElement("div");
  head.className = "stop-row stop-row--title";
  head.innerHTML = `<div class="stop-title-row"><h4 class="itin-title">${escapeHTML(title)}</h4></div>`;
  list.appendChild(head);
  list.appendChild(buildDayNotes(day));

  // Stops (and spurs) in walking order.
  const rows = [
    ...d.stops.map((s) => ({ m: s.m, s })),
    ...d.spurs.map((sp) => ({ m: sp.m + 0.01, sp })),
  ].sort((a, b) => a.m - b.m);
  if (d.kind === "rest") {
    for (const sp of d.spurs) list.appendChild(spurRow(sp));
    if (!d.spurs.length) list.insertAdjacentHTML("beforeend", `<p class="line-hint">A day in camp. Draw a day hike from ${escapeHTML(endLabel(d.to))} to fill it.</p>`);
  } else {
    for (const r of rows) list.appendChild(r.s ? stopRow(r.s, plan, d) : spurRow(r.sp));
    if (!plan.camps.length) list.insertAdjacentHTML("beforeend", `<p class="line-hint">Add a camp on your line to split it into days.</p>`);
  }
  if (last && !loop && !plan.route.properties.return_same_way) {
    list.insertAdjacentHTML("beforeend", `<div class="line-actions"><button type="button" class="btn btn--quiet btn--sm" data-act="return">Return the same way</button></div>`);
  }
  section.appendChild(list);

  const row = document.createElement("div");
  row.className = "itin-edit-row";
  row.innerHTML = `
    ${isEditingNotes(day?.id) ? "" : `<button type="button" class="btn btn--ghost btn--sm" data-act="notes">${day?.notes?.trim() ? "Edit notes" : "Add notes"}</button>`}
    <button type="button" class="btn btn--ghost btn--sm day-map-btn" data-act="map" aria-pressed="${isDayOnMap(day?.id) ? "true" : "false"}">Show on map</button>`;
  section.appendChild(row);

  section.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "notes") editDayNotes(day.id);
    else if (act === "map") showDayOnMap(day.id);
    else if (act === "return") returnSameWay();
    const stop = e.target.closest("[data-stop-id]");
    if (stop) selectRow(stop);
  });
  section.addEventListener("keydown", (e) => {
    const stop = e.target.closest("[data-stop-id]");
    if (stop && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectRow(stop); }
  });
  return section;
}

/**
 * A row was chosen: frame it beside the panel, then open the stop's menu. A
 * day-hike row frames the spur with the stop it leaves from (`from_stop`),
 * and a stop is framed with its day hikes.
 */
function selectRow(row) {
  frameFeature(row.dataset.spurId || row.dataset.stopId);
  openStopMenu(row.dataset.stopId);
}

function stopRow(s, plan, d) {
  const p = s.f.properties;
  const camp = s.kind === "camp" ? plan.camps.find((c) => c.id === s.id) : null;
  let name = p.name || "";
  if (s.kind === "camp") name = camp ? `Camp ${camp.n}${p.name ? `, ${p.name}` : ""}` : p.name || offRouteLabel(s.id) || "Camp";
  else if (!name) name = KIND_LABEL[s.kind] || "Stop";
  const notes = [];
  if (s.kind === "water") {
    const src = p.water_source && p.water_source !== "other" ? cap(p.water_source) : "";
    const rel = p.reliability && p.reliability !== "unknown" ? p.reliability : "reliability unknown";
    notes.push([src, rel].filter(Boolean).join(", "));
  }
  if (camp && camp.nights > 1) notes.push(`${camp.nights} nights`);
  const pl = passLabel(s);
  if (pl === "out") notes.push("On the way out");
  else if (pl === "back") notes.push("On the way back");
  else if (pl) notes.push(cap(pl));
  if (p.notes) notes.push(p.notes);
  const row = document.createElement("div");
  row.className = "stop-row" + (s.offRoute ? " stop-row--off" : "");
  row.dataset.stopId = s.id;
  row.dataset.type = s.kind;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const at = s.offRoute ? "" : `${(Math.max(0, s.dayM) / MI).toFixed(1)} mi`;
  const off = s.offRoute ? `Off route, near mile ${(s.m / MI).toFixed(1)}${s.nearD != null ? ` (${s.nearD < 160 ? `${Math.round(s.nearD * 3.28084)} ft` : `${(s.nearD / MI).toFixed(1)} mi`} away)` : ""}` : "";
  row.innerHTML = `
    ${glyphIcon(glyphForKind(s.kind), { seed: seedOf(s.id), size: 24 })}
    <span class="stop-name ${NAME_CLASS[s.kind] || ""}">${escapeHTML(name)}</span>
    ${at ? `<span class="stop-at">${at}</span>` : "<span></span>"}
    <span class="stop-tools"><span class="tile-edit-btn" aria-hidden="true">Edit</span></span>
    ${off ? `<span class="stop-note stop-note--off">${escapeHTML(off)}</span>` : ""}
    ${notes.length ? `<span class="stop-note">${escapeHTML(notes.join(" · "))}</span>` : ""}`;
  row.setAttribute("aria-label", `${name}${at ? `, ${at} into day ${d.n}` : ""}. Open`);
  return row;
}

function spurRow(sp) {
  const row = document.createElement("div");
  row.className = "stop-row";
  row.dataset.type = "dayhike";
  row.dataset.spurId = sp.id;
  if (sp.fromStop) { row.dataset.stopId = sp.fromStop; row.tabIndex = 0; row.setAttribute("role", "button"); }
  row.innerHTML = `
    ${glyphIcon("dayhike", { seed: seedOf(sp.id), size: 24 })}
    <span class="stop-name is-dayhike">${escapeHTML(sp.f.properties.name || "Day hike")}</span>
    <span class="stop-at">${sp.rt.toFixed(1)} mi rt</span>
    <span></span>
    ${sp.f.properties.notes ? `<span class="stop-note">${escapeHTML(sp.f.properties.notes)}</span>` : ""}`;
  return row;
}

/**
 * GPX import, panel wiring: "Import GPX" (multi-select), drag-and-drop onto
 * the trip panel and "Assign by date". Files are read in the browser and
 * never sent anywhere. Parsing and route building live in gpx-core.js.
 */

import { map } from "./app.js"; // circular; only used at runtime
import { fetchElevationProfile } from "./planning.js"; // fallback for files without <ele>
import { confirm as confirmMotion } from "./design/motion.js";
import { parseGPX, buildRouteFeature, routeLabel, localDateISO } from "./gpx-core.js";
import { getActiveRegion, getCatalogRegions } from "./region-picker.js"; // circular; runtime only
import { loadGraph, pickGraphRegion } from "./routing.js";
import { matchTrack } from "./gpx-match.js";
import { deriveImportedName, isGenericRouteName } from "./route-names.js";

// ---------------------------------------------------------------------------
// Panel wiring
// ---------------------------------------------------------------------------

let TM = null; // TripManager, injected by initGpxImport (avoids an import cycle at load)
let noteTimer = 0;

const importedRoutes = (ids, trip) => (ids || [])
  .map((id) => trip.features.find((f) => f.properties._id === id))
  .filter((f) => f?.properties.type === "route" && f.properties.source?.type === "gpx");

function showNote(text) {
  const el = document.getElementById("gpxImportNote");
  if (!el) return;
  clearTimeout(noteTimer);
  el.textContent = text;
  el.hidden = !text;
  if (text) noteTimer = setTimeout(() => { el.hidden = true; }, 12000);
}

const readText = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error("could not read the file"));
  r.readAsText(file);
});

/**
 * Map-match a freshly built recording to the region's routing graph (if the
 * region has one): store the OSM way ids on its imported segment and, when the
 * name is only a made-up label ("May 3 · 1.3 mi", a device name), replace it
 * with "Dominant to Destination" from the trails it follows, flagged
 * `name_auto` like a planned route. A distinctive GPX name is kept. Best
 * effort: no graph, no match or any failure leaves the route as built.
 */
export async function applyTrailMatch(f) {
  try {
    const coords = f.geometry.coordinates;
    const pick = pickGraphRegion(getActiveRegion(), getCatalogRegions(), coords[0]);
    if (!pick?.info) return false;
    const m = matchTrack(await loadGraph(pick.info), coords);
    if (!(m.totalM > 0) || m.matchedM < m.totalM * 0.5) return false;
    if (m.wayIds.length) f.properties.segments[0].osm_way_ids = m.wayIds;
    if (isGenericRouteName(f.properties.name)) {
      const name = deriveImportedName(m.runs, m);
      if (name) { f.properties.name = name; f.properties.name_auto = true; }
    }
    return true;
  } catch (err) {
    console.warn("[gpx] trail match skipped:", err.message);
    return false;
  }
}

/** Import GPX files into the open trip. Returns { added, skipped } for callers and tests. */
export async function importGpxFiles(files) {
  const trip = TM?.currentTrip;
  if (!trip) return { added: 0, skipped: 0 };
  const built = [], problems = [];
  let duplicates = 0;
  const known = new Set(trip.features
    .filter((f) => f.properties?.source?.type === "gpx")
    .map((f) => `${f.properties.source.recorded_at}|${f.geometry.coordinates.length}|${f.geometry.coordinates[0]}`));
  const usedNames = new Set(trip.features.map((f) => (f.properties?.name || "").toLowerCase()));

  for (const file of files) {
    try {
      const tracks = parseGPX(await readText(file));
      let usable = 0;
      for (const t of tracks) {
        const f = buildRouteFeature(t, file.name);
        if (!f) continue;
        usable++;
        const key = `${f.properties.source.recorded_at}|${f.geometry.coordinates.length}|${f.geometry.coordinates[0]}`;
        if (f.properties.source.recorded_at && known.has(key)) { duplicates++; continue; }
        known.add(key);
        built.push(f);
      }
      if (!usable) problems.push(`${file.name} has no track or route with two points`);
    } catch (err) {
      problems.push(`${file.name}: ${err.message}`);
    }
  }

  built.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
  const added = [];
  for (const f of built) {
    f.properties.name = routeLabel(f, usedNames);
    await applyTrailMatch(f);
    const idx = TM.addFeature(f.geometry, f.properties);
    added.push(TM.currentTrip.features[idx]);
  }
  sortImportedByStart(trip);
  TM.render();
  TM.save();

  // Files with no <ele> fall back to Open-Meteo, like a drawn route.
  for (const f of added) if (!f.properties.elevation_profile) fetchElevationProfile(f.geometry.coordinates, f.properties._id);

  if (added.length) fitTo(added);
  const parts = [];
  if (added.length) parts.push(`Added ${added.length} ${added.length === 1 ? "recording" : "recordings"} to Unassigned.`);
  if (duplicates) parts.push(`${duplicates} already in this trip.`);
  parts.push(...problems.map((p) => p + "."));
  showNote(parts.join(" "));
  return { added: added.length, skipped: duplicates + problems.length };
}

/** Keep imported recordings in the Unassigned tray ordered by start time. */
function sortImportedByStart(trip) {
  const at = (id) => importedRoutes([id], trip)[0]?.properties.source.recorded_at;
  const slots = [];
  trip.unassigned.forEach((id, i) => { if (at(id)) slots.push(i); });
  const sorted = slots.map((i) => trip.unassigned[i]).sort((a, b) => at(a).localeCompare(at(b)));
  slots.forEach((slot, k) => { trip.unassigned[slot] = sorted[k]; });
}

function fitTo(features) {
  if (!map) return;
  const pts = features.flatMap((f) => f.geometry.coordinates);
  const b = pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0]));
  const panel = document.getElementById("tripPanel");
  const overlays = window.innerWidth > 640 && panel ? panel.offsetWidth : 0;
  const pad = 56;
  map.fitBounds(b, {
    padding: { top: pad, bottom: pad, left: pad, right: pad + overlays },
    maxZoom: 14,
    duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 800,
  });
}

/** Which unassigned recordings belong to which day, by the local date they started. */
function planAssignment(trip) {
  const byDate = new Map((trip.days || []).filter((d) => d.date).map((d) => [d.date, d]));
  const moves = [];
  let outside = 0;
  for (const f of importedRoutes(trip.unassigned, trip)) {
    const at = f.properties.source.recorded_at;
    if (!at) continue;
    const day = byDate.get(localDateISO(Date.parse(at)));
    if (day) moves.push({ id: f.properties._id, day }); else outside++;
  }
  return { moves, outside };
}

/** Put each unassigned recording into the day that matches its local start date. */
export function assignByDate() {
  const trip = TM?.currentTrip;
  if (!trip) return 0;
  const { moves, outside } = planAssignment(trip);
  for (const m of moves) TM.moveFeature(m.id, "day", m.day.id, null);
  // moveFeature appends; keep each day's recordings in start order.
  for (const day of trip.days) {
    const rec = (id) => importedRoutes([id], trip)[0]?.properties.source.recorded_at;
    const slots = [];
    day.features.forEach((id, i) => { if (rec(id)) slots.push(i); });
    const sorted = slots.map((i) => day.features[i]).sort((a, b) => rec(a).localeCompare(rec(b)));
    slots.forEach((s, k) => { day.features[s] = sorted[k]; });
  }
  TM.render();
  TM.save();
  showNote(moves.length
    ? `Put ${moves.length} ${moves.length === 1 ? "recording" : "recordings"} in the day it started.${outside ? ` ${outside} fall outside the trip dates.` : ""}`
    : "");
  return moves.length;
}

/** Show "Assign by date" only when it would do something. Called after each tray render. */
export function refreshGpxActions() {
  const btn = document.getElementById("assignByDateBtn");
  if (!btn) return;
  const trip = TM?.currentTrip;
  btn.hidden = !(trip && planAssignment(trip).moves.length);
}

const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

export function initGpxImport(TripManager) {
  TM = TripManager;
  const input = document.getElementById("importGpxInput");
  input?.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.value = "";
    if (files.length) await importGpxFiles(files);
  });

  document.getElementById("assignByDateBtn")?.addEventListener("click", (e) => {
    if (assignByDate()) confirmMotion(e.currentTarget);
  });

  // Drop .gpx files anywhere on the panel. Feature chips drag as text, so
  // only drags that carry Files are ours.
  const panel = document.getElementById("tripPanel");
  if (!panel) return;
  let depth = 0;
  const over = (on) => panel.classList.toggle("is-file-over", on);
  panel.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; over(true); } });
  panel.addEventListener("dragleave", (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; over(false); } });
  panel.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, true);
  panel.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    over(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.gpx$/i.test(f.name) || /gpx/.test(f.type));
    if (!files.length) { showNote("Drop .gpx files to import them."); return; }
    await importGpxFiles(files);
  }, true);
}

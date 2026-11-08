/**
 * OutHere Trip Planning — Trip State & Sidebar UI
 *
 * Manages the trip data model, renders it on MapLibre,
 * builds the notebook sidebar (sketchbook profile, overview, continuous day
 * story; see itinerary-panel.js), and handles
 * localStorage persistence and GeoJSON download/upload.
 *
 * Data model (schema v4):
 *   trip.features          — flat array of all feature objects (GeoJSON / MapLibre source)
 *   trip.unassigned        — array of feature IDs not yet assigned to a day
 *   trip.days              — array of { id, date, features: [featureId, ...], notes }
 *   trip.properties.readme — markdown string for the Overview section
 *
 * CDN global: maplibregl (classic script in index.html).
 */

import { map } from "./app.js"; // circular with app.js; only used at runtime
import {
  cancelDrawing,
  initPointTypeSelector,
  startRouteDrawing,
  startDeleteMode,
  exitDeleteMode,
  isDeleteMode,
  getTripDateRange,
  buildRoutingOverlay,
  prefetchRoutingGraph,
  isDrawingRoute,
} from "./planning.js";
import { buildItinerary, kindOf, ruleSVG, mentionsMeal } from "./itinerary-profile.js";
import { initItineraryPanel, updateItinerary, setItineraryCompact } from "./itinerary-panel.js";
import { glyphIcon, glyphDefsSVG } from "./sketch.js";
import { confirm as confirmMotion } from "./design/motion.js";
import { TripsStore, hideTripsHome } from "./trips-home.js"; // circular; only used at runtime
import { getActiveRegionId } from "./region-picker.js"; // circular; only used at runtime

// ---------------------------------------------------------------------------
// Trip state manager
// ---------------------------------------------------------------------------
// Persistence lives in TripsStore (trips-home.js): an index plus one
// localStorage entry per trip, keyed by trip_id.

// Canonical trip format version (see outhere/trips/trip.schema.json + FORMAT.md).
// Distinct from the legacy _schema_version integer migration counter.
// 1.1 adds per-leg routing provenance (`segments`, `routing`); 1.0 files
// remain valid and are still read.
const TRIP_SCHEMA_VERSION = "1.1";
const READABLE_SCHEMA_VERSIONS = ["1.0", "1.1"];

let activeDayId = null;       // day ID highlighted on the map ("Show on map"), or null
let drawIntoDayId = null;     // "Draw route" from an empty day: new features land in that day
let editingNotesDayId = null; // day whose notes are open in the editor
let confirmFeatureId = null;  // feature just dropped into a day (gets the confirm shiver)

export const TripManager = {
  currentTrip: null,

  create(name, { location = "", startDate = null, nights = 0 } = {}) {
    this.currentTrip = {
      type: "FeatureCollection",
      properties: {
        trip_id: crypto.randomUUID(),
        name: name || "Untitled Trip",
        location,
        created: new Date().toISOString(),
        sharing: "private",
        readme: "",
        notes: "",
        region: getActiveRegionId(),
        schema_version: TRIP_SCHEMA_VERSION,
        _schema_version: 4,
        dates: startDate ? {
          start: startDate,
          end: offsetDate(startDate, nights),
        } : null,
      },
      days: [],
      unassigned: [],
      features: [],
    };
    // Pre-create days
    for (let i = 0; i <= nights; i++) {
      this.currentTrip.days.push({
        id: crypto.randomUUID(),
        date: startDate ? offsetDate(startDate, i) : null,
        features: [],
        notes: "",
      });
    }
    hideTripsHome(); // creating a trip leaves the home view
    this.render();
    this.save();
  },

  /** Add a feature, assign it a stable ID, and place it in the unassigned pool. */
  addFeature(geometry, properties) {
    const id = crypto.randomUUID();
    properties._id = id;
    this.currentTrip.features.push({ type: "Feature", geometry, properties });
    // Started from a day's "Draw route": the new route and its points go
    // straight into that day instead of the unassigned tray.
    const intoDay = isDrawingRoute && drawIntoDayId && this.currentTrip.days?.find(d => d.id === drawIntoDayId);
    if (intoDay) (intoDay.features ||= []).push(id);
    else this.currentTrip.unassigned.push(id);
    const idx = this.currentTrip.features.length - 1;
    this.render();
    this.save();
    return idx;
  },

  removeFeature(index) {
    const feature = this.currentTrip.features[index];
    if (!feature) return;
    const id = feature.properties._id;

    this.currentTrip.features.splice(index, 1);

    // Remove from unassigned
    this.currentTrip.unassigned = (this.currentTrip.unassigned || []).filter(fid => fid !== id);

    // Remove from any day
    for (const day of (this.currentTrip.days || [])) {
      day.features = (day.features || []).filter(fid => fid !== id);
    }

    this.render();
    this.save();
  },

  updateFeature(index, properties) {
    Object.assign(this.currentTrip.features[index].properties, properties);
    this.render();
    this.save();
  },

  addDay() {
    if (!this.currentTrip.days) this.currentTrip.days = [];
    const idx = this.currentTrip.days.length;
    const day = {
      id: crypto.randomUUID(),
      date: computeDayDate(this.currentTrip, idx),
      features: [],
      notes: "",
    };
    this.currentTrip.days.push(day);
    this.render();
    this.save();
  },

  /** Move a feature to a new location: "day" (with optional insertBeforeId) or "unassigned". */
  moveFeature(featureId, targetType, targetDayId, insertBeforeId) {
    const trip = this.currentTrip;
    if (!trip) return;

    // Remove from unassigned and all days
    trip.unassigned = (trip.unassigned || []).filter(id => id !== featureId);
    for (const day of (trip.days || [])) {
      day.features = (day.features || []).filter(id => id !== featureId);
    }

    if (targetType === "unassigned") {
      trip.unassigned.push(featureId);
    } else if (targetType === "day") {
      const day = trip.days.find(d => d.id === targetDayId);
      if (!day) return;
      if (!day.features) day.features = [];
      if (insertBeforeId) {
        const idx = day.features.indexOf(insertBeforeId);
        day.features.splice(idx !== -1 ? idx : day.features.length, 0, featureId);
      } else {
        day.features.push(featureId);
      }
    }

    this.render();
    this.save();
  },

  /** Update MapLibre source and sidebar. */
  render() {
    if (map.getSource("trip")) {
      // Routed routes/spurs also render per leg (trail / manual / straight
      // + gap pins); the overlay never touches the stored trip.
      const trip = this.currentTrip;
      map.getSource("trip").setData(trip
        ? { type: "FeatureCollection", features: [...trip.features, ...buildRoutingOverlay(trip)] }
        : { type: "FeatureCollection", features: [] });
    }
    renderSidebar();
    renderTripTitle();
    renderMetaChips();
  },

  save() {
    if (!this.currentTrip) return;
    const props = this.currentTrip.properties;
    if (!props.trip_id) props.trip_id = crypto.randomUUID();
    // Stamp the active region on trips that don't carry one yet (legacy /
    // imported trips). An explicit region switch while a trip is open
    // re-stamps it in region-picker.js.
    if (!props.region) props.region = getActiveRegionId();
    props.updated = new Date().toISOString();
    try {
      TripsStore.saveTrip(this.currentTrip);
      TripsStore.setActiveTripId(props.trip_id);
    } catch (err) {
      // Quota exceeded or storage unavailable — keep the app running
      console.warn("[trip] could not save trip to localStorage:", err.message);
    }
  },

  loadFromStorage() {
    const activeId = TripsStore.getActiveTripId();
    if (!activeId) return false;
    const saved = TripsStore.loadTrip(activeId);
    if (!saved) {
      // Stale pointer (trip deleted or corrupt) — clear it
      TripsStore.setActiveTripId(null);
      return false;
    }
    this.currentTrip = migrateTrip(saved);
    this.render();
    prefetchRoutingGraph();
    return true;
  },

  /** Make an already-parsed stored trip the open one (used by trips home). */
  setTrip(trip) {
    // A half-drawn route belongs to the trip it was started in — don't let
    // finishRouteDrawing deposit it into the newly opened trip.
    cancelDrawing();
    this.currentTrip = migrateTrip(trip);
    this.render();
    this.save();
    prefetchRoutingGraph();
  },

  loadFromGeoJSON(geojson) {
    if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
      throw new Error("Invalid GeoJSON: expected a FeatureCollection");
    }
    if (!geojson.properties || !geojson.properties.trip_id) {
      geojson.properties = {
        trip_id: crypto.randomUUID(),
        name: geojson.properties?.name || "Imported Trip",
        created: new Date().toISOString(),
        sharing: "private",
        ...geojson.properties,
      };
    }
    this.currentTrip = migrateTrip(geojson);
    this.render();
    this.save();
  },

  buildExport() {
    return buildTripExport(this.currentTrip);
  },

  download() {
    downloadTripGeoJSON(this.currentTrip);
  },

  exportMarkdown() {
    if (!this.currentTrip) return;
    const trip = this.currentTrip;
    const name = trip.properties.name || "Untitled Trip";
    const location = trip.properties.location || "";

    let md = `# ${name}${location ? ` — ${location}` : ""}\n\n`;

    if (trip.properties.readme?.trim()) {
      md += trip.properties.readme.trim() + "\n\n";
    }

    for (let i = 0; i < (trip.days || []).length; i++) {
      const day = trip.days[i];
      const dateLabel = day.date ? formatDateLabel(day.date) : null;
      const heading = `Day ${i + 1}${dateLabel ? ` — ${dateLabel}` : ""}`;
      md += `---\n\n## ${heading}\n\n`;

      // Auto-summary from assigned features
      const dayFeatures = (day.features || [])
        .map(id => trip.features.find(f => f.properties._id === id))
        .filter(Boolean);

      for (const f of dayFeatures) {
        const props = f.properties;
        const type = getDisplayType(props);
        const label = getFeatureLabel(props, type);
        const stats = getFeatureStats(props, type);
        md += `- **${label}**${stats ? ` — ${stats}` : ""}\n`;
      }

      if (dayFeatures.length > 0) md += "\n";

      if (day.notes?.trim()) {
        md += day.notes.trim() + "\n\n";
      } else {
        md += "\n";
      }
    }

    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "trip";
    a.download = `${slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
  },

  /** Close the current trip (it stays saved in the trips store). */
  clear() {
    TripsStore.setActiveTripId(null);
    this.currentTrip = null;
    this.render();
  },
};

// ---------------------------------------------------------------------------
// Canonical export helpers (shared with trips-home.js so any stored trip can
// be exported without opening it)
// ---------------------------------------------------------------------------

/**
 * Build the canonical export document (schema_version 1.1) without mutating
 * the live trip: stamps schema_version, mirrors the readme into `notes`
 * (mobile reads `notes`), and guarantees a `dates` key.
 */
export function buildTripExport(trip) {
  if (!trip) return null;
  const out = JSON.parse(JSON.stringify(trip));
  out.properties.schema_version = TRIP_SCHEMA_VERSION;
  // The UI edits `readme`; write `notes` from the same value for mobile.
  out.properties.notes = out.properties.readme || "";
  if (out.properties.dates === undefined) out.properties.dates = null;
  if (!Array.isArray(out.days)) out.days = [];
  if (!Array.isArray(out.unassigned)) out.unassigned = [];
  return out;
}

export function downloadTripGeoJSON(trip) {
  const exportTrip = buildTripExport(trip);
  if (!exportTrip) return;

  // Lightweight structural self-check against the canonical format.
  // Warn (don't block) so users can still get their data out.
  const problems = validateTripExport(exportTrip);
  if (problems.length > 0) {
    console.warn(
      `[trip] export does not conform to trip schema ${TRIP_SCHEMA_VERSION} ` +
      `(${problems.length} issue${problems.length !== 1 ? "s" : ""}):\n- ` +
      problems.join("\n- ")
    );
  }

  const data = JSON.stringify(exportTrip, null, 2);
  const blob = new Blob([data], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug = (exportTrip.properties.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_") || "trip";
  a.download = `${slug}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Data migration
// ---------------------------------------------------------------------------

export function migrateTrip(trip) {
  if (!trip || !trip.properties) return trip;

  // v1 → v2: add point_type to waypoints / camps
  if ((trip.properties._schema_version || 1) < 2) {
    for (const f of trip.features) {
      // Legacy web v1 used type "waypoint" for what became dayhike points.
      // Canonical files (schema_version "1.0", e.g. from schema.py/mobile)
      // carry real waypoints (subtype water|hazard|...) — never stamp those.
      if (f.properties.type === "waypoint" && !f.properties.point_type &&
          !trip.properties.schema_version) {
        f.properties.point_type = "dayhike";
      }
      if (f.properties.type === "camp" && !f.properties.point_type) {
        f.properties.point_type = "camp";
      }
    }
    trip.properties._schema_version = 2;
  }

  // v2 → v3: add feature IDs, unassigned pool, days array, readme
  if ((trip.properties._schema_version || 1) < 3) {
    for (const f of trip.features) {
      if (!f.properties._id) {
        f.properties._id = crypto.randomUUID();
      }
    }
    if (!trip.unassigned) {
      // Only pool features not already assigned to a day (canonical files
      // may carry days without an unassigned member — both are optional).
      const assigned = new Set((trip.days || []).flatMap(d => d.features || []));
      trip.unassigned = trip.features
        .map(f => f.properties._id)
        .filter(id => !assigned.has(id));
    }
    if (!trip.days) {
      trip.days = [];
    }
    if (!trip.properties.readme) {
      trip.properties.readme = "";
    }
    trip.properties._schema_version = 3;
  }

  // v3 → v4: add per-day notes and trip location
  if ((trip.properties._schema_version || 1) < 4) {
    if (!trip.properties.location) {
      trip.properties.location = "";
    }
    for (const day of (trip.days || [])) {
      if (!day.notes) day.notes = "";
    }
    trip.properties._schema_version = 4;
  }

  // Normalization (idempotent): files from schema.py / mobile carry trip text
  // in `notes` only — surface it in the readme editor.
  if (!trip.properties.readme && trip.properties.notes) {
    trip.properties.readme = trip.properties.notes;
  }

  return trip;
}

// ---------------------------------------------------------------------------
// Export self-check — lightweight structural validation against the canonical
// trip format (outhere/trips/trip.schema.json, schema_version 1.0). This is
// deliberately NOT a JSON-Schema engine; it checks required fields and
// geometry types and returns a list of human-readable problems.
// ---------------------------------------------------------------------------

const FEATURE_GEOMETRY_TYPES = {
  route: "LineString",
  dayhike_spur: "LineString",
  gps_track: "LineString",
  camp: "Point",
  dayhike: "Point",
  rest: "Point",
  waypoint: "Point",
  photo: "Point",
};

const WAYPOINT_SUBTYPES = ["water", "hazard", "resupply", "scenic"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateTripExport(trip) {
  const problems = [];
  const push = (msg) => problems.push(msg);

  if (!trip || typeof trip !== "object") return ["trip is not an object"];
  if (trip.type !== "FeatureCollection") push(`type is "${trip.type}", expected "FeatureCollection"`);

  // --- properties ---
  const meta = trip.properties;
  if (!meta || typeof meta !== "object") {
    push("missing top-level properties object");
  } else {
    if (typeof meta.trip_id !== "string" || meta.trip_id.length === 0) push("properties.trip_id missing or empty");
    if (typeof meta.name !== "string") push("properties.name missing");
    if (!READABLE_SCHEMA_VERSIONS.includes(meta.schema_version)) {
      push(`properties.schema_version is ${JSON.stringify(meta.schema_version)}, expected one of ${READABLE_SCHEMA_VERSIONS.join(", ")}`);
    }
    if (meta.dates !== null && meta.dates !== undefined) {
      if (typeof meta.dates !== "object" ||
          !ISO_DATE_RE.test(meta.dates.start || "") ||
          !ISO_DATE_RE.test(meta.dates.end || "")) {
        push("properties.dates must be null or { start, end } with YYYY-MM-DD strings");
      }
    }
    if (meta.sharing !== undefined && !["private", "link", "public"].includes(meta.sharing)) {
      push(`properties.sharing "${meta.sharing}" not one of private|link|public`);
    }
  }

  // --- features ---
  if (!Array.isArray(trip.features)) {
    push("features is not an array");
    return problems;
  }

  const featureIds = new Set();
  trip.features.forEach((f, i) => {
    const where = `features[${i}]`;
    if (!f || f.type !== "Feature") { push(`${where}: type is not "Feature"`); return; }
    if (!f.geometry || typeof f.geometry !== "object") { push(`${where}: missing geometry`); return; }
    if (!f.properties || typeof f.properties !== "object") { push(`${where}: missing properties`); return; }

    const ftype = f.properties.type;
    if (typeof ftype !== "string" || !ftype) {
      push(`${where}: properties.type missing`);
      return;
    }

    const expectedGeom = FEATURE_GEOMETRY_TYPES[ftype];
    if (expectedGeom && f.geometry.type !== expectedGeom) {
      push(`${where} (${ftype}): geometry.type is "${f.geometry.type}", expected "${expectedGeom}"`);
    }
    if (!Array.isArray(f.geometry.coordinates)) {
      push(`${where} (${ftype}): geometry.coordinates is not an array`);
    } else if (f.geometry.type === "LineString" && f.geometry.coordinates.length < 2) {
      push(`${where} (${ftype}): LineString has fewer than 2 positions`);
    } else if (f.geometry.type === "Point" &&
               (f.geometry.coordinates.length < 2 || typeof f.geometry.coordinates[0] !== "number")) {
      push(`${where} (${ftype}): Point coordinates are not [lon, lat]`);
    }

    if (ftype === "waypoint" && !WAYPOINT_SUBTYPES.includes(f.properties.subtype)) {
      push(`${where}: waypoint subtype "${f.properties.subtype}" not one of ${WAYPOINT_SUBTYPES.join("|")}`);
    }
    if (ftype === "dayhike_spur" &&
        (!Number.isInteger(f.properties.route_index) || f.properties.route_index < 0)) {
      push(`${where}: dayhike_spur missing non-negative integer route_index`);
    }
    if (ftype === "route" || ftype === "dayhike_spur") {
      validateRoutingProvenance(f, where, push);
    }
    if (["camp", "dayhike", "rest"].includes(ftype) &&
        f.properties.date !== undefined && f.properties.date !== "" &&
        !ISO_DATE_RE.test(f.properties.date)) {
      push(`${where} (${ftype}): date "${f.properties.date}" is neither "" nor YYYY-MM-DD`);
    }

    if (typeof f.properties._id === "string") featureIds.add(f.properties._id);
  });

  // --- days / unassigned referential integrity ---
  (trip.days || []).forEach((day, i) => {
    if (!day || typeof day.id !== "string" || !day.id) push(`days[${i}]: missing id`);
    if (day && day.date != null && !ISO_DATE_RE.test(day.date)) {
      push(`days[${i}]: date "${day.date}" is neither null nor YYYY-MM-DD`);
    }
    for (const fid of (day?.features || [])) {
      if (!featureIds.has(fid)) push(`days[${i}] references unknown feature _id ${fid}`);
    }
  });
  for (const fid of (trip.unassigned || [])) {
    if (!featureIds.has(fid)) push(`unassigned references unknown feature _id ${fid}`);
  }

  return problems;
}

const SEGMENT_MODES = ["trail", "straight", "manual", "imported"];
const SEGMENT_REASONS = ["no_path", "no_graph", "cross_region"];
const isIndex = (n) => Number.isInteger(n) && n >= 0;

/** schema 1.1 `segments` / `routing` on route and dayhike_spur features (both optional). */
function validateRoutingProvenance(f, where, push) {
  const p = f.properties;
  if (p.segments !== undefined) {
    if (!Array.isArray(p.segments)) {
      push(`${where}: segments is not an array`);
    } else {
      const nCoords = Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates.length : 0;
      p.segments.forEach((seg, k) => {
        const at = `${where}.segments[${k}]`;
        if (!seg || typeof seg !== "object") { push(`${at}: not an object`); return; }
        if (!SEGMENT_MODES.includes(seg.mode)) push(`${at}: mode "${seg.mode}" not one of ${SEGMENT_MODES.join("|")}`);
        if (seg.reason !== undefined && !SEGMENT_REASONS.includes(seg.reason)) push(`${at}: reason "${seg.reason}" not one of ${SEGMENT_REASONS.join("|")}`);
        if (!isIndex(seg.from_vertex) || !isIndex(seg.to_vertex)) push(`${at}: from_vertex/to_vertex must be non-negative integers`);
        if (seg.coord_range !== undefined) {
          const r = seg.coord_range;
          if (!Array.isArray(r) || r.length !== 2 || !r.every(isIndex) || r[0] > r[1] || r[1] >= nCoords) {
            push(`${at}: coord_range must be [start, end] indices into geometry.coordinates`);
          }
        }
        if (seg.length_m !== undefined && !(typeof seg.length_m === "number" && seg.length_m >= 0)) push(`${at}: length_m must be a number >= 0`);
        if (seg.osm_way_ids !== undefined && !(Array.isArray(seg.osm_way_ids) && seg.osm_way_ids.every(Number.isInteger))) {
          push(`${at}: osm_way_ids must be an array of integers`);
        }
      });
    }
  }
  if (p.routing !== undefined && (!p.routing || p.routing.engine !== "booot-graph")) {
    push(`${where}: routing.engine must be "booot-graph"`);
  }
}

// ---------------------------------------------------------------------------
// Auto-calculate day date from trip start + day index
// ---------------------------------------------------------------------------

function computeDayDate(trip, dayIndex) {
  const start = trip.properties.dates?.start;
  if (!start) return null;
  return offsetDate(start, dayIndex);
}

function offsetDate(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sidebar: trip title + metadata chips
// ---------------------------------------------------------------------------

function renderTripTitle() {
  const titleEl = document.getElementById("tripTitle");
  if (!titleEl) return;
  const name = TripManager.currentTrip?.properties?.name || "Untitled Trip";
  if (document.activeElement !== titleEl) {
    titleEl.textContent = name;
  }
}

function renderMetaChips() {
  const el = document.getElementById("tripMetaChips");
  if (!el) return;
  const trip = TripManager.currentTrip;
  if (!trip || !trip.features.length) { el.innerHTML = ""; return; }

  // Route miles are what the day totals add up to; round-trip day hikes are
  // shown beside them, not folded in.
  let totalMi = 0, dayhikeMi = 0;
  for (const f of trip.features) {
    if (f.properties.type === "route") {
      totalMi += f.properties.main_route_distance_mi || 0;
      dayhikeMi += f.properties.dayhike_distance_mi || 0;
    }
  }
  const dayhikeHTML = dayhikeMi >= 0.05
    ? `<span class="meta-chip-extra" aria-hidden="true">·</span><span class="meta-chip-extra">+<span class="meta-chip-num">${dayhikeMi.toFixed(1)}</span> day hike${dayhikeMi >= 1.05 || dayhikeMi < 0.95 ? "s" : ""}</span>` : "";
  const dayCount = trip.days?.length || 0;

  const chips = [];
  if (totalMi > 0) chips.push(
    `<div class="meta-chip"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><polyline points="1,10 4,3 6,7 8,1 11,10"/></svg>${totalMi.toFixed(1)} mi${dayhikeHTML}</div>`
  );
  if (dayCount > 0) chips.push(
    `<div class="meta-chip"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="10" height="9" rx="1"/><line x1="1" y1="5" x2="11" y2="5"/><line x1="4" y1="1" x2="4" y2="3"/><line x1="8" y1="1" x2="8" y2="3"/></svg>${dayCount} day${dayCount !== 1 ? "s" : ""}</div>`
  );
  el.innerHTML = chips.join("");
}

// ---------------------------------------------------------------------------
// Notebook: top-level render dispatcher
// ---------------------------------------------------------------------------

function renderSidebar() {
  renderNotebook();
}

function renderNotebook() {
  renderOverview();
  renderUnassignedPool();
  renderDaySections();
}

function renderOverview() {
  const editor = document.getElementById("readmeEditor");
  if (!editor) return;
  const content = TripManager.currentTrip?.properties?.readme || "";
  if (document.activeElement !== editor) {
    editor.value = content;
  }
}

function renderUnassignedPool() {
  const chipsEl = document.getElementById("unassignedChips");
  const poolEl = document.getElementById("unassignedPool");
  if (!chipsEl) return;
  chipsEl.innerHTML = "";

  const trip = TripManager.currentTrip;
  const unassignedFeatures = trip ? (trip.unassigned || [])
    .map(id => trip.features.find(f => f.properties._id === id))
    .filter(Boolean) : [];

  // The tray only takes room when it holds something (or while you drag or
  // draw: then it's where a feature can go back to / where the new route lands).
  poolEl?.classList.toggle("has-items", unassignedFeatures.length > 0);
  if (unassignedFeatures.length === 0) {
    chipsEl.innerHTML = `<span class="pool-empty">Drop here to take it out of its day.</span>`;
    return;
  }

  for (const f of unassignedFeatures) {
    chipsEl.appendChild(buildFeatureChip(f));
  }
}

/** The continuous day story (direction A): one column, no accordions. */
function renderDaySections() {
  const container = document.getElementById("daySections");
  if (!container) return;
  container.innerHTML = "";

  const trip = TripManager.currentTrip;
  if (!trip || !trip.days) {
    updateItinerary(null, []);
    return;
  }

  // Drop the map highlight if the highlighted day no longer exists
  if (activeDayId && !trip.days.some(d => d.id === activeDayId)) {
    setActiveDayHighlight(null);
  }

  const model = buildItinerary(trip);
  const modelDays = model.mode === "days" ? model.days : [];
  const tripIsEmpty = trip.features.length === 0;
  const sections = trip.days.map((day, idx) => buildDaySection(day, idx, modelDays[idx], tripIsEmpty));
  sections.forEach(s => container.appendChild(s));
  updateItinerary(trip, sections, model);

  if (confirmFeatureId) {
    const row = container.querySelector(`.feature-tile[data-id="${CSS.escape(confirmFeatureId)}"]`);
    confirmFeatureId = null;
    if (row) confirmMotion(row);
  }
}

// ---------------------------------------------------------------------------
// Map: day highlight
// ---------------------------------------------------------------------------

function setActiveDayHighlight(dayId) {
  activeDayId = dayId;

  // Update sidebar visual state
  document.querySelectorAll(".itin-day").forEach(section => {
    const isActive = section.dataset.dayId === dayId;
    section.classList.toggle("day-active", isActive);
    section.querySelector(".day-map-btn")?.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  if (!map || !map.isStyleLoaded()) return;

  const tripLayerIds = [
    "trip-routes", "trip-dayhike-spurs",
    "trip-legs-casing", "trip-legs-trail", "trip-legs-manual", "trip-legs-straight", "trip-gap-pins", "trip-gap-pins-dot",
    "trip-camps", "trip-dayhikes", "trip-rest", "trip-waypoints",
    "trip-labels",
  ];

  for (const layerId of tripLayerIds) {
    const layer = map.getLayer(layerId);
    if (!layer) continue;
    const type = layer.type;

    if (dayId) {
      const activeIds = TripManager.currentTrip?.days?.find(d => d.id === dayId)?.features || [];
      const dimExpr = ["case", ["in", ["get", "_id"], ["literal", activeIds]], 1, 0.2];
      if (type === "line") {
        map.setPaintProperty(layerId, "line-opacity", dimExpr);
      } else if (type === "circle") {
        map.setPaintProperty(layerId, "circle-opacity", dimExpr);
        map.setPaintProperty(layerId, "circle-stroke-opacity", dimExpr);
      } else if (type === "symbol") {
        map.setPaintProperty(layerId, "text-opacity", dimExpr);
      }
    } else {
      // Reset to full opacity
      if (type === "line") {
        map.setPaintProperty(layerId, "line-opacity", 1);
      } else if (type === "circle") {
        map.setPaintProperty(layerId, "circle-opacity", 1);
        map.setPaintProperty(layerId, "circle-stroke-opacity", 1);
      } else if (type === "symbol") {
        map.setPaintProperty(layerId, "text-opacity", 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop state & utilities
// ---------------------------------------------------------------------------

let activeDragFeatureId = null;
let currentDragIndicator = null;

function getDragInsertBeforeId(e, container) {
  const items = [...container.querySelectorAll(".feature-tile:not(.dragging)")];
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) return item.dataset.id || null;
  }
  return null; // Append at end
}

function showDragIndicator(container, insertBeforeId) {
  if (currentDragIndicator) currentDragIndicator.remove();
  const indicator = document.createElement("div");
  indicator.className = "drag-drop-indicator";
  currentDragIndicator = indicator;
  const target = insertBeforeId ? container.querySelector(`[data-id="${insertBeforeId}"]`) : null;
  container.insertBefore(indicator, target || null);
}

function clearDragIndicator() {
  if (currentDragIndicator) {
    currentDragIndicator.remove();
    currentDragIndicator = null;
  }
}

function parseDragData(e) {
  try {
    return JSON.parse(e.dataTransfer.getData("application/x-feature"));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sidebar: build unassigned chip
// ---------------------------------------------------------------------------

function buildFeatureChip(feature) {
  const props = feature.properties;
  const type = getDisplayType(props);
  const chip = document.createElement("div");
  chip.className = "feature-chip";
  chip.dataset.id = props._id || "";
  chip.dataset.type = type || "waypoint";
  chip.draggable = true;

  chip.innerHTML = `
    <span class="chip-icon">${buildTypeIconHTML(type)}</span>
    <span class="chip-name">${escapeHTML(getFeatureLabel(props, type))}</span>
  `;

  chip.addEventListener("click", () => {
    const idx = TripManager.currentTrip.features.findIndex(f => f.properties._id === props._id);
    if (idx !== -1) zoomToFeature(idx);
  });

  chip.addEventListener("dragstart", (e) => {
    activeDragFeatureId = props._id;
    document.body.classList.add("is-dragging-feature");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-feature", JSON.stringify({
      featureId: props._id,
      sourceType: "unassigned",
      sourceDayId: null,
    }));
    requestAnimationFrame(() => chip.classList.add("dragging"));
  });

  chip.addEventListener("dragend", () => {
    activeDragFeatureId = null;
    document.body.classList.remove("is-dragging-feature");
    chip.classList.remove("dragging");
    clearDragIndicator();
  });

  return chip;
}

// ---------------------------------------------------------------------------
// Sidebar: build day section (continuous story: label, date, pencil rule,
// totals; then the route as the day's title, notes, and the stops)
// ---------------------------------------------------------------------------

/**
 * @param {object} day      trip.days[dayIndex]
 * @param {number} dayIndex
 * @param {object} [mday]   the day in buildItinerary()'s model (stop miles), if routed
 * @param {boolean} tripIsEmpty  nothing drawn yet: the profile carries the instruction
 */
function buildDaySection(day, dayIndex, mday, tripIsEmpty) {
  const trip = TripManager.currentTrip;
  const dayFeatures = (day.features || [])
    .map(id => trip.features.find(f => f.properties._id === id))
    .filter(Boolean);
  const stats = computeDayStats(dayFeatures);
  const n = dayIndex + 1;

  const section = document.createElement("section");
  section.className = "itin-day" + (activeDayId === day.id ? " day-active" : "") + (dayFeatures.length ? "" : " is-empty");
  section.dataset.dayId = day.id;
  section.dataset.dayIndex = String(dayIndex);
  section.tabIndex = -1;
  const labelId = `day-label-${dayIndex}`;
  section.setAttribute("aria-labelledby", labelId);

  // ── Head: label, date, pencil rule, totals ────────────────────────────────
  const dateLabel = day.date ? formatDateLabel(day.date) : "";
  // Route miles only, so the header matches the profile's day tag; day-hike
  // spurs show their own round trip in the stop list.
  const routeMi = dayFeatures.reduce((m, f) => m + (getDisplayType(f.properties) === "route" ? (f.properties.main_route_distance_mi || 0) : 0), 0);
  let sum = "";
  if (routeMi > 0) {
    sum = `${routeMi.toFixed(1)} mi`;
    if (stats.totalElevGain > 0 || stats.totalElevLoss > 0) {
      sum += ` · +${stats.totalElevGain.toLocaleString("en-US")}<span class="loss"> −${stats.totalElevLoss.toLocaleString("en-US")}</span> ft`;
    }
  }
  section.innerHTML = `
    <header class="itin-day-head">
      <h3 class="itin-day-label" id="${labelId}">Day ${n}</h3>
      ${dateLabel ? `<span class="itin-day-date">${escapeHTML(dateLabel)}</span>` : ""}
      ${ruleSVG(dayIndex)}
      ${sum ? `<span class="itin-day-sum">${sum}</span>` : ""}
    </header>`;

  // ── Body: the drop target. Routes first (the first one is the day's
  // title), then the notes, then stops in walking order. ─────────────────────
  const list = document.createElement("div");
  list.className = "day-feature-list";

  const stopMi = new Map((mday?.stops || []).map(s => [s.id, s.dayMi]));
  const spurById = new Map((mday?.spurs || []).map(s => [s.id, s]));
  const routes = dayFeatures.filter(f => getDisplayType(f.properties) === "route");
  const others = dayFeatures.filter(f => getDisplayType(f.properties) !== "route");
  const orderMi = (f) => {
    const id = f.properties._id;
    if (spurById.has(id)) return spurById.get(id).at - mday.startMi + 0.02;
    if (stopMi.has(id)) return stopMi.get(id) + (getDisplayType(f.properties) === "camp" ? 0.01 : 0);
    return Infinity;
  };
  if (mday && !mday.empty) others.sort((a, b) => orderMi(a) - orderMi(b));

  const camp = others.find(f => getDisplayType(f.properties) === "camp" && f.properties.name);
  routes.forEach((f, k) => {
    list.appendChild(buildFeatureTile(f, day.id, k === 0
      ? { variant: "title", fallbackTitle: camp ? `To ${camp.properties.name}` : "" }
      : { variant: "stop" }));
  });
  list.appendChild(buildNotesBlock(day));
  for (const f of others) {
    const id = f.properties._id;
    const sp = spurById.get(id);
    list.appendChild(buildFeatureTile(f, day.id, {
      variant: "stop",
      atMi: mday && !mday.empty && stopMi.has(id) ? stopMi.get(id) : null,
      rt: sp ? sp.rt : null,
    }));
  }

  if (dayFeatures.length === 0) {
    const empty = document.createElement("div");
    empty.className = "itin-day-empty";
    empty.innerHTML = tripIsEmpty
      ? `<p>Nothing planned yet.</p>`
      : `<p>Nothing planned yet. Draw a route for this day, or drag a stop here.</p>
         <button type="button" class="btn btn--quiet btn--sm" data-act="draw">Draw route</button>`;
    list.appendChild(empty);
  }
  section.appendChild(list);

  // ── Edit row: appears on hover / focus (always on touch) ──────────────────
  const hasNotes = !!day.notes?.trim();
  const row = document.createElement("div");
  row.className = "itin-edit-row";
  row.innerHTML = `
    ${editingNotesDayId === day.id ? "" : `<button type="button" class="btn btn--ghost btn--sm" data-act="notes">${hasNotes ? "Edit notes" : "Add notes"}</button>`}
    ${dayFeatures.length ? `<button type="button" class="btn btn--ghost btn--sm day-map-btn" data-act="map" aria-pressed="${activeDayId === day.id ? "true" : "false"}">Show on map</button>` : ""}`;
  section.appendChild(row);

  section.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "notes") {
      editingNotesDayId = day.id;
      renderDaySections();
    } else if (act === "map") {
      const on = activeDayId !== day.id;
      setActiveDayHighlight(on ? day.id : null);
      if (on) fitToFeatures(dayFeatures);
    } else if (act === "draw") {
      drawIntoDayId = day.id;
      startRouteDrawing();
    }
  });

  return section;
}

/** Day notes: read as text; click (or "Edit notes") to write. */
function buildNotesBlock(day) {
  const wrap = document.createElement("div");
  wrap.className = "itin-notes";
  if (editingNotesDayId === day.id) {
    const ta = document.createElement("textarea");
    ta.className = "notes-editor itin-notes-editor";
    ta.placeholder = "Water, hazards, beta, key distances. Markdown works.";
    ta.setAttribute("aria-label", "Day notes");
    ta.value = day.notes || "";
    const fit = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
    ta.addEventListener("input", () => {
      const d = TripManager.currentTrip?.days.find(dd => dd.id === day.id);
      if (d) { d.notes = ta.value; TripManager.save(); }
      fit();
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); ta.blur(); } });
    ta.addEventListener("blur", () => {
      if (editingNotesDayId !== day.id) return;
      editingNotesDayId = null;
      renderDaySections();
    });
    ta.addEventListener("mousedown", e => e.stopPropagation());
    wrap.appendChild(ta);
    requestAnimationFrame(() => { fit(); ta.focus(); });
  } else if (day.notes?.trim()) {
    const p = document.createElement("p");
    p.className = "itin-notes-text";
    p.textContent = day.notes.trim();
    p.title = "Click to edit notes";
    p.addEventListener("click", () => { editingNotesDayId = day.id; renderDaySections(); });
    wrap.appendChild(p);
  }
  return wrap;
}

/**
 * Frame the whole trip on the map, leaving room for the trip panel on the
 * right (it covers the map rather than shrinking it). Instant under reduced
 * motion. Used when a trip is opened or imported.
 */
export function fitTripToView(trip = TripManager.currentTrip) {
  if (!map || !trip?.features?.length) return;
  const pts = [];
  for (const f of trip.features) {
    const g = f.geometry;
    if (g?.type === "Point") pts.push(g.coordinates);
    else if (g?.type === "LineString") pts.push(...g.coordinates);
  }
  if (!pts.length) return;
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

function fitToFeatures(features) {
  const coords = [];
  for (const f of features) {
    const g = f.geometry;
    if (g?.type === "Point") coords.push(g.coordinates);
    else if (g?.type === "LineString") coords.push(...g.coordinates);
  }
  if (!coords.length || !map) return;
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 });
}

// ---------------------------------------------------------------------------
// Sidebar: build feature tile (inside a day section) — inline editing
// ---------------------------------------------------------------------------

/**
 * One feature in a day's story: the day's title (its first route) or a stop
 * row with a hand-drawn glyph. `ctx` = { variant: "title" | "stop",
 * fallbackTitle, atMi (miles into the day), rt (spur round trip) }.
 */
function buildFeatureTile(feature, dayId, ctx = {}) {
  const props = feature.properties;
  const featureId = props._id;

  const tile = document.createElement("div");
  tile.className = "feature-tile stop-row" + (ctx.variant === "title" ? " stop-row--title" : "");
  tile._ctx = ctx;
  tile.draggable = true;
  tile.dataset.id = featureId || "";
  tile.dataset.type = getDisplayType(props) || "waypoint";
  tile.setAttribute("tabindex", "0");

  // Single delegated click handler covers all interactive children
  tile.addEventListener("click", (e) => {
    // Edit button — toggle editing on
    if (e.target.closest(".tile-edit-btn") && !tile.classList.contains("editing")) {
      tile.classList.add("editing");
      tile.draggable = false;
      setTileEditContent(tile, featureId, dayId);
      return;
    }
    // Cancel button or edit button when already editing — revert
    if (e.target.closest(".tile-cancel-btn") || (e.target.closest(".tile-edit-btn") && tile.classList.contains("editing"))) {
      tile.classList.remove("editing");
      tile.draggable = true;
      setTileViewContent(tile, featureId);
      return;
    }
    // Save button
    if (e.target.closest(".tile-save-btn")) {
      const type = tile.dataset.type;
      const updates = collectTileFormValues(tile, type);
      const idx = TripManager.currentTrip?.features.findIndex(f => f.properties._id === featureId);
      if (idx !== -1) TripManager.updateFeature(idx, updates);
      return;
    }
    // Delete button
    if (e.target.closest(".tile-delete-btn")) {
      if (confirm("Delete this feature?")) {
        const idx = TripManager.currentTrip?.features.findIndex(f => f.properties._id === featureId);
        if (idx !== -1) TripManager.removeFeature(idx);
      }
      return;
    }
    // Drag handle — no zoom
    if (e.target.closest(".tile-drag-handle")) return;
    // Body click when not editing → zoom to feature
    if (!tile.classList.contains("editing")) {
      const idx = TripManager.currentTrip?.features.findIndex(f => f.properties._id === featureId);
      if (idx !== -1) zoomToFeature(idx);
    }
  });

  // Prevent text selection/drag in editing inputs from propagating to tile drag
  tile.addEventListener("mousedown", (e) => {
    if (tile.classList.contains("editing")) e.stopPropagation();
  });

  // Drag events
  tile.addEventListener("dragstart", (e) => {
    if (tile.classList.contains("editing")) { e.preventDefault(); return; }
    e.stopPropagation();
    activeDragFeatureId = featureId;
    document.body.classList.add("is-dragging-feature");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-feature", JSON.stringify({
      featureId,
      sourceType: "day",
      sourceDayId: dayId,
    }));
    requestAnimationFrame(() => tile.classList.add("dragging"));
  });

  tile.addEventListener("dragend", () => {
    activeDragFeatureId = null;
    document.body.classList.remove("is-dragging-feature");
    tile.classList.remove("dragging");
    clearDragIndicator();
  });

  tile.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && !tile.classList.contains("editing")) {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      e.preventDefault();
      const idx = TripManager.currentTrip?.features.findIndex(f => f.properties._id === featureId);
      if (idx !== -1 && confirm("Remove this feature?")) TripManager.removeFeature(idx);
    }
  });

  setTileViewContent(tile, featureId);
  return tile;
}

const GRIP_SVG = `<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/></svg>`;

/** Glyph (sketch.js) for a feature: waypoints by subtype, spurs as day hikes. */
function glyphKindFor(props) {
  const k = kindOf(props);
  if (k === "dayhike_spur") return "dayhike";
  return ["camp", "dayhike", "rest", "water", "hazard", "scenic", "resupply", "meal", "route"].includes(k) ? k : "scenic";
}

const NAME_CLASS = { camp: "is-camp", water: "is-water", dayhike: "is-dayhike", rest: "is-rest" };

const seedOf = (id) => [...String(id || "x")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 997;

function setTileViewContent(tile, featureId) {
  const feature = TripManager.currentTrip?.features.find(f => f.properties._id === featureId);
  if (!feature) return;
  const props = feature.properties;
  const type = getDisplayType(props);
  const ctx = tile._ctx || {};
  const label = getFeatureLabel(props, type);
  const tools = `<span class="stop-tools">
      <button type="button" class="tile-edit-btn" aria-label="Edit ${escapeAttr(label)}">Edit</button>
      <span class="tile-drag-handle" title="Drag into another day" aria-hidden="true">${GRIP_SVG}</span>
    </span>`;

  if (ctx.variant === "title") {
    const title = props.name || ctx.fallbackTitle || "Untitled route";
    const offMi = offTrailMeters(props) / 1609.344;
    tile.innerHTML = `
      <div class="stop-title-row">
        <h4 class="itin-title${props.name ? "" : " is-placeholder"}">${escapeHTML(title)}</h4>
        ${tools}
      </div>
      ${offMi >= 0.05 ? `<p class="stop-sub">Includes ${offMi.toFixed(1)} mi drawn straight, off the trail network</p>` : ""}
      ${props.notes ? `<p class="stop-note">${escapeHTML(props.notes)}</p>` : ""}`;
    return;
  }

  const gk = glyphKindFor(props);
  let at = "";
  if (ctx.rt != null) at = `${ctx.rt.toFixed(1)} mi rt`;
  else if (type === "route" && props.main_route_distance_mi > 0) at = `${props.main_route_distance_mi.toFixed(1)} mi`;
  else if (ctx.atMi != null) at = `${ctx.atMi.toFixed(1)} mi`;
  let note = props.notes || "";
  if (type === "camp" && props.water_nearby) note += `${note ? " " : ""}Water nearby${props.water_notes ? `: ${props.water_notes}` : "."}`;
  const nameCls = NAME_CLASS[gk === "water" ? "water" : type] || "";
  tile.innerHTML = `
    ${glyphIcon(gk, { seed: seedOf(featureId), size: 24 })}
    <span class="stop-name ${nameCls}">${escapeHTML(label)}</span>
    ${at ? `<span class="stop-at">${at}</span>` : ""}
    ${tools}
    ${note ? `<span class="stop-note">${escapeHTML(note)}</span>` : ""}`;
}

function setTileEditContent(tile, featureId, dayId) {
  const feature = TripManager.currentTrip?.features.find(f => f.properties._id === featureId);
  if (!feature) return;
  const props = feature.properties;
  const type = getDisplayType(props);

  let fieldsHTML = "";
  if (type === "camp") {
    fieldsHTML += `<div class="tile-field"><label class="tile-field-label">Date</label><select class="tile-date-sel">${buildDateOptions(props.date)}</select></div>`;
    fieldsHTML += `<label class="tile-checkbox-row"><input type="checkbox" class="tile-water-check" ${props.water_nearby ? "checked" : ""}> Water nearby</label>`;
  } else if (type === "dayhike" || type === "rest") {
    fieldsHTML += `<div class="tile-field"><label class="tile-field-label">Date</label><select class="tile-date-sel">${buildDateOptions(props.date)}</select></div>`;
  } else if (type === "route") {
    fieldsHTML += `<label class="tile-checkbox-row"><input type="checkbox" class="tile-planned-check" ${props.planned ? "checked" : ""}> Planned route</label>`;
  }

  tile.innerHTML = `
    <div class="tile-header-row">
      <span class="tile-type-icon">${glyphIcon(glyphKindFor(props), { seed: seedOf(featureId), size: 22 })}</span>
      <input class="tile-title-input" type="text" value="${escapeAttr(props.name || "")}" placeholder="${escapeAttr(getFeatureLabel(props, type))}" aria-label="Name" />
    </div>
    ${fieldsHTML}
    <textarea class="tile-notes-field" placeholder="Notes…">${escapeHTML(props.notes || "")}</textarea>
    <div class="tile-edit-actions">
      <button class="tile-cancel-btn">Cancel</button>
      <button class="tile-save-btn">Save</button>
      <button class="tile-delete-btn">Delete</button>
    </div>
  `;

  // Focus title input
  tile.querySelector(".tile-title-input")?.focus();
}

function collectTileFormValues(tile, type) {
  const updates = { name: tile.querySelector(".tile-title-input")?.value || "" };
  if (type === "camp") {
    updates.date = tile.querySelector(".tile-date-sel")?.value;
    updates.water_nearby = tile.querySelector(".tile-water-check")?.checked || false;
  } else if (type === "dayhike" || type === "rest") {
    updates.date = tile.querySelector(".tile-date-sel")?.value;
  } else if (type === "route") {
    updates.planned = tile.querySelector(".tile-planned-check")?.checked || false;
  }
  updates.notes = tile.querySelector(".tile-notes-field")?.value || "";
  return updates;
}

// ---------------------------------------------------------------------------
// Type icons
// ---------------------------------------------------------------------------

function buildTypeIconHTML(type) {
  const stroke = "currentColor";
  switch (type) {
    case "route":
    case "dayhike":
    case "dayhike_spur":
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,12 5,4 7,8 9,2 12,12"/></svg>`;
    case "camp":
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${stroke}" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,12 7,4 11,12" stroke-width="1.2"/><polyline points="5,12 7,8 9,12" stroke-width="0.8"/></svg>`;
    case "rest":
    case "meal":
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${stroke}" stroke-width="1" stroke-linecap="round"><circle cx="7" cy="7" r="2"/><line x1="7" y1="1" x2="7" y2="3"/><line x1="7" y1="11" x2="7" y2="13"/><line x1="1" y1="7" x2="3" y2="7"/><line x1="11" y1="7" x2="13" y2="7"/></svg>`;
    case "waypoint":
    default:
      return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="${stroke}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7,1 1,13 13,13"/></svg>`;
  }
}

// ---------------------------------------------------------------------------
// Feature label + stats helpers
// ---------------------------------------------------------------------------

export const POINT_TYPE_LABELS = {
  route: "Route",
  camp: "Camp",
  dayhike: "Day Hike",
  dayhike_spur: "Day Hike Spur",
  rest: "Rest Day",
  meal: "Meal",
  waypoint: "Waypoint",
};

/**
 * Effective display type for a feature. point_type normally wins (it
 * duplicates type for web rendering), but is IGNORED on waypoints: the old
 * v1->v2 migration stamped point_type "dayhike" onto real waypoints, and the
 * canonical format (outhere/trips/FORMAT.md, drift item 13) says readers must
 * ignore it there.
 */
export function getDisplayType(props) {
  if (props.type === "waypoint") return "waypoint";
  return props.point_type || props.type;
}

const WAYPOINT_LABELS = {
  water: "Water",
  hazard: "Hazard",
  scenic: "Scenic",
  resupply: "Resupply",
};

function getFeatureLabel(props, type) {
  if (props.name) return props.name;
  switch (type) {
    case "route": return "Untitled route";
    case "camp": return props.night_number ? `Camp, night ${props.night_number}` : "Camp";
    case "dayhike": return "Day hike";
    case "rest": return "Rest day";
    case "meal": return "Meal";
    case "waypoint": return WAYPOINT_LABELS[props.subtype] || "Waypoint";
    case "dayhike_spur": return "Day hike spur";
    default: return POINT_TYPE_LABELS[type] || type;
  }
}

/** Meters of fallback straight legs where trails don't connect (no_path); legs with no graph aren't flagged. */
function offTrailMeters(props) {
  return (props.segments || []).reduce((m, s) => m + (s.mode === "straight" && (s.reason || "no_path") === "no_path" ? (s.length_m || 0) : 0), 0);
}

function getFeatureStats(props, type) {
  if (type === "route") {
    const mainDist = props.main_route_distance_mi;
    const dhDist = props.dayhike_distance_mi;
    if (mainDist && mainDist > 0) {
      let s = `${mainDist.toFixed(1)} mi`;
      if (dhDist && dhDist > 0) s += ` + ${dhDist.toFixed(1)} mi day hikes`;
      const offMi = offTrailMeters(props) / 1609.344;
      if (offMi >= 0.05) s += ` · includes ${offMi.toFixed(1)} mi off-trail`;
      return s;
    }
    const numPts = props.vertex_coords?.length || 0;
    return numPts > 0 ? `${numPts} points` : "";
  }
  const parts = [];
  if (type === "camp" && props.water_nearby) parts.push("Water nearby");
  if (type === "dayhike_spur") parts.push("Day hike spur");
  if (type === "waypoint" && props.subtype) parts.push(WAYPOINT_LABELS[props.subtype] || props.subtype);
  if (props.estimatedDuration) parts.push(`~${formatDuration(props.estimatedDuration)}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Day stats aggregation
// ---------------------------------------------------------------------------

function computeDayStats(features) {
  let totalMiles = 0;
  let totalElevGain = 0;
  let totalElevLoss = 0;
  let totalMinutes = 0;
  let hasWater = false;

  for (const f of features) {
    const p = f.properties;
    const type = getDisplayType(p);
    if (type === "route") {
      totalMiles += (p.main_route_distance_mi || 0) + (p.dayhike_distance_mi || 0);
      totalElevGain += p.elevation_gain_ft || 0;
      totalElevLoss += p.elevation_loss_ft || 0;
    }
    if (p.estimatedDuration) totalMinutes += p.estimatedDuration;
    if ((type === "camp") && p.water_nearby) hasWater = true;
  }

  return { totalMiles, totalElevGain, totalElevLoss, totalMinutes, hasWater };
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Feature edit form (shown in-panel)
// ---------------------------------------------------------------------------

function buildDateOptions(selectedDate) {
  const tripDates = getTripDateRange();
  let html = '<option value="">No date</option>';
  for (const d of tripDates) {
    html += `<option value="${d}" ${selectedDate === d ? "selected" : ""}>${d}</option>`;
  }
  return html;
}

// openFeatureForm / closeFeatureForm replaced by inline tile editing (setTileEditContent / setTileViewContent)

function zoomToFeature(index) {
  const feature = TripManager.currentTrip?.features[index];
  if (!feature) return;

  const geom = feature.geometry;
  if (geom.type === "Point") {
    map.flyTo({ center: geom.coordinates, zoom: 13, duration: 800 });
  } else if (geom.type === "LineString" && geom.coordinates.length > 0) {
    const bounds = geom.coordinates.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(geom.coordinates[0], geom.coordinates[0])
    );
    map.fitBounds(bounds, { padding: 60, duration: 800 });
  }
}

// ---------------------------------------------------------------------------
// Drawing progress live preview (shown in sidebar during route drawing)
// ---------------------------------------------------------------------------

export function updateDrawingPreview(info) {
  const poolEl = document.getElementById("unassignedChips");
  if (!poolEl) return;

  // Remove any existing preview chip
  const existing = document.getElementById("drawingPreviewChip");
  if (existing) existing.remove();

  if (!info || info.vertexCount === 0) return;

  const chip = document.createElement("div");
  chip.id = "drawingPreviewChip";
  chip.className = "drawing-preview-chip";

  const mainDist = info.mainDistanceMi.toFixed(1);
  const dhDist = info.dayhikeDistanceMi.toFixed(1);
  let label = `${info.vertexCount} pt${info.vertexCount !== 1 ? "s" : ""}`;
  if (parseFloat(mainDist) > 0) label = `${mainDist} mi`;
  if (parseFloat(dhDist) > 0) label += ` +${dhDist}`;
  if ((info.offTrailMi || 0) >= 0.05) label += `, includes ${info.offTrailMi.toFixed(1)} mi off-trail`;

  chip.innerHTML = `
    <span class="tile-icon-dot tile-icon-dot--route"></span>
    <span>Drawing\u2026 ${label}</span>
    <span class="drawing-preview-pulse"></span>
  `;

  poolEl.insertBefore(chip, poolEl.firstChild);
}

// ---------------------------------------------------------------------------
// File upload handler
// ---------------------------------------------------------------------------

function handleFileUpload(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const geojson = JSON.parse(e.target.result);
      TripManager.loadFromGeoJSON(geojson);
    } catch (err) {
      alert("Could not load file: " + err.message);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------------------
// Sidebar open/close helpers
// ---------------------------------------------------------------------------

/** Map padding used to keep the visible map centered next to the open panel. */
function panelMapPadding() {
  // On mobile the panel overlays the full map — don't pad.
  return window.innerWidth <= 640 ? 0 : 520;
}

/** Re-align the floating planning toolbar with the Plan map control. */
export function alignPlanningToolbar() {
  const planBtnEl = document.getElementById("planBtn");
  const planningToolbarEl = document.getElementById("planningToolbar");
  if (planBtnEl && planningToolbarEl) {
    planningToolbarEl.style.top = planBtnEl.getBoundingClientRect().top + "px";
  }
}

export function openSidebar() {
  const tripPanel = document.getElementById("tripPanel");
  const toolbar = document.getElementById("planningToolbar");
  // Align toolbar top with planBtn before making it visible
  alignPlanningToolbar();
  tripPanel.classList.add("open");
  document.getElementById("planBtn").classList.add("active");
  toolbar.classList.add("visible");
  document.body.classList.add("panel-open");
  map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: panelMapPadding() }, duration: 250 });
  if (!TripManager.currentTrip) {
    showOnboardingModal();
  }
}

function closeSidebar() {
  const tripPanel = document.getElementById("tripPanel");
  const toolbar = document.getElementById("planningToolbar");
  tripPanel.classList.remove("open");
  document.getElementById("planBtn").classList.remove("active");
  toolbar.classList.remove("visible");
  document.body.classList.remove("panel-open");
  map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 250 });
  cancelDrawing();
}

// ---------------------------------------------------------------------------
// Panel wiring
// ---------------------------------------------------------------------------

export function initTripPanel() {
  const planBtn = document.getElementById("planBtn");
  const tripPanel = document.getElementById("tripPanel");

  // Header Plan button — toggle sidebar
  planBtn.addEventListener("click", () => {
    if (tripPanel.classList.contains("open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  // Collapse toggle on the panel edge
  document.getElementById("sidebarCollapseBtn").addEventListener("click", () => {
    closeSidebar();
  });

  // Add Day button
  document.getElementById("addDayBtn").addEventListener("click", () => {
    TripManager.addDay();
  });

  // Drawing tool buttons
  document.getElementById("addRouteBtn").addEventListener("click", startRouteDrawing);
  const deleteWaypointBtn = document.getElementById("deleteWaypointBtn");
  if (deleteWaypointBtn) {
    deleteWaypointBtn.addEventListener("click", () => {
      if (isDeleteMode) exitDeleteMode();
      else startDeleteMode();
    });
  }

  // Point-type selector buttons
  initPointTypeSelector();

  // Cancel drawing on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelDrawing();
  });

  // Trip title input
  const tripTitleInput = document.getElementById("tripTitle");
  if (tripTitleInput) {
    tripTitleInput.addEventListener("input", () => {
      if (!TripManager.currentTrip) return;
      TripManager.currentTrip.properties.name = tripTitleInput.textContent.replace(/\s+/g, " ").trim();
      TripManager.save();
    });
    tripTitleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); tripTitleInput.blur(); }
    });
    tripTitleInput.addEventListener("blur", () => {
      if (tripTitleInput.textContent.trim() === "") renderTripTitle();
    });
  }

  // Overview section: collapse/expand toggle
  document.getElementById("overviewHeader")?.addEventListener("click", (e) => {
    // Header action links (e.g. Import .md) shouldn't toggle the section
    if (e.target.closest(".overview-header-actions")) return;
    const section = document.getElementById("overviewSection");
    section?.classList.toggle("expanded");
  });

  // Overview notes editor — save on input
  const readmeEditor = document.getElementById("readmeEditor");
  if (readmeEditor) {
    readmeEditor.addEventListener("input", () => {
      if (!TripManager.currentTrip) return;
      TripManager.currentTrip.properties.readme = readmeEditor.value;
      // Keep the canonical `notes` mirror in sync (mobile reads `notes`;
      // also prevents a stale notes value from resurrecting cleared readme
      // text via the notes->readme normalization on the next load).
      TripManager.currentTrip.properties.notes = readmeEditor.value;
      TripManager.save();
    });
    readmeEditor.addEventListener("mousedown", e => e.stopPropagation());
  }

  // Import .md file into overview
  const mdInput = document.getElementById("readmeMdInput");
  if (mdInput) {
    mdInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (!TripManager.currentTrip) return;
        TripManager.currentTrip.properties.readme = ev.target.result;
        TripManager.currentTrip.properties.notes = ev.target.result;
        TripManager.save();
        if (readmeEditor) readmeEditor.value = ev.target.result;
      };
      reader.readAsText(file);
      e.target.value = "";
    });
  }

  // Download GeoJSON
  document.getElementById("downloadTripBtn").addEventListener("click", () => {
    TripManager.download();
  });

  // Export Markdown
  document.getElementById("exportMarkdownBtn")?.addEventListener("click", () => {
    TripManager.exportMarkdown();
  });

  // Load trip from file
  document.getElementById("loadTripInput").addEventListener("change", (e) => {
    if (e.target.files[0]) {
      handleFileUpload(e.target.files[0]);
      e.target.value = "";
    }
  });

  // New trip button → show onboarding modal
  document.getElementById("newTripBtn").addEventListener("click", () => {
    if (TripManager.currentTrip && TripManager.currentTrip.features.length > 0) {
      if (!confirm("Start a new trip? Your current trip stays saved in My Trips.")) return;
    }
    showOnboardingModal();
  });

  // Sketchbook profile (sticky) + active day. Wired before the first render.
  document.body.insertAdjacentHTML("beforeend", glyphDefsSVG());
  initItineraryPanel({
    figure: document.getElementById("itineraryProfile"),
    scroll: document.getElementById("notebookPanel"),
    tail: document.getElementById("itineraryTail"),
    onDrawRoute: () => startRouteDrawing(),
  });
  // Drawing a route: collapse the profile to a strip so the map leads.
  const toolbarEl = document.getElementById("planningToolbar");
  if (toolbarEl) {
    new MutationObserver(() => {
      setItineraryCompact(isDrawingRoute);
      document.body.classList.toggle("is-drawing-route", isDrawingRoute);
      if (!isDrawingRoute) drawIntoDayId = null;
    }).observe(toolbarEl, { attributes: true, attributeFilter: ["class"] });
  }

  // Migrate the legacy single-trip localStorage entry into the multi-trip
  // store (lossless, one-time), then load the active trip if there is one.
  TripsStore.migrateLegacy();
  TripManager.loadFromStorage();

  // ---------------------------------------------------------------------------
  // Drag-and-drop event delegation (notebook panel)
  // ---------------------------------------------------------------------------

  const notebookPanel = document.getElementById("notebookPanel");

  // A whole day (head, rule, notes, stops) is one drop target.
  const dayListAt = (el) => el.closest(".itin-day")?.querySelector(".day-feature-list") || null;

  notebookPanel.addEventListener("dragover", (e) => {
    e.preventDefault();
    const featureList = dayListAt(e.target);
    const pool = e.target.closest(".unassigned-pool");
    if (featureList) {
      e.dataTransfer.dropEffect = "move";
      const insertBeforeId = getDragInsertBeforeId(e, featureList);
      showDragIndicator(featureList, insertBeforeId);
      featureList._dropInsertBefore = insertBeforeId;
      document.querySelectorAll(".itin-day.drag-over").forEach(el => { if (!el.contains(featureList)) el.classList.remove("drag-over"); });
      featureList.closest(".itin-day").classList.add("drag-over");
    } else if (pool) {
      e.dataTransfer.dropEffect = "move";
      pool.classList.add("drag-over");
    }
  });

  notebookPanel.addEventListener("dragleave", (e) => {
    const dayEl = e.target.closest(".itin-day");
    const pool = e.target.closest(".unassigned-pool");
    if (dayEl && !dayEl.contains(e.relatedTarget)) {
      dayEl.classList.remove("drag-over");
      clearDragIndicator();
    }
    if (pool && !pool.contains(e.relatedTarget)) {
      pool.classList.remove("drag-over");
    }
  });

  notebookPanel.addEventListener("drop", (e) => {
    e.preventDefault();
    const data = parseDragData(e);
    if (!data) return;
    clearDragIndicator();
    document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));

    document.body.classList.remove("is-dragging-feature");
    const featureList = dayListAt(e.target);
    const pool = e.target.closest(".unassigned-pool");
    if (featureList) {
      const dayId = featureList.closest(".itin-day")?.dataset.dayId;
      if (dayId) {
        confirmFeatureId = data.featureId; // the confirm shiver on the row once it lands
        TripManager.moveFeature(data.featureId, "day", dayId, featureList._dropInsertBefore || null);
      }
    } else if (pool) {
      TripManager.moveFeature(data.featureId, "unassigned", null, null);
    }
  });

  // ---------------------------------------------------------------------------
  // Onboarding modal wiring
  // ---------------------------------------------------------------------------

  document.getElementById("onboardingSubmit")?.addEventListener("click", submitOnboardingModal);

  // Dismiss the modal. With no trip yet, also close the panel so the user
  // isn't trapped (they can reopen Plan to try again).
  const dismissOnboarding = () => {
    hideOnboardingModal();
    if (!TripManager.currentTrip) closeSidebar();
  };

  document.getElementById("onboardingOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("onboardingOverlay")) dismissOnboarding();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("onboardingOverlay")?.hidden) {
      dismissOnboarding();
    }
  });

  // Enter inside any onboarding text field submits
  document.getElementById("onboardingModal")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      submitOnboardingModal();
    }
  });
}

// ---------------------------------------------------------------------------
// Onboarding modal
// ---------------------------------------------------------------------------

export function showOnboardingModal() {
  const overlay = document.getElementById("onboardingOverlay");
  if (!overlay) return;
  // Pre-fill today's date
  const dateInput = document.getElementById("onboardingStartDate");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }
  overlay.hidden = false;
  document.getElementById("onboardingName")?.focus();
}

function hideOnboardingModal() {
  const overlay = document.getElementById("onboardingOverlay");
  if (overlay) overlay.hidden = true;
}

function submitOnboardingModal() {
  const name     = document.getElementById("onboardingName")?.value.trim() || "Untitled Trip";
  const location = document.getElementById("onboardingLocation")?.value.trim() || "";
  const startDate = document.getElementById("onboardingStartDate")?.value || null;
  const nightsRaw = parseInt(document.getElementById("onboardingNights")?.value, 10);
  const nights   = Number.isFinite(nightsRaw) ? Math.min(30, Math.max(0, nightsRaw)) : 0;

  TripManager.create(name, { location, startDate, nights });
  hideOnboardingModal();

  // Open the panel if not already open
  if (!document.getElementById("tripPanel")?.classList.contains("open")) {
    openSidebar();
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Auto-save every 30 seconds
// ---------------------------------------------------------------------------

setInterval(() => {
  if (TripManager.currentTrip) TripManager.save();
}, 30000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function escapeHTML(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

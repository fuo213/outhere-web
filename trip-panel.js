/**
 * OutHere Trip Planning — Trip State & Sidebar UI
 *
 * Manages the trip data model, renders it on MapLibre,
 * builds the notebook sidebar (overview + day accordion), and handles
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
} from "./planning.js";

// ---------------------------------------------------------------------------
// Trip state manager
// ---------------------------------------------------------------------------

const STORAGE_KEY = "outhere_trip";

// Canonical trip format version (see outhere/trips/trip.schema.json + FORMAT.md).
// Distinct from the legacy _schema_version integer migration counter.
const TRIP_SCHEMA_VERSION = "1.0";

let activeDayId = null;       // day ID currently highlighted on map, or null
const expandedDayIds = new Set(); // which day sections are expanded (UI state only)

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
    this.render();
    this.save();
  },

  /** Add a feature, assign it a stable ID, and place it in the unassigned pool. */
  addFeature(geometry, properties) {
    const id = crypto.randomUUID();
    properties._id = id;
    this.currentTrip.features.push({ type: "Feature", geometry, properties });
    this.currentTrip.unassigned.push(id);
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
      map.getSource("trip").setData(this.currentTrip || { type: "FeatureCollection", features: [] });
    }
    renderSidebar();
    renderTripTitle();
    renderMetaChips();
  },

  save() {
    if (!this.currentTrip) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.currentTrip));
    } catch (err) {
      // Quota exceeded or storage unavailable — keep the app running
      console.warn("[trip] could not save trip to localStorage:", err.message);
    }
  },

  loadFromStorage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return false;
    try {
      const parsed = JSON.parse(saved);
      if (!parsed || parsed.type !== "FeatureCollection" ||
          !Array.isArray(parsed.features) || !parsed.properties) {
        throw new Error("saved trip has invalid shape");
      }
      this.currentTrip = migrateTrip(parsed);
      this.render();
      return true;
    } catch (err) {
      // Corrupt saved trip: drop it so we don't fail on every load
      console.warn("[trip] discarding corrupt saved trip:", err.message);
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
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

  /**
   * Build the canonical export document (schema_version 1.0) without
   * mutating the live trip: stamps schema_version, mirrors the readme into
   * `notes` (mobile reads `notes`), and guarantees a `dates` key.
   */
  buildExport() {
    if (!this.currentTrip) return null;
    const out = JSON.parse(JSON.stringify(this.currentTrip));
    out.properties.schema_version = TRIP_SCHEMA_VERSION;
    // The UI edits `readme`; write `notes` from the same value for mobile.
    out.properties.notes = out.properties.readme || "";
    if (out.properties.dates === undefined) out.properties.dates = null;
    if (!Array.isArray(out.days)) out.days = [];
    if (!Array.isArray(out.unassigned)) out.unassigned = [];
    return out;
  },

  download() {
    const exportTrip = this.buildExport();
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
        const type = props.point_type || props.type;
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

  clear() {
    localStorage.removeItem(STORAGE_KEY);
    this.currentTrip = null;
    this.render();
  },
};

// ---------------------------------------------------------------------------
// Data migration
// ---------------------------------------------------------------------------

function migrateTrip(trip) {
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
    if (meta.schema_version !== TRIP_SCHEMA_VERSION) push(`properties.schema_version is ${JSON.stringify(meta.schema_version)}, expected "${TRIP_SCHEMA_VERSION}"`);
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
    titleEl.value = name;
  }
}

function renderMetaChips() {
  const el = document.getElementById("tripMetaChips");
  if (!el) return;
  const trip = TripManager.currentTrip;
  if (!trip || !trip.features.length) { el.innerHTML = ""; return; }

  let totalMi = 0;
  for (const f of trip.features) {
    if (f.properties.type === "route") {
      totalMi += (f.properties.main_route_distance_mi || 0) + (f.properties.dayhike_distance_mi || 0);
    }
  }
  const dayCount = trip.days?.length || 0;

  const chips = [];
  if (totalMi > 0) chips.push(
    `<div class="meta-chip"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><polyline points="1,10 4,3 6,7 8,1 11,10"/></svg>${totalMi.toFixed(1)} mi</div>`
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
  if (!chipsEl) return;
  chipsEl.innerHTML = "";

  const trip = TripManager.currentTrip;
  if (!trip) return;

  const unassignedFeatures = (trip.unassigned || [])
    .map(id => trip.features.find(f => f.properties._id === id))
    .filter(Boolean);

  if (unassignedFeatures.length === 0) {
    const msg = trip.features.length > 0 ? "All features assigned" : "No unassigned features";
    chipsEl.innerHTML = `<span class="pool-empty">${msg}</span>`;
    return;
  }

  for (const f of unassignedFeatures) {
    chipsEl.appendChild(buildFeatureChip(f));
  }
}

function renderDaySections() {
  const container = document.getElementById("daySections");
  if (!container) return;
  container.innerHTML = "";

  const trip = TripManager.currentTrip;
  if (!trip || !trip.days) return;

  // Drop the map highlight if the highlighted day no longer exists
  if (activeDayId && !trip.days.some(d => d.id === activeDayId)) {
    setActiveDayHighlight(null);
  }

  trip.days.forEach((day, idx) => {
    container.appendChild(buildDaySection(day, idx));
  });
}

// ---------------------------------------------------------------------------
// Sparkline — SVG elevation profile renderer
// ---------------------------------------------------------------------------

/**
 * Build an SVG elevation sparkline from a profile array (values in feet).
 * Returns an HTML string for an <svg> element.
 *
 * @param {number[]} profile  - elevation values in feet
 * @param {number}   width    - SVG pixel width
 * @param {number}   height   - SVG pixel height
 * @param {string}   cssClass - class name applied to the <svg>
 */
function buildSparklineSVG(profile, width, height, cssClass) {
  if (!profile || profile.length < 2) return "";

  const min = Math.min(...profile);
  const max = Math.max(...profile);
  const range = max - min || 1;
  const padV = 3; // vertical padding in px

  const pts = profile.map((e, i) => {
    const x = (i / (profile.length - 1)) * width;
    const y = padV + (height - padV * 2) * (1 - (e - min) / range);
    return [x.toFixed(2), y.toFixed(2)];
  });

  const linePoints = pts.map(p => p.join(",")).join(" ");

  // Area fill path: line + drop to bottom corners
  const areaPath = [
    `M ${pts[0][0]},${pts[0][1]}`,
    ...pts.slice(1).map(p => `L ${p[0]},${p[1]}`),
    `L ${width},${height} L 0,${height} Z`,
  ].join(" ");

  const gradId = `spk-${Math.random().toString(36).slice(2, 7)}`;

  return `<svg class="${escapeAttr(cssClass)}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="currentColor" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <path d="${escapeAttr(areaPath)}" fill="url(#${gradId})"/>
    <polyline points="${escapeAttr(linePoints)}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/**
 * Get the combined elevation profile for a day's route features.
 * If a day has multiple routes, concatenates their profiles.
 */
function getDayElevationProfile(dayFeatures) {
  const profile = [];
  for (const f of dayFeatures) {
    const p = f.properties;
    if ((p.point_type || p.type) === "route" && Array.isArray(p.elevation_profile)) {
      if (profile.length > 0) profile.push(...p.elevation_profile.slice(1));
      else profile.push(...p.elevation_profile);
    }
  }
  return profile;
}

// ---------------------------------------------------------------------------
// Map: day highlight
// ---------------------------------------------------------------------------

function setActiveDayHighlight(dayId) {
  activeDayId = dayId;

  // Update sidebar visual state
  document.querySelectorAll(".day-section").forEach(section => {
    const isActive = section.dataset.dayId === dayId;
    section.classList.toggle("day-active", isActive);
    section.querySelector(".day-focus-btn")?.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  if (!map || !map.isStyleLoaded()) return;

  const tripLayerIds = [
    "trip-routes", "trip-dayhike-spurs",
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
  const type = props.point_type || props.type;
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
    chip.classList.remove("dragging");
    clearDragIndicator();
  });

  return chip;
}

// ---------------------------------------------------------------------------
// Sidebar: build day section
// ---------------------------------------------------------------------------

function buildDaySection(day, dayIndex) {
  const trip = TripManager.currentTrip;
  const dayFeatures = (day.features || [])
    .map(id => trip.features.find(f => f.properties._id === id))
    .filter(Boolean);
  const stats = computeDayStats(dayFeatures);
  const profile = getDayElevationProfile(dayFeatures);
  const isExpanded = expandedDayIds.has(day.id);

  const section = document.createElement("div");
  section.className = "day-section" + (isExpanded ? " expanded" : "") + (activeDayId === day.id ? " day-active" : "");
  section.dataset.dayId = day.id;

  // ── Collapsed header row ──────────────────────────────────────────────────
  const dateLabel = day.date ? formatDateLabel(day.date) : "";

  const statParts = [];
  if (stats.totalMiles > 0) statParts.push(`${stats.totalMiles.toFixed(1)} mi`);
  if (stats.totalElevGain > 0) statParts.push(`+${stats.totalElevGain.toLocaleString()} ft`);

  const header = document.createElement("div");
  header.className = "day-collapsed-header";
  header.setAttribute("tabindex", "0");
  header.setAttribute("role", "button");
  header.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  header.setAttribute("aria-label", `Day ${dayIndex + 1}${dateLabel ? `, ${dateLabel}` : ""}`);

  header.innerHTML = `
    <svg class="day-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="2,3 5,7 8,3"/>
    </svg>
    <div class="day-header-info">
      <span class="day-label">Day ${dayIndex + 1}</span>
      ${dateLabel ? `<span class="day-date">${escapeHTML(dateLabel)}</span>` : ""}
    </div>
    <div class="day-sparkline-mini-wrap">
      ${profile.length >= 2 ? buildSparklineSVG(profile, 72, 20, "day-sparkline-mini") : ""}
    </div>
    <div class="day-stats-col">
      ${statParts.map(s => `<span class="day-stat-item">${escapeHTML(s)}</span>`).join("")}
    </div>
    <button class="day-focus-btn" title="Highlight this day on the map" aria-label="Highlight day ${dayIndex + 1} on the map" aria-pressed="${activeDayId === day.id ? "true" : "false"}">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 1 C3.8 1 2 2.8 2 5 C2 8 6 11 6 11 C6 11 10 8 10 5 C10 2.8 8.2 1 6 1 Z"/>
        <circle cx="6" cy="5" r="1.4"/>
      </svg>
    </button>
  `;

  // Map-highlight toggle (doesn't expand/collapse the section)
  header.querySelector(".day-focus-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setActiveDayHighlight(activeDayId === day.id ? null : day.id);
  });

  // Toggle expand/collapse on header click
  header.addEventListener("click", () => {
    if (expandedDayIds.has(day.id)) {
      expandedDayIds.delete(day.id);
      section.classList.remove("expanded");
      header.setAttribute("aria-expanded", "false");
    } else {
      expandedDayIds.add(day.id);
      section.classList.add("expanded");
      header.setAttribute("aria-expanded", "true");
    }
  });
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); header.click(); }
  });

  section.appendChild(header);

  // ── Expanded body ─────────────────────────────────────────────────────────
  const body = document.createElement("div");
  body.className = "day-body";

  // Full-width sparkline
  if (profile.length >= 2) {
    const sparklineWrap = document.createElement("div");
    sparklineWrap.className = "day-sparkline-full-wrap";
    const gainLabel = stats.totalElevGain > 0 ? `+${stats.totalElevGain.toLocaleString()} ft` : "";
    const lossLabel = stats.totalElevLoss > 0 ? `−${stats.totalElevLoss.toLocaleString()} ft` : "";
    sparklineWrap.innerHTML = `
      <div class="day-sparkline-labels">
        ${gainLabel ? `<span class="sparkline-gain">${escapeHTML(gainLabel)}</span>` : ""}
        ${lossLabel ? `<span class="sparkline-loss">${escapeHTML(lossLabel)}</span>` : ""}
      </div>
      ${buildSparklineSVG(profile, 460, 52, "day-sparkline-full")}
    `;
    body.appendChild(sparklineWrap);
  }

  // Auto-summary (elevated feature list)
  const summary = buildDayAutoSummary(dayFeatures, day.id);
  body.appendChild(summary);

  // Per-day notes editor
  const notesWrap = document.createElement("div");
  notesWrap.className = "day-notes-wrap";
  const notesEl = document.createElement("textarea");
  notesEl.className = "notes-editor";
  notesEl.placeholder = "Day notes — water sources, hazards, beta, key distances…\n\nMarkdown supported.";
  notesEl.value = day.notes || "";
  notesEl.addEventListener("input", () => {
    const d = TripManager.currentTrip?.days.find(dd => dd.id === day.id);
    if (d) { d.notes = notesEl.value; TripManager.save(); }
  });
  // Prevent drag from textarea propagating to outer drag handlers
  notesEl.addEventListener("mousedown", e => e.stopPropagation());
  notesWrap.appendChild(notesEl);
  body.appendChild(notesWrap);

  section.appendChild(body);
  return section;
}

// ---------------------------------------------------------------------------
// Day auto-summary — elevated read-only feature list inside expanded day
// ---------------------------------------------------------------------------

function buildDayAutoSummary(dayFeatures, dayId) {
  const wrap = document.createElement("div");
  wrap.className = "day-auto-summary";

  // Feature list area (also serves as the drag-and-drop target)
  const featureList = document.createElement("div");
  featureList.className = "day-feature-list";

  if (dayFeatures.length === 0) {
    featureList.innerHTML = `
      <div class="day-drop-zone">
        <svg class="day-drop-zone-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#A89880" stroke-width="1.2" stroke-linecap="round">
          <polyline points="2,17 6,5 10,12 13,3 18,17"/>
        </svg>
        <span class="day-drop-zone-label">Drag waypoints here</span>
      </div>`;
  } else {
    for (const f of dayFeatures) {
      featureList.appendChild(buildFeatureTile(f, dayId));
    }
  }

  wrap.appendChild(featureList);
  return wrap;
}

// ---------------------------------------------------------------------------
// Sidebar: build feature tile (inside a day section) — inline editing
// ---------------------------------------------------------------------------

function buildFeatureTile(feature, dayId) {
  const props = feature.properties;
  const featureId = props._id;

  const tile = document.createElement("div");
  tile.className = "feature-tile";
  tile.dataset.id = featureId || "";
  tile.dataset.type = props.point_type || props.type || "waypoint";
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

function setTileViewContent(tile, featureId) {
  const feature = TripManager.currentTrip?.features.find(f => f.properties._id === featureId);
  if (!feature) return;
  const props = feature.properties;
  const type = props.point_type || props.type;
  const stats = getFeatureStats(props, type);
  const notes = props.notes || "";

  tile.innerHTML = `
    <div class="tile-header-row">
      <span class="tile-type-icon">${buildTypeIconHTML(type)}</span>
      <span class="tile-title">${escapeHTML(getFeatureLabel(props, type))}</span>
      ${stats ? `<span class="tile-stat">${escapeHTML(stats)}</span>` : ""}
      <button class="tile-edit-btn" title="Edit">&#9998;</button>
      <div class="tile-drag-handle" aria-hidden="true"><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/></svg></div>
    </div>
    ${notes ? `<p class="tile-description">${escapeHTML(notes)}</p>` : ""}
  `;
}

function setTileEditContent(tile, featureId, dayId) {
  const feature = TripManager.currentTrip?.features.find(f => f.properties._id === featureId);
  if (!feature) return;
  const props = feature.properties;
  const type = props.point_type || props.type;

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
      <span class="tile-type-icon">${buildTypeIconHTML(type)}</span>
      <input class="tile-title-input" type="text" value="${escapeAttr(getFeatureLabel(props, type))}" />
      <button class="tile-edit-btn active" title="Cancel editing">&#9998;</button>
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

const WAYPOINT_LABELS = {
  water: "Water",
  hazard: "Hazard",
  scenic: "Scenic",
  resupply: "Resupply",
};

function getFeatureLabel(props, type) {
  if (props.name) return props.name;
  switch (type) {
    case "route": return "Untitled Route";
    case "camp": return props.night_number ? `Camp Night ${props.night_number}` : "Camp";
    case "dayhike": return "Day Hike";
    case "rest": return "Rest Day";
    case "meal": return "Meal";
    case "waypoint": return `${WAYPOINT_LABELS[props.subtype] || "Waypoint"} Point`;
    default: return POINT_TYPE_LABELS[type] || type;
  }
}

function getFeatureStats(props, type) {
  if (type === "route") {
    const mainDist = props.main_route_distance_mi;
    const dhDist = props.dayhike_distance_mi;
    if (mainDist && mainDist > 0) {
      let s = `${mainDist.toFixed(1)} mi`;
      if (dhDist && dhDist > 0) s += ` + ${dhDist.toFixed(1)} mi day hikes`;
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
    const type = p.point_type || p.type;
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

function openSidebar() {
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
      TripManager.currentTrip.properties.name = tripTitleInput.value;
      TripManager.save();
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
      if (!confirm("Start a new trip? Current trip will remain in Downloads if saved.")) return;
    }
    showOnboardingModal();
  });

  // Load saved trip; if none, show onboarding on first open
  TripManager.loadFromStorage();

  // ---------------------------------------------------------------------------
  // Drag-and-drop event delegation (notebook panel)
  // ---------------------------------------------------------------------------

  const notebookPanel = document.getElementById("notebookPanel");

  notebookPanel.addEventListener("dragover", (e) => {
    e.preventDefault();
    const featureList = e.target.closest(".day-feature-list");
    const pool = e.target.closest(".unassigned-pool");
    if (featureList) {
      e.dataTransfer.dropEffect = "move";
      const insertBeforeId = getDragInsertBeforeId(e, featureList);
      showDragIndicator(featureList, insertBeforeId);
      featureList._dropInsertBefore = insertBeforeId;
      featureList.classList.add("drag-over");
    } else if (pool) {
      e.dataTransfer.dropEffect = "move";
      pool.classList.add("drag-over");
    }
  });

  notebookPanel.addEventListener("dragleave", (e) => {
    const featureList = e.target.closest(".day-feature-list");
    const pool = e.target.closest(".unassigned-pool");
    if (featureList && !featureList.contains(e.relatedTarget)) {
      featureList.classList.remove("drag-over");
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

    const featureList = e.target.closest(".day-feature-list");
    const pool = e.target.closest(".unassigned-pool");
    if (featureList) {
      const dayId = featureList.closest(".day-section")?.dataset.dayId;
      if (dayId) {
        // Auto-expand the day when something is dropped into it
        expandedDayIds.add(dayId);
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

function showOnboardingModal() {
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

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

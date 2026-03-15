/**
 * OutHere Trip Planning — Trip State & Sidebar UI
 *
 * Manages the trip data model, renders it on MapLibre,
 * builds the tabbed sidebar (Timeline / Readme), and handles
 * localStorage persistence and GeoJSON download/upload.
 *
 * Data model (schema v3):
 *   trip.features          — flat array of all feature objects (GeoJSON / MapLibre source)
 *   trip.unassigned        — array of feature IDs not yet assigned to a day
 *   trip.days              — array of { id, date, features: [featureId, ...] }
 *   trip.properties.readme — markdown string for Readme tab
 *
 * Dependencies (loaded before this script):
 *   - map        (global, from app.js)
 *   - planning.js (cancelDrawing, initPointTypeSelector, getTripDateRange, etc.)
 */

// ---------------------------------------------------------------------------
// Trip state manager
// ---------------------------------------------------------------------------

const STORAGE_KEY = "outhere_trip";

const TripManager = {
  currentTrip: null,

  create(name) {
    this.currentTrip = {
      type: "FeatureCollection",
      properties: {
        trip_id: crypto.randomUUID(),
        name: name || "Untitled Trip",
        created: new Date().toISOString(),
        sharing: "private",
        readme: "",
        _schema_version: 3,
      },
      days: [],
      unassigned: [],
      features: [],
    };
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
    };
    this.currentTrip.days.push(day);
    this.render();
    this.save();
  },

  /** Update MapLibre source and sidebar. */
  render() {
    if (map.getSource("trip")) {
      map.getSource("trip").setData(this.currentTrip || { type: "FeatureCollection", features: [] });
    }
    renderSidebar();
    renderTripMeta();
  },

  save() {
    if (this.currentTrip) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.currentTrip));
    }
  },

  loadFromStorage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        this.currentTrip = migrateTrip(JSON.parse(saved));
        this.render();
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
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

  download() {
    if (!this.currentTrip) return;
    const data = JSON.stringify(this.currentTrip, null, 2);
    const blob = new Blob([data], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = this.currentTrip.properties.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    a.download = `${slug}.geojson`;
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
      if (f.properties.type === "waypoint" && !f.properties.point_type) {
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
      trip.unassigned = trip.features.map(f => f.properties._id);
    }
    if (!trip.days) {
      trip.days = [];
    }
    if (!trip.properties.readme) {
      trip.properties.readme = "";
    }
    trip.properties._schema_version = 3;
  }

  return trip;
}

// ---------------------------------------------------------------------------
// Auto-calculate day date from trip start + day index
// ---------------------------------------------------------------------------

function computeDayDate(trip, dayIndex) {
  const start = trip.properties.dates?.start;
  if (!start) return null;
  const d = new Date(start + "T00:00:00");
  d.setDate(d.getDate() + dayIndex);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sidebar: trip metadata
// ---------------------------------------------------------------------------

function renderTripMeta() {
  const nameInput = document.getElementById("tripName");
  const startInput = document.getElementById("tripStart");
  const endInput = document.getElementById("tripEnd");
  const notesInput = document.getElementById("tripNotes");
  if (!nameInput) return;

  if (!TripManager.currentTrip) {
    nameInput.value = "";
    startInput.value = "";
    endInput.value = "";
    notesInput.value = "";
    return;
  }

  const meta = TripManager.currentTrip.properties;
  nameInput.value = meta.name || "";
  startInput.value = meta.dates?.start || "";
  endInput.value = meta.dates?.end || "";
  notesInput.value = meta.notes || "";
}

function onTripMetaChange() {
  if (!TripManager.currentTrip) return;
  const meta = TripManager.currentTrip.properties;
  meta.name = document.getElementById("tripName").value;
  const start = document.getElementById("tripStart").value;
  const end = document.getElementById("tripEnd").value;
  if (start || end) {
    meta.dates = { start, end };
  } else {
    delete meta.dates;
  }
  meta.notes = document.getElementById("tripNotes").value || undefined;

  // Recompute day dates when trip dates change
  if (TripManager.currentTrip.days) {
    TripManager.currentTrip.days.forEach((day, idx) => {
      day.date = computeDayDate(TripManager.currentTrip, idx);
    });
  }

  TripManager.save();
  renderSidebar();
}

// ---------------------------------------------------------------------------
// Sidebar: top-level render dispatcher
// ---------------------------------------------------------------------------

function renderSidebar() {
  renderTimeline();
  // Readme tab has no dynamic content in this phase
}

// ---------------------------------------------------------------------------
// Sidebar: Timeline tab
// ---------------------------------------------------------------------------

function renderTimeline() {
  renderUnassignedPool();
  renderDaySections();
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
    chipsEl.innerHTML = '<span class="pool-empty">No unassigned features</span>';
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

  trip.days.forEach((day, idx) => {
    container.appendChild(buildDaySection(day, idx));
  });
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

  chip.innerHTML = `
    <span class="chip-icon">${buildTypeIconHTML(type)}</span>
    <span class="chip-name">${escapeHTML(getFeatureLabel(props, type))}</span>
  `;

  chip.addEventListener("click", () => {
    const idx = TripManager.currentTrip.features.findIndex(f => f.properties._id === props._id);
    if (idx !== -1) openFeatureForm(idx);
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

  const section = document.createElement("div");
  section.className = "day-section";
  section.dataset.dayId = day.id;

  // Date label: use day.date if set, otherwise auto-compute from trip start
  const dateLabel = day.date ? formatDateLabel(day.date) : "";

  // Stats bar HTML
  const statParts = [];
  if (stats.totalMiles > 0) statParts.push(`<span class="day-stat">${stats.totalMiles.toFixed(1)} mi</span>`);
  if (stats.totalElevGain > 0) statParts.push(`<span class="day-stat">+${Math.round(stats.totalElevGain).toLocaleString()} ft</span>`);
  if (stats.totalMinutes > 0) statParts.push(`<span class="day-stat">${formatDuration(stats.totalMinutes)}</span>`);
  if (stats.hasWater) statParts.push(`<span class="day-stat day-stat-water">&#128167; Water</span>`);

  section.innerHTML = `
    <div class="day-header">
      <span class="day-label">Day ${dayIndex + 1}</span>
      ${dateLabel ? `<span class="day-date">${escapeHTML(dateLabel)}</span>` : ""}
    </div>
    ${statParts.length > 0 ? `<div class="day-stats">${statParts.join("")}</div>` : ""}
    <div class="day-feature-list"></div>
  `;

  const featureList = section.querySelector(".day-feature-list");
  if (dayFeatures.length === 0) {
    featureList.innerHTML = '<div class="day-empty">No features yet</div>';
  } else {
    for (const f of dayFeatures) {
      featureList.appendChild(buildFeatureTile(f));
    }
  }

  return section;
}

// ---------------------------------------------------------------------------
// Sidebar: build feature tile (inside a day section)
// ---------------------------------------------------------------------------

function buildFeatureTile(feature) {
  const props = feature.properties;
  const type = props.point_type || props.type;

  const tile = document.createElement("div");
  tile.className = "feature-tile";
  tile.dataset.id = props._id || "";

  const stats = getFeatureStats(props, type);

  tile.innerHTML = `
    <div class="tile-type-icon">${buildTypeIconHTML(type)}</div>
    <div class="tile-info">
      <span class="tile-name">${escapeHTML(getFeatureLabel(props, type))}</span>
      ${stats ? `<span class="tile-stats">${escapeHTML(stats)}</span>` : ""}
    </div>
    <div class="tile-drag-handle">&#9776;</div>
  `;

  tile.addEventListener("click", () => {
    const idx = TripManager.currentTrip.features.findIndex(f => f.properties._id === props._id);
    if (idx !== -1) openFeatureForm(idx);
  });

  return tile;
}

// ---------------------------------------------------------------------------
// Type icons
// ---------------------------------------------------------------------------

function buildTypeIconHTML(type) {
  switch (type) {
    case "route":
      return '<span class="tile-icon-dot tile-icon-dot--route"></span>';
    case "camp":
      return "&#9978;"; // ⛺
    case "meal":
      return "&#127859;"; // 🍳
    case "waypoint":
      return "&#128205;"; // 📍
    case "dayhike":
      return "&#129406;"; // 🥾
    case "rest":
      return "&#128164;"; // 💤
    case "dayhike_spur":
      return "&#129406;"; // 🥾
    default:
      return "&#128205;"; // 📍
  }
}

// ---------------------------------------------------------------------------
// Feature label + stats helpers
// ---------------------------------------------------------------------------

const POINT_TYPE_LABELS = {
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
  if (type === "camp" && props.water_nearby) return "Water nearby";
  if (props.estimatedDuration) return formatDuration(props.estimatedDuration);
  if (type === "dayhike_spur") return "Day hike spur";
  if (type === "waypoint" && props.subtype) return WAYPOINT_LABELS[props.subtype] || props.subtype;
  return "";
}

// ---------------------------------------------------------------------------
// Day stats aggregation
// ---------------------------------------------------------------------------

function computeDayStats(features) {
  let totalMiles = 0;
  let totalElevGain = 0;
  let totalMinutes = 0;
  let hasWater = false;

  for (const f of features) {
    const p = f.properties;
    const type = p.point_type || p.type;
    if (type === "route") {
      totalMiles += (p.main_route_distance_mi || 0) + (p.dayhike_distance_mi || 0);
      totalElevGain += p.elevation_gain_ft || 0;
    }
    if (p.estimatedDuration) totalMinutes += p.estimatedDuration;
    if ((type === "camp") && p.water_nearby) hasWater = true;
  }

  return { totalMiles, totalElevGain, totalMinutes, hasWater };
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

function openFeatureForm(index) {
  const feature = TripManager.currentTrip?.features[index];
  if (!feature) return;

  // Make sure trip panel is open
  const tripPanel = document.getElementById("tripPanel");
  tripPanel.classList.add("open");
  document.getElementById("planBtn").classList.add("active");
  document.body.classList.add("sidebar-open");

  const container = document.getElementById("tripFeatureForm");
  container.innerHTML = "";
  container.classList.add("visible");

  const props = feature.properties;
  const type = props.point_type || props.type;
  const iconHTML = buildTypeIconHTML(type);

  let formHTML = `<h4>${iconHTML} Edit ${POINT_TYPE_LABELS[type] || type}</h4>`;

  // Name field (all types)
  formHTML += `<label>Name<input type="text" id="featName" value="${escapeAttr(props.name || "")}" /></label>`;

  if (type === "route") {
    formHTML += `
      <label class="checkbox-label">
        <input type="checkbox" id="featPlanned" ${props.planned ? "checked" : ""} /> Planned route
      </label>
      <label>Notes<textarea id="featNotes" rows="2">${escapeHTML(props.notes || "")}</textarea></label>
    `;
  } else if (type === "camp") {
    formHTML += `
      <label>Date<select id="featDate">${buildDateOptions(props.date)}</select></label>
      <label class="checkbox-label">
        <input type="checkbox" id="featWaterNearby" ${props.water_nearby ? "checked" : ""} /> Water nearby
      </label>
      <label>Water notes<input type="text" id="featWaterNotes" value="${escapeAttr(props.water_notes || "")}" /></label>
      <label>Notes<textarea id="featNotes" rows="2">${escapeHTML(props.notes || "")}</textarea></label>
    `;
  } else if (type === "dayhike" || type === "rest") {
    formHTML += `
      <label>Date<select id="featDate">${buildDateOptions(props.date)}</select></label>
      <label>Notes<textarea id="featNotes" rows="2">${escapeHTML(props.notes || "")}</textarea></label>
    `;
  } else if (type === "waypoint") {
    formHTML += `
      <label>Type
        <select id="featSubtype">
          <option value="scenic" ${props.subtype === "scenic" ? "selected" : ""}>Scenic</option>
          <option value="water" ${props.subtype === "water" ? "selected" : ""}>Water</option>
          <option value="hazard" ${props.subtype === "hazard" ? "selected" : ""}>Hazard</option>
          <option value="resupply" ${props.subtype === "resupply" ? "selected" : ""}>Resupply</option>
        </select>
      </label>
      <label>Notes<textarea id="featNotes" rows="2">${escapeHTML(props.notes || "")}</textarea></label>
    `;
  }

  formHTML += `
    <div class="form-actions">
      <button class="form-save" id="featSave">Save</button>
      <button class="form-cancel" id="featCancel">Cancel</button>
      <button class="form-delete" id="featDelete">Delete</button>
    </div>
  `;

  container.innerHTML = formHTML;

  document.getElementById("featSave").addEventListener("click", () => {
    const updates = { name: document.getElementById("featName").value };

    if (type === "route") {
      updates.planned = document.getElementById("featPlanned").checked;
      updates.notes = document.getElementById("featNotes").value;
    } else if (type === "camp") {
      updates.date = document.getElementById("featDate").value;
      updates.water_nearby = document.getElementById("featWaterNearby").checked;
      updates.water_notes = document.getElementById("featWaterNotes").value;
      updates.notes = document.getElementById("featNotes").value;
    } else if (type === "dayhike" || type === "rest") {
      updates.date = document.getElementById("featDate").value;
      updates.notes = document.getElementById("featNotes").value;
    } else if (type === "waypoint") {
      updates.subtype = document.getElementById("featSubtype").value;
      updates.notes = document.getElementById("featNotes").value;
    }

    TripManager.updateFeature(index, updates);
    closeFeatureForm();
  });

  document.getElementById("featCancel").addEventListener("click", closeFeatureForm);

  document.getElementById("featDelete").addEventListener("click", () => {
    if (confirm("Delete this feature?")) {
      TripManager.removeFeature(index);
      closeFeatureForm();
    }
  });
}

function closeFeatureForm() {
  const container = document.getElementById("tripFeatureForm");
  if (container) {
    container.classList.remove("visible");
    container.innerHTML = "";
  }
}

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

function updateDrawingPreview(info) {
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

function openSidebar() {
  const tripPanel = document.getElementById("tripPanel");
  const toolbar = document.getElementById("planningToolbar");
  tripPanel.classList.add("open");
  document.getElementById("planBtn").classList.add("active");
  document.body.classList.add("sidebar-open");
  toolbar.classList.add("visible");
  if (!TripManager.currentTrip) {
    TripManager.create("Untitled Trip");
  }
  setTimeout(() => map.resize(), 260);
}

function closeSidebar() {
  const tripPanel = document.getElementById("tripPanel");
  const toolbar = document.getElementById("planningToolbar");
  tripPanel.classList.remove("open");
  document.getElementById("planBtn").classList.remove("active");
  document.body.classList.remove("sidebar-open");
  toolbar.classList.remove("visible");
  cancelDrawing();
  setTimeout(() => map.resize(), 260);
}

// ---------------------------------------------------------------------------
// Panel wiring
// ---------------------------------------------------------------------------

function initTripPanel() {
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

  // Tab switching
  document.querySelectorAll(".sidebar-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".sidebar-tab").forEach(t => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      const tabName = tab.dataset.tab;
      document.getElementById("timelinePanel").classList.toggle("sidebar-tab-panel--hidden", tabName !== "timeline");
      document.getElementById("readmePanel").classList.toggle("sidebar-tab-panel--hidden", tabName !== "readme");
    });
  });

  // Add Day button
  document.getElementById("addDayBtn").addEventListener("click", () => {
    TripManager.addDay();
  });

  // Drawing tool button
  document.getElementById("drawRouteBtn").addEventListener("click", startRouteDrawing);

  // Point-type selector buttons
  initPointTypeSelector();

  // Cancel drawing on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelDrawing();
  });

  // Trip metadata change handlers
  ["tripName", "tripStart", "tripEnd", "tripNotes"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", onTripMetaChange);
  });

  // Download button
  document.getElementById("downloadTripBtn").addEventListener("click", () => {
    TripManager.download();
  });

  // Upload button
  document.getElementById("loadTripInput").addEventListener("change", (e) => {
    if (e.target.files[0]) {
      handleFileUpload(e.target.files[0]);
      e.target.value = "";
    }
  });

  // New trip button
  document.getElementById("newTripBtn").addEventListener("click", () => {
    if (TripManager.currentTrip && TripManager.currentTrip.features.length > 0) {
      if (!confirm("Start a new trip? Current trip will remain in Downloads if saved.")) return;
    }
    TripManager.create("Untitled Trip");
  });

  // Load saved trip from localStorage
  TripManager.loadFromStorage();
}

// ---------------------------------------------------------------------------
// Auto-save every 30 seconds
// ---------------------------------------------------------------------------

setInterval(() => {
  if (TripManager.currentTrip) {
    TripManager.save();
  }
}, 30000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHTML(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

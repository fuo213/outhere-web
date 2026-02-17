/**
 * OutHere Trip Planning — Trip State & Sidebar UI
 *
 * Manages the trip FeatureCollection, renders it on MapLibre,
 * builds the sidebar feature list + edit forms, and handles
 * localStorage persistence and GeoJSON download/upload.
 *
 * Dependencies (loaded before this script):
 *   - map        (global, from app.js)
 *   - planning.js (cancelDrawing, etc.)
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
      },
      features: [],
    };
    this.render();
    this.save();
  },

  /** Add a feature and return its index. */
  addFeature(geometry, properties) {
    this.currentTrip.features.push({ type: "Feature", geometry, properties });
    const idx = this.currentTrip.features.length - 1;
    this.render();
    this.save();
    return idx;
  },

  removeFeature(index) {
    this.currentTrip.features.splice(index, 1);
    // Renumber camp night_numbers
    let nightNum = 1;
    for (const f of this.currentTrip.features) {
      if (f.properties.type === "camp") {
        f.properties.night_number = nightNum++;
      }
    }
    this.render();
    this.save();
  },

  updateFeature(index, properties) {
    Object.assign(this.currentTrip.features[index].properties, properties);
    this.render();
    this.save();
  },

  getNextNightNumber() {
    if (!this.currentTrip) return 1;
    return this.currentTrip.features.filter((f) => f.properties.type === "camp").length + 1;
  },

  /** Update MapLibre source and sidebar list. */
  render() {
    if (map.getSource("trip")) {
      map.getSource("trip").setData(this.currentTrip || { type: "FeatureCollection", features: [] });
    }
    renderFeatureList();
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
        this.currentTrip = JSON.parse(saved);
        this.render();
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  },

  loadFromGeoJSON(geojson) {
    // Validate basic structure
    if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
      throw new Error("Invalid GeoJSON: expected a FeatureCollection");
    }
    // Ensure trip metadata exists
    if (!geojson.properties || !geojson.properties.trip_id) {
      geojson.properties = {
        trip_id: crypto.randomUUID(),
        name: geojson.properties?.name || "Imported Trip",
        created: new Date().toISOString(),
        sharing: "private",
        ...geojson.properties,
      };
    }
    this.currentTrip = geojson;
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
  TripManager.save();
}

// ---------------------------------------------------------------------------
// Sidebar: feature list
// ---------------------------------------------------------------------------

const FEATURE_ICONS = {
  route: "\u{1F6A9}",    // flag
  camp: "\u{26FA}",      // tent
  waypoint: "\u{1F4CD}", // pin
  photo: "\u{1F4F7}",    // camera
};

const WAYPOINT_LABELS = {
  water: "Water",
  hazard: "Hazard",
  scenic: "Scenic",
  resupply: "Resupply",
};

function renderFeatureList() {
  const container = document.getElementById("tripFeatureList");
  if (!container) return;
  container.innerHTML = "";

  if (!TripManager.currentTrip || TripManager.currentTrip.features.length === 0) {
    container.innerHTML = '<p class="trip-empty">No features yet. Use the toolbar to add routes, camps, and waypoints.</p>';
    return;
  }

  TripManager.currentTrip.features.forEach((feature, index) => {
    const props = feature.properties;
    const row = document.createElement("div");
    row.className = "trip-feature-row";
    row.dataset.index = index;

    const icon = FEATURE_ICONS[props.type] || "\u{1F4CD}";
    let label = props.name || "";
    if (!label) {
      switch (props.type) {
        case "route":
          label = "Untitled Route";
          break;
        case "camp":
          label = `Camp Night ${props.night_number}`;
          break;
        case "waypoint":
          label = `${WAYPOINT_LABELS[props.subtype] || "Waypoint"} Point`;
          break;
        default:
          label = props.type;
      }
    }

    let subtitle = "";
    if (props.type === "camp" && props.water_nearby) {
      subtitle = "Water nearby";
    } else if (props.type === "waypoint" && props.subtype) {
      subtitle = WAYPOINT_LABELS[props.subtype] || props.subtype;
    } else if (props.type === "route") {
      const numPts = feature.geometry.coordinates?.length || 0;
      subtitle = `${numPts} points`;
    }

    row.innerHTML = `
      <span class="trip-feature-icon">${icon}</span>
      <div class="trip-feature-info">
        <span class="trip-feature-name">${label}</span>
        ${subtitle ? `<span class="trip-feature-sub">${subtitle}</span>` : ""}
      </div>
      <div class="trip-feature-actions">
        <button class="trip-feat-btn trip-feat-edit" title="Edit" data-index="${index}">&#9998;</button>
        <button class="trip-feat-btn trip-feat-zoom" title="Zoom to" data-index="${index}">&#8982;</button>
        <button class="trip-feat-btn trip-feat-delete" title="Delete" data-index="${index}">&times;</button>
      </div>
    `;

    container.appendChild(row);
  });

  // Event delegation for feature actions
  container.querySelectorAll(".trip-feat-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFeatureForm(parseInt(btn.dataset.index));
    });
  });

  container.querySelectorAll(".trip-feat-zoom").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      zoomToFeature(parseInt(btn.dataset.index));
    });
  });

  container.querySelectorAll(".trip-feat-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("Delete this feature?")) {
        TripManager.removeFeature(parseInt(btn.dataset.index));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Feature edit form (shown in-panel)
// ---------------------------------------------------------------------------

function openFeatureForm(index) {
  const feature = TripManager.currentTrip?.features[index];
  if (!feature) return;

  // Make sure trip panel is open
  document.getElementById("tripPanel").classList.add("open");
  document.getElementById("planBtn").classList.add("active");

  const container = document.getElementById("tripFeatureForm");
  container.innerHTML = "";
  container.classList.add("visible");

  const props = feature.properties;
  const type = props.type;

  let formHTML = `<h4>${FEATURE_ICONS[type] || ""} Edit ${type.charAt(0).toUpperCase() + type.slice(1)}</h4>`;

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
      <label>Night #<input type="number" id="featNight" value="${props.night_number || 1}" min="1" /></label>
      <label class="checkbox-label">
        <input type="checkbox" id="featWaterNearby" ${props.water_nearby ? "checked" : ""} /> Water nearby
      </label>
      <label>Water notes<input type="text" id="featWaterNotes" value="${escapeAttr(props.water_notes || "")}" /></label>
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
    </div>
  `;

  container.innerHTML = formHTML;

  document.getElementById("featSave").addEventListener("click", () => {
    const updates = { name: document.getElementById("featName").value };

    if (type === "route") {
      updates.planned = document.getElementById("featPlanned").checked;
      updates.notes = document.getElementById("featNotes").value;
    } else if (type === "camp") {
      updates.night_number = parseInt(document.getElementById("featNight").value) || 1;
      updates.water_nearby = document.getElementById("featWaterNearby").checked;
      updates.water_notes = document.getElementById("featWaterNotes").value;
      updates.notes = document.getElementById("featNotes").value;
    } else if (type === "waypoint") {
      updates.subtype = document.getElementById("featSubtype").value;
      updates.notes = document.getElementById("featNotes").value;
    }

    TripManager.updateFeature(index, updates);
    closeFeatureForm();
  });

  document.getElementById("featCancel").addEventListener("click", closeFeatureForm);
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
// Panel open/close wiring
// ---------------------------------------------------------------------------

function initTripPanel() {
  const planBtn = document.getElementById("planBtn");
  const tripPanel = document.getElementById("tripPanel");
  const toolbar = document.getElementById("planningToolbar");

  // Toggle trip panel
  planBtn.addEventListener("click", () => {
    const isOpen = tripPanel.classList.toggle("open");
    planBtn.classList.toggle("active", isOpen);
    toolbar.classList.toggle("visible", isOpen);

    // Auto-create trip if none exists
    if (isOpen && !TripManager.currentTrip) {
      TripManager.create("Untitled Trip");
    }

    if (!isOpen) {
      cancelDrawing();
    }
  });

  // Drawing tool buttons
  document.getElementById("drawRouteBtn").addEventListener("click", startRouteDrawing);
  document.getElementById("dropCampBtn").addEventListener("click", startCampDrop);

  // Waypoint button — cycles through subtypes or just uses scenic default
  document.getElementById("addWaypointBtn").addEventListener("click", () => {
    startWaypointDrop("scenic");
  });

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
      e.target.value = ""; // reset so same file can be re-loaded
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
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

let readmeMode = "edit"; // "edit" | "preview"
let activeDayId = null;  // day ID currently highlighted on map, or null

const TEMPLATES = {
  solo: `## Gear checklist
- [ ] Tent/shelter
- [ ] Sleeping bag
- [ ] Sleeping pad
- [ ] Stove + fuel
- [ ] Water filter
- [ ] First aid kit
- [ ] Headlamp
- [ ] Map/compass

## Water plan
Describe water sources and filtration strategy.

## Permit info
Permit number, ranger district, entry/exit points.

## Emergency contacts
Name, phone, relationship. Include local ranger station number.`,

  group: `## Group members
Name, role, emergency contact.

## Shared gear
- [ ] Tent (who carries?)
- [ ] Stove + fuel
- [ ] First aid kit
- [ ] Navigation gear

## Meal plan
Breakfast, lunch, dinner per day.

## Communication plan
Satellite communicator owner, check-in schedule, emergency protocols.

## Resupply points
Location, method (cache/mail/store), day number.`,
};

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
// Sidebar: top-level render dispatcher
// ---------------------------------------------------------------------------

function renderSidebar() {
  renderTimeline();
  renderReadme();
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

  trip.days.forEach((day, idx) => {
    if (idx > 0) container.appendChild(buildDaySectionDivider());
    container.appendChild(buildDaySection(day, idx));
  });
}

// ---------------------------------------------------------------------------
// Sidebar: Readme tab
// ---------------------------------------------------------------------------

function renderReadme() {
  const trip = TripManager.currentTrip;
  const content = trip?.properties?.readme || "";

  // Update editor value (don't clobber if the user is actively typing)
  const editor = document.getElementById("readmeEditor");
  if (editor && document.activeElement !== editor) {
    editor.value = content;
  }

  // Template picker: visible only when content is empty
  const picker = document.getElementById("readmeTemplatePicker");
  if (picker) picker.style.display = content.trim() === "" ? "" : "none";

  // Re-render TOC from current content
  renderReadmeTOC(content);

  // In preview mode, refresh the rendered output
  if (readmeMode === "preview") {
    const rendered = document.getElementById("readmeRendered");
    if (rendered) {
      rendered.innerHTML = parseMarkdown(content);
      attachTOCScrollHandlers();
    }
  }
}

function renderReadmeTOC(content) {
  const toc = document.getElementById("readmeToc");
  if (!toc) return;
  const headings = parseMarkdownHeadings(content);
  if (headings.length === 0) {
    toc.innerHTML = "";
    toc.style.display = "none";
    return;
  }
  toc.style.display = "";
  toc.innerHTML = headings.map(h => {
    const indent = Math.max(0, h.level - 2) * 12;
    return `<a class="toc-link" href="#${escapeAttr(h.slug)}" style="padding-left:${8 + indent}px">${escapeHTML(h.text)}</a>`;
  }).join("");
  attachTOCScrollHandlers();
}

function attachTOCScrollHandlers() {
  const toc = document.getElementById("readmeToc");
  if (!toc) return;
  toc.querySelectorAll(".toc-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const slug = link.getAttribute("href").slice(1);
      const target = document.getElementById(slug);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
}

function parseMarkdownHeadings(content) {
  const headings = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(#{2,4})\s+(.+)/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), slug: slugify(m[2].trim()) });
  }
  return headings;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseMarkdown(md) {
  if (!md || !md.trim()) {
    return '<p class="readme-empty-msg">No content yet. Switch to Edit mode to add trip notes.</p>';
  }
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  let listTag = "";

  const closeList = () => {
    if (inList) { html += `</${listTag}>`; inList = false; listTag = ""; }
  };

  for (const line of lines) {
    // Headings
    const hm = line.match(/^(#{1,4})\s+(.+)/);
    if (hm) {
      closeList();
      const lvl = hm[1].length;
      const id = slugify(hm[2]);
      html += `<h${lvl} id="${escapeAttr(id)}">${inlineMarkdown(hm[2])}</h${lvl}>`;
      continue;
    }
    // Checkbox list item
    const cbm = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
    if (cbm) {
      if (!inList || listTag !== "ul") { closeList(); html += '<ul class="readme-checklist">'; inList = true; listTag = "ul"; }
      const checked = cbm[1].trim() !== "";
      html += `<li><label class="readme-check-label"><input type="checkbox" ${checked ? "checked" : ""} onclick="return false">${inlineMarkdown(cbm[2])}</label></li>`;
      continue;
    }
    // Regular list item
    const lm = line.match(/^[-*]\s+(.*)/);
    if (lm) {
      if (!inList || listTag !== "ul") { closeList(); html += "<ul>"; inList = true; listTag = "ul"; }
      html += `<li>${inlineMarkdown(lm[1])}</li>`;
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
  closeList();
  return html;
}

function inlineMarkdown(text) {
  text = escapeHTML(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return text;
}

// ---------------------------------------------------------------------------
// Map: day highlight
// ---------------------------------------------------------------------------

function setActiveDayHighlight(dayId) {
  activeDayId = dayId;

  // Update sidebar visual state
  document.querySelectorAll(".day-section").forEach(section => {
    section.classList.toggle("day-active", section.dataset.dayId === dayId);
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

function buildDaySectionDivider() {
  const divider = document.createElement("div");
  divider.className = "day-divider";
  divider.innerHTML = `<svg width="100%" height="20" viewBox="0 0 276 20" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="0" y1="10" x2="276" y2="10" stroke="#c9c3b5" stroke-width="1" stroke-dasharray="3 4"/>
    <circle cx="20" cy="10" r="2" fill="#c9c3b5"/>
    <circle cx="138" cy="10" r="2" fill="#c9c3b5"/>
    <circle cx="256" cy="10" r="2" fill="#c9c3b5"/>
  </svg>`;
  return divider;
}

function buildDaySection(day, dayIndex) {
  const trip = TripManager.currentTrip;
  const dayFeatures = (day.features || [])
    .map(id => trip.features.find(f => f.properties._id === id))
    .filter(Boolean);
  const stats = computeDayStats(dayFeatures);

  const section = document.createElement("div");
  section.className = "day-section";
  section.dataset.dayId = day.id;

  // Build inline stats string
  const statParts = [];
  if (stats.totalMiles > 0) statParts.push(`${stats.totalMiles.toFixed(1)} mi`);
  if (stats.totalElevGain > 0) statParts.push(`+${Math.round(stats.totalElevGain).toLocaleString()} ft`);
  if (stats.totalMinutes > 0) statParts.push(formatDuration(stats.totalMinutes));
  if (stats.hasWater) statParts.push("water nearby");
  const statsText = statParts.join(" · ");

  // Date label: use day.date if set
  const dateLabel = day.date ? formatDateLabel(day.date) : "";
  const dateText = dateLabel ? ` — ${dateLabel}` : "";

  section.innerHTML = `
    <div class="day-header" tabindex="0" role="button" aria-label="Day ${dayIndex + 1}${dateLabel ? `, ${dateLabel}` : ""}">
      <span class="day-label">Day ${dayIndex + 1}</span>
      ${dateLabel ? `<span class="day-date">${escapeHTML(dateLabel)}</span>` : ""}
      <span class="day-rule"></span>
      ${statsText ? `<span class="day-stats-inline">${escapeHTML(statsText)}</span>` : ""}
    </div>
    <div class="day-feature-list"></div>
  `;

  // Click day header to toggle map highlight for that day
  section.querySelector(".day-header").addEventListener("click", () => {
    setActiveDayHighlight(activeDayId === day.id ? null : day.id);
  });

  const featureList = section.querySelector(".day-feature-list");
  if (dayFeatures.length === 0) {
    featureList.innerHTML = `<div class="day-drop-zone"><svg class="day-drop-zone-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#A89880" stroke-width="1.2" stroke-linecap="round"><polyline points="2,17 6,5 10,12 13,3 18,17"/></svg><span class="day-drop-zone-label">Drag waypoints here</span></div>`;
  } else {
    for (const f of dayFeatures) {
      featureList.appendChild(buildFeatureTile(f, day.id));
    }
  }

  // Mark as active if this day is the current highlight
  if (activeDayId === day.id) section.classList.add("day-active");

  return section;
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

function switchToTab(tabName) {
  document.querySelectorAll(".sidebar-tab").forEach(t => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.getElementById("timelinePanel").classList.toggle("sidebar-tab-panel--hidden", tabName !== "timeline");
  document.getElementById("readmePanel").classList.toggle("sidebar-tab-panel--hidden", tabName !== "readme");
}

function openSidebar() {
  const tripPanel = document.getElementById("tripPanel");
  const toolbar = document.getElementById("planningToolbar");
  const planBtnEl = document.getElementById("planBtn");
  // Align toolbar top with planBtn before making it visible
  if (planBtnEl && toolbar) {
    toolbar.style.top = planBtnEl.getBoundingClientRect().top + "px";
  }
  tripPanel.classList.add("open");
  document.getElementById("planBtn").classList.add("active");
  toolbar.classList.add("visible");
  document.body.classList.add("panel-open");
  map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 520 }, duration: 250 });
  if (!TripManager.currentTrip) {
    TripManager.create("Untitled Trip");
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

  // Drawing tool buttons
  document.getElementById("addRouteBtn").addEventListener("click", startRouteDrawing);
  const deleteWaypointBtn = document.getElementById("deleteWaypointBtn");
  if (deleteWaypointBtn) {
    deleteWaypointBtn.addEventListener("click", () => {
      if (isDeleteMode) exitDeleteMode();
      else startDeleteMode();
    });
  }

  // Expose alignment helper for planning.js (re-aligns toolbar with planBtn when needed)
  window.alignPlanningToolbar = function () {
    const planBtnEl = document.getElementById("planBtn");
    const planningToolbarEl = document.getElementById("planningToolbar");
    if (planBtnEl && planningToolbarEl) {
      planningToolbarEl.style.top = planBtnEl.getBoundingClientRect().top + "px";
    }
  };

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

  // ---------------------------------------------------------------------------
  // Readme tab wiring
  // ---------------------------------------------------------------------------

  // Preview toggle button — 3D flip
  const previewBtn = document.getElementById("readmePreviewBtn");
  if (previewBtn) {
    const front = previewBtn.querySelector(".btn-face--front");
    const back  = previewBtn.querySelector(".btn-face--back");
    previewBtn.addEventListener("click", () => {
      const editArea = document.getElementById("readmeEditArea");
      const readArea = document.getElementById("readmeReadArea");
      if (readmeMode === "edit") {
        readmeMode = "preview";
        previewBtn.dataset.mode = "preview";
        front.textContent = "Preview";
        back.textContent  = "Edit";
        editArea.style.display = "none";
        readArea.style.display  = "";
        renderReadme();
      } else {
        readmeMode = "edit";
        previewBtn.dataset.mode = "edit";
        front.textContent = "Edit";
        back.textContent  = "Preview";
        editArea.style.display  = "";
        readArea.style.display  = "none";
      }
      // Shimmy to confirm state change; suppress hover flip until mouseout
      previewBtn.classList.remove("clicked");
      void previewBtn.offsetWidth; // force reflow so animation restarts cleanly
      previewBtn.classList.add("clicked");
    });
    previewBtn.addEventListener("mouseleave", () => {
      previewBtn.classList.remove("clicked");
    });
  }

  // Readme editor — save on input
  const readmeEditor = document.getElementById("readmeEditor");
  if (readmeEditor) {
    readmeEditor.addEventListener("input", () => {
      if (!TripManager.currentTrip) return;
      const content = readmeEditor.value;
      TripManager.currentTrip.properties.readme = content;
      TripManager.save();
      renderReadmeTOC(content);
      const picker = document.getElementById("readmeTemplatePicker");
      if (picker) picker.style.display = content.trim() === "" ? "" : "none";
    });
  }

  // Template buttons
  document.querySelectorAll(".template-opt-btn[data-template]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!TripManager.currentTrip) return;
      const content = TEMPLATES[btn.dataset.template] || "";
      TripManager.currentTrip.properties.readme = content;
      TripManager.save();
      if (readmeEditor) readmeEditor.value = content;
      renderReadme();
    });
  });

  // Import .md file
  const mdInput = document.getElementById("readmeMdInput");
  if (mdInput) {
    mdInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (!TripManager.currentTrip) return;
        const content = ev.target.result;
        TripManager.currentTrip.properties.readme = content;
        TripManager.save();
        if (readmeEditor) readmeEditor.value = content;
        renderReadme();
      };
      reader.readAsText(file);
      e.target.value = "";
    });
  }

  // Print button — switch to preview mode then print
  document.getElementById("readmePrintBtn")?.addEventListener("click", () => {
    if (readmeMode !== "preview") {
      document.getElementById("readmePreviewBtn")?.click();
    }
    setTimeout(() => window.print(), 100);
  });

  // ---------------------------------------------------------------------------
  // Drag-and-drop event delegation (single listener on timeline panel)
  // ---------------------------------------------------------------------------

  const timelinePanel = document.getElementById("timelinePanel");

  timelinePanel.addEventListener("dragover", (e) => {
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

  timelinePanel.addEventListener("dragleave", (e) => {
    const featureList = e.target.closest(".day-feature-list");
    const pool = e.target.closest(".unassigned-pool");
    if (featureList && !featureList.contains(e.relatedTarget)) {
      featureList.classList.remove("drag-over");
    }
    if (pool && !pool.contains(e.relatedTarget)) {
      pool.classList.remove("drag-over");
    }
  });

  timelinePanel.addEventListener("drop", (e) => {
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
        TripManager.moveFeature(data.featureId, "day", dayId, featureList._dropInsertBefore || null);
      }
    } else if (pool) {
      TripManager.moveFeature(data.featureId, "unassigned", null, null);
    }
  });

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  // Enter on a day header toggles map highlight for that day
  timelinePanel.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const header = e.target.closest(".day-header[tabindex]");
    if (!header) return;
    const dayId = header.closest(".day-section")?.dataset.dayId;
    if (dayId) setActiveDayHighlight(activeDayId === dayId ? null : dayId);
  });
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

/**
 * OutHere Trips Home — multi-trip storage + home view
 *
 * Storage model:
 *   outhere_trips_index      — { version: 1, trips: [{ id, name, updated }] }
 *   outhere_trip_<trip_id>   — one full trip FeatureCollection per trip
 *   outhere_active_trip      — trip_id currently open in the planner (or unset)
 *
 * The legacy single-trip key ("outhere_trip") is migrated losslessly into
 * this store on first load — see TripsStore.migrateLegacy().
 *
 * The home view is the app's state when no trip is open: a card per trip
 * with open / duplicate / export / delete actions, plus import + new trip.
 */

import { map } from "./app.js"; // circular with app.js; only used at runtime
import {
  TripManager,
  migrateTrip,
  downloadTripGeoJSON,
  openSidebar,
  showOnboardingModal,
  escapeHTML,
  escapeAttr,
  getDisplayType,
} from "./trip-panel.js"; // circular; only used at runtime
import { getActiveRegionId, findRegionById, getRegionName, applyRegion } from "./region-picker.js";

const INDEX_KEY = "outhere_trips_index";
const TRIP_KEY_PREFIX = "outhere_trip_";
const ACTIVE_TRIP_KEY = "outhere_active_trip";
const LEGACY_TRIP_KEY = "outhere_trip";

// ---------------------------------------------------------------------------
// TripsStore — localStorage index + one entry per trip
// ---------------------------------------------------------------------------

export const TripsStore = {
  readIndex() {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      if (!raw) return { version: 1, trips: [] };
      const idx = JSON.parse(raw);
      if (!idx || !Array.isArray(idx.trips)) throw new Error("invalid index shape");
      return idx;
    } catch (err) {
      console.warn("[trips] discarding corrupt trips index:", err.message);
      return { version: 1, trips: [] };
    }
  },

  writeIndex(idx) {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
    } catch (err) {
      console.warn("[trips] could not write trips index:", err.message);
    }
  },

  /** Load one trip by id. Returns null if missing/corrupt. */
  loadTrip(id) {
    if (!id) return null;
    const raw = localStorage.getItem(TRIP_KEY_PREFIX + id);
    if (!raw) return null;
    try {
      const trip = JSON.parse(raw);
      if (!trip || trip.type !== "FeatureCollection" ||
          !Array.isArray(trip.features) || !trip.properties) {
        throw new Error("saved trip has invalid shape");
      }
      return trip;
    } catch (err) {
      console.warn(`[trips] trip ${id} is corrupt:`, err.message);
      return null;
    }
  },

  /** All trips in the index (parsed), most recently updated first. */
  listTrips() {
    const idx = this.readIndex();
    const trips = [];
    for (const entry of idx.trips) {
      const trip = this.loadTrip(entry.id);
      if (trip) trips.push(trip);
    }
    trips.sort((a, b) =>
      String(b.properties.updated || b.properties.created || "")
        .localeCompare(String(a.properties.updated || a.properties.created || ""))
    );
    return trips;
  },

  /** Persist a trip and upsert its index entry. Throws on quota errors. */
  saveTrip(trip) {
    const id = trip?.properties?.trip_id;
    if (!id) throw new Error("trip has no trip_id");
    localStorage.setItem(TRIP_KEY_PREFIX + id, JSON.stringify(trip));

    const idx = this.readIndex();
    const entry = { id, name: trip.properties.name || "Untitled Trip", updated: trip.properties.updated || new Date().toISOString() };
    const i = idx.trips.findIndex((t) => t.id === id);
    if (i === -1) idx.trips.push(entry);
    else idx.trips[i] = entry;
    this.writeIndex(idx);
  },

  deleteTrip(id) {
    localStorage.removeItem(TRIP_KEY_PREFIX + id);
    const idx = this.readIndex();
    idx.trips = idx.trips.filter((t) => t.id !== id);
    this.writeIndex(idx);
    if (this.getActiveTripId() === id) this.setActiveTripId(null);
  },

  getActiveTripId() {
    return localStorage.getItem(ACTIVE_TRIP_KEY) || null;
  },

  setActiveTripId(id) {
    if (id) localStorage.setItem(ACTIVE_TRIP_KEY, id);
    else localStorage.removeItem(ACTIVE_TRIP_KEY);
  },

  /**
   * One-time lossless migration of the legacy single-trip key into the
   * multi-trip store. The legacy entry is only removed after the new entry
   * has been written and read back successfully.
   */
  migrateLegacy() {
    const raw = localStorage.getItem(LEGACY_TRIP_KEY);
    if (!raw) return;
    try {
      const trip = JSON.parse(raw);
      if (!trip || trip.type !== "FeatureCollection" || !Array.isArray(trip.features)) {
        throw new Error("legacy trip has invalid shape");
      }
      if (!trip.properties) trip.properties = {};
      if (!trip.properties.trip_id) trip.properties.trip_id = crypto.randomUUID();
      const id = trip.properties.trip_id;

      // Don't clobber an existing entry with the same id (already migrated).
      if (!localStorage.getItem(TRIP_KEY_PREFIX + id)) {
        this.saveTrip(trip);
      }
      // The legacy trip was "the open trip" — keep that behaviour.
      if (!this.getActiveTripId()) this.setActiveTripId(id);

      // Verify before removing the legacy key.
      if (this.loadTrip(id)) {
        localStorage.removeItem(LEGACY_TRIP_KEY);
        console.info(`[trips] migrated legacy trip "${trip.properties.name || id}" into multi-trip store`);
      }
    } catch (err) {
      // Leave the legacy key in place so nothing is lost; we'll retry next load.
      console.warn("[trips] legacy trip migration failed:", err.message);
    }
  },
};

// ---------------------------------------------------------------------------
// Trip activation (open from home / import) — region-aware
// ---------------------------------------------------------------------------

/**
 * If the trip belongs to a different region than the active one, switch
 * tiles + camera to that region first (restoreRuntimeLayers re-adds the
 * trip layers after the style swap).
 */
function syncRegionForTrip(trip) {
  const regionId = trip?.properties?.region;
  if (!regionId || regionId === getActiveRegionId()) return;
  const region = findRegionById(regionId);
  if (region && region.available !== false) {
    applyRegion(region);
  } else {
    console.warn(`[trips] trip region "${regionId}" not available in catalog; keeping current region`);
  }
}

function openTrip(id) {
  const trip = TripsStore.loadTrip(id);
  if (!trip) {
    alert("Could not load this trip — it may be corrupt.");
    return;
  }
  syncRegionForTrip(trip);
  TripManager.setTrip(trip);
  hideTripsHome();
  openSidebar();
}

function duplicateTrip(id) {
  const trip = TripsStore.loadTrip(id);
  if (!trip) return;
  const copy = JSON.parse(JSON.stringify(trip));
  copy.properties.trip_id = crypto.randomUUID();
  copy.properties.name = `${copy.properties.name || "Untitled Trip"} (copy)`;
  copy.properties.created = new Date().toISOString();
  copy.properties.updated = new Date().toISOString();
  try {
    TripsStore.saveTrip(copy);
  } catch (err) {
    // Quota exceeded or storage unavailable — surface it instead of dying
    console.warn("[trips] could not duplicate trip:", err.message);
    alert("Could not duplicate this trip — browser storage may be full.");
    return;
  }
  renderTripsHome();
}

function deleteTrip(id) {
  const trip = TripsStore.loadTrip(id);
  const name = trip?.properties?.name || "this trip";
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  TripsStore.deleteTrip(id);
  if (TripManager.currentTrip?.properties?.trip_id === id) {
    TripManager.currentTrip = null;
    TripManager.render();
  }
  renderTripsHome();
}

function exportTrip(id) {
  const trip = TripsStore.loadTrip(id);
  if (!trip) return;
  // Run through the same migration path the planner uses so the export is
  // canonical (schema_version 1.0, readme/notes mirrored) even for trips
  // that were never re-opened after import.
  downloadTripGeoJSON(migrateTrip(trip));
}

// ---------------------------------------------------------------------------
// Card summaries
// ---------------------------------------------------------------------------

function formatCardDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function tripSummary(trip) {
  const p = trip.properties || {};
  let miles = 0;
  for (const f of trip.features || []) {
    if (getDisplayType(f.properties || {}) === "route") {
      miles += (f.properties.main_route_distance_mi || 0) + (f.properties.dayhike_distance_mi || 0);
    }
  }
  const dayCount = Array.isArray(trip.days) ? trip.days.length : 0;
  let dateRange = "";
  if (p.dates?.start && p.dates?.end) {
    dateRange = p.dates.start === p.dates.end
      ? formatCardDate(p.dates.start)
      : `${formatCardDate(p.dates.start)} – ${formatCardDate(p.dates.end)}`;
  }
  return { miles, dayCount, dateRange };
}

// ---------------------------------------------------------------------------
// Home view rendering
// ---------------------------------------------------------------------------

const CARD_STAT_ICONS = {
  calendar: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="10" height="9" rx="1"/><line x1="1" y1="5" x2="11" y2="5"/><line x1="4" y1="1" x2="4" y2="3"/><line x1="8" y1="1" x2="8" y2="3"/></svg>',
  distance: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><polyline points="1,10 4,3 6,7 8,1 11,10"/></svg>',
  region:   '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1 C3.8 1 2 2.8 2 5 C2 8 6 11 6 11 C6 11 10 8 10 5 C10 2.8 8.2 1 6 1 Z"/><circle cx="6" cy="5" r="1.4"/></svg>',
};

function buildTripCard(trip) {
  const p = trip.properties || {};
  const { miles, dayCount, dateRange } = tripSummary(trip);
  const isOpen = TripManager.currentTrip?.properties?.trip_id === p.trip_id;

  const card = document.createElement("article");
  card.className = "trip-card" + (isOpen ? " trip-card-open" : "");
  card.dataset.id = p.trip_id;

  const chips = [];
  if (dateRange) chips.push(`<span class="trip-card-stat">${CARD_STAT_ICONS.calendar}${escapeHTML(dateRange)}</span>`);
  if (dayCount > 0) chips.push(`<span class="trip-card-stat">${dayCount} day${dayCount !== 1 ? "s" : ""}</span>`);
  if (miles > 0) chips.push(`<span class="trip-card-stat">${CARD_STAT_ICONS.distance}${miles.toFixed(1)} mi</span>`);
  if (p.region) chips.push(`<span class="trip-card-stat">${CARD_STAT_ICONS.region}${escapeHTML(getRegionName(p.region))}</span>`);

  card.innerHTML = `
    <div class="trip-card-body" data-action="open" role="button" tabindex="0" aria-label="Open ${escapeAttr(p.name || "Untitled Trip")}">
      <h3 class="trip-card-name">${escapeHTML(p.name || "Untitled Trip")}${isOpen ? '<span class="trip-card-open-tag">Open</span>' : ""}</h3>
      ${p.location ? `<p class="trip-card-location">${escapeHTML(p.location)}</p>` : ""}
      <div class="trip-card-meta">${chips.join("")}</div>
    </div>
    <div class="trip-card-actions">
      <button type="button" data-action="open">Open</button>
      <button type="button" data-action="duplicate">Duplicate</button>
      <button type="button" data-action="export">Export</button>
      <button type="button" data-action="delete" class="trip-card-delete">Delete</button>
    </div>
  `;
  return card;
}

export function renderTripsHome() {
  const grid = document.getElementById("tripsGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const trips = TripsStore.listTrips();
  if (trips.length === 0) {
    grid.innerHTML = `
      <div class="trips-empty">
        <p>No trips yet.</p>
        <p class="trips-empty-sub">Start a new trip or import a saved .geojson file.</p>
      </div>`;
    return;
  }
  for (const trip of trips) {
    grid.appendChild(buildTripCard(trip));
  }
}

export function showTripsHome() {
  renderTripsHome();
  const overlay = document.getElementById("tripsHomeOverlay");
  if (overlay) overlay.hidden = false;
  document.getElementById("homeBtn")?.classList.add("active");
}

export function hideTripsHome() {
  const overlay = document.getElementById("tripsHomeOverlay");
  if (overlay) overlay.hidden = true;
  document.getElementById("homeBtn")?.classList.remove("active");
}

function isTripsHomeVisible() {
  const overlay = document.getElementById("tripsHomeOverlay");
  return overlay && !overlay.hidden;
}

// ---------------------------------------------------------------------------
// Init + wiring
// ---------------------------------------------------------------------------

export function initTripsHome() {
  // Map control button — toggle the home view
  document.getElementById("homeBtn")?.addEventListener("click", () => {
    if (isTripsHomeVisible()) hideTripsHome();
    else showTripsHome();
  });

  // Close button + backdrop click
  document.getElementById("tripsHomeCloseBtn")?.addEventListener("click", hideTripsHome);
  document.getElementById("tripsHomeOverlay")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("tripsHomeOverlay")) hideTripsHome();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isTripsHomeVisible() &&
        document.getElementById("onboardingOverlay")?.hidden !== false) {
      hideTripsHome();
    }
  });

  // Card actions (event delegation)
  document.getElementById("tripsGrid")?.addEventListener("click", (e) => {
    const card = e.target.closest(".trip-card");
    if (!card) return;
    const id = card.dataset.id;
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "open") openTrip(id);
    else if (action === "duplicate") duplicateTrip(id);
    else if (action === "export") exportTrip(id);
    else if (action === "delete") deleteTrip(id);
  });
  document.getElementById("tripsGrid")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("trip-card-body")) {
      const id = e.target.closest(".trip-card")?.dataset.id;
      if (id) openTrip(id);
    }
  });

  // New trip → existing onboarding modal (TripManager.create hides home)
  document.getElementById("tripsHomeNewBtn")?.addEventListener("click", () => {
    showOnboardingModal();
  });

  // Import — same path as the planner's Load Trip
  document.getElementById("tripsHomeImportInput")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const geojson = JSON.parse(ev.target.result);
        TripManager.loadFromGeoJSON(geojson);
        syncRegionForTrip(TripManager.currentTrip);
        hideTripsHome();
        openSidebar();
      } catch (err) {
        alert("Could not load file: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  // Home is the default state when no trip is open.
  if (!TripManager.currentTrip) {
    showTripsHome();
  }
}

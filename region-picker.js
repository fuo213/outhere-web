/**
 * OutHere Region Picker — catalog-driven tile region switching
 *
 * Fetches the machine-readable region catalog from tiles.booot.org
 * (same catalog the mobile app consumes), caches it in localStorage with a
 * 24h TTL (stale-while-revalidate), and lets the user switch the map's
 * PMTiles source between regions.
 *
 * IMPORTANT: map.setStyle() wipes ALL runtime sources/layers (the trip
 * rendering, route-drawing previews, snap preview). applyRegion() therefore
 * re-adds them via restoreRuntimeLayers() once the new style loads.
 */

import { DEFAULT_REGION, CATALOG_URL, MAP_CONFIG } from "./config.js";
import { map, buildStyle, restoreRuntimeLayers } from "./app.js"; // circular with app.js; only used at runtime
import { TripManager, escapeHTML } from "./trip-panel.js"; // circular; only used at runtime

const CATALOG_CACHE_KEY = "outhere_catalog_cache";   // { fetchedAt, catalog }
const ACTIVE_REGION_KEY = "outhere_active_region";   // full region record
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;          // ~24h

let catalog = null;
let activeRegion = readStoredRegion() || DEFAULT_REGION;

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** Region to boot the map with (synchronous — used before the catalog loads). */
export function getInitialRegion() {
  return activeRegion;
}

export function getActiveRegion() {
  return activeRegion;
}

export function getActiveRegionId() {
  return activeRegion.id;
}

/** Look up a region record by id in the loaded catalog (or the fallback). */
export function findRegionById(id) {
  if (!id) return null;
  const fromCatalog = catalog?.regions?.find((r) => r.id === id);
  if (fromCatalog) return fromCatalog;
  if (id === DEFAULT_REGION.id) return DEFAULT_REGION;
  if (id === activeRegion.id) return activeRegion;
  return null;
}

/** Human-readable name for a region id (falls back to the raw id). */
export function getRegionName(id) {
  return findRegionById(id)?.name || id || "";
}

/**
 * MapLibre maxBounds for a region: explicit maxBounds if the record carries
 * one (the Utah fallback keeps the original MAP_CONFIG values), otherwise
 * the catalog bounds padded by half a degree.
 */
export function regionMaxBounds(region) {
  if (region?.maxBounds) return region.maxBounds;
  const b = region?.bounds;
  if (!b) return MAP_CONFIG.maxBounds;
  const pad = 0.5;
  return [
    [b.west - pad, b.south - pad],
    [b.east + pad, b.north + pad],
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readStoredRegion() {
  try {
    const raw = localStorage.getItem(ACTIVE_REGION_KEY);
    if (!raw) return null;
    const region = JSON.parse(raw);
    if (!region || typeof region.id !== "string" || typeof region.url !== "string") {
      throw new Error("stored region has invalid shape");
    }
    return region;
  } catch (err) {
    console.warn("[regions] discarding stored active region:", err.message);
    localStorage.removeItem(ACTIVE_REGION_KEY);
    return null;
  }
}

function persistActiveRegion() {
  try {
    localStorage.setItem(ACTIVE_REGION_KEY, JSON.stringify(activeRegion));
  } catch (err) {
    console.warn("[regions] could not persist active region:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Catalog fetch + cache (stale-while-revalidate, ~24h TTL)
// ---------------------------------------------------------------------------

function readCatalogCache() {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !Array.isArray(cached.catalog?.regions)) throw new Error("invalid cache shape");
    return cached;
  } catch (err) {
    console.warn("[regions] discarding corrupt catalog cache:", err.message);
    localStorage.removeItem(CATALOG_CACHE_KEY);
    return null;
  }
}

function writeCatalogCache(cat) {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), catalog: cat }));
  } catch (err) {
    console.warn("[regions] could not cache catalog:", err.message);
  }
}

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cat = await res.json();
  if (!cat || !Array.isArray(cat.regions)) throw new Error("unexpected catalog shape");
  return cat;
}

function setCatalog(cat, { store = false } = {}) {
  catalog = cat;
  if (store) writeCatalogCache(cat);

  // Refresh the persisted active-region record from the live catalog so URL /
  // bounds updates in the pipeline are picked up on the next reload.
  const fresh = cat.regions.find((r) => r.id === activeRegion.id);
  if (fresh) {
    activeRegion = fresh;
    persistActiveRegion();
    updateRegionButton();
  }
  renderRegionList();
}

async function revalidateCatalog() {
  try {
    setCatalog(await fetchCatalog(), { store: true });
    console.info("[regions] catalog revalidated");
  } catch (err) {
    console.warn("[regions] catalog revalidation failed (keeping cached):", err.message);
  }
}

// ---------------------------------------------------------------------------
// Region switching
// ---------------------------------------------------------------------------

/**
 * Make a region the active one: persist it, rebuild the map style for its
 * tile URL, restore the runtime (trip/drawing) layers, and move the camera
 * into the region's bounds.
 */
export function applyRegion(region, { fly = true } = {}) {
  activeRegion = region;
  persistActiveRegion();
  updateRegionButton();
  renderRegionList();
  document.title = `OutHere — ${region.name}`;

  // Release the old region's camera constraints before moving.
  map.setMaxBounds(null);

  // Swap tile source. diff:false forces a full style rebuild, so ALL runtime
  // sources/layers (trip, route-drawing, snap-preview) are wiped — re-add
  // them as soon as the new style is ready.
  map.setStyle(buildStyle(region), { diff: false });
  map.once("style.load", () => {
    restoreRuntimeLayers();
  });

  const bounds = regionMaxBounds(region);
  const camera = { center: region.center || MAP_CONFIG.center, zoom: region.zoom ?? MAP_CONFIG.zoom };
  if (fly) {
    map.flyTo({ ...camera, duration: 1600, essential: true });
    map.once("moveend", () => {
      // Guard against a second rapid switch racing this callback.
      if (activeRegion.id === region.id && bounds) map.setMaxBounds(bounds);
    });
  } else {
    map.jumpTo(camera);
    if (bounds) map.setMaxBounds(bounds);
  }
}

/** User picked a region in the panel. */
function selectRegion(region) {
  if (!region.available) return;
  closeRegionPanel();
  if (region.id === activeRegion.id) return;

  applyRegion(region);

  // An explicit switch while a trip is open moves the trip's home region too.
  if (TripManager.currentTrip) {
    TripManager.currentTrip.properties.region = region.id;
    TripManager.save();
  }
}

// ---------------------------------------------------------------------------
// UI — switcher button (top-right) + grouped region panel
// ---------------------------------------------------------------------------

function updateRegionButton() {
  const label = document.getElementById("regionBtnLabel");
  if (label) label.textContent = activeRegion.name;
}

function toggleRegionPanel() {
  const panel = document.getElementById("regionPanel");
  const btn = document.getElementById("regionBtn");
  if (!panel) return;
  const open = panel.classList.toggle("open");
  btn?.setAttribute("aria-expanded", open ? "true" : "false");
  btn?.classList.toggle("active", open);
}

function closeRegionPanel() {
  const panel = document.getElementById("regionPanel");
  const btn = document.getElementById("regionBtn");
  panel?.classList.remove("open");
  btn?.setAttribute("aria-expanded", "false");
  btn?.classList.remove("active");
}

/**
 * Group regions by state, then by category within each state (mirrors the
 * mobile app's RegionPicker grouping: state header → category header → rows).
 * Group order follows first appearance in the catalog.
 */
function groupRegions(regions) {
  const states = [];
  const byState = new Map();
  for (const region of regions) {
    const stateKey = region.state || "other";
    if (!byState.has(stateKey)) {
      const group = { state: stateKey, state_name: region.state_name || stateKey, categories: [] };
      byState.set(stateKey, group);
      states.push(group);
    }
    const stateGroup = byState.get(stateKey);
    const catKey = region.category || "other";
    let catGroup = stateGroup.categories.find((c) => c.category === catKey);
    if (!catGroup) {
      catGroup = { category: catKey, category_name: region.category_name || catKey, regions: [] };
      stateGroup.categories.push(catGroup);
    }
    catGroup.regions.push(region);
  }
  return states;
}

function renderRegionList() {
  const panel = document.getElementById("regionPanel");
  if (!panel) return;
  panel.innerHTML = "";

  const heading = document.createElement("h3");
  heading.textContent = "Regions";
  panel.appendChild(heading);

  const regions = catalog?.regions?.length ? catalog.regions : [DEFAULT_REGION];

  for (const stateGroup of groupRegions(regions)) {
    const stateHeader = document.createElement("div");
    stateHeader.className = "region-state-header";
    stateHeader.textContent = stateGroup.state_name;
    panel.appendChild(stateHeader);

    for (const catGroup of stateGroup.categories) {
      const catHeader = document.createElement("div");
      catHeader.className = "region-category-header";
      catHeader.textContent = catGroup.category_name;
      panel.appendChild(catHeader);

      for (const region of catGroup.regions) {
        panel.appendChild(buildRegionRow(region));
      }
    }
  }
}

function buildRegionRow(region) {
  const isActive = region.id === activeRegion.id;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "region-row" +
    (isActive ? " region-row-active" : "") +
    (!region.available ? " region-row-unavailable" : "");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", isActive ? "true" : "false");
  if (!region.available) row.disabled = true;

  const statusHTML = isActive
    ? '<span class="region-status region-status-active">Active</span>'
    : !region.available
      ? '<span class="region-status">Coming soon</span>'
      : "";

  row.innerHTML = `
    <span class="region-row-main">
      <span class="region-row-name">${escapeHTML(region.name)}</span>
      ${region.description ? `<span class="region-row-desc">${escapeHTML(region.description)}</span>` : ""}
    </span>
    ${statusHTML}
  `;

  if (region.available) {
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      selectRegion(region);
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export async function initRegionPicker() {
  const btn = document.getElementById("regionBtn");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRegionPanel();
  });
  // Close the panel when clicking anywhere else (incl. the map canvas).
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".region-switcher")) closeRegionPanel();
  });

  updateRegionButton();
  document.title = `OutHere — ${activeRegion.name}`;
  renderRegionList(); // fallback list until the catalog arrives

  const cached = readCatalogCache();
  if (cached) {
    // Stale-while-revalidate: render from cache immediately, refresh in the
    // background if older than the TTL.
    setCatalog(cached.catalog);
    if (Date.now() - cached.fetchedAt > CATALOG_TTL_MS) revalidateCatalog();
  } else {
    try {
      setCatalog(await fetchCatalog(), { store: true });
    } catch (err) {
      // Never break the app: fall back to the built-in Utah region.
      console.warn("[regions] catalog fetch failed, using fallback region:", err.message);
      setCatalog({ version: "0", generated_at: null, regions: [DEFAULT_REGION] });
    }
  }
}

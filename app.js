/**
 * OutHere Map Viewer — Application Logic
 *
 * Initializes MapLibre GL JS with PMTiles protocol, builds the style
 * from config, and wires up layer toggle controls.
 *
 * CDN globals (classic scripts in index.html): maplibregl, pmtiles, turf.
 */

import { TILE_URL, MAP_CONFIG, LAYER_GROUPS, MAP_FONT } from "./config.js";
import { LayerStyleManager, buildStyleControls, toggleStyleControls } from "./layer-styles.js";
import {
  isDrawingRoute,
  isDeleteMode,
  handleDeleteClick,
  handleMapClickForRoute,
  handleMapDblClickForRoute,
  showGapCard,
  routingDebug,
  elevationDebug,
} from "./planning.js";
import { initTripPanel, TripManager, POINT_TYPE_LABELS, escapeHTML, getDisplayType } from "./trip-panel.js";
import { getInitialRegion, regionMaxBounds, initRegionPicker, applyRegion, findRegionById, getCatalogRegions } from "./region-picker.js";
import { graphInfoForRegion } from "./routing.js";
import { initTripsHome, loadDemoTripFromURL } from "./trips-home.js";
import { addTripChartLayers, drawingLegLayers, gapPinLayers, vertexPaint, initTripChart, TRIP_POINT_LAYERS, tripChartDebug } from "./map-trip-style.js";
import { handleMapClickForStop, isStopToolActive, openStopMenu } from "./stops.js";
import * as lineModel from "./line-model.js";
import * as routeEdit from "./route-edit.js";
import * as lineEdit from "./line-edit.js";
import * as stops from "./stops.js";
const { isLineTrip } = lineModel;

// ---------------------------------------------------------------------------
// PMTiles protocol registration
// ---------------------------------------------------------------------------
// Register the pmtiles:// protocol so MapLibre can fetch tile ranges
// directly from a single .pmtiles file on R2.

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// ---------------------------------------------------------------------------
// Build MapLibre style for a region
// ---------------------------------------------------------------------------
// We inline the style here (rather than fetching style.json) so the viewer
// works with zero extra requests. The layer definitions mirror what
// tile_generator.py generates — see outhere/utah_maps/output/style.json.
// The tile source URL comes from the active region (catalog-driven); the
// hardcoded TILE_URL from config.js is the last-resort fallback.

export function buildStyle(region) {
  const source = "outhere";
  const pmtilesUrl = `pmtiles://${region?.url || TILE_URL}`;

  return {
    version: 8,
    name: region?.name ? `${region.name} Hiking` : "OutHere Hiking",
    // Our own glyphs on R2 (same convention as the pipeline style and the
    // phone). Only "Open Sans Regular" is hosted, so every text layer must
    // pin "text-font" to it: MapLibre's default stack would ask for a
    // combined "Open Sans Regular,Arial Unicode MS Regular" that isn't there.
    // No sprite: every icon is drawn at runtime with map.addImage.
    glyphs: "https://tiles.booot.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      [source]: {
        type: "vector",
        url: pmtilesUrl,
        attribution: MAP_CONFIG.attribution,
      },
    },
    layers: [
      // Background
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#f8f4f0" },
      },
      // Protected areas — translucent green fill
      {
        id: "protected-areas-fill",
        type: "fill",
        source,
        "source-layer": "protected_areas",
        paint: {
          "fill-color": "#d4e8d4",
          "fill-opacity": 0.3,
        },
      },
      // Water — polygon fills (lakes, reservoirs)
      {
        id: "water-fill",
        type: "fill",
        source,
        "source-layer": "water",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#a5bfdd" },
      },
      // Water — line features (rivers, streams)
      {
        id: "waterways",
        type: "line",
        source,
        "source-layer": "water",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": "#a5bfdd",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 2],
        },
      },
      // Roads — white lines for context
      {
        id: "roads",
        type: "line",
        source,
        "source-layer": "roads",
        paint: {
          "line-color": "#ffffff",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 13, 3],
        },
      },
      // Contour lines — minor (thin, subtle)
      {
        id: "contours-minor",
        type: "line",
        source,
        "source-layer": "contours",
        filter: ["==", ["get", "contour_type"], "minor"],
        minzoom: 12,
        paint: {
          "line-color": "#c4a882",
          "line-width": 0.5,
          "line-opacity": 0.4,
        },
      },
      // Contour lines — major (bolder)
      {
        id: "contours-major",
        type: "line",
        source,
        "source-layer": "contours",
        filter: ["==", ["get", "contour_type"], "major"],
        minzoom: 11,
        paint: {
          "line-color": "#b09070",
          "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 14, 1.5],
          "line-opacity": 0.6,
        },
      },
      // Contour labels — elevation in feet on major contours
      {
        id: "contour-labels",
        type: "symbol",
        source,
        "source-layer": "contours",
        filter: ["==", ["get", "contour_type"], "major"],
        minzoom: 13,
        layout: {
          "symbol-placement": "line",
          "text-field": ["concat", ["to-string", ["get", "elevation_ft"]], "ft"],
          "text-font": MAP_FONT,
          "text-size": 9,
          "text-max-angle": 25,
          "text-padding": 50,
        },
        paint: {
          "text-color": "#8a7060",
          "text-halo-color": "#f8f4f0",
          "text-halo-width": 1,
        },
      },
      // Trails — colored by difficulty, dashed
      {
        id: "trails",
        type: "line",
        source,
        "source-layer": "trails",
        paint: {
          "line-color": [
            "match",
            ["get", "difficulty"],
            "easy", "#2d7a2d",
            "moderate", "#d97706",
            "hard", "#dc2626",
            "#666666",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 3],
          "line-dasharray": [2, 1],
        },
      },
      // POIs — colored circles by category
      {
        id: "pois",
        type: "circle",
        source,
        "source-layer": "pois",
        paint: {
          "circle-radius": [
            "match",
            ["get", "priority"],
            "high", 6,
            "medium", 4,
            "low", 3,
            3,
          ],
          "circle-color": [
            "match",
            ["get", "poi_category"],
            "trailhead", "#8b4513",
            "summit", "#dc2626",
            "water", "#3b82f6",
            "accommodation", "#7c3aed",
            "viewpoint", "#eab308",
            "natural", "#d97706",
            "infrastructure", "#64748b",
            "#64748b",
          ],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#ffffff",
        },
      },
      // POI labels — name text below the dot
      {
        id: "poi-labels",
        type: "symbol",
        source,
        "source-layer": "pois",
        minzoom: 12,
        layout: {
          "text-field": ["get", "name"],
          "text-font": MAP_FONT,
          "text-size": 11,
          "text-offset": [0, 1.2],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#1f2937",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Map initialization
// ---------------------------------------------------------------------------

// Boot with the persisted active region (or the Utah fallback) — the full
// catalog is fetched asynchronously by initRegionPicker() after load.
const initialRegion = getInitialRegion();

export const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(initialRegion),
  center: initialRegion.center || MAP_CONFIG.center,
  zoom: initialRegion.zoom ?? MAP_CONFIG.zoom,
  minZoom: MAP_CONFIG.minZoom,
  maxZoom: MAP_CONFIG.maxZoom,
  maxBounds: regionMaxBounds(initialRegion),
});

// Debug handle: module scope is unreachable from devtools, so expose the two
// core objects for console debugging. Not part of the public API.
window.__outhere = { map, TripManager, applyRegion, findRegionById, routing: routingDebug, tripChart: tripChartDebug, lineModel, lineEdit, routeEdit, stops, elevation: elevationDebug };

// Navigation controls (zoom +/-, compass)
map.addControl(new maplibregl.NavigationControl(), "top-left");

// Scale bar (metric + imperial)
map.addControl(
  new maplibregl.ScaleControl({ maxWidth: 150, unit: "imperial" }),
  "bottom-left"
);

// Geolocation button
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  }),
  "top-left"
);

// Helper: create a single-button MapLibre custom control
function makeMapControl(id, label, svgHtml) {
  return {
    onAdd() {
      this._el = document.createElement("div");
      this._el.className = "maplibregl-ctrl maplibregl-ctrl-group";
      this._el.innerHTML = `<button id="${id}" type="button" title="${label}" aria-label="${label}">${svgHtml}</button>`;
      return this._el;
    },
    onRemove() { this._el?.parentNode?.removeChild(this._el); },
  };
}

const planIconSvg = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="5" cy="6" r="2.2" fill="currentColor"/>
  <circle cx="15" cy="14" r="2.2" fill="currentColor"/>
  <path d="M5 8.2 C4.5 12.5 15.5 7.5 15 11.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>
</svg>`;

const layersIconSvg = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <polygon points="10,3 18,7.5 10,12 2,7.5"/>
  <polyline points="2,11 10,15.5 18,11"/>
</svg>`;

const homeIconSvg = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 3.5 h10 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 h-10 z"/>
  <line x1="4" y1="3.5" x2="4" y2="16.5"/>
  <line x1="7.5" y1="7" x2="12.5" y2="7"/>
  <line x1="7.5" y1="10" x2="12.5" y2="10"/>
</svg>`;

map.addControl(makeMapControl("homeBtn", "My Trips", homeIconSvg), "top-left");
map.addControl(makeMapControl("planBtn", "Trip Planning", planIconSvg), "top-left");
map.addControl(makeMapControl("layersBtn", "Map Layers", layersIconSvg), "top-left");

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("errorBanner");

// ---------------------------------------------------------------------------
// Runtime (non-tile) sources + layers — trip rendering & drawing previews
// ---------------------------------------------------------------------------
// These live outside buildStyle(), so any map.setStyle() call (region switch)
// wipes them. addTripLayers() is idempotent and is re-run after every style
// swap via restoreRuntimeLayers().

function addTripLayers() {
  if (map.getSource("trip")) return; // already present (initial load path)

  // -------------------------------------------------------------------
  // Trip planning GeoJSON source + layers (drawn in map-trip-style.js:
  // inked route, pencil day bands, glyphs, day numerals). `fid` ids let
  // the active day highlight use feature-state.
  // -------------------------------------------------------------------
  map.addSource("trip", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    promoteId: "fid",
  });
  addTripChartLayers();

  // -------------------------------------------------------------------
  // Route drawing: placed legs + vertices (per click) and the live
  // preview leg + cursor marker (per frame) in separate sources, so a
  // long route isn't re-tiled on every mouse move.
  // -------------------------------------------------------------------
  map.addSource("route-drawing", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("route-preview", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  const isLine = ["==", ["geometry-type"], "LineString"];
  const tok = resolveTokenColors();
  // "Redraw from here": the stretch the change would remove, faded under a
  // paper wash with a rust dash, so you see it before you commit.
  map.addSource("route-ghost", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "route-ghost-fade", type: "line", source: "route-ghost", filter: ["==", ["get", "role"], "remove"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": tok.surfaceRaised, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 10, 13, 20, 17, 32], "line-opacity": 0.82 },
  });
  map.addLayer({
    id: "route-ghost-remove", type: "line", source: "route-ghost", filter: ["==", ["get", "role"], "remove"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": tok.accent, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.4, 13, 2.2, 17, 3], "line-dasharray": [1.2, 1.8], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "route-ghost-rejoin", type: "circle", source: "route-ghost", filter: ["==", ["get", "role"], "rejoin"],
    paint: { "circle-radius": 6, "circle-color": tok.surfaceRaised, "circle-stroke-width": 2, "circle-stroke-color": tok.ink },
  });
  for (const layer of drawingLegLayers("route-preview", "route-preview", isLine, { preview: true })) map.addLayer(layer);
  for (const layer of drawingLegLayers("route-drawing", "route-drawing", isLine)) map.addLayer(layer);
  for (const layer of gapPinLayers("route-drawing-gaps", "route-drawing", ["==", ["get", "gap"], true])) map.addLayer(layer);

  const paint = vertexPaint();
  map.addLayer({
    id: "route-drawing-vertices",
    type: "circle",
    source: "route-drawing",
    filter: ["==", ["get", "vertex"], true],
    paint: paint.vertices,
  });

  // Cursor marker: ink dot on a trail, hollow ring where the click won't snap.
  map.addLayer({
    id: "route-preview-cursor",
    type: "circle",
    source: "route-preview",
    filter: ["==", ["get", "cursor"], true],
    paint: paint.cursor,
  });

  addRoutedAreasLayers(resolveTokenColors());
}

/**
 * "Routed areas": catalog regions that publish a routing graph, outlined and
 * lightly tinted with --accent, named in small type. Hidden until the Layers
 * panel switches it on. Added under the trip layers so it never covers a route.
 */
function addRoutedAreasLayers(C) {
  if (map.getSource("routed-areas")) return;
  map.addSource("routed-areas", { type: "geojson", data: routedAreasData() });
  const hidden = { visibility: "none" };
  const before = "trip-chart-casing";
  map.addLayer({
    id: "routed-areas-fill", type: "fill", source: "routed-areas", layout: hidden,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": C.accent, "fill-opacity": 0.07 },
  }, before);
  map.addLayer({
    id: "routed-areas-line", type: "line", source: "routed-areas",
    filter: ["==", ["geometry-type"], "Polygon"],
    layout: { ...hidden, "line-join": "round" },
    paint: { "line-color": C.accent, "line-width": 1.5, "line-opacity": 0.7, "line-dasharray": [4, 2] },
  }, before);
  map.addLayer({
    id: "routed-areas-label", type: "symbol", source: "routed-areas",
    filter: ["==", ["geometry-type"], "Point"],
    layout: { ...hidden, "text-field": ["get", "name"], "text-font": MAP_FONT, "text-size": 12, "text-anchor": "top-left", "text-offset": [0.4, 0.4], "text-allow-overlap": true },
    paint: { "text-color": C.accent, "text-halo-color": C.surfaceRaised, "text-halo-width": 1.5 },
  }, before);
}

function routedAreasData() {
  const features = [];
  for (const r of getCatalogRegions()) {
    if (!r.bounds || !graphInfoForRegion(r)) continue;
    const { west: w, south: s, east: e, north: n } = r.bounds;
    features.push(
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: { name: r.name } },
      // Label hangs from the top-left corner (Maze and Needles overlap, so not the center).
      { type: "Feature", geometry: { type: "Point", coordinates: [w, n] }, properties: { name: r.name } },
    );
  }
  return { type: "FeatureCollection", features };
}

document.addEventListener("outhere:catalog", () => map.getSource("routed-areas")?.setData(routedAreasData()));

/** Resolve the design tokens the map needs into concrete colors. */
function resolveTokenColors() {
  const cs = getComputedStyle(document.documentElement);
  const t = (name) => cs.getPropertyValue(name).trim();
  return {
    accent: t("--accent"),
    surfaceRaised: t("--surface-raised"),
    ink: t("--text"),
  };
}

/**
 * Re-establish everything a style swap (map.setStyle) destroys: the trip +
 * drawing sources/layers, the current trip's data, the user's layer style
 * overrides, and the layer panel's visibility toggles.
 * Called by region-picker.js after each region switch.
 */
export function restoreRuntimeLayers() {
  addTripLayers();
  TripManager.render();          // repopulate the "trip" source data
  LayerStyleManager.applyAll();  // re-apply saved paint overrides
  applyLayerToggleState();       // re-apply layer panel checkboxes
}

map.on("load", () => {
  loadingEl.classList.add("hidden");

  initTripChart();
  addTripLayers();

  // -------------------------------------------------------------------
  // Initialize trip planning tools
  // -------------------------------------------------------------------
  initTripPanel();

  // -------------------------------------------------------------------
  // Apply saved layer style overrides
  // -------------------------------------------------------------------
  LayerStyleManager.load();
  LayerStyleManager.applyAll();

  // -------------------------------------------------------------------
  // Region picker (async catalog fetch) + trips home view
  // -------------------------------------------------------------------
  const regionsReady = initRegionPicker();
  initTripsHome();
  loadDemoTripFromURL(regionsReady); // dev only: ?demo=maze

  // -------------------------------------------------------------------
  // Click handlers for route drawing + trip features
  // -------------------------------------------------------------------
  map.on("click", (e) => {
    if (isDeleteMode) {
      handleDeleteClick(e);
      return;
    }
    if (!isDrawingRoute && handleMapClickForStop(e)) return;
    if (isDrawingRoute) {
      handleMapClickForRoute(e);
    }
  });

  map.on("dblclick", (e) => {
    if (isDrawingRoute) {
      e.preventDefault();
      handleMapDblClickForRoute(e);
    }
  });

  // Gap pins on saved routes explain the straight leg (and link to the OSM fix).
  map.on("click", "trip-gap-pins", (e) => {
    if (isDrawingRoute || isDeleteMode) return;
    const f = e.features[0];
    showGapCard({ gap: f.geometry.coordinates, reason: f.properties.reason, length_m: f.properties.length_m });
  });
  map.on("mouseenter", "trip-gap-pins", () => { if (!isDrawingRoute && !isDeleteMode) map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "trip-gap-pins", () => { if (!isDrawingRoute && !isDeleteMode) map.getCanvas().style.cursor = ""; });

  // Trip feature click — show popup (skip during route drawing)
  for (const layerId of TRIP_POINT_LAYERS) {
    map.on("click", layerId, (e) => {
      if (isDrawingRoute || isDeleteMode || isStopToolActive()) return;
      // 1.2 trips: a stop opens its menu (name, nights, water, pass, day hike).
      if (isLineTrip(TripManager.currentTrip) && e.features?.[0]?.properties?._id) {
        e.originalEvent.stopPropagation();
        openStopMenu(e.features[0].properties._id);
        return;
      }
      showTripFeaturePopup(e);
    });
    // Don't clobber the crosshair cursor while drawing or in delete mode
    map.on("mouseenter", layerId, () => {
      if (isDrawingRoute || isDeleteMode) return;
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      if (isDrawingRoute || isDeleteMode) return;
      map.getCanvas().style.cursor = "";
    });
  }
});

map.on("error", (e) => {
  // Surface tile loading errors to help debug R2 URL issues
  const msg = e.error ? e.error.message : String(e.message || e);
  console.error("Map error:", msg);

  // Show a user-facing banner for source/tile errors
  if (msg && msg.includes("pmtiles")) {
    errorEl.textContent =
      "Could not load map tiles. Check that TILE_URL in config.js points to your R2 deployment.";
    errorEl.classList.add("visible");
  }
});

// ---------------------------------------------------------------------------
// Layer controls
// ---------------------------------------------------------------------------

/** Toggle visibility of all MapLibre layers in a group. */
function setLayerGroupVisibility(group, visible) {
  const value = visible ? "visible" : "none";
  for (const layerId of group.layers) {
    // Only set if the layer exists in the style (contours may not be
    // present if contour_generator.py hasn't been run for this region).
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", value);
    }
  }
}

// group.id → checkbox element, so visibility can be re-applied after a
// region switch rebuilds the style with default visibility.
const layerGroupCheckboxes = new Map();

/** Re-apply the layer panel's checkbox state to the (rebuilt) style. */
function applyLayerToggleState() {
  for (const group of LAYER_GROUPS) {
    const checkbox = layerGroupCheckboxes.get(group.id);
    if (checkbox && !checkbox.checked) {
      setLayerGroupVisibility(group, false);
    } else if (checkbox && group.id === "routed-areas") {
      setLayerGroupVisibility(group, true); // runtime layers start hidden
    }
  }
}

/** Build the layer control panel from LAYER_GROUPS config. */
function buildLayerControls() {
  const container = document.getElementById("layerList");

  LAYER_GROUPS.forEach((group, i) => {
    // Checkbox row
    const label = document.createElement("label");
    label.className = "layer-toggle";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = group.defaultVisible;
    checkbox.addEventListener("change", () => {
      setLayerGroupVisibility(group, checkbox.checked);
    });
    layerGroupCheckboxes.set(group.id, checkbox);

    const nameSpan = document.createElement("span");
    nameSpan.className = "layer-name";
    nameSpan.textContent = group.label;

    label.appendChild(checkbox);
    label.appendChild(nameSpan);

    // Style customize button (gear icon)
    if (group.styleLayers && group.styleLayers.length > 0) {
      const gearBtn = document.createElement("button");
      gearBtn.type = "button";
      gearBtn.className = "style-expand-btn";
      gearBtn.innerHTML = "&#9881;";
      gearBtn.title = "Customize style";
      gearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleStyleControls(group.id);
      });
      label.appendChild(gearBtn);
    }

    container.appendChild(label);

    // Legend swatches (if any)
    if (group.legend.length > 0) {
      const legendDiv = document.createElement("div");
      legendDiv.className = "legend";

      group.legend.forEach((item) => {
        const el = document.createElement("span");
        el.className = "legend-item";
        el.innerHTML =
          `<span class="legend-swatch" style="background:${item.color}"></span>` +
          item.label;
        legendDiv.appendChild(el);
      });

      container.appendChild(legendDiv);
    }

    // Style controls (expandable, hidden by default)
    if (group.styleLayers && group.styleLayers.length > 0) {
      const styleDiv = document.createElement("div");
      styleDiv.className = "style-controls";
      styleDiv.id = `style-controls-${group.id}`;
      styleDiv.style.display = "none";
      buildStyleControls(group, styleDiv);
      container.appendChild(styleDiv);
    }

    // Divider between groups (except after last)
    if (i < LAYER_GROUPS.length - 1) {
      const hr = document.createElement("div");
      hr.className = "layer-divider";
      container.appendChild(hr);
    }
  });
}

// Build controls once the DOM is ready
buildLayerControls();

// Toggle the layer panel open/closed
const layersBtn = document.getElementById("layersBtn");
const layerPanel = document.getElementById("layerPanel");

layersBtn.addEventListener("click", () => {
  const isOpen = layerPanel.classList.toggle("open");
  layersBtn.classList.toggle("active", isOpen);
});

// Close panel when clicking on the map
map.on("click", () => {
  layerPanel.classList.remove("open");
  layersBtn.classList.remove("active");
});

// ---------------------------------------------------------------------------
// POI click interaction — show a popup with name and details
// ---------------------------------------------------------------------------

map.on("click", "pois", (e) => {
  if (isDrawingRoute) return;
  if (!e.features || e.features.length === 0) return;

  const f = e.features[0];
  const props = f.properties;
  const coords = f.geometry.coordinates.slice();

  // Build popup content
  let html = `<strong>${escapeHTML(props.name || "Unnamed")}</strong>`;
  if (props.poi_category) {
    html += `<br><span class="popup-meta">${escapeHTML(props.poi_category)}</span>`;
  }
  if (props.elevation) {
    const ft = Math.round(props.elevation * 3.28084);
    html += `<br><span class="popup-data">${ft} ft</span>`;
  }

  new maplibregl.Popup({ offset: 8, maxWidth: "240px" })
    .setLngLat(coords)
    .setHTML(html)
    .addTo(map);
});

// Pointer cursor on hoverable features (not while drawing / delete mode,
// which own the crosshair cursor)
map.on("mouseenter", "pois", () => {
  if (isDrawingRoute || isDeleteMode) return;
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "pois", () => {
  if (isDrawingRoute || isDeleteMode) return;
  map.getCanvas().style.cursor = "";
});

// ---------------------------------------------------------------------------
// Trip feature popup
// ---------------------------------------------------------------------------

function showTripFeaturePopup(e) {
  if (!e.features || e.features.length === 0) return;
  e.originalEvent.stopPropagation();

  const f = e.features[0];
  const props = f.properties;
  const coords = f.geometry.coordinates.slice();
  const type = getDisplayType(props);
  const typeLabel = POINT_TYPE_LABELS[type] || type;

  let html = `<strong>${escapeHTML(props.name || typeLabel)}</strong>`;
  if (props.date) {
    html += `<br><span class="popup-data">${escapeHTML(props.date)}</span>`;
  }
  if (type === "camp") {
    let detail = "";
    if (props.water_nearby) detail += "Water nearby";
    if (detail) html += `<br><span class="popup-meta">${detail}</span>`;
  } else if (type === "waypoint" && props.subtype) {
    html += `<br><span class="popup-meta">${escapeHTML(props.subtype)}</span>`;
  }
  if (props.notes) {
    html += `<br><span class="popup-meta">${escapeHTML(props.notes)}</span>`;
  }

  new maplibregl.Popup({ offset: 12, maxWidth: "260px" })
    .setLngLat(coords)
    .setHTML(html)
    .addTo(map);
}

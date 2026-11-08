/**
 * OutHere Map Viewer — Application Logic
 *
 * Initializes MapLibre GL JS with PMTiles protocol, builds the style
 * from config, and wires up layer toggle controls.
 *
 * CDN globals (classic scripts in index.html): maplibregl, pmtiles, turf.
 */

import { TILE_URL, MAP_CONFIG, LAYER_GROUPS } from "./config.js";
import { LayerStyleManager, buildStyleControls, toggleStyleControls } from "./layer-styles.js";
import {
  isDrawingRoute,
  isDeleteMode,
  handleDeleteClick,
  handleMapClickForRoute,
  handleMapDblClickForRoute,
  showGapCard,
  routingDebug,
} from "./planning.js";
import { initTripPanel, TripManager, POINT_TYPE_LABELS, escapeHTML, getDisplayType } from "./trip-panel.js";
import { getInitialRegion, regionMaxBounds, initRegionPicker, applyRegion, findRegionById } from "./region-picker.js";
import { initTripsHome } from "./trips-home.js";

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
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sprite: "https://demotiles.maplibre.org/styles/osm-bright-gl-style/sprite",
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
window.__outhere = { map, TripManager, applyRegion, findRegionById, routing: routingDebug };

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
  // Trip planning GeoJSON source + layers
  // -------------------------------------------------------------------
  map.addSource("trip", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Colors come from design/tokens.css: MapLibre paint can't read CSS
  // variables, so resolve them once here (re-run after every style swap).
  const C = resolveTokenColors();

  // Legacy routes (no per-leg `segments`, pre-schema-1.1): one line each.
  map.addLayer({
    id: "trip-routes",
    type: "line",
    source: "trip",
    filter: ["all", ["==", ["get", "type"], "route"], ["!", ["has", "segments"]]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.route, "line-width": 3 },
  });

  map.addLayer({
    id: "trip-dayhike-spurs",
    type: "line",
    source: "trip",
    filter: ["all", ["==", ["get", "type"], "dayhike_spur"], ["!", ["has", "segments"]]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.dayhike, "line-width": 2.5 },
  });

  // Routed routes/spurs: one feature per leg (buildRoutingOverlay), styled
  // by how the leg was made.
  for (const layer of legLayers("trip-legs", "trip", ["==", ["get", "type"], "route_leg"], C)) map.addLayer(layer);
  for (const layer of gapPinLayers("trip-gap-pins", "trip", ["==", ["get", "type"], "route_gap"], C)) map.addLayer(layer);

  map.addLayer({
    id: "trip-camps",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "camp"],
    paint: {
      "circle-radius": 9,
      "circle-color": C.camp,
      "circle-stroke-width": 2.5,
      "circle-stroke-color": C.surfaceRaised,
    },
  });

  map.addLayer({
    id: "trip-dayhikes",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "dayhike"],
    paint: {
      "circle-radius": 7,
      "circle-color": C.dayhike,
      "circle-stroke-width": 2,
      "circle-stroke-color": C.surfaceRaised,
    },
  });

  map.addLayer({
    id: "trip-rest",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "rest"],
    paint: {
      "circle-radius": 7,
      "circle-color": C.rest,
      "circle-stroke-width": 2,
      "circle-stroke-color": C.surfaceRaised,
    },
  });

  // Legacy waypoints — colored by subtype (backward compat)
  map.addLayer({
    id: "trip-waypoints",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "waypoint"],
    paint: {
      "circle-radius": 7,
      "circle-color": [
        "match",
        ["get", "subtype"],
        "water", "#3b82f6",
        "hazard", "#ef4444",
        "scenic", "#eab308",
        "resupply", "#8b5cf6",
        "#6b7280",
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });

  // Trip feature labels
  map.addLayer({
    id: "trip-labels",
    type: "symbol",
    source: "trip",
    filter: ["all", ["has", "name"], ["!=", ["get", "name"], ""]],
    layout: {
      "text-field": ["get", "name"],
      "text-size": 12,
      "text-offset": [0, 1.5],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#1f2937",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });

  // Camp night number labels
  map.addLayer({
    id: "trip-camp-numbers",
    type: "symbol",
    source: "trip",
    filter: ["==", ["get", "type"], "camp"],
    layout: {
      "text-field": ["to-string", ["get", "night_number"]],
      "text-size": 11,
      "text-font": ["Open Sans Bold"],
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#ffffff",
    },
  });

  // -------------------------------------------------------------------
  // Route drawing: placed legs + vertices (per click) and the live
  // preview leg + cursor marker (per frame) in separate sources, so a
  // long route isn't re-tiled on every mouse move.
  // -------------------------------------------------------------------
  map.addSource("route-drawing", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addSource("route-preview", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

  const isLine = ["==", ["geometry-type"], "LineString"];
  for (const layer of legLayers("route-preview", "route-preview", isLine, C, 0.6)) map.addLayer(layer);
  for (const layer of legLayers("route-drawing", "route-drawing", isLine, C)) map.addLayer(layer);
  for (const layer of gapPinLayers("route-drawing-gaps", "route-drawing", ["==", ["get", "gap"], true], C)) map.addLayer(layer);

  map.addLayer({
    id: "route-drawing-vertices",
    type: "circle",
    source: "route-drawing",
    filter: ["==", ["get", "vertex"], true],
    paint: {
      "circle-radius": [
        "match", ["get", "point_type"],
        "camp", 8,
        "dayhike", 7,
        "rest", 7,
        5,
      ],
      "circle-color": [
        "match", ["get", "point_type"],
        "camp", C.camp,
        "dayhike", C.dayhike,
        "rest", C.rest,
        C.route,
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": C.surfaceRaised,
    },
  });

  // Cursor marker: filled on a trail, hollow where the click won't snap.
  map.addLayer({
    id: "route-preview-cursor",
    type: "circle",
    source: "route-preview",
    filter: ["==", ["get", "cursor"], true],
    paint: {
      "circle-radius": 6,
      "circle-color": ["case", ["get", "snapped"], C.route, C.surfaceRaised],
      "circle-stroke-width": 2,
      "circle-stroke-color": ["case", ["get", "snapped"], C.surfaceRaised, C.textSecondary],
      "circle-opacity": 0.9,
    },
  });
}

/** Resolve the design tokens the map needs into concrete colors. */
function resolveTokenColors() {
  const cs = getComputedStyle(document.documentElement);
  const t = (name) => cs.getPropertyValue(name).trim();
  return {
    route: t("--type-route"),
    camp: t("--type-camp"),
    dayhike: t("--type-dayhike"),
    rest: t("--type-rest"),
    accent: t("--accent"),
    surfaceRaised: t("--surface-raised"),
    textSecondary: t("--text-secondary"),
  };
}

/**
 * Three line layers for route legs (SNAPPING_DESIGN.md §2.6), keyed on the
 * feature's `leg_mode` and `kind` ("main" | "spur"):
 *   trail (and any future mode) solid --type-route / --type-dayhike, 3 px,
 *                               on a 6 px --surface-raised casing
 *   manual (Shift)              same color, dash [2, 2]
 *   straight (no route found)   --accent, dash [1, 1.5]
 * MapLibre 4 can't drive line-dasharray from data, hence one layer per mode.
 */
function legLayers(prefix, source, baseFilter, C, opacity = 1) {
  const color = ["case", ["==", ["get", "kind"], "spur"], C.dayhike, C.route];
  const mode = ["get", "leg_mode"];
  const notStraightOrManual = ["!", ["in", mode, ["literal", ["manual", "straight"]]]];
  return [
    // Paper casing so the route reads above the basemap's own trail lines.
    {
      id: `${prefix}-casing`, type: "line", source,
      filter: ["all", baseFilter, notStraightOrManual],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.surfaceRaised, "line-width": 6, "line-opacity": 0.85 * opacity },
    },
    {
      id: `${prefix}-trail`, type: "line", source,
      filter: ["all", baseFilter, notStraightOrManual],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": 3, "line-opacity": opacity },
    },
    {
      id: `${prefix}-manual`, type: "line", source,
      filter: ["all", baseFilter, ["==", mode, "manual"]],
      layout: { "line-join": "round" },
      paint: { "line-color": color, "line-width": 3, "line-dasharray": [2, 2], "line-opacity": opacity },
    },
    {
      id: `${prefix}-straight`, type: "line", source,
      filter: ["all", baseFilter, ["==", mode, "straight"]],
      layout: { "line-join": "round" },
      paint: { "line-color": C.accent, "line-width": 3, "line-dasharray": [1, 1.5], "line-opacity": opacity },
    },
  ];
}

/**
 * Gap pin where a straight leg's gap is (click it for the explanation card):
 * a paper ring with a rust rim and rust center, so it can't be mistaken for
 * the basemap's filled POI dots.
 */
function gapPinLayers(id, source, filter, C) {
  return [
    {
      id, type: "circle", source, filter,
      paint: {
        "circle-radius": 7,
        "circle-color": C.surfaceRaised,
        "circle-stroke-width": 2.5,
        "circle-stroke-color": C.accent,
      },
    },
    {
      id: `${id}-dot`, type: "circle", source, filter,
      paint: { "circle-radius": 2.5, "circle-color": C.accent },
    },
  ];
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
  initRegionPicker();
  initTripsHome();

  // -------------------------------------------------------------------
  // Click handlers for route drawing + trip features
  // -------------------------------------------------------------------
  map.on("click", (e) => {
    if (isDeleteMode) {
      handleDeleteClick(e);
      return;
    }
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
  for (const layerId of ["trip-camps", "trip-dayhikes", "trip-rest", "trip-waypoints"]) {
    map.on("click", layerId, (e) => {
      if (isDrawingRoute) return;
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

/**
 * OutHere Map Viewer — Application Logic
 *
 * Initializes MapLibre GL JS with PMTiles protocol, builds the style
 * from config, and wires up layer toggle controls.
 *
 * Dependencies (loaded before this script):
 *   - maplibregl (global)
 *   - pmtiles    (global, via pmtiles.js)
 *   - config.js  (TILE_URL, MAP_CONFIG, LAYER_GROUPS)
 */

// ---------------------------------------------------------------------------
// PMTiles protocol registration
// ---------------------------------------------------------------------------
// Register the pmtiles:// protocol so MapLibre can fetch tile ranges
// directly from a single .pmtiles file on R2.

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// ---------------------------------------------------------------------------
// Build MapLibre style from the existing Utah style.json
// ---------------------------------------------------------------------------
// We inline the style here (rather than fetching style.json) so the viewer
// works with zero extra requests. The layer definitions mirror what
// tile_generator.py generates — see outhere/utah_maps/output/style.json.

function buildStyle() {
  const source = "utah";
  const pmtilesUrl = `pmtiles://${TILE_URL}`;

  return {
    version: 8,
    name: "Utah Hiking",
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

const map = new maplibregl.Map({
  container: "map",
  style: buildStyle(),
  center: MAP_CONFIG.center,
  zoom: MAP_CONFIG.zoom,
  minZoom: MAP_CONFIG.minZoom,
  maxZoom: MAP_CONFIG.maxZoom,
  maxBounds: MAP_CONFIG.maxBounds,
});

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

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

const loadingEl = document.getElementById("loading");
const errorEl = document.getElementById("errorBanner");

map.on("load", () => {
  loadingEl.classList.add("hidden");

  // -------------------------------------------------------------------
  // Trip planning GeoJSON source + layers
  // -------------------------------------------------------------------
  map.addSource("trip", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  // Trip routes — bold orange dashed line
  map.addLayer({
    id: "trip-routes",
    type: "line",
    source: "trip",
    filter: ["==", ["get", "type"], "route"],
    paint: {
      "line-color": "#e85d04",
      "line-width": 3.5,
      "line-dasharray": [3, 2],
    },
  });

  // Trip camps — green circles
  map.addLayer({
    id: "trip-camps",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "camp"],
    paint: {
      "circle-radius": 9,
      "circle-color": "#2d6a4f",
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#fff",
    },
  });

  // Trip dayhike points — amber circles
  map.addLayer({
    id: "trip-dayhikes",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "dayhike"],
    paint: {
      "circle-radius": 7,
      "circle-color": "#d97706",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });

  // Trip rest points — purple circles
  map.addLayer({
    id: "trip-rest",
    type: "circle",
    source: "trip",
    filter: ["==", ["get", "type"], "rest"],
    paint: {
      "circle-radius": 7,
      "circle-color": "#7c3aed",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
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
  // Route drawing in-progress visualization (for custom snap-to-trail)
  // -------------------------------------------------------------------
  map.addSource("route-drawing", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "route-drawing-line",
    type: "line",
    source: "route-drawing",
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": "#e85d04",
      "line-width": 3,
      "line-dasharray": [2, 2],
      "line-opacity": 0.7,
    },
  });

  map.addLayer({
    id: "route-drawing-vertices",
    type: "circle",
    source: "route-drawing",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": [
        "case",
        ["==", ["get", "point_type"], "camp"], 8,
        ["==", ["get", "point_type"], "dayhike"], 7,
        ["==", ["get", "point_type"], "rest"], 7,
        6,
      ],
      "circle-color": [
        "case",
        ["==", ["get", "point_type"], "camp"], "#2d6a4f",
        ["==", ["get", "point_type"], "dayhike"], "#d97706",
        ["==", ["get", "point_type"], "rest"], "#7c3aed",
        ["get", "snapped"], "#3b82f6",
        "#e85d04",
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });

  // Snap preview — ghost marker showing where next click will land
  map.addSource("snap-preview", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "snap-preview-marker",
    type: "circle",
    source: "snap-preview",
    paint: {
      "circle-radius": 8,
      "circle-color": ["case", ["get", "snapped"], "#3b82f6", "#e85d04"],
      "circle-opacity": 0.6,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
      "circle-stroke-opacity": 0.8,
    },
  });

  // -------------------------------------------------------------------
  // Initialize trip planning tools
  // -------------------------------------------------------------------
  initTripPanel();

  // -------------------------------------------------------------------
  // Click handlers for route drawing + trip features
  // -------------------------------------------------------------------
  map.on("click", (e) => {
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

  // Trip feature click — show popup (skip during route drawing)
  for (const layerId of ["trip-camps", "trip-dayhikes", "trip-rest", "trip-waypoints"]) {
    map.on("click", layerId, (e) => {
      if (isDrawingRoute) return;
      showTripFeaturePopup(e);
    });
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
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

    const nameSpan = document.createElement("span");
    nameSpan.className = "layer-name";
    nameSpan.textContent = group.label;

    label.appendChild(checkbox);
    label.appendChild(nameSpan);
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
  let html = `<strong>${props.name || "Unnamed"}</strong>`;
  if (props.poi_category) {
    html += `<br><span style="color:#6b7280;font-size:0.85em">${props.poi_category}</span>`;
  }
  if (props.elevation) {
    const ft = Math.round(props.elevation * 3.28084);
    html += `<br><span style="color:#6b7280;font-size:0.85em">${ft} ft</span>`;
  }

  new maplibregl.Popup({ offset: 8, maxWidth: "240px" })
    .setLngLat(coords)
    .setHTML(html)
    .addTo(map);
});

// Pointer cursor on hoverable features
map.on("mouseenter", "pois", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "pois", () => {
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
  const type = props.point_type || props.type;
  const typeLabel = (typeof POINT_TYPE_LABELS !== "undefined" && POINT_TYPE_LABELS[type]) || type;

  let html = `<strong>${props.name || typeLabel}</strong>`;
  if (props.date) {
    html += `<br><span style="color:#6b7280;font-size:0.85em">${props.date}</span>`;
  }
  if (type === "camp") {
    let detail = "";
    if (props.water_nearby) detail += "Water nearby";
    if (detail) html += `<br><span style="color:#6b7280;font-size:0.85em">${detail}</span>`;
  } else if (type === "waypoint" && props.subtype) {
    html += `<br><span style="color:#6b7280;font-size:0.85em">${props.subtype}</span>`;
  }
  if (props.notes) {
    html += `<br><span style="color:#6b7280;font-size:0.8em">${props.notes}</span>`;
  }

  new maplibregl.Popup({ offset: 12, maxWidth: "260px" })
    .setLngLat(coords)
    .setHTML(html)
    .addTo(map);
}

/**
 * OutHere Trip Planning — Drawing Tools
 *
 * Route drawing uses a custom click-based system with trail snapping
 * (via turf.js nearestPointOnLine). A live preview marker follows the
 * cursor and snaps to trails in real time. Camp/waypoint placement
 * uses terra-draw's PointMode.
 *
 * Dependencies (loaded before this script):
 *   - terraDraw          (global, via terra-draw.umd.js)
 *   - terraDrawMaplibreGlAdapter (global, via terra-draw-maplibre-gl-adapter.umd.js)
 *   - turf               (global, via turf.min.js)
 *   - map                (global, from app.js)
 */

let draw = null;
let pendingFeatureType = null; // "route" | "camp" | "waypoint"
let pendingWaypointSubtype = "scenic";

// Route drawing state (custom, not terra-draw)
let isDrawingRoute = false;
let routeCoords = [];
let routeSnapped = []; // parallel array: true if vertex was snapped

const SNAP_PIXEL_RADIUS = 100; // pixel radius for trail query + snap threshold

// Bound handler reference so we can add/remove the mousemove listener
let _routeMouseMoveHandler = null;

// ---------------------------------------------------------------------------
// Initialization (terra-draw for camps/waypoints only)
// ---------------------------------------------------------------------------

function initDrawing(mapInstance) {
  if (typeof terraDraw === "undefined" || typeof terraDrawMaplibreGlAdapter === "undefined") {
    console.warn("terra-draw libraries not loaded — drawing tools disabled");
    return;
  }

  const { TerraDraw, TerraDrawPointMode, TerraDrawRenderMode } = terraDraw;
  const { TerraDrawMapLibreGLAdapter } = terraDrawMaplibreGlAdapter;

  draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map: mapInstance, lib: maplibregl }),
    modes: [
      new TerraDrawPointMode({
        styles: {
          pointColor: "#2d6a4f",
          pointWidth: 8,
          pointOutlineColor: "#fff",
          pointOutlineWidth: 2,
        },
      }),
      // Idle mode — no drawing, just viewing
      new TerraDrawRenderMode({ modeName: "static" }),
    ],
  });

  draw.start();

  draw.on("finish", (id) => {
    handlePointFinish(id);
  });
}

// ---------------------------------------------------------------------------
// Route drawing — custom click-based with trail snapping
// ---------------------------------------------------------------------------

function startRouteDrawing() {
  // Cancel any active terra-draw mode
  if (draw) {
    try { draw.setMode("static"); } catch (_) {}
  }

  isDrawingRoute = true;
  routeCoords = [];
  routeSnapped = [];
  pendingFeatureType = "route";
  setActiveToolBtn("drawRouteBtn");
  showRouteModal();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = "crosshair";
  updateRouteDrawing();
  updateSnapPreview(null); // clear any stale preview

  // Wire up mousemove for live snap preview
  _routeMouseMoveHandler = handleMouseMoveForRoute;
  map.on("mousemove", _routeMouseMoveHandler);
}

function handleMapClickForRoute(e) {
  if (!isDrawingRoute) return;

  const coord = [e.lngLat.lng, e.lngLat.lat];
  const result = snapToTrail(coord);

  routeCoords.push(result.coordinates);
  routeSnapped.push(result.snapped);
  updateRouteDrawing();
}

function handleMapDblClickForRoute(e) {
  if (!isDrawingRoute) return;
  e.preventDefault();
  finishRouteDrawing();
}

function handleMouseMoveForRoute(e) {
  if (!isDrawingRoute) return;

  const coord = [e.lngLat.lng, e.lngLat.lat];
  const result = snapToTrail(coord);
  updateSnapPreview(result);

  // Also update the in-progress line to extend to the preview point
  updateRouteDrawing(result.coordinates);
}

function finishRouteDrawing() {
  if (routeCoords.length < 2) {
    // Not enough points — cancel instead
    resetRouteDrawing();
    cancelDrawing();
    return;
  }

  const geometry = { type: "LineString", coordinates: routeCoords };
  const properties = { type: "route", name: "", planned: true, notes: "" };
  const idx = TripManager.addFeature(geometry, properties);

  resetRouteDrawing();
  cancelDrawing();
  openFeatureForm(idx);
}

function resetRouteDrawing() {
  isDrawingRoute = false;
  routeCoords = [];
  routeSnapped = [];
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = "";
  updateRouteDrawing();
  updateSnapPreview(null);
  hideRouteModal();

  // Remove mousemove handler
  if (_routeMouseMoveHandler) {
    map.off("mousemove", _routeMouseMoveHandler);
    _routeMouseMoveHandler = null;
  }
}

/**
 * Update the route-drawing source with current in-progress line + vertices.
 * @param {[number, number]|null} previewCoord - optional cursor position to extend line to
 */
function updateRouteDrawing(previewCoord) {
  const source = map.getSource("route-drawing");
  if (!source) return;

  const features = [];

  // Line connecting all placed vertices (+ preview extension)
  const lineCoords = [...routeCoords];
  if (previewCoord && lineCoords.length >= 1) {
    lineCoords.push(previewCoord);
  }

  if (lineCoords.length >= 2) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: lineCoords },
      properties: {},
    });
  }

  // Vertex markers (placed points only, not preview)
  routeCoords.forEach((coord, i) => {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coord },
      properties: { snapped: routeSnapped[i] || false, vertex: true },
    });
  });

  source.setData({ type: "FeatureCollection", features });
}

/**
 * Update the snap-preview source to show where the next click would land.
 * @param {{ coordinates: [number, number], snapped: boolean }|null} result
 */
function updateSnapPreview(result) {
  const source = map.getSource("snap-preview");
  if (!source) return;

  if (!result) {
    source.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  source.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: result.coordinates },
      properties: { snapped: result.snapped },
    }],
  });
}

// ---------------------------------------------------------------------------
// Trail snapping via turf.js (pixel-based threshold)
// ---------------------------------------------------------------------------

/**
 * Snap a coordinate to the nearest trail if within SNAP_PIXEL_RADIUS pixels.
 * @param {[number, number]} coord - [lng, lat]
 * @returns {{ coordinates: [number, number], snapped: boolean }}
 */
function snapToTrail(coord) {
  if (typeof turf === "undefined") {
    return { coordinates: coord, snapped: false };
  }

  // Project to pixels and create a bounding box for querying
  const pixel = map.project(coord);
  const bbox = [
    [pixel.x - SNAP_PIXEL_RADIUS, pixel.y - SNAP_PIXEL_RADIUS],
    [pixel.x + SNAP_PIXEL_RADIUS, pixel.y + SNAP_PIXEL_RADIUS],
  ];

  const trails = map.queryRenderedFeatures(bbox, { layers: ["trails"] });
  if (trails.length === 0) {
    return { coordinates: coord, snapped: false };
  }

  const clickPoint = turf.point(coord);
  let bestPoint = null;
  let bestPixelDist = Infinity;

  for (const trail of trails) {
    if (trail.geometry.type !== "LineString") continue;
    if (trail.geometry.coordinates.length < 2) continue;

    const line = turf.lineString(trail.geometry.coordinates);
    const nearest = turf.nearestPointOnLine(line, clickPoint, { units: "meters" });

    // Convert the snapped point back to pixels and measure screen distance
    const snappedPixel = map.project(nearest.geometry.coordinates);
    const dx = snappedPixel.x - pixel.x;
    const dy = snappedPixel.y - pixel.y;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);

    if (pixelDist < bestPixelDist) {
      bestPixelDist = pixelDist;
      bestPoint = nearest;
    }
  }

  if (bestPoint && bestPixelDist <= SNAP_PIXEL_RADIUS) {
    return {
      coordinates: bestPoint.geometry.coordinates,
      snapped: true,
    };
  }

  return { coordinates: coord, snapped: false };
}

// ---------------------------------------------------------------------------
// Camp & waypoint drawing — terra-draw PointMode
// ---------------------------------------------------------------------------

function startCampDrop() {
  if (!draw) return;
  if (isDrawingRoute) resetRouteDrawing();
  pendingFeatureType = "camp";
  draw.setMode("point");
  setActiveToolBtn("dropCampBtn");
  showDrawingHint("Click on the map to place camp.");
}

function startWaypointDrop(subtype) {
  if (!draw) return;
  if (isDrawingRoute) resetRouteDrawing();
  pendingFeatureType = "waypoint";
  pendingWaypointSubtype = subtype || "scenic";
  draw.setMode("point");
  setActiveToolBtn("addWaypointBtn");
  showDrawingHint("Click on the map to place waypoint.");
}

/** Handle terra-draw point finish (camps and waypoints only). */
function handlePointFinish(id) {
  const snapshot = draw.getSnapshot();
  const feature = snapshot.find((f) => f.id === id);
  if (!feature || !pendingFeatureType) return;

  const geometry = {
    type: feature.geometry.type,
    coordinates: feature.geometry.coordinates,
  };

  let properties;
  if (pendingFeatureType === "camp") {
    properties = {
      type: "camp",
      night_number: TripManager.getNextNightNumber(),
      name: "",
      notes: "",
      water_nearby: false,
      planned: true,
    };
  } else if (pendingFeatureType === "waypoint") {
    properties = {
      type: "waypoint",
      subtype: pendingWaypointSubtype,
      name: "",
      notes: "",
    };
  } else {
    return;
  }

  const idx = TripManager.addFeature(geometry, properties);

  try {
    draw.removeFeatures([id]);
  } catch (_) {}

  cancelDrawing();
  openFeatureForm(idx);
}

// ---------------------------------------------------------------------------
// Cancel / shared UI
// ---------------------------------------------------------------------------

function cancelDrawing() {
  if (isDrawingRoute) {
    resetRouteDrawing();
  }
  if (draw) {
    try { draw.setMode("static"); } catch (_) {}
  }
  pendingFeatureType = null;
  setActiveToolBtn(null);
  hideDrawingHint();
  hideRouteModal();
}

function setActiveToolBtn(id) {
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.id === id);
  });
}

function showDrawingHint(text) {
  const el = document.getElementById("drawingHint");
  if (el) {
    el.textContent = text;
    el.classList.add("visible");
  }
}

function hideDrawingHint() {
  const el = document.getElementById("drawingHint");
  if (el) el.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Route instruction modal
// ---------------------------------------------------------------------------

function showRouteModal() {
  const el = document.getElementById("routeModal");
  if (el) el.classList.add("visible");
}

function hideRouteModal() {
  const el = document.getElementById("routeModal");
  if (el) el.classList.remove("visible");
}

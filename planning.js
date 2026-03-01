/**
 * OutHere Trip Planning — Drawing Tools
 *
 * Unified route drawing with switchable point types (route/camp/dayhike/rest).
 * Uses a custom click-based system with trail snapping via turf.js
 * nearestPointOnLine. A live preview marker follows the cursor and snaps
 * to trails in real time.
 *
 * Hotkeys 1-4 switch point type during drawing.
 *
 * Dependencies (loaded before this script):
 *   - turf               (global, via turf.min.js)
 *   - map                (global, from app.js)
 */

let pendingFeatureType = null; // "route" when drawing

// Route drawing state
let isDrawingRoute = false;
let routeCoords = [];
let routeSnapped = [];      // parallel array: true if vertex was snapped
let routeVertexTypes = [];   // parallel array: "route" | "camp" | "dayhike" | "rest"
let currentPointType = "route";

const SNAP_PIXEL_RADIUS = 30; // pixel radius for trail query + snap threshold

const POINT_TYPES = ["route", "camp", "dayhike", "rest"];

// Bound handler references so we can add/remove listeners
let _routeMouseMoveHandler = null;
let _routeKeyHandler = null;

// ---------------------------------------------------------------------------
// Route drawing — custom click-based with trail snapping
// ---------------------------------------------------------------------------

function startRouteDrawing() {
  isDrawingRoute = true;
  routeCoords = [];
  routeSnapped = [];
  routeVertexTypes = [];
  currentPointType = "route";
  pendingFeatureType = "route";
  setActiveToolBtn("drawRouteBtn");
  showPointTypeSelector();
  setActivePointType("route");
  showRouteModal();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = "crosshair";
  updateRouteDrawing();
  updateSnapPreview(null);

  // Wire up mousemove for live snap preview
  _routeMouseMoveHandler = handleMouseMoveForRoute;
  map.on("mousemove", _routeMouseMoveHandler);

  // Wire up keyboard hotkeys for point type switching
  _routeKeyHandler = handleRouteKeyDown;
  document.addEventListener("keydown", _routeKeyHandler);
}

function handleMapClickForRoute(e) {
  if (!isDrawingRoute) return;

  const coord = [e.lngLat.lng, e.lngLat.lat];
  const result = e.originalEvent.shiftKey
    ? { coordinates: coord, snapped: false }
    : snapToTrail(coord);

  routeCoords.push(result.coordinates);
  routeSnapped.push(result.snapped);
  routeVertexTypes.push(currentPointType);
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
  const result = e.originalEvent.shiftKey
    ? { coordinates: coord, snapped: false }
    : snapToTrail(coord);
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

  // 1. Create the route LineString
  const geometry = { type: "LineString", coordinates: routeCoords };
  const properties = {
    type: "route",
    name: "",
    planned: true,
    notes: "",
    vertex_types: [...routeVertexTypes],
    vertex_snapped: [...routeSnapped],
  };
  const routeIdx = TripManager.addFeature(geometry, properties);

  // 2. Create Point features for special points (camp/dayhike/rest)
  const tripDates = getTripDateRange();
  let dateIndex = 0;

  for (let i = 0; i < routeCoords.length; i++) {
    const vtype = routeVertexTypes[i];
    if (vtype === "route") continue;

    const pointGeom = { type: "Point", coordinates: routeCoords[i] };
    const pointDate = tripDates[dateIndex] || "";

    const pointProps = {
      type: vtype,
      point_type: vtype,
      route_index: routeIdx,
      route_vertex_index: i,
      date: pointDate,
      name: "",
      notes: "",
    };

    if (vtype === "camp") {
      pointProps.water_nearby = false;
      pointProps.water_notes = "";
      dateIndex++; // camp advances to next day
    } else if (vtype === "rest") {
      dateIndex++; // rest day consumes a day
    }
    // dayhike does NOT advance the date (same-day activity)

    TripManager.addFeature(pointGeom, pointProps);
  }

  resetRouteDrawing();
  cancelDrawing();
  openFeatureForm(routeIdx);
}

function resetRouteDrawing() {
  isDrawingRoute = false;
  routeCoords = [];
  routeSnapped = [];
  routeVertexTypes = [];
  currentPointType = "route";
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = "";
  updateRouteDrawing();
  updateSnapPreview(null);
  hideRouteModal();
  hidePointTypeSelector();

  // Remove mousemove handler
  if (_routeMouseMoveHandler) {
    map.off("mousemove", _routeMouseMoveHandler);
    _routeMouseMoveHandler = null;
  }

  // Remove keyboard handler
  if (_routeKeyHandler) {
    document.removeEventListener("keydown", _routeKeyHandler);
    _routeKeyHandler = null;
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
      properties: {
        snapped: routeSnapped[i] || false,
        vertex: true,
        point_type: routeVertexTypes[i] || "route",
      },
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
// Cancel / shared UI
// ---------------------------------------------------------------------------

function cancelDrawing() {
  if (isDrawingRoute) {
    resetRouteDrawing();
  }
  pendingFeatureType = null;
  setActiveToolBtn(null);
  hideDrawingHint();
  hideRouteModal();
  hidePointTypeSelector();
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
  const el = document.getElementById("routeInstructions");
  if (el) el.classList.add("visible");
}

function hideRouteModal() {
  const el = document.getElementById("routeInstructions");
  if (el) el.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Point type selector
// ---------------------------------------------------------------------------

function showPointTypeSelector() {
  const el = document.getElementById("pointTypeSelector");
  if (el) el.classList.add("visible");
}

function hidePointTypeSelector() {
  const el = document.getElementById("pointTypeSelector");
  if (el) el.classList.remove("visible");
}

function setActivePointType(pointType) {
  currentPointType = pointType;
  document.querySelectorAll(".point-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.pointType === pointType);
  });
}

function initPointTypeSelector() {
  document.querySelectorAll(".point-type-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setActivePointType(btn.dataset.pointType);
    });
  });
}

// ---------------------------------------------------------------------------
// Keyboard hotkeys for point type switching (1-4)
// ---------------------------------------------------------------------------

function handleRouteKeyDown(e) {
  if (!isDrawingRoute) return;

  // Ignore if user is typing in a form input
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const keyMap = { "1": "route", "2": "camp", "3": "dayhike", "4": "rest" };
  const pointType = keyMap[e.key];
  if (pointType) {
    e.preventDefault();
    setActivePointType(pointType);
  }
}

// ---------------------------------------------------------------------------
// Trip date range helper
// ---------------------------------------------------------------------------

function getTripDateRange() {
  if (!TripManager.currentTrip) return [];
  const meta = TripManager.currentTrip.properties;
  if (!meta.dates?.start || !meta.dates?.end) return [];

  const dates = [];
  const start = new Date(meta.dates.start + "T00:00:00");
  const end = new Date(meta.dates.end + "T00:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

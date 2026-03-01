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
let routeTrailRefs = [];     // parallel array: { trailCoords, trailId, trailName, indexOnLine } or null
let routeSegments = [];      // per-edge: { coords, isTrailSnapped }
let routeDayhikeSegments = []; // dayhike spurs: { fromVertexIndex, coords, distance }
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
  routeTrailRefs = [];
  routeSegments = [];
  routeDayhikeSegments = [];
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
    ? { coordinates: coord, snapped: false, trailFeature: null, indexOnLine: null }
    : snapToTrail(coord);

  if (e.originalEvent.shiftKey) {
    console.log("[snap] shift-bypass: straight line");
  }

  routeCoords.push(result.coordinates);
  routeSnapped.push(result.snapped);
  routeVertexTypes.push(currentPointType);
  routeTrailRefs.push(result.snapped ? {
    trailCoords: result.trailFeature.geometry.coordinates,
    trailId: result.trailFeature.id ?? result.trailFeature.properties?.osm_id ?? null,
    trailName: result.trailFeature.properties?.name ?? null,
    indexOnLine: result.indexOnLine,
  } : null);

  // Compute segment from previous vertex
  if (routeCoords.length >= 2) {
    const currIdx = routeCoords.length - 1;
    const prevIdx = currIdx - 1;

    if (currentPointType === "dayhike") {
      // Dayhike spur: branch from last main-route vertex
      const lastMainIdx = findLastMainRouteVertexIndex(prevIdx);
      const segment = getTrailSegmentBetween(
        routeTrailRefs[lastMainIdx], routeTrailRefs[currIdx],
        routeCoords[lastMainIdx], routeCoords[currIdx]
      );
      const dist = segment.coords.length >= 2
        ? turf.length(turf.lineString(segment.coords), { units: "miles" })
        : 0;
      routeDayhikeSegments.push({
        fromVertexIndex: lastMainIdx,
        coords: segment.coords,
        distance: dist,
      });
    } else {
      // Main route vertex: connect from last main-route vertex (skip dayhikes)
      const lastMainIdx = findLastMainRouteVertexIndex(prevIdx);
      const fromIdx = (routeVertexTypes[prevIdx] === "dayhike") ? lastMainIdx : prevIdx;
      const segment = getTrailSegmentBetween(
        routeTrailRefs[fromIdx], routeTrailRefs[currIdx],
        routeCoords[fromIdx], routeCoords[currIdx]
      );
      routeSegments.push(segment);
      console.log("[snap] segment added:", JSON.stringify({
        segmentIndex: routeSegments.length - 1,
        fromIdx,
        currIdx,
        isTrailSnapped: segment.isTrailSnapped,
        segmentCoordCount: segment.coords.length,
        segmentStart: segment.coords[0],
        segmentEnd: segment.coords[segment.coords.length - 1],
        vertexStart: routeCoords[fromIdx],
        vertexEnd: routeCoords[currIdx],
      }));
    }
  }

  // Log full state after each click
  console.log("[snap] state:", JSON.stringify({
    totalVertices: routeCoords.length,
    totalSegments: routeSegments.length,
    totalDayhikeSpurs: routeDayhikeSegments.length,
    vertices: routeCoords,
    vertexTypes: routeVertexTypes,
    trailRefs: routeTrailRefs.map((ref, i) => ref ? {
      idx: i,
      indexOnLine: ref.indexOnLine,
      trailName: ref.trailName,
      trailCoordsLen: ref.trailCoords.length,
      trailFirst: ref.trailCoords[0],
      trailLast: ref.trailCoords[ref.trailCoords.length - 1],
    } : { idx: i, ref: null }),
    segments: routeSegments.map((seg, i) => ({
      idx: i,
      isTrailSnapped: seg.isTrailSnapped,
      coordCount: seg.coords.length,
      start: seg.coords[0],
      end: seg.coords[seg.coords.length - 1],
    })),
  }));

  updateRouteDrawing();
  notifyDrawingProgress();

  // Log the final display coords after this click
  const displayCoords = buildMainRouteDisplayCoords();
  console.log("[snap] display line after click:", JSON.stringify({
    displayCoordCount: displayCoords.length,
    displayFirst: displayCoords[0],
    displayLast: displayCoords[displayCoords.length - 1],
    matchesLastVertex: routeCoords.length > 0 &&
      displayCoords.length > 0 &&
      displayCoords[displayCoords.length - 1][0] === routeCoords[routeCoords.length - 1][0] &&
      displayCoords[displayCoords.length - 1][1] === routeCoords[routeCoords.length - 1][1],
  }));
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

  // 1. Create the route LineString with trail-following display coords
  const mainDisplayCoords = buildMainRouteDisplayCoords();
  // Ensure we have at least 2 coords for a valid LineString
  const geometry = {
    type: "LineString",
    coordinates: mainDisplayCoords.length >= 2 ? mainDisplayCoords : [...routeCoords],
  };
  const properties = {
    type: "route",
    name: "",
    planned: true,
    notes: "",
    vertex_types: [...routeVertexTypes],
    vertex_snapped: [...routeSnapped],
    vertex_coords: [...routeCoords],
    main_route_distance_mi: computeMainRouteDistance(),
    dayhike_distance_mi: computeDayhikeDistance(),
  };
  const routeIdx = TripManager.addFeature(geometry, properties);

  // 2. Create dayhike spur LineString features
  for (const spur of routeDayhikeSegments) {
    if (spur.coords.length >= 2) {
      TripManager.addFeature(
        { type: "LineString", coordinates: spur.coords },
        { type: "dayhike_spur", route_index: routeIdx, name: "" }
      );
    }
  }

  // 3. Create Point features for special points (camp/dayhike/rest)
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
  routeTrailRefs = [];
  routeSegments = [];
  routeDayhikeSegments = [];
  currentPointType = "route";
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = "";
  updateRouteDrawing();
  updateSnapPreview(null);
  hideRouteModal();
  hidePointTypeSelector();

  // Clear sidebar drawing preview
  if (typeof updateDrawingPreview === "function") {
    updateDrawingPreview(null);
  }

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
 * Uses trail-following display coords for the main route line, and separate
 * features for dayhike spurs.
 * @param {[number, number]|null} previewCoord - optional cursor position to extend line to
 */
function updateRouteDrawing(previewCoord) {
  const source = map.getSource("route-drawing");
  if (!source) return;

  const features = [];

  // 1. Main route line from trail-snapped segments
  const mainCoords = buildMainRouteDisplayCoords();
  if (previewCoord && currentPointType !== "dayhike") {
    // Extend main route to cursor (straight line preview — no trail interpolation on mousemove)
    if (mainCoords.length >= 1) {
      mainCoords.push(previewCoord);
    }
  }
  if (mainCoords.length >= 2) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: mainCoords },
      properties: { segment_type: "main" },
    });
  }

  // 2. Dayhike spur lines
  for (const spur of routeDayhikeSegments) {
    if (spur.coords.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: spur.coords },
        properties: { segment_type: "dayhike" },
      });
    }
  }

  // 3. Preview spur when in dayhike mode
  if (previewCoord && currentPointType === "dayhike" && routeCoords.length >= 1) {
    const lastMainIdx = findLastMainRouteVertexIndex(routeCoords.length - 1);
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [routeCoords[lastMainIdx], previewCoord] },
      properties: { segment_type: "dayhike" },
    });
  }

  // 4. Vertex markers (placed points only, not preview)
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
    return { coordinates: coord, snapped: false, trailFeature: null, indexOnLine: null };
  }

  // Project to pixels and create a bounding box for querying
  const pixel = map.project(coord);
  const bbox = [
    [pixel.x - SNAP_PIXEL_RADIUS, pixel.y - SNAP_PIXEL_RADIUS],
    [pixel.x + SNAP_PIXEL_RADIUS, pixel.y + SNAP_PIXEL_RADIUS],
  ];

  const trails = map.queryRenderedFeatures(bbox, { layers: ["trails"] });
  if (trails.length === 0) {
    return { coordinates: coord, snapped: false, trailFeature: null, indexOnLine: null };
  }

  const clickPoint = turf.point(coord);
  let bestPoint = null;
  let bestPixelDist = Infinity;
  let bestTrail = null;

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
      bestTrail = trail;
    }
  }

  if (bestPoint && bestPixelDist <= SNAP_PIXEL_RADIUS) {
    console.log("[snap] snapped to trail:", JSON.stringify({
      originalClick: coord,
      snappedTo: bestPoint.geometry.coordinates,
      pixelDist: Math.round(bestPixelDist * 10) / 10,
      indexOnLine: bestPoint.properties.index,
      trailName: bestTrail.properties?.name || null,
      trailId: bestTrail.id ?? bestTrail.properties?.osm_id ?? null,
      trailCoordsLength: bestTrail.geometry.coordinates.length,
      trailFirstCoord: bestTrail.geometry.coordinates[0],
      trailLastCoord: bestTrail.geometry.coordinates[bestTrail.geometry.coordinates.length - 1],
    }));
    return {
      coordinates: bestPoint.geometry.coordinates,
      snapped: true,
      trailFeature: bestTrail,
      indexOnLine: bestPoint.properties.index,
    };
  }

  console.log("[snap] no trail in range, unsnapped:", coord);
  return { coordinates: coord, snapped: false, trailFeature: null, indexOnLine: null };
}

// ---------------------------------------------------------------------------
// Trail segment extraction — follow trail geometry between snapped points
// ---------------------------------------------------------------------------

/**
 * Check if two trail refs represent the same trail geometry.
 * Returns "same" if identical coordinates, "related" if same trail id/name
 * but different geometry (tile-boundary split), or false if unrelated.
 *
 * NOTE: queryRenderedFeatures returns new JS objects every call, so we
 * compare by stored coordinates/id/name rather than object identity.
 */
function trailsMatch(refA, refB) {
  if (!refA || !refB) {
    console.log("[snap] trailsMatch: null ref", { refA: !!refA, refB: !!refB });
    return false;
  }

  // Same coordinates array content = same trail geometry
  // (fast check: compare length + first/last coords)
  const ac = refA.trailCoords;
  const bc = refB.trailCoords;
  const lengthMatch = ac.length === bc.length;
  const firstMatch = ac.length > 0 && bc.length > 0 && ac[0][0] === bc[0][0] && ac[0][1] === bc[0][1];
  const lastMatch = ac.length > 0 && bc.length > 0 &&
    ac[ac.length - 1][0] === bc[bc.length - 1][0] &&
    ac[ac.length - 1][1] === bc[bc.length - 1][1];

  console.log("[snap] trailsMatch check:", JSON.stringify({
    aLen: ac.length, bLen: bc.length,
    lengthMatch, firstMatch, lastMatch,
    aFirst: ac[0], bFirst: bc[0],
    aLast: ac[ac.length - 1], bLast: bc[bc.length - 1],
    aName: refA.trailName, bName: refB.trailName,
    aId: refA.trailId, bId: refB.trailId,
    aIndex: refA.indexOnLine, bIndex: refB.indexOnLine,
  }));

  if (lengthMatch && firstMatch && lastMatch) {
    console.log("[snap] trailsMatch → same");
    return "same";
  }

  // Same trail id or name but different geometry = tile-boundary fragments
  if (refA.trailId && refB.trailId && refA.trailId === refB.trailId) {
    console.log("[snap] trailsMatch → related (by id)");
    return "related";
  }
  if (refA.trailName && refB.trailName && refA.trailName === refB.trailName) {
    console.log("[snap] trailsMatch → related (by name)");
    return "related";
  }
  console.log("[snap] trailsMatch → false (no match)");
  return false;
}

/**
 * Extract trail coordinates between two known segment indices.
 * Uses the stored indexOnLine from nearestPointOnLine to avoid
 * the re-projection ambiguity that turf.lineSlice causes on curvy trails.
 *
 * @param {number[][]} trailCoords - full trail coordinate array
 * @param {[number,number]} startCoord - snapped start point
 * @param {number} startIdx - segment index where start was snapped
 * @param {[number,number]} endCoord - snapped end point
 * @param {number} endIdx - segment index where end was snapped
 * @returns {number[][]} coordinates from start to end along the trail
 */
function extractTrailSlice(trailCoords, startCoord, startIdx, endCoord, endIdx) {
  // Determine direction: forward or backward along the trail
  const forward = startIdx <= endIdx;
  const coords = [];

  console.log("[snap] extractTrailSlice input:", JSON.stringify({
    trailCoordsLength: trailCoords.length,
    startCoord, startIdx,
    endCoord, endIdx,
    forward,
    // Show the trail vertices around the start and end indices
    trailAtStartIdx: trailCoords[startIdx],
    trailAtStartIdx1: trailCoords[startIdx + 1],
    trailAtEndIdx: trailCoords[endIdx],
    trailAtEndIdx1: trailCoords[endIdx + 1],
  }));

  if (forward) {
    // Start with the snapped start point
    coords.push(startCoord);
    // Add all trail vertices between the two segments
    for (let i = startIdx + 1; i <= endIdx; i++) {
      coords.push(trailCoords[i]);
    }
    // End with the snapped end point
    coords.push(endCoord);
  } else {
    // Walking backward along the trail
    coords.push(startCoord);
    for (let i = startIdx; i > endIdx; i--) {
      coords.push(trailCoords[i]);
    }
    coords.push(endCoord);
  }

  console.log("[snap] extractTrailSlice output:", JSON.stringify({
    resultLength: coords.length,
    first: coords[0],
    last: coords[coords.length - 1],
    all: coords,
  }));

  return coords;
}

/**
 * Get the trail segment between two vertices.
 * Uses index-based extraction when both points are on the same trail geometry
 * to avoid turf.lineSlice re-projection issues on curvy/switchback trails.
 * Falls back to a straight line otherwise.
 */
function getTrailSegmentBetween(prevRef, currRef, prevCoord, currCoord) {
  // Either endpoint unsnapped → straight line
  if (!prevRef || !currRef) {
    console.log("[snap] unsnapped-endpoint fallback");
    return { coords: [prevCoord, currCoord], isTrailSnapped: false };
  }

  const match = trailsMatch(prevRef, currRef);

  if (match === "same") {
    // Same trail geometry — use index-based extraction (no re-projection)
    // This path already uses prevCoord/currCoord as endpoints, so no pinning needed
    try {
      const slicedCoords = extractTrailSlice(
        prevRef.trailCoords,
        prevCoord, prevRef.indexOnLine,
        currCoord, currRef.indexOnLine
      );
      if (slicedCoords.length >= 2) {
        const trailName = prevRef.trailName || "unnamed";
        console.log("[snap] same-trail index-slice:", trailName, slicedCoords.length, "coords, idx", prevRef.indexOnLine, "→", currRef.indexOnLine);
        return { coords: slicedCoords, isTrailSnapped: true };
      }
    } catch (err) {
      console.warn("[snap] index-slice error, falling back to straight line:", err.message);
    }
    return { coords: [prevCoord, currCoord], isTrailSnapped: false };
  }

  // For "related" and corridor-connect paths, we use prevCoord/currCoord
  // (the stored routeCoords) as the canonical segment endpoints, replacing any
  // re-projected coordinates that turf.lineSlice or nearestPointOnLine produces.
  // This eliminates visual gaps between vertex dots and rendered lines at the source.
  let result = null;

  if (match === "related") {
    // Tile-boundary: same trail id/name but different geometry fragments
    try {
      const merged = mergeTrailFragments(
        { geometry: { coordinates: prevRef.trailCoords } },
        { geometry: { coordinates: currRef.trailCoords } }
      );
      if (merged) {
        console.log("[snap] tile-boundary merge:", 2, "fragments");
        const sliced = turf.lineSlice(
          turf.point(prevCoord),
          turf.point(currCoord),
          merged
        );
        const sc = sliced.geometry.coordinates;
        if (sc.length >= 2) {
          // Replace re-projected endpoints with canonical vertex coords
          sc[0] = prevCoord;
          sc[sc.length - 1] = currCoord;
          result = { coords: sc, isTrailSnapped: true };
        }
      } else {
        console.log("[snap] tile-boundary merge failed, straight line fallback");
      }
    } catch (err) {
      console.warn("[snap] tile-boundary slice error, falling back to straight line:", err.message);
    }
  }

  if (!result) {
    // Different trails → try wider query to find connecting geometry
    result = tryConnectTrails(prevRef, currRef, prevCoord, currCoord);
  }

  if (!result) {
    const name1 = prevRef.trailName || "unnamed";
    const name2 = currRef.trailName || "unnamed";
    console.log("[snap] different-trails fallback:", name1, name2);
    return { coords: [prevCoord, currCoord], isTrailSnapped: false };
  }

  return { coords: result.coords, isTrailSnapped: result.isTrailSnapped };
}

/**
 * Merge two trail feature fragments that are part of the same logical trail
 * (split across tile boundaries). Returns a turf lineString or null.
 */
const MERGE_GAP_TOLERANCE_METERS = 20; // max gap between trail fragment endpoints for merge

function mergeTrailFragments(featA, featB) {
  const coordsA = featA.geometry.coordinates;
  const coordsB = featB.geometry.coordinates;
  if (!coordsA.length || !coordsB.length) return null;

  // Check which ends are closest to determine merge order
  const aEnd = coordsA[coordsA.length - 1];
  const bStart = coordsB[0];
  const bEnd = coordsB[coordsB.length - 1];
  const aStart = coordsA[0];

  // Use turf.distance (meters) instead of degree-based threshold which varies with latitude
  const distMeters = (a, b) => turf.distance(turf.point(a), turf.point(b), { units: "meters" });

  // Try A→B
  const dAEndBStart = distMeters(aEnd, bStart);
  if (dAEndBStart <= MERGE_GAP_TOLERANCE_METERS) {
    return turf.lineString([...coordsA, ...coordsB.slice(1)]);
  }
  // Try A→B(reversed)
  const dAEndBEnd = distMeters(aEnd, bEnd);
  if (dAEndBEnd <= MERGE_GAP_TOLERANCE_METERS) {
    return turf.lineString([...coordsA, ...[...coordsB].reverse().slice(1)]);
  }
  // Try B→A
  const dBEndAStart = distMeters(bEnd, aStart);
  if (dBEndAStart <= MERGE_GAP_TOLERANCE_METERS) {
    return turf.lineString([...coordsB, ...coordsA.slice(1)]);
  }
  // Try B(reversed)→A
  const dBStartAStart = distMeters(bStart, aStart);
  if (dBStartAStart <= MERGE_GAP_TOLERANCE_METERS) {
    return turf.lineString([...[...coordsB].reverse(), ...coordsA.slice(1)]);
  }

  const minGap = Math.min(dAEndBStart, dAEndBEnd, dBEndAStart, dBStartAStart);
  console.log("[snap] mergeTrailFragments failed: closest gap", Math.round(minGap), "m exceeds", MERGE_GAP_TOLERANCE_METERS, "m tolerance");
  return null;
}

/**
 * Try to connect two points on different trails by querying
 * the corridor between them for shared trail geometry.
 * Returns { coords, isTrailSnapped } or null.
 */
function tryConnectTrails(prevRef, currRef, prevCoord, currCoord) {
  // Query all trails in the bounding box between the two points
  const p1 = map.project(prevCoord);
  const p2 = map.project(currCoord);
  const minX = Math.min(p1.x, p2.x) - SNAP_PIXEL_RADIUS;
  const minY = Math.min(p1.y, p2.y) - SNAP_PIXEL_RADIUS;
  const maxX = Math.max(p1.x, p2.x) + SNAP_PIXEL_RADIUS;
  const maxY = Math.max(p1.y, p2.y) + SNAP_PIXEL_RADIUS;

  const corridorTrails = map.queryRenderedFeatures(
    [[minX, minY], [maxX, maxY]],
    { layers: ["trails"] }
  );

  // Look for a single trail that passes near both points
  const prevPt = turf.point(prevCoord);
  const currPt = turf.point(currCoord);

  for (const trail of corridorTrails) {
    if (trail.geometry.type !== "LineString" || trail.geometry.coordinates.length < 2) continue;

    // Quick bounding-box prefilter: skip trails whose extent doesn't come near
    // both endpoints. Avoids expensive nearestPointOnLine on irrelevant trails.
    const tc = trail.geometry.coordinates;
    let tMinLng = Infinity, tMaxLng = -Infinity, tMinLat = Infinity, tMaxLat = -Infinity;
    for (let k = 0; k < tc.length; k++) {
      if (tc[k][0] < tMinLng) tMinLng = tc[k][0];
      if (tc[k][0] > tMaxLng) tMaxLng = tc[k][0];
      if (tc[k][1] < tMinLat) tMinLat = tc[k][1];
      if (tc[k][1] > tMaxLat) tMaxLat = tc[k][1];
    }
    // Pad by ~0.005 degrees (~500m) to account for snap radius at typical zoom
    const pad = 0.005;
    const prevNear = prevCoord[0] >= tMinLng - pad && prevCoord[0] <= tMaxLng + pad &&
                     prevCoord[1] >= tMinLat - pad && prevCoord[1] <= tMaxLat + pad;
    const currNear = currCoord[0] >= tMinLng - pad && currCoord[0] <= tMaxLng + pad &&
                     currCoord[1] >= tMinLat - pad && currCoord[1] <= tMaxLat + pad;
    if (!prevNear || !currNear) continue;

    const line = turf.lineString(trail.geometry.coordinates);
    const nearPrev = turf.nearestPointOnLine(line, prevPt, { units: "meters" });
    const nearCurr = turf.nearestPointOnLine(line, currPt, { units: "meters" });

    const prevPixel = map.project(nearPrev.geometry.coordinates);
    const currPixel = map.project(nearCurr.geometry.coordinates);

    const distPrev = Math.sqrt((prevPixel.x - p1.x) ** 2 + (prevPixel.y - p1.y) ** 2);
    const distCurr = Math.sqrt((currPixel.x - p2.x) ** 2 + (currPixel.y - p2.y) ** 2);

    // Both endpoints must be close to this trail. Uses 2x SNAP_PIXEL_RADIUS because
    // corridor-connect joins vertices on different trails — the connecting geometry
    // won't be pixel-perfect at either end, so we need a wider acceptance window.
    if (distPrev <= SNAP_PIXEL_RADIUS * 2 && distCurr <= SNAP_PIXEL_RADIUS * 2) {
      try {
        // Use index-based extraction with canonical vertex coords as endpoints
        // (indices from nearestPointOnLine for the slice range, but prevCoord/currCoord
        // as the authoritative start/end to avoid re-projection drift)
        const slicedCoords = extractTrailSlice(
          trail.geometry.coordinates,
          prevCoord, nearPrev.properties.index,
          currCoord, nearCurr.properties.index
        );
        if (slicedCoords.length >= 2) {
          const trailName = trail.properties?.name || "unnamed";
          console.log("[snap] corridor-connect via:", trailName, slicedCoords.length, "coords");
          return { coords: slicedCoords, isTrailSnapped: true };
        }
      } catch (_) { /* continue to next trail */ }
    }
  }

  // --- Two-hop junction search ---
  // No single trail spans both vertices. Look for two trails that share a junction
  // (a coordinate pair within MERGE_GAP_TOLERANCE_METERS of each other).
  // Collect candidate trails near each endpoint separately.
  const prevCandidates = []; // trails near prevCoord
  const currCandidates = []; // trails near currCoord

  for (const trail of corridorTrails) {
    if (trail.geometry.type !== "LineString" || trail.geometry.coordinates.length < 2) continue;

    const line = turf.lineString(trail.geometry.coordinates);
    const nearPrev = turf.nearestPointOnLine(line, prevPt, { units: "meters" });
    const nearCurr = turf.nearestPointOnLine(line, currPt, { units: "meters" });

    const prevPixel = map.project(nearPrev.geometry.coordinates);
    const currPixel = map.project(nearCurr.geometry.coordinates);

    const dPrev = Math.sqrt((prevPixel.x - p1.x) ** 2 + (prevPixel.y - p1.y) ** 2);
    const dCurr = Math.sqrt((currPixel.x - p2.x) ** 2 + (currPixel.y - p2.y) ** 2);

    if (dPrev <= SNAP_PIXEL_RADIUS * 2) {
      prevCandidates.push({ trail, nearPoint: nearPrev });
    }
    if (dCurr <= SNAP_PIXEL_RADIUS * 2) {
      currCandidates.push({ trail, nearPoint: nearCurr });
    }
  }

  for (const pc of prevCandidates) {
    for (const cc of currCandidates) {
      // Skip if same trail geometry (already tried in single-trail pass)
      if (pc.trail === cc.trail) continue;

      // Find a junction: any coordinate on trail A within tolerance of any coordinate on trail B
      const coordsA = pc.trail.geometry.coordinates;
      const coordsB = cc.trail.geometry.coordinates;

      for (let ai = 0; ai < coordsA.length; ai++) {
        for (let bi = 0; bi < coordsB.length; bi++) {
          const gapM = turf.distance(turf.point(coordsA[ai]), turf.point(coordsB[bi]), { units: "meters" });
          if (gapM > MERGE_GAP_TOLERANCE_METERS) continue;

          // Found a junction — stitch: prevCoord→junction on trail A, junction→currCoord on trail B
          try {
            const junctionCoord = coordsA[ai]; // use trail A's coordinate as the junction point
            const legA = extractTrailSlice(
              coordsA,
              prevCoord, pc.nearPoint.properties.index,
              junctionCoord, ai
            );
            const legB = extractTrailSlice(
              coordsB,
              junctionCoord, bi,
              currCoord, cc.nearPoint.properties.index
            );

            if (legA.length >= 2 && legB.length >= 2) {
              // Concatenate, deduplicating the shared junction coordinate
              const stitched = [...legA, ...legB.slice(1)];
              const nameA = pc.trail.properties?.name || "unnamed";
              const nameB = cc.trail.properties?.name || "unnamed";
              console.log("[snap] two-hop connect via:", nameA, "→", nameB,
                "at junction", JSON.stringify(junctionCoord),
                stitched.length, "coords");
              return { coords: stitched, isTrailSnapped: true };
            }
          } catch (_) { /* continue searching */ }
        }
      }
    }
  }

  return null;
}

/**
 * Find the index of the last main-route vertex (non-dayhike) at or before upToIndex.
 */
function findLastMainRouteVertexIndex(upToIndex) {
  for (let i = upToIndex; i >= 0; i--) {
    if (routeVertexTypes[i] !== "dayhike") return i;
  }
  return 0;
}

/**
 * Build the full main route coordinate array from segments.
 * Concatenates segment coords, deduplicating shared endpoints.
 */
function buildMainRouteDisplayCoords() {
  if (routeSegments.length === 0) {
    // Only one vertex placed, or no segments yet
    const mainVertices = routeCoords.filter((_, i) => routeVertexTypes[i] !== "dayhike");
    return mainVertices.length > 0 ? [mainVertices[0]] : [];
  }

  const coords = [...routeSegments[0].coords];
  for (let i = 1; i < routeSegments.length; i++) {
    const segCoords = routeSegments[i].coords;
    // Skip first coord if it's a duplicate of the previous segment's last coord.
    // Use a small tolerance (1e-10 degrees) rather than exact equality to guard
    // against floating point drift between segment endpoints.
    let startJ = 1;
    if (segCoords.length > 0 && coords.length > 0) {
      const last = coords[coords.length - 1];
      const first = segCoords[0];
      const dLng = Math.abs(last[0] - first[0]);
      const dLat = Math.abs(last[1] - first[1]);
      if (dLng > 1e-10 || dLat > 1e-10) {
        // Not a duplicate — include the first coord
        startJ = 0;
        if (dLng < 1e-6 && dLat < 1e-6) {
          console.warn("[snap] buildMainRouteDisplayCoords: near-duplicate detected between segment", i - 1, "end and segment", i, "start, drift:", dLng.toExponential(2), dLat.toExponential(2));
        }
      }
    }
    for (let j = startJ; j < segCoords.length; j++) {
      coords.push(segCoords[j]);
    }
  }

  return coords;
}

// ---------------------------------------------------------------------------
// Distance computation
// ---------------------------------------------------------------------------

function computeMainRouteDistance() {
  let total = 0;
  for (const seg of routeSegments) {
    if (seg.coords.length >= 2) {
      total += turf.length(turf.lineString(seg.coords), { units: "miles" });
    }
  }
  return total;
}

function computeDayhikeDistance() {
  let total = 0;
  for (const spur of routeDayhikeSegments) {
    // Dayhikes are out-and-back, so double the spur distance
    total += spur.distance * 2;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Drawing progress notification (for sidebar live preview)
// ---------------------------------------------------------------------------

function notifyDrawingProgress() {
  if (typeof updateDrawingPreview === "function") {
    updateDrawingPreview({
      vertexCount: routeCoords.length,
      mainDistanceMi: computeMainRouteDistance(),
      dayhikeDistanceMi: computeDayhikeDistance(),
      vertexTypes: [...routeVertexTypes],
    });
  }
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

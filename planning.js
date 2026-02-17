/**
 * OutHere Trip Planning — Drawing Tools
 *
 * Integrates terra-draw for route/point drawing on the map.
 * Uses terra-draw only for active drawing interactions — finished
 * features are moved to the trip GeoJSON source for rendering.
 *
 * Dependencies (loaded before this script):
 *   - terraDraw          (global, via terra-draw.umd.js)
 *   - terraDrawMaplibreGlAdapter (global, via terra-draw-maplibre-gl-adapter.umd.js)
 *   - map                (global, from app.js)
 */

let draw = null;
let pendingFeatureType = null; // "route" | "camp" | "waypoint"
let pendingWaypointSubtype = "scenic";

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function initDrawing(mapInstance) {
  if (typeof terraDraw === "undefined" || typeof terraDrawMaplibreGlAdapter === "undefined") {
    console.warn("terra-draw libraries not loaded — drawing tools disabled");
    return;
  }

  const { TerraDraw, TerraDrawLineStringMode, TerraDrawPointMode, TerraDrawRenderMode } = terraDraw;
  const { TerraDrawMapLibreGLAdapter } = terraDrawMaplibreGlAdapter;

  draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map: mapInstance, lib: maplibregl }),
    modes: [
      new TerraDrawLineStringMode({
        styles: {
          lineStringColor: "#e85d04",
          lineStringWidth: 3,
          closingPointColor: "#e85d04",
          closingPointWidth: 4,
          closingPointOutlineColor: "#fff",
          closingPointOutlineWidth: 2,
        },
      }),
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
    handleFeatureFinish(id);
  });
}

// ---------------------------------------------------------------------------
// Drawing mode activation
// ---------------------------------------------------------------------------

function startRouteDrawing() {
  if (!draw) return;
  pendingFeatureType = "route";
  draw.setMode("linestring");
  setActiveToolBtn("drawRouteBtn");
  showDrawingHint("Click to add points. Double-click to finish route.");
}

function startCampDrop() {
  if (!draw) return;
  pendingFeatureType = "camp";
  draw.setMode("point");
  setActiveToolBtn("dropCampBtn");
  showDrawingHint("Click on the map to place camp.");
}

function startWaypointDrop(subtype) {
  if (!draw) return;
  pendingFeatureType = "waypoint";
  pendingWaypointSubtype = subtype || "scenic";
  draw.setMode("point");
  setActiveToolBtn("addWaypointBtn");
  showDrawingHint("Click on the map to place waypoint.");
}

function cancelDrawing() {
  if (draw) {
    try {
      draw.setMode("static");
    } catch (_) {
      // safe to ignore
    }
  }
  pendingFeatureType = null;
  setActiveToolBtn(null);
  hideDrawingHint();
}

// ---------------------------------------------------------------------------
// Feature capture — move from terra-draw to trip state
// ---------------------------------------------------------------------------

function handleFeatureFinish(id) {
  const snapshot = draw.getSnapshot();
  const feature = snapshot.find((f) => f.id === id);
  if (!feature || !pendingFeatureType) return;

  const geometry = {
    type: feature.geometry.type,
    coordinates: feature.geometry.coordinates,
  };

  let properties;
  switch (pendingFeatureType) {
    case "route":
      properties = { type: "route", name: "", planned: true, notes: "" };
      break;
    case "camp":
      properties = {
        type: "camp",
        night_number: TripManager.getNextNightNumber(),
        name: "",
        notes: "",
        water_nearby: false,
        planned: true,
      };
      break;
    case "waypoint":
      properties = {
        type: "waypoint",
        subtype: pendingWaypointSubtype,
        name: "",
        notes: "",
      };
      break;
    default:
      return;
  }

  // Add to trip, render, and save
  const idx = TripManager.addFeature(geometry, properties);

  // Remove from terra-draw (we render via our own MapLibre source)
  try {
    draw.removeFeatures([id]);
  } catch (_) {
    // OK if removal fails
  }

  cancelDrawing();

  // Open the edit form for the new feature
  openFeatureForm(idx);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

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

/**
 * OutHere Map Viewer — Configuration
 *
 * Tile URLs, map defaults, and layer definitions.
 * Update TILE_URL after deploying tiles to R2.
 */

// ---------------------------------------------------------------------------
// Tile source
// ---------------------------------------------------------------------------
// Replace with your actual R2 public URL after running deploy_to_r2.py.
// Format: https://pub-{account-id}.r2.dev/utah/utah_hiking.pmtiles
//    or:  https://tiles.yourdomain.com/utah/utah_hiking.pmtiles
const TILE_URL = "https://pub-facc37c75f49450988b436c5307ce8dd.r2.dev/utah/utah_hiking.pmtiles";

// ---------------------------------------------------------------------------
// Map defaults
// ---------------------------------------------------------------------------
const MAP_CONFIG = {
  center: [-110.0, 38.5],   // lng, lat — central Utah
  zoom: 7,
  minZoom: 6,
  maxZoom: 14,
  // Utah bounding box from STATE_REGISTRY (west, south, east, north)
  maxBounds: [
    [-114.1, 36.9],  // southwest
    [-108.9, 42.1],  // northeast
  ],
  attribution:
    '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, ' +
    '<a href="https://www.usgs.gov">USGS</a>',
};

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------
// Each entry maps a UI toggle to one or more MapLibre style layer IDs.
// "group" is the source-layer name from tippecanoe; "layers" lists the
// style layer IDs that should toggle together.
const LAYER_GROUPS = [
  {
    id: "trails",
    label: "Trails",
    layers: ["trails"],
    defaultVisible: true,
    legend: [
      { color: "#2d7a2d", label: "Easy" },
      { color: "#d97706", label: "Moderate" },
      { color: "#dc2626", label: "Hard" },
      { color: "#666666", label: "Unknown" },
    ],
  },
  {
    id: "contours",
    label: "Contours",
    layers: ["contours-minor", "contours-major", "contour-labels"],
    defaultVisible: true,
    legend: [
      { color: "#b09070", label: "Major (200ft)" },
      { color: "#c4a882", label: "Minor (40ft)" },
    ],
  },
  {
    id: "pois",
    label: "Points of Interest",
    layers: ["pois", "poi-labels"],
    defaultVisible: true,
    legend: [
      { color: "#8b4513", label: "Trailhead" },
      { color: "#dc2626", label: "Summit" },
      { color: "#3b82f6", label: "Water" },
      { color: "#7c3aed", label: "Accommodation" },
      { color: "#eab308", label: "Viewpoint" },
    ],
  },
  {
    id: "water",
    label: "Water",
    layers: ["water-fill", "waterways"],
    defaultVisible: true,
    legend: [{ color: "#a5bfdd", label: "Rivers & lakes" }],
  },
  {
    id: "roads",
    label: "Roads",
    layers: ["roads"],
    defaultVisible: true,
    legend: [],
  },
  {
    id: "protected-areas",
    label: "Protected Areas",
    layers: ["protected-areas-fill"],
    defaultVisible: true,
    legend: [{ color: "#d4e8d4", label: "Parks & wilderness" }],
  },
];

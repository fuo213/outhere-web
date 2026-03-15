/**
 * OutHere Map Viewer — Layer Style Customization
 *
 * Manages user overrides for map layer paint properties (color, width,
 * dash pattern, opacity). Persists to localStorage and applies via
 * MapLibre's setPaintProperty() for instant, no-rebuild updates.
 *
 * Dependencies (loaded before this script):
 *   - LAYER_STYLE_DEFAULTS, DASH_PRESETS  (from config.js)
 *   - map                                 (from app.js, used at runtime only)
 */

const STYLE_STORAGE_KEY = "outhere_layer_styles";

// ---------------------------------------------------------------------------
// LayerStyleManager — singleton for overrides, persistence, map application
// ---------------------------------------------------------------------------

const LayerStyleManager = {
  overrides: {},

  load() {
    const saved = localStorage.getItem(STYLE_STORAGE_KEY);
    if (saved) {
      try { this.overrides = JSON.parse(saved); }
      catch (_) { this.overrides = {}; }
    }
  },

  save() {
    localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(this.overrides));
  },

  getValue(layerId, prop) {
    return this.overrides[layerId]?.[prop]
      ?? LAYER_STYLE_DEFAULTS[layerId]?.[prop];
  },

  set(layerId, prop, value) {
    if (!this.overrides[layerId]) this.overrides[layerId] = {};
    this.overrides[layerId][prop] = value;
    this.applyProperty(layerId, prop, value);
    this.save();
  },

  applyProperty(layerId, prop, value) {
    if (!map.getLayer(layerId)) return;

    if (prop === "line-width") {
      const defaults = LAYER_STYLE_DEFAULTS[layerId];
      const maxVal = defaults["line-width-max"] || defaults["line-width"];
      const ratio = maxVal / defaults["line-width"];
      // Determine zoom range from the original layer
      const minZoom = layerId === "roads" ? 8 :
                      layerId === "contours-major" ? 11 : 10;
      const maxZoom = layerId === "roads" ? 13 : 14;
      if (ratio > 1) {
        map.setPaintProperty(layerId, "line-width",
          ["interpolate", ["linear"], ["zoom"], minZoom, value, maxZoom, value * ratio]);
      } else {
        map.setPaintProperty(layerId, "line-width", value);
      }
    } else {
      map.setPaintProperty(layerId, prop, value);
    }
  },

  applyAll() {
    for (const [layerId, props] of Object.entries(this.overrides)) {
      for (const [prop, value] of Object.entries(props)) {
        this.applyProperty(layerId, prop, value);
      }
    }
  },

  resetLayer(layerId) {
    delete this.overrides[layerId];
    const defaults = LAYER_STYLE_DEFAULTS[layerId];
    if (!defaults) return;

    for (const [prop, value] of Object.entries(defaults)) {
      if (prop === "type" || prop.startsWith("has") || prop === "line-width-max") continue;
      this.applyProperty(layerId, prop, value);
    }
    this.restoreDataDriven(layerId);
    this.save();
  },

  restoreDataDriven(layerId) {
    if (layerId === "trails") {
      map.setPaintProperty(layerId, "line-color", [
        "match", ["get", "difficulty"],
        "easy", "#2d7a2d",
        "moderate", "#d97706",
        "hard", "#dc2626",
        "#666666",
      ]);
    } else if (layerId === "pois") {
      map.setPaintProperty(layerId, "circle-color", [
        "match", ["get", "poi_category"],
        "trailhead", "#8b4513",
        "summit", "#dc2626",
        "water", "#3b82f6",
        "accommodation", "#7c3aed",
        "viewpoint", "#eab308",
        "natural", "#d97706",
        "infrastructure", "#64748b",
        "#64748b",
      ]);
      map.setPaintProperty(layerId, "circle-radius", [
        "match", ["get", "priority"],
        "high", 6,
        "medium", 4,
        "low", 3,
        3,
      ]);
    }
  },
};

// ---------------------------------------------------------------------------
// DOM builder helpers — called from buildLayerControls() in app.js
// ---------------------------------------------------------------------------

/** Identify which dash preset name matches an array value. */
function matchDashPreset(arr) {
  for (const [name, preset] of Object.entries(DASH_PRESETS)) {
    if (preset[0] === arr[0] && preset[1] === arr[1]) return name;
  }
  return "dashed";
}

/** Build a labelled color picker row. */
function buildColorRow(layerId, prop, defaults) {
  const row = document.createElement("div");
  row.className = "style-row";

  const label = document.createElement("span");
  label.className = "style-row-label";
  label.textContent = "Color";
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "color";
  input.value = LayerStyleManager.getValue(layerId, prop);
  input.dataset.layerId = layerId;
  input.dataset.prop = prop;
  input.addEventListener("input", () => {
    LayerStyleManager.set(layerId, prop, input.value);
  });
  row.appendChild(input);

  const wrapper = document.createElement("div");
  wrapper.appendChild(row);

  if (defaults.hasDataDrivenColor) {
    const note = document.createElement("div");
    note.className = "style-data-driven-note";
    note.textContent = layerId === "trails"
      ? "Overrides difficulty colors"
      : "Overrides category colors";
    wrapper.appendChild(note);
  }

  return wrapper;
}

/** Build a labelled range slider row. */
function buildSliderRow(layerId, prop, labelText, min, max, step, defaultVal) {
  const row = document.createElement("div");
  row.className = "style-row";

  const label = document.createElement("span");
  label.className = "style-row-label";
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "range";
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = LayerStyleManager.getValue(layerId, prop) ?? defaultVal;
  input.dataset.layerId = layerId;
  input.dataset.prop = prop;
  row.appendChild(input);

  const valueSpan = document.createElement("span");
  valueSpan.className = "style-value";
  const isPercent = prop.includes("opacity");
  valueSpan.textContent = isPercent
    ? Math.round(input.value * 100) + "%"
    : parseFloat(input.value).toFixed(1);
  row.appendChild(valueSpan);

  input.addEventListener("input", () => {
    const val = parseFloat(input.value);
    valueSpan.textContent = isPercent
      ? Math.round(val * 100) + "%"
      : val.toFixed(1);
    LayerStyleManager.set(layerId, prop, val);
  });

  return row;
}

/** Build a dash pattern segmented control. */
function buildDashRow(layerId, defaults) {
  const row = document.createElement("div");
  row.className = "style-row";

  const label = document.createElement("span");
  label.className = "style-row-label";
  label.textContent = "Style";
  row.appendChild(label);

  const selector = document.createElement("div");
  selector.className = "dash-selector";

  const currentDash = LayerStyleManager.getValue(layerId, "line-dasharray")
    || defaults["line-dasharray"];
  const activeName = matchDashPreset(currentDash);

  for (const [name, preset] of Object.entries(DASH_PRESETS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dash-btn" + (name === activeName ? " active" : "");
    btn.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    btn.dataset.dashName = name;
    btn.dataset.layerId = layerId;
    btn.addEventListener("click", () => {
      selector.querySelectorAll(".dash-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      LayerStyleManager.set(layerId, "line-dasharray", [...preset]);
    });
    selector.appendChild(btn);
  }

  row.appendChild(selector);
  return row;
}

/** Friendly display name for a layer ID. */
function layerDisplayName(layerId) {
  const names = {
    trails: "Trails",
    "contours-minor": "Minor contours",
    "contours-major": "Major contours",
    waterways: "Waterways",
    roads: "Roads",
    "water-fill": "Water fill",
    "protected-areas-fill": "Protected areas",
    pois: "Points of Interest",
  };
  return names[layerId] || layerId;
}

/** Build all style controls for a layer group. */
function buildStyleControls(group, container) {
  for (const layerId of group.styleLayers) {
    const defaults = LAYER_STYLE_DEFAULTS[layerId];
    if (!defaults) continue;

    if (group.styleLayers.length > 1) {
      const subHeader = document.createElement("div");
      subHeader.className = "style-sub-header";
      subHeader.textContent = layerDisplayName(layerId);
      container.appendChild(subHeader);
    }

    // Color picker
    const colorProp = defaults.type === "line" ? "line-color"
                    : defaults.type === "fill" ? "fill-color"
                    : "circle-color";
    container.appendChild(buildColorRow(layerId, colorProp, defaults));

    // Width / size slider
    if (defaults.type === "line") {
      container.appendChild(buildSliderRow(layerId, "line-width", "Width",
        0.1, 8, 0.1, defaults["line-width"]));
    } else if (defaults.type === "circle") {
      container.appendChild(buildSliderRow(layerId, "circle-radius", "Size",
        1, 12, 1, defaults["circle-radius"]));
    }

    // Opacity slider
    if (defaults.type === "fill") {
      container.appendChild(buildSliderRow(layerId, "fill-opacity", "Opacity",
        0, 1, 0.05, defaults["fill-opacity"]));
    } else if (defaults["line-opacity"] !== undefined) {
      container.appendChild(buildSliderRow(layerId, "line-opacity", "Opacity",
        0, 1, 0.05, defaults["line-opacity"]));
    }

    // Dash pattern selector (line layers only)
    if (defaults.type === "line") {
      container.appendChild(buildDashRow(layerId, defaults));
    }
  }

  // Reset button
  const resetBtn = document.createElement("button");
  resetBtn.className = "style-reset-btn";
  resetBtn.textContent = "Reset to default";
  resetBtn.addEventListener("click", () => {
    for (const layerId of group.styleLayers) {
      LayerStyleManager.resetLayer(layerId);
    }
    refreshStyleInputs(group, container);
  });
  container.appendChild(resetBtn);
}

/** Accordion toggle — only one group open at a time. */
function toggleStyleControls(groupId) {
  document.querySelectorAll(".style-controls").forEach(el => {
    if (el.id === `style-controls-${groupId}`) {
      el.style.display = el.style.display === "none" ? "block" : "none";
    } else {
      el.style.display = "none";
    }
  });
}

/** Re-sync all input values in a group's style controls after reset. */
function refreshStyleInputs(group, container) {
  container.querySelectorAll("input[data-layer-id]").forEach(input => {
    const layerId = input.dataset.layerId;
    const prop = input.dataset.prop;
    const val = LayerStyleManager.getValue(layerId, prop);
    if (val !== undefined) {
      input.value = input.type === "color" ? val : val;
      // Update value display for range inputs
      const valueSpan = input.parentElement.querySelector(".style-value");
      if (valueSpan) {
        const isPercent = prop.includes("opacity");
        valueSpan.textContent = isPercent
          ? Math.round(val * 100) + "%"
          : parseFloat(val).toFixed(1);
      }
    }
  });
  // Reset dash buttons
  container.querySelectorAll(".dash-selector").forEach(selector => {
    const firstBtn = selector.querySelector(".dash-btn");
    if (!firstBtn) return;
    const layerId = firstBtn.dataset.layerId;
    const currentDash = LayerStyleManager.getValue(layerId, "line-dasharray")
      || LAYER_STYLE_DEFAULTS[layerId]?.["line-dasharray"];
    const activeName = matchDashPreset(currentDash);
    selector.querySelectorAll(".dash-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.dashName === activeName);
    });
  });
}

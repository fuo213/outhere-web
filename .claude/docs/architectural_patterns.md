# Architectural Patterns — OutHere Web

## Style Sync with Tile Pipeline

The MapLibre style in `buildStyle()` ([app.js:29-215](../../app.js#L29-L215)) is an inline copy of what `outhere/tile_generator.py` generates at `outhere/utah_maps/output/style.json`. This is intentional — it avoids an extra network request on load and lets us evolve the web style independently.

**Keeping them in sync:**
- The source-layer names (`trails`, `pois`, `water`, `roads`, `protected_areas`, `contours`) are set by tippecanoe during tile generation and cannot change without regenerating tiles.
- Property names used in filters and expressions (`difficulty`, `contour_type`, `elevation_ft`, `poi_category`, `priority`) come from the GeoJSON properties written by `outhere/osm_processor.py` and `outhere/contour_generator.py`.
- If a new source-layer is added in the tile pipeline, the web viewer needs: (1) a new layer entry in `buildStyle()`, and (2) a new `LAYER_GROUPS` entry in `config.js`.

**When to diverge:**
- Web-specific styling (hover effects, click interactions, label density) should only exist in `app.js`.
- The pipeline's `style.json` is a reference baseline — the web viewer is the canonical styling for the web.

## Layer Group System

The layer toggle UI is data-driven from `LAYER_GROUPS` in [config.js:40-97](../../config.js#L40-L97). Each group maps a single UI checkbox to one or more MapLibre style layer IDs.

```
config.js: LAYER_GROUPS[]
    ↓
app.js: buildLayerControls() → creates DOM checkboxes + legend swatches
    ↓
checkbox change event → setLayerGroupVisibility() → map.setLayoutProperty()
```

**Why groups exist:** A single conceptual layer (e.g., "Contours") may span multiple style layers (`contours-minor`, `contours-major`, `contour-labels`). The group abstraction lets users toggle them as one.

**Adding a layer group:**
1. Add MapLibre layer(s) to `buildStyle()` in app.js
2. Add a `LAYER_GROUPS` entry in config.js with:
   - `id`: unique string
   - `label`: display name
   - `layers`: array of MapLibre layer IDs to toggle together
   - `defaultVisible`: initial state
   - `legend`: array of `{color, label}` for the swatch display

## PMTiles Protocol

PMTiles is registered as a custom MapLibre protocol at [app.js:19-20](../../app.js#L19-L20):

```js
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
```

This lets MapLibre fetch individual tile ranges from a single `.pmtiles` file via HTTP range requests. The source URL uses the `pmtiles://` scheme prefix:

```
pmtiles://https://pub-xxx.r2.dev/utah/utah_hiking.pmtiles
```

The PMTiles library handles:
- Directory parsing (which byte ranges contain which tiles)
- HTTP Range request caching
- Tile decompression

**CORS requirement:** The R2 bucket must have CORS enabled for range requests. This is configured in the Cloudflare dashboard under R2 > bucket > Settings > CORS Policy.

## No-Build Architecture

The app has zero build steps:
- Dependencies loaded from CDN via `<script>` tags in [index.html:13-17](../../index.html#L13-L17)
- Config, app logic, and styles are separate files loaded directly by the browser
- Cloudflare Pages serves the directory as-is

**Script load order matters:** `index.html` loads `config.js` before `app.js` because `app.js` references globals (`TILE_URL`, `MAP_CONFIG`, `LAYER_GROUPS`) defined in `config.js`.

**When this becomes limiting:**
- If we need environment-specific config (dev vs prod tile URLs), consider a build step or runtime detection via `window.location.hostname`.
- If bundle size matters, the CDN libs (~200KB for MapLibre + PMTiles) could be self-hosted and cached via service worker.
- If we add TypeScript or JSX, we'd need a bundler (Vite is the natural choice for Cloudflare Pages).

## UI Component Patterns

### Header Bar
Fixed 48px bar at top with purple gradient matching booot-landing. Pushes MapLibre's native controls down via CSS override at [styles.css:186-188](../../styles.css#L186-L188).

### Layer Panel
Floating panel toggled by the "Layers" button. Opens/closes via CSS class `.open`. Closes on map click to avoid blocking the map. Built dynamically from config — no hardcoded DOM.

### Loading / Error States
- **Loading overlay** ([styles.css:226-260](../../styles.css#L226-L260)): Shown on page load, hidden when MapLibre fires `load` event.
- **Error banner** ([app.js:260-271](../../app.js#L260-L271)): Shown when PMTiles source fails to load. Directs user to check `TILE_URL` in config.js.

### POI Popups
Click handler on the `pois` layer ([app.js:361-382](../../app.js#L361-L382)) shows a MapLibre Popup with name, category, and elevation (converted to feet). Cursor changes to pointer on hover.

## Design Tokens

Shared across booot-landing and outhere-web:

| Token | Value | Usage |
|-------|-------|-------|
| Primary gradient | `#667eea` → `#764ba2` | Header bar, accent color, checkbox accent |
| Background | `#f8f4f0` | Map background, loading overlay |
| Text dark | `#1f2937` | POI labels, primary text |
| Text muted | `#6b7280` | Subtitles, legend text, scale bar |
| Border light | `#e5e7eb` | Dividers, loading spinner base |
| Font stack | `-apple-system, BlinkMacSystemFont, ...` | All UI text |

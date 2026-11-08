# OutHere Web — Map Viewer

Web-based hiking map viewer displaying OutHere vector tiles (PMTiles) via MapLibre GL JS. No build step, no framework, no backend — pure HTML/CSS/JS served from Cloudflare Pages.

**Live**: https://outhere-web.pages.dev
**Tiles**: Loaded from Cloudflare R2 at `pub-facc37c75f49450988b436c5307ce8dd.r2.dev`

## Design system

All UI work follows `design/` (tokens, principles, motion, components, taste
log; see `design/DESIGN.md`). The `booot-design` skill loads it automatically.
Use tokens, never raw colors; one primary action per view; screenshot visible
changes with `node design/tools/shoot.mjs` before calling them done.

## Related Repositories

- **outhere** — Tile generation pipeline ([../outhere](../outhere))
  - Processes OSM + USGS data into PMTiles
  - Generates the style.json that app.js mirrors
  - Deploys tiles to Cloudflare R2

- **booot-landing** — Marketing site ([../booot-landing](../booot-landing))
  - Landing page at booot.org
  - Email signup form

- **booot-signup-worker** — Email API ([../booot-signup-worker](../booot-signup-worker))
  - Cloudflare Worker handling signup submissions

- **booot-mobile**: React Native app (read-only trip viewer with offline maps)

## When You're Working Here

Use this repo when:
- Changing the map viewer UI (header, layer panel, popups)
- Modifying map styling (colors, line widths, label visibility)
- Adding new layer toggle controls
- Updating the tile source URL after redeployment

Don't use this repo for:
- Generating or regenerating tiles → see `outhere`
- Landing page changes → see `booot-landing`
- Adding new data layers to tiles → see `outhere/tile_generator.py`

## Tech Stack

- **MapLibre GL JS** v4.7.1 — Map rendering (CDN)
- **PMTiles** v3.2.1 — Protocol handler for single-file vector tiles (CDN)
- **Cloudflare Pages** — Static hosting, auto-deploy from `main`
- **Cloudflare R2** — Tile storage (zero egress)

## Project Structure

```
outhere-web/
├── index.html      # Entry point, CDN script tags, DOM structure
├── app.js          # Map init, style builder, layer controls, POI popups, trip + route layers
├── planning.js     # Route drawing: clicks, live routed preview, undo, legs → trip features (schema 1.1 segments)
├── routing.js      # Trail routing: decodes the region's booot-trail-graph, flatbush snapping, A* (SNAPPING_DESIGN.md)
├── config.js       # Tile URL, map center/bounds, layer group definitions
├── styles.css      # Full-screen layout, header, layer panel, responsive
└── .claude/docs/   # Detailed patterns documentation
```

### Key Files

- [config.js](config.js) — All configuration in one place
  - Line 14: `TILE_URL` — R2 PMTiles URL
  - Lines 19-32: `MAP_CONFIG` — center, zoom, bounds, attribution
  - Lines 40-97: `LAYER_GROUPS` — toggle definitions with legend colors

- [app.js](app.js) — Application logic
  - Lines 19-20: PMTiles protocol registration
  - Lines 29-215: `buildStyle()` — inline MapLibre style (mirrors outhere/utah_maps/output/style.json)
  - Lines 221-247: Map initialization with controls
  - Lines 278-355: Layer toggle panel (reads from `LAYER_GROUPS`)
  - Lines 361-390: POI click popups

- [styles.css](styles.css) — UI styling
  - Lines 34-88: Header bar (purple gradient `#667eea` → `#764ba2`)
  - Lines 94-179: Layer control panel (floating, toggleable)
  - Lines 185-220: MapLibre control overrides
  - Lines 226-260: Loading overlay with spinner
  - Lines 291-301: Mobile responsive breakpoint (480px)

- [index.html](index.html) — DOM structure
  - Lines 12-17: CDN dependencies (MapLibre, PMTiles)
  - Lines 25-35: Header bar with Layers button
  - Lines 41-46: Layer panel container (populated by app.js)
  - Lines 49-55: Loading overlay and error banner

## Build & Deploy Commands

```bash
# Local development (no build step)
python3 -m http.server 8080

# Deploy to Cloudflare Pages (auto on push)
git push origin main

# Manual deploy via Wrangler
npx wrangler pages deploy . --project-name outhere-web

# Test with local PMTiles file (no R2 needed)
ln -s ../outhere/utah_maps/output/utah_hiking.pmtiles .
# Then set TILE_URL = "utah_hiking.pmtiles" in config.js
```

## Trail routing

Routes follow real trails using the per-region routing graph the pipeline
publishes (`routing_graph` in catalog.json, format `booot-trail-graph` v1;
design in `../SNAPPING_DESIGN.md`). The graph loads lazily per region (draw
start, trip open). Where no graph exists, legs are drawn straight with
"Routing isn't available here yet." Exports write `schema_version` "1.1"
with per-leg `segments` + `routing`.

- **Dev override (localhost only):** `?graph=zion:dev-graphs/zion.trails-graph.json`
  maps a region id to a local graph file (keep `dev-graphs/` out of git).
- **Verify:** `node design/tools/shoot.mjs --scenes design/tools/scenes-routing.json`
  (add `--base https://<branch>.outhere-web.pages.dev` for a Pages preview)
  draws Angels Landing / West Rim / Hop Valley, a no-path gap, interactions
  and preview timing. On the 2026-11-07 OSM graph (zion d9883fc4) expect
  2.18 / 14.64 / 6.54 mi; distances move with OSM edits (the Feb-2026 graph
  gave 2.11 / 14.57 / 6.54 before Walter's Wiggles was re-mapped in more detail).

## Data Flow

```
R2 (utah_hiking.pmtiles) → PMTiles protocol → MapLibre GL JS → Canvas
config.js (LAYER_GROUPS) → app.js (buildLayerControls) → DOM checkboxes
checkbox change → setLayoutProperty("visibility") → MapLibre layer toggle
```

## Additional Documentation

**Before making changes:**
- [.claude/docs/architectural_patterns.md](.claude/docs/architectural_patterns.md) — Style sync with tile pipeline, layer system, PMTiles protocol

**When modifying map styling:**
- The style in `buildStyle()` must stay in sync with `outhere/tile_generator.py:327-520`
- Source layer names (`trails`, `pois`, `water`, `roads`, `protected_areas`, `contours`) come from tippecanoe layer names

**When adding a new layer:**
1. Add layer definition(s) to `buildStyle()` in [app.js:45-213](app.js#L45-L213)
2. Add a `LAYER_GROUPS` entry in [config.js:40-97](config.js#L40-L97) with layer IDs and legend colors
3. The toggle UI builds automatically from the config

**When debugging tile loading:**
- Check browser console for PMTiles fetch errors
- Verify CORS is enabled on the R2 bucket (Cloudflare dashboard)
- Error banner in [app.js:260-271](app.js#L260-L271) surfaces `pmtiles` errors to the UI

**When updating tile URL:**
- Edit `TILE_URL` in [config.js:14](config.js#L14)
- URL format: `https://pub-{account-id}.r2.dev/{state}/{state}_hiking.pmtiles`

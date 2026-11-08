# outhere-web: Booot web map + trip planner

The production web app: a MapLibre topo map of Booot's own vector tiles plus a
multi-day trip planner (draw a route, split it into days and camps, export a
trip file for the phone). Vanilla JS ES modules, no framework, no build step,
no backend. All state lives in the browser (localStorage).

- **Live:** https://outhere-web.pages.dev (Cloudflare Pages, **auto-deploys
  from `main`**; never push `main` directly, branch + PR, merge = deploy)
- **Tiles:** https://tiles.booot.org (R2 custom domain, built by `../outhere`)
- **Product name:** **Booot** on every user-facing surface. "OutHere" is the
  internal repo/code name only (identifiers and `outhere_*` localStorage keys
  stay as they are).

Ecosystem context (other repos, canonical formats, cross-repo rules):
`../CLAUDE.md`.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Use **port 8000**: it's in the R2 CORS allowlist for tiles.booot.org (8080 is
not, so tiles fail to load there). No install or build; edit and reload.

## Files

| File | What it does |
|---|---|
| `index.html` | DOM shell: planning toolbar, region switcher, trips home, trip panel, onboarding modal, layer panel. CDN `<script>`s, then `app.js` as `type="module"` |
| `app.js` | Entry. Registers the `pmtiles://` protocol, `buildStyle(region)` (inline MapLibre style), map + controls, runtime trip layers (`addTripLayers` / `restoreRuntimeLayers`), layer toggle panel, popups |
| `config.js` | `TILE_URL` (Utah fallback PMTiles), `CATALOG_URL`, `MAP_CONFIG`, `DEFAULT_REGION`, `LAYER_GROUPS` (layer toggles + legends), `LAYER_STYLE_DEFAULTS`, `DASH_PRESETS` |
| `region-picker.js` | Fetches `catalog.json` (localStorage cache, ~24h TTL, stale-while-revalidate), region switcher UI, `applyRegion()` swaps the PMTiles source via `map.setStyle()` |
| `trips-home.js` | `TripsStore`: multi-trip localStorage store (`outhere_trips_index`, `outhere_trip_<id>`, `outhere_active_trip`; migrates legacy `outhere_trip`). Trips home view: open / duplicate / export / delete / import |
| `trip-panel.js` | `TripManager` (trip data model, internal `_schema_version` 4 migrations), notebook sidebar (overview, unassigned pool, day accordion, drag-and-drop), canonical export (`buildTripExport` + `validateTripExport`), `escapeHTML` / `escapeAttr` |
| `planning.js` | Route drawing (point types route / camp / dayhike / rest, hotkeys 1-4, Shift = no snap, Esc cancels, double-click finishes), trail snapping, distances, elevation profiles |
| `layer-styles.js` | `LayerStyleManager`: per-layer color / width / dash / opacity overrides via `setPaintProperty`, persisted to `outhere_layer_styles` |
| `styles.css` | App feature styles on the design tokens (loaded after `design/tokens.css`, `motion.css`, `components.css`) |
| `ui-motion.js` | Motion wiring: `confirm` shiver on exports (delegated clicks) |
| `design/` | The Booot design system (below) |

Modules import each other circularly (`app.js` exports `map`; the others
import it). That's safe only because the imports are used at runtime, not at
module-evaluation time. Keep it that way: don't touch `map` at a module's top
level outside `app.js`.

## Dependencies (CDN, no package.json)

Classic `<script>` tags in `index.html`, used as globals from the modules:

- `maplibregl`: MapLibre GL JS 4.7.1 (unpkg)
- `pmtiles`: PMTiles 3.2.1 (unpkg)
- `turf`: Turf 6.5.0 (jsDelivr), used by snapping and distances
- Google Fonts: Playfair Display, DM Sans, IBM Plex Mono

Runtime network calls: tiles.booot.org (catalog + PMTiles range requests),
MapLibre demotiles for glyphs/sprite, and the free Open-Meteo elevation API
(`fetchElevationProfile` in `planning.js`). Keep new dependencies open and
free (see product principles in `../CLAUDE.md`); pin exact versions.

## Tiles, regions and style

- `catalog.json` at `https://tiles.booot.org/catalog.json` lists regions (built
  by `outhere/catalog_generator.py`; the mobile app reads the same file). Each
  region's `url` is a PMTiles file under `https://tiles.booot.org/{state}/`.
  If the catalog has never loaded, the app boots on `DEFAULT_REGION` (Utah,
  `TILE_URL`).
- **Style:** `buildStyle()` is a hand-maintained inline copy of the canonical
  pipeline style (`outhere/tile_generator.py` `create_style_spec()`, published
  as `tiles.booot.org/{state}/metadata/style.json`). The app does not fetch
  `style.json`. This is known drift: change the pipeline style first, then
  mirror it here. Source-layer names (`trails`, `pois`, `water`, `roads`,
  `protected_areas`, `contours`) and properties come from the pipeline.
- **`map.setStyle()` wipes runtime sources/layers** (trip rendering, drawing
  and snap previews). Anything added outside `buildStyle()` must be re-added
  in `restoreRuntimeLayers()` (`applyRegion()` calls it after a region switch).
- **Adding a map layer:** add it to `buildStyle()`, then a `LAYER_GROUPS`
  entry in `config.js` (toggle + legend UI builds from it), and a
  `LAYER_STYLE_DEFAULTS` entry if it should be user-stylable.

## Trip format

Exports must match the canonical trip format in `../outhere/trips/`
(`trip.schema.json` + `FORMAT.md`, `schema_version: "1.0"`; read FORMAT.md's
Drift section first). Don't invent fields: extend the schema in `outhere`
first. `buildTripExport()` stamps `schema_version` and mirrors `readme` into
`notes`; `validateTripExport()` is a lightweight structural self-check, not a
full schema validator, so validate real exports against the schema after
touching export code. The internal `_schema_version` (4) is a separate
localStorage migration counter.

## Trail snapping (being replaced)

`planning.js` snaps to rendered tile geometry
(`queryRenderedFeatures` on the `trails` layer + Turf), so results depend on
zoom and on clipped, simplified tile geometry. It's slated to be replaced by
routing on a per-region trail graph built by the pipeline. See `../SNAPPING_RESEARCH.md`
before working on snapping; don't invest in the render-tile approach.

## Design system

All UI work follows `design/`:

- `DESIGN.md`: principles (each with a test), color/type rules, motion, voice
- `decisions.md`: taste log (confirmed / trying / rejected); read before UI
  work, append when Vincent confirms or rejects something
- `tokens.css`: the only place raw values live; `components.css`,
  `motion.css`, `motion.js`: reuse these
- `specimen.html`: live reference at http://localhost:8000/design/specimen.html
- `tools/shoot.mjs`: screenshot harness (Node 22+, system Chrome, starts its
  own server on :8000): `node design/tools/shoot.mjs [--only planner]`
- `skills/`: sources of the `booot-design` (applied automatically to UI work)
  and `/design-review` skills

The app is on the tokens (Phase 1b): `index.html` links the design CSS
before `styles.css`, and `styles.css` has no raw hex/rgba/px font sizes. The
only raw colors left in the app are map paint (`buildStyle()` in `app.js`,
`config.js` legends/style defaults, `layer-styles.js`), which belong to the
pipeline map style. New buttons/cards go in the press/lift selector list at
the top of `styles.css`; screenshot visible changes before calling them done.

## Gotchas

- **XSS:** `escapeHTML` escapes `& < >` but **not quotes**. Use `escapeAttr`
  for anything interpolated into an HTML attribute.
- **Headless verification:** a hidden or background browser tab freezes
  `requestAnimationFrame`, so MapLibre never fires `load`. Use the rAF shim
  from gotcha #5 in `../BOOOT_NEXT_STEPS.md` (and remove it before
  committing), or real headless Chrome as `shoot.mjs` does.
- **Caching checks:** test Cloudflare caching with a ranged GET, not HEAD.
- **CORS / cache rules** on tiles.booot.org are Cloudflare-dashboard settings
  Vincent changes; they're not in any repo.
- `window.__outhere = { map, TripManager }` is exposed for console debugging
  only.

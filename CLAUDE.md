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
| `trip-panel.js` | `TripManager` (trip data model, internal `_schema_version` 4 migrations), notebook sidebar (overview, unassigned tray, continuous day story, drag-and-drop, inline stop editing), canonical export (`buildTripExport` + `validateTripExport`), `escapeHTML` / `escapeAttr` |
| `itinerary-profile.js` | Pure: `buildItinerary(trip)` (day-by-day model: miles from geometry, elevation from each route's `elevation_profile`, stops projected onto the route) and `drawProfile()` (the sketchbook elevation profile as SVG, drawn at the real pixel width) |
| `itinerary-panel.js` | The sticky profile in the trip panel: active day (IntersectionObserver), band click to scroll, compact strip while drawing, the `booot:active-day` signal |
| `sketch.js` | The drawing kit: ink strokes, pencil hatching, paper grain, the hand-drawn glyph family (also used as stop icons) |
| `planning.js` | Route drawing (point types route / camp / dayhike / rest, hotkeys 1-4, Shift = straight leg, Esc cancels, double-click finishes), live routed preview, undo, gap card, legs → trip features (schema 1.1 `segments`), elevation profiles |
| `map-trip-style.js` | How the trip is drawn on the map (itinerary direction B, "Trip chart"): inked route on a paper casing, colored-pencil `line-pattern` band per day, glyphs (tent, drop, day-hike arrow, start/end rings, gap pin), circled day numerals, italic labels, all rasterized at runtime with `map.addImage`. Drawing/preview leg styles. Active-day highlight (feature-state) + the `booot:active-day` event |
| `gpx-core.js` / `gpx-import.js` | GPX import. Core is pure (parse via DOMParser, 1.5 m simplification, recorded-elevation profile and gain/loss with a 3 m hysteresis, route feature with `segments: [{mode:"imported"}]` + `source`). Import wires the trip panel: Import GPX (multi-select), drop files on the panel, "Assign by date". Client-side only; recorded elevation beats Open-Meteo for imported routes |
| `gpx-match.js` / `route-names.js` | Pure. `matchTrack(graph, coords)` map-matches a recording to the routing graph (resample ~17 m, nearest way within 25 m, sticky to the previous way, junction/GPS-gap noise merged) and returns name runs + OSM way ids + a loop flag. `route-names.js` holds the auto-name rules (`deriveNameFromRuns`, `deriveImportedName` with loop names, `isGenericRouteName`), shared by planning.js and GPX import. Test: `FLATBUSH_DIR=<dir with node_modules/flatbush> [ZION_GRAPH=<graph json>] node design/tools/test-gpx-match.mjs` |
| `osm-report.js` | Pure "Fix the map" logic: note text builders (gap + general problem, always ending with a Booot signature line), duplicate check (`nearbyNotesUrl` / `parseNotes`), `createNote` (anonymous POST to `{api}/api/0.6/notes.json`, typed `NoteError` kinds, optional `authHeaders` slot for a later OAuth path), `ReportedSpots` localStorage store (`outhere_osm_reports`, 75 m, per API base), iD link (`osmEditUrl`: `/edit?editor=id#id=w<way>&map=19/lat/lon`), `resolveOsmApiBase`. Test: `node design/tools/test-osm-report.mjs` |
| `report-ui.js` | The report dialog (checks existing notes, editable text, send, sent/error/reported states), the pick-a-spot flag control (`#reportBtn`) and right-click entry. All OSM-provided text via `textContent`. Gap card wiring is in `planning.js` `showGapCard` |
| `routing.js` | Trail routing: loads the region's `booot-trail-graph`, flatbush snapping (meters), A* |
| `elevation-dem.js` | Pure: elevation for routed legs from our own USGS 3DEP data. Loads the graph's `booot-trail-elev` sidecar (`routing_graph.elevation` in the catalog) and `profileForRoute(route, graph, { fill })` returns `{ profile_ft, gain_ft, loss_ft, spacing_m, source }` or null |
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
- `turf`: Turf 6.5.0 (jsDelivr), still loaded; routing no longer uses it
- Flatbush 4.4.0: ES-module import from jsDelivr in `routing.js` (spatial index for snapping)
- Google Fonts: Playfair Display, DM Sans, IBM Plex Mono

Runtime network calls: tiles.booot.org (catalog + PMTiles range requests),
MapLibre demotiles for glyphs/sprite, and the free Open-Meteo elevation API
(`fetchElevationProfile` in `planning.js`), which is only the fallback: where
a region's graph ships an elevation sidecar, trail legs get their profile
from it with no API call (see "Elevation" below). Keep new dependencies open and
Runtime network calls: tiles.booot.org (catalog, PMTiles range requests and
map glyphs under `fonts/`), and the free Open-Meteo elevation API
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

## Itinerary panel and the active-day signal

The trip panel is one scroll area (`#notebookPanel`): the sketchbook
elevation profile (`#itineraryProfile`, `position: sticky`) on top, then the
overview, the unassigned tray (only shown when it holds something, while you
drag, or while drawing) and the days as one continuous story
(`design/itinerary.css`). The day whose section crosses a line just below the
profile is the **active day**; its band is highlighted on the profile.

**Active-day signal (contract with the map; keep it exact):**

```js
window.dispatchEvent(new CustomEvent("booot:active-day", {
  detail: { dayIndex /* 0-based number or null */, dayId /* trip.days[i].id or null */, source: "panel" },
}));
```

- The panel dispatches it whenever the active day changes because of the panel
  (scrolling, clicking a band, opening another trip -> `null`).
- Anyone else (the map sends `source: "map"`, e.g. when a day's route segment
  is clicked) can dispatch the same event; the panel scrolls that day under the
  profile and does **not** echo it back. Listeners must ignore their own
  `source` to avoid loops. `dayId` wins over `dayIndex` when both are given.
- "Show on map" in a day's edit row is separate: it zooms to the day and dims
  the other days (`setActiveDayHighlight`).

## Trip format

Exports must match the canonical trip format in `../outhere/trips/`
(`trip.schema.json` + `FORMAT.md`, `schema_version: "1.1"`; read FORMAT.md's
Drift section first). Don't invent fields: extend the schema in `outhere`
first. `buildTripExport()` stamps `schema_version` and mirrors `readme` into
`notes`; `validateTripExport()` is a lightweight structural self-check, not a
full schema validator, so validate real exports against the schema after
touching export code. The internal `_schema_version` (4) is a separate
localStorage migration counter.

## Trail routing

Routes follow real trails using the per-region routing graph the pipeline
publishes (`routing_graph` in catalog.json, format `booot-trail-graph` v1;
design in `../SNAPPING_DESIGN.md`). The graph loads lazily per region (draw
start, trip open) and one throwaway route warms A* up right after it loads.
Where no graph exists (`no_graph`, `cross_region`), legs are drawn as plain
route lines: no pin, no flagged styling; one quiet hint per page load names
the routed areas (from the catalog). The export still records `mode:
"straight"` + `reason`. Only a real OSM gap (`no_path` inside a routed area)
gets the dotted leg, gap pin and "fix it in OpenStreetMap" card. The Layers
panel has a "Routed areas" toggle (default off) outlining catalog regions
with a `routing_graph`. Exports write `schema_version` "1.1" with per-leg `segments` +
`routing`.

- **Auto names:** when a route or spur is finished with no name,
  `deriveRouteName()` (planning.js) names it from the OSM trail names it
  follows, weighted by length (`route()` returns per-name `runs`; not
  exported). If it ends on a different named trail (at least 0.1 mi or 5%),
  the name is "Dominant to Destination" ("West Rim Trail to Angels Landing"). It sets `name_auto: true` (the schema allows extra route
  properties); the panel's save drops that flag when the user types a
  different name. Re-derive only while `name_auto` is true. The destination
  must be the trail the route *ends* on (the trailing run, unnamed bits
  allowed), not one it merely crossed earlier. The rules live in
  `route-names.js`.
- **Imported routes** (`applyTrailMatch` in gpx-import.js): when the region has
  a routing graph, a GPX recording is map-matched to it (`gpx-match.js`); the
  matched OSM way ids go on its imported segment (`osm_way_ids`), and a
  made-up or device name ("May 3 · 1.3 mi", "Wayne County Hiking") becomes
  "Dominant to Destination" with `name_auto: true`. A distinctive GPX name is
  kept. A loop (ends within 150 m of the start, or turns around after its farthest
  point and ends under 20% of the distance walked from its start; a one-way
  switchback climb is not a loop) is named "Out to Place" when the farthest
  point is on a place-like trail other than the dominant one, else
  "Dominant loop". No graph or under half the track matched: left as is.
- **Dev override (localhost only):** `?graph=zion:dev-graphs/zion.trails-graph.json`
  maps a region id to a local graph file (keep `dev-graphs/` out of git).
- **Elevation** (`../SNAPPING_DESIGN.md` §5): order of trust is recorded GPX
  `<ele>`, then our 3DEP sidecar, then Open-Meteo. `fetchElevationProfile`
  tries `profileForRoute` first: routes with `trail` legs in a region whose
  `routing_graph.elevation` is set get a profile sampled every 10 m from the
  sidecar, smoothed over 100 m, with gain/loss by the same 3 m hysteresis as
  recordings, stored at one sample per 25 m (up to 1,000). Straight and manual
  legs on such a route are filled from Open-Meteo (one request);
  `elevation_source` records which (`usgs-3dep`, `mixed`, `open-meteo`).
  Anything else (no sidecar, no trail legs) takes the old Open-Meteo path.
  With the `?graph=` dev override the sidecar is the file next to the graph
  (`dev-graphs/zion.trails-elev.json`). `window.__outhere.elevation.last`
  says what the last profile came from. Tests:
  `FLATBUSH_DIR=<dir with node_modules/flatbush> node design/tools/test-elevation-dem.mjs`.
- **Demo trip:** "See a demo trip" (trips home and the new-trip dialog) or `?demo=spanish-bottom` opens `design/fixtures/spanish-bottom-2026.trip.geojson` as a throwaway copy (`TripManager.openDemo`: never saved; banner with "Make it your own" / Close). `?demo=maze` stays dev only. Never commit `.gpx` files or `design/fixtures/local/` (git-ignored).
- **Verify:** `node design/tools/shoot.mjs --scenes design/tools/scenes-routing.json`
  (add `--base https://<branch>.outhere-web.pages.dev` for a Pages preview)
  draws Angels Landing / West Rim / Hop Valley, a no-path gap, interactions
  and preview timing. On the 2026-11-07 OSM graph (zion d9883fc4) expect
  2.18 / 14.64 / 6.54 mi; distances move with OSM edits (the Feb-2026 graph
  gave 2.11 / 14.57 / 6.54 before Walter's Wiggles was re-mapped in more detail).

## Fix the map (OSM Notes)

Gap card and a general "Report a map problem" (flag control, right-click) post an
anonymous OSM Note after the user reviews the text; nothing is sent without
the Send click. **Never test against production OSM.** `OSM_API_BASE`
(`config.js`) is `https://api.openstreetmap.org` unless `?osmapi=sandbox` is on
localhost or a `*.outhere-web.pages.dev` preview, which switches to
`https://master.apis.dev.openstreetmap.org` (the dialog then shows a "Test mode"
line; reported spots are stored per API base). `routing.js` `gapFor()` now also
returns `ways` (OSM id, name, highway) and `dist_m` for the note text. Scenes:
`design/tools/scenes-report.json` (use `--base <preview>`; they post to the
sandbox). Sign-in (OAuth) is not built: pass `authHeaders` to `createNote`.

## Trip on the map and the active day

`map-trip-style.js` owns every trip layer on the `trip` source (ids
`trip-chart-*`, plus `trip-gap-pins`). Route geometry is drawn exactly as
routed; the hand-drawn feel comes only from images (pencil band pattern,
glyphs, numerals, labels) generated on canvas at the device pixel ratio.
Numerals and labels are created on demand in `styleimagemissing`
(`booot-day-<n>`, `booot-lbl:<kind>:<name>`). planning.js
`buildRoutingOverlay()` passes its leg features through
`tripChartOverlay(trip, legs)`, which adds `day_index` / `tone` / `fid` and
the chart's own features (`route_line`, `chart_point`, `day_mark`,
`trip_ring`, `spur_end`). The `trip` source uses `promoteId: "fid"` so the
highlight is feature-state only (no source rebuild). GeoJSON sources
stringify array properties: drive offsets from scalar properties.

**Active day contract** (shared by the trip panel and the map):
- Event: `window` `CustomEvent("booot:active-day", { detail: { dayIndex, dayId, source } })`.
  `dayIndex` is 0-based or `null`; `dayId` is the trip day's `id` or `null`
  (`dayId` wins when both are given). Both `null` = no active day (all days
  shown evenly). `source` names the sender (`"panel"`, `"map"`, …).
- The map listens: the active day's pencil band and ink strengthen, other
  days (and unassigned routes) mute. If most of the day is off-screen
  (beside the open panel), the camera eases to it (instant under reduced
  motion); otherwise the camera doesn't move.
- Clicking a day's line or numeral on the map makes it active (clicking the
  active day again clears it) and dispatches the same event with
  `source: "map"`. Listeners should ignore their own events; the map
  ignores the events it dispatched.


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

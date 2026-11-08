# Itinerary explorations (2026-11-08)

Vincent's note: the planner "feels somehow old". The days are boxed, collapsed
accordions, so the trip never reads as one story. He'd like hand-drawn,
map-like charts of the itinerary, done in the style of an artist with pens and
colored pencils, and calm rather than cartoony.

These are static pages, not the live planner. Each one shows the 520 px trip
panel with the real Maze demo trip (`design/fixtures/demo-maze-chocolate-drops.trip.geojson`),
and each one works at phone width. The exploration bar at the top switches between
the directions and four states: default, hover day 2, dragging a pill into a
day, and an empty day.

| Page | Direction |
|---|---|
| `sketchbook.html` | **A · Sketchbook profile** (recommended) |
| `chart.html` | B · Trip chart |
| `journal.html` | C · Field journal |

Serve the repo (`python3 -m http.server 8000`) and open
`/design/explorations/itinerary/`. On a Pages branch preview the paths drop
the `.html`.

## How the drawings are made

Everything is drawn from data, with no invented squiggles and no filters that make lines jitter.

- **Shapes are real.** Profiles come from each route's `elevation_profile`
  (USGS 3DEP, sampled the way the planner samples). Plan views use the routed
  geometry, projected and simplified. Contours are real 80 ft contours from the
  3DEP DEM (`maze-contours.json`, 225 KB, generated once).
- **Ink** (`inkStroke` in `itin.js`) is a filled outline, not a stroke. Its
  width changes slightly the way pen pressure does, it tapers at the ends, and
  it has a sub-pixel tremor built into the path data. Every line uses the same
  pen: the route, the baseline, leader lines and glyphs.
- **Colored pencil** is two layers: an even light pass, then procedural hatching
  (spacing, angle and pressure vary slightly) masked by a paper-grain
  `feTurbulence`. Under a profile, the pressure eases off toward the baseline.
  The pencil sits slightly out of register with the ink, as it does on paper.
- **Glyphs** are one hand-drawn family, drawn as custom paths with the same
  pen: tent (camp), drop (water), asterisk (viewpoint), cliff step (pour-off),
  mug (meal), benchmark triangle (high point), teal arrow (day hike), ringed
  dot (start/finish). The same glyphs appear in the drawing and in the stop
  lists, so the drawing and the text match.
- **Color comes from tokens.** Day bands alternate sage and dust pencil. Glyph
  fills use the type colors (camp gold, water blue, day-hike teal). Rust
  appears only on "Download trip". The new values are in the `EXPLORATION`
  block at the bottom of `itin.css`.
- **Fonts stay strict.** Annotations are DM Sans (italic for place names, as
  on a map), numbers are Plex Mono, and the trip title is the only Playfair.
  Nothing is smaller than 11 px: the SVG is re-rendered at the container's
  real pixel width, never scaled down.

## A · Sketchbook profile (recommended)

**Pitch:** the elevation profile of the whole trip as the hero, drawn like a
page from a good trail journal. A fineliner line, a colored-pencil band for
each day, and small inked glyphs placed on the line: tents where you sleep,
drops at water, the day-hike arrow leaving Chimney Rock, and a dotted stretch
labeled "not in OSM" where the Chocolate Drops trail doesn't connect. Below
it, the days run as one continuous story in the Paper timeline anatomy
(label, date, pencil rule, totals, then title, notes and stops), with no boxes
or accordions. Hovering a day lights up its band. Edit actions appear on hover
or focus, and stay visible on touch.

**Why it's the lead:** for a backpacker the profile answers the real question
("how hard is each day, and where do I sleep?"), and the map next to the panel
already shows the plan view. It is also the closest match to Vincent's
"colored pencils and pens" note, and it holds up at 390 px.

**To build it into the planner:**
1. Move `itin.js`'s drawing kit (inkStroke, hatch, pencil defs, glyphs) into
   an app module (e.g. `sketch.js`, ~350 lines, no dependencies).
2. Replace the accordion in `trip-panel.js` `renderDaySections()` with the
   continuous day list. The profile is built by joining each day's route
   `elevation_profile`. That already exists, so no schema change is needed.
3. Connect hover/focus on a day to the existing `setActiveDayHighlight()` map
   dimming and to the figure's band highlight.
4. Glyph positions come from projecting each stop onto its day's route (the
   `alongMi` helper). Days with several routes, or no route, need a rule
   (concatenate in day order; an empty day gets a flat pencil gap).
5. Meals: the mug is derived from "lunch" in a note here. A real version
   needs data, e.g. a `meal` waypoint subtype (schema change first, per
   `outhere/trips/FORMAT.md`).
6. Re-render on resize and on elevation fetch (the profile arrives async).
   Cost: about 30 SVG paths per day plus two filters; it renders in a few ms.

## B · Trip chart

**Pitch:** a plan-view chart of the whole route at the top of the panel, like
a hand-inked trail map over real contours. The route is traced in fineliner
over colored-pencil highlighter, one tone per day, with circled day numerals,
tents, drops, a dashed teal spur, a scale bar and a north arrow. Below it are
compact day rows: numeral, title, camp, totals, two lines of notes, and a
glyph strip of the day's stops. Hovering a row highlights that day's
stretch.

**Trade-off:** it is the most beautiful single picture, but it repeats the
real map 8 px away, and in the planner the map is supposed to be the hero.
It would earn its place in two other spots: the **printed/exported trip
sheet** and the **mobile trip overview** before going offline. Building it
needs a contour source in the app (the tiles already have contours; the
chart could also skip them and draw only the route).

## C · Field journal

**Pitch:** the Paper "Timeline" revived. Each day is a label, date, 1 px rule
and totals, then a small inked sketch of only that day's route next to its
title, notes and stops. The rest of the trip shows faintly at the edges.
It reads like a journal written after each day.

**Trade-off:** it is the calmest option and the easiest to build (reuses B's
renderer per day). But four small maps make a lot of repeated texture, and
each sketch is too small to use for route finding. A good fallback if A's
profile turns out to be too much drawing for daily use.

## Recommendation

Build **A**. Use its continuous day story in all cases, since that alone fixes
most of the "old" feeling: no accordions, no boxed cards, one column you read
top to bottom. Keep B's chart renderer for the export sheet and for mobile
later. Drop C, or keep it only as the fallback described above.

## Open questions for Vincent

1. Is A's level of drawing right for the planner, or should the sketch fade
   back once you start editing (e.g. a compact strip while drawing routes)?
2. Day bands alternate sage and dust. Sage already means "route" and dust
   means "rest". Is that acceptable, or should days use one pencil color with
   different hatch angles?
3. Meals: do you want meal stops as real data (a `meal` waypoint subtype),
   or only drawn when a note mentions lunch or dinner?
4. Should the drawing be its own exportable artifact (PNG/PDF "trip page")?
   B's chart and A's profile would both work printed.
5. Off-network legs: the dotted stretch and "Fix it in OSM" link are a
   give-back hook. Should the link open the OSM editor at the gap, or a short
   how-to first?

## Demo trip

`design/fixtures/demo-maze-chocolate-drops.trip.geojson`, schema 1.1, valid
against `outhere/trips/trip.schema.json`. Load it in the app with
`?demo=maze` (localhost and Pages branch previews only), or with "Load trip".
It is routed on the live `maze-district` graph (1a03b49c) with the planner's
own A* (`routing.js` from `feat/graph-routing`, run in Node). The build
script and click plan are in `design/fixtures/src/`.

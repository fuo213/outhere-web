# Booot Taste Log

How the design system learns. Newest entries at the top of each section.
Claude: read this before UI work; append to it when Vincent confirms or
rejects something (date, what, why, where it shows up). Don't silently
change tokens or principles. Propose, then log.

**Tiers**
- **Confirmed**: Vincent has seen it and wants it. Locked until a new
  decision overrides it. Reflected in `tokens.css` / `DESIGN.md`.
- **Trying**: in the system as the current default but not yet validated on
  real screens. Follow it; flag friction.
- **Rejected**: tried or considered and decided against. Don't reintroduce
  without a new reason.
- **Explorations**: ideas Claude tried creatively during a task that went
  beyond the system. Each one waits for a verdict and then moves up or down.

---

## Confirmed

- **2026-11-07 · Design system v0.1 direction approved.** Vincent reviewed
  DESIGN.md, the tokens and the specimen and likes the direction. The
  "Trying" items below stay as defaults until real screens validate them.
- **2026-11-07 · No animation for its own sake; loading is the exception.**
  Waiting moments may be more expressive. See DESIGN.md "Loading states".
- **2026-11-07 · Name is "Booot"** on every user-facing surface. OutHere is an
  internal repo name only. *Why:* matches booot.org.
- **2026-11-07 · Web design leads, mobile follows.** Settle the visual and
  interaction language in the web planner first, then carry it to iOS.
- **2026-11-07 · Playful-but-purposeful interactions.** The flip button
  (slot-machine label on hover) and the click shiver from the March Paper
  work are the right spirit. Restored as the `flip` and `confirm` verbs.
- **2026-03 · Field-notebook palette.** Parchment surfaces, near-black ink,
  NPS rust accent, earthy point-type colors. (Paper file, see
  `reference/paper-extraction-2026-03.md`.)
- **2026-03 · Playfair Display for the trip title.** Gives it cartographic
  character.
- **2026-11-11 · Delete on the line, and the redraw point.** Click selects a
  section; Delete trims an end or leaves a straight gap in the middle. The
  gap's first anchor gets a rust ring on paper with a "Redraw from here" map
  label (tap to redraw forward from there); a straight section's menu offers
  "Redraw this section" and "Snap to trails". Vincent: "working perfect".
  *Why:* drawing only runs forward along the trip, so the map has to show
  where a redraw starts.
- **2026-11-11 · POI colours and sizes after the category fix.** Vincent
  reviewed the rebuilt Utah tiles: likes seeing every point of interest, and
  the large red peak dots are not too loud. Leave the pipeline POI style as is.

## Trying

- **2026-11-08 · Itinerary explorations: continuous day story + hand-drawn
  charts** (awaiting Vincent's pick). `design/explorations/itinerary/`
  (A sketchbook profile, B trip chart, C field journal; README has pitches
  and build notes). Response to "the planner feels somehow old": days read
  as one continuous story (Paper timeline anatomy: label, date, rule,
  totals) instead of boxed accordions; edit actions appear on hover/focus.
  Drawings are built from real data (route geometry, 3DEP profile and
  contours) with a restrained "hand": variable-width ink outlines with
  baked-in tremor, colored-pencil hatching masked by paper grain, one
  family of custom glyphs. Vincent relaxed "no sketchy filters" for this,
  on the condition that it stay disciplined (pencil grain yes, jitter no). Recommendation: A. Open
  questions: day bands reuse sage/dust (route/rest meanings); meal stops
  need data; whether the drawing should compact while editing.

- **2026-11-07 · Phase 1b app migration calls** (seen on real screens in
  the 1b PR, awaiting Vincent's review):
  - No badge above titles: "TRIP PLANNER", "TRIP JOURNAL", "NEW TRIP" removed
    (per the rejected micro-label pattern). Trip title and close share a row.
  - Trip panel primary = "Download trip (.geojson)"; export notes / load /
    new trip are ghost buttons in one row. "New trip" is no longer red: it
    doesn't destroy anything (the current trip stays saved).
  - Active point-type tool and tile Save fill with `--type-*-text` (white on
    the light `--type-*` fills was 2.1:1 for camp).
  - Layers button "open" state uses the accent like the Plan button, not teal
    (teal means dayhike).
  - Notes editors in DM Sans, not Plex Mono (mono is for numbers only).
  - Elevation loss in `--text-secondary`, not rust (one rust per view);
    instruction keywords in ink, not rust.
  - "Overview" and "Day 1" rows are sentence case; the tracked label is kept
    for real section headers (Unassigned, Layers, Regions).
  - Scrims lose the 2px backdrop blur; panels lose the faint ruled-paper
    texture (both read as decoration; the ruling was nearly invisible).
  - Layer panel sits above the planning toolbar (they overlapped before).
- **2026-11-07 · Three type families with strict jobs** (Playfair titles /
  DM Sans UI / Plex Mono numbers). Source Serif 4 dropped from UI.
- **2026-11-07 · 11px type floor** and only one tracked-uppercase style.
- **2026-11-07 · Six motion verbs** (press, lift, confirm, flip, draw, count)
  with token durations; nothing moves when idle.
- **2026-11-07 · One primary action per view.** In the trip panel that's
  "Send to phone"; everything else moves to quiet buttons or an overflow menu.
- **2026-11-07 · Muted text (ink-400) only at ≥14px**; ink-300 never as text.

## Rejected

- **2026-11-07 · Purple gradient brand** (old landing page `#667eea → #764ba2`).
  Generic, unrelated to the product.
- **2026-11-07 · Tracked uppercase micro-labels everywhere** ("TRIP PLANNER"
  badges, 9–10px caps). Reads as template/AI-generated.
- **2026-11-07 · Four equal-weight action buttons** stacked at the bottom
  of the trip panel. No hierarchy.
- **2026-11-07 · Emoji as icons** (landing page feature cards).
- **2026-11-07 · Features we don't ship in marketing copy** (photo
  breadcrumbs, partner sharing, Oregon/Washington coverage).

## Explorations (awaiting verdict)

- 2026-11-08 · **Line + stops planner (POC, trip format 1.2)** · branch
  `poc/line-stops`, new trip in Zion · the draw tool only draws the line
  (no point types); a separate pin tool drops stops (keys 1-6, pills reuse
  the point-type selector, active fill = the type's text shade, ink for
  hazard/viewpoint/note). Stops open a small paper menu on the map (name,
  nights stepper, water source/reliability selects, Out/Back segmented
  toggle, "Day hike from here" quiet, Move ghost, Delete in danger ink).
  Clicking the line opens a three-item list ("Add a camp here", "Redraw from
  here", "Return the same way"). While redrawing, the stretch that will go
  is washed out with paper and dashed rust; hovering the old line shows
  "Rejoin your line here" and shrinks the rust stretch to what will really
  be removed. Every edit says what happened in an ink toast with Undo; a stop
  pushed off the route gets a rust dot in the toast and a rust-ruled note at
  the top of the itinerary ("Camp 2 is off your route now"). Day titles read
  "Camp 1 to Camp 2"; rest days "Rest day at Camp 2". New glyph: `note` (a
  slip with a folded corner) in sketch.js; breaks use the rest glyph.
  Why: days come from where you sleep, so the itinerary builds itself.
  Round 2 (2026-11-10): older trips are never switched on open. Trips with
  one routed line get a quiet block under the days, one sentence on what
  changes and a quiet "Switch to line and stops" button; the toast offers
  Undo. Off-route copy is per kind: a camp's "night doesn't count until it's
  back on the line"; a break is "listed at the nearest mile until you move
  it back onto the line". Edit toasts add a second sentence when the way
  back followed ("The way back follows the new way out") or was left alone
  ("You edited the way back by hand, so it stays as it is").

- 2026-11-08 · **Trip chart on the real map** (direction B carried onto the
  planner map): the route is a clean ink line (`--ink-900`, ~2.4 px at z13,
  round caps/joins) on a thin `--surface-raised` casing; each day's stretch
  gets a colored-pencil band underneath (`line-pattern` drawn on canvas at
  runtime: light even pass, -62° hatching, ragged edges, paper tooth),
  alternating `--sage-500` / `--dust-500` like B. Unassigned routes are ink
  only. Geometry is exact; the hand lives in the pencil, glyphs, numerals
  and labels. Circled day numerals in Plex Mono (numbers job) at each day's
  start, set behind the way the day leaves. Glyphs from the sketchbook
  family: tent (camp gold), drop (water), teal day-hike arrow + dashed teal
  spur, ringed-dot start, target end, scenic asterisk, hazard step; minor
  glyphs wait for z12. Camp names in italic DM Sans (map convention for
  places), others from z12.5, with MapLibre collision. Shift legs are dashed
  ink; real OSM gaps stay rust, dotted, with a hand-drawn rust ring pin.
  While drawing, placed legs are inked and the live preview is a lighter
  pencil line (`--ink-400`), so a click reads as inking it. Active day:
  band and ink strengthen, other days mute to ~30-50%. **Same styling
  outside planning mode** (panel closed, trips home behind the modal): the
  chart is the trip's identity and reads calmly at every zoom, so a lighter
  variant would only add a second look to learn · planner with `?demo=maze`,
  `map-trip-style.js` · Vincent: B "is how we should show the actual route
  inside of the main map". Open: sage band on the green protected-area fill
  is quieter than dust; whether day bands should keep reusing sage/dust.

- 2026-11-08 · **Direction A in the real planner, with Vincent's sticky
  profile** · trip panel, `?demo=maze` (localhost / Pages previews) ·
  Vincent: "the profile should scroll down with us … the day planning sort of
  disappears behind it." Calls made while building it:
  - **Sticky profile + active day.** The profile is `position: sticky` at
    the top of the panel's scroll area; days scroll under it and fade out
    behind a short paper fade (`--itin-fade`, 24 px). The fade is the one
    gradient in the panel: it's functional (content passing under paper), not
    decoration. The active day is the section crossing a line 12 px below the
    profile. Its band gets a second, denser pencil pass; the other bands drop
    to 50 % and their tags to 55 %. With few days the active tag gets a pencil
    underline in its day tone; with many days (bands too narrow for "Day N"),
    tags become numbers and the active day's "Day N · x mi" appears on its own
    row with a small pencil caret, so it never collides with a neighbor.
    Clicking a band scrolls to that day (smooth, instant under reduced motion).
    A tail spacer lets the last day reach the line.
  - **Compact strip while drawing.** While a route is being drawn the profile
    collapses to a 46 px strip: bands, the ink line, tents and day numbers, no
    lettering, no axis, no caption. The map leads while you draw; the strip
    keeps the trip's shape in view, and the live distance stays in the tray
    chip. It restores when drawing ends (finish or Esc). Delete mode keeps the
    full profile.
  - **Day bands stay sage/dust** (exploration's choice). In the real panel
    they read as "this day / next day", not as route/rest: the bands are
    pencil texture inside a drawing, never a pill or a fill behind text, and
    the rest point type only appears as a dust glyph in the stop list. Revisit
    if a rest day lands inside a dust band and the two get confused.
  - **The day's title is its first route.** Unnamed routes read "To {camp}"
    when the day's camp is named, else "Untitled route" in secondary ink. Edit
    renames the route (the title). Other features are stop rows in walking
    order (projected onto the route), not data order.
  - **Unassigned routes:** when no route is in a day yet, the profile draws
    them as one neutral (earth pencil) stretch with "Drag it into a day to
    split the profile". When some are assigned, the profile shows only the
    days and the caption counts the loose routes.
  - **No elevation yet:** that stretch is a pencil rule being inked back and
    forth ("Elevation loading…"); after 20 s with nothing it becomes a quiet
    dotted line, "No elevation for this stretch". When elevation arrives the
    ink line draws itself in once (`draw` verb).
  - **Empty trip:** the profile area becomes a faint dotted ridge over a
    ruled baseline with one line ("Your elevation profile draws itself here.
    Draw a route on the map, then drag it into a day.") and a quiet Draw route
    button; days just say "Nothing planned yet." Empty days in a trip with
    content say "Draw a route for this day, or drag a stop here", and their
    Draw route puts the new route straight into that day.
  - **Meals** are still derived from notes (breakfast/lunch/dinner/snack in a
    stop's notes draws the mug). Follow-up: a `meal` waypoint subtype in the
    schema first.
  - **Day totals are route miles** (match the profile's day tag); a day-hike
    spur shows its own "x mi rt" in the stop list. The top chips (PR #12's
    area) still include day hikes.
  - **Unplanned days after the last route take no width** on the profile;
    empty days between routes are rest days at the previous day's elevation.
  - The paper fade only appears once content is scrolling under the profile
    (at rest it would grey out the first row).
  - The tray (Unassigned) is hidden when empty; it appears while dragging
    ("Drop here to take it out of its day.") and while drawing.

- 2026-11-07 · **Route legs on the map (trail routing)**: routed legs are
  solid `--type-route` on a 6 px `--surface-raised` casing; Shift legs dash
  [2,2]; no-path fallback legs are `--accent` dotted [1,1.5] with a gap pin
  drawn as a paper ring with a rust rim and rust center · planner, draw a
  route in Zion (`design/tools/scenes-routing.json`) · the casing keeps the
  route readable over the basemap's own colored trail lines, and the ring
  pin can't be confused with the basemap's filled POI dots.
- 2026-11-08 · **Quiet unrouted areas**: legs drawn where there is no routing
  graph (`no_graph`, `cross_region`) render as ordinary route lines: no gap
  pin, no dotted rust styling, no card. Only `no_path` inside a routed area
  keeps the flagged leg + pin + OSM-fix card. The data stays honest (exports
  keep `mode: "straight"` + `reason`). One non-repeating hint per page load
  on the first click outside a routed area: "Trail routing covers Zion, the
  Maze and the Needles. Here, lines are drawn as you click." (names built
  from the catalog). New "Routed areas" layer toggle outlines those regions
  (dashed `--accent` outline, 7% tint, 12 px label) and is **off by default**:
  the calmer option, since most users never need it and the hint already
  says where routing lives. Could instead default on while drawing · planner,
  Utah full-state view (`routing-unrouted-utah`, `routing-routed-areas-layer`
  scenes) · most of the state will never have routing, so an absence of
  routing should look like normal drawing, not a defect.
- 2026-11-07 · **Ink-rule loading hint**: while a region's trail graph
  downloads, the drawing hint reads "Loading trails for routing…" and a
  1 px sage rule draws back and forth under it (static under reduced motion)
  · `.drawing-hint--loading` in styles.css · first small piece of the
  tabletop loading direction: a line being inked instead of a spinner. It
  only runs while the data is actually loading. On top of 1b (2026-11-08)
  the hint keeps 1b's ink pill (`--text` on `--surface`) instead of the
  paper pill the routing branch had, and sits above the instructions card;
  the gap card inherits 1b's base popup instead of restyling it.

- 2026-11-07 · **"Tabletop" loading**: map layers drop onto the paper one
  by one as they load; panels set down like sheets; imported trips draw in,
  then day cards drop into place · not built yet; direction in DESIGN.md
  "Loading states" · Vincent's idea: makes waiting feel like spreading a map
  on a table. Build it with the map-loading work and validate on a real load.

Format:
`- YYYY-MM-DD · <what> · <where to see it> · <why it might be better>`

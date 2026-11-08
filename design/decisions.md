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

## Trying

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

- 2026-11-07 · **Route legs on the map (trail routing)**: routed legs are
  solid `--type-route` on a 6 px `--surface-raised` casing; Shift legs dash
  [2,2]; no-path fallback legs are `--accent` dotted [1,1.5] with a gap pin
  drawn as a paper ring with a rust rim and rust center · planner, draw a
  route in Zion (`design/tools/scenes-routing.json`) · the casing keeps the
  route readable over the basemap's own colored trail lines, and the ring
  pin can't be confused with the basemap's filled POI dots.
- 2026-11-07 · **Ink-rule loading hint**: while a region's trail graph
  downloads, the drawing hint reads "Loading trails for routing…" and a
  1 px sage rule draws back and forth under it (static under reduced motion)
  · `.drawing-hint--loading` in styles.css · first small piece of the
  tabletop loading direction: a line being inked instead of a spinner. It
  only runs while the data is actually loading.

- 2026-11-07 · **"Tabletop" loading**: map layers drop onto the paper one
  by one as they load; panels set down like sheets; imported trips draw in,
  then day cards drop into place · not built yet; direction in DESIGN.md
  "Loading states" · Vincent's idea: makes waiting feel like spreading a map
  on a table. Build it with the map-loading work and validate on a real load.

Format:
`- YYYY-MM-DD · <what> · <where to see it> · <why it might be better>`

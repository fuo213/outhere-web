# Booot Design System

**Status:** v0.1 (2026-11-07). Alive. Read `decisions.md` for what's confirmed
vs. still being tried. Values live in `tokens.css`; this file is the *why*.

Live specimen: `design/specimen.html` (serve the repo on port 8000 and open
`/design/specimen.html`; also deployed with the site).

---

## What Booot is, in one breath

A field notebook for planning multi-day backpacking trips: draw the route on a
real topo map, split it into days and camps, and carry it offline on your
phone. The user is someone sitting down on a weeknight to plan a trip they're
excited about. The interface should feel like a good paper map and a good
notebook: calm, warm, precise, a little bit tactile. Never like a dashboard.

**Name:** Booot (three o's), everywhere a user can see it. "OutHere" is an
internal repo name only.

---

## Principles

Each principle has a test. If a design fails the test, it's wrong even if it
looks nice.

### 1. The map is the hero
The map is the product; chrome frames it and gets out of the way.
- **Test:** In any planning screen, the map occupies the majority of the
  viewport and no panel competes with it for attention (one panel open at a
  time; panels are paper-colored, not saturated).

### 2. One clear next step
Every view has exactly one primary action, and empty states say what to do
next in one line with the action right there.
- **Test:** Squint at the screen: exactly one rust-filled element. An empty
  area never just says "Nothing here".

### 3. Ink on paper
Warm paper surfaces, near-black ink, a single brand accent (rust) for action.
Point-type colors (sage, gold, teal, dust) mean *what kind of place this is*
and never decorate.
- **Test:** Remove all color except rust and the type colors: nothing
  important disappears. No gradients, no purple, no glassmorphism.

### 4. Quiet type, loud numbers
Three families with strict jobs: **Playfair Display** for trip titles and
page heroes only, **DM Sans** for all interface text, **IBM Plex Mono** for
numbers (miles, feet, dates, coordinates). Sentence case everywhere. One tracked
uppercase style (`.t-label`, 11px) for section labels, used sparingly.
- **Test:** Nothing below 11px. No more than one `.t-label` per panel section.
  Plex Mono never sets words, only data.

### 5. Motion confirms, never decorates
Six verbs (see Motion). Every animation answers "did that work?" or "where did
that go?". Idle UI is still.
- **Test:** Every animation is triggered by a user action or a state change.
  Under reduce-motion, the UI is fully usable and nothing moves.

### 6. Honest and specific
Copy names real things: "Draw your route, then drag it into a day," not "Get
started on your adventure!" Marketing promises only what ships.
- **Test:** No exclamation marks in UI copy. No feature claims that a user
  can't do today.

---

## Color

Palette tokens (`--earth-*`, `--ink-*`, `--rust-*`…) exist so semantic tokens
can point at them. **Components use semantic tokens only**: `--surface`,
`--surface-raised`, `--surface-sunken`, `--border`, `--text`, `--text-body`,
`--text-secondary`, `--text-muted`, `--accent`, `--danger`, `--type-*`.

Contrast rules (measured on `--surface` #F2EDE3):
| Token | Ratio | Allowed for |
|---|---|---|
| `--text` ink-900 | 14.8 | anything |
| `--text-body` ink-700 | 10.4 | anything |
| `--text-secondary` ink-500 | 5.4 | any text, the floor for small text |
| `--text-muted` ink-400 | 3.5 | ≥14px or non-essential hints |
| ink-300 | 2.4 | **never text**: icons, rules, decoration |
| `--accent` rust-500 | 4.7 | text links, primary fill (white text on it: 5.1) |
| `--type-*` fills | 1.9–3.2 | **never text**: use `--type-*-text` |

Point types: route = sage, camp = gold, dayhike = teal, rest = dust, water =
water-blue. Each has `fill`, `tint`, `border`, `text` variants (water's
`--type-water-text` added in 1b). When a type needs a **solid fill with light
text on it** (active point-type tool, a tile's Save button), fill with the
`--type-*-text` shade: the `--type-*` fills are too light for white text.

Overlays use the flat `--scrim`: no backdrop blur. Surfaces are flat paper:
no ruled-line texture.

## Type scale

| Token | px | Use |
|---|---|---|
| `--text-xs` | 11 | section labels (`.t-label`), fine print. **Floor** |
| `--text-sm` | 12 | chips, meta, secondary buttons |
| `--text-md` | 13 | default UI |
| `--text-base` | 14 | body, inputs |
| `--text-lg` | 17 | section headings (DM Sans bold) |
| `--text-xl` | 22 | modal titles (Playfair) |
| `--text-2xl` | 28 | trip title (Playfair 700, -0.02em) |
| `--text-hero` | 36–64 | landing hero only |

## Space, shape, depth
4px spacing scale (`--space-1`…`--space-12`). Radii: 4 inputs, 8 buttons and
cards, 12 modals, pill for chips. Shadows climb with elevation: `--shadow-1`
resting card → `--shadow-4` side panel. Pressed things lose their shadow.

## Motion

| Verb | What happens | Where | How |
|---|---|---|---|
| **press** | sinks to 0.97, shadow collapses, springs back | every button and tool | built into `.btn`/`.tool`; `.m-press` elsewhere |
| **lift** | rises 1px with a soft shadow on hover | things you can grab or open: cards, pills | `.m-lift` |
| **confirm** | a 420ms shiver | a state change landed: saved, assigned to a day, exported | `confirm(el)`; app wiring in `ui-motion.js` |
| **flip** | label slides like a slot machine on hover, previewing the other state | two-state toggles (edit/preview, units, layer on/off) | `.flip-btn` + `wireFlip()` (reusable; no text toggle in the app uses it yet) |
| **draw** | line draws itself in | a route was just finished; route previews | `.m-draw` / `drawIn()` |
| **count** | numbers tick to their new value | day/trip totals after an edit | `countUp()` |

Easing: `--ease-out` (momentum, the default), `--ease-spring` (release from
press only), `--ease-in-out` (draw). Durations: 90 press / 160 hover / 260
panels / 420 confirm / 900 draw. All collapse to 0 under
`prefers-reduced-motion`.

## Loading states and expressive motion (direction, not built yet)

The rule above still holds: no animation for its own sake. **Waiting is the
exception.** While the user is already waiting (the map loading, a region
downloading, a trip importing), motion can be more expressive, because it
fills time that would otherwise be dead and shows that something is
happening.

**The tabletop metaphor.** Planning a trip is spreading a map on a table and
laying your notes on it. Loading should feel like that: things settle onto a
surface rather than spin or shimmer.
- **Map load:** the paper base appears first, then layers *drop onto the
  table* in reading order (terrain/contours ink in, water, trails draw, POIs
  drop like pins with a small settle). Each layer lands when its data is
  actually ready.
- **Panels and modals:** set down like a sheet of paper (short drop + settle,
  shadow tightening as it lands), not a slide or fade from nowhere.
- **Trip import / open:** the route draws in (`draw`), then day cards drop
  into the itinerary one after another.
- **Region download (mobile):** tiles fill in on a miniature of the region,
  with honest progress (MB of MB), never an indeterminate spinner.

**Guardrails for loading motion**
1. **Never slower than the data.** Animation runs alongside real loading
   and finishes quickly (≤ 300ms) once the data is there; it never holds
   content back to finish a sequence.
2. **Full sequence once per session.** The first map load can play the whole
   tabletop sequence; later loads get a short version (quick settle) or none.
3. **Tied to real states.** Each step corresponds to an actual load event
   (style loaded, source loaded, tiles idle), not a timer.
4. **Reduced motion:** a plain crossfade or nothing.
5. **No shimmer skeletons, no bouncing dots, no spinner as the main
   experience.** If something needs a placeholder, use flat paper-colored
   blocks in the shape of the content.

Likely additions when this is built: a `settle` verb (drop + slight
overshoot + shadow tighten) in `motion.css`, `--dur-settle` and a stagger
token, and a small loader helper in `motion.js` that maps MapLibre events
(`styledata`, `sourcedata`, `idle`) to layer reveals.

## Components (base layer: `components.css`)
- **Buttons:** `.btn--primary` (one per view), `.btn--quiet` (default
  secondary), `.btn--ghost` (inline/tertiary), `.btn--danger` (destructive,
  never filled). Sizes default 36px / `--sm` 28px.
- **Map tools:** `.tool`, 40×40 paper squares; `aria-pressed="true"` turns
  rust with accent glow. Tools get a visible text label or a tooltip, never an
  unexplained glyph.
- **Chips:** `.chip` for metadata (mono numbers + icon).
- **Pills:** `.pill[data-type]` for trip features you can drag into days.
- **Cards, fields, empty states:** `.card`, `.field` + `.input`, `.empty`.

### How the app uses them (Phase 1b)
`index.html` links `design/tokens.css`, `motion.css`, `components.css`, then
`styles.css` (feature styles, token names only). Static buttons use the
`.btn` classes directly; JS-rendered pieces keep their own class names and
mirror a base component in `styles.css`:
| App class | Mirrors |
|---|---|
| `.feature-chip[data-type]` | `.pill` (+ `waypoint` → water tokens) |
| `.meta-chip` | `.chip` |
| `.tool-btn`, MapLibre controls | `.tool` |
| `.trip-card`, `.feature-tile` | `.card` + lift |
| `.onboarding-input` / `-label` | `.input` / `.field-label` |
| `.trips-empty`, `.day-drop-zone` | `.empty` |

Press and lift for these are wired by one selector list at the top of
`styles.css`; add new buttons/cards there. `confirm` fires on exports
(`ui-motion.js`, delegated clicks). Section labels in the app that use the
`.t-label` treatment: Unassigned, Layers, Regions, style sub-headers, the
drawing-instructions title. Accordion rows ("Overview", "Day 1") are
sentence case.

**Trip panel hierarchy:** the one primary is "Download trip (.geojson)"
(it becomes "Send to phone" when that ships); export notes / load / new trip
are small ghost buttons in one row. No badge above the title.

## Voice
Plain, warm, specific, second person. Verbs on buttons ("Draw route", "Send to
phone"). Numbers with units ("12.4 mi", "+2,310 ft"). No exclamation marks, no
"adventure awaits", no emoji in UI.

## Anti-patterns (things that make it look AI-generated)
- Tiny tracked-out uppercase labels on everything ("TRIP PLANNER", "DAY 1")
- Badges that restate the obvious (an "NPS-style" badge above every title)
- Several equal-weight full-width buttons stacked at the bottom of a panel
- Purple/blue gradients, glass blur, glow for its own sake
- Emoji as icons; generic icon soup with no labels
- A fourth font, or serif body text in UI chrome
- Centered-card-on-gradient marketing layouts
- Motion on idle elements (pulsing, bouncing, floating)
- Placeholder copy ("Lorem", "Untitled", "No items") left as the empty state

## How this system evolves
See `decisions.md`. In short: tokens and principles are **locked** until a
decision changes them; components are **defaults** you follow unless you have
a reason; anything new is an **exploration**, allowed and encouraged but
labeled as one so it can be promoted or rejected deliberately.

## Files
| File | Role |
|---|---|
| `tokens.css` | values (source of truth) |
| `motion.css` / `motion.js` | motion vocabulary |
| `components.css` | base components |
| `specimen.html` | living reference + visual test page |
| `decisions.md` | taste log: confirmed / trying / rejected |
| `skills/` | Claude Code skills that apply this system automatically |
| `tools/shoot.mjs` | zero-dependency screenshot harness for design review |
| `reference/` | source material (Paper file extraction, March 2026) |

# OutHere Timeline Panel Redesign

Only apply these guidelines when working on front-end or UI components

## Design direction

We're moving the app toward a "paper map / field journal" aesthetic. Think National Geographic topo map marginalia, not a SaaS sidebar. The UI should feel like notes sketched in the margins of a trail map.

## Typography

Switch all timeline panel text to a serif font stack: `Georgia, 'Times New Roman', serif`.

- Brand header: 11px, uppercase, letter-spacing 2.5px, muted color
- Trip title: 18px, regular weight (not bold)
- Secondary info (mileage, elevation, route notes): italic
- Day labels: 13px, regular weight with 0.5px letter-spacing
- Activity labels: 12px
- Time/duration values: 11px, right-aligned

## Color palette

Replace the current color scheme with earth tones. All colors should feel like they belong on a printed trail guide.

**Background:** `#f4f0e8` (warm parchment)
**Borders/dividers:** `#c9c3b5` (weathered paper edge)
**Primary text:** `#3d3529` (dark earth)
**Secondary text:** `#8a7e6b` (faded ink)

### Activity color coding

Each activity type gets a distinct earth-tone bar color. Text within each bar uses a darker shade from the same color family (never black or generic gray).

| Activity | Bar background | Text color | Icon stroke |
|----------|---------------|------------|-------------|
| Hike | `#b8c9a3` (sage green) | `#2a3d1e` | `#3d5a2a` |
| Camp | `#d4a574` (warm tan) | `#3d2208` | `#5c3a18` |
| Rest/meals | `#e8d5b5` (sandy beige) | `#5c4a2e` | `#7a6340` |
| Waypoint (TH, junction) | `#c4a882` (khaki) | `#3d2a10` | `#5c4a2e` |

## Timeline tile layout

Each activity in the timeline is a **full-width color bar** with no gaps between tiles (just 2px margin). Key rules:

- Tiles span the full width of the sidebar minus 12px horizontal padding
- Border radius: 3px (subtle, not rounded)
- Padding: 8px 12px
- **Height scales with estimated time.** A 6-hour hike tile should be visually taller than a 1-hour rest tile. Use something like `min-height: baseHeight + (hours * scaleFactor)` where baseHeight is ~32px and scaleFactor is ~8-10px per hour
- Each tile has: left-aligned icon + label, right-aligned time/duration
- Sub-labels (route details like "via Pete's Mesa route") go below the main label in a smaller, lighter shade

## Day dividers

Replace any existing day separation (cards, borders, whitespace) with a **dotted line + dot markers** pattern:

```
<svg width="100%" height="20" viewBox="0 0 260 20">
  <line x1="0" y1="10" x2="260" y2="10" stroke="#c9c3b5" stroke-width="1" stroke-dasharray="3 4"/>
  <circle cx="20" cy="10" r="2" fill="#c9c3b5"/>
  <circle cx="130" cy="10" r="2" fill="#c9c3b5"/>
  <circle cx="240" cy="10" r="2" fill="#c9c3b5"/>
</svg>
```

This should feel like trail markers on a paper map. The SVG should be responsive to panel width.

## Day headers

Each day header sits above its tiles with:
- Day label ("Day 1") in 13px serif
- Stats ("14.2 mi · 2,800 ft gain") in 11px italic, secondary color
- Both on the same line, separated by a gap

## Icons

All icons are **stroke-only SVGs**, 14x14px. They should look like pen sketches. No filled shapes, no emoji.

- **Hike:** Mountain peak zigzag (`M2 12 L5 4 L7 8 L9 2 L12 12`), stroke-width 1.2, round caps/joins
- **Camp:** Tent shape, two overlapping triangles (`M3 12L7 4L11 12` outer, `M5 12L7 8L9 12` inner), stroke-width 1.2/0.8
- **Rest:** Sun with rays, small circle center with radiating lines, stroke-width 1
- **Waypoint:** Simple triangle (`M7 1L1 13h12L7 1z`), stroke-width 1.2

## Legend

Bottom of the panel, above any action buttons. Horizontal row of small swatches (16x10px, 2px radius) with 10px labels. Shows: Hike, Camp, Rest, Waypoint.

## What NOT to do

- No card wrappers around individual days or tiles
- No drop shadows or gradients anywhere
- No sans-serif fonts in the timeline panel
- No bright/saturated colors; everything stays muted and warm
- No rounded corners larger than 3px on tiles
- No heavy borders between tiles; the color bars do the separation work

# Booot – Design System

Extracted from the "Booot" Paper design file, Page 1.
Two artboards: **Trip Planner – Modal** (Notes tab) and **Trip Planner – Timeline Tab** — both 1440×900px desktop.

---

## Color Palette

### Base / Surface

| Token | Hex | Usage |
|---|---|---|
| `parchment` | `#F2EDE3` | Modal panel background, toolbar button fill, map label bg |
| `parchment-light` | `#EDE7DA` | Timeline content area background |
| `parchment-tray` | `#E2D9CA` | Unassigned waypoints tray background |
| `parchment-chip` | `#EDE6D9` | Metadata chip bg, Cancel button bg |
| `parchment-muted` | `#E8E1D4` | Close button background |

### Border / Divider

| Token | Hex | Usage |
|---|---|---|
| `border-strong` | `#D5CBBA` | Toolbar card border, tab bar bottom line |
| `border-medium` | `#C9BFB0` | Tray bottom border, day-label divider line |
| `border-subtle` | `#C0B098` | Empty drop-zone dashed border |

### Text

| Token | Hex | Usage |
|---|---|---|
| `text-primary` | `#1E1A14` | Headings, primary content |
| `text-secondary` | `#6B5E4C` | Day labels, section labels |
| `text-muted` | `#8A7B68` | Inactive tab labels, supporting text |
| `text-tertiary` | `#A89880` | Dates, coordinates, sub-labels |

### Brand / Accent

| Token | Hex | Usage |
|---|---|---|
| `nps-rust` | `#B8431A` | Primary CTA, active tab underline, Jordan collaborator, Summit accent |
| `teal` | `#4A7C8A` | NPS arrowhead badge, Timeline tab active, Sam collaborator |
| `sage` | `#7D9168` | Marcus collaborator, Route waypoint type |
| `trail-dust` | `#C09A6B` | Rest waypoint type, editing focus ring, 4th collaborator |

### Waypoint Type System

Each type has three paired values: an **accent**, a **background tint**, and a **border**.

| Type | Accent | Background | Border |
|---|---|---|---|
| Camp Night | `#D4A853` | `#FDF7E8` | `#E0C870` |
| Route | `#7D9168` | `#EFF4EB` | `#A8C098` |
| Day Hike | `#4A7C8A` | `#EAF3F5` | `#90B8C4` |
| Rest Day | `#C09A6B` | `#F8F2EA` | `#C8A870` |
| Water Stop | `#5A8FA8` | `#EBF2F6` | `#88B0C8` |
| Summit | `#B8431A` | `#FDF0EB` | `#D09070` |

### Annotation / Overlay

| Token | Hex | Usage |
|---|---|---|
| `sticky-yellow` | `#FFFDE7` | Sticky note background |
| `sticky-border` | `#E8D48A` | Sticky note border |
| `sticky-strip` | `#D4A828` | Sticky note accent strip |
| `edit-field-bg` | `#FFF8EE` | Editing state notes textarea background |
| `edit-field-border` | `#E0C080` | Editing state notes textarea border |

### Map

| Token | Hex | Usage |
|---|---|---|
| `map-base` | `#C8D4B8` | Topographic map base fill |
| `map-contour` | `#A8BC96` | Standard contour lines |
| `map-index-contour` | `#8AAA78` | Index (bold) contour lines |
| `map-water` | `#7AAABA` | Rivers and streams |
| `map-vegetation` | `#6A8F60` | Tree cover dots |
| `map-text` | `#4A5E42` | Map scale bar, labels |

---

## Typography

### Font Families

| Family | Role |
|---|---|
| **Playfair Display** | Display headings, trip name, summit card title — cartographic elegance |
| **DM Sans** | All UI chrome: labels, tabs, buttons, pills, badges, avatar initials |
| **Source Serif 4** | Body text, card descriptions, blockquotes, sticky note content |
| **IBM Plex Mono** | Metadata: mileage, coordinates, dates, data values, markdown syntax markers |

### Type Scale

| Size | Weight | Family | Color | Usage |
|---|---|---|---|---|
| 28px | 800 | Playfair Display | `#1E1A14` | Trip/page title; `line-height: 110%`, `letter-spacing: -0.02em` |
| 22px | 700 | Playfair Display | `#1E1A14` | Markdown H1 heading |
| 17px | 700 | Playfair Display | `#1E1A14` | Markdown H2 heading |
| 14px | 400i | Playfair Display | `#8A7B68` | Trip subtitle / location tagline |
| 14px | 400i | Source Serif 4 | `#6B5E4C` | Blockquote / inspirational callout |
| 14px | 400 | Source Serif 4 | `#2E2820` | Markdown body text |
| 13px | 700 | Playfair Display | `#B8431A` | Summit card title (special case) |
| 13px | 600 | DM Sans | `#B8431A` | Active tab label; `letter-spacing: 0.01em` |
| 13px | 500 | DM Sans | `#8A7B68` | Inactive tab label |
| 12px | 700 | DM Sans | type-specific | Card title (in timeline day buckets) |
| 11px | 700 | DM Sans | `#4A7C8A` | Section badge (e.g. "TRIP PLANNER"); `text-transform: uppercase`, `letter-spacing: 0.12em` |
| 11px | 600 | DM Sans | type-specific | Waypoint pill label |
| 11px | 400 | Source Serif 4 | type-specific | Card description / body; `line-height: 14px` |
| 11px | 400i | Source Serif 4 | `#3A3020` | Sticky note body; `line-height: 140%` |
| 11px | 400i | Source Serif 4 | `#5A4020` | Editing state notes field; `line-height: 160%` |
| 10px | 700 | DM Sans | `#6B5E4C` | Day bucket label; `text-transform: uppercase`, `letter-spacing: 0.12em` |
| 10px | 700 | DM Sans | `#F2EDE3` | Difficulty badge (e.g. "STRENUOUS"); `text-transform: uppercase`, `letter-spacing: 0.06em` |
| 10px | 500 | IBM Plex Mono | `#4A3E30` | Metadata chip values (mileage, days, elevation) |
| 9px | 700 | DM Sans | `#F2EDE3` | Avatar initials |
| 9px | 400 | IBM Plex Mono | `#A89880` | Tertiary metadata: dates, sub-labels |
| 9px | 400 | IBM Plex Mono | `#A89040` | Sticky note attribution |

---

## Spacing Scale

Extracted from computed padding, gap, and margin values across components.

| Value | Usage |
|---|---|
| `4px` | Chip padding-block; avatar stack overlap margin; small action button padding |
| `5px` | Pill vertical padding; avatar overlap compensation |
| `6px` | Toolbar button gap; pill icon–label gap; empty drop zone gap; day label row gap |
| `7px` | Tab icon–label gap; card header row gap |
| `8px` | Metadata chip gap row; toolbar group gap; markdown toolbar button gap |
| `9px` | Card padding-block |
| `10px` | Tab horizontal padding; metadata chip horizontal padding |
| `11px` | Card horizontal padding |
| `12px` | Tray top padding |
| `14px` | Day bucket vertical gap; tray bottom padding |
| `16px` | Modal top bar bottom margin |
| `18px` | Timeline area horizontal padding |
| `20px` | Tab bar top margin; section gap |
| `24px` | Modal bottom padding |
| `28px` | Modal primary horizontal padding (header, notes content) |

---

## Border Radius

| Value | Usage |
|---|---|
| `4px` | Save / Cancel action buttons; small inline chips |
| `5px` | Editing notes textarea field; markdown toolbar buttons |
| `6px` | Close button |
| `7px` | Timeline cards (standard) |
| `8px` | Toolbar button cards; empty drop zone container |
| `20px` | Waypoint pills; metadata chips; collaborator badges |
| `50%` | Avatar circles; collaborator color dots |

---

## Shadows

| Name | Value | Usage |
|---|---|---|
| `shadow-modal` | `-8px 0 40px rgba(#1E1A14, 0.22)` | Modal panel left-edge entry shadow |
| `shadow-toolbar` | `0 2px 8px rgba(#1E1A14, 0.18)` | Toolbar card group, inactive toolbar buttons |
| `shadow-cta` | `0 2px 8px rgba(#B8431A, 0.35)` | Active draw-route button (colored glow) |
| `shadow-card` | `0 1px 3px rgba(#1E1A14, 0.07)` | Timeline cards (normal state) |
| `shadow-focus` | `0 0 0 2px #C09A6B, 0 3px 12px rgba(#C09A6B, 0.18)` | Card editing/focused state (ring + soft glow) |

---

## Component Patterns

### Modal Panel
- Width: `520px`, height: `900px`, right-anchored, `position: absolute`
- Background: `#F2EDE3`
- Shadow: `shadow-modal`
- Subtle parchment texture: `repeating-linear-gradient(0deg, transparent 28px, rgba(180,168,148,0.06) 29px)`
- Internal layout: `display: flex; flex-direction: column`

### Tab Bar
- Bottom border: `2px solid #D5CBBA`
- Horizontal padding: `28px`
- Active tab: `3px solid [accent]` bottom border, `margin-bottom: -2px` to bleed over the bar border
- Inactive tab: no underline, muted label color
- Tab icon + label gap: `7px`

### Waypoint Pills (Unassigned Tray)
- Shape: `border-radius: 20px`
- Fill: type background tint
- Border: `1px solid [type border color]`
- Padding: `5px 11px 5px 7px`
- Content: 12px SVG icon + 11px/600 DM Sans label
- Gap: `5px`
- Cursor: `grab`
- Pills wrap via `flex-wrap: wrap`

### Timeline Cards (Assigned State)
- Shape: `border-radius: 7px`
- Fill: type background tint (no left border)
- Shadow: `shadow-card`
- Padding: `9px 11px`
- Header row: icon (13px SVG) + bold title + muted pencil icon + right-aligned type value
- Body: 11px Source Serif 4 description, `margin-bottom: 4px`
- Footer: 14px collaborator avatar + 9px IBM Plex Mono label
- Pencil icon: `opacity: 0.4` at rest, becomes `opacity: 1` + type accent color when editing

### Card Editing State
- Same geometry as normal card
- Shadow replaced by: `shadow-focus` (2px outline ring + soft glow in type accent color)
- Title: underline `1.5px solid [type accent]`, `padding-bottom: 1px`
- Notes field: `background: #FFF8EE`, `border: 1px solid #E0C080`, `border-radius: 5px`, `padding: 7px 9px`
- Action row: Cancel (`bg: #EDE6D9`, `border-radius: 4px`) + Save (`bg: type accent`, `border-radius: 4px`)

### Empty Drop Zone
- `border: 1.5px dashed #C0B098`
- `border-radius: 8px`
- `padding: 18px 16px`
- Centered column: 20px SVG icon (opacity 0.35) + 10px IBM Plex Mono label
- Gap: `6px`

### Metadata Chips (Header)
- `border-radius: 20px`
- `background: #EDE6D9`
- `padding: 4px 10px`
- Content: 12px SVG icon + 10px/500 IBM Plex Mono value
- Gap: `5px`
- Special variant: Difficulty badge uses `background: #B8431A`, white text

### Collaborator Avatar Stack
- Avatar size: `26px × 26px`
- Shape: `border-radius: 50%`
- Separator border: `2px solid #F2EDE3`
- Overlap: `margin-left: -6px`
- Initials: 9px/700 DM Sans, `#F2EDE3`
- Colors: Marcus `#7D9168` · Jordan `#B8431A` · Sam `#4A7C8A` · Trail dust `#C09A6B`
- Add button: dashed border `#8A9B76`, plus SVG icon

### Map Toolbar Buttons
- Size: `40×40px`
- Shape: `border-radius: 8px`
- Default state: `background: #F2EDE3`, `border: 1px solid #D5CBBA`, `shadow-toolbar`
- Active/CTA state (Draw Route): `background: #B8431A`, no border, `shadow-cta`
- Zoom group: two buttons stacked, separated by `1px solid #D5CBBA` internal divider

### Sticky Notes
- Background: `#FFFDE7` (yellow) or `#E8F5E9` (green) or `#F2EDE3` (parchment)
- `box-shadow: 2px 3px 10px rgba(#1E1A14, 0.20–0.22)`
- Slight rotation via `transform: rotate(±1–3.5deg)`
- Tape strip: `width: 40px; height: 16px; background: rgba([tint], 0.5); border-radius: 2px`, positioned at `top: -8px; left: 50%; transform: translateX(-50%)`

### Day Bucket (Timeline)
- No background or border — cards sit directly on `#EDE7DA`
- Header row: `10px/700 DM Sans` day label + `9px IBM Plex Mono` date + `flex: 1` `1px #C9BFB0` rule + summary text
- Cards stack vertically with `gap: 5px`
- Day buckets separated by `margin-bottom: 14px`

---

## Layout Grid

### Artboard
- Canvas size: `1440×900px` (desktop)
- Artboard spacing on canvas: `80px` between frames

### Modal Split
- Map area: `~920px` (left, implicit)
- Modal panel: `520px` (right, fixed width, full height)
- Modal is `position: absolute; top: 0; right: 0`

### Modal Internal Layout
```
Modal Panel (520px)
├── Header          padding: 24px 28px 0
├── Tab Bar         padding: 0 28px; margin-top: 20px
├── Tab Content     flex: 1; overflow-y: auto
│   ├── Notes       padding: 20px 28px
│   └── Timeline
│       ├── Tray    padding: 12px 18px 14px
│       └── Buckets padding: 14px 18px 24px
```

### Toolbar
- Position: `absolute; top: 20px; left: 20px`
- Width: `42px` (button size 40px + implicit)
- Gap between button groups: `6px`
- Button size: `40×40px`

---

## Icon System

- All icons are inline SVG, no icon font
- Standard size within cards: `13×13px`
- Standard size within pills: `12×12px`
- Toolbar icons: `16–18px`
- Stroke weight: `1.2–1.8px` depending on icon complexity
- Icons use the type accent color with `fill-opacity: 0.2–0.35` for filled areas
- Pencil icon (editability indicator): `10–11px`, muted at rest (`opacity: 0.4`), accent color when active

---

## Interaction Patterns

### Two-State Flip Button

A compact toggle button where text slides in/out like a slot machine on hover, and a subtle shiver confirms the click. Used for the Readme Preview/Edit toggle.

**Behavior:**
- **Hover**: current label slides out (up or down depending on direction), next label slides in from the opposite edge
- **Direction is state-aware**: "forward" transitions slide up, "backward" transitions slide down
- **Click**: shiver animation confirms the state change; hover flip and background color change are suppressed until `mouseleave`
- **After mouseout**: flip re-arms for the next hover in the new state

**HTML structure:**
```html
<button class="flip-btn" id="myBtn" data-mode="a" aria-label="Toggle mode">
  <span class="btn-face btn-face--front">Label A</span>
  <span class="btn-face btn-face--back">Label B</span>
</button>
```

**CSS:**
```css
.flip-btn {
  position: relative;
  overflow: hidden;          /* clips sliding faces — required */
  width: 80px;               /* fixed width: size to longest label */
  height: 28px;
  border: none;
  border-radius: 4px;
  font-family: 'DM Sans', sans-serif;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.25s ease;
}

/* State colors */
.flip-btn[data-mode="a"]       { background: #B8431A; } /* nps-rust */
.flip-btn[data-mode="b"]       { background: #4A7C8A; } /* teal */
/* Hover previews destination color */
.flip-btn[data-mode="a"]:hover { background: #4A7C8A; }
.flip-btn[data-mode="b"]:hover { background: #B8431A; }

.btn-face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #F2EDE3;
  white-space: nowrap;
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}

/* Resting positions */
.btn-face--front                      { transform: translateY(0); }
.btn-face--back                       { transform: translateY(100%); }
.flip-btn[data-mode="b"] .btn-face--back { transform: translateY(-100%); }

/* Hover: mode "a" → "b" slides UP */
.flip-btn[data-mode="a"]:hover .btn-face--front { transform: translateY(-100%); }
.flip-btn[data-mode="a"]:hover .btn-face--back  { transform: translateY(0); }

/* Hover: mode "b" → "a" slides DOWN */
.flip-btn[data-mode="b"]:hover .btn-face--front { transform: translateY(100%); }
.flip-btn[data-mode="b"]:hover .btn-face--back  { transform: translateY(0); }

/* Post-click: shiver + freeze all motion until mouseout */
@keyframes btn-shiver {
  0%   { transform: rotate(0deg); }
  15%  { transform: rotate(-1.5deg); }
  32%  { transform: rotate(1.5deg); }
  50%  { transform: rotate(-1deg); }
  66%  { transform: rotate(1deg); }
  82%  { transform: rotate(-0.4deg); }
  92%  { transform: rotate(0.4deg); }
  100% { transform: rotate(0deg); }
}

.flip-btn.clicked                     { animation: btn-shiver 0.4s ease; }
.flip-btn.clicked .btn-face           { transition: none; } /* snap resting pos, no visible slide */
.flip-btn[data-mode="a"].clicked:hover { background: #B8431A; }
.flip-btn[data-mode="b"].clicked:hover { background: #4A7C8A; }
.flip-btn[data-mode="a"].clicked:hover .btn-face--front { transform: translateY(0); }
.flip-btn[data-mode="a"].clicked:hover .btn-face--back  { transform: translateY(100%); }
.flip-btn[data-mode="b"].clicked:hover .btn-face--front { transform: translateY(0); }
.flip-btn[data-mode="b"].clicked:hover .btn-face--back  { transform: translateY(-100%); }
```

**JS pattern:**
```js
const btn   = document.getElementById("myBtn");
const front = btn.querySelector(".btn-face--front");
const back  = btn.querySelector(".btn-face--back");
let mode = "a";

btn.addEventListener("click", () => {
  if (mode === "a") {
    mode = "b";
    btn.dataset.mode = "b";
    front.textContent = "Label B";
    back.textContent  = "Label A";
    // ... apply state B
  } else {
    mode = "a";
    btn.dataset.mode = "a";
    front.textContent = "Label A";
    back.textContent  = "Label B";
    // ... apply state A
  }
  // Shiver + freeze hover until mouseout
  btn.classList.remove("clicked");
  void btn.offsetWidth; // force reflow so animation restarts on repeated clicks
  btn.classList.add("clicked");
});

btn.addEventListener("mouseleave", () => btn.classList.remove("clicked"));
```

**Key implementation notes:**
- `overflow: hidden` on the button is non-negotiable — it clips the off-screen face so it's never visible at rest
- Fixed `width` prevents the button resizing between labels of different lengths
- `transition: none` on `.btn-face` while `.clicked` is active prevents the back face from animating when `data-mode` changes its resting `translateY` (which would show as a flash)
- `void btn.offsetWidth` forces a reflow so removing + re-adding `.clicked` always restarts the shiver, even on rapid clicks
- The `cubic-bezier(0.22, 1, 0.36, 1)` easing gives a fast-start / decelerating "momentum" feel without overshoot that would clip against `overflow: hidden`

---
name: booot-design
description: Booot's design system, taste and interaction language. Use for ANY user-facing work in the Booot repos (outhere-web planner, booot-landing, booot-mobile screens), including HTML, CSS, layout, components, icons, colors, typography, animation, hover/click states, empty states, UI copy and marketing copy, or whenever asked to make something look, feel or read better, even when the design system isn't mentioned. Not needed for pipeline, data or pure logic changes.
---

# Booot design system

You're designing for **Booot** (three o's; "OutHere" is only an internal repo
name). It's a field notebook for planning multi-day backpacking trips on a topo
map and carrying them offline on your phone. Calm, warm, precise, a little
tactile. Never a dashboard, never generic SaaS.

The system lives in `~/development/booot/outhere-web/design/`:

| Read | When |
|---|---|
| `DESIGN.md` | Before any UI work: principles (each has a test), color/type rules, motion verbs, voice, anti-patterns |
| `decisions.md` | Before any UI work: what Vincent has confirmed, is trying, or rejected |
| `tokens.css` | Whenever you write CSS: use these names, never raw values |
| `components.css`, `motion.css`, `motion.js` | Before building a button, chip, pill, field, card, empty state or animation: reuse, don't restyle |
| `specimen.html` | To see it all live (serve on :8000 → `/design/specimen.html`) |

## Non-negotiables
1. **Tokens only.** No raw hex/rgba/px font sizes in feature CSS. Semantic
   tokens (`--surface`, `--text-secondary`, `--accent`, `--type-camp`…) over
   palette tokens. Need a new value? Add a token to `tokens.css` with a
   comment, or mark it as an exploration.
2. **One rust-filled primary action per view.** Everything else is quiet or ghost.
3. **Type jobs:** Playfair = trip/page titles only; DM Sans = all UI; IBM Plex
   Mono = numbers only. Nothing under 11px. Sentence case; `.t-label` is the
   one uppercase style, used sparingly.
4. **Motion = the six verbs** (press, lift, confirm, flip, draw, count) from
   `motion.css`/`motion.js`, triggered by user actions or state changes. Idle
   UI never moves. Reduced motion is respected through tokens; don't hardcode
   durations.
5. **Contrast:** `--text-muted` only ≥14px; ink-300 and `--type-*` fills are
   never text (use `--type-*-text`).
6. **Copy:** plain, specific, verbs on buttons, units on numbers, no
   exclamation marks, no emoji, no promises the product doesn't keep.

## Creative latitude (how the system grows)
The system is a floor, not a ceiling. Within a task you may make **one
exploration**: something the system doesn't cover yet or a deliberate
deviation you think is better. Rules:
- Build it with tokens where possible; put any new raw values in one clearly
  commented block (`/* EXPLORATION: … */`).
- Tell Vincent in your summary: what you tried, where to see it, and why it
  might be better.
- Append it to `decisions.md` under **Explorations** with today's date.
When Vincent reacts ("love it", "no", "less of that"), record the verdict in
`decisions.md` (move the entry to Confirmed/Rejected with the reason). If a
confirmed exploration changes tokens, components or principles, update
`tokens.css` / `components.css` / `DESIGN.md` in the same change. Never
silently drift the system.

## Workflow for UI changes
1. Read `DESIGN.md` + `decisions.md` (skim if you read them this session).
2. Reuse base components; extend with modifiers rather than new one-offs.
3. Check yourself against the principle tests and the anti-pattern list.
4. **Look at it.** For visible changes, screenshot with
   `node ~/development/booot/outhere-web/design/tools/shoot.mjs --only <scene>`
   (zero deps; starts its own server on :8000; scenes: specimen, planner,
   mobile; custom scenes via `--scenes file.json`) and read the PNGs before
   calling the work done. For a full critique, Vincent can run `/design-review`.
5. In outhere-web: no build step, no npm. ES modules and CDN only.

## Repo specifics
- **outhere-web**: the app links `design/tokens.css`, `motion.css` and
  `components.css`; feature styles live in `styles.css` and consume tokens.
- **booot-landing**: single static `index.html`; copy the `:root` block from
  `tokens.css` (and needed components) inline, and note the source version in a comment.
- **booot-mobile**: map tokens to a TS theme object; mirror the motion verbs
  with Reanimated/Animated and respect iOS Reduce Motion.

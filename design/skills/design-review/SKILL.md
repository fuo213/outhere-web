---
name: design-review
description: Screenshot Booot's web UI and critique it against the Booot design system (principles, tokens, motion, anti-patterns). Run after visual changes or when Vincent asks for a design review.
disable-model-invocation: true
argument-hint: "[scene names: specimen, planner, mobile] [focus area]"
---

# Booot design review

Review what's actually on screen, not what the code implies.

1. **Load the system:** read `~/development/booot/outhere-web/design/DESIGN.md` and
   `decisions.md`.
2. **Capture:** from `~/development/booot/outhere-web` (or a worktree of it) run
   `node design/tools/shoot.mjs --out <scratch dir>/review [--only <scenes>]`.
   Scenes default to specimen + planner (trips home, onboarding, planner,
   drawing, drawn route, layers) + mobile width. If the change is elsewhere,
   write a scenes JSON (format documented at the top of `shoot.mjs`) and pass
   `--scenes`. Note any page errors it prints.
3. **Read every PNG.** Then audit the code for the changed files:
   `grep -nE "#[0-9a-fA-F]{3,6}\b|rgba?\(" styles.css` (raw colors outside
   `design/tokens.css`), font sizes under 11px, missing `:active`/focus
   states, hardcoded durations.
4. **Report** in this shape, most important first, max ~10 findings:
   - **Principle check:** each of the six principles: pass / fail + the
     evidence (screenshot name + what you see).
   - **Findings:** `[severity] screen · what's wrong · why it matters (which
     principle/anti-pattern) · concrete fix (tokens/components to use)`.
   - **What's working:** 2–3 things to keep, so they get confirmed.
   - **Taste questions:** up to 3 decisions only Vincent can make, phrased as
     A/B choices.
5. Offer to fix. Don't change code during the review itself. After Vincent
   answers taste questions, log the verdicts in `decisions.md`.

$ARGUMENTS

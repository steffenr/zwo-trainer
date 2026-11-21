# Compact ride view: live block + workout graph — design

**Issue:** https://github.com/steffenr/zwo-trainer/issues/51
**Builds on:** [2026-11-16-compact-three-panels-design.md](2026-11-16-compact-three-panels-design.md) (one DOM that is never rebuilt on resize, `ResizeObserver` driving `data-*` attributes, `Gauge`) and [2026-11-13-compact-ride-design.md](2026-11-13-compact-ride-design.md) (window lifecycle, `CompactView`, `ride_window.rs`).
**Decision:** The three mini panels (LIVE | CURRENT | NEXT) are **replaced** by a live block plus a workout graph, in two orientations: a **vertical layout** for narrow windows (time runs down) and a **horizontal layout** for wide windows (time runs across). This reverses a non-goal of the three-panels design ("no workout chart or mini profile in compact"). Chosen from options A "fix in place", B "merge CURRENT into LIVE" and C "live + graph" (issue #51); the reporter's and the owner's screenshots of C are the visual base.

## Why

The reporter rides with the compact view as their *main* view, with a video playing beside it. They need the video as large as possible and heart rate, cadence, power and workout left always readable, never hidden or clipped. Today those numbers are 11 px labels with a 15 px value beside a gauge, they clip at the 320 px minimum width (worst in German), CURRENT repeats the target watts and NEXT repeats the segment countdown, and workout left disappears below 300 px width. The graph carries what CURRENT and NEXT carried (what is now, what comes next and when) in less space, which allows a 240 px wide window and a flat ~150 px high one, and so a bigger video.

## Goals

- Narrow windows: live block on top, workout graph below it, controls and workout left at the bottom. Wide windows: live block and graph side by side.
- Heart rate, cadence, power, target and workout left are never hidden or clipped when the window is at least **240 × 200** (vertical) or **640 × 150** (horizontal), in English, German and French, for 60 and 120 minute workouts, ramps and four-digit watts.
- Minimum compact window: **240 × 150** (today 320 × 200).
- The graph uses all remaining space, so a bigger window gives it more detail.
- Text stays readable: captions 11 px minimum, values 12 px and up.

## Non-goals / anti-goals

- No seeking or clicking on the compact graph, no zoom, no scrolling, no live traces (power, cadence, heart rate) on it.
- No new setting, no persistence, no Tauri permission, no crate, no dependency, no bundler. (The only Rust additions are the window size limits of the two layouts, see "Changes made while building".) Do not rebuild the ride DOM on resize. Do not change the full ride screen.
- The gauge shows power only: no ring or arc besides the existing target marker (the reporter found the double ring "counterintuitive"). No timer ring in compact; the segment countdown is text on the graph.
- No change to the window lifecycle, `CompactView`, or the remembered compact geometry.

## Approaches considered

- **A. Fix in place.** Three panels, duplicates removed, bigger HR / cadence. Smallest change, still needs about 540 px height and keeps the countdown ring.
- **B. Live + Next, countdown inside LIVE.** About 500 px height, no workout overview.
- **C. Live + whole-workout graph (chosen).** Most information per pixel, answers the reporter's "crazy idea". The effort concern (a new graph renderer, two orientations) is accepted because both orientations share one drawing routine, the graph is drawn only on workout / size change, and the window lifecycle is untouched. It also removes the old four-tier layout system (`ws`, `wt`, `nt`, `ns`), which could not hold the required HR / cadence tiles at 240 px.

## Layout choice

`compactMode(width, height)` (pure, in `compact.js`) returns the layout and the flags below. It runs from the existing `ResizeObserver` and its result is written as `data-*` attributes on `.compact-ride`; CSS does the rest. The old `ws / wt / nt / ns` modes and the `short / tiny / narrow / xs` flags are removed.

- **Horizontal** when width ≥ 640 and width ≥ 1.5 × height. Otherwise **vertical**. (Mock defaults, tune on real hardware.)
- Vertical flags: `live` = `col` when height ≥ 520, else `row`; `graph` on when height ≥ 360; `foot` = `head` when height < 244 (play and workout left move into the heading row, stop and the label are omitted), else `foot`; `tiles` off only when height < 190 (see Degradation).

## Vertical layout (narrow windows)

```
┌ ● ● ●            [⤢] ┐  heading: traffic lights (macOS), status dot, gears while free-like, expand
│ ● LIVE               │
│      ┌────┐          │  gauge: power only, small target tick, "W" under the number
│      │ 138│          │
│      └────┘          │
│      ⚡ 220 W         │  target: bolt + watts in the zone's text colour, right under the gauge
│ ┌────────┐┌────────┐ │  heart rate | cadence: icon + number, no labels
│ │ ♡ 128  ││ ⟳  91  │ │
│ ● WORKOUT            │
│ NOW      ▒▒ past ▒▒ │  graph: time runs down, bar width = % FTP, finished part dimmed
│ 220 W    ████████    │  solid position line; NOW label sits ABOVE it
│ 8:00 left ━━━━━━━━━━ │
│ NEXT     ┄┄┄┄┄┄┄┄┄┄ │  dotted line at the next segment's start; NEXT label sits BELOW it
│ 250 W    ██████      │
│ in 8:00  ▇▇▇▇        │
│ [▶][■]    WORKOUT LEFT│  footer: play / pause, stop, workout left (label above 22 px number)
│               1:15:00│
└──────────────────────┘
```

Fixed parts at 240 px wide, measured in the mockups: heading 32; live block as `col` ~215 (gauge 116, target 19, tiles ~44), as `row` ~128 (gauge 84 on the left, target above two stacked tiles on the right); footer ~44. The graph is `flex: 1`: window 520 → graph 148 px, 640 → 268, 760 → 388 (column live block; the row variant leaves 128 px more, so 400 → ~136 px graph).

## Horizontal layout (wide windows)

```
┌ ● ● ●                                                                          ┐
│  [▶][■]   ┌ LIVE ─────────────────────┐             ┌ WORKOUT ───── WORKOUT LEFT 40:00 ┐
│  [⤢]      │ ◜138◝   ⚡ 220 W          │   (space)   │   Now 220 W │ Next 250 W · in 8:00│
│           │ ◟ W ◞  [♡ 128] [⟳ 91]   │             │ ▂▃▅█│█████│▇▇▇ ▂▂ ▇▇▇ ▃▂        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Left rail** (one button wide, below the macOS window buttons): play / pause, stop, layout switch and expand in one column. Gears (while free-like) take the layout switch's place as a small − / + row. No heading row: the window can be as flat as 150 px.
- **Live block:** gauge on the left (at most 150 px), target line and the two tiles to its right, vertically centred in the block when the window is taller. **Width 300–420 px.**
- **Graph panel:** header "WORKOUT" on the left and workout left on the right (below 290 px panel width the label drops and only the number stays; the label is the tooltip). **Width 200–720 px.**
- **Max widths:** on a wide window the live block stops at 420 px and the graph at 720 px; the leftover space is an empty gap *between* them (live block left, graph right). CSS: `grid-template-columns: minmax(300px, 420px) minmax(0, 1fr) minmax(200px, 720px)` (the middle track is the empty space; grid grows the outer tracks to their maximum before the flexible one).
- Time runs left to right; bar height = % FTP; ramps are slopes; dashed horizontal line = FTP; solid vertical line = now; dotted vertical line = start of the next segment.
- **Labels** sit in a strip above the bars: "Now {watts}" right-aligned to the left of the position line, "Next {watts} · in {m:ss}" left-aligned right of the next segment's start. If there is no room: drop " · in m:ss" first, then the "Now" / "Next" words (leaving just the watts for Now), then the Next label. In a graph panel of ~200 px (window 640 px wide) the Now label is just the watts.

## LIVE block (both layouts)

- **Gauge:** power number and a static "W". The old sub-line inside the gauge (`#cmp-pow-sub`) is removed: it overflowed at small sizes.
- **Target line:** bolt icon + watts, 19 px bold, in the zone text colour (`zoneInk(target / FTP, bounds())`, the `--zN-ink` tokens that are readable in light and dark), no word "Target". A ramp segment shows its range (`70–210 W`, en dash) and the gauge tick follows the current target. Free ride / all-out: the existing `gFree` / `gAllOut` text in `--muted`. The intensity multiplier is already part of the value (as in `renderNext`).
- **Heart rate and cadence:** two tiles, icon + 24 px number, no label and no unit. The word is the tooltip and the accessible name (`aria-label` from `devHr`, `cadence`). Cadence is red when off target (existing `off-target` state). Missing sensor: `–`.

## Workout graph (shared)

- One new class in `ui/js/render.js`, next to `Diagram` (working name `CompactGraph`), with an `orientation` (`'v'` or `'h'`). It draws an SVG at the **measured pixel size** of its slot (no stretching, so text stays crisp) and redraws only when the workout, the orientation or the slot size changes (from the same `ResizeObserver`, throttled with `requestAnimationFrame`), never per tick.
- Data: `workout.segments` (`start`, `duration`, `p0`, `p1`), colours from `zoneColor` / `FREE_COLOR`, free segments (`p0 === null`) as a grey block like `Diagram`. Scale: bar length is p / `maxP` with `Diagram`'s `maxP` rule (max(1.2, highest p) × 1.08), so it matches the full view. A dashed line marks FTP (p = 1).
- `update(at)`: moves the position line and dims segments that are completely finished (class toggle only when the segment index changes). Called from `renderCompact` while compact is active, and once when entering compact or switching orientation.
- Labels are SVG text; values come from the same sources as `renderNext`/the target line (free-ride and all-out texts, ramp ranges, intensity multiplier), so the full and the compact view never disagree. Label strings are measured with `getComputedTextLength()` when the string or the size changes, not every tick.
- **Vertical labels:** left gutter of 80 px. NOW (kicker, watts, "{time} left") sits above the position line, NEXT (kicker, watts or range, "in {time}") below the dotted next-start line, so they point away from each other. Edge rules (pure function, unit-tested): NOW is clamped to at least 48 px from the top of the graph, NEXT to the bottom; if the boxes still overlap, drop NEXT's second line, then NEXT. No NEXT label when there is no next segment.
- A next segment that is a ramp is drawn as a slope and labelled with its range (`70–210 W`).
- Not interactive (`pointer-events: none`). The drawing is `aria-hidden`; the label text is real text. The labels are not a live region (they change every second); the graph has an accessible name (`compactGraphAria`).
- 120 minute workouts: at 268 px graph height a minute is about 2 px, so a 4 minute rest is a 9 px block. Segments of a pixel or less in very long workouts are accepted.

## Heading, footer, controls

- **Vertical heading:** draggable region, traffic-light space (80 px, as today), status dot (tooltip as today), gears while the segment is free-like, expand. The workout title and the status text are not shown.
- **Vertical footer:** play / pause and stop, workout left right-aligned (label above a 22 px number). Below 244 px height the footer goes away; play and the workout-left number (no label, 20 px) move into the heading row, the stop button is omitted (rider expands to stop).
- Workout left is never hidden (the old `data-xs` rule is removed).

## Numbers shrink to fit

Long values step down 1 px at a time until they fit, never below a floor: target 12 px, gauge number 16 px, workout left 14 px, tile numbers 14 px, graph watts 12 px. This replaces "hidden, not shrunk" for these values only; captions keep the 11 px floor and still hide when they do not fit. Cases: ramp `100–1000 W`, four-digit watts, `10:15:00`.
- A pure helper `fitFontSize(measure, avail, min, max)` in `compact.js` (largest size in [min, max] whose measured width fits; `measure(size)` injected so it is unit-testable). The DOM glue calls it **only when the text changes** (cache the last string per element) and from the `ResizeObserver` callback, never on every tick.

## Degradation (below the guaranteed sizes)

Window minimum is 240 × 150, but not everything fits everywhere. Order in which things give way, vertical: graph (below 360 px high) → footer into the heading (below 244) → heart rate and cadence tiles (below 190). The horizontal layout is fixed at 150 px and up; in a narrow horizontal window (640 px) the graph labels shorten as described. Hiding the tiles below 190 px high is the only place the "never hidden" goal is not met, at a size nobody should ride at (a 240 × 150 window); revisit if the reporter objects.

## What changes in the code

- **Removed:** the CURRENT and NEXT compact panels and their markup, `cRing` (the compact `ProgressRing`), the compact target of `renderNext` (`#cmp-next`, `cmp-next-in`, `.cp-opt` variants), `cmp-seg*`, `cmp-tgt`, `cmp-bar`, the `.cp-meta` label+value markup, the four old tiers in `compact.css`, and `compactMode`'s old flags. Full ride screen untouched.
- **Kept:** the single compact DOM that is never rebuilt, `cGauge`, `CompactView`, status / connection title handling, the gears and the `C` toggle.
- **Added:** the live block markup (gauge, target line, two tiles), the graph slot and panel, the rail (horizontal), `CompactGraph`, `compactMode` rewrite, `fitFontSize`, label placement, the new CSS in `ui/css/views/compact.css` (layers, native nesting with `&`, tokens only; zone colours via `--zN-ink`).

## i18n (English, German, French)

New keys in `en.js`, `de.js`, `fr.js` (French typography rules; `node scripts/check-i18n.mjs` must pass): `compactNow` ("Now" / "Jetzt" / "Maintenant"), `compactLeft` ("{time} left" / "{time} übrig" / "{time} restant"), `compactGraphAria` ("Workout profile"). Reused: `devHr`, `cadence`, `compactNext`, `compactIn`, `compactWorkoutLeft`, `gFree`, `gAllOut`. Removed once unused: `compactCurrent`. Check the longest German and French `compactWorkoutLeft` at 240 px (label above number); if it wraps or clips, shorten the string, not the layout.

## Window (Rust)

`ride_window.rs`: compact minimum becomes **240 × 150** (`apply`, the test double that stores `(320, 200)`, and its tests). Initial first-time size stays 960 × 200; the full-view minimum 900 × 640 stays; remembered geometry as before. `cargo test` and clippy stay green.

## Edge cases

- Workout without a next segment: no NEXT label. FTP test workouts: same graph; targets are actual targets, never the test-estimated FTP.
- Free ride and all-out segments: target line and graph labels use the existing texts; bar is the grey free block.
- Intensity changes (+/−): every shown watt value includes the multiplier; the bars show the planned profile and do not move.
- Auto-pause, switching to the full view and back, orientation change on resize: the DOM is not rebuilt; the graph redraws on size / orientation change and `update` runs on entry.
- A ride that has not started: position line at the top / left, NOW label shows the first target.

## Verification

- Unit tests (`scripts/compact-ride.test.mjs` or a sibling): `compactMode` boundaries (layout choice at 639 / 640 wide and the 1.5 ratio; `live` 519 / 520, `graph` 359 / 360, `foot` 243 / 244, `tiles` 189 / 190); `fitFontSize`; label placement (edge clamps, overlap rules, no next segment, horizontal shortening ladder); graph geometry (position of a segment start, past dimming at a boundary).
- `node scripts/check-i18n.mjs`, `scripts/check-html.mjs`, `scripts/check-css.mjs`, `cd src-tauri && cargo test`, `cargo clippy --all-targets` stay green.
- Run the app with `?sim=1`: both themes; English, German, French; a 60 and a 120 minute workout; ERG, free-ride and all-out segments; a ramp as current and as next, including `100–1000 W`; sizes vertical 240 × 200, 240 × 300, 240 × 400, 240 × 520, 240 × 640, 240 × 760, 320 × 560; horizontal 640 × 150, 960 × 150, 1400 × 150, 960 × 340.
- **Overflow check** for every combination: no element's box leaves its panel, no leaf text has `scrollWidth > clientWidth`, no SVG text leaves its SVG. The reference mockup page used exactly this check; port it to a script or the browser mock (`scripts/shots/`).
- Update README (compact view, 240 × 150 minimum, graph), DESIGN.md (compact block, target line, icon tiles, graph, max widths), AGENTS.md (compact section: two layouts, `compactMode` flags, `CompactGraph`, shrink-to-fit rule, 240 × 150) and the spec pointer comment in `compact.js`. Retake the website `compact` screenshot (`node scripts/shots/run.mjs compact`) and check the mock (`scripts/shots/mock.js`) works with the new DOM.

## Calls I made (to check)

1. **Layout switch:** horizontal at width ≥ 640 and width ≥ 1.5 × height; vertical otherwise. Mock default, tune on hardware.
2. **Thresholds** in the vertical layout (520 / 360 / 244 / 190) come from the mockup arithmetic (fixed parts of 372 px for the column variant, 244 px for the row variant, graph ≥ ~110 px).
3. **Minimum 240 × 150** and the initial size 960 × 200 unchanged (the reporter wanted a flat window; a rider's remembered size takes over after the first use). A narrow window under 190 px high hides the tiles.
4. **Stop button:** the mockups drew only play and expand in the horizontal rail; I put play and stop on one row and expand below it. In the short vertical heading the stop button is omitted.
5. **Gears and status dot** (virtual shifting, connection): kept in the vertical heading; in the horizontal layout the gears are a small − / + row in the rail and the status dot is dropped (tooltip on the expand button's neighbour is the builder's choice).
6. **Max widths:** live block 300–420 px, graph 200–720 px; the gap sits between them. I read "max-width for the header" as the live block.
7. **Zone text colour** for the target uses the existing `--zN-ink` tokens, not the bright zone fills.
8. **Shrink floors** (12 / 14 / 16 px) and the en-dash ramp range (`70–210 W`, the full view uses `70 → 210 W`) are my choice.
9. **The gauge scale is not changed** for ramps or very high watts (the mockup page showed a plain gauge).
10. **Label placement** in the horizontal graph uses character-count estimates in the mockup; the implementation should measure text.

## Changes made while building (after the owner tried the app)

These decisions were taken during testing and supersede the sections above where they differ.

- **Window sizes, explicit layout choice.** The wide bar is a fixed **195 px** high window (from 640 px wide); the tall column is **240–320 px** wide at any height (minimum height 150). The ranges never overlap, so the layout is chosen with a switch button (rail and heading row) or the **V** key; `Ride.switchLayout()` sets the other layout's limits (`ride_window_bar`) and resizes (`ride_window_size`) to the size that layout had last (defaults 960 × 195 and 300 × 640). The first-time size is 960 × 195. The switch gives way to the gears in free-like segments and below 244 px high (V still works).
- **Drag regions.** The wide layout has no heading row, so `data-tauri-drag-region` is on the rail, the gap, the footer and the panels.
- **Equal buttons.** Play, stop, expand, layout switch and gear buttons are one 30 px size.
- **Rail.** One column of 30 px buttons: play / pause, stop, layout switch, expand; the gear buttons replace the layout switch while free-like (V still switches). The rail is as wide as one button.
- **Wide bar sizes.** Live block 300–460 px, a fixed 16 px gap, the graph takes everything else and is at least 60 % of the window width from 1400 px up (its minimum is `min(60vw, 100vw - 540px)`, so below that the live block keeps its 460 px first). Values are large for reading from a distance: target 24 px, heart rate / cadence 30 px, workout left 26 px, graph labels 14 px, captions 12 px, and 34 / 40 / 34 / 17 / 13 px in a bar of 170 px and more (always the case at 195 px). The graph's label strip follows the CSS label size.
- **Tall column values.** Target 28 px (24 px in the row variant), gauge number 32 % of the dial, a single watts value on the graph up to 24 px (a range shrinks to the 80 px gutter, then an ellipsis). The label blocks were re-measured (NOW_MIN 54, NEXT_3 52, NEXT_2 40).
- **Labels.** Gutter texts (kicker, watts, sub-line) shrink and are cut with an ellipsis, so French and German never reach the bars; the horizontal labels are measured only when a text or place changes.
- **Gear buttons / status dot** are hidden below 244 px high in the tall layout (`data-foot="head"`).

## Left to the builder

Exact CSS values and spacing (the mockup numbers are the reference), the name and file of the graph class, how the compact graph gets the workout (same `this.w` the `Diagram` gets), the exact German and French strings, the place of the status dot and gears in the horizontal rail, and the fine tuning of the label clamp rules near the top and bottom of the vertical graph.

# Compact ride view: three mini panels — design

**Issue:** https://github.com/steffenr/zwo-trainer/issues/12
**Builds on:** [2026-11-13-compact-ride-design.md](2026-11-13-compact-ride-design.md) (window lifecycle, `CompactView`, `ride_window.rs` stay as they are)
**Decision:** Variant **A, "Three mini panels"**, chosen from four interactive mockups.

## Why

The first compact view shows only numbers: power, target, segment left, workout left. That is too little. The rider loses the gauges, which are the quick visual read of the workout, and loses the LIVE · CURRENT · NEXT structure of the full screen. Variant A was picked because it is the smallest change for riders: the compact view looks like the ride screen, just smaller.

## Goals

- LIVE, CURRENT and NEXT stay visible at every compact size, each with its own label.
- The power gauge (target arc + actual arc) and the segment progress ring stay visible at every size. Less information drops out as the window shrinks, never the gauges.
- Pause/resume, stop and expand stay reachable at every size.

## Non-goals / anti-goals

- No workout chart or mini profile in compact (that is variant C).
- No change to the full ride screen, the window lifecycle, the minimum size (320 × 200) or the initial size (960 × 200).
- No new setting, persistence, Rust command, Tauri permission, crate or dependency.
- Do not rebuild the ride DOM on resize.

## Approaches considered

- **A. Three mini panels (chosen).** LIVE | CURRENT | NEXT as cards: three columns when wide, stacked rows when narrow and tall.
- B. One hero gauge with a nested ring. Scales smallest, but LIVE and CURRENT share one dial.
- C. Gauge plus workout profile strip. Shows what is coming, but needs a profile renderer.
- D. Make the real ride screen responsive. One code path, but the largest change to the working layout.

## Layout

Four size tiers, set by a `ResizeObserver` on the compact section as a `data-mode` attribute (width ≥ 560 is "wide", height < 260 is "short" when wide, height < 300 when narrow):

| Tier | Layout | Panel content |
|---|---|---|
| wide, short (960 × 200) | 3 columns, each gauge left, text right | LIVE: gauge, HR, cadence · CURRENT: ring, target, segment bar · NEXT: target W, duration @ %, "in m:ss", name |
| wide, tall | 3 columns, gauge above text | same |
| narrow, tall (240 × 520) | 3 stacked rows, gauge left, text right | same |
| narrow, short (320 × 200) | 3 small columns | gauge/ring with number, NEXT target and `duration @ %`; HR, cadence, segment bar, names hidden |

- **Controls:** pause/resume and stop sit in the footer. When the window is shorter than 240 px they move into the heading row together with "workout left", so the panels get the height.
- **Heading row** (draggable, room for macOS traffic lights): title, connection/paused status dot, expand.
- **Virtual gears** (−/+) stay in the controls row while the segment is free-like.
- **Workout left** is shown in the footer or heading, and hidden below 300 px width.

## Data and reuse

- LIVE uses a second instance of the existing `Gauge` class, CURRENT a second `ProgressRing`; both are fed by `Ride.render()` with the same values as the full view, in the same place. NEXT reuses the strings already built for `#next-card`.
- Free and all-out segments use the same labels as the full view (`gFree`, `gAllOut`, `bigFree`), never a made-up ERG target.
- Missing sensors show a dash. The "on target" glow is not carried over.
- The old `.compact-readouts` markup and its `cmp-*` number elements are replaced.

## Verification

- Unit test for a pure `compactMode(width, height)` in `compact.js` (tier boundaries).
- Existing `scripts/compact-ride.test.mjs` stays green; `node scripts/check-i18n.mjs`, `cargo test`, clippy unchanged.
- Run the app with `?sim=1`; look at both themes, EN/DE/FR, ERG, free-ride and all-out segments, at 960 × 200, 640 × 200, 320 × 200, 240 × 520 and 200 × 340 (dragged).
- Update README, DESIGN.md and AGENTS.md in the same change.

## Calls I made (to check)

1. Tiers are driven by `ResizeObserver` and a `data-mode` attribute, not CSS container queries, so older system web views behave the same.
2. The tier thresholds come from the mockup and may need tuning on real hardware.
3. Panel labels reuse `live` and `compactWorkoutLeft`; three new keys were needed (`compactCurrent`, `compactNext`, `compactIn`) because "Current segment" and "Next segment" are too long for 100 px columns. `compactSegmentLeft` is removed.

## Left to the builder

Exact CSS values, gauge stroke widths at small sizes and whether the heading can drop the workout title below 420 px (the mockup does).

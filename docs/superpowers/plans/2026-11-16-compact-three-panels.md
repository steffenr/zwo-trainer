# Compact three mini panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the number-only compact ride readouts with three mini panels (LIVE, CURRENT, NEXT) that keep the gauge and the segment ring at every compact window size.

**Architecture:** The compact section keeps its place inside `#ride`. Its markup gains three panels, filled by `Ride.render()` next to the existing full-view updates; the LIVE panel owns a second `Gauge`, the CURRENT panel a second `ProgressRing`. A pure `compactMode(width, height)` in `compact.js` picks one of four size tiers; a `ResizeObserver` writes the tiers as `data-*` attributes and CSS does the rest. No Rust, no Tauri command, no dependency.

**Tech Stack:** vanilla ES modules, CSS tokens, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-16-compact-three-panels-design.md` (builds on `2026-11-13-compact-ride-design.md`)

## Global Constraints

- Compact minimum inner size 320 × 200, initial 960 × 200 (unchanged; `ride_window.rs` is not touched).
- No new crate, npm dependency, Tauri command or capability; no persisted setting.
- Never call `Ride.build()` on resize; presentation only.
- CSS uses `var(--…)` tokens only (zone colours come from `zoneColor` / `zoneInk`); light and dark themes.
- Every user-visible string goes through `t()` and exists in `en.js`, `de.js` and `fr.js`; run `node scripts/check-i18n.mjs`. No local variable named `t`.
- Free and all-out segments use the full view's labels (`free`, `allOut`, `gFree`, `gAllOut`); never invent an ERG target. Compact readouts use the actual target (`gt`), not a test-estimated FTP.
- `esc()` for any interpolated user/file value in HTML strings.
- Builds warning-free; `cd src-tauri && cargo test` stays green.

## Review Focus

- Free-ride / all-out segment (`gt == null`): LIVE gauge draws no target arc; target text reads Free or All out, never `0 W`.
- Last segment (no NEXT): the NEXT panel shows the "finish" copy already used by the full view, not an empty card.
- No sensor connected: power, HR and cadence show `–`; gauge draws no actual arc.
- Auto-pause / paused / not started: status dot and label still update; gauge and ring stay visible.
- Resizing while riding (dragging through every tier, including entering and leaving compact): no DOM rebuild, no lost gauge, observer cleaned up in `Ride.close()`.
- German and French labels at 320 × 200: no text overflows its panel (ellipsis, no overlap).
- FTP test rides: compact shows the segment's real target, same as before.

---

### Task 1: `compactMode` size tiers

**Files:**
- Modify: `ui/js/compact.js`
- Test: `scripts/compact-ride.test.mjs`

**Interfaces:**
- Produces: `export function compactMode(width: number, height: number): { mode: 'wt'|'ws'|'nt'|'ns', short: boolean, tiny: boolean, narrow: boolean, xs: boolean }`
  - `mode`: width ≥ 560 → `'ws'` if height < 260 else `'wt'`; width < 560 → `'ns'` if height < 300 else `'nt'`.
  - `short`: height < 240 (controls move into the heading row).
  - `tiny`: width < 260 or height < 170.
  - `narrow`: width < 420 (workout title hidden). `xs`: width < 300 (workout-left hidden).

- [ ] **Step 1: Write the failing tests** in `scripts/compact-ride.test.mjs`: `compactMode: wide tiers` (960×200 → `ws`, 900×640 → `wt`, 560×259 → `ws`, 560×260 → `wt`), `compactMode: narrow tiers` (320×200 → `ns`, 240×520 → `nt`, 559×299 → `ns`, 559×300 → `nt`), `compactMode: flags` (320×200 → `short`, `narrow`, not `xs`… check each boundary: 239/240 short, 259/260 tiny width, 419/420 narrow, 299/300 xs).
- [ ] **Step 2:** `node --test scripts/compact-ride.test.mjs` → FAIL (`compactMode` not exported).
- [ ] **Step 3: Implement `compactMode`** in `ui/js/compact.js` exactly per the thresholds above (no state, no DOM).
- [ ] **Step 4:** `node --test scripts/compact-ride.test.mjs` → all PASS.
- [ ] **Step 5: Commit** `git add ui/js/compact.js scripts/compact-ride.test.mjs && git commit -m "Add compact size tiers"`

---

### Task 2: Three-panel markup, translations and render wiring

**Files:**
- Modify: `ui/js/app.js` (compact markup in `Ride.build()` near lines 2047–2066; render block near 2512–2535; `Ride.close()`)
- Modify: `ui/js/i18n/en.js`, `de.js`, `fr.js`

**Interfaces:**
- Consumes: `Gauge`, `ProgressRing` (render.js), `compactMode` (Task 1), `CompactView` as is.
- Produces (DOM ids used by Task 3's CSS): inside `<section class="compact-ride">`:
  - `.compact-head`: keep `.compact-name`, `#cmp-state` (`#cmp-dot`, `#cmp-status`), `#cmp-gears` / `#cmp-gear` (moved here, always visible); add `.compact-short` group (`.cmp-wleft` + play/stop `data-c` buttons) and the expand button.
  - `.compact-main` with three `<section class="cp">`: `.cp-live` (`.cp-ph` label `t('live')`, `.cp-gauge` mount, `#cmp-pow` + `#cmp-pow-sub` in `.cp-center`, `.cp-meta.cp-opt` with `#cmp-hr`, `#cmp-cad`), `.cp-cur` (`.cp-ph` label `t('compactCurrent')`, `.cp-ring` mount, `#cmp-seg` + `#cmp-seg-sub` in `.cp-center`, `.cp-info.cp-opt` with `#cmp-tgt` and `.cp-bar > i#cmp-bar`), `.cp-next` (`.cp-ph` label `t('compactNext')`, `#cmp-next` card with `--zc`).
  - `.compact-foot`: play/stop `data-c` buttons and `.cmp-wleft` (existing `t('compactWorkoutLeft')` label).
  - `this.cGauge = new Gauge(...)`, `this.cRing = new ProgressRing(...)`, `this.cObs` (ResizeObserver, disconnected in `close()`), and `data-mode`, `data-short`, `data-tiny`, `data-narrow`, `data-xs` on the compact section set from `compactMode(el.clientWidth, el.clientHeight)` (compact section must have `container`-free sizing: observe the `.compact-ride` element).
- New keys in all three dictionaries: `compactCurrent` (en "Current", de "Aktuell", fr "En cours"), `compactNext` (en "Next", de "Nächstes", fr "Suivant"). Remove the now-unused `compactSegmentLeft`.

- [ ] **Step 1: Write the failing check.** `node scripts/check-i18n.mjs` currently passes; add the two keys to `en.js` only first and run it → FAIL (de/fr missing). This is the red step for the strings.
- [ ] **Step 2: Add the keys to `de.js` and `fr.js`; remove `compactSegmentLeft` from all three.** Run `node scripts/check-i18n.mjs` → PASS.
- [ ] **Step 3: Replace the `.compact-readouts` and `.compact-controls` markup** with the structure above. Keep `data-c`/`data-shift` attributes so the existing delegated handlers work; duplicate play/stop buttons are fine because `$$('#ride [data-c="play"]')` already updates every match.
- [ ] **Step 4: Construct the compact gauge/ring and observer in `Ride.build()`** after the full-view ones; the observer callback calls `compactMode` and writes the `data-*` attributes (`data-short`, `data-tiny`, `data-narrow`, `data-xs` as `'1'|'0'`). Disconnect it in `Ride.close()`.
- [ ] **Step 5: Replace the old `cmp-*` block in `render()`** with updates from the same locals the full view uses:
  - `this.cGauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() })`, `#cmp-pow` ← `p ?? '–'`, `#cmp-pow-sub` ← `gt != null ? \`${gt} W\` : allOut ? t('gAllOut') : t('gFree')`.
  - `this.cRing.update(Math.min(1, inSeg / s.duration), color)`, `#cmp-seg` ← `fmtTime(Math.max(0, Math.ceil(rem)))`, `#cmp-seg-sub` ← target text (`gt` W, or Free / All out as above), `#cmp-tgt` ← percent line as the full view's `#s-target`, `#cmp-bar` width and background as `#s-bar`.
  - `#cmp-hr`, `#cmp-cad` as before (dash when null; keep the `off-target` toggle on `#cmp-cad`).
  - `.cmp-wleft` (all matches) ← `$('#d-rem').textContent`; status block unchanged; `#cmp-gears` / `#cmp-gear` unchanged.
  - `#cmp-next`: inside the existing `segChanged || force` block, set `#cmp-next`'s `--zc` and innerHTML from the same `big` / `watts` / duration strings already computed for `#next-card` (with the finish/test-done copy when there is no next segment); update `#cmp-next` "in m:ss" every tick from `rem`.
- [ ] **Step 6:** `node --check ui/js/app.js && node scripts/check-i18n.mjs && node --test scripts/compact-ride.test.mjs` → all pass.
- [ ] **Step 7: Commit** `git commit -am "Add LIVE, CURRENT and NEXT panels to the compact ride view"`

---

### Task 3: Tier CSS

**Files:**
- Modify: `ui/css/styles.css` (replace the `compact` block from `.compact-readouts` through the `@media (min-width: 1100px)` rule; keep `body.compact-riding …`, `.compact-head`, `.compact-state`, `.compact-gears` rules)

**Interfaces:**
- Consumes: the ids, classes and `data-mode` / `data-short` / `data-tiny` / `data-narrow` / `data-xs` attributes from Task 2.

- [ ] **Step 1: Layout.** `.compact-ride` flex column (head, main, foot). `.compact-main`: grid, 3 columns by default; `[data-mode="nt"]` → one column, rows `1.25fr 1.25fr .75fr`. `.cp` panel: `var(--surface)` card, `var(--line)` border, 9px radius, `min-width:0; overflow:hidden`.
- [ ] **Step 2: Gauge sizing.** `.cp-gauge` / `.cp-ring` are `container-type: size` cells; the gauge element is `min(100cqw, 100cqh)` square with `.gauge-svg` filling it and `.cp-center` absolutely centred (power / time number sized with `min(…cqw, …cqh)`; sub-line hidden when the cell is under 85 px). Row direction (gauge left, text right) for `[data-mode="ws"]` and `[data-mode="nt"]`; column otherwise.
- [ ] **Step 3: Tiers.** `[data-mode="ns"] .cp-opt { display: none }`; `[data-tiny="1"]` hides `.cp-meta`, `.cp-info` bar and NEXT detail lines; `[data-short="1"]` hides `.compact-foot` and shows `.compact-short` in the head; `[data-narrow="1"]` hides `.compact-name`; `[data-xs="1"]` hides every `.cmp-wleft`. Every label and value has `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.
- [ ] **Step 4: NEXT card.** Reuse the look of `.nx-card` (left bar in `var(--zc)`), smaller type with `clamp()`; stacked bar-on-top in `ns`.
- [ ] **Step 5: Visual check** with the browser mock or `cargo tauri dev -- ` and `?sim=1`: 960×200, 640×200, 320×200, 240×520 and 200×340, light and dark, EN/DE/FR, ERG and a free-ride segment, paused. Fix overflow and overlap found. (The mock window is a plain page: set the `compact-riding` body class and resize the viewport.)
- [ ] **Step 6: Commit** `git commit -am "Style the three compact panels for four size tiers"`

---

### Task 4: Docs and final verification

**Files:**
- Modify: `README.md` (compact view description), `DESIGN.md` (line ~180 compact bullet: panels, tiers, gauges), `AGENTS.md` (the **Compact ride view** bullet: panels, second `Gauge` / `ProgressRing`, `compactMode`, tier attributes; the `compact.js` layout line), `docs/superpowers/specs/2026-11-16-compact-three-panels-design.md` (replace "no new strings are planned" with the two new keys).

- [ ] **Step 1: Update the four documents** as listed; keep the README's flags and wording consistent with the implemented tiers.
- [ ] **Step 2: Run the full checks:** `node --check ui/js/app.js ui/js/compact.js`, `node scripts/check-i18n.mjs`, `node --test scripts/compact-ride.test.mjs`, `cd src-tauri && cargo test && cargo clippy --all-targets`. Expected: all green, no warnings.
- [ ] **Step 3: Commit** `git commit -am "Document the compact three-panel view"`

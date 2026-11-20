# Compact Ride View: Live Block + Workout Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three mini panels of the compact ride view with a live block and a workout graph, in a vertical layout (narrow windows, time runs down) and a horizontal layout (wide windows, time runs across), with a 240 × 150 minimum window.

**Architecture:** One compact DOM that is never rebuilt on resize. `compactMode()` (pure, `ui/js/compact.js`) picks the layout from the window size; a `ResizeObserver` writes it as `data-*` attributes and CSS does the rest. One new `CompactGraph` class draws both orientations into a measured slot. Pure logic (layout choice, label placement, geometry, shrink-to-fit sizing) lives in `compact.js` and is unit-tested in node; the DOM is checked by a Playwright overflow script that runs the real UI against the existing screenshot mock.

**Tech Stack:** Vanilla ES modules (no build step), native CSS layers and nesting, Rust (Tauri 2) for the window minimum, `node --test`, Playwright via `npx` (not a repo dependency).

**Spec:** [docs/superpowers/specs/2026-11-20-compact-graph-layout-design.md](../specs/2026-11-20-compact-graph-layout-design.md). Visual and numeric reference (real-pixel mockups, exact CSS values, the overflow check it used): [docs/superpowers/specs/assets/2026-11-20-compact-layouts-mockup.html](../specs/assets/2026-11-20-compact-layouts-mockup.html), open it in a browser.

**Branch:** work on a feature branch from `develop` (`feat/compact-graph-layout`); one commit per task; do not push.

## Global Constraints

- No new crates, no new npm dependencies, no bundler, no framework (AGENTS.md). Playwright only through `npx -y -p playwright`.
- Do not rebuild the ride DOM on resize; do not change the full ride screen; no new Tauri command or permission; no new setting or persistence.
- Markup only through `html` templates and `mount()`; no `innerHTML` writes (check: `node scripts/check-html.mjs`). Keep top-level code free of calls into other UI modules (cycle rule in AGENTS.md).
- CSS: only token colours (`var(--…)`) except zone/brand colours; cascade layers (`css/views/compact.css` is the view layer); native nesting always with `&`, declarations before nested rules, ≤ 3 levels; no unlayered CSS, no `<style>`. Check: `node scripts/check-css.mjs`.
- Text: captions 11 px minimum, values 12 px and up. Long values shrink 1 px at a time to a floor (target 12, gauge number 16, workout left 14, tile numbers 14, graph watts 12); captions still hide when they do not fit.
- Every user-visible string goes through `t()` and exists in `en.js`, `de.js` and `fr.js` (French typography per AGENTS.md). Check: `node scripts/check-i18n.mjs`.
- Layout choice: horizontal when `width >= 640 && width >= 1.5 * height`, otherwise vertical. Vertical: `live` is `col` from height 520, `graph` from 360, `foot` moves into the heading row below 244, `tiles` hidden only below 190. Horizontal: live block 300–420 px, graph 200–720 px, empty gap between them.
- Minimum compact window 240 × 150; first-time size stays 960 × 200; full-view minimum 900 × 640 unchanged.
- Rust stays warning-free (`cd src-tauri && cargo test`, `cargo clippy --all-targets`). Update README.md, DESIGN.md and AGENTS.md in the same change (Task 8).

## Review Focus

Inputs the spec implies but a happy-path run does not exercise (each has its pinning test in the named task):

1. **Free-ride, max-effort and all-out segments** (no ERG target): the target line and graph labels show the existing words, never `null W` or `NaN`. (Task 1 `levelView`; Task 4 scenario `allout`.)
2. **Last segment, single-segment workout, no next segment**: no NEXT label, no crash; NOW label stays inside the graph near the top. (Task 1 `placeGraphLabels`; Task 5 scenario `last`.)
3. **Resizing while riding across the 640 px / 1.5 ratio line** (vertical ⇄ horizontal): same DOM element survives, graph redraws in the new orientation. (Task 5.)
4. **No sensors, zero power, intensity ≠ 100 %**: tiles show `–`, gauge at zero, watts in labels include the multiplier but bars do not move. (Task 1 `levelView` with `m`; Task 4 scenario `nosensor`.)
5. **Longest strings and extreme values**: German and French workout-left label at 240 px, `10:15:00`, a ramp `100–1000 W`, four-digit watts. (Task 6 stress scenario in all three languages.)

---

### Task 1: Pure compact logic in `compact.js`

**Files:**
- Modify: `ui/js/compact.js` (replace `compactMode`; add the functions below; keep `CompactView` untouched)
- Modify: `scripts/compact-ride.test.mjs` (replace the three old `compactMode` tests at the end of the file; keep the `CompactView` tests)

**Interfaces:**
- Produces (all exported from `ui/js/compact.js`, no DOM, no imports):
  - `compactMode(width: number, height: number): { layout: 'h' | 'v', live: 'col' | 'row', graph: boolean, foot: 'foot' | 'head' | 'rail', tiles: boolean }`
  - `fitFontSize(measure: (size: number) => number, avail: number, min: number, max: number): number`
  - `levelView(seg: Segment, m: number, F: number): { kind: 'watts' | 'range' | 'free' | 'maxeffort' | 'allout', a?: number, b?: number }` — `seg` has `p0`, `p1` (fractions of FTP or `null`), `erg`, `type`; `m` intensity multiplier; `F` FTP in watts; `a`/`b` are `Math.round(p * F * m)`.
  - `maxPOf(segments: Segment[]): number` — `Math.max(1.2, ...all p0/p1) * 1.08` (the `Diagram` rule).
  - `segmentPoints(seg: Segment, geo: { orientation: 'h' | 'v', total: number, maxP: number, length: number, breadth: number, top?: number, gutter?: number }): string` — four `x,y` pairs with two decimals joined by spaces; `p0/p1 === null` count as 0.5. Horizontal: `x = t / total * length`, `y = breadth - p / maxP * (breadth - top)`, points `[x0,breadth] [x0,yA] [x1,yB] [x1,breadth]`. Vertical: `y = t / total * length`, `x = gutter + p / maxP * (breadth - gutter)`, points `[gutter,y0] [xA,y0] [xB,y1] [gutter,y1]`.
  - `placeGraphLabels({ height, yNow, yNext }: { height: number, yNow: number, yNext: number | null }): { nowBase: number, next: null | { top: number, lines: 3 | 2 } }` — constants `NOW_MIN = 48`, `NEXT_3 = 46`, `NEXT_2 = 31`, `GAP = 2`; `nowBase = max(yNow, NOW_MIN)`; for `lines` of 3 then 2: `top = min(yNext, height - NEXT_lines)`; the first with `top >= nowBase + GAP` wins; none, or `yNext === null`: `next = null`.
  - `fitHorizontalLabels({ width, xNow, xNext, now, next, measure }: { width: number, xNow: number, xNext: number, now: [string, string], next: [string, string] | null, measure: (s: string) => number }): { now: string, next: string }` — `now[0]` if `measure(now[0]) <= xNow - 6` else `now[1]`; `next[0]` if `xNext + 6 + measure(next[0]) <= width`, else `next[1]` if it fits, else `''`; `next === null` gives `''`.

- [ ] **Step 1: Write the failing tests** (replace the old `compactMode` tests in `scripts/compact-ride.test.mjs`; imports from `../ui/js/compact.js`)

```js
test('compactMode: layout choice', () => {
  assert.equal(compactMode(639, 150).layout, 'v');
  assert.equal(compactMode(640, 150).layout, 'h');
  assert.equal(compactMode(640, 426).layout, 'h');
  assert.equal(compactMode(640, 427).layout, 'v');   // 640 < 1.5 * 427
  assert.equal(compactMode(1400, 150).layout, 'h');
  assert.equal(compactMode(960, 340).layout, 'h');
  assert.equal(compactMode(700, 700).layout, 'v');
});
test('compactMode: horizontal is fixed, vertical thresholds', () => {
  assert.deepEqual(compactMode(960, 150), { layout: 'h', live: 'row', graph: true, foot: 'rail', tiles: true });
  assert.equal(compactMode(240, 519).live, 'row');  assert.equal(compactMode(240, 520).live, 'col');
  assert.equal(compactMode(240, 359).graph, false); assert.equal(compactMode(240, 360).graph, true);
  assert.equal(compactMode(240, 243).foot, 'head'); assert.equal(compactMode(240, 244).foot, 'foot');
  assert.equal(compactMode(240, 189).tiles, false); assert.equal(compactMode(240, 190).tiles, true);
});
test('fitFontSize: largest size that fits, clamped', () => {
  const m = (s) => s * 5;
  assert.equal(fitFontSize(m, 60, 11, 24), 12);
  assert.equal(fitFontSize(m, 59, 11, 24), 11);
  assert.equal(fitFontSize(m, 10, 14, 24), 14);     // never below the floor
  assert.equal(fitFontSize(m, 1000, 14, 24), 24);   // never above the cap
});
test('levelView: watts, ramp, free, max effort, all-out, intensity', () => {
  assert.deepEqual(levelView({ p0: .56, p1: .56 }, 1, 250), { kind: 'watts', a: 140, b: 140 });
  assert.deepEqual(levelView({ p0: .28, p1: .84 }, 1, 250), { kind: 'range', a: 70, b: 210 });
  assert.deepEqual(levelView({ p0: .5, p1: .5 }, 1.2, 250), { kind: 'watts', a: 150, b: 150 });
  assert.equal(levelView({ p0: null, p1: null, type: 'freeride' }, 1, 250).kind, 'free');
  assert.equal(levelView({ p0: null, p1: null, type: 'maxeffort' }, 1, 250).kind, 'maxeffort');
  assert.equal(levelView({ p0: 1, p1: 1, erg: false }, 1, 250).kind, 'allout');
});
test('maxPOf and segmentPoints', () => {
  assert.ok(Math.abs(maxPOf([{ p0: .5, p1: .5 }, { p0: 1, p1: 1.3 }]) - 1.404) < 1e-9);
  assert.ok(Math.abs(maxPOf([{ p0: .5, p1: .5 }]) - 1.296) < 1e-9);
  const h = { orientation: 'h', total: 60, maxP: 1.1, length: 200, breadth: 110, top: 10 };
  assert.equal(segmentPoints({ start: 10, duration: 10, p0: .5, p1: 1.1 }, h), '33.33,110.00 33.33,64.55 66.67,10.00 66.67,110.00');
  const v = { orientation: 'v', total: 60, maxP: 1.1, length: 120, breadth: 100, gutter: 20 };
  assert.equal(segmentPoints({ start: 30, duration: 30, p0: 1.1, p1: .55 }, v), '20.00,60.00 100.00,60.00 60.00,120.00 20.00,120.00');
  assert.equal(segmentPoints({ start: 0, duration: 60, p0: null, p1: null }, v), '20.00,0.00 60.00,0.00 60.00,120.00 20.00,120.00'); // free block at 0.5
});
test('placeGraphLabels: clamps, overlap, no next', () => {
  assert.deepEqual(placeGraphLabels({ height: 200, yNow: 60, yNext: 80 }), { nowBase: 60, next: { top: 80, lines: 3 } });
  assert.deepEqual(placeGraphLabels({ height: 200, yNow: 10, yNext: 14 }), { nowBase: 48, next: null });
  assert.deepEqual(placeGraphLabels({ height: 100, yNow: 40, yNext: 70 }), { nowBase: 48, next: { top: 54, lines: 3 } });
  assert.deepEqual(placeGraphLabels({ height: 100, yNow: 60, yNext: 70 }), { nowBase: 60, next: { top: 69, lines: 2 } });
  assert.deepEqual(placeGraphLabels({ height: 80, yNow: 60, yNext: 70 }), { nowBase: 60, next: null });
  assert.deepEqual(placeGraphLabels({ height: 200, yNow: 5, yNext: null }), { nowBase: 48, next: null });
});
test('fitHorizontalLabels: shortening ladder', () => {
  const measure = (s) => s.length * 7;
  const now = ['Now 140 W', '140 W'], next = ['Next 220 W · in 8:00', 'Next 220 W'];
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 67, xNext: 93, now, next, measure }), { now: '140 W', next: 'Next 220 W' });
  assert.deepEqual(fitHorizontalLabels({ width: 600, xNow: 200, xNext: 260, now, next, measure }), { now: 'Now 140 W', next: 'Next 220 W · in 8:00' });
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 67, xNext: 190, now, next, measure }), { now: '140 W', next: '' });
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 67, xNext: 93, now, next: null, measure }), { now: '140 W', next: '' });
});
```

- [ ] **Step 2: Run to verify failure** — `node --test scripts/compact-ride.test.mjs`. Expected: the new tests FAIL (functions not exported / old `compactMode` shape); the `CompactView` tests still pass.
- [ ] **Step 3: Implement the functions in `ui/js/compact.js`** per the Interfaces block. `levelView` kind order: `erg === false` → `allout`; `p0 === null` → `maxeffort` when `type === 'maxeffort'` else `free`; `p0 !== p1` → `range`; else `watts`. Update the header comment above `compactMode` to point to the new spec.
- [ ] **Step 4: Run to verify pass** — `node --test scripts/compact-ride.test.mjs`. Expected: all PASS.
- [ ] **Step 5: Commit** — `git add ui/js/compact.js scripts/compact-ride.test.mjs && git commit -m "Add pure compact layout, label and fit logic"`

---

### Task 2: i18n keys

**Files:**
- Modify: `ui/js/i18n/en.js`, `ui/js/i18n/de.js`, `ui/js/i18n/fr.js` (next to the other `compact*` keys near the top of each file)

**Interfaces:**
- Produces keys: `compactNow`, `compactLeft` (placeholder `{time}`), `compactGraphAria`.

| key | en | de | fr |
|---|---|---|---|
| `compactNow` | Now | Jetzt | Maintenant |
| `compactLeft` | {time} left | {time} übrig | {time} restant |
| `compactGraphAria` | Workout profile | Trainingsprofil | Profil de l’entraînement |

- [ ] **Step 1: Add the three keys to `en.js` only.** Run `node scripts/check-i18n.mjs`. Expected: FAIL (de/fr lack the keys).
- [ ] **Step 2: Add them to `de.js` and `fr.js`.** Run `node scripts/check-i18n.mjs`. Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -am "Add compact graph strings"`

---

### Task 3: Overflow-check harness for the real UI

**Files:**
- Create: `scripts/shots/lib.mjs` (extracted from `run.mjs`), `scripts/shots/compact-fit.mjs`
- Modify: `scripts/shots/run.mjs` (import from `lib.mjs` instead of defining the pieces)

**Interfaces:**
- `lib.mjs` exports: `loadPlaywright(): { chromium }` (the function at `run.mjs:59-68`); `startServer(uiDir: string): Promise<{ base: string, close(): void }>` (the static server at `run.mjs:71-80`); `helpers(page, theme)` (the `helpers` function at `run.mjs:169-195`, taking `base` through a module-level `setBase(base)` or a parameter); `newShotPage(browser, { base, fixture, theme, viewport, scale, free, tweakRider }): Promise<{ page, context, errors }>` (the context + fake clock + init script part of `capture` at `run.mjs:197-213`).
- `compact-fit.mjs` CLI: `npx -y -p playwright node scripts/shots/compact-fit.mjs [--theme dark|light] [--lang en|de|fr]` (defaults: both themes, all three languages). Prints one line per case `PASS|FAIL <WxH> <lang> <theme> <scenario>` plus details, ends with `compact-fit: <n> problems`, exit code 1 when `n > 0`.
  - **Sizes:** vertical 240×200, 240×300, 240×400, 240×520, 240×640, 240×760, 320×560; horizontal 640×150, 960×150, 1400×150, 960×340.
  - **Scenarios:** `steady` (ride Sweet Spot 3×12 to 18:44 as the `compact` shot does), `allout` (20-minute FTP test at 54:15, as `test-20min`), `nosensor` (rider with `settings.devices = {}`), `last` (steady ride, then `ride.go(duration - 20)` through `(await import('/js/core.js')).ride`), `stress` (Task 6).
  - **Per case:** enter compact (`#btn-compact`), `page.setViewportSize`, tick 600 ms; assert `.compact-ride[data-layout]` equals `compactMode(w, h).layout` (import `ui/js/compact.js`); run the overflow check: for every element inside `.compact-ride` with a non-zero box, its box lies inside its nearest `.cp, .compact-foot, .compact-head, .compact-rail, .compact-ride`; no leaf text element has `scrollWidth > clientWidth + 1`; no SVG `<text>` box leaves its `<svg>`; no text contains `null`, `NaN` or `undefined`.
  - Resize case `flip`: at 960×150 set `data-probe` on `.compact-ride`, resize to 240×520 and back, assert the same element still carries `data-probe`.

- [ ] **Step 1: Extract `lib.mjs` and rewire `run.mjs`.** Verify: `npx -y -p playwright node scripts/shots/run.mjs --list` prints the list, and `npx -y -p playwright node scripts/shots/run.mjs ride compact` prints `unchanged` for all four images (the refactor must not change a pixel).
- [ ] **Step 2: Write `compact-fit.mjs`** per the Interfaces block.
- [ ] **Step 3: Run it against the current (old) UI.** Run: `npx -y -p playwright node scripts/shots/compact-fit.mjs --theme dark --lang en`. Expected: FAIL lines (at minimum the missing `data-layout` attribute and overflow at 240 px); this is the failing test for Tasks 4–6.
- [ ] **Step 4: Commit** — `git add scripts/shots && git commit -m "Add overflow check for the compact ride view"`

---

### Task 4: New compact DOM, CSS and live block (both layouts, graph slot still empty)

**Files:**
- Modify: `ui/js/ride/ride.js` (compact markup in `build()` at the `<section class="compact-ride">` block and the `cmpCtl`/`cmpWl` templates; the `fitCompact` ResizeObserver callback; remove `cRing`; `renderNext` loses its compact target; rewrite `renderCompact`)
- Modify: `ui/js/render.js` (`Gauge` compact variant)
- Rewrite: `ui/css/views/compact.css`
- Modify: `ui/js/i18n/en.js`, `de.js`, `fr.js` (delete `compactCurrent`)

**Interfaces:**
- Consumes: `compactMode`, `levelView` (Task 1); keys from Task 2.
- Produces — `Gauge` gets an options argument: `new Gauge(container, { compact: true })`. Compact mode draws: one track arc (`r = 80`), one actual arc (`r = 80`, class `g-actual`, zone colour of the actual power), one target tick (new class `g-tick`: a line from `r = 70` to `r = 92` at `target / max`, stroke `var(--text)`, width 3). No target arc, no inner track, no FTP tick. `update({ target, actual, ftp, bounds })` is unchanged; `max` rule unchanged (`Math.max(ftp * 1.5, target * 1.1, actual * 1.05)`).
- Produces — DOM contract (ids/classes later tasks rely on):
  - `.compact-ride` with `data-layout="h|v"`, `data-live="col|row"`, `data-graph="1|0"`, `data-foot="foot|head|rail"`, `data-tiles="1|0"` written from `compactMode(cmpEl.clientWidth, cmpEl.clientHeight)`.
  - `.compact-head[data-tauri-drag-region]`: `#cmp-dot` status dot (`.on` when connected; `#cmp-state` keeps the tooltip/`aria-label` as today), visually hidden `#cmp-status[role=status]`, `.cmp-gears` (hidden unless free-like; use classes and `qsa`, there are two copies), `.compact-short` (workout-left number `.cmp-wleft` + play button, shown when `data-foot="head"`), expand button.
  - `.compact-main` containing `.cp.cp-live` (`#cmp-gauge` mount, `#cmp-pow`, target line `#cmp-target`, tiles with `#cmp-hr`, `#cmp-cad` each with an `aria-label`/`title` from `devHr` / `cadence`), `.cp-gap` (the empty space in the horizontal layout), `.cp.cp-graph` (header with `compactWorkout…` label from `workout` and a `.cp-wl` workout-left number; body `#cmp-graph` slot, empty in this task).
  - `.compact-foot` (play, stop, `.cmp-wl.big` with label `compactWorkoutLeft` above `.cmp-wleft`), `.compact-rail` (play, stop, expand, `.cmp-gears`; shown when `data-foot="rail"`).
  - All play/stop/expand buttons keep their `data-act` attributes (event delegation and `renderControls` already use `qsa('#ride [data-act="play"]')`).
- Shrink hooks (used by Task 6): put `data-fit="min,max"` on `#cmp-target` (`12,19`), `.cmp-wleft` (`14,22`) and the two tile numbers (`14,24`); `#cmp-pow` gets `data-fit="16"` and its maximum is 25 % of the gauge width.
- Target line: `#cmp-target` shows bolt icon + `levelView` text of the current segment (`watts` uses the real `gt` incl. virtual shifting; `range` shows `a–b W` with an en dash; `free`/`maxeffort`/`allout` show `t('gFree'|'maxEffort'|'gAllOut')`), coloured `zoneInk(gt / F, bounds())`, `var(--muted)` when there is no target. HR / cadence `–` when missing; cadence tile keeps the `off-target` class from `cadState`.

CSS reference: the mockup file (`.win`, `.cp`, `.tile`, `.tgt`, `.hmain` grid, `.rail`); numbers to keep: vertical live block `col` = gauge 116 px, `row` = gauge 84 px with target above two stacked tiles; tiles 24 px numbers; target 19 px bold; footer workout-left number 22 px; horizontal grid `grid-template-columns: minmax(300px, 420px) minmax(0, 1fr) minmax(200px, 720px)`, rail 96 px wide, gauge at most 150 px, live content vertically centred.

- [ ] **Step 1: Confirm the failing test.** Run `npx -y -p playwright node scripts/shots/compact-fit.mjs --theme dark --lang en`. Expected: FAIL (as at the end of Task 3).
- [ ] **Step 2: Implement `Gauge` compact mode** in `render.js` per the Interfaces block (a `compact` flag selects the constructor drawing and the `paint()` branch).
- [ ] **Step 3: Replace the compact markup in `build()`**, remove `cRing`, the compact branch of `renderNext` (`#cmp-next`, `cmp-next-in`, `.cp-opt` variants) and the old `cmp-*` writers; write the five `data-*` attributes in `fitCompact`; rewrite `renderCompact` so it only writes changed values (`setText`/`setAttr`, cached lookups via `this.q` / `this.qsa`, never `querySelector` per tick).
- [ ] **Step 4: Rewrite `ui/css/views/compact.css`** for both layouts keyed on the `data-*` attributes (the file keeps the `body.compact-riding` rules that show `.compact-ride` and hide the full view). Delete `compactCurrent` from the three dictionaries.
- [ ] **Step 5: Verify.** `npx -y -p playwright node scripts/shots/compact-fit.mjs --theme dark --lang en` then `--theme light --lang de`: Expected PASS for scenarios `steady`, `allout`, `nosensor`, `flip` at every size (the graph slot is empty). Then `node --check ui/js/ride/ride.js ui/js/render.js && node scripts/check-css.mjs && node scripts/check-html.mjs && node scripts/check-i18n.mjs && node --test scripts/*.test.mjs`. Look at 240×520 and 960×150 with `run.mjs compact --out <tmp>` style screenshots in both themes (`s.resize` in a throwaway shot or the app via `cargo tauri dev` with `?sim=1`) and compare with the mockup.
- [ ] **Step 6: Commit** — `git add -A ui && git commit -m "Replace compact panels with a live block in two layouts"`

---

### Task 5: `CompactGraph` and its wiring

**Files:**
- Modify: `ui/js/render.js` (new class `CompactGraph`, next to `Diagram`)
- Modify: `ui/js/ride/ride.js` (create it in `build()`, orientation from `fitCompact`, `update` from `renderCompact`, redraw on resize, label strings)
- Modify: `ui/css/views/compact.css` (graph panel, slot, SVG text classes)
- Modify: `scripts/shots/compact-fit.mjs` (graph assertions)

**Interfaces:**
- Consumes: `maxPOf`, `segmentPoints`, `placeGraphLabels`, `fitHorizontalLabels`, `fitFontSize`, `levelView` (Task 1); `zoneColor`, `FREE_COLOR` (render.js); keys `compactNow`, `compactLeft`, `compactNext`, `compactIn`, `compactGraphAria`.
- Produces:
  - `class CompactGraph { constructor(slot: HTMLElement, workout: Workout, opts: { bounds: number[] }); setOrientation(o: 'v' | 'h'): void; redraw(): void; update(at: number, labels: GraphLabels): void; destroy(): void }`
  - `GraphLabels = { nowKicker: string, now: [full: string, short: string], nowSub: string, nextKicker: string, next: [full: string, short: string] | null, nextSub: string | null }`
  - Behaviour: `redraw()` measures the slot (`clientWidth`/`clientHeight`) and draws an SVG at that pixel size (a `<polygon>` per segment via `segmentPoints`, colours `zoneColor((p0 + p1) / 2, bounds)` or `FREE_COLOR`, FTP line at p = 1, position line, dotted next-start line); it runs on workout load, on `setOrientation` and on slot resize (observer callback throttled with `requestAnimationFrame`), never per tick. `update(at, labels)` moves the position line, toggles the `done` class on segments that ended before `at` (only when the segment index changes), and places labels: vertical via `placeGraphLabels` (gutter 80 px; kicker 11 px, watts 15 px bold, sub-line 12 px), horizontal via `fitHorizontalLabels` measured with `getComputedTextLength()`. Label watts shrink with `fitFontSize` (floor 12 px) to fit the 80 px gutter. The drawing is `aria-hidden`; the slot has `role="img"` and `aria-label` = `t('compactGraphAria')`; `pointer-events: none`.
  - `Ride` builds `GraphLabels` from the same `frame()` values as the target line (`levelView` for the current and next segment, `this.mult()`, `F`, `rem`, `compactIn`/`compactLeft`/`compactNow`/`compactNext`); a next segment that is a ramp is drawn as a slope and labelled `a–b W`; no next segment gives `next: null`.

- [ ] **Step 1: Extend `compact-fit.mjs` (failing test).** For every case with `data-graph="1"`: `#cmp-graph svg` exists, its `<polygon>` count equals the workout's segment count (read through `(await import('/js/core.js')).ride.w.segments.length`), the position line lies inside the SVG; for scenario `last` the NEXT label is absent and no label leaves the SVG; for `flip` the polygon count is the same after the round trip. Run it: Expected FAIL (no graph yet).
- [ ] **Step 2: Implement `CompactGraph`** per the Interfaces block; construct it in `build()` (the same `this.w` the `Diagram` gets), call `setOrientation` from `fitCompact` (`layout === 'h' ? 'h' : 'v'`), call `update` from `renderCompact` only while `this.compact.active`, and once from `CompactView`'s `apply` when entering compact (next to the existing `diagram.update` call). Disconnect its observer in `close()` next to `cObs`.
- [ ] **Step 3: Style the graph panel** (header, slot `flex: 1`, SVG text uses `--text`, `--text-2`; dimmed segments via a `done` class with reduced opacity) in `compact.css`.
- [ ] **Step 4: Verify.** `npx -y -p playwright node scripts/shots/compact-fit.mjs` (all themes, all languages): Expected `compact-fit: 0 problems`. Then `node --test scripts/*.test.mjs`, `node scripts/check-css.mjs`, `node scripts/check-html.mjs`, and look at 240×520, 240×640, 960×150, 1400×150 (gap between live block and graph) against the mockup.
- [ ] **Step 5: Commit** — `git add -A ui scripts && git commit -m "Draw the workout graph in the compact view"`

---

### Task 6: Shrink-to-fit for long values

**Files:**
- Modify: `ui/js/compact.js` (add the DOM helper `fitTexts(root: HTMLElement): void`; function bodies only, no top-level DOM access so node tests can still import the module)
- Modify: `ui/js/ride/ride.js` (call it)
- Modify: `scripts/shots/compact-fit.mjs` (scenario `stress`)

**Interfaces:**
- Consumes: `fitFontSize` (Task 1).
- Produces: `fitTexts(root)` — for each element in `root` with a `data-fit` attribute (set in the Task 4 markup: `min,max`, or only `min` for `#cmp-pow`, whose maximum is 25 % of its gauge's width), clears its inline `font-size`, then sets the size returned by `fitFontSize` with `measure = (s) => { el.style.fontSize = s + 'px'; return el.getBoundingClientRect().width }` and `avail` = the width of its container minus siblings (icon, padding) as laid out. `Ride` calls it only when one of those texts changed (compare with the last written string, cached on the ride) and from the `fitCompact` observer callback; never every tick.
- Stress scenario `stress` (in `compact-fit.mjs`): after entering compact, set `#cmp-target` to `100–1000 W`, `#cmp-pow` to `1234`, every `.cmp-wleft` to `10:15:00`, `#cmp-hr` to `188`, `#cmp-cad` to `120`, call `(await import('/js/compact.js')).fitTexts(document.querySelector('.compact-ride'))`, then run the overflow check and assert each element's computed font size is at or above its floor.

- [ ] **Step 1: Add the `stress` scenario and run it.** Expected: FAIL (overflow at 240 px, e.g. the target line and workout left).
- [ ] **Step 2: Implement `fitTexts`**, add the `data-fit` attributes to the markup, call it from `Ride` on text change and from `fitCompact`.
- [ ] **Step 3: Verify.** `npx -y -p playwright node scripts/shots/compact-fit.mjs` (all languages, both themes): Expected `compact-fit: 0 problems`, including `stress` in `de` and `fr` at 240 px. If the longest German/French `compactWorkoutLeft` still wraps or clips, shorten that string (not the layout) in the dictionaries and re-run `node scripts/check-i18n.mjs`.
- [ ] **Step 4: Commit** — `git add -A ui scripts && git commit -m "Shrink long compact values to fit"`

---

### Task 7: Window minimum 240 × 150 (Rust)

**Files:**
- Modify: `src-tauri/src/ride_window.rs` (`apply` at the `(320.0, 200.0)` literal, the test double's `(320, 200)` at `apply` in the `#[cfg(test)]` section, and the assertions in `leaving_after_two_failed_restores_resets_the_minimum_and_forgets_the_snapshot`, `entry_and_exit_restore_physical_geometry`, `failed_exit_preserves_compact_geometry_and_the_saved_full_view`, `unavailable_window_position_does_not_block_compact_view`)
- Also update the doc comment that mentions "the lowered 320 × 200 minimum".

**Interfaces:** compact minimum becomes `(240.0, 150.0)` logical px; `(900.0, 640.0)` full-view minimum and the `960.0 × 200.0` first-time size are unchanged.

- [ ] **Step 1: Change the four test assertions and the test double to `(240, 150)`.** Run `cd src-tauri && cargo test ride_window`. Expected: FAIL (production still 320 × 200).
- [ ] **Step 2: Change the production literal in `apply` and the doc comment.** Run `cd src-tauri && cargo test && cargo clippy --all-targets`. Expected: all tests pass, no warnings.
- [ ] **Step 3: Commit** — `git commit -am "Lower the compact window minimum to 240 x 150"`

---

### Task 8: Docs, screenshot, cleanup and final checks

**Files:**
- Modify: `README.md` (the "Compact view for videos" paragraph near line 188: both layouts, the graph, 240 × 150 minimum, what shows where), `DESIGN.md` (compact block: target line, icon tiles, graph, max widths, shrink-to-fit), `AGENTS.md` (compact section and layout listing: `compactMode` returns `layout/live/graph/foot/tiles`, `CompactGraph`, `fitTexts`, compact gauge variant, 240 × 150, the overflow script `scripts/shots/compact-fit.mjs`; add the script to the Commands list)
- Modify: `scripts/shots/shots.mjs` (keep the `compact` shot at 960 × 200 but update `about` if the content changed), `site/` copy only if it states the old minimum or panels (search `site/*.html` for "320" and "three panels")
- Modify: remove any dead compact CSS/markup/i18n left over (`grep` for `cp-opt`, `cp-nx`, `cmp-seg`, `cmp-bar`, `compactCurrent`)

- [ ] **Step 1: Update README, DESIGN.md, AGENTS.md and the site copy** as listed.
- [ ] **Step 2: Retake the screenshot.** `npx -y -p playwright node scripts/shots/run.mjs compact`; open the printed contact sheet once and check both themes. Expected: `compact-dark` / `compact-light` updated, no `page errors` or `unmocked` notes.
- [ ] **Step 3: Full verification.**
  - `node scripts/check-i18n.mjs && node scripts/check-css.mjs && node scripts/check-html.mjs`
  - `node --test scripts/*.test.mjs`
  - `cd src-tauri && cargo test && cargo clippy --all-targets`
  - `npx -y -p playwright node scripts/shots/compact-fit.mjs` (both themes, `en`/`de`/`fr`): `compact-fit: 0 problems`
  - Manual: `cargo tauri dev` with `?sim=1`: toggle compact with **C**, drag the window across the layout switch, check a ramp, a free-ride segment and an all-out effort.
  Expected: all green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "Document the compact graph layout and retake the screenshot"`

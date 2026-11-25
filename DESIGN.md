# DESIGN.md — zwoTrainer design system

The visual and interaction rules for zwoTrainer. The styles live in `ui/css/` (tokens on `:root` in `tokens.css`, see [CSS structure](#css-structure)) plus a few constants in `ui/js/render.js` / `ui/js/riders.js` (avatar colours). Any new screen or component must follow this document; if you introduce a new pattern, document it here.

## CSS structure

Plain CSS, no build step. `styles.css` declares the cascade layers and imports the files. A later layer always wins, whatever the specificity:

| Layer | Files | Holds |
|---|---|---|
| `tokens` | `tokens.css` | colour, font, radius and type-scale tokens; dark overrides |
| `base` | `base.css` | elements, native inputs and their focus/invalid states, text helpers (`.muted`, `.small`, `.eyebrow`, `.meta`, `.k`, `.ic`), shared keyframes |
| `components` | `components/*.css`, one family per file | `buttons` (button, icon button, link, segmented control, tabs, star/⋯) · `card` (card, hero, card header row, section head, back link) · `indicators` (progress bar, badge, week/day tag, zone tag, spinner) · `dialog` · `popover` (+ ⋯ menus) · `notice` (toast, update card) · `list` (history-style table, sync list, service logo) · `forms` · `avatar` · `charts` (chart, mini profile, zone bar, gauge, ring) · `markdown` |
| `views` | `views/*.css` | one file per screen or dialog: top bar, home, plan + workouts lists, history, FTP tests, dialogs, settings, ride, compact ride |
| `utilities` | `utilities.css` | `[hidden]`, `.sr-only`, forced text colours, the global "Reduce motion" switch |

- **Component or view?** If it appears on more than one screen, it is a component. A component file never refers to a view (`check-css.mjs` fails on `body.riding`, `.ride`, `dialog.settings` … in `components/`); a view adapts a component in its own file (e.g. `.ride-title .badge` lives in `views/ride.css`). Screen-only pieces stay in their view even when they look generic (zone limits and folder row in `settings.css`, overlay toggles in `ride.css`).
- **Markup helpers mirror the CSS:** `ui/js/components/<family>.js` renders what `css/components/<family>.css` styles (e.g. `badge()` in `indicators.js`, `dialogHead()` in `dialog.js`, `segCtl()` in `buttons.js`). Use the helper instead of writing the markup again; they build with `html```, so text is escaped. New component: add both files.
- **No atomic-design folders:** at this size atoms and molecules are a few lines each; two levels (components, views) plus families per file are easier to find and to decide.
- **Nesting** groups a component's parts, states and modifiers in one block (`.btn { &:hover {…} &.primary {…} }`), and its motion next to it (`@media (prefers-reduced-motion: no-preference)`). Always write `&`.
- **Motion:** single-use `@keyframes` sit next to their component; shared ones (`mo-fade`, `mo-fade-out`, `mo-settle`, `mo-pop-in`) are in `base.css`.

## Principles

1. **Calm and clean.** The workout is the hero. Few controls, generous whitespace, no decoration that doesn't carry information.
2. **Readable at a distance.** While riding the user sits 1–2 m from the screen, sweating. Ride numbers are big, high-contrast and tabular, and they grow with the window.
3. **Colour means zone.** The five zone colours are reserved for training intensity. UI chrome uses neutral greys and one accent.
4. **Same structure everywhere.** The top bar never changes shape, destructive actions are always behind a "⋯" menu and a confirmation, and dialogs share one layout.
5. **Light and dark are equals.** Light mode is pure white (`#fff`) and dark mode is pure black (`#000`). Every element is checked in both.
6. **Own identity.** The palette is inspired by WhatsOnZwift's zone colours; everything else is zwoTrainer's own.

## Colour

### Theme tokens

Always use tokens (`var(--…)`), never raw hex in components. Dark values apply via `prefers-color-scheme` unless the user forced a theme (`:root[data-theme="light|dark"]`).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#000000` | page background |
| `--surface` | `#ffffff` | `#0b0b0c` | cards, panels, dialogs, inputs |
| `--surface-2` | `#f5f6f8` | `#141416` | hover, segmented-control track, icon tiles |
| `--surface-3` | `#eceef2` | `#1c1c1f` | inline code, muted badges |
| `--line` | `#e5e7eb` | `#232326` | borders, dividers |
| `--line-strong` | `#cfd3da` | `#34343a` | input borders, hover borders |
| `--text` | `#1f2328` | `#f2f2f3` | primary text |
| `--text-2` | `#555555` | `#cccccc` | secondary text |
| `--muted` | `#646b75` | `#85858d` | labels, meta, placeholders, hints (≥ 4.5:1 on `--surface` and `--surface-2`) |
| `--accent` | `#007690` | `#1cc4e6` | primary buttons, links, accent text, selection, progress, focus ring. Light: white on it 5.26:1, on `--surface` 5.26, `--surface-2` 4.86, `--accent-soft` 4.57. Dark: `--accent-ink` on it 9.12:1, on `--surface` 9.45 |
| `--accent-hover` | `#00657b` | `#44d2ee` | hover of accent fills (light: white on it 6.67:1) |
| `--accent-soft` | 10 % accent | 14 % accent | selected backgrounds |
| `--ok` / `--ok-soft` | `#2e9e4f` | `#4cd07a` | connected, success, ERG on |
| `--warn` / `--warn-soft` | `#8a5a12` | `#f2c14e` | connecting, ERG off, changed intensity (`.warn-text`); light value ≥ 4.5:1 as text, also on `--warn-soft` |
| `--danger` | `#c62f26` | `#ff5a4f` | destructive text and buttons, errors (`.danger-text`: failed actions, sync errors); light value ≥ 4.5:1 as text and under white |
| `--danger-ink` | `#ffffff` | `#000000` | label on a `--danger` fill (`.btn.danger`): 5.47:1 on the light `#c62f26`, 6.83:1 on the dark red, where white would be only 3.08:1 |
| `--z4-soft` | 28 % Z4 fill | 18 % Z4 fill | FTP-test badge background; `--text` on it ≥ 12.5:1 light, ≥ 9.7:1 dark |
| `--pos`, `--trace`, `--ftp` | text colour | white | chart position line, power trace, FTP line |
| `--done` | `#00a3c4` (brand cyan) | accent | completed part of the workout; graphic only, never text |
| `--cad` / `--hrline` | `#8b3dff` / `#e0004d` | `#b98bff` / `#ff4d7d` | cadence and heart-rate traces |

### Zone colours (fixed; identical in both themes)

| Zone | Fill | Text ink (light / dark) |
|---|---|---|
| Z1 Recovery | `#7f7f7f` | `#6b6b6b` / `#a6a6a6` |
| Z2 Base endurance | `#338cff` | `#1f74e0` / `#5aa4ff` |
| Z3 Tempo | `#59bf59` | `#2f9a3a` / `#6fd06f` |
| Z4 Threshold | `#ffcc3f` | `#b88a00` / `#ffcc3f` |
| Z5 VO2max | `#ff6639` | `#e4501f` / `#ff7a52` |
| Free ride | `#b4bac2` | — |

- **Fills** are used for bars, chips, tags and filter dots. Text on a fill is black (`.ztag`).
- **Text on a coloured fill** always uses its ink token (`--accent-ink`, `--danger-ink`, `--garmin-ink`), never a literal `#fff`: the dark theme's fills are light, and white on the dark accent is only 2.08:1.
- **Inks** (`--zN-ink`) are for coloured text on the page background, such as target % and upcoming watts.
- **Never** use zone colours for buttons, status or decoration.

### Brand and third-party colours

- The cyan is zwoTrainer's brand colour. The light theme uses a deeper teal-cyan for `--accent` (`#007690`) so text and white labels on it reach 4.5:1; the bright brand cyan `#00a3c4` stays for non-text graphics (`--done`) and the dark theme's `#1cc4e6`. Don't lighten the light accent again: white on `#00a3c4` is only 2.98:1.
- Third-party colours appear only on that service's own control: Garmin `#1d1d1f` (button and logo tile flip to light in dark mode via `--garmin-bg` / `--garmin-ink`). The favourite star uses `--star`.
- Avatar colours (user choice): `#338cff #59bf59 #ff6639 #b47cff #00a3c4 #e0a800 #ff4d8d #7f7f7f` or any custom colour.

## Typography

| Role | Font | Size / weight |
|---|---|---|
| UI text | `--font`: SF Pro Text / system (Segoe UI Variable on Windows, Noto Sans / Cantarell on Linux) | 15 px / 1.45, body |
| Numbers (ride readouts, stats) | `--num`: SF Pro Rounded / `ui-rounded` (Segoe UI / Roboto elsewhere) | tabular figures (`font-variant-numeric: tabular-nums`) |
| Code / paths | `ui-monospace`, SF Mono, Menlo | 12 px in `code` chips |

**Scale:**

| Element | Size and weight |
|---|---|
| `h1` | 26 px, 650 |
| `h2` | 19 px |
| `h3` | 15 px |
| meta | 14 px (`--fs-md`), muted |
| `.small` | 13 px (`--fs-sm`) |
| `.k` labels | 11 px (`--fs-2xs`), uppercase, `letter-spacing: .08em`, 600, muted |
| `.eyebrow` | 11 px (`--fs-2xs`), uppercase, `.09em` |

UI text uses the type tokens only: `--fs-2xs` 11 · `--fs-xs` 12 · `--fs-sm` 13 · `--fs-md` 14 · `--fs-base` 15 · `--fs-lg` 17. Headings (`h1` 26, `h2` 19) and big readouts keep their own sizes. **The smallest text is 11 px (`--fs-2xs`)**, and only for uppercase labels, tags, badges and chart axis labels; running text and fine print are at least 12 px (`--fs-xs`). Fluid sizes (`clamp()` on the ride screen) start and end on the scale or on a readout size, e.g. `clamp(var(--fs-2xs), …, var(--fs-md))`. No half-pixel sizes. Headings use `letter-spacing: -0.01em`.

**Ride readouts:** base sizes at 1400 px width, scaling linearly with `vw` above that, capped at 1.6× (full screen). Use the pattern `clamp(BASEpx, BASE/14 vw, 1.6·BASEpx)`:

| Readout | Base size |
|---|---|
| Watt gauge value | 50 px |
| Segment target | 40 px (range 30 px) |
| rpm / km/h / bpm | 34 px |
| Segment elapsed / duration / remaining (equal) | 28 px |
| Upcoming values | 22 px |
| Intensity (control bar) | 24 px |

The workout clock (elapsed and remaining in the chart header) uses `clamp(22px, 0.6rem + 1.5vw, 56px)` and its total uses `clamp(12px, 0.4rem + 0.5vw, 20px)`.

## Spacing, radius, elevation

| Category | Values |
|---|---|
| Spacing (multiples of 2) | 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32 px |
| Page | `.view` max-width 1120 px, padding 24 px |
| Sections | `.section` margin-top 32 px |
| Radius (tokens) | `--r-xl` 18 dialogs · `--radius` 14 cards/panels · `--r-lg` 12 popovers, inset boxes, rows, toast · `--r-md` 10 buttons, inputs · `--r-sm` 8 small buttons, menu items · `--r-tag` 6 badges, tags, code · `--r-2xs` 3 swatches · `--r-pill` · 50 % avatars and round buttons. Nested corners: inner = outer − padding (`calc(var(--r-md) - 3px)` in the segmented control). |
| Elevation | `--shadow` is a subtle 1 px shadow on cards (none in dark) · `--shadow-lg` for dialogs, popovers and toasts · dark mode relies on borders, not shadows |

**Z-index layers:**

| Layer | z-index |
|---|---|
| Top bar | 5 (30 while riding) |
| Ride overlay | 20 |
| Ride hint | 30 |
| Update card | 90 |
| Toast | 100 |
| Popover | 200 |

## Layout

### App shell

```
┌ top bar (sticky, 60 px, blurred bg, bottom border) ─────────────────────────────┐
│ ● ● ●  [logo] zwoTrainer  [Plans|Workouts|FTP Tests]          [ᛒ•] [📅] [⚙] (R1) │
└──────────────────────────────────────────────────────────────────────────────────┘
#view  (max 1120 px, centred) — home / plan / workouts / tests / history
#ride  (fixed below the top bar while riding)
<dialog id="modal"> (+ #modal-live) · #toast · #live · #popover
```

- **Left padding:** 92 px on macOS (`:root[data-os="mac"]`), leaving room for the traffic lights of the overlay title bar; 24 px on Windows and Linux, which have a normal title bar.
- **Right side:** exactly four controls, in this order:
  1. **Devices**: Bluetooth glyph and three status dots (trainer, HR, shifter), green / amber / grey.
  2. **Ride history**: calendar with a check mark.
  3. **Settings**: gear.
  4. **Avatar**: a 32 px circle, no name label.
- **The bar is identical on every full-size screen.** The optional Compact ride view hides it entirely (see below); it never adds controls to this bar. During a ride:
  - the mode switch is replaced by the ride title (`#ride-title`: badge · title · ERG pill) at the same 40 px height;
  - ride history is shown at 30 % opacity and disabled;
  - the avatar never moves.
- **Never add controls** to the top bar. Theme, preferences and connections live in Settings; occasional actions go in "⋯" menus.

### Ride screen

```
┌ ● LIVE ∿   CONNECTED ┐ ┌ ◎ CURRENT SEGMENT                       STEADY STATE ┐ ┌ ◇ NEXT SEGMENT ──┐
│     (watt gauge)     │ │   ╭ 239 W ╮    ⚡ TARGET POWER   ⟳ TARGET CADENCE    │ │ ▌ 146 W          │
│        244           │ │   │  90%  │       239 W            90 rpm           │ │ ▌ 55%            │
│       239 W          │ │   ╰───────╯    ⏱ SEGMENT         ⚑ REMAINING         │ │ ▌ 5:00 min       │
│ ⚡ POWER   ⟳ CADENCE  │ │                   12:00 ▬▬          5:50            │ │ ▌ 85 rpm         │
│  244 W     86 / 90   │ │                                                     │ │                  │
│ ◠ SPEED   ♡ HR       │ │         [ ⟳ Cadence low · 81 → aim 90 rpm ]         │ │                  │
└──────────────────────┘ └─────────────────────────────────────────────────────┘ └──────────────────┘
[ ılı WORKOUT / ELAPSED 0:00 ······ ● Power ● Cadence ● Heart rate ······ REMAINING 29:58 of 30:00 ]
[ watt axis │ workout chart (fills remaining height), HTML labels under the bars ]
[ ⏮  ↺  ▶/⏸  ■  ↻  ⏭  │  INTENSITY 100%  −  + ]
```

- **Panel grid:** 25 / 50 / 25 (`minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)`) above the chart; the chart takes the remaining height. Below 980 px: Live and Current side by side, Next full width.
- **Panel header** `.ph`: 19 px accent icon · 13 px (`--fs-sm`) uppercase label (letter-spacing .09em; grows to 16 px on wide windows) · optional status on the right (`.ph-status`, 11 px uppercase; green `ok` when connected). LIVE has a status dot (green when a trainer is connected).
- **LIVE** `.live-body`: the watt gauge on top (centred), the four metrics below in a 2 × 2 grid. `.metric`: 19 px icon · uppercase label · value (`--num`, 22 px) + unit + muted extra (`/ 90` cadence target, `69%`) · 5 px bar (`.mbar`). Power shows only the live value (the target is on the gauge); its bar runs 0…1.5× target, coloured by the zone you're riding in. Speed: 0–60 km/h, green. Heart rate: % of max HR.
- **Cadence target:** only when the segment has one, the cadence row shows `86 / 90 rpm` (or `/ 85–95`); the bar spans 40–130 rpm with a marker (or band, for ranges) at the target and turns **green** on target, **amber** 5–10 rpm off, **red** beyond 10 rpm — the value itself turns red too. CURRENT shows it as *Target cadence* (in `--cad`), the next-segment card as its last line.
- **Current-segment ring** `ProgressRing`: a single progress arc in the zone colour (it reuses `Gauge` but removes the inner "actual power" track, the FTP tick and the actual arc — only the LIVE watt gauge has two arcs: outer = target, inner = actual). The centre shows the target in **watts** as the big number (zone ink; a ramp shows its range `119–199 W` with an en dash, smaller via `b.range`) and % of FTP on the line below (`45–75%`).
- **Current segment** `.seg-body`: the ring on the left (`.seg-left`, 210 px, gear box below it in free-ride segments), a 2 × 2 `.seg-stats` grid on the right: target power (zone ink) · target cadence (`--cad`, `–` without a target) · segment duration with a progress bar in the zone colour · remaining (pulses in the last 5 s). Icon · label · 30 px value. Below 1180 px the ring stacks above the grid.
- **Coach line** `.coach-line` under `.seg-body`: one message at a time, icon + 18 px semibold text, centred in a tinted box (`--cc`: accent for workout text events, `--warn`/`--danger` for cadence and pacing, `--ok` for "Back on target", the zone ink for hard-segment cues). Its height is always reserved; it fades in and out (opacity, 4 px slide) so nothing in the panel moves.
- **Test pacing** (all-out test efforts ≥ 5 min): the ring centre shows the running effort average in zone ink, the line below it "avg · aim ~263 W" (or "too fast · ease off" in `--warn` after 1 min at > 110 % of the aim), and the first stat becomes **Est. FTP** (8/20-min efforts) or **Effort avg**. Keep both lines short so they fit inside the ring.
- **Power ranges in stat values** (e.g. `150–113`) drop the unit and use `.stat b.range` (20 px) so they fit their column.
- **Next-segment card** `.nx-card`: 6 px stripe in the zone colour (zone name as tooltip) and the values only, no labels or icons: `146 W` (40 px; a ramp `73 → 219 W` at 32 px via `b.range`), then `55%`, `5:00 min` and, if set, `85 rpm` (22 px, `--text-2`; rpm in `--cad`).
- **Controls row:** buttons centred horizontally and on one centre line (`align-items: center`), the larger play button in the middle. After a divider: **intensity** (`.int-group`: label + value, `--warn` when ≠ 100 %, then − / + as 48 px `.ctl` buttons; Shift-click ±10 %). It scales the whole workout, so it lives with the ride controls, not in a panel.
- **Chart:**
  - Bars stretch (SVG `preserveAspectRatio="none"`), but **all text is HTML layered on top** (`.dg-labels`, `.dg-free`), never SVG text, so it keeps its proportions at any size.
  - Segment labels hide when they don't fit their segment.
- **Feedback for remote actions** (controller buttons) uses the `#ride-hint` pill at the top centre of the ride area, shown for 1.4 s.
- **Paused** dims panels and chart to 60 %. **Auto-paused** adds a line above the controls ("Auto-paused — start pedalling to continue").
- **Motion:** only where it carries information, 200–500 ms, nothing that loops while riding. Segment change: a sweep in the zone colour crosses Current segment (`.seg-in`), its values settle in, the Next card slides up and its stripe grows (`.nx-in`). The gauge arcs glide to each reading with a light spring (`Gauge.step`, ~0.45 s); the numbers change instantly. Within ±5 % of the target for 3 s the gauge glows in the zone colour (`.on-target`). The intensity value rolls up or down (`.roll-up` / `.roll-down`). When a workout is ridden to the end, the ring draws a check (`.finished`) and the summary rises (`dialog.rise`). With the system's *Reduce motion* setting every animation and transition is off (`motionOK()` in render.js, a global CSS rule).
- **Motion outside the ride:** 120–250 ms, only on a change. Dialogs and popovers scale in from 97 % (dialogs fade out in 120 ms via `closeModal()`), settings tabs fade, a new view fades in with a 6 px rise (`.view-in`, not on re-renders of the same view). Workout rows lift 1 px on hover and settle in one after another after a folder, duration, zone or sort change (`.list-in`, not while typing a search). The preview's bars grow from the baseline. A workout just marked done pops its check (`.just-done`), progress bars glide to the new value (`.pbar.glide`). Device dots breathe while connecting, pulse once on connect, shake when a connection drops. Toasts slide up and out; the update card pops in like a popover. A new FTP in the test result counts up once from the current value (`countUp()`). Buttons press to 98 %, segmented controls fade between states.
- **Motion on the website** (`site/`): the same curve, durations and `mo-*` keyframes as the app, each played once. On load the zone pips grow, the hero copy fades up, `.zwo` gets the segment-change sweep and the app screenshot rises into its tilt. Sections rise in on scroll (`.rv`) and their lists settle in one after another; the order comes from `--i`, set in `site.js`. Buttons press to 98 %, tiles lift, a theme switch cross-fades the colours. Only the coffee fuel bar loops, and *Reduce motion* turns everything off.

### Compact ride view

- Optional compact-view icon button (`#btn-compact`, arrows pointing inward, no text) in the top bar just before the rider avatar, shown only during a ride; a compact presentation of the same Ride and native window, not another dashboard or another ride. It shows a **live block** (`.cp-live`: power-only gauge, target line, heart rate and cadence) and the **workout graph** (`.cp-graph`, drawn by `CompactGraph`). `compactMode()` picks the layout (`data-layout`): **vertical** (`v`, narrow windows: live block on top, graph below with time running down, footer with play/stop and workout left) or **horizontal** (`h`, width ≥ 640 and ≥ 1.5 × height: rail, live block, empty space, graph with time running across), plus `data-live` (`col` gauge above, `row` gauge beside), `data-graph`, `data-foot` (`foot` / `head` / `rail`) and `data-tiles`. Built once with the ride; no DOM is rebuilt on resize.
- Hide the normal toolbar, panels, chart and ready overlay only in this view. The vertical layout has a 32 px draggable heading row (connection dot with tooltip, gears while free-like, expand); the horizontal one has a one-button-wide left rail, one column: play/pause, stop, layout switch, expand (the gear buttons take the layout switch's place while free-like); live block 300–460 px, a 16 px gap and the graph taking the rest, at least 60 % of the window width from 1400 px up (`100vw - 540px` bound so the live block keeps its 460 px first) and no heading, so the window can be as flat as 195 px. On macOS, reserve the existing traffic-light space (80 px in the heading row, 32 px above the rail).
- Initial inner size **960 × 195**, minimum **240 × 150** logical pixels (the column). Horizontal values are larger because the bar is read from a distance: target 24 px, heart rate / cadence 30 px, workout left 26 px, Current and Next cards 23 px (kicker and sub-line 12 px), captions 12 px; in a tall bar (panels ≥ 170 px, a window up to 200 px) 34 / 40 / 34 px (a `@container` query on `.compact-main`); the gauge number is 30 % of the dial; they still shrink to fit in narrow windows. Horizontal: live block 300–460 px wide, at least 16 px between it and the graph, graph 190–1400 px wide (so it takes the extra width of a large screen and an empty gap only appears beyond about 1,900 px); the horizontal layout is a bar with a **fixed window height of 195 px** (from 640 px wide), the tall column is **240–320 px wide** at any height (`ride_window_bar`, `bar_sizes()` in ride_window.rs). The two ranges never overlap, so the layout switch button (`.cmp-layout` in the rail and in the heading row, it gives way to the gears in free-like segments and below 244 px high) and the **V** key are the way between them; each layout comes back at the window size it had last (defaults 960 × 195 and 300 × 640). The panels never stretch beyond 179 px and the large values below always apply. Vertical values: target 28 px (24 px in the row variant), gauge number 32 % of the dial, a single watts value on the graph up to 24 px (a range shrinks to the 80 px gutter). Vertical: gauge 116 px (`col`, from 520 px high) or 84 px (`row`), graph from 360 px high, footer joins the heading row below 244 px, heart rate and cadence hide below 190 px.
- **Gauge:** power only, one arc with a short target tick (`g-tick`); no target arc, no inner ring, no FTP tick. **Target line:** bolt icon + watts, 19 px bold in the zone's text colour (`zoneInk`), no word "Target"; a ramp shows its range (`70–210 W`, en dash). **Heart rate / cadence:** icon + 24 px number, no label (the word is the tooltip and accessible name); cadence turns red when off target. **Graph:** bar length = % FTP (same scale as the full view's chart), dashed line = FTP, solid line = now, dotted line = start of the next segment, finished segments dimmed (the full view's chart does the same, both use `--seg-done`); "Now" label above the line and "Next" below the dotted line in the vertical layout, both in a strip above the bars in the horizontal one.
- **Text sizes** come from the type scale: captions never go below `--fs-2xs` (11 px) and are hidden when they do not fit. Values shrink instead (`fitTexts()`, 1 px steps, never below the floor in `data-fit`: target 12, gauge number 16, workout left 14 and 12 in the heading row, tiles 14, graph watts 12), only when a value changes its length or the window is resized. Missing sensors show a dash. Free, max-effort and all-out targets use their words without a W unit. Keep virtual gear controls in free-like segments (not below 244 px high).
- Pause/resume and stop have accessible names; expand restores full-view geometry without rebuilding Ride. Stop/results expand before opening their dialogs. Use a short auto-pause label, with the pedalling hint retained in its accessible name/tooltip.
- Full-view geometry is machine-local and temporary; position restoration is best-effort on compositors that restrict it. Native fullscreen must be exited before switching. Resizing failures leave the current presentation available for retry.

### Responsive

- **Normal minimum window:** 900 × 640; Compact ride view: 240 × 150.
- **≤ 1100 px:** the workout rows drop the mini profile.
- **≤ 980 px:** the ride panels wrap 2 + 1 and the rows drop the duration. Every row keeps its actions (☆, ⋯, *Ride* / *Start* + *Skip*): at the 900 px minimum, next to the Workouts sidebar, the title still gets ~170 px with the widest translated action cell (German favourites: ↑ ↓ ☆ ⋯ *Fahren*). Never hide the actions to make room; the title ellipsizes first.
- **Above 1400 px:** ride readouts scale up (see Typography).

## Components

| Component | Spec |
|---|---|
| **Button** `.btn` | 1 px `--line-strong` border, `--surface`, 600 14 px, radius 10, padding 9 × 16. Variants: `.primary` (accent fill), `.ghost` (transparent), `.danger` (red fill), `.sm` (13 px, radius 8), `.big`, `.round` (34 px circle). One primary per view or dialog, placed last (right). |
| **Icon button** `.icon-btn` | 36 × 36, transparent, muted icon, `--surface-2` on hover. |
| **Segmented control** `.seg-ctl` | `--surface-2` track, radius 10, 3 px padding; the selected item is a raised `--surface` pill. Used for the mode switch, duration filter, theme, upload mode and shifting. The top-bar mode switch is a `role="group"` labelled "Mode" whose buttons carry `aria-pressed` (plain Tab between them; they switch the whole view, so they are not tabs). In dialogs build it with `segRow()`: a `radiogroup` labelled by its row text, buttons are `role="radio"` with `aria-checked`, one tab stop, arrow keys / Home / End move and select (`rovingKey`). Focus shows a 2 px accent outline. |
| **Card / panel** `.card` `.panel` | `--surface`, 1 px `--line`, radius 14, padding 20 / 16, `--shadow`. |
| **Workout row** `.wrow` | grid: status · title (+ meta) · mini profile 200 × 28 · duration · intensity tag + TSS · actions (☆, ⋯, primary action), left-aligned so ☆ and ⋯ line up on every row. All rows of a list (all weeks of a plan) share one column grid (`.wlist` / `.weeks`, rows are subgrids): the action column is at least 150 px and grows to the widest row, so longer labels ("Démarrer" + "Sauter", "Überspringen") never overlap the TSS. The mini profile goes at ≤ 1100 px and the duration at ≤ 980 px; the actions stay at every width. Radius 11, hover border `--line-strong`. The next workout in a plan gets the accent border and a soft gradient. |
| **Intensity tag** `.ztag` | zone fill, black 11 px 650 text "Z1–Z5", radius 5, min-width 26. |
| **Zone filter** `.zone-filter` | outlined chips with a 9 px zone dot; when active the border is the zone colour, the background is 16 % zone colour, and the zone name is shown. |
| **Badge** `.badge` | 11 px 700, radius 6. Default is accent; `.ok`, `.warn` (e.g. *Not completed* in the test history), `.muted` and `.test` (`--z4-soft` fill with `--text`) variants. A badge fill is always a fill or soft token, never an ink token; its text is ≥ 4.5:1 on it in both themes. |
| **Plausibility note** `.ftp-check` | inside the FTP result box, above the buttons, when the new FTP differs > 15 % from the current one: `--warn-soft` background, thin warn border, 13.5 px text. |
| **FTP result box** `.ftp-result` | accent border + `--accent-soft` for a new FTP; `.incomplete` switches to `--warn` / `--warn-soft` with an "Effort not completed" heading, an explanation and the effort details. |
| **ERG pill** `.erg` | 11.5 px 700 uppercase-ish, radius 6: `.on` ok, `.off` warn, `.vs` virtual gears. |
| **Dialog** `dialog` | radius 18, `--shadow-lg`, blurred `--backdrop`. Widths: default 560, `.small` 460, `.settings` 540, `.wide` 960. Header `.pv-head` has the title left and ✕ right; actions go in `.modal-actions` on the right with cancel/back as ghost and the confirm button last. |
| **Settings** `dialog.settings` | fixed size (540 × up to 720, never jumps between tabs): header and tabs stay put, only `.set-panes` scrolls, footer `.set-foot` has the status line left ("Changes are saved automatically", briefly "✓ Saved") and **Done** right. Tabs Rider · Riding · Connections · App (`role="tablist"`, arrow keys). No Save/Cancel: every control saves on change, numbers when the field is left and valid. An invalid number gets a red border and a `.field-err` line under it (right-aligned, 12.5 px, `--danger`) and is not saved; Done/✕ then focus it instead of closing, Esc and a click outside still close. Groups use an `h3` (Sounds, During a ride, Virtual shifting); rarely changed fields go in `details.adv` ("Advanced"); a one-line muted `.hint` may follow a control. |
| **Popover / menu** `.popover` | radius 12, `--shadow-lg`, 6 px padding, 220 px minimum. Items are full-width rows with radius 8 and hover `--surface-2`; separate destructive items with `<hr>` and mark them `.danger-text` with a trailing "…". |
| **"⋯" menu** | `menuBtn(items)` gives a quiet 28–34 px button. Use it for every secondary or destructive action: Finder, Trash, Reset progress, … |
| **Devices menu** | 300 px popover with the title "DEVICES" and one row per device kind: 34 px icon tile (`.dev-ico`, ok-tinted when connected) · name and status · action text ("Connect" / "Change"). Connected devices that report a battery show a **battery badge** (`.batt`) after the name: a 20 × 12 icon filled to the level plus the percentage. State colours: `ok` (≥ 40 %, `--ok`), `low` (16–39 %, `--warn`), `critical` (≤ 15 %, `--danger`); never colour alone, the percentage and an accessible label always accompany it. With several controllers the lowest level is shown. Battery appears only in this menu, not in the top bar. |
| **Avatar** `.avatar` | circle with `--av` background and 700 initials in white, or black (`.ink-dark`) when black contrasts more with the fill (`avatarInk()` in `js/components/avatar.js`, WCAG luminance > ≈ 0.18). All preset colours get black initials (6.3–9.8:1; white was 2.2–4.0:1); dark custom colours keep white. With an emoji, the background is 22 % `--av` mixed with the surface, plus an inset 1.5 px `--av` ring. Sizes: 28 (lists), 32 (top bar), 72–84 (`.xl`: who's riding, editor). |
| **Toast** `.toast` | inverted (text-colour background), radius 12, bottom centre, 3.2 s. Short and plain. Screen readers hear it through `announce()` (see Accessibility). |
| **Update card** `.update-card` | the only persistent notice: fixed bottom-right (24 px), 340 px, `--surface`, `--line` border, radius 14, `--shadow-lg`. 30 px accent-soft download tile · "zwoTrainer X is available" / muted "You have Y" · actions *What's new* (ghost, left), *Later* (ghost) and *Install &amp; restart* (primary). While installing: status line and a `.pbar` with the download progress. Hidden while riding (`body.riding`), pops in like a popover. |
| **Description** `.plan-desc` + `.md` | card under the plan header (and inside the Workouts folder header): rendered Markdown in `--text-2`, 14.5 px / 1.6, max 78 ch, accent underlined links, selectable text. Longer than 300 characters → a plain-text preview, smart-trimmed at the last sentence end after ~180 characters (else at a word boundary with “…”), followed by an inline accent *Show more* link; expanded shows the full Markdown with *Show less* at the end (`smartTrim`, `markdownPlain`). Plan cards show the first sentence (2-line clamp, `.pc-desc`). |
| **Plan / Collection badge** | muted `.badge` next to the folder title in Workouts; the sidebar groups folders under PLANS and COLLECTIONS. |
| **Platform card** `.svc.svc-ext` | compact service card under the "MORE PLATFORMS" group label: neutral letter tile (`.svc-logo.ext`, no brand colours) · name and status ("Connected as …", "Not connected", "Manual import") · one action. Body: API-key field, upload-mode control, or "After a ride: Off / Show import button", plus a one-line hint. Connected cards get an ok-tinted border. |
| **Sync list** `.sync-list` | ride summary: a bordered list with one 44 px row per destination (`.sl-row`: 26 px logo · name · state/action on the right). Garmin first, then Intervals.icu / COROS when enabled, then "Ride file · Save .fit". States: *Upload*, *Import…*, spinner "Uploading…", "Uploaded ✓" (link), "Failed · Retry". |
| **Service card** `.svc` | bordered block in Settings → Connections: 34 px logo tile · name and status · action button, then the options and a short muted explanation. |
| **Inputs** | `--surface`, 1 px `--line-strong`, radius 10, padding 8 × 12, 14 px; focus: `--accent` border + 3 px `--accent-soft` ring; invalid: `--danger` border. One style everywhere (`base.css`), views only set width. Labels sit above in `--text-2` 13 px. |

## Icons

- **Style:** inline SVG with a 24 × 24 viewBox, `fill="none"`, `stroke="currentColor"`, `stroke-width="2"`, round caps and joins (Lucide-like). Shown at 18–20 px in the top bar and 16–18 px in tiles.
- **Glyphs:**

| Concept | Glyph |
|---|---|
| Devices | Bluetooth rune |
| Ride history | calendar with a check mark |
| Settings | gear (filled) |
| Trainer | lightning bolt |
| Heart rate | heart |
| Shifter | up/down arrows |
| Profile sync | circular arrows |
| Ride controls | ⏮ previous, ↺ −1 min, ▶/⏸, ■ end, ↻ +1 min, ⏭ next |

- **Colour:** icons inherit `currentColor`, which is muted at rest and `--text` on hover.

## Interaction rules

- **Destructive actions** (Trash, delete rider, reset progress, disconnect) always:
  1. live in a "⋯" menu or a secondary position;
  2. are labelled with a trailing "…";
  3. open `confirmDialog` with a clear consequence and a red confirm button.
  Deleting files always uses the system Trash (Recycle Bin on Windows).
- **Locked items** (later plan workouts) show 🔒 and are not clickable; explain in the tooltip.
- **Feedback:** use a toast for background results (saved, synced, uploaded), the ride hint for actions during a ride, and inline status inside the related control (upload spinners and ✓ in the ride summary and history). The update card is the one exception that stays until the rider acts, and it never appears during a ride.
- **Motion:** 150 ms for hover/border/opacity, 200 ms for hint and popover fades, and `.4s` for gauge arcs. No bounces and no animation during ERG-critical moments. Any new decorative animation must be disabled under `prefers-reduced-motion`.
- **Platform wording:** labels follow the OS via `PLAT` in core.js: *Show in Finder / Explorer / Files*, *Trash / Recycle Bin*, *this Mac / PC / computer*. Never hard-code the macOS terms.
- **Text:** plain, friendly wording in sentence case, in English, German and French (`ui/js/i18n/`; German "du", French "vous"). Leave room for German, the longest of the three: labels in segmented controls and buttons must still fit at 900 px. Units use a thin space in tables ("250 W", "90 %"), and durations are `m:ss` / `h:mm:ss` (`fmtTime`) or "1h 05m" (`fmtDur`).
- **Accessibility:**
  - Icon-only buttons need a `title` and an `aria-label` (`tText()`), and their SVG is `aria-hidden="true"`. A button whose action changes names the action it will do now: the ride play button is *Start*, then *Pause* / *Resume*. Toggles that keep their name carry `aria-pressed` (chart overlay toggles, the power gauge for watts ↔ % FTP, the mode switch). Keyboard shortcuts go in `aria-keyshortcuts` as well as the title.
  - Transient messages (toasts, ride hints) are announced with `announce()` in core.js through a polite live region that exists in index.html from the start: `#live` on the page, `#modal-live` inside the dialog (an open modal makes the rest of the page inert). Both are `.sr-only` (utilities.css). Never create a live region together with its text; it is often not read.
  - Status is never shown by colour alone: dots are paired with text in the devices menu and tooltips.
  - Contrast is ≥ 4.5:1 for text (use the zone *ink* tokens for coloured text).
  - Everything should be reachable by keyboard, and rows are focusable (`tabindex="0"`, Enter opens). Keyboard focus is one shared rule in `utilities.css` (`:focus-visible` on buttons, links, `[tabindex]`, `summary`, `[role=…]` → 2 px `--accent` outline, offset 2; inset −2 inside popovers), so `all: unset` controls get it too. It sits in the last layer on purpose; don't remove focus outlines in a view (`outline: none` there has no effect).
  - Popover menus (`popoverOpen()` in actions.js): opening focuses the first item, ↑/↓/Home/End move, Esc or Tab closes and returns focus to the anchor, the anchor carries `aria-haspopup` / `aria-expanded`. While a popover is open the ride shortcuts are off, so Esc never stops the workout.
  - Every input has an accessible name: a `<label>`, or an `aria-label` when the visible text isn't a label (zone limits, the two gear-range fields).
  - Text size minimums: see [Typography](#typography) (11 px uppercase labels, otherwise ≥ 12 px).

## Checklist for UI changes

- [ ] Only tokens and zone colours; no new raw colours.
- [ ] New CSS in the right layer and file (component vs. view, see [CSS structure](#css-structure)).
- [ ] Checked in light **and** dark.
- [ ] Checked at 1400 px, at full screen (2560 px) and at the minimum window (900 × 640).
- [ ] Top bar unchanged; secondary and destructive actions in "⋯" menus.
- [ ] Ride screen text is HTML (never stretched SVG text) and readable from 2 m.
- [ ] Interpolated text is escaped with `esc()`.
- [ ] README / DESIGN.md updated if the change is user-visible or adds a pattern.

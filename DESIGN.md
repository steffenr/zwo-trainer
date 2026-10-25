# DESIGN.md — zwoTrainer design system

The visual and interaction rules for zwoTrainer. Everything lives in `ui/css/styles.css` (tokens on `:root`) and a few constants in `ui/js/render.js` / `ui/js/app.js`. Any new screen or component must follow this document; if you introduce a new pattern, document it here.

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
| `--muted` | `#8a9099` | `#85858d` | labels, meta, placeholders |
| `--accent` | `#00a3c4` | `#1cc4e6` | primary buttons, links, selection, progress |
| `--accent-soft` | 10 % accent | 14 % accent | selected backgrounds |
| `--ok` / `--ok-soft` | `#2e9e4f` | `#4cd07a` | connected, success, ERG on |
| `--warn` / `--warn-soft` | `#b7791f` | `#f2c14e` | connecting, ERG off, changed intensity |
| `--danger` | `#e0352b` | `#ff5a4f` | destructive text and buttons |
| `--pos`, `--trace`, `--ftp` | text colour | white | chart position line, power trace, FTP line |
| `--done` | accent | accent | completed part of the workout |
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
- **Inks** (`--zN-ink`) are for coloured text on the page background, such as target % and upcoming watts.
- **Never** use zone colours for buttons, status or decoration.

### Brand and third-party colours

- The accent cyan is zwoTrainer's brand colour.
- Third-party colours appear only on that service's own control: Garmin `#1d1d1f`.
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
| meta | 13.5 px, muted |
| `.small` | 13 px |
| `.k` labels | 11 px, uppercase, `letter-spacing: .08em`, 600, muted |
| `.eyebrow` | 11.5 px, uppercase, `.09em` |

Headings use `letter-spacing: -0.01em`.

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
| Radius | dialogs 18 px · cards/panels 14 px (`--radius`) · popovers 12 px · buttons 10 px · small buttons 8 px · tags 5–6 px · pills 999 px · avatars and round buttons 50 % |
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
<dialog id="modal"> · #toast · #popover
```

- **Left padding:** 92 px on macOS (`:root[data-os="mac"]`), leaving room for the traffic lights of the overlay title bar; 24 px on Windows and Linux, which have a normal title bar.
- **Right side:** exactly four controls, in this order:
  1. **Devices**: Bluetooth glyph and three status dots (trainer, HR, shifter), green / amber / grey.
  2. **Ride history**: calendar with a check mark.
  3. **Settings**: gear.
  4. **Avatar**: a 32 px circle, no name label.
- **The bar is identical on every screen.** During a ride:
  - the mode switch is replaced by the ride title (`#ride-title`: badge · title · ERG pill) at the same 40 px height;
  - ride history is shown at 30 % opacity and disabled;
  - the avatar never moves.
- **Never add controls** to the top bar. Theme, preferences and connections live in Settings; occasional actions go in "⋯" menus.

### Ride screen

```
┌ ● LIVE ∿   CONNECTED ┐ ┌ ◎ CURRENT SEGMENT                       STEADY STATE ┐ ┌ ◇ NEXT SEGMENT ──┐
│     (watt gauge)     │ │   ╭─ 90% ─╮    ⚡ TARGET POWER   ⟳ TARGET CADENCE    │ │ ▌ 55%            │
│        244           │ │   │ 239 W │       239 W            90 rpm           │ │ ▌ 146 W          │
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
- **Panel header** `.ph`: 19 px accent icon · 12.5 px uppercase label (letter-spacing .09em) · optional status on the right (`.ph-status`, 11 px uppercase; green `ok` when connected). LIVE has a status dot (green when a trainer is connected).
- **LIVE** `.live-body`: the watt gauge on top (centred), the four metrics below in a 2 × 2 grid. `.metric`: 19 px icon · uppercase label · value (`--num`, 22 px) + unit + muted extra (`/ 90` cadence target, `69%`) · 5 px bar (`.mbar`). Power shows only the live value (the target is on the gauge); its bar runs 0…1.5× target, coloured by the zone you're riding in. Speed: 0–60 km/h, green. Heart rate: % of max HR.
- **Cadence target:** only when the segment has one, the cadence row shows `86 / 90 rpm` (or `/ 85–95`); the bar spans 40–130 rpm with a marker (or band, for ranges) at the target and turns **green** on target, **amber** 5–10 rpm off, **red** beyond 10 rpm — the value itself turns red too. CURRENT shows it as *Target cadence* (in `--cad`), the next-segment card as its last line.
- **Current-segment ring** `ProgressRing`: a single progress arc in the zone colour (it reuses `Gauge` but removes the inner "actual power" track, the FTP tick and the actual arc — only the LIVE watt gauge has two arcs: outer = target, inner = actual).
- **Current segment** `.seg-body`: the ring on the left (`.seg-left`, 210 px, gear box below it in free-ride segments), a 2 × 2 `.seg-stats` grid on the right: target power (zone ink) · target cadence (`--cad`, `–` without a target) · segment duration with a progress bar in the zone colour · remaining (pulses in the last 5 s). Icon · label · 30 px value. Below 1180 px the ring stacks above the grid.
- **Coach line** `.coach-line` under `.seg-body`: one message at a time, icon + 18 px semibold text, centred in a tinted box (`--cc`: accent for workout text events, `--warn`/`--danger` for cadence and pacing, `--ok` for "Back on target", the zone ink for hard-segment cues). Its height is always reserved; it fades in and out (opacity, 4 px slide) so nothing in the panel moves.
- **Test pacing** (all-out test efforts ≥ 5 min): the ring centre shows the running effort average in zone ink, the line below it "avg · aim ~263 W" (or "too fast · ease off" in `--warn` after 1 min at > 110 % of the aim), and the first stat becomes **Est. FTP** (8/20-min efforts) or **Effort avg**. Keep both lines short so they fit inside the ring.
- **Power ranges in stat values** (e.g. `150–113`) drop the unit and use `.stat b.range` (20 px) so they fit their column.
- **Next-segment card** `.nx-card`: 6 px stripe in the zone colour (zone name as tooltip) and the values only, no labels or icons: `55%` (40 px), then `146 W`, `5:00 min` and, if set, `85 rpm` (22 px, `--text-2`; rpm in `--cad`).
- **Controls row:** buttons centred horizontally and on one centre line (`align-items: center`), the larger play button in the middle. After a divider: **intensity** (`.int-group`: label + value, `--warn` when ≠ 100 %, then − / + as 48 px `.ctl` buttons; Shift-click ±10 %). It scales the whole workout, so it lives with the ride controls, not in a panel.
- **Chart:**
  - Bars stretch (SVG `preserveAspectRatio="none"`), but **all text is HTML layered on top** (`.dg-labels`, `.dg-free`), never SVG text, so it keeps its proportions at any size.
  - Segment labels hide when they don't fit their segment.
- **Feedback for remote actions** (controller buttons) uses the `#ride-hint` pill at the top centre of the ride area, shown for 1.4 s.
- **Paused** dims panels and chart to 60 %. **Auto-paused** adds a line above the controls ("Auto-paused — start pedalling to continue").
- **Motion:** only where it carries information, 200–500 ms, nothing that loops while riding. Segment change: a sweep in the zone colour crosses Current segment (`.seg-in`), its values settle in, the Next card slides up and its stripe grows (`.nx-in`). The gauge arcs glide to each reading with a light spring (`Gauge.step`, ~0.45 s); the numbers change instantly. Within ±5 % of the target for 3 s the gauge glows in the zone colour (`.on-target`). The intensity value rolls up or down (`.roll-up` / `.roll-down`). When a workout is ridden to the end, the ring draws a check (`.finished`) and the summary rises (`dialog.rise`). With the system's *Reduce motion* setting every animation and transition is off (`motionOK()` in render.js, a global CSS rule).
- **Motion outside the ride:** 120–250 ms, only on a change. Dialogs and popovers scale in from 97 % (dialogs fade out in 120 ms via `closeModal()`), settings tabs fade, a new view fades in with a 6 px rise (`.view-in`, not on re-renders of the same view). Workout rows lift 1 px on hover and settle in one after another after a folder, duration, zone or sort change (`.list-in`, not while typing a search). The preview's bars grow from the baseline. A workout just marked done pops its check (`.just-done`), progress bars glide to the new value (`.pbar.glide`). Device dots breathe while connecting, pulse once on connect, shake when a connection drops. Toasts slide up and out; the update card pops in like a popover. A new FTP in the test result counts up once from the current value (`countUp()`). Buttons press to 98 %, segmented controls fade between states.
- **Motion on the website** (`site/`): the same curve, durations and `mo-*` keyframes as the app, each played once. On load the zone pips grow, the hero copy fades up, `.zwo` gets the segment-change sweep and the app screenshot rises into its tilt. Sections rise in on scroll (`.rv`) and their lists settle in one after another; the order comes from `--i`, set in `site.js`. Buttons press to 98 %, tiles lift, a theme switch cross-fades the colours. Only the coffee fuel bar loops, and *Reduce motion* turns everything off.

### Responsive

- **Minimum window:** 900 × 640.
- **≤ 1100 px:** the workout rows drop the mini profile.
- **≤ 980 px:** the ride panels wrap 2 + 1 and the rows drop the duration.
- **Above 1400 px:** ride readouts scale up (see Typography).

## Components

| Component | Spec |
|---|---|
| **Button** `.btn` | 1 px `--line-strong` border, `--surface`, 600 14 px, radius 10, padding 9 × 16. Variants: `.primary` (accent fill), `.ghost` (transparent), `.danger` (red fill), `.sm` (13 px, radius 8), `.big`, `.round` (34 px circle). One primary per view or dialog, placed last (right). |
| **Icon button** `.icon-btn` | 36 × 36, transparent, muted icon, `--surface-2` on hover. |
| **Segmented control** `.seg-ctl` | `--surface-2` track, radius 10, 3 px padding; the selected item is a raised `--surface` pill. Used for the mode switch, duration filter, theme, upload mode and shifting. |
| **Card / panel** `.card` `.panel` | `--surface`, 1 px `--line`, radius 14, padding 20 / 16, `--shadow`. |
| **Workout row** `.wrow` | grid: status · title (+ meta) · mini profile 200 × 28 · duration · intensity tag + TSS · actions (☆, ⋯, primary action). Radius 11, hover border `--line-strong`. The next workout in a plan gets the accent border and a soft gradient. |
| **Intensity tag** `.ztag` | zone fill, black 11 px 650 text "Z1–Z5", radius 5, min-width 26. |
| **Zone filter** `.zone-filter` | outlined chips with a 9 px zone dot; when active the border is the zone colour, the background is 16 % zone colour, and the zone name is shown. |
| **Badge** `.badge` | 11 px 700, radius 6. Default is accent; `.ok`, `.warn` (e.g. *Not completed* in the test history), `.muted` and `.test` (Z4 ink) variants. |
| **Plausibility note** `.ftp-check` | inside the FTP result box, above the buttons, when the new FTP differs > 15 % from the current one: `--warn-soft` background, thin warn border, 13.5 px text. |
| **FTP result box** `.ftp-result` | accent border + `--accent-soft` for a new FTP; `.incomplete` switches to `--warn` / `--warn-soft` with an "Effort not completed" heading, an explanation and the effort details. |
| **ERG pill** `.erg` | 11.5 px 700 uppercase-ish, radius 6: `.on` ok, `.off` warn, `.vs` virtual gears. |
| **Dialog** `dialog` | radius 18, `--shadow-lg`, blurred `--backdrop`. Widths: default 560, `.small` 460, `.settings` 540, `.wide` 960. Header `.pv-head` has the title left and ✕ right; actions go in `.modal-actions` on the right with cancel/back as ghost and the confirm button last. |
| **Popover / menu** `.popover` | radius 12, `--shadow-lg`, 6 px padding, 220 px minimum. Items are full-width rows with radius 8 and hover `--surface-2`; separate destructive items with `<hr>` and mark them `.danger-text` with a trailing "…". |
| **"⋯" menu** | `menuBtn(items)` gives a quiet 28–34 px button. Use it for every secondary or destructive action: Finder, Trash, Reset progress, … |
| **Devices menu** | 300 px popover with the title "DEVICES" and one row per device kind: 34 px icon tile (`.dev-ico`, ok-tinted when connected) · name and status · action text ("Connect" / "Change"). |
| **Avatar** `.avatar` | circle with `--av` background and white 700 initials. With an emoji, the background is 22 % `--av` mixed with the surface, plus an inset 1.5 px `--av` ring. Sizes: 28 (lists), 32 (top bar), 72–84 (`.xl`: who's riding, editor). |
| **Toast** `.toast` | inverted (text-colour background), radius 12, bottom centre, 3.2 s. Short and plain English. |
| **Update card** `.update-card` | the only persistent notice: fixed bottom-right (24 px), 340 px, `--surface`, `--line` border, radius 14, `--shadow-lg`. 30 px accent-soft download tile · "zwoTrainer X is available" / muted "You have Y" · actions *What's new* (ghost, left), *Later* (ghost) and *Install &amp; restart* (primary). While installing: status line and a `.pbar` with the download progress. Hidden while riding (`body.riding`), pops in like a popover. |
| **Description** `.plan-desc` + `.md` | card under the plan header (and inside the Workouts folder header): rendered Markdown in `--text-2`, 14.5 px / 1.6, max 78 ch, accent underlined links, selectable text. Longer than 300 characters → a plain-text preview, smart-trimmed at the last sentence end after ~180 characters (else at a word boundary with “…”), followed by an inline accent *Show more* link; expanded shows the full Markdown with *Show less* at the end (`smartTrim`, `markdownPlain`). Plan cards show the first sentence (2-line clamp, `.pc-desc`). |
| **Plan / Collection badge** | muted `.badge` next to the folder title in Workouts; the sidebar groups folders under PLANS and COLLECTIONS. |
| **Platform card** `.svc.svc-ext` | compact service card under the "MORE PLATFORMS" group label: neutral letter tile (`.svc-logo.ext`, no brand colours) · name and status ("Connected as …", "Not connected", "Manual import") · one action. Body: API-key field, upload-mode control, or "After a ride: Off / Show import button", plus a one-line hint. Connected cards get an ok-tinted border. |
| **Sync list** `.sync-list` | ride summary: a bordered list with one 44 px row per destination (`.sl-row`: 26 px logo · name · state/action on the right). Garmin first, then Intervals.icu / COROS when enabled, then "Ride file · Save .fit". States: *Upload*, *Import…*, spinner "Uploading…", "Uploaded ✓" (link), "Failed · Retry". |
| **Service card** `.svc` | bordered block in Settings → Connections: 34 px logo tile · name and status · action button, then the options and a short muted explanation. |
| **Inputs** | `--surface`, 1 px `--line-strong`, radius 9, padding 8 × 10, 14 px. Labels sit above in `--text-2` 13 px. |

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
- **Platform wording:** labels follow the OS via `PLAT` in app.js: *Show in Finder / Explorer / Files*, *Trash / Recycle Bin*, *this Mac / PC / computer*. Never hard-code the macOS terms.
- **Text:** plain, friendly English in sentence case. Units use a thin space in tables ("250 W", "90 %"), and durations are `m:ss` / `h:mm:ss` (`fmtTime`) or "1h 05m" (`fmtDur`).
- **Accessibility:**
  - Icon-only buttons need a `title` and an `aria-label`.
  - Status is never shown by colour alone: dots are paired with text in the devices menu and tooltips.
  - Contrast is ≥ 4.5:1 for text (use the zone *ink* tokens for coloured text).
  - Everything should be reachable by keyboard, and rows are focusable (`tabindex="0"`, Enter opens).

## Checklist for UI changes

- [ ] Only tokens and zone colours; no new raw colours.
- [ ] Checked in light **and** dark.
- [ ] Checked at 1400 px, at full screen (2560 px) and at the minimum window (900 × 640).
- [ ] Top bar unchanged; secondary and destructive actions in "⋯" menus.
- [ ] Ride screen text is HTML (never stretched SVG text) and readable from 2 m.
- [ ] Interpolated text is escaped with `esc()`.
- [ ] README / DESIGN.md updated if the change is user-visible or adds a pattern.

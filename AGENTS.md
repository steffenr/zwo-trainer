# AGENTS.md — working on zwoTrainer

Guidance for coding agents (and humans) changing this repository. User documentation lives in [README.md](README.md) and the visual design system in [DESIGN.md](DESIGN.md). Keep all three in sync with the code. When behaviour changes, update the README in the same change.

## What this is

A desktop app (Tauri 2) for riding Zwift `.zwo` workouts on a Bluetooth smart trainer. It is developed on macOS and also released for Windows and Linux from the same code. It covers folder-based plans, free workouts, FTP tests, rider profiles, FIT recording, Garmin upload and profile sync through a cloud folder.

**Product principles** (don't break them):
- **Lightweight and fast:** no bundler, no Node in the app (Node is only used by CI and the scripts in `scripts/`), no frontend framework, no runtime downloads (the only one is the optional, signed app update). App start and library scans of ~2,600 files must stay well under a second.
- **Not in scope:** video courses, a workout builder, music, social features or a complex frontend.
- **Clean, calm UX:** few controls, destructive actions behind "⋯" menus and confirmations, consistent top bar (see DESIGN.md).
- **The rider's data is theirs:** local JSON files, optional sync through a folder the user chooses, no telemetry. Garmin passwords and MFA never pass through our code.

## Repository layout

```
ui/                         frontend — static files served by Tauri (frontendDist = ../ui)
  index.html                shell: top bar, #view, #ride, <dialog id="modal">, #toast
  css/styles.css            entry only: @layer order (tokens, base, components, views, utilities) + @imports
  css/tokens.css            theme tokens on :root (light) + dark overrides (OS dark and forced dark)
  css/base.css              elements, native form controls, text helpers (.muted, .k, .ic …), shared @keyframes
  css/components/           reusable pieces, one family per file: buttons, card, indicators (badge, tags, progress, spinner), dialog, popover, notice (toast, update card), list (history-style table, sync list, service logo), forms, avatar, charts, markdown
  css/views/                one file per screen/dialog: topbar, home, library, history, tests, dialogs, settings, ride, compact
  css/utilities.css         [hidden], forced text colours, global "Reduce motion"
  js/app.js                 app controller: boot, routing, modes, riders, settings, sync, Ride class
  js/compact.js             serialized compact/full ride presentation transitions (same Ride, native resize first) and `compactMode()` size tiers
  js/render.js              zones, colours, mini profiles, Diagram (workout chart), Gauge, ProgressRing
  js/markdown.js            tiny safe Markdown renderer (plan descriptions); escapes everything, links via open_link
  js/zwo.js                 client-side ZWO helpers: parse, powerAt, segmentAt, TSS, zone classification
  js/tests.js               FTP test protocols, evaluation, VO2max, test-workout detection
  js/vshift.js              virtual drivetrain + flat-road physics (virtual shifting)
  js/sound.js               countdown beep, rising/falling countdown notes and end chime (Web Audio)
  js/html.js                html`` tagged template (auto-escaping), raw(), tHtml(), mount(), esc()
  js/components/            markup helpers, one file per CSS component family (same names as css/components/):
                            icons (IC), buttons (segCtl, segRow, selectSeg, menuBtn), indicators (badge, wdTag, zoneTag), dialog (dialogHead, closeBtn)
  js/battery.js             battery badge for the devices popover: state thresholds (ok ≥ 40, low 16–39, critical ≤ 15), lowest level, icon HTML
  sounds/                   power-up.mp3, power-down.mp3 (3 notes ~1 s apart), workout-done.mp3 (all CC0)
  js/ble.js                 device objects (Trainer, HeartRate, Controllers), simulator, Tauri event binding
  js/i18n/index.js          t(key, vars), plurals, locale detection, translateDom() for data-i18n attributes
  js/i18n/en.js · de.js · fr.js  UI dictionaries: en is the source, de/fr define the same keys
src-tauri/
  src/lib.rs                Tauri commands (the only IPC surface) + App state
  src/state.rs              Store: state.json (profiles) + secrets.json, atomic writes, migrations
  src/sync.rs               profile sync through a cloud-synced folder
  src/library.rs            workouts-folder scan, natural sort, mtime cache, path-traversal guard, plan vs collection, .md descriptions
  src/zwo.rs                ZWO parser (authoritative), TSS estimate, zone classification
  src/fit.rs                FIT encoder (Generic + Garmin flavour)
  src/garmin.rs             Garmin SSO window → OAuth1 → OAuth2, upload
  src/ride_window.rs        temporary compact-window geometry, minimum size, transactional resize/restore
  src/updater.rs            in-app updates (tauri-plugin-updater): check, download + verify + install, restart
  src/services.rs           Intervals.icu (automatic upload, API key) and COROS (manual Training Hub import, ZIP)
  src/ble.rs                btleplug: FTMS (ERG), Cycling Power, Heart Rate, reconnect
  src/shifter.rs            Zwift Ride / Click / Play protocol (RideOn handshake, button decoding), controller scan/connect
  src/obc.rs                OpenBikeControl protocol (button state, one action per press, App Information)
  src/battery.rs            battery level of connected devices (Battery Service 0x180F, read every 2 min, event `battery`)
  tauri.conf.json           window, CSP, bundle, plugins.updater (pubkey, endpoint); Info.plist (Bluetooth usage, App Nap off)
  tauri.updater.conf.json   CI-only overlay: createUpdaterArtifacts (needs TAURI_SIGNING_PRIVATE_KEY)
  capabilities/default.json Tauri permissions (keep minimal)
scripts/sync-version.mjs    print / set the version (Cargo.toml + Cargo.lock; tauri.conf.json has none)
scripts/updater-manifest.mjs  write latest.json (version, notes, per-platform url + signature) from the signed release files
scripts/setup-updater-key.sh  one-time: create the updater key in ~/.tauri, write the pubkey, set the GitHub secrets
scripts/check-i18n.mjs      de/fr have exactly en's keys, plural shapes and placeholders; every t('key') in ui/ exists
scripts/check-html.mjs      ui/js: no innerHTML/outerHTML write or insertAdjacentHTML outside mount() in html.js
scripts/check-css.mjs       ui/css: layer order, every file imported once into a layer, balanced braces, nested selectors start with &, components/ never name a view
scripts/shots/              every website screenshot (site/img) from the real ui/ in headless Chromium (see "Website" below)
  run.mjs                   runner: server, fake clock, capture, WebP, skip unchanged, contact sheet, sync <img> sizes
  shots.mjs                 the shot list: one entry per image pair (viewport, scale, rider tweaks, steps)
  mock.js                   window.__TAURI__ stub: state, events, virtual trainer/strap/controller, seeded random
  rider.mjs                 sample rider "Lena" (history, plan progress, tests) and the fixed clock time NOW
  fixture/                  sample library: make.mjs (definitions → .zwo → Rust scan) → library.json, workouts.json
site/                       static website (home, features, download) with dark/light screenshots in site/img; no build step
.github/workflows/
  ci.yml                    push/PR: tests + clippy + UI syntax + i18n + CSS + markup checks (Linux), tests (macOS, Windows)
  release.yml               manual: bump patch/minor/major, commit, tag vX, push (needs RELEASE_PAT)
  build-app.yml             tag v*: build macOS arm64/x64, Windows, Linux → one GitHub release (+ latest.json for updates)
  pages.yml                 site/ change on develop, successful release build, manual: deploy site/ to GitHub Pages
.github/dependabot.yml      monthly PRs to develop: all Actions in one, Cargo minor+patch in one, each Cargo major alone
```

## Commands

```bash
cargo install tauri-cli --version "^2" --locked     # once
cargo tauri dev                                      # run (from repo root)
cargo tauri build                                    # .app + .dmg
cd src-tauri && cargo test                           # all Rust tests (must pass)
cd src-tauri && cargo clippy --all-targets           # keep warning-free
ZWO_TEST_DIR=~/Downloads/zwo cargo test scan_real_library -- --nocapture   # parse a real library
node --check ui/js/app.js                            # quick syntax check for edited JS modules
node scripts/check-i18n.mjs                          # translations complete and consistent (en / de / fr)
node scripts/check-css.mjs                           # every CSS file imported into a layer, braces, & nesting
node scripts/check-html.mjs                          # markup reaches the DOM only through mount()
node --test scripts/compact-ride.test.mjs             # compact/full transition lifecycle
node --test scripts/battery.test.mjs                   # battery state, lowest level, badge
node --test scripts/html.test.mjs                      # html`` escaping, raw/Safe nesting, tHtml, mount
node scripts/sync-version.mjs [x.y.z]                # print / set the app version
npx -y -p playwright node scripts/shots/run.mjs [names…] [--list|--theme t|--out dir|--force]   # retake website screenshots
node scripts/shots/fixture/make.mjs                  # rebuild the screenshot sample library (after parser/scan changes)
```

## Releases & platforms

- **Version:** only in `src-tauri/Cargo.toml` (`[package] version`), mirrored into `Cargo.lock` by `scripts/sync-version.mjs`. Don't add `version` back to `tauri.conf.json`.
- **Releasing:** run the *Release* workflow (bump) → it pushes tag `vX` → *Build zwoTrainer* builds all four targets and publishes the GitHub release. The Tauri CLI comes from `npx @tauri-apps/cli@^2` in CI; there is no package.json on purpose.
- **Installers are unsigned** (macOS uses ad-hoc signing `signingIdentity: "-"`, which keeps the Bluetooth permission stable). Adding real signing/notarisation means adding secrets to `build-app.yml`.
- **In-app updates** are a separate signature (minisign, `tauri-plugin-updater`), not code signing:
  - The public key is `plugins.updater.pubkey` in `tauri.conf.json`; the private key lives only in `~/.tauri/zwotrainer.key` and the `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` repository secrets. Never commit it. Losing it means installed apps can't be updated any more.
  - Until `scripts/setup-updater-key.sh` has run, the pubkey is the placeholder `UPDATER_PUBLIC_KEY_NOT_SET`: `updater::configured` is false, the UI hides the update controls and never checks.
  - `build-app.yml` passes `--config src-tauri/tauri.updater.conf.json` only when the secret exists (local `cargo tauri build` never needs the key). The macOS `zwoTrainer.app.tar.gz` is renamed to `zwoTrainer_<version>_<aarch64|x64>.app.tar.gz` so both architectures fit in one release.
  - The publish job turns the `.sig` files into `latest.json` (`scripts/updater-manifest.mjs`); the `.sig` files themselves are not attached. Keys are `{os}-{arch}-{bundle}` (`darwin-aarch64-app`, `windows-x86_64-nsis` / `-msi`, `linux-x86_64-appimage` / `-deb` / `-rpm`) plus the plain `{os}-{arch}` for the default bundle; the plugin picks the one matching how the app was installed.
  - The endpoint is `releases/latest/download/latest.json`, so drafts and pre-releases are never offered. A release without `latest.json` (secret missing) simply isn't offered to installed apps.
- **Bundles:** `targets: "all"` → `.app`/`.dmg`, NSIS `.exe`/`.msi`, `.deb`/`.rpm`/`.AppImage`. The Linux packages depend on `bluez`.
- **Before merging platform-touching Rust:** CI must be green on all three OSes. Locally you can type-check Windows from Linux/macOS with `rustup target add x86_64-pc-windows-msvc && cargo clippy --target x86_64-pc-windows-msvc` (`ring` needs MSVC headers; `cargo xwin` or the CI job is the easy way).

The minimum Rust version is **1.90** (required by `tauri-plugin-updater`). Builds must stay warning-free.

## Architecture

```
UI (vanilla ES modules) ──invoke(cmd, args)──▶ Rust commands (lib.rs) ──▶ state / library / ble / fit / garmin / sync
        ▲                                                     │
        └──────────── events: device-status, sensor, button, ctrl-raw ◀──┘
```

- **IPC:** the UI talks to Rust only through `window.__TAURI__.core.invoke` (wrapped in `ble.js` as `invoke`) and `event.listen` (`withGlobalTauri: true`). Every new capability is a `#[tauri::command]` in `lib.rs` and must be registered in `generate_handler!`.
- **Commands** (current set): `open_link app_state save_profile create_profile rename_profile edit_profile delete_profile switch_profile sync_targets sync_config sync_now pick_sync_dir scan_library load_workout pick_zwo_dir save_activity reveal_in_library trash_in_library export_activity garmin_import pick_garmin_dir open_url garmin_status garmin_connect garmin_disconnect garmin_upload services_status service_connect service_disconnect service_upload service_manual keep_awake ride_window ble_scan ble_connect ble_disconnect ble_current trainer_set_power trainer_free_ride trainer_resume ctrl_scan ctrl_connect ctrl_disconnect ctrl_list update_status update_prefs update_check update_install`.
- **Events Rust → UI:**
  - `device-status {kind: trainer|hr|controller, connected, reconnecting, name, erg, ergDenied, count, ids}` (`ids`: connected controller ids; `ergDenied`: the trainer answered "control not permitted"; ERG stays on, it's only a warning)
  - `battery {kind: trainer|hr|controller, id, level}` (0–100; only devices with a readable Battery Level characteristic; the UI clears it when the device disconnects and shows it only in the devices popover)
  - `sensor {power?, cadence?, speed?, hr?}`
  - `button {button, device, erg?}` (`erg`: OpenBikeControl's pick for ERG segments)
  - `ctrl-raw {device, hex}`
  - `update-progress {done, total}` (bytes; only on whole-percent changes)
- **State ownership:**
  - The profile schema is owned by the UI. `state.rs` guarantees defaults (`merge_defaults`), ids, `updatedAt` and atomic writes; it must not drop unknown keys.
  - The UI mutates `state` (the active profile) and calls `api.saveState()` → `save_profile`.
  - Rust-side changes (create/edit/switch/delete profile, sync) return a fresh `app_state` summary, which the UI applies with `applyAppState()`.
- **The ZWO parser exists twice:** `zwo.rs` is authoritative (library scan, workout loading) and `ui/js/zwo.js` is a mirror used by the mock/dev server and some client helpers. If you change parsing, TSS or zone classification, change **both** and keep their outputs identical.
- **Ride loop:** the `Ride` class in `app.js` ticks every 250 ms. It computes the target, sends ERG (deduplicated in JS and Rust), records 1 Hz samples, runs auto-pause, the countdown (`countdown()` in sound.js; `cueDir()` picks up / down / same with a 3 % FTP dead band) and controller actions. `coach()` fills the coach line in the Current segment panel (priority: .zwo text events > pacing > cadence > hard-segment cues; hysteresis and the 4 s minimum use wall-clock time in `this.cz`; `settings.coachHints` switches the automatic hints off). `finish()` → `save_activity` (FIT) → history → Garmin upload. `render()` runs every tick, so it never queries the DOM directly: `this.q(id)`, `this.qs(selector)` and `this.qsa(selector)` cache elements (and look up again when one was replaced), `setText()` / `setHtml(el, fragment)` write only changed values (setHtml must be the only writer of its element), and the next-segment card is described once and mounted into the full and the compact view.

## Data model (state.json v2)

```jsonc
{
  "version": 2,
  "activeProfile": "p_…",
  "profiles": { "p_…": {
    "id", "name", "avatar": { "color": "#rrggbb"|null, "emoji": "🚴"|null },
    "createdAt", "updatedAt",
    "settings": { "ftp", "maxHr", "weight", "zones": [55,75,90,105], "bests": {s5,m1,m5,m20},
                  "theme", "language": "en|de|fr" (missing = system language), "mode", "beeps", "beepDirection", "endChime", "autoPause", "overlay": {power,cadence,hr},
                  "shifting": {...}, "zwoDir", "devices": {trainer, hr, controllers[]},
                  "garmin": {mode, autoOpen, folder},
                  "services": { "<intervals|coros>": {mode: off|manual|auto} },
                  "folderKinds": { "<folderId>": "plan" | "collection" } },   // rider override of library kind
    "activePlan", "plans": { "<folderId>": { startedAt, finishedAt?, entries: { "<file>": {status, at, …} } } },
    "history": [ {file, plan, title, at, status, doneDuration, avgPower, np, …, fitPath, garmin?, services?: {<id>: {id, url, at} | {error}}} ],
    "tests": [ {at, protocol, ftp, prevFtp, details, cp, wPrime, vo2, accepted} ],
    "favorites": [ "<file>" ]
  } },
  "tombstones": { "<deleted profile id>": "<iso time>" },
  "sync": { "provider": "off|icloud|dropbox|nextcloud|folder", "dir", "auto", "lastSync", "lastError" },
  "updates": { "auto": true }   // machine-local (not in a profile, never synced); missing = true
}
```

- **Machine-local settings:** `settings.devices`, `settings.zwoDir` and `settings.garmin.folder` are never synced (`sync::strip_local` / `keep_local`).
- **Secrets:** they live only in `secrets.json` (mode 0600), keyed by profile, and are never synced or logged.
- **Schema changes:** add defaults in `default_settings()` / `default_profile()` and handle missing keys in the UI (`?.`, `??`). Never require a migration for additive changes. Bump `version` only for breaking ones and write the migration in `Store::load`.

## Conventions

**Rust**
- `Result<T, String>` at the command boundary (`type Res<T>`). Error strings are shown to the user, so make them short, plain English and actionable.
- **No new crates without a strong reason;** keep the release binary small (`opt-level = "s"`, LTO). Prefer std plus existing deps (serde_json `Value` for flexible JSON).
- **File writes** go through `state::write_json` (tmp + fsync + rename) and must never be partial.
- **Paths from the UI** are relative to the workouts folder and pass `library::inside_root` (path-traversal guard). Deleting goes to the Trash (`trash` crate), never `remove_file` on user content.
- **Bluetooth:** dedupe ERG writes, never block the async runtime (use `spawn_blocking` for blocking work), reconnect silently.
- **Tests:** every parser, encoder, protocol decoder and merge rule has unit tests next to the code (`#[cfg(test)] mod tests`). Add one for every bug fix.

**JavaScript**
- Plain ES modules, no build step, no dependencies. `$` / `$$` helpers. Markup is built with the `html` tagged template from `js/html.js`, which escapes **every** interpolated value (XSS: workout names come from files); `raw()` only for markup we generated (icons, `renderMarkdown()`, SVG profiles), `tHtml()` for translations inside element content, `tText()` for translations in attributes (title, aria-label, placeholder — never `tHtml` there), `mount(el, fragment)` to set `innerHTML`. Booleans render nothing; write `${n > 0 && …}`, not `${n && …}`. There are no plain-string markup builders left: `scripts/check-html.mjs` fails on any `innerHTML` / `outerHTML` write outside `mount()` (empty an element with `replaceChildren()`).
- **Views** are functions that render `#view` (`renderHome`, `renderPlan`, `renderWorkouts`, `renderTests`, `renderHistory`) from small row/card builders (`workoutRow`, `planCard`, `testCard`, `historyRow`, …); `route()` picks one from the hash and `mode()`.
- **Actions:** every clickable element has `data-act="name"` (arguments in other `data-*`). `bindActions(root, handlers)` delegates clicks: a handler from `handlers` (dialog- or screen-specific) wins, else the shared `VIEW_ACTIONS` map (`close` included). Dialogs call `bindActions(modal, {...})` after `openModal`; the ride screen dispatches `data-act` to `Ride.control()`. Don't reintroduce `data-a` / `data-c` or per-button `onclick`. Menus use `menuBtn(items)` / `openMenu()` (a `<template>` holding `data-act` buttons).
- **Modals:** `openModal(fragment, cls)` (an `html` fragment; a plain string would show as text), `confirmDialog`, `choiceDialog`, `promptDialog`; `toast()` for feedback. Big dialogs are split: `openSettings` = one markup function per tab (`settingsRiderTab` …) + `bindSettingsFields` + `settingsActions`; the ride summary = `Ride.saveFit` / `recordTest` / `showSummary` with `summaryTest`, `summaryStats`, `summarySyncList`, `summaryNext`.
- **Languages (English, German, French):** every user-visible string goes through `t('key', vars)` from `js/i18n/index.js` and lives in `en.js`, `de.js` **and** `fr.js` (run `node scripts/check-i18n.mjs`). Mirrors wozTools' `src/i18n/`, as plain modules instead of a React hook.
  - Keys are camelCase (`p.ramp.name`, `mac.files`, `tm.*` for test-workout messages); counts use `{ one, other }` with `vars.n` (Intl.PluralRules, so French 0 is singular).
  - Values may contain our own markup (`<b>`, `<code>`, `&amp;`) for `innerHTML`. Strings for `confirmDialog`, `choiceDialog`, `toast()` and `textContent` are escaped/plain, so their values must be plain text. In markup use `tHtml('key', vars)`, which escapes the vars (pass an `html` fragment for markup such as `<b>`); with plain `t()` in a legacy HTML string, pass file and rider values through `esc()` first. Never make `t()` itself escape: it also feeds plain-text APIs.
  - Never name a local variable `t` (it shadows the translator); use `el`, `x`, `th`, `ts`…
  - The language is per rider (`settings.language`, copied to new riders like the theme); without it the system language is used, falling back to English. `applyLanguage()` sets it and fills `data-i18n` / `data-i18n-title` / `data-i18n-aria` in index.html; switching in Settings → App redraws the app at once (the ride screen picks it up with the next ride). Dates and times use `fmtLocale()`.
  - Zone names (`ZONES[i].name` in render.js) and test protocol texts (`PROTOCOLS[i].name/about/…` in tests.js) are getters, so they always follow the current language. Test results already saved keep the detail labels of the language they were ridden in; built-in test names are re-translated via `testName()`.
  - German uses "du", French "vous" with French typography (narrow no-break space before ? ! ; :, « »). Brand and hardware names (ERG, FTP, TSS, Zwift buttons, Garmin/COROS menu paths) stay as they are.
  - Rust error strings (shown in toasts) stay English for now.
- **During a ride** nothing may re-render or block: sync and profile switching are deferred (`if (ride) …`).
- **Dev URL parameters:** `?sim=1` starts simulated devices, `?speed=N` fast-forwards time (recordings stay 1 Hz), `?profile=…` skips "Who's riding?".

**CSS / UI:** follow [DESIGN.md](DESIGN.md). Only token colours (`var(--…)`), no hard-coded colours except zone and brand colours. Every change must work in **light and dark**, from 900 px up to full screen (the optional Compact ride view supports 320 × 200).
- **Where a rule goes (cascade layers):** reusable pieces in `css/components/`, screen-specific rules in `css/views/`; a later layer always wins, so a view overrides a component without raising specificity. A component file never names a view (no `.ride .btn` in `buttons.css`); put that in the view. New files need an `@import … layer(…)` line in `styles.css`. No unlayered CSS (it would beat every layer) and no `<style>` blocks.
- **Nesting:** native CSS nesting, always with `&` (`& .child`, `&.mod`, `&:hover`), declarations before nested rules, and never nest under a selector list whose parts differ in specificity (`&` becomes `:is(…)`, which takes the highest one). Keep nesting shallow (≤ 3 levels).
- **Order still matters inside a file** where media blocks adjust earlier rules (ride.css: short-window and ≥ 1401 px blocks stay below the rules they change).
- **Engines:** layers and nesting need Safari 17+, current WebView2 and WebKitGTK ≥ 2.42. macOS 13 is the minimum (`minimumSystemVersion`, an owner decision; Safari 17 would also run on macOS 12). The OS minimum alone doesn't guarantee that (a macOS release ships with an older Safari until it is updated), so `checkEngine()` in app.js shows an "update your system" notice when the `--css-ok` marker from `base.css` is missing. Keep that marker and the check when touching base.css or boot.

## Testing changes

1. `cd src-tauri && cargo test`; all tests must pass, warning-free.
2. **UI changes:** run the app (`cargo tauri dev`, or the browser mock below) and look at the changed screens in **both themes** and at **1400 px and full-screen width**. Screenshot before/after if you can.
3. **Without hardware:** use `?sim=1` (or *Use simulator* in a device dialog). Controller buttons can be exercised from the console by emitting `button` events through the mock.
4. **Browser mock (optional):** serve `ui/` with a small static server and inject a `window.__TAURI__` stub that answers the commands above (`app_state`, `scan_library` → JSON from a sample folder, …). Never ship it. `scripts/shots/` already is one (`mock.js` + `rider.mjs` + the fixture library); reuse it for any browser test or screenshot rather than starting a new mock.

## Website (`site/`)

- **Keep it in step with releases:** when a release changes what the site describes (features, requirements, settings, dialogs), update the copy in `index.html` / `features.html` / `download.html` and retake the affected screenshots in the same change. Wording follows the README.
- **Screenshots:** every image exists as `<name>-dark.webp` and `<name>-light.webp`, shown with `class="sd"` / `class="sl"`. **All of them are scripted** in `scripts/shots/`; don't take site screenshots by hand.
  - **Retake:** `npx -y -p playwright node scripts/shots/run.mjs` (all, ~15 s) or with shot names (`… ride compact`); `--list` shows them. Playwright comes via npx, not a repo dependency; run `npx -y playwright install chromium` once.
  - **Reading the result (cheap):** one line per image. `unchanged` needs no look. `updated n % px in W×H at x,y` says how much and where. Only changed images are written, and all of them land on one contact sheet (path printed; `--sheet <file>` to choose): look at that single image, not at each file. `--out <dir>` writes elsewhere to compare before touching `site/img`.
  - **Sizes:** the runner rewrites `width`/`height` of every `<img>` showing that image in `site/*.html`; never edit them by hand.
  - **Deterministic:** the clock is fake and paused (`rider.mjs` `NOW`; time moves only through `s.tick()`), `Math.random` and the virtual rider are seeded, so an unchanged UI gives identical pixels and a second run says `no changes`. If a shot flips between runs, something in it runs on real time; find it rather than raising the noise threshold.
  - **Data:** the rider (`rider.mjs`) and the library (`fixture/`, 2 plans, 2 collections, 45 workouts) are shared by all shots. The library JSON comes from the real Rust scan/parse (`library::tests::dump_fixture`, an ignored test), so after parser or scan changes rerun `node scripts/shots/fixture/make.mjs` and then the shots.
  - **Devices and rides:** saved devices auto-connect to the mock's virtual trainer, strap and controller (no `?sim=1`); the virtual rider holds every ERG target, rides `free` watts (per shot) when ERG is off and keeps ~90 rpm. Ride shots fast-forward with `?speed=N`.
  - **New shot:** add an entry to `shots.mjs` (`name`, `about`, `viewport`, `scale` 1 for 1600 × 1000 screens and 2 for dialogs/cards, optional `rider(p)`, `run(s)` returning the selector to capture), add the `<img class="sd">` / `<img class="sl">` pair to the page, run it, check the contact sheet. A command the mock doesn't know is reported as `unmocked: …`; add it to `R` in `mock.js`.
- **Checking:** open the pages in both themes at desktop and phone width. Sections reveal on scroll (`.rv` → `.in`), so for full-page captures add `in` to every `.rv` first.

## Things that are easy to get wrong

- **Ramps:** `PowerLow` is the start and `PowerHigh` the end (cooldowns descend). `IntervalsT` expands into on/off segments with `rep` / `reps`.
- **Plans vs collections:** `library::folder_kind` says `plan` only when a folder spans ≥ 2 weeks; converters name collections `Week01_Day01…DayNN`, so "1 week" is meaningless. The UI decides with `isPlan()`: rider override (`settings.folderKinds`) → active/started plan → library kind. Don't show week/day labels for collections (`showWeekDay`).
- **Descriptions:** `<folder>.md` (else README.md, else the only `.md`), capped at 64 KB, rendered by `markdown.js`. Never inject description HTML unescaped; links only open via `open_link` (http/https).
- **FTP tests (`tests.js`):** results come only from tagged samples (`measure`): ramp steps are tagged `ramp`, all-out efforts `20` / `a` / `b` / `m20` / `e<i>`. `effort()` returns a power only when ≥ `COMPLETE` (95 %) of the effort was ridden; otherwise `incomplete()` returns `{ ftp: null, incomplete: { label, ridden, needed, text } }`. Never fall back to "best N minutes of the whole ride" — warm-up and recovery would give a too-low FTP.
- **Test ride rules (`Ride` in app.js):** during a test, auto-pause is skipped in every measured segment (`cs.measure`), `go(t)` (all seeks from buttons, keys, controllers, the chart) blocks skipping inside a measured block and snaps jumps to its start (forward) or end (backward), and `rampCooldown()` replaces the remaining ramp steps with a 5-minute cool-down when the rider fails (`this.cooling`; Stop then finishes without the dialog). Pacing uses `this.effAcc[tag]` (running sum per effort, filled where samples are recorded).
- **Sounds (`sound.js`):** MP3 (decodes in every webview: WKWebView, WebView2, WebKitGTK/GStreamer; Ogg isn't reliable in WKWebView). They are fetched from the app origin (CSP `connect-src 'self'`) and decoded when a ride opens; until they are ready, or if decoding fails, the plain beep plays. Each countdown tick plays only its own note, so pause and seek can't leave a cue running. Note starts come from `noteStarts()` on the decoded audio, never fixed offsets: MP3 decoders add a short, decoder-specific delay at the start. New sounds must be CC0 (or another licence that needs no attribution in the app) and get a line in the README's License section. The chime plays only when `finish(true)` is reached at the end of the workout and `!this.test`.
- **FTMS control point (`ble.rs`):** the notification task forwards control-point replies (`parse_cp_response`) to `Conn::command`, which waits for the reply to its own op code. A reply never turns ERG off; only a failed BLE write during the handshake means power only. *Control not permitted* (on request control, start or a target) only sets `ergDenied`, a warning the UI toasts once, because some firmware refuses yet follows targets; an accepted target clears it (`denied_after`). Other result codes → ERG as before; no reply → tolerated (many trainers stay silent), and later targets don't wait for replies (`acks`). During a ride a *not permitted* target re-requests control once, and the refused target isn't resent. A failed target write returns `Err` from `trainer_set_power` / `trainer_free_ride`, and `Trainer.send` in ble.js then forgets `lastSent` so the next tick resends it. Never treat a successful BLE write alone as "ERG works".
- **Supported Power Range (0x2AD8):** read once when connecting, before the control handshake (no command in flight). `write_control` clamps every ERG target to it and snaps it to the trainer's increment *before* the dedupe (`PowerRange::clamp`). A missing, unreadable or nonsensical range (max ≤ min, step wider than the range) falls back to 0–2000 W; the trainer's max never raises our own 2000 W cap. Only `Target::bytes()` builds control point commands.
- **Free-ride segments** have `p0 === null`; all-out efforts are `erg: false` with a measurement window. Both must release ERG (free ride or virtual shifting).
- **Zwift Ride:** only the **left** controller needs a connection. The sync-RX characteristic accepts write-without-response only; the handshake picks the write type from the characteristic properties. Button bits are **cleared** when pressed.
- **OpenBikeControl:** the protocol is decided by the advertised service at scan time and by the discovered GATT services at connect time (`shifter::protocol`; OpenBikeControl wins over Zwift data), never by trying one and falling back. One press can send several ids in one message; `obc::Tracker` turns the newly pressed ids into one press and picks one button by priority (shift > difficulty > interval skip / navigation / select, difficulty first in ERG segments). A button held longer than `HOLD_MAX` (2 s) counts as released, so a lost release message can't block it. Rust sends both picks, `onButton` in app.js chooses with `ride.freeLike`. Bluetooth only: the mDNS / TCP transport would need a new crate.
- **FIT:** CRC, local message definitions and the Garmin flavour (manufacturer 1, product 1036 = Edge 500) are validated against `fitdecode`. Keep the tests green when touching `fit.rs`.
- **Activity names:** FIT has no activity-title field. `fit::encode` writes a `workout` message (`wkt_name`, max 63 bytes) plus up to 100 `workout_step`s from `Ride.steps` (power targets as watts + 1000; > 100 steps → name only), like a structured workout from an Edge. Garmin Connect ignores it when importing (tested Oct 2026: the activity is still named by Garmin's default), but FIT readers such as Strautomator can use it. After a Garmin upload, `garmin::rename` sets `activityName` / `description` (`PUT /activity-service/activity/{id}`). If Garmin hasn't returned an id yet, `find_by_start` matches the latest activities by start time (the UI passes `start`). Intervals.icu gets `name` on upload plus a `PUT /api/v1/activity/{id}`. Names come from `rideMeta()` in app.js.
- **Garmin:** the sign-in runs on Garmin's own page in a WebviewWindow; we only read the `ST-` ticket. Never inject credentials or scrape the password field.
- **Sync:** the newest profile wins, history and tests are unioned, deletions use tombstones, and history `*Path` fields are relocated per Mac. Changing merge rules needs a test in `sync.rs`.
- **Damaged state (`state.rs`):** a `state.json` / `secrets.json` that doesn't parse as a JSON object is renamed to `<name>.corrupt-<unix>` before defaults are created; if it can't be read or moved aside, `read_json_object` fails and writes are refused instead of replacing it. `write_json` fsyncs the tmp file before the rename and creates secrets with mode 0600.
- **ZWO limits:** `MAX_ELEMENT_SECS` (1 day, durations clamp), `MAX_REPS` (1000, repeats clamp) and `MAX_WORKOUT_SECS` (48 h; longer is a parse error, the scan skips the file). They exist in `zwo.rs` and `zwo.js`; keep both equal.
- **Other platforms (`services.rs`):**
  - Only platforms with **automatic upload for everyone** (Intervals.icu) plus COROS's manual import are supported, to keep the app simple.
  - Wahoo, TrainingPeaks and Suunto need approved partner apps and were removed on purpose; don't re-add them. **Never copy another app's client ids or secrets.**
  - Intervals.icu uses the rider's personal API key (Basic auth `API_KEY:<key>`, upload `POST /api/v1/athlete/0/activities`, multipart `file`).
  - COROS Training Hub imports only ZIPs (`zip_stored`).
  - Secrets are stored under `svc:<id>` in `secrets.json`; per-ride results go in `history[].services[id]`; modes live in `settings.services[id].mode`.
- **Strava:** deliberately no Strava API integration (owner subscription requirement since 2026). Strava gets rides via Garmin's partner sync, which pushes once right after the import: Strava keeps its own default name ("Morning Ride") and the default bike, the type is Indoor Cycling. Neither `wkt_name` nor the later `garmin::rename` reaches Strava, and there is no known way around this without the Strava API. Don't re-add an API key flow.
- **Updates (`updater.rs`, `initUpdates()` in app.js):**
  - The UI decides when: first check 8 s after boot, then every 6 h, only with `updates.auto` and never while `ride` is set. `Ride.close()` shows a card for an update found earlier; *Later* hides it for that version until the next launch.
  - `update_check` stores the `Update` in the `Pending` state; `update_install` takes it, downloads, verifies, installs and calls `app.restart()` (on Windows the installer quits the app first). A failed install puts it back so *Install & restart* can be retried.
  - The plugin's own JS commands are not enabled in `capabilities/default.json` on purpose: everything goes through our commands.
  - Bump the version only through the release workflow: the updater compares the manifest's `version` with `Cargo.toml`'s.
- **Workout rows (`.wrow`):** never give the action column a fixed width; translated labels are up to twice as long as English. The columns live on the list (`.wlist`, and `.weeks` around all weeks of a plan) and rows use `grid-template-columns: subgrid`, so the action column grows to the widest row and every row stays aligned. With subgrid the row's 14 px padding comes out of the edge tracks (first track 40 = 26 + 14). Anything else placed in a `.wlist` must span `1 / -1`.
- **Settings (`openSettings()`):** one save model: every control writes `state.settings` and calls `save()` (→ `api.saveState()`) on change; numbers on `change` only when valid (`FIELDS` with min/max from the input, zones must increase), otherwise a `.field-err` line and `aria-invalid`, nothing saved. There is no Save/Cancel and no theme revert; Done/✕ refuse to close while a field is invalid (they focus it), Esc and a backdrop click always close. Views redraw once on close (`onModalClose`, `settingsDirty`), never while typing. Tabs: `rider`, `riding` (sounds, ride behaviour, virtual shifting with gear tuning under *Advanced*), `sync` (Connections), `app` (appearance, language, folder, devices, updates, About). New options go into the matching tab and group; segmented controls use `segRow()`.
- **Top bar:** it is identical on every full-size screen, including during a ride. Don't add controls there; use Settings or a "⋯" menu. The one exception is the icon-only compact-view button (`#btn-compact`, before the rider avatar), which is hidden outside a ride. Optional Compact view hides it entirely; expand restores it unchanged.
- **Compact ride view (`compact.js`, `ride_window.rs`):** same Ride and same native window. `CompactView.set(bool)` serializes IPC and changes CSS only after success; never call `Ride.build()` on resize. `ride_window` snapshots physical geometry once, lowers minimum size to 320 × 200 (initial 960 × 200 logical), and restores the normal 900 × 640 minimum/geometry/maximization. Failures roll back and allow retry; window positioning is best-effort so compositor restrictions do not block resizing. Native fullscreen must be exited first. Stop/finish/close expand before dialogs/routing. The compact section holds three mini panels (LIVE gauge, CURRENT ring, NEXT card) with their own `Gauge` / `ProgressRing` instances, filled by `Ride.render()` next to the full-view values; a `ResizeObserver` (`Ride.cObs`, disconnected in `close()`) writes `compactMode()` as `data-mode` / `data-short` / `data-tiny` / `data-narrow` / `data-xs` on `.compact-ride`, and CSS does the rest (gauges stay, text drops out first). Play/stop and "workout left" exist twice (heading row when short, footer otherwise). Only presentation changes; recording, ERG, test rules and controller/keyboard handling continue. Compact readouts use actual target/free/all-out mode, not test-estimated FTP. No persisted state or new Tauri plugin permissions.
- **Cross-platform (macOS, Windows, Linux):**
  - **Wording:** never hard-code "Finder", "macOS Trash" or "this Mac" in the UI. Use `PLAT` in app.js (`PLAT.files`, `PLAT.trash`, `PLAT.machine`, `PLAT.onThisMachine`, `PLAT.bt`, `PLAT.emojiKey`); each is read from the dictionary (`mac.files`, `win.trash`, …) so it follows the UI language. `OS` is `mac` / `win` / `linux` and is also set as `<html data-os>`.
  - **Layout:** the 92 px traffic-light gap in the top bar applies only to `:root[data-os="mac"]`; Windows and Linux have a normal title bar (`titleBarStyle`, `hiddenTitle` and `trafficLightPosition` are macOS-only keys).
  - **Rust:** gate OS-specific code with `#[cfg(target_os = …)]` / `#[cfg(unix)]` and keep a fallback so every target compiles (e.g. `keep_awake`: `caffeinate` on macOS, `systemd-inhibit` on Linux, the web Screen Wake Lock API on Windows; `secrets.json` 0600 only on unix; `brctl` only on macOS).
  - **Paths:** build paths with `Path::join`, never string concatenation with `/`; library-relative ids are always `/`-separated (`library::rel_string`).
  - **Sync folders:** `sync::targets()` knows the macOS locations (`~/Library/CloudStorage`, iCloud Drive) plus `~/iCloudDrive` (Windows), `~/Dropbox` and `~/Nextcloud`.

## Commit & PR hygiene

- One logical change per commit with an imperative subject ("Add auto-pause", "Fix Zwift Ride handshake").
- Update README.md (user-visible behaviour), DESIGN.md (visual rules, new components) and this file (architecture, commands, gotchas) in the same change.
- Don't commit `src-tauri/target/`, `src-tauri/gen/`, user data or secrets.

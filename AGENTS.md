# AGENTS.md — working on zwoTrainer

Guidance for coding agents (and humans) changing this repository. User documentation lives in [README.md](README.md) and the visual design system in [DESIGN.md](DESIGN.md). Keep all three in sync with the code. When behaviour changes, update the README in the same change.

## What this is

A macOS desktop app (Tauri 2) for riding Zwift `.zwo` workouts on a Bluetooth smart trainer. It covers folder-based plans, free workouts, FTP tests, rider profiles, FIT recording, Garmin upload and profile sync through a cloud folder.

**Product principles** (don't break them):
- **Lightweight and fast:** no bundler, no Node, no frontend framework, no runtime downloads. App start and library scans of ~2,600 files must stay well under a second.
- **Not in scope:** video courses, a workout builder, music, social features or a complex frontend.
- **Clean, calm UX:** few controls, destructive actions behind "⋯" menus and confirmations, consistent top bar (see DESIGN.md).
- **The rider's data is theirs:** local JSON files, optional sync through a folder the user chooses, no telemetry. Garmin passwords and MFA never pass through our code.

## Repository layout

```
ui/                         frontend — static files served by Tauri (frontendDist = ../ui)
  index.html                shell: top bar, #view, #ride, <dialog id="modal">, #toast
  css/styles.css            ALL styles; theme tokens on :root (light) + dark overrides
  js/app.js                 app controller: boot, routing, modes, riders, settings, sync, Ride class
  js/render.js              zones, colours, mini profiles, Diagram (workout chart), Gauge, ProgressRing
  js/zwo.js                 client-side ZWO helpers: parse, powerAt, segmentAt, TSS, zone classification
  js/tests.js               FTP test protocols, evaluation, VO2max, test-workout detection
  js/vshift.js              virtual drivetrain + flat-road physics (virtual shifting)
  js/ble.js                 device objects (Trainer, HeartRate, Controllers), simulator, Tauri event binding
src-tauri/
  src/lib.rs                Tauri commands (the only IPC surface) + App state
  src/state.rs              Store: state.json (profiles) + secrets.json, atomic writes, migrations
  src/sync.rs               profile sync through a cloud-synced folder
  src/library.rs            workouts-folder scan, natural sort, mtime cache, path-traversal guard
  src/zwo.rs                ZWO parser (authoritative), TSS estimate, zone classification
  src/fit.rs                FIT encoder (Generic + Garmin flavour)
  src/garmin.rs             Garmin SSO window → OAuth1 → OAuth2, upload
  src/services.rs           Intervals.icu (automatic upload, API key) and COROS (manual Training Hub import, ZIP)
  src/ble.rs                btleplug: FTMS (ERG), Cycling Power, Heart Rate, reconnect
  src/shifter.rs            Zwift Ride / Click / Play protocol (RideOn handshake, button decoding)
  tauri.conf.json           window, CSP, bundle; Info.plist (Bluetooth usage, App Nap off)
  capabilities/default.json Tauri permissions (keep minimal)
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
```

The minimum Rust version is **1.82** (`Option::is_none_or` is used). Builds must stay warning-free.

## Architecture

```
UI (vanilla ES modules) ──invoke(cmd, args)──▶ Rust commands (lib.rs) ──▶ state / library / ble / fit / garmin / sync
        ▲                                                     │
        └──────────── events: device-status, sensor, button, ctrl-raw ◀──┘
```

- **IPC:** the UI talks to Rust only through `window.__TAURI__.core.invoke` (wrapped in `ble.js` as `invoke`) and `event.listen` (`withGlobalTauri: true`). Every new capability is a `#[tauri::command]` in `lib.rs` and must be registered in `generate_handler!`.
- **Commands** (current set): `app_state save_profile create_profile rename_profile edit_profile delete_profile switch_profile sync_targets sync_config sync_now pick_sync_dir scan_library load_workout pick_zwo_dir save_activity reveal_in_library trash_in_library export_activity garmin_import pick_garmin_dir open_url garmin_status garmin_connect garmin_disconnect garmin_upload services_status service_connect service_disconnect service_upload service_manual keep_awake ble_scan ble_connect ble_disconnect ble_current trainer_set_power trainer_free_ride trainer_resume ctrl_scan ctrl_connect ctrl_disconnect ctrl_list`.
- **Events Rust → UI:**
  - `device-status {kind: trainer|hr|controller, connected, reconnecting, name, erg, count}`
  - `sensor {power?, cadence?, speed?, hr?}`
  - `button {button, device}`
  - `ctrl-raw {device, hex}`
- **State ownership:**
  - The profile schema is owned by the UI. `state.rs` guarantees defaults (`merge_defaults`), ids, `updatedAt` and atomic writes; it must not drop unknown keys.
  - The UI mutates `state` (the active profile) and calls `api.saveState()` → `save_profile`.
  - Rust-side changes (create/edit/switch/delete profile, sync) return a fresh `app_state` summary, which the UI applies with `applyAppState()`.
- **The ZWO parser exists twice:** `zwo.rs` is authoritative (library scan, workout loading) and `ui/js/zwo.js` is a mirror used by the mock/dev server and some client helpers. If you change parsing, TSS or zone classification, change **both** and keep their outputs identical.
- **Ride loop:** the `Ride` class in `app.js` ticks every 250 ms. It computes the target, sends ERG (deduplicated in JS and Rust), records 1 Hz samples, runs auto-pause, beeps and controller actions. `finish()` → `save_activity` (FIT) → history → Garmin upload.

## Data model (state.json v2)

```jsonc
{
  "version": 2,
  "activeProfile": "p_…",
  "profiles": { "p_…": {
    "id", "name", "avatar": { "color": "#rrggbb"|null, "emoji": "🚴"|null },
    "createdAt", "updatedAt",
    "settings": { "ftp", "maxHr", "weight", "zones": [55,75,90,105], "bests": {s5,m1,m5,m20},
                  "theme", "mode", "beeps", "autoPause", "overlay": {power,cadence,hr},
                  "shifting": {...}, "zwoDir", "devices": {trainer, hr, controllers[]},
                  "garmin": {mode, autoOpen, folder},
                  "services": { "<intervals|coros>": {mode: off|manual|auto} } },
    "activePlan", "plans": { "<folderId>": { startedAt, finishedAt?, entries: { "<file>": {status, at, …} } } },
    "history": [ {file, plan, title, at, status, doneDuration, avgPower, np, …, fitPath, garmin?, services?: {<id>: {id, url, at} | {error}}} ],
    "tests": [ {at, protocol, ftp, prevFtp, details, cp, wPrime, vo2, accepted} ],
    "favorites": [ "<file>" ]
  } },
  "tombstones": { "<deleted profile id>": "<iso time>" },
  "sync": { "provider": "off|icloud|dropbox|nextcloud|folder", "dir", "auto", "lastSync", "lastError" }
}
```

- **Machine-local settings:** `settings.devices`, `settings.zwoDir` and `settings.garmin.folder` are never synced (`sync::strip_local` / `keep_local`).
- **Secrets:** they live only in `secrets.json` (mode 0600), keyed by profile, and are never synced or logged.
- **Schema changes:** add defaults in `default_settings()` / `default_profile()` and handle missing keys in the UI (`?.`, `??`). Never require a migration for additive changes. Bump `version` only for breaking ones and write the migration in `Store::load`.

## Conventions

**Rust**
- `Result<T, String>` at the command boundary (`type Res<T>`). Error strings are shown to the user, so make them short, plain English and actionable.
- **No new crates without a strong reason;** keep the release binary small (`opt-level = "s"`, LTO). Prefer std plus existing deps (serde_json `Value` for flexible JSON).
- **File writes** go through `state::write_json` (tmp + rename) and must never be partial.
- **Paths from the UI** are relative to the workouts folder and pass `library::inside_root` (path-traversal guard). Deleting goes to the Trash (`trash` crate), never `remove_file` on user content.
- **Bluetooth:** dedupe ERG writes, never block the async runtime (use `spawn_blocking` for blocking work), reconnect silently.
- **Tests:** every parser, encoder, protocol decoder and merge rule has unit tests next to the code (`#[cfg(test)] mod tests`). Add one for every bug fix.

**JavaScript**
- Plain ES modules, no build step, no dependencies. `$` / `$$` helpers, template strings, and `esc()` for **every** interpolated user or file value (XSS: workout names come from files).
- **Views** are functions that render `#view` (`renderHome`, `renderPlan`, `renderWorkouts`, `renderTests`, `renderHistory`); `route()` picks one from the hash and `mode()`.
- **Actions** use `data-act` attributes, handled by `bindActions(root)`. Menus use `menuBtn(items)` / `openMenu()` (a `<template>` holding `data-act` buttons).
- **Modals:** `openModal(html, cls)`, `confirmDialog`, `choiceDialog`, `promptDialog`; `toast()` for feedback.
- **During a ride** nothing may re-render or block: sync and profile switching are deferred (`if (ride) …`).
- **Dev URL parameters:** `?sim=1` starts simulated devices, `?speed=N` fast-forwards time (recordings stay 1 Hz), `?profile=…` skips "Who's riding?".

**CSS / UI:** follow [DESIGN.md](DESIGN.md). Only token colours (`var(--…)`), no hard-coded colours except zone and brand colours. Every change must work in **light and dark**, from 900 px up to full screen.

## Testing changes

1. `cd src-tauri && cargo test`; all tests must pass, warning-free.
2. **UI changes:** run the app (`cargo tauri dev`, or the browser mock below) and look at the changed screens in **both themes** and at **1400 px and full-screen width**. Screenshot before/after if you can.
3. **Without hardware:** use `?sim=1` (or *Use simulator* in a device dialog). Controller buttons can be exercised from the console by emitting `button` events through the mock.
4. **Browser mock (optional):** serve `ui/` with a small static server and inject a `window.__TAURI__` stub that answers the commands above (`app_state`, `scan_library` → JSON from a sample folder, …). Useful for Playwright screenshots; never ship it.

## Things that are easy to get wrong

- **Ramps:** `PowerLow` is the start and `PowerHigh` the end (cooldowns descend). `IntervalsT` expands into on/off segments with `rep` / `reps`.
- **Free-ride segments** have `p0 === null`; all-out efforts are `erg: false` with a measurement window. Both must release ERG (free ride or virtual shifting).
- **Zwift Ride:** only the **left** controller needs a connection. The sync-RX characteristic accepts write-without-response only; the handshake picks the write type from the characteristic properties. Button bits are **cleared** when pressed.
- **FIT:** CRC, local message definitions and the Garmin flavour (manufacturer 1, product 1036 = Edge 500) are validated against `fitdecode`. Keep the tests green when touching `fit.rs`.
- **Garmin:** the sign-in runs on Garmin's own page in a WebviewWindow; we only read the `ST-` ticket. Never inject credentials or scrape the password field.
- **Sync:** the newest profile wins, history and tests are unioned, deletions use tombstones, and history `*Path` fields are relocated per Mac. Changing merge rules needs a test in `sync.rs`.
- **Other platforms (`services.rs`):**
  - Only platforms with **automatic upload for everyone** (Intervals.icu) plus COROS's manual import are supported, to keep the app simple.
  - Wahoo, TrainingPeaks and Suunto need approved partner apps and were removed on purpose; don't re-add them. **Never copy another app's client ids or secrets.**
  - Intervals.icu uses the rider's personal API key (Basic auth `API_KEY:<key>`, upload `POST /api/v1/athlete/0/activities`, multipart `file`).
  - COROS Training Hub imports only ZIPs (`zip_stored`).
  - Secrets are stored under `svc:<id>` in `secrets.json`; per-ride results go in `history[].services[id]`; modes live in `settings.services[id].mode`.
- **Strava:** deliberately no Strava API integration (owner subscription requirement since 2026). Strava gets rides via Garmin's partner sync. Don't re-add an API key flow.
- **Top bar:** it is identical on every screen, including during a ride. Don't add controls there; use Settings or a "⋯" menu.

## Commit & PR hygiene

- One logical change per commit with an imperative subject ("Add auto-pause", "Fix Zwift Ride handshake").
- Update README.md (user-visible behaviour), DESIGN.md (visual rules, new components) and this file (architecture, commands, gotchas) in the same change.
- Don't commit `src-tauri/target/`, `src-tauri/gen/`, user data or secrets.

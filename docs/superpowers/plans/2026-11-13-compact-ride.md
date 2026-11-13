# Compact Ride View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #12 and deliver a locally built macOS app and DMG.

**Architecture:** Keep one Ride instance and one native window. A small presentation controller serializes native requests; a Rust window-state manager snapshots/restores geometry. Compact readouts are built once and updated by the existing ride loop; CSS selects horizontal or vertical arrangements.

**Tech Stack:** Tauri 2, Rust, dependency-free vanilla ES modules/CSS, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-13-compact-ride-design.md`

## Global Constraints

- Minimum Rust version is **1.90**; no new crates, frontend frameworks, bundler, or runtime downloads.
- Normal minimum window remains **900 × 640**; Compact minimum is **320 × 200**, initial **960 × 200** logical pixels.
- All new copy in en/de/fr; token colors, escaped file values, accessible icon names.
- No Ride rebuild, trainer/recording change, profile schema change, embedded video or always-on-top.
- Normal top bar unchanged; hide it only in Compact view. Preserve all supported desktop platforms.

## Review Focus

- Rapid enter/exit or closing during a resize: requests serialize, final presentation matches native state.
- Native resize failure: no interrupted ride or lost geometry; retry works.
- Tiny windows with long German/French labels: all four core readouts and primary controls remain visible.
- Free/all-out/test segments: display appropriate mode/target; retain virtual shifting, test protections and keyboard/controller behavior.
- Maximized/fullscreen/DPI changes or unavailable positioning: restore physical size/maximization and position where supported; reject fullscreen entry clearly and safely.

---

### Task 1: Implement and document the complete compact ride lifecycle

**Files:**
- Create `ui/js/compact.js`, `scripts/compact-ride.test.mjs`, `src-tauri/src/ride_window.rs`.
- Modify `ui/js/app.js`, `ui/css/styles.css`, `ui/js/i18n/{en,de,fr}.js`, `src-tauri/src/lib.rs`, `.github/workflows/ci.yml`, `README.md`, `DESIGN.md`, `AGENTS.md`.

**Interfaces:**
- `CompactView({resize, apply, report})`, `set(active: boolean): Promise<boolean>`, `active: boolean`.
- `ride_window(compact: bool) -> Result<(), String>`; machine-local managed mutex, no persisted state.
- Compact DOM/readouts belong to `Ride.build()` and are updated in `Ride.render()`; native layout transitions never call `Ride.build()`.

- [x] Write Node tests for entry/exit, idempotence, queued requests, failure/retry; removing a successful transition must make them fail.
- [x] Run `node --test scripts/compact-ride.test.mjs`; expect a missing-module/feature failure before implementation.
- [x] Write Rust window lifecycle tests with a fake native boundary: once-only snapshot, minimum constraints, physical restoration, maximization, failed entry/exit retry and fullscreen rejection. Run `cargo test --locked ride_window` to demonstrate missing implementation.
- [x] Implement `CompactView` and the window manager/registered IPC command using current Tauri APIs, no additional permissions/crates.
- [x] Run both focused suites; expect zero failures.
- [x] Add the once-built compact presentation, ride-control menu/expand, mirrored pause status and safe expansion before stop/finish/close. Keep the live loop untouched.
- [x] Add responsive token-based styling and en/de/fr labels; integrate Node tests into CI; update README/DESIGN/AGENTS.
- [x] Run Node tests/syntax/i18n and Rust tests/clippy. Expected: green, no warnings.
- [x] Review the diff for scope and lifecycle consistency before the final feature commit.

### Task 2: Verify rendered behavior and deliver the build

**Files:** temporary mock/browser test scripts and screenshots under git-ignored scratch; no shipped mock or new dependency.

**Interfaces:** consumes Task 1 compact UI/IPC and existing simulator/dev parameters.

- [x] Run the real UI against a temporary static server/Tauri stub. Assert DOM retention, current power/target/time updates, recorded sample continuity, native request ordering, pause/resume, stop dialog expansion, virtual shifting and missing-sensor labels.
- [x] Batch checks/screenshots for light/dark at 320 × 200, 320 × 520, 960 × 200 and intermediate sizes in en/de/fr; verify no clipped core metrics/control targets. Check full dashboard at 1400 and 2560 pixels.
- [x] Fix confirmed functional defects with failing regression tests, then run the full suites again; at most one visual confirmation pass.
- [x] Run Impeccable detector once over changed UI targets and inspect contextual findings.
- [x] Run `cargo tauri build`; expected: successful `.app` and `.dmg` under `src-tauri/target/release/bundle/`.
- [x] Inspect the final diff and built artifacts; verify branch/content and report exact app/DMG paths plus any platform-verification limits. Do not push/merge/release or close the issue.

## Verification results

- Full Rust suite: **52 passed**, zero failures; warning-free `cargo clippy --locked --all-targets -- -D warnings`.
- JavaScript lifecycle suite: **5 passed**; all module syntax checks and **626 translation keys** validated.
- Real browser UI with temporary native/hardware stubs: **39 geometry/state checks**, both themes/all three languages, retained Ride/DOM, continuing samples, pause/keyboard controls, virtual shifting, test skip protection, missing sensors, resize-failure retry, stop/result expansion and automatic FIT save/close.
- One mechanical design scan: no new-component findings; two incumbent CSS advisories left unchanged.
- macOS Apple Silicon release build: **1.4.1**, `.app` and `zwoTrainer_1.4.1_aarch64.dmg`; ad-hoc signature and disk-image integrity validated.
- Limits: Windows/Linux native runtime and actual BLE hardware need platform/rider verification. Fullscreen must be exited before switching; position restoration is best-effort where the compositor restricts it. Final code review was an author review, not a delegated independent review.

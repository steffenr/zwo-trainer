# Compact ride view — design

**Issue:** https://github.com/steffenr/zwo-trainer/issues/12
**Branch:** `feat/12-compact-ride-layouts`
**Decision:** The user approved proceeding with the defaults proposed in the conversation.

## Intent and scope

Keep essential ride information visible beside or above an external video player. Add an optional Compact view, entered from a ⋯ menu beside the existing ride controls. Do not embed video, add always-on-top behavior, change the full dashboard, or change workout/trainer/recording behavior.

## Approaches

- Make every screen work below 900 × 640: broad scope, with navigation and dialogs competing for space.
- Add a second window: duplicates window lifecycle and introduces synchronization risk.
- **Chosen: compact presentation of the same ride in the same window.** Build its readouts once with the ride; CSS switches presentations. The running Ride instance, samples, keyboard/controller actions and trainer control remain unchanged.

## Presentation

- Compact minimum inner size: **320 × 200 logical pixels**; initial size: **960 × 200**.
- A short horizontal bar displays power, target power, segment remaining and workout remaining, with pause/resume, stop and expand.
- A narrow vertical panel reflows the same information. Cadence and heart rate appear when sufficient height/width is available. Missing sensors show a dash; free/all-out effort labels must not become fictional ERG targets.
- Preserve useful readiness, paused/auto-paused and trainer connection status. Virtual gears remain accessible in free-like segments.
- In Compact view only, hide the normal app toolbar, chart and full dashboard. Keep a draggable heading with room for macOS traffic lights. Do not add controls to the normal top bar.
- Use existing tokens, system fonts, zone inks and tabular numbers. All new copy is translated into English, German and French; icon controls have accessible names and keyboard focus.

## Lifecycle

A Rust command `ride_window(compact: bool)` lowers/restores the minimum window size and remembers full-view geometry. Snapshot once on entry; repeat entry/exit calls are idempotent. Restore physical size (DPI-safe) and maximization on exit; restore position where the compositor supports it, without making positioning a requirement for resizing. A fullscreen window must be exited before Compact view, with an actionable error rather than racing the OS fullscreen animation.

Serialize UI requests. Change presentation only after native resizing succeeds; report failures without interrupting the ride, and permit retry. Expand before stop/result dialogs and before closing the ride. No profile setting, persistence, migration, new crate or frontend dependency is needed.

## Verification

Unit tests cover serialized/idempotent transitions, resize failures/retries, geometry restoration and maximization. Browser tests use the real UI with a temporary Tauri/sensor stub and cover both layouts, minimum sizes, all languages/themes, missing sensors, ERG/free-like segments, pause/resume, stop/expand, continuing samples and retained DOM. Check the unchanged dashboard at 1400 and 2560 pixels. Run Rust tests, warning-free clippy, JavaScript tests/syntax, i18n validation and a release `cargo tauri build`. Cross-platform APIs are checked in source; Windows/Linux runtime verification requires CI/platform access and is not claimed locally.

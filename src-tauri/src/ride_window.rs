// Machine-local geometry for the optional compact presentation of the main ride window.
// Physical snapshots preserve position/size across monitors; requested sizes are logical.
// The compact geometry the rider last used is persisted (state.json root key `compact`) and
// restored on the next compact entry; it never leaves the machine and is never synced.
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Smallest compact window in logical px (width, height): narrow enough for a tall column beside a video
/// and flat enough for a bar below it. The full view's minimum is 900 × 640.
pub(crate) const COMPACT_MIN: (u32, u32) = (240, 150);

/// The wide bar (horizontal layout) has one fixed height in logical px, readable from a distance, and is at
/// least `BAR_MIN_WIDTH` wide so the UI keeps choosing the horizontal layout. The tall column is
/// `COMPACT_MIN.0` to `COLUMN_MAX_WIDTH` wide at any height.
pub(crate) const BAR_HEIGHT: u32 = 195;
pub(crate) const BAR_MIN_WIDTH: u32 = 640;
pub(crate) const COLUMN_MAX_WIDTH: u32 = 320;

/// Minimum and maximum window size of the compact view's two layouts. Which layout is shown is the rider's
/// choice (the switch button / V key); the window sizes of the two never overlap.
pub(crate) fn bar_sizes(bar: bool) -> (LogicalSize<f64>, LogicalSize<f64>) {
    let size = |w: u32, h: f64| LogicalSize::new(f64::from(w), h);
    if bar {
        (size(BAR_MIN_WIDTH, f64::from(BAR_HEIGHT)), size(10_000, f64::from(BAR_HEIGHT)))
    } else {
        (size(COMPACT_MIN.0, f64::from(COMPACT_MIN.1)), size(COLUMN_MAX_WIDTH, 10_000.0))
    }
}

const RESIZE_ERROR: &str = "Cannot resize the window. Please try again.";
const LEAVE_ERROR: &str = "Cannot restore the window size. Please resize the window by hand.";

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bounds {
    size: PhysicalSize<u32>,
    position: Option<PhysicalPosition<i32>>,
    maximized: bool,
    fullscreen: bool,
}

impl Bounds {
    /// Persisted form: only the compact window's size and (where the OS reports it) position.
    pub(crate) fn to_json(self) -> Value {
        json!({
            "width": self.size.width,
            "height": self.size.height,
            "x": self.position.map(|p| p.x),
            "y": self.position.map(|p| p.y),
        })
    }

    /// Remembered compact geometry; nonsense (a missing, tiny or absurd size) is ignored rather
    /// than taken as a window size, so a damaged entry falls back to the default bar.
    pub(crate) fn from_json(v: &Value) -> Option<Self> {
        let width = u32::try_from(v["width"].as_u64()?).ok().filter(|w| (200..=20_000).contains(w))?;
        let height = u32::try_from(v["height"].as_u64()?).ok().filter(|h| (120..=20_000).contains(h))?;
        let position = match (v["x"].as_i64(), v["y"].as_i64()) {
            (Some(x), Some(y)) => Some(PhysicalPosition::new(i32::try_from(x).ok()?, i32::try_from(y).ok()?)),
            _ => None,
        };
        Some(Self { size: PhysicalSize::new(width, height), position, maximized: false, fullscreen: false })
    }
}

/// Is enough of the window on one of the monitors? A remembered position from a since-disconnected
/// screen would otherwise put the compact window where the rider can't see or drag it.
fn visible_on_screen(position: PhysicalPosition<i32>, monitors: &[(PhysicalPosition<i32>, PhysicalSize<u32>)]) -> bool {
    monitors.iter().any(|(corner, size)| {
        let left = position.x.max(corner.x);
        let top = position.y.max(corner.y);
        let right = (position.x + 160).min(corner.x + size.width as i32);
        let bottom = (position.y + 80).min(corner.y + size.height as i32);
        right - left >= 80 && bottom - top >= 40
    })
}

trait WindowOps {
    fn snapshot(&self) -> Result<Bounds, String>;
    /// Apply `compact` (or the full view) with `geometry`: the remembered compact bounds, the full
    /// snapshot to restore, or None for a fresh compact bar / full window.
    fn apply(&self, compact: bool, geometry: Option<&Bounds>) -> Result<(), String>;
    /// Only the normal 900 × 640 minimum: the last resort when the full geometry can't be restored.
    fn reset_minimum(&self) -> Result<(), String>;
}

impl WindowOps for WebviewWindow {
    fn snapshot(&self) -> Result<Bounds, String> {
        let read = || -> tauri::Result<Bounds> {
            Ok(Bounds {
                size: self.inner_size()?,
                // Some compositors cannot report or move windows; resizing must still work.
                position: self.outer_position().ok(),
                maximized: self.is_maximized()?,
                fullscreen: self.is_fullscreen()?,
            })
        };
        read().map_err(|_| RESIZE_ERROR.to_string())
    }

    fn apply(&self, compact: bool, geometry: Option<&Bounds>) -> Result<(), String> {
        let resize = || -> tauri::Result<()> {
            self.unmaximize()?;
            let (width, height) = if compact {
                (f64::from(COMPACT_MIN.0), f64::from(COMPACT_MIN.1))
            } else {
                (900.0, 640.0)
            };
            self.set_max_size(None::<LogicalSize<f64>>)?; // the wide bar's height limit is set again by the UI
            self.set_min_size(Some(LogicalSize::new(width, height)))?;
            match geometry {
                Some(saved) => {
                    self.set_size(saved.size)?;
                    if let Some(position) = saved.position {
                        let _ = self.set_position(position);
                    }
                    // A compact window is never maximized, whatever the remembered bounds say.
                    if !compact && saved.maximized {
                        self.maximize()?;
                    }
                }
                None if compact => self.set_size(LogicalSize::new(960.0, f64::from(BAR_HEIGHT)))?,
                None => self.set_size(LogicalSize::new(900.0, 640.0))?,
            }
            Ok(())
        };
        resize().map_err(|_| RESIZE_ERROR.to_string())
    }

    fn reset_minimum(&self) -> Result<(), String> {
        // the compact layouts' maximum size goes too, or the full view would stay capped at 320 px wide
        self.set_max_size(None::<LogicalSize<f64>>).map_err(|_| RESIZE_ERROR.to_string())?;
        self.set_min_size(Some(LogicalSize::new(900.0, 640.0)))
            .map_err(|_| RESIZE_ERROR.to_string())
    }
}

#[derive(Default)]
struct WindowState {
    saved: Option<Bounds>,
}

impl WindowState {
    /// `target`: the remembered compact geometry (None: the default 960 × 200 bar). Returns the compact
    /// geometry the rider actually used when leaving it, so the caller can remember it.
    fn set(&mut self, window: &impl WindowOps, compact: bool, target: Option<&Bounds>) -> Result<Option<Bounds>, String> {
        if compact == self.saved.is_some() {
            return Ok(None);
        }
        let current = window.snapshot()?;
        if current.fullscreen {
            return Err("Leave full screen before switching the ride view.".into());
        }
        if compact {
            if let Err(error) = window.apply(true, target) {
                // Roll back partial changes (including the minimum size).
                let _ = window.apply(false, Some(&current));
                return Err(error);
            }
            self.saved = Some(current);
            Ok(None)
        } else {
            if let Err(error) = window.apply(false, self.saved.as_ref()) {
                // Roll back to the compact geometry the rider was just using; keep the original
                // full snapshot so a retry still restores it.
                let _ = window.apply(true, Some(&current));
                return Err(error);
            }
            self.saved = None;
            Ok(Some(current))
        }
    }

    /// Leaving the ride: restore the full view like `set(false)`, retrying once. If both tries fail,
    /// the ride screen closes anyway, so give up the geometry but never keep the lowered compact
    /// minimum or a stale snapshot: the window stays resizable and the next compact entry starts fresh.
    fn leave(&mut self, window: &impl WindowOps) -> Result<Option<Bounds>, String> {
        if self.saved.is_none() {
            return Ok(None);
        }
        for _ in 0..2 {
            if let Ok(used) = self.set(window, false, None) {
                return Ok(used);
            }
        }
        let _ = window.reset_minimum();
        self.saved = None;
        Err(LEAVE_ERROR.into())
    }
}

#[derive(Default)]
pub struct Pending(Mutex<WindowState>);

impl Pending {
    /// `target`: remembered compact geometry from state.json. `leave`: the ride screen is closing (see
    /// `WindowState::leave`); only used with `compact == false`. Returns the compact geometry to remember.
    pub fn set(&self, window: &WebviewWindow, compact: bool, leave: bool, target: Option<Bounds>) -> Result<Option<Bounds>, String> {
        if window.label() != "main" {
            return Err("Compact view is only available in the main window.".into());
        }
        let mut state = self.0.lock().map_err(|_| RESIZE_ERROR.to_string())?;
        if leave && !compact {
            state.leave(window)
        } else {
            let target = target.map(|b| match b.position {
                Some(position) => {
                    let visible = match window.available_monitors() {
                        Ok(monitors) => {
                            let list: Vec<_> = monitors.iter().map(|m| (*m.position(), *m.size())).collect();
                            visible_on_screen(position, &list)
                        }
                        Err(_) => true, // can't tell: keep the remembered position
                    };
                    if visible {
                        b
                    } else {
                        Bounds { position: None, ..b }
                    }
                }
                None => b,
            });
            state.set(window, compact, target.as_ref())
        }
    }

    /// The compact geometry in use, for the window-close path (persist without toggling back to the
    /// full view). None when the window isn't in the compact presentation.
    pub fn compact_geometry(&self, window: &WebviewWindow) -> Option<Bounds> {
        let state = self.0.lock().ok()?;
        if state.saved.is_some() {
            window.snapshot().ok()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tauri::{PhysicalPosition, PhysicalSize};

    fn original() -> Bounds {
        Bounds {
            size: PhysicalSize::new(2720, 1760),
            position: Some(PhysicalPosition::new(-1200, 84)),
            maximized: false,
            fullscreen: false,
        }
    }

    struct FakeWindow {
        bounds: RefCell<Bounds>,
        minimum: RefCell<(u32, u32)>,
        fail: RefCell<Option<bool>>,
        // number of full-view restores (apply(false, …)) that fail before one succeeds
        fail_exits: RefCell<u32>,
        calls: RefCell<Vec<bool>>,
    }

    impl FakeWindow {
        fn new(bounds: Bounds) -> Self {
            Self {
                bounds: RefCell::new(bounds),
                minimum: RefCell::new((900, 640)),
                fail: RefCell::new(None),
                fail_exits: RefCell::new(0),
                calls: RefCell::new(vec![]),
            }
        }
    }

    // Only the OS boundary is simulated; WindowState owns the real transactional lifecycle.
    impl WindowOps for FakeWindow {
        fn snapshot(&self) -> Result<Bounds, String> {
            Ok(*self.bounds.borrow())
        }
        fn apply(&self, compact: bool, geometry: Option<&Bounds>) -> Result<(), String> {
            self.calls.borrow_mut().push(compact);
            *self.minimum.borrow_mut() = if compact { COMPACT_MIN } else { (900, 640) };
            if self.fail.borrow_mut().take() == Some(compact) {
                return Err("resize failed".into());
            }
            let mut exits = self.fail_exits.borrow_mut();
            if !compact && *exits > 0 {
                *exits -= 1;
                return Err("resize failed".into());
            }
            let mut bounds = self.bounds.borrow_mut();
            if let Some(saved) = geometry {
                *bounds = *saved;
            } else {
                bounds.size = PhysicalSize::new(960, 200);
                bounds.maximized = false;
            }
            Ok(())
        }
        fn reset_minimum(&self) -> Result<(), String> {
            *self.minimum.borrow_mut() = (900, 640);
            Ok(())
        }
    }

    fn compact_bounds() -> Bounds {
        Bounds {
            size: PhysicalSize::new(640, 1040),
            position: Some(PhysicalPosition::new(400, 20)),
            ..original()
        }
    }

    #[test]
    fn leaving_retries_a_failed_restore_once() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        *window.bounds.borrow_mut() = compact_bounds();
        *window.fail_exits.borrow_mut() = 1;
        state.leave(&window).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.minimum.borrow(), (900, 640));
        assert!(state.saved.is_none());
    }

    #[test]
    fn compact_minimum_is_240_by_150() {
        assert_eq!(COMPACT_MIN, (240, 150));
    }

    #[test]
    fn the_bar_is_195_px_high_and_the_column_240_to_320_px_wide() {
        let (min, max) = bar_sizes(true);
        assert_eq!((min.width, min.height), (640.0, 195.0));
        assert_eq!((max.width, max.height), (10_000.0, 195.0));
        let (min, max) = bar_sizes(false);
        assert_eq!((min.width, min.height), (240.0, 150.0));
        assert_eq!((max.width, max.height), (320.0, 10_000.0));
    }

    #[test]
    fn leaving_after_two_failed_restores_resets_the_minimum_and_forgets_the_snapshot() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        *window.bounds.borrow_mut() = compact_bounds();
        *window.fail_exits.borrow_mut() = 2;
        assert!(state.leave(&window).is_err());
        assert_eq!(*window.bounds.borrow(), compact_bounds());
        assert_eq!(*window.minimum.borrow(), (900, 640));
        assert!(state.saved.is_none());
        // the next ride's compact toggle snapshots the current window and works normally
        state.set(&window, true, None).unwrap();
        assert_eq!(*window.minimum.borrow(), COMPACT_MIN);
        state.set(&window, false, None).unwrap();
        assert_eq!(*window.bounds.borrow(), compact_bounds());
        assert_eq!(*window.minimum.borrow(), (900, 640));
    }

    #[test]
    fn leaving_the_full_view_touches_nothing() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.leave(&window).unwrap();
        assert!(window.calls.borrow().is_empty());
    }

    #[test]
    fn entry_and_exit_restore_physical_geometry() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        assert_eq!(*window.minimum.borrow(), COMPACT_MIN);
        window.bounds.borrow_mut().size = PhysicalSize::new(640, 1040);
        window.bounds.borrow_mut().position = Some(PhysicalPosition::new(300, 200));
        state.set(&window, false, None).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.minimum.borrow(), (900, 640));
    }

    #[test]
    fn repeated_entry_preserves_the_first_snapshot() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, false, None).unwrap();
        state.set(&window, true, None).unwrap();
        window.bounds.borrow_mut().size = PhysicalSize::new(640, 1040);
        state.set(&window, true, None).unwrap();
        state.set(&window, false, None).unwrap();
        state.set(&window, false, None).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.calls.borrow(), [true, false]);
    }

    #[test]
    fn maximization_is_restored() {
        let saved = Bounds {
            maximized: true,
            ..original()
        };
        let window = FakeWindow::new(saved);
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        assert!(!window.bounds.borrow().maximized);
        state.set(&window, false, None).unwrap();
        assert_eq!(*window.bounds.borrow(), saved);
    }

    #[test]
    fn failed_entry_restores_constraints_and_can_be_retried() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        *window.fail.borrow_mut() = Some(true);
        assert!(state.set(&window, true, None).is_err());
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.minimum.borrow(), (900, 640));
        assert!(state.saved.is_none());
        state.set(&window, true, None).unwrap();
        state.set(&window, false, None).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
    }

    #[test]
    fn failed_exit_preserves_compact_geometry_and_the_saved_full_view() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        let compact = compact_bounds();
        *window.bounds.borrow_mut() = compact;
        *window.fail.borrow_mut() = Some(false);
        assert!(state.set(&window, false, None).is_err());
        assert_eq!(*window.bounds.borrow(), compact);
        assert_eq!(*window.minimum.borrow(), COMPACT_MIN);
        assert_eq!(state.saved, Some(original()));
        state.set(&window, false, None).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
    }

    #[test]
    fn unavailable_window_position_does_not_block_compact_view() {
        let saved = Bounds {
            position: None,
            ..original()
        };
        let window = FakeWindow::new(saved);
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        assert_eq!(*window.minimum.borrow(), COMPACT_MIN);
        state.set(&window, false, None).unwrap();
        assert_eq!(window.bounds.borrow().size, saved.size);
        assert_eq!(*window.minimum.borrow(), (900, 640));
    }

    #[test]
    fn fullscreen_entry_is_rejected_without_changing_the_window() {
        let saved = Bounds {
            fullscreen: true,
            ..original()
        };
        let window = FakeWindow::new(saved);
        let mut state = WindowState::default();
        assert!(state
            .set(&window, true, None)
            .unwrap_err()
            .contains("full screen"));
        assert_eq!(*window.bounds.borrow(), saved);
        assert!(window.calls.borrow().is_empty());
        assert!(state.saved.is_none());
    }
    #[test]
    fn remembered_compact_geometry_is_restored_and_handed_back() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        let remembered = compact_bounds();
        state.set(&window, true, Some(&remembered)).unwrap();
        assert_eq!(*window.bounds.borrow(), remembered);
        // the rider resizes and moves it; leaving hands that geometry back for persistence
        let used = Bounds {
            size: PhysicalSize::new(800, 300),
            position: Some(PhysicalPosition::new(40, 60)),
            ..remembered
        };
        *window.bounds.borrow_mut() = used;
        assert_eq!(state.set(&window, false, None).unwrap(), Some(used));
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.minimum.borrow(), (900, 640));
    }

    #[test]
    fn leaving_the_compact_view_reports_its_geometry() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true, None).unwrap();
        *window.bounds.borrow_mut() = compact_bounds();
        assert_eq!(state.leave(&window).unwrap(), Some(compact_bounds()));
        assert_eq!(*window.bounds.borrow(), original());
    }

    #[test]
    fn compact_geometry_round_trips_through_json() {
        let bounds = compact_bounds();
        assert_eq!(Bounds::from_json(&bounds.to_json()), Some(bounds));
        let no_position = Bounds { position: None, ..bounds };
        assert_eq!(Bounds::from_json(&no_position.to_json()), Some(no_position));
        // a compact window is never restored maximized
        let value = json!({ "width": 640, "height": 320, "x": 5, "y": 6, "maximized": true });
        assert!(!Bounds::from_json(&value).unwrap().maximized);
    }

    #[test]
    fn damaged_compact_geometry_falls_back_to_the_default_bar() {
        for value in [json!({}), json!({ "width": 10, "height": 200 }), json!({ "width": 640, "height": 0 }), json!("compact")] {
            assert_eq!(Bounds::from_json(&value), None, "{value}");
        }
    }

    #[test]
    fn remembered_position_must_be_on_a_connected_screen() {
        let monitors = [
            (PhysicalPosition::new(0, 0), PhysicalSize::new(1920, 1080)),
            (PhysicalPosition::new(1920, 0), PhysicalSize::new(1280, 720)),
        ];
        assert!(visible_on_screen(PhysicalPosition::new(100, 100), &monitors));
        assert!(visible_on_screen(PhysicalPosition::new(3100, 600), &monitors));
        assert!(!visible_on_screen(PhysicalPosition::new(-300, 100), &monitors));
        assert!(!visible_on_screen(PhysicalPosition::new(0, 2000), &monitors));
        // barely peeking in (less than 80 × 40) counts as off-screen
        assert!(!visible_on_screen(PhysicalPosition::new(1880, -100), &monitors));
    }

}

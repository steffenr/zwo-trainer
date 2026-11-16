// Machine-local geometry for the optional compact presentation of the main ride window.
// Physical snapshots preserve position/size across monitors; requested sizes are logical.
use std::sync::Mutex;
use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};

const RESIZE_ERROR: &str = "Cannot resize the window. Please try again.";

#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    size: PhysicalSize<u32>,
    position: Option<PhysicalPosition<i32>>,
    maximized: bool,
    fullscreen: bool,
}

trait WindowOps {
    fn snapshot(&self) -> Result<Bounds, String>;
    fn apply(&self, compact: bool, restore: Option<&Bounds>) -> Result<(), String>;
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

    fn apply(&self, compact: bool, restore: Option<&Bounds>) -> Result<(), String> {
        let resize = || -> tauri::Result<()> {
            self.unmaximize()?;
            let (width, height) = if compact {
                (320.0, 200.0)
            } else {
                (900.0, 640.0)
            };
            self.set_min_size(Some(LogicalSize::new(width, height)))?;
            if let Some(saved) = restore {
                self.set_size(saved.size)?;
                if let Some(position) = saved.position {
                    let _ = self.set_position(position);
                }
                if saved.maximized {
                    self.maximize()?;
                }
            } else {
                self.set_size(LogicalSize::new(960.0, 200.0))?;
            }
            Ok(())
        };
        resize().map_err(|_| RESIZE_ERROR.to_string())
    }
}

#[derive(Default)]
struct WindowState {
    saved: Option<Bounds>,
}

impl WindowState {
    fn set(&mut self, window: &impl WindowOps, compact: bool) -> Result<(), String> {
        if compact == self.saved.is_some() {
            return Ok(());
        }
        let current = window.snapshot()?;
        if current.fullscreen {
            return Err("Leave full screen before switching the ride view.".into());
        }
        let restore = if compact { None } else { self.saved.as_ref() };
        if let Err(error) = window.apply(compact, restore) {
            // Roll back partial changes (including the minimum size); keep the original
            // snapshot on failed exit so the rider can retry without losing the full view.
            let _ = window.apply(!compact, Some(&current));
            return Err(error);
        }
        self.saved = if compact { Some(current) } else { None };
        Ok(())
    }
}

#[derive(Default)]
pub struct Pending(Mutex<WindowState>);

impl Pending {
    pub fn set(&self, window: &WebviewWindow, compact: bool) -> Result<(), String> {
        if window.label() != "main" {
            return Err("Compact view is only available in the main window.".into());
        }
        self.0
            .lock()
            .map_err(|_| RESIZE_ERROR.to_string())?
            .set(window, compact)
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
        calls: RefCell<Vec<bool>>,
    }

    impl FakeWindow {
        fn new(bounds: Bounds) -> Self {
            Self {
                bounds: RefCell::new(bounds),
                minimum: RefCell::new((900, 640)),
                fail: RefCell::new(None),
                calls: RefCell::new(vec![]),
            }
        }
    }

    // Only the OS boundary is simulated; WindowState owns the real transactional lifecycle.
    impl WindowOps for FakeWindow {
        fn snapshot(&self) -> Result<Bounds, String> {
            Ok(*self.bounds.borrow())
        }
        fn apply(&self, compact: bool, restore: Option<&Bounds>) -> Result<(), String> {
            self.calls.borrow_mut().push(compact);
            *self.minimum.borrow_mut() = if compact { (320, 200) } else { (900, 640) };
            if self.fail.borrow_mut().take() == Some(compact) {
                return Err("resize failed".into());
            }
            let mut bounds = self.bounds.borrow_mut();
            if let Some(saved) = restore {
                *bounds = *saved;
            } else {
                bounds.size = PhysicalSize::new(960, 200);
                bounds.maximized = false;
            }
            Ok(())
        }
    }

    #[test]
    fn entry_and_exit_restore_physical_geometry() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true).unwrap();
        assert_eq!(*window.minimum.borrow(), (320, 200));
        window.bounds.borrow_mut().size = PhysicalSize::new(640, 1040);
        window.bounds.borrow_mut().position = Some(PhysicalPosition::new(300, 200));
        state.set(&window, false).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.minimum.borrow(), (900, 640));
    }

    #[test]
    fn repeated_entry_preserves_the_first_snapshot() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, false).unwrap();
        state.set(&window, true).unwrap();
        window.bounds.borrow_mut().size = PhysicalSize::new(640, 1040);
        state.set(&window, true).unwrap();
        state.set(&window, false).unwrap();
        state.set(&window, false).unwrap();
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
        state.set(&window, true).unwrap();
        assert!(!window.bounds.borrow().maximized);
        state.set(&window, false).unwrap();
        assert_eq!(*window.bounds.borrow(), saved);
    }

    #[test]
    fn failed_entry_restores_constraints_and_can_be_retried() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        *window.fail.borrow_mut() = Some(true);
        assert!(state.set(&window, true).is_err());
        assert_eq!(*window.bounds.borrow(), original());
        assert_eq!(*window.minimum.borrow(), (900, 640));
        assert!(state.saved.is_none());
        state.set(&window, true).unwrap();
        state.set(&window, false).unwrap();
        assert_eq!(*window.bounds.borrow(), original());
    }

    #[test]
    fn failed_exit_preserves_compact_geometry_and_the_saved_full_view() {
        let window = FakeWindow::new(original());
        let mut state = WindowState::default();
        state.set(&window, true).unwrap();
        let compact = Bounds {
            size: PhysicalSize::new(640, 1040),
            position: Some(PhysicalPosition::new(400, 20)),
            ..original()
        };
        *window.bounds.borrow_mut() = compact;
        *window.fail.borrow_mut() = Some(false);
        assert!(state.set(&window, false).is_err());
        assert_eq!(*window.bounds.borrow(), compact);
        assert_eq!(*window.minimum.borrow(), (320, 200));
        assert_eq!(state.saved, Some(original()));
        state.set(&window, false).unwrap();
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
        state.set(&window, true).unwrap();
        assert_eq!(*window.minimum.borrow(), (320, 200));
        state.set(&window, false).unwrap();
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
            .set(&window, true)
            .unwrap_err()
            .contains("full screen"));
        assert_eq!(*window.bounds.borrow(), saved);
        assert!(window.calls.borrow().is_empty());
        assert!(state.saved.is_none());
    }
}

//! OpenBikeControl controllers (buttons only) for virtual shifting.
//!
//! OpenBikeControl is an open, MIT-licensed protocol (github.com/OpenBikeControl/openbikecontrol-protocol,
//! PROTOCOL.md + BLE.md), spoken by some controllers directly and by bridge apps such as BikeControl
//! for others (Shimano, SRAM, Wahoo, …). Implemented from the spec:
//!  - advertises service d273f680-d548-419d-b9d1-fa0472345229 (never manufacturer data)
//!  - …f681 button state (notify): [0x01, id, state, id, state, …], only the buttons that changed
//!    (state 0 = released, 1 = pressed, ≥ 2 = analog)
//!  - …f683 app information (write): [0x04, 0x01, len, app id, len, version, count, ids…], sent
//!    once after connecting so the device knows which button ids we act on
//!
//! One physical button may send several ids in one message (e.g. shift up + increase difficulty +
//! select, so every app finds one it knows). All ids a message newly presses count as one press,
//! and exactly one of them is used: shift first, then difficulty, then the workout and navigation
//! buttons. In ERG segments difficulty comes before shift, so the UI gets both picks (`button` and
//! `erg`) and chooses (app.js `onButton`).

use crate::shifter::{B_A, B_DOWN, B_LEFT, B_RIGHT, B_SHIFT_DN, B_SHIFT_UP, B_UP};
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const SVC: Uuid = Uuid::from_u128(0xd273f680_d548_419d_b9d1_fa0472345229);
pub const BUTTON_STATE: Uuid = Uuid::from_u128(0xd273f681_d548_419d_b9d1_fa0472345229);
pub const APP_INFO: Uuid = Uuid::from_u128(0xd273f683_d548_419d_b9d1_fa0472345229);
const MSG_BUTTON_STATE: u8 = 0x01;
const MSG_APP_INFO: u8 = 0x04;
pub const APP_ID: &str = "zwotrainer";

/// OpenBikeControl button id → semantic button (B_* flags, see BUTTON_ACTIONS in app.js).
/// Difficulty ± is ▲ / ▼ (intensity ±1 %), interval skips are ▶ / ◀, select is A (start / pause).
const BUTTONS: [(u8, u32); 11] = [
    (0x01, B_SHIFT_UP),  // Shift Up
    (0x02, B_SHIFT_DN),  // Shift Down
    (0x30, B_UP),        // Increase Difficulty
    (0x31, B_DOWN),      // Decrease Difficulty
    (0x32, B_RIGHT),     // Skip Interval
    (0x36, B_LEFT),      // Previous Interval
    (0x10, B_UP),        // Up
    (0x11, B_DOWN),      // Down
    (0x12, B_LEFT),      // Left
    (0x13, B_RIGHT),     // Right
    (0x14, B_A),         // Select/Confirm
];

/// Which of several ids sent for one press wins, first one first.
const PRIORITY: [u8; 11] = [0x01, 0x02, 0x30, 0x31, 0x32, 0x36, 0x10, 0x11, 0x12, 0x13, 0x14];
/// The same in ERG segments: difficulty before shift.
const PRIORITY_ERG: [u8; 11] = [0x30, 0x31, 0x01, 0x02, 0x32, 0x36, 0x10, 0x11, 0x12, 0x13, 0x14];

fn button(id: u8) -> u32 {
    BUTTONS.iter().find(|(i, _)| *i == id).map(|(_, b)| *b).unwrap_or(0)
}

/// (button id, state) pairs of a button state message; None for any other message.
pub fn button_states(msg: &[u8]) -> Option<Vec<(u8, u8)>> {
    let (&kind, body) = msg.split_first()?;
    if kind != MSG_BUTTON_STATE {
        return None;
    }
    Some(body.chunks_exact(2).map(|p| (p[0], p[1])).collect())
}

/// One press: the button for free-ride segments and the one for ERG segments (B_* flags).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Press {
    pub free: u32,
    pub erg: u32,
}

/// Turns button state messages into presses. A message lists only the changed buttons, so the
/// state of every id is kept to find the ones that are newly pressed.
pub struct Tracker {
    /// When each id was pressed; None = released.
    held: [Option<Instant>; 256],
}

impl Default for Tracker {
    fn default() -> Self {
        Self { held: [None; 256] }
    }
}

/// A button "held" longer than this is assumed to have lost its release message (dropped
/// notification, or a bridge that only sends presses): the next press counts again.
const HOLD_MAX: Duration = Duration::from_secs(2);

impl Tracker {
    pub fn update(&mut self, msg: &[u8]) -> Option<Press> {
        self.update_at(msg, Instant::now())
    }

    fn update_at(&mut self, msg: &[u8], now: Instant) -> Option<Press> {
        let mut pressed = vec![];
        for (id, state) in button_states(msg)? {
            let slot = &mut self.held[id as usize];
            if state != 0 {
                if slot.is_none_or(|at| now.saturating_duration_since(at) > HOLD_MAX) {
                    pressed.push(id);
                    *slot = Some(now);
                }
            } else {
                *slot = None;
            }
        }
        let pick = |order: &[u8]| order.iter().find(|id| pressed.contains(id)).map(|id| button(*id));
        Some(Press { free: pick(&PRIORITY)?, erg: pick(&PRIORITY_ERG)? })
    }
}

/// The App Information message: our app id, version and the button ids we act on.
pub fn app_info(version: &str) -> Vec<u8> {
    let text = |s: &str| -> Vec<u8> { s.bytes().take(32).collect() };
    let (id, ver) = (text(APP_ID), text(version));
    let mut out = vec![MSG_APP_INFO, 0x01, id.len() as u8];
    out.extend(&id);
    out.push(ver.len() as u8);
    out.extend(&ver);
    out.push(PRIORITY.len() as u8);
    out.extend(PRIORITY);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Payloads as produced by examples/python/protocol_parser.py encode_button_state().

    #[test]
    fn single_buttons() {
        let mut t = Tracker::default();
        assert_eq!(t.update(&[0x01, 0x01, 0x01]), Some(Press { free: B_SHIFT_UP, erg: B_SHIFT_UP }));
        assert_eq!(t.update(&[0x01, 0x01, 0x00]), None);
        assert_eq!(t.update(&[0x01, 0x31, 0x01]), Some(Press { free: B_DOWN, erg: B_DOWN }));
        assert_eq!(t.update(&[0x01, 0x31, 0x00]), None);
        assert_eq!(t.update(&[0x01, 0x32, 0x01]), Some(Press { free: B_RIGHT, erg: B_RIGHT }));
        assert_eq!(t.update(&[0x01, 0x14, 0x01]), Some(Press { free: B_A, erg: B_A }));
    }

    #[test]
    fn one_press_with_several_ids() {
        let mut t = Tracker::default();
        // Shift Up + Increase Difficulty + Select: shift in free ride, difficulty in ERG
        assert_eq!(t.update(&[0x01, 0x01, 0x01, 0x30, 0x01, 0x14, 0x01]), Some(Press { free: B_SHIFT_UP, erg: B_UP }));
        assert_eq!(t.update(&[0x01, 0x01, 0x00, 0x30, 0x00, 0x14, 0x00]), None);
        // Shift Down + Decrease Difficulty + Down
        assert_eq!(t.update(&[0x01, 0x02, 0x01, 0x31, 0x01, 0x11, 0x01]), Some(Press { free: B_SHIFT_DN, erg: B_DOWN }));
        assert_eq!(t.update(&[0x01, 0x02, 0x00, 0x31, 0x00, 0x11, 0x00]), None);
        // Increase Difficulty + Up: difficulty before navigation in both
        assert_eq!(t.update(&[0x01, 0x10, 0x01, 0x30, 0x01]), Some(Press { free: B_UP, erg: B_UP }));
        assert_eq!(t.update(&[0x01, 0x10, 0x00, 0x30, 0x00]), None);
        // Skip Interval + Right + Select: the interval skip
        assert_eq!(t.update(&[0x01, 0x14, 0x01, 0x13, 0x01, 0x32, 0x01]), Some(Press { free: B_RIGHT, erg: B_RIGHT }));
    }

    #[test]
    fn held_buttons_dont_repeat() {
        let mut t = Tracker::default();
        assert!(t.update(&[0x01, 0x01, 0x01]).is_some());
        // shift still held, difficulty newly pressed: only the new id counts
        assert_eq!(t.update(&[0x01, 0x01, 0x01, 0x30, 0x01]), Some(Press { free: B_UP, erg: B_UP }));
        // release only
        assert_eq!(t.update(&[0x01, 0x01, 0x00, 0x30, 0x00]), None);
        // pressed again after the release
        assert!(t.update(&[0x01, 0x01, 0x01]).is_some());
    }

    #[test]
    fn lost_release_does_not_block_the_button() {
        let mut t = Tracker::default();
        let t0 = Instant::now();
        assert!(t.update_at(&[0x01, 0x01, 0x01], t0).is_some());
        // no release: a quick repeat is still the same hold
        assert!(t.update_at(&[0x01, 0x01, 0x01], t0 + Duration::from_millis(500)).is_none());
        // after HOLD_MAX the press counts again
        assert!(t.update_at(&[0x01, 0x01, 0x01], t0 + HOLD_MAX + Duration::from_millis(1)).is_some());
    }

    #[test]
    fn ignored_messages() {
        let mut t = Tracker::default();
        assert_eq!(t.update(&[]), None);
        assert_eq!(t.update(&[0x02, 0x01, 0x01]), None); // device status (TCP only)
        assert_eq!(t.update(&[0x01, 0x20, 0x01]), None); // Emote: not used
        assert_eq!(t.update(&[0x01, 0x1B, 0x94]), None); // steering angle (analog)
        assert_eq!(t.update(&[0x01, 0x01]), None); // truncated pair
        assert_eq!(button_states(&[0x01, 0x01, 0x01, 0x02]), Some(vec![(0x01, 0x01)]));
    }

    #[test]
    fn app_information() {
        let msg = app_info("1.3.1");
        let mut want = vec![0x04, 0x01, 10];
        want.extend(b"zwotrainer");
        want.push(5);
        want.extend(b"1.3.1");
        want.push(11);
        want.extend([0x01, 0x02, 0x30, 0x31, 0x32, 0x36, 0x10, 0x11, 0x12, 0x13, 0x14]);
        assert_eq!(msg, want);
        // every id we announce is mapped
        assert!(PRIORITY.iter().chain(PRIORITY_ERG.iter()).all(|id| button(*id) != 0));
    }
}

//! Battery level of connected Bluetooth devices (standard Battery Service 0x180F, level 0x2A19).
//!
//! Event emitted to the UI: "battery" { kind: "trainer"|"hr"|"controller", id, level }  (level 0..=100)
//! Devices without the service (many trainers) simply never emit it.

use btleplug::api::{bleuuid::uuid_from_u16, CharPropFlags, Peripheral as _};
use btleplug::platform::Peripheral;
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const BATTERY_LEVEL: Uuid = uuid_from_u16(0x2a19);
/// Battery levels change slowly; one read every two minutes is plenty and costs the device next to nothing.
const POLL: Duration = Duration::from_secs(120);
/// Give up after this many failed reads in a row (the device is gone; a reconnect starts a new watcher).
const MAX_FAILS: u32 = 3;

/// Battery Level characteristic value: one byte, 0..=100.
pub fn parse(v: &[u8]) -> Option<u8> {
    v.first().copied().filter(|b| *b <= 100)
}

/// A running battery watcher. Dropping it stops the polling, so it can live inside a device's `Conn`.
pub struct Watch(tokio::task::JoinHandle<()>);

impl Drop for Watch {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Start reading the battery level of `periph`. `None` when the device has no readable battery characteristic.
pub fn watch(app: AppHandle, periph: Peripheral, kind: &'static str, id: String) -> Option<Watch> {
    let ch = periph.characteristics().into_iter().find(|c| c.uuid == BATTERY_LEVEL && c.properties.contains(CharPropFlags::READ))?;
    Some(Watch(tokio::spawn(async move {
        let mut last: Option<u8> = None;
        let mut fails = 0;
        loop {
            match periph.read(&ch).await {
                Ok(v) => {
                    fails = 0;
                    if let Some(level) = parse(&v) {
                        if last != Some(level) {
                            last = Some(level);
                            let _ = app.emit("battery", json!({ "kind": kind, "id": id, "level": level }));
                        }
                    }
                }
                Err(_) => {
                    fails += 1;
                    if fails >= MAX_FAILS {
                        return;
                    }
                }
            }
            tokio::time::sleep(POLL).await;
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_is_the_first_byte() {
        assert_eq!(parse(&[87]), Some(87));
        assert_eq!(parse(&[0]), Some(0));
        assert_eq!(parse(&[100, 1, 2]), Some(100));
    }

    #[test]
    fn invalid_levels_are_ignored() {
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&[101]), None);
        assert_eq!(parse(&[255]), None);
    }
}

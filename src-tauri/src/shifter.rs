//! Zwift Ride / Zwift Click / Zwift Play controllers for virtual shifting.
//!
//! Based on the publicly reverse-engineered Zwift controller BLE protocol (as used by
//! open-source tools such as BikeControl / qdomyos-zwift):
//!  - advertises manufacturer data with Zwift's company id 0x094A; byte 0 = device type
//!    (0x09 Click, 0x02/0x03 Play right/left, 0x07/0x08 Ride right/left, 0x0A/0x0B Click v2)
//!  - custom service 00000001-19ca-4651-86e5-fa29dcdd09d1:
//!    …0002 async notify (button events) · …0003 sync RX (write) · …0004 sync TX (indicate)
//!  - handshake: write "RideOn" to sync RX → unencrypted button notifications
//!  - notification = 1 type byte + protobuf:
//!    0x37 Click   {1: plus, 2: minus}               (0 = pressed, 1 = released)
//!    0x07 Play    {1: side (0 right/1 left), …, 6: shift paddle}
//!    0x23 Ride    {1: button bitmap}                (bit cleared = pressed)
//!
//! Only the LEFT Zwift Ride controller needs a connection — it relays the right one.
//!
//! Events emitted to the UI:  "button" { button, device } on every press (rising edge; button
//! is one of shiftUp shiftDown up down left right a b y z powerup onoff), "ctrl-raw" { device,
//! hex } for the button tester, and "device-status" { kind: "controller", connected, name, … }.

use btleplug::api::{Central, CharPropFlags, Characteristic, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::Peripheral;
use futures::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ble::{Ble, Found};

pub const ZWIFT_COMPANY: u16 = 0x094A;
const SVC: Uuid = Uuid::from_u128(0x00000001_19ca_4651_86e5_fa29dcdd09d1);
/// Zwift Ride advertises the 16-bit service 0xFC82 instead (same characteristics).
const SVC_RIDE: Uuid = Uuid::from_u128(0x0000fc82_0000_1000_8000_00805f9b34fb);
const ASYNC: Uuid = Uuid::from_u128(0x00000002_19ca_4651_86e5_fa29dcdd09d1);
const SYNC_RX: Uuid = Uuid::from_u128(0x00000003_19ca_4651_86e5_fa29dcdd09d1);
const SYNC_TX: Uuid = Uuid::from_u128(0x00000004_19ca_4651_86e5_fa29dcdd09d1);
const RIDE_ON: &[u8] = b"RideOn";

// Zwift Ride button bitmap (bit cleared = pressed), per makinolo.com "Zwift Ride protocol"
const RIDE_LEFT: u32 = 0x1;
const RIDE_UP: u32 = 0x2;
const RIDE_RIGHT: u32 = 0x4;
const RIDE_DOWN: u32 = 0x8;
const RIDE_A: u32 = 0x10;
const RIDE_B: u32 = 0x20;
const RIDE_Y: u32 = 0x40;
const RIDE_Z: u32 = 0x100;
const RIDE_SHIFT_UP_L: u32 = 0x0200;
const RIDE_SHIFT_DN_L: u32 = 0x0400;
const RIDE_POWERUP_L: u32 = 0x0800;
const RIDE_ONOFF_L: u32 = 0x1000;
const RIDE_SHIFT_UP_R: u32 = 0x2000;
const RIDE_SHIFT_DN_R: u32 = 0x4000;
const RIDE_POWERUP_R: u32 = 0x10000;
const RIDE_ONOFF_R: u32 = 0x20000;

/// Semantic buttons (bit flags) shared by all controller types.
pub const B_SHIFT_UP: u32 = 1;
pub const B_SHIFT_DN: u32 = 1 << 1;
pub const B_UP: u32 = 1 << 2;
pub const B_DOWN: u32 = 1 << 3;
pub const B_LEFT: u32 = 1 << 4;
pub const B_RIGHT: u32 = 1 << 5;
pub const B_A: u32 = 1 << 6;
pub const B_B: u32 = 1 << 7;
pub const B_Y: u32 = 1 << 8;
pub const B_Z: u32 = 1 << 9;
pub const B_POWERUP: u32 = 1 << 10;
pub const B_ONOFF: u32 = 1 << 11;
pub const BUTTON_NAMES: [(u32, &str); 12] = [
    (B_SHIFT_UP, "shiftUp"), (B_SHIFT_DN, "shiftDown"), (B_UP, "up"), (B_DOWN, "down"),
    (B_LEFT, "left"), (B_RIGHT, "right"), (B_A, "a"), (B_B, "b"), (B_Y, "y"), (B_Z, "z"),
    (B_POWERUP, "powerup"), (B_ONOFF, "onoff"),
];

pub fn device_name(type_byte: Option<u8>, fallback: &str) -> String {
    match type_byte {
        Some(0x09) => "Zwift Click".into(),
        Some(0x0A) | Some(0x0B) => "Zwift Click v2".into(),
        Some(0x02) => "Zwift Play (R)".into(),
        Some(0x03) => "Zwift Play (L)".into(),
        Some(0x07) => "Zwift Ride (R)".into(),
        Some(0x08) => "Zwift Ride (L)".into(),
        _ => fallback.into(),
    }
}

/// Minimal protobuf reader: (field number, varint value) pairs; other wire types skipped.
pub fn proto_varints(b: &[u8]) -> Vec<(u32, u64)> {
    let mut out = vec![];
    let mut i = 0;
    let varint = |i: &mut usize| -> Option<u64> {
        let mut v = 0u64;
        let mut shift = 0;
        while *i < b.len() {
            let byte = b[*i];
            *i += 1;
            v |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 {
                return Some(v);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
        None
    };
    while i < b.len() {
        let Some(key) = varint(&mut i) else { break };
        let (field, wire) = ((key >> 3) as u32, key & 7);
        match wire {
            0 => match varint(&mut i) {
                Some(v) => out.push((field, v)),
                None => break,
            },
            1 => i += 8,
            2 => match varint(&mut i) {
                Some(len) => i += len as usize,
                None => break,
            },
            5 => i += 4,
            _ => break,
        }
    }
    out
}

/// Pressed buttons (B_* flags) in one notification; None for non-button messages.
pub fn decode(msg: &[u8]) -> Option<u32> {
    let (&kind, body) = msg.split_first()?;
    let f = proto_varints(body);
    let get = |n: u32| f.iter().find(|(k, _)| *k == n).map(|(_, v)| *v);
    let on = |cond: bool, flag: u32| if cond { flag } else { 0 };
    match kind {
        // Click: {1: plus, 2: minus}, 0 = pressed
        0x37 => Some(on(get(1) == Some(0), B_SHIFT_UP) | on(get(2) == Some(0), B_SHIFT_DN)),
        // Play: {1: pad (0 right, 1 left), 2: Y/up, 3: Z/left, 4: A/right, 5: B/down, 6: shift, 7: on}
        0x07 => {
            let right = get(1).unwrap_or(0) == 0;
            let p = |n: u32| get(n) == Some(0);
            Some(if right {
                on(p(2), B_Y) | on(p(3), B_Z) | on(p(4), B_A) | on(p(5), B_B) | on(p(6), B_SHIFT_UP) | on(p(7), B_POWERUP)
            } else {
                on(p(2), B_UP) | on(p(3), B_LEFT) | on(p(4), B_RIGHT) | on(p(5), B_DOWN) | on(p(6), B_SHIFT_DN) | on(p(7), B_ONOFF)
            })
        }
        // Ride (and Click v2): {1: button bitmap, bit cleared = pressed}
        0x23 => {
            let map = get(1)? as u32;
            let d = |m: u32| map & m == 0;
            Some(
                on(d(RIDE_SHIFT_UP_L) || d(RIDE_SHIFT_UP_R), B_SHIFT_UP)
                    | on(d(RIDE_SHIFT_DN_L) || d(RIDE_SHIFT_DN_R), B_SHIFT_DN)
                    | on(d(RIDE_UP), B_UP) | on(d(RIDE_DOWN), B_DOWN) | on(d(RIDE_LEFT), B_LEFT) | on(d(RIDE_RIGHT), B_RIGHT)
                    | on(d(RIDE_A), B_A) | on(d(RIDE_B), B_B) | on(d(RIDE_Y), B_Y) | on(d(RIDE_Z), B_Z)
                    | on(d(RIDE_POWERUP_L) || d(RIDE_POWERUP_R), B_POWERUP)
                    | on(d(RIDE_ONOFF_L) || d(RIDE_ONOFF_R), B_ONOFF),
            )
        }
        _ => None,
    }
}

/// Write types to try for the handshake, preferred first.
pub fn handshake_write_types(p: CharPropFlags) -> Vec<WriteType> {
    let (w, wnr) = (p.contains(CharPropFlags::WRITE), p.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE));
    match (w, wnr) {
        (_, true) if !w => vec![WriteType::WithoutResponse],
        (true, false) => vec![WriteType::WithResponse],
        // both advertised: without-response is what the Zwift apps use; keep the other as fallback
        _ => vec![WriteType::WithoutResponse, WriteType::WithResponse],
    }
}

struct Conn {
    periph: Peripheral,
    id: String,
    name: String,
    task: tokio::task::JoinHandle<()>,
}

pub struct Controllers {
    app: AppHandle,
    ble: Arc<Ble>,
    conns: Mutex<Vec<Conn>>,
}

impl Controllers {
    pub fn new(app: AppHandle, ble: Arc<Ble>) -> Arc<Self> {
        Arc::new(Self { app, ble, conns: Mutex::new(vec![]) })
    }

    async fn status(&self) {
        let names: Vec<String> = self.conns.lock().await.iter().map(|c| c.name.clone()).collect();
        let _ = self.app.emit(
            "device-status",
            json!({ "kind": "controller", "connected": !names.is_empty(), "name": names.join(" + "), "count": names.len() }),
        );
    }

    /// Scan for Zwift controllers (they advertise Zwift's manufacturer id; the service UUID is not always advertised).
    pub async fn scan(&self, secs: u64) -> Result<Vec<Found>, String> {
        let adapter = self.ble.adapter().await?;
        adapter.start_scan(ScanFilter::default()).await.map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_secs(secs.clamp(1, 15))).await;
        let _ = adapter.stop_scan().await;
        let connected: Vec<String> = self.conns.lock().await.iter().map(|c| c.id.clone()).collect();
        let mut out = vec![];
        for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
            let Ok(Some(props)) = p.properties().await else { continue };
            let zwift = props.manufacturer_data.get(&ZWIFT_COMPANY);
            if zwift.is_none() && !props.services.contains(&SVC) && !props.services.contains(&SVC_RIDE) {
                continue;
            }
            let id = p.id().to_string();
            if connected.contains(&id) {
                continue;
            }
            let ty = zwift.and_then(|d| d.first().copied());
            if matches!(ty, Some(0x01) | Some(0x05) | Some(0x06)) {
                continue; // Zwift Hub / trainers / other non-controller devices
            }
            let local = props.local_name.or(props.advertisement_name).unwrap_or_else(|| "Zwift controller".into());
            out.push(Found { id, name: device_name(ty, &local), rssi: props.rssi, kind: "controller" });
        }
        out.sort_by_key(|f| -(f.rssi.unwrap_or(-127) as i32));
        Ok(out)
    }

    pub async fn connect(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let adapter = self.ble.adapter().await?;
        let mut periph = adapter.peripherals().await.ok().and_then(|ps| ps.into_iter().find(|p| p.id().to_string() == id));
        if periph.is_none() {
            adapter.start_scan(ScanFilter::default()).await.map_err(|e| e.to_string())?;
            for _ in 0..25 {
                tokio::time::sleep(Duration::from_millis(400)).await;
                periph = adapter.peripherals().await.ok().and_then(|ps| ps.into_iter().find(|p| p.id().to_string() == id));
                if periph.is_some() {
                    break;
                }
            }
            let _ = adapter.stop_scan().await;
        }
        let periph = periph.ok_or("Controller not found — press a button to wake it")?;
        let ty = periph.properties().await.ok().flatten().and_then(|p| {
            let local = p.local_name.clone().or(p.advertisement_name.clone()).unwrap_or_default();
            p.manufacturer_data.get(&ZWIFT_COMPANY).and_then(|d| d.first().copied()).map(|t| (t, local.clone())).or(Some((0, local)))
        });
        let name = ty.as_ref().map(|(t, l)| device_name(Some(*t), if l.is_empty() { "Zwift controller" } else { l })).unwrap_or_else(|| "Zwift controller".into());

        tokio::time::timeout(Duration::from_secs(15), periph.connect()).await.map_err(|_| "Connection timed out")?.map_err(|e| e.to_string())?;
        periph.discover_services().await.map_err(|e| e.to_string())?;
        let chars = periph.characteristics();
        let ch = |u: Uuid| chars.iter().find(|c| c.uuid == u).cloned();
        let async_c: Characteristic = ch(ASYNC).ok_or("Not a Zwift controller (service missing)")?;
        let mut stream = periph.notifications().await.map_err(|e| e.to_string())?;
        periph.subscribe(&async_c).await.map_err(|e| e.to_string())?;
        if let Some(tx) = ch(SYNC_TX) {
            let _ = periph.subscribe(&tx).await;
        }
        // Handshake. The Zwift Ride's sync-RX only accepts write-without-response (a write with
        // response fails on macOS with "Writing is not permitted"), Click/Play accept both, so
        // pick the type from the characteristic's properties and fall back to the other one.
        let rx = chars
            .iter()
            .filter(|c| c.uuid == SYNC_RX)
            .find(|c| c.properties.intersects(CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE))
            .cloned();
        if let Some(rx) = rx {
            let types = handshake_write_types(rx.properties);
            let mut last = String::new();
            let mut ok = false;
            for t in types {
                match periph.write(&rx, RIDE_ON, t).await {
                    Ok(()) => { ok = true; break; }
                    Err(e) => last = e.to_string(),
                }
            }
            if !ok {
                let _ = periph.disconnect().await;
                return Err(format!("Handshake failed: {last} (sync RX properties {:?})", rx.properties));
            }
        }

        let app = self.app.clone();
        let dev = name.clone();
        let me = self.clone();
        let pid = id.to_string();
        let task = tokio::spawn(async move {
            let mut was = 0u32;
            while let Some(n) = stream.next().await {
                if n.uuid == ASYNC || n.uuid == SYNC_TX {
                    let hex: String = n.value.iter().map(|b| format!("{b:02x}")).collect();
                    let _ = app.emit("ctrl-raw", json!({ "device": dev, "hex": hex }));
                }
                if n.uuid != ASYNC {
                    continue;
                }
                if let Some(now) = decode(&n.value) {
                    for (flag, name) in BUTTON_NAMES {
                        if now & flag != 0 && was & flag == 0 {
                            let _ = app.emit("button", json!({ "button": name, "device": dev }));
                        }
                    }
                    was = now;
                }
            }
            // stream ended → device gone
            me.conns.lock().await.retain(|c| c.id != pid);
            me.status().await;
        });
        self.conns.lock().await.push(Conn { periph, id: id.to_string(), name: name.clone(), task });
        self.status().await;
        Ok(json!({ "id": id, "name": name }))
    }

    pub async fn disconnect_all(&self) {
        let conns: Vec<Conn> = self.conns.lock().await.drain(..).collect();
        for c in conns {
            c.task.abort();
            let _ = c.periph.disconnect().await;
        }
        self.status().await;
    }

    pub async fn connected(&self) -> Vec<Value> {
        self.conns.lock().await.iter().map(|c| json!({ "id": c.id, "name": c.name })).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_types() {
        assert_eq!(handshake_write_types(CharPropFlags::WRITE_WITHOUT_RESPONSE), vec![WriteType::WithoutResponse]);
        assert_eq!(handshake_write_types(CharPropFlags::WRITE), vec![WriteType::WithResponse]);
        assert_eq!(handshake_write_types(CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE)[0], WriteType::WithoutResponse);
    }

    #[test]
    fn click_plus_minus() {
        assert_eq!(decode(&[0x37, 0x08, 0x00, 0x10, 0x01]), Some(B_SHIFT_UP));
        assert_eq!(decode(&[0x37, 0x08, 0x01, 0x10, 0x00]), Some(B_SHIFT_DN));
        assert_eq!(decode(&[0x37, 0x08, 0x01, 0x10, 0x01]), Some(0));
    }

    fn ride(v: u32) -> Vec<u8> {
        let mut out = vec![0x23, 0x08];
        let mut v = v as u64;
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 { out.push(b); break; }
            out.push(b | 0x80);
        }
        out
    }

    #[test]
    fn ride_bitmap() {
        assert_eq!(decode(&ride(0xFFFF_FFFF)), Some(0));
        assert_eq!(decode(&ride(!RIDE_SHIFT_UP_R)), Some(B_SHIFT_UP));
        assert_eq!(decode(&ride(!RIDE_SHIFT_DN_L)), Some(B_SHIFT_DN));
        assert_eq!(decode(&ride(!RIDE_LEFT)), Some(B_LEFT));
        assert_eq!(decode(&ride(!(RIDE_A | RIDE_RIGHT))), Some(B_A | B_RIGHT));
        assert_eq!(decode(&ride(!RIDE_POWERUP_R)), Some(B_POWERUP));
    }

    #[test]
    fn play_pads() {
        // right pad, A pressed (field 4 = 0), others released
        assert_eq!(decode(&[0x07, 0x08, 0x00, 0x10, 0x01, 0x18, 0x01, 0x20, 0x00, 0x28, 0x01, 0x30, 0x01]), Some(B_A));
        // left pad, shift paddle pressed
        assert_eq!(decode(&[0x07, 0x08, 0x01, 0x30, 0x00]), Some(B_SHIFT_DN));
        assert_eq!(decode(&[0x07, 0x08, 0x00, 0x30, 0x00]), Some(B_SHIFT_UP));
    }

    #[test]
    fn non_button() {
        assert_eq!(decode(&[0x19, 0x08, 0x64]), None);
        assert_eq!(decode(&[]), None);
    }
}

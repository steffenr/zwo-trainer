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
//! OpenBikeControl controllers (obc.rs) are found and connected here too; the advertised or
//! discovered OpenBikeControl service decides the protocol (see `protocol`).
//!
//! Events emitted to the UI:  "button" { button, device } on every press (rising edge; button
//! is one of shiftUp shiftDown up down left right a b y z powerup onoff), "ctrl-raw" { device,
//! hex } for the button tester, and "device-status" { kind: "controller", connected, name, … }.

use btleplug::api::{Central, CharPropFlags, Characteristic, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::Peripheral;
use crate::ble::Claims;
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ble::{Ble, Found};
use crate::obc;

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

/// Which protocol a controller speaks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    Zwift,
    Obc,
}

/// The protocol from the service UUIDs (advertised or discovered) and whether Zwift's manufacturer
/// data is present. OpenBikeControl wins when both are there (a bridge app may advertise both).
pub fn protocol(services: &[Uuid], zwift_data: bool) -> Option<Protocol> {
    if services.contains(&obc::SVC) {
        Some(Protocol::Obc)
    } else if zwift_data || services.contains(&SVC) || services.contains(&SVC_RIDE) {
        Some(Protocol::Zwift)
    } else {
        None
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
        // lengths come from the device: checked, so a huge one can't wrap `i` back to the start
        let skip = match wire {
            0 => match varint(&mut i) {
                Some(v) => {
                    out.push((field, v));
                    continue;
                }
                None => break,
            },
            1 => 8,
            2 => match varint(&mut i).and_then(|len| usize::try_from(len).ok()) {
                Some(len) => len,
                None => break,
            },
            5 => 4,
            _ => break,
        };
        match i.checked_add(skip) {
            Some(next) => i = next,
            None => break,
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
    /// Battery polling; stops when the controller is dropped.
    _battery: Option<crate::battery::Watch>,
}

pub struct Controllers {
    app: AppHandle,
    ble: Arc<Ble>,
    conns: Mutex<Vec<Conn>>,
    /// Ids with a connect running. A second connect of the same controller (auto-connect retry
    /// next to a manual connect) waits for it instead of opening a second link, which would
    /// fire every press twice.
    pending: Claims,
    /// Ids the rider connected and hasn't disconnected: one that drops is reconnected (`reconnect`).
    wanted: std::sync::Mutex<HashSet<String>>,
    /// Ids with a reconnect running (one per controller).
    reconnecting: Claims,
}

impl Controllers {
    pub fn new(app: AppHandle, ble: Arc<Ble>) -> Arc<Self> {
        Arc::new(Self {
            app,
            ble,
            conns: Mutex::new(vec![]),
            pending: Claims::default(),
            wanted: std::sync::Mutex::new(HashSet::new()),
            reconnecting: Claims::default(),
        })
    }

    fn wanted(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.wanted.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn status(&self) {
        let (names, ids): (Vec<String>, Vec<String>) = self.conns.lock().await.iter().map(|c| (c.name.clone(), c.id.clone())).unzip();
        let reconnecting = names.is_empty() && self.wanted().iter().any(|id| self.reconnecting.contains(id));
        let _ = self.app.emit(
            "device-status",
            json!({ "kind": "controller", "connected": !names.is_empty(), "reconnecting": reconnecting, "name": names.join(" + "), "count": names.len(), "ids": ids }),
        );
    }

    /// Scan for Zwift controllers (they advertise Zwift's manufacturer id; the service UUID is not always advertised)
    /// and OpenBikeControl controllers (they advertise the OpenBikeControl service).
    pub async fn scan(&self, secs: u64) -> Result<Vec<Found>, String> {
        let adapter = self.ble.adapter().await?;
        let _gate = self.ble.scan_gate.lock().await;
        adapter.start_scan(ScanFilter::default()).await.map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_secs(secs.clamp(1, 15))).await;
        let _ = adapter.stop_scan().await;
        let connected: Vec<String> = self.conns.lock().await.iter().map(|c| c.id.clone()).collect();
        let mut out = vec![];
        for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
            let Ok(Some(props)) = p.properties().await else { continue };
            let zwift = props.manufacturer_data.get(&ZWIFT_COMPANY);
            let Some(proto) = protocol(&props.services, zwift.is_some()) else { continue };
            let id = p.id().to_string();
            if connected.contains(&id) {
                continue;
            }
            if proto == Protocol::Obc {
                let name = props.local_name.or(props.advertisement_name).unwrap_or_else(|| "OpenBikeControl controller".into());
                out.push(Found { id, name, rssi: props.rssi, kind: "controller" });
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

    /// The controller `id` as `{ id, name }` if it is connected.
    async fn known(&self, id: &str) -> Option<Value> {
        self.conns.lock().await.iter().find(|c| c.id == id).map(|c| json!({ "id": c.id, "name": c.name }))
    }

    /// Connect `id` and keep it connected: it is reconnected after a dropout until `disconnect_all`.
    pub async fn connect(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let res = self.connect_once(id).await;
        if res.is_ok() {
            self.wanted().insert(id.to_string());
        }
        res
    }

    /// Connect `id` once: an already connected controller is returned as it is, and a connect
    /// that is already running is waited for.
    async fn connect_once(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let mut waited = Duration::ZERO;
        let _claim = loop {
            if let Some(c) = self.known(id).await {
                return Ok(c);
            }
            if let Some(claim) = self.pending.claim(id) {
                break claim;
            }
            if waited > Duration::from_secs(60) {
                return Err("The controller is still connecting".into());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
            waited += Duration::from_millis(250);
        };
        // the other connect may have finished between the two checks
        if let Some(c) = self.known(id).await {
            return Ok(c);
        }
        self.open(id).await
    }

    async fn open(self: &Arc<Self>, id: &str) -> Result<Value, String> {
        let adapter = self.ble.adapter().await?;
        let mut periph = adapter.peripherals().await.ok().and_then(|ps| ps.into_iter().find(|p| p.id().to_string() == id));
        if periph.is_none() {
            let _gate = self.ble.scan_gate.lock().await;
            // another scan may have found it while we waited for the gate
            periph = adapter.peripherals().await.ok().and_then(|ps| ps.into_iter().find(|p| p.id().to_string() == id));
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
        }
        let periph = periph.ok_or("Controller not found — press a button to wake it")?;
        let ty = periph.properties().await.ok().flatten().and_then(|p| {
            let local = p.local_name.clone().or(p.advertisement_name.clone()).unwrap_or_default();
            p.manufacturer_data.get(&ZWIFT_COMPANY).and_then(|d| d.first().copied()).map(|t| (t, local.clone())).or(Some((0, local)))
        });
        let name = ty.as_ref().map(|(t, l)| device_name(Some(*t), if l.is_empty() { "Zwift controller" } else { l })).unwrap_or_else(|| "Zwift controller".into());

        tokio::time::timeout(Duration::from_secs(15), periph.connect()).await.map_err(|_| "Connection timed out")?.map_err(|e| e.to_string())?;
        // don't keep the link open when the setup fails
        let res = self.setup(periph.clone(), id, name).await;
        if res.is_err() {
            let _ = periph.disconnect().await;
        }
        res
    }

    /// Everything after the link is up. On `Err` the caller closes the link.
    async fn setup(self: &Arc<Self>, periph: Peripheral, id: &str, name: String) -> Result<Value, String> {
        periph.discover_services().await.map_err(|e| e.to_string())?;
        let services: Vec<Uuid> = periph.services().iter().map(|s| s.uuid).collect();
        if protocol(&services, false) == Some(Protocol::Obc) {
            return self.connect_obc(periph, id).await;
        }
        self.connect_zwift(periph, id, name).await
    }

    /// Zwift Ride / Click / Play: subscribe, RideOn handshake, emit newly pressed buttons.
    async fn connect_zwift(self: &Arc<Self>, periph: Peripheral, id: &str, name: String) -> Result<Value, String> {
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
                return Err(format!("Handshake failed: {last} (sync RX properties {:?})", rx.properties));
            }
        }

        let app = self.app.clone();
        let dev = name.clone();
        let me = self.clone();
        let pid = id.to_string();
        let mut gone = self.ble.subscribe_dropped();
        let up = crate::ble::link_up(&periph);
        // Held until the Conn is registered (see connect_obc).
        let mut conns = self.conns.lock().await;
        let task = tokio::spawn(async move {
            let mut was = 0u32;
            loop {
                // the stream may never end when the controller is switched off: also watch the adapter
                let n = tokio::select! {
                    n = stream.next() => match n { Some(n) => n, None => break },
                    _ = crate::ble::wait_dropped(&mut gone, &pid, &up) => break,
                };
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
            me.gone(&pid).await;
        });
        let battery = crate::battery::watch(self.app.clone(), periph.clone(), "controller", id.to_string());
        conns.push(Conn { periph, id: id.to_string(), name: name.clone(), task, _battery: battery });
        drop(conns);
        self.status().await;
        Ok(json!({ "id": id, "name": name }))
    }

    /// OpenBikeControl: subscribe to the button state, send our App Information, emit one button per press.
    async fn connect_obc(self: &Arc<Self>, periph: Peripheral, id: &str) -> Result<Value, String> {
        let props = periph.properties().await.ok().flatten();
        let name = props.and_then(|p| p.local_name.or(p.advertisement_name)).unwrap_or_else(|| "OpenBikeControl controller".into());
        let chars = periph.characteristics();
        let ch = |u: Uuid| chars.iter().find(|c| c.uuid == u).cloned();
        let state_c = ch(obc::BUTTON_STATE).ok_or("Not an OpenBikeControl controller (button state missing)")?;
        let mut stream = periph.notifications().await.map_err(|e| e.to_string())?;
        periph.subscribe(&state_c).await.map_err(|e| e.to_string())?;
        // optional for the device: it then assumes we support every button
        if let Some(info) = ch(obc::APP_INFO) {
            let msg = obc::app_info(env!("CARGO_PKG_VERSION"));
            for t in handshake_write_types(info.properties) {
                if periph.write(&info, &msg, t).await.is_ok() {
                    break;
                }
            }
        }

        let app = self.app.clone();
        let dev = name.clone();
        let me = self.clone();
        let pid = id.to_string();
        // Held until the Conn is registered: if the link drops right away, the task's cleanup
        // waits for the lock instead of running on a list that doesn't have the Conn yet.
        let mut gone = self.ble.subscribe_dropped();
        let up = crate::ble::link_up(&periph);
        let mut conns = self.conns.lock().await;
        let task = tokio::spawn(async move {
            let mut tracker = obc::Tracker::default();
            let label = |b: u32| BUTTON_NAMES.iter().find(|(f, _)| *f == b).map(|(_, n)| *n).unwrap_or("");
            loop {
                let n = tokio::select! {
                    n = stream.next() => match n { Some(n) => n, None => break },
                    _ = crate::ble::wait_dropped(&mut gone, &pid, &up) => break,
                };
                if n.uuid != obc::BUTTON_STATE {
                    continue;
                }
                let hex: String = n.value.iter().map(|b| format!("{b:02x}")).collect();
                let _ = app.emit("ctrl-raw", json!({ "device": dev, "hex": hex }));
                if let Some(p) = tracker.update(&n.value) {
                    let _ = app.emit("button", json!({ "button": label(p.free), "erg": label(p.erg), "device": dev }));
                }
            }
            // stream ended → device gone
            me.gone(&pid).await;
        });
        let battery = crate::battery::watch(self.app.clone(), periph.clone(), "controller", id.to_string());
        conns.push(Conn { periph, id: id.to_string(), name: name.clone(), task, _battery: battery });
        drop(conns);
        self.status().await;
        Ok(json!({ "id": id, "name": name }))
    }

    /// The link of `id` ended (switched off, out of range): forget it and, unless the rider
    /// disconnected it, reconnect.
    async fn gone(self: &Arc<Self>, id: &str) {
        self.conns.lock().await.retain(|c| c.id != id);
        if self.wanted().contains(id) {
            tokio::spawn(self.clone().reconnect(id.to_string()));
        }
        self.status().await;
    }

    /// Reconnect a dropped controller, like the trainer: 8 tries over about a minute, stopping
    /// when the rider disconnects. Boxed, because it calls `connect_once`, whose task calls it.
    fn reconnect(self: Arc<Self>, id: String) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move {
            let Some(_claim) = self.reconnecting.claim(&id) else { return };
            self.status().await;
            for attempt in 1..=8u64 {
                tokio::time::sleep(Duration::from_millis(1500 * attempt.min(4))).await;
                if !self.wanted().contains(&id) || self.connect_once(&id).await.is_ok() {
                    break;
                }
            }
            // the rider disconnected while the last try was connecting: don't keep that link
            if !self.wanted().contains(&id) {
                let dropped: Vec<Conn> = {
                    let mut conns = self.conns.lock().await;
                    let (gone, keep) = conns.drain(..).partition(|c| c.id == id);
                    *conns = keep;
                    gone
                };
                for c in dropped {
                    c.task.abort();
                    let _ = c.periph.disconnect().await;
                }
            }
            drop(_claim);
            self.status().await;
        })
    }

    pub async fn disconnect_all(&self) {
        // first, so a reconnect stops and a dropping link isn't reconnected
        self.wanted().clear();
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
    fn protocol_detection() {
        assert_eq!(protocol(&[obc::SVC], false), Some(Protocol::Obc));
        assert_eq!(protocol(&[SVC, obc::SVC], true), Some(Protocol::Obc));
        assert_eq!(protocol(&[], true), Some(Protocol::Zwift));
        assert_eq!(protocol(&[SVC_RIDE], false), Some(Protocol::Zwift));
        assert_eq!(protocol(&[SVC], false), Some(Protocol::Zwift));
        assert_eq!(protocol(&[Uuid::from_u128(0x00001826_0000_1000_8000_00805f9b34fb)], false), None);
    }

    #[test]
    fn non_button() {
        assert_eq!(decode(&[0x19, 0x08, 0x64]), None);
        assert_eq!(decode(&[]), None);
    }

    #[test]
    fn malformed_messages_terminate() {
        // length-delimited field whose length wraps the index back to 0 (used to spin forever)
        let mut wrap = vec![0x0a, 0xF5];
        wrap.extend([0xFF; 8]);
        wrap.push(0x01);
        assert_eq!(proto_varints(&wrap), vec![]);
        let mut msg = vec![0x23];
        msg.extend(&wrap);
        assert_eq!(decode(&msg), None);
        // maximal length, then a valid field that must not be read
        let mut max = vec![0x0a];
        max.extend([0xFF; 9]);
        max.extend([0x01, 0x08, 0x00]);
        assert_eq!(proto_varints(&max), vec![]);
        // truncated inputs: varint without end, fixed64 / fixed32 / bytes past the end
        assert_eq!(proto_varints(&[0x08, 0x80]), vec![]);
        assert_eq!(proto_varints(&[0x08, 0x01, 0x09, 0x01]), vec![(1, 1)]);
        assert_eq!(proto_varints(&[0x0d, 0x01, 0x10, 0x02]), vec![]);
        assert_eq!(proto_varints(&[0x0a, 0x05, 0x01]), vec![]);
        // over-long varint (more than 64 bits)
        assert_eq!(proto_varints(&[0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01]), vec![]);
    }
}

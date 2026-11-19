//! Bluetooth LE sensors via btleplug.
//! Trainer: FTMS (ERG control + power/cadence/speed) with Cycling Power fallback (read-only).
//! Heart rate: standard Heart Rate service.
//!
//! Events emitted to the UI:
//!   "sensor"        { power?, cadence?, speed?, hr? }
//!   "device-status" { kind, connected, name, erg, reconnecting }
//!   "battery"       { kind, id, level }   (see battery.rs)

use btleplug::api::{bleuuid::uuid_from_u16, Central, CentralEvent, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc, Mutex, OnceCell};
use uuid::Uuid;

const FTMS: Uuid = uuid_from_u16(0x1826);
const INDOOR_BIKE_DATA: Uuid = uuid_from_u16(0x2ad2);
const FTMS_CONTROL: Uuid = uuid_from_u16(0x2ad9);
const SUPPORTED_POWER_RANGE: Uuid = uuid_from_u16(0x2ad8);
const CPS: Uuid = uuid_from_u16(0x1818);
const CP_MEASUREMENT: Uuid = uuid_from_u16(0x2a63);
const HRS: Uuid = uuid_from_u16(0x180d);
const HR_MEASUREMENT: Uuid = uuid_from_u16(0x2a37);

// FTMS control point op codes and result codes (FTMS spec 4.16).
const OP_REQUEST_CONTROL: u8 = 0x00;
const OP_START: u8 = 0x07;
const OP_RESPONSE: u8 = 0x80;
/// Wait for the control point's reply while connecting (some trainers are slow right after connecting).
const REPLY_CONNECT: Duration = Duration::from_millis(1500);
/// Wait for the reply to a target during a ride. Only used for trainers that answered while connecting.
const REPLY_RIDE: Duration = Duration::from_millis(600);

/// What the trainer answered on the control point.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Reply {
    Success,
    /// "Control not permitted": another app controls the trainer, or control was never granted.
    Denied,
    /// Any other result code (op code not supported, invalid parameter, operation failed).
    Failed(u8),
    /// No reply in time; many trainers never send one, so this is not an error.
    Silent,
}

impl Reply {
    fn from_result(code: u8) -> Self {
        match code {
            0x01 => Reply::Success,
            0x05 => Reply::Denied,
            c => Reply::Failed(c),
        }
    }
}

/// Whether to warn "another app may control the trainer" after a reply to a target:
/// a refusal raises it, an accepted target clears it, anything else leaves it as it was.
/// The warning never turns ERG off (some firmware refuses yet follows targets).
fn denied_after(denied: bool, reply: Reply) -> bool {
    match reply {
        Reply::Denied => true,
        Reply::Success => false,
        Reply::Failed(_) | Reply::Silent => denied,
    }
}

/// Our own limit for ERG targets; a trainer's Supported Power Range can only narrow it.
const MAX_TARGET: i32 = 2000;

/// Power targets the trainer accepts (FTMS Supported Power Range, 0x2AD8), in watts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PowerRange {
    min: i32,
    max: i32,
    step: i32,
}

impl Default for PowerRange {
    fn default() -> Self {
        PowerRange { min: 0, max: MAX_TARGET, step: 1 }
    }
}

impl PowerRange {
    /// `[min: sint16, max: sint16, increment: uint16]`, little endian. `None` for a missing or
    /// nonsensical range, so a bad value from the trainer never narrows ERG to something unusable.
    pub fn parse(v: &[u8]) -> Option<Self> {
        let min = i32::from(i16le(v, 0)?).max(0);
        let max = i32::from(i16le(v, 2)?).min(MAX_TARGET);
        let step = i32::from(u16le(v, 4)?).max(1);
        (max > min && step <= max - min).then_some(PowerRange { min, max, step })
    }

    /// Keep a target inside the range, on the trainer's increment (counted from `min`).
    pub fn clamp(self, watts: i32) -> i32 {
        let w = watts.clamp(self.min, self.max);
        let snapped = self.min + ((w - self.min) as f64 / self.step as f64).round() as i32 * self.step;
        // rounding up may pass a max that isn't on the grid: take the last step below it
        if snapped > self.max { snapped - self.step } else { snapped }
    }
}

/// FTMS Control Point response indication: `[0x80, request op code, result code, …]`.
pub fn parse_cp_response(v: &[u8]) -> Option<(u8, u8)> {
    match v {
        [OP_RESPONSE, op, result, ..] => Some((*op, *result)),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Trainer,
    Hr,
}

impl Kind {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "trainer" => Ok(Kind::Trainer),
            "hr" => Ok(Kind::Hr),
            _ => Err(format!("unknown device kind {s}")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Kind::Trainer => "trainer",
            Kind::Hr => "hr",
        }
    }
    fn services(self) -> Vec<Uuid> {
        match self {
            Kind::Trainer => vec![FTMS, CPS],
            Kind::Hr => vec![HRS],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Target {
    Watts(i32),
    Free,
}

impl Target {
    /// Control point command for this target.
    fn bytes(self) -> Vec<u8> {
        match self {
            // Set Target Power: sint16 watts
            Target::Watts(w) => {
                let b = (w.clamp(0, MAX_TARGET) as i16).to_le_bytes();
                vec![0x05, b[0], b[1]]
            }
            // Indoor Bike Simulation, flat road: wind 0, grade 0 %, crr 0.004, cw 0.51
            Target::Free => vec![0x11, 0, 0, 0, 0, 40, 51],
        }
    }
}

/// Read the trainer's Supported Power Range, if it has a readable one (2 s at most).
async fn read_power_range(periph: &Peripheral, ch: Option<Characteristic>) -> Option<PowerRange> {
    let ch = ch.filter(|c| c.properties.contains(CharPropFlags::READ))?;
    let v = tokio::time::timeout(Duration::from_secs(2), periph.read(&ch)).await.ok()?.ok()?;
    PowerRange::parse(&v)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Ftms,
    Cps,
    Hr,
}

struct Conn {
    periph: Peripheral,
    id: String,
    name: String,
    mode: Mode,
    control: Option<Characteristic>,
    last_target: Option<Target>,
    /// Unique per connection: a reconnect only replaces the very connection that dropped.
    serial: u64,
    /// A reconnect task is already running for this connection.
    reconnecting: bool,
    /// Notification task (sensor events, control point replies); aborted when the `Conn` is dropped.
    task: tokio::task::JoinHandle<()>,
    /// Control point replies `(op code, result)`, forwarded by the notification task.
    replies: mpsc::UnboundedReceiver<(u8, u8)>,
    /// The trainer answered "request control" while connecting, so later replies are worth waiting for.
    acks: bool,
    /// The trainer refused control ("control not permitted"): ERG stays on, the UI warns.
    denied: bool,
    /// ERG targets are kept inside this range (the trainer's own, else 0–2000 W).
    range: PowerRange,
    /// Battery polling; stops when the connection is dropped.
    _battery: Option<crate::battery::Watch>,
}

impl Drop for Conn {
    /// A replaced or dropped connection must stop emitting `sensor` events (two trainers' power would mix).
    fn drop(&mut self) {
        self.task.abort();
    }
}

static NEXT_SERIAL: AtomicU64 = AtomicU64::new(1);

/// What a reconnect does once it is done, given what the slot holds now (`(serial, id)` of its `Conn`).
#[derive(PartialEq, Debug)]
enum Takeover {
    /// The slot still holds the connection that dropped: replace it (or, after giving up, clear it).
    Mine,
    /// The user disconnected or connected another device meanwhile: leave the slot alone and close
    /// our own link, unless the slot now holds the same device (closing it would cut that connection).
    Superseded { close_link: bool },
}

fn takeover(slot: Option<(u64, &str)>, serial: u64, id: &str) -> Takeover {
    match slot {
        Some((s, _)) if s == serial => Takeover::Mine,
        Some((_, other)) => Takeover::Superseded { close_link: other != id },
        None => Takeover::Superseded { close_link: true },
    }
}

/// A control point write may hang (e.g. a link dropping mid-write) while the trainer lock is held.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);

impl Conn {
    fn token(&self) -> (u64, &str) {
        (self.serial, &self.id)
    }

    fn erg(&self) -> bool {
        self.mode == Mode::Ftms && self.control.is_some()
    }

    fn info(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "erg": self.erg(), "ergDenied": self.denied })
    }

    /// Write a control point command and, when `wait` is set, wait for the trainer's reply to it.
    async fn command(&mut self, cp: &Characteristic, bytes: &[u8], wait: Option<Duration>) -> Result<Reply, String> {
        while self.replies.try_recv().is_ok() {} // drop stale replies
        // a write that doesn't complete counts as failed (it may not have reached the trainer)
        tokio::time::timeout(WRITE_TIMEOUT, self.periph.write(cp, bytes, WriteType::WithResponse))
            .await
            .map_err(|_| "Trainer didn't confirm the write".to_string())?
            .map_err(|e| e.to_string())?;
        let Some(wait) = wait else { return Ok(Reply::Silent) };
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, self.replies.recv()).await {
                Ok(Some((op, result))) if op == bytes[0] => return Ok(Reply::from_result(result)),
                Ok(Some(_)) => {} // reply to an earlier command
                Ok(None) | Err(_) => return Ok(Reply::Silent),
            }
        }
    }

    /// Take control of the trainer: request control, then start / resume.
    async fn take_control(&mut self, cp: Characteristic) {
        // indications must be enabled before writing to the control point
        if self.periph.subscribe(&cp).await.is_err() {
            eprintln!("FTMS control point unavailable — power only");
            return;
        }
        // Any answer keeps ERG: a refusal only raises the `denied` warning, because some firmware
        // answers "not permitted" and follows targets anyway. Only a failed write means power only.
        match self.command(&cp, &[OP_REQUEST_CONTROL], Some(REPLY_CONNECT)).await {
            Ok(Reply::Denied) => {
                eprintln!("FTMS control not permitted — another app may control the trainer; trying ERG anyway");
                self.denied = true;
                self.acks = true;
            }
            Ok(Reply::Failed(code)) => {
                eprintln!("FTMS request control answered {code:#04x} — trying ERG anyway");
                self.acks = true;
            }
            Ok(reply) => self.acks = reply == Reply::Success,
            Err(e) => {
                eprintln!("FTMS request control failed: {e} — power only");
                return;
            }
        }
        let wait = self.acks.then_some(REPLY_CONNECT);
        match self.command(&cp, &[OP_START], wait).await {
            Ok(reply) => {
                if reply == Reply::Denied {
                    eprintln!("FTMS start not permitted — trying ERG anyway");
                    self.denied = true;
                }
                // some trainers reject "start" (not supported) but follow targets anyway
                self.control = Some(cp);
            }
            Err(e) => eprintln!("FTMS start failed: {e} — power only"),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
    pub kind: &'static str,
}

pub struct Ble {
    app: AppHandle,
    adapter: OnceCell<Adapter>,
    trainer: Mutex<Option<Conn>>,
    hr: Mutex<Option<Conn>>,
    /// One scan at a time: every scan ends with `stop_scan()` and a new `start_scan()` replaces the
    /// previous filter, so concurrent scans (trainer + HR + controllers at app start) cancel each other.
    pub(crate) scan_gate: Mutex<()>,
    /// Ids of peripherals the adapter reported as disconnected. Controllers listen to this because
    /// their notification stream doesn't end when the device is switched off (e.g. on macOS).
    dropped: broadcast::Sender<String>,
}

/// Wait until the adapter reports `id` as disconnected (never returns if the channel stays quiet).
pub(crate) async fn wait_dropped(rx: &mut broadcast::Receiver<String>, id: &str) {
    loop {
        match rx.recv().await {
            Ok(got) if got == id => return,
            Err(broadcast::error::RecvError::Closed) => return,
            _ => {}
        }
    }
}

impl Ble {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            adapter: OnceCell::new(),
            trainer: Mutex::new(None),
            hr: Mutex::new(None),
            scan_gate: Mutex::new(()),
            dropped: broadcast::channel(16).0,
        })
    }

    /// Subscribe before starting to watch a device, so a disconnect right after connecting isn't missed.
    pub(crate) fn subscribe_dropped(&self) -> broadcast::Receiver<String> {
        self.dropped.subscribe()
    }

    fn slot(&self, kind: Kind) -> &Mutex<Option<Conn>> {
        match kind {
            Kind::Trainer => &self.trainer,
            Kind::Hr => &self.hr,
        }
    }

    pub(crate) async fn adapter(self: &Arc<Self>) -> Result<&Adapter, String> {
        self.adapter
            .get_or_try_init(|| async {
                let manager = Manager::new().await.map_err(|e| format!("Bluetooth unavailable: {e}"))?;
                let adapter = manager
                    .adapters()
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .next()
                    .ok_or_else(|| "No Bluetooth adapter found".to_string())?;
                self.clone().watch_events(adapter.clone());
                Ok::<_, String>(adapter)
            })
            .await
    }

    fn status(&self, kind: Kind, connected: bool, name: &str, erg: bool, reconnecting: bool) {
        self.emit_status(kind, connected, name, erg, reconnecting, false);
    }

    /// Status of a live connection (includes `ergDenied`).
    fn conn_status(&self, kind: Kind, c: &Conn) {
        self.emit_status(kind, true, &c.name, c.erg(), false, c.denied);
    }

    fn emit_status(&self, kind: Kind, connected: bool, name: &str, erg: bool, reconnecting: bool, denied: bool) {
        let _ = self.app.emit(
            "device-status",
            json!({ "kind": kind.as_str(), "connected": connected, "name": name, "erg": erg, "reconnecting": reconnecting, "ergDenied": denied }),
        );
    }

    /// Scan for `secs` seconds and return matching devices, strongest signal first.
    pub async fn scan(self: &Arc<Self>, kind: Kind, secs: u64) -> Result<Vec<Found>, String> {
        let adapter = self.adapter().await?;
        let services = kind.services();
        let _gate = self.scan_gate.lock().await;
        adapter.start_scan(ScanFilter { services: services.clone() }).await.map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_secs(secs.clamp(1, 15))).await;
        let _ = adapter.stop_scan().await;
        let mut out = vec![];
        for p in adapter.peripherals().await.map_err(|e| e.to_string())? {
            let Ok(Some(props)) = p.properties().await else { continue };
            if !props.services.iter().any(|s| services.contains(s)) {
                continue;
            }
            let name = props.local_name.or(props.advertisement_name).unwrap_or_else(|| "Unnamed device".into());
            out.push(Found { id: p.id().to_string(), name, rssi: props.rssi, kind: kind.as_str() });
        }
        out.sort_by_key(|f| -(f.rssi.unwrap_or(-127) as i32));
        Ok(out)
    }

    async fn find(self: &Arc<Self>, kind: Kind, id: &str, wait: Duration) -> Result<Peripheral, String> {
        let adapter = self.adapter().await?;
        let lookup = || async {
            adapter.peripherals().await.ok().and_then(|ps| ps.into_iter().find(|p| p.id().to_string() == id))
        };
        if let Some(p) = lookup().await {
            return Ok(p);
        }
        // wait for other scans to finish; they may already have discovered this device
        let _gate = self.scan_gate.lock().await;
        if let Some(p) = lookup().await {
            return Ok(p);
        }
        adapter.start_scan(ScanFilter { services: kind.services() }).await.map_err(|e| e.to_string())?;
        let deadline = tokio::time::Instant::now() + wait;
        let found = loop {
            if let Some(p) = lookup().await {
                break Some(p);
            }
            if tokio::time::Instant::now() > deadline {
                break None;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        };
        let _ = adapter.stop_scan().await;
        found.ok_or_else(|| "Device not found — is it awake and not connected to another app?".into())
    }

    pub async fn connect(self: &Arc<Self>, kind: Kind, id: &str) -> Result<Value, String> {
        // drop an existing connection of the same kind first
        self.disconnect(kind).await;
        let periph = self.find(kind, id, Duration::from_secs(12)).await?;
        let conn = match self.setup(kind, periph.clone(), id.to_string()).await {
            Ok(conn) => conn,
            Err(e) => {
                // don't leave a half set-up link open
                let _ = periph.disconnect().await;
                return Err(e);
            }
        };
        let info = conn.info();
        let old = {
            let mut slot = self.slot(kind).lock().await;
            self.conn_status(kind, &conn);
            slot.replace(conn)
        };
        // another connect (or a reconnect) filled the slot meanwhile: dropping it stops its events,
        // and its link is closed unless it is the device we just connected
        if let Some(old) = old {
            if old.id != id {
                let _ = old.periph.disconnect().await;
            }
        }
        Ok(info)
    }

    async fn setup(self: &Arc<Self>, kind: Kind, periph: Peripheral, id: String) -> Result<Conn, String> {
        if !periph.is_connected().await.unwrap_or(false) {
            tokio::time::timeout(Duration::from_secs(15), periph.connect())
                .await
                .map_err(|_| "Connection timed out".to_string())?
                .map_err(|e| e.to_string())?;
        }
        periph.discover_services().await.map_err(|e| e.to_string())?;
        let name = periph
            .properties()
            .await
            .ok()
            .flatten()
            .and_then(|p| p.local_name.or(p.advertisement_name))
            .unwrap_or_else(|| if kind == Kind::Trainer { "Trainer".into() } else { "Heart rate".into() });

        let chars = periph.characteristics();
        let ch = |u: Uuid| chars.iter().find(|c| c.uuid == u).cloned();
        let mut stream = periph.notifications().await.map_err(|e| e.to_string())?;

        let (mode, control) = match kind {
            Kind::Hr => {
                let hr = ch(HR_MEASUREMENT).ok_or("Heart rate characteristic missing")?;
                periph.subscribe(&hr).await.map_err(|e| e.to_string())?;
                (Mode::Hr, None)
            }
            Kind::Trainer => {
                if let Some(data) = ch(INDOOR_BIKE_DATA) {
                    periph.subscribe(&data).await.map_err(|e| e.to_string())?;
                    (Mode::Ftms, ch(FTMS_CONTROL))
                } else if let Some(m) = ch(CP_MEASUREMENT) {
                    periph.subscribe(&m).await.map_err(|e| e.to_string())?;
                    (Mode::Cps, None)
                } else {
                    return Err("Device offers neither FTMS nor Cycling Power".into());
                }
            }
        };

        let app = self.app.clone();
        let (reply_tx, replies) = mpsc::unbounded_channel();
        // started before taking control, so the control point's replies are already forwarded
        let task = tokio::spawn(async move {
            let mut crank: Option<CrankState> = None;
            while let Some(n) = stream.next().await {
                if n.uuid == FTMS_CONTROL {
                    if let Some(r) = parse_cp_response(&n.value) {
                        let _ = reply_tx.send(r);
                    }
                    continue;
                }
                let out = match n.uuid {
                    u if u == INDOOR_BIKE_DATA => parse_bike_data(&n.value),
                    u if u == CP_MEASUREMENT => parse_power(&n.value, &mut crank),
                    u if u == HR_MEASUREMENT => parse_hr(&n.value),
                    _ => None,
                };
                if let Some(o) = out {
                    if !o.is_empty() {
                        let _ = app.emit("sensor", Value::Object(o));
                    }
                }
            }
        });

        let mut conn = Conn {
            periph: periph.clone(),
            id: id.clone(),
            name,
            mode,
            control: None,
            last_target: None,
            serial: NEXT_SERIAL.fetch_add(1, Ordering::Relaxed),
            reconnecting: false,
            task,
            replies,
            acks: false,
            denied: false,
            range: PowerRange::default(),
            _battery: None,
        };
        if let Some(cp) = control {
            // read before taking control: no control point command is in flight yet
            if let Some(range) = read_power_range(&periph, ch(SUPPORTED_POWER_RANGE)).await {
                eprintln!("FTMS supported power range {}–{} W (step {})", range.min, range.max, range.step);
                conn.range = range;
            }
            conn.take_control(cp).await;
        }
        // after taking control, so the first battery read doesn't collide with the handshake
        conn._battery = crate::battery::watch(self.app.clone(), periph, kind.as_str(), id);
        Ok(conn)
    }

    pub async fn disconnect(&self, kind: Kind) {
        // an empty slot also tells a running reconnect to stop
        let conn = self.slot(kind).lock().await.take();
        if let Some(c) = conn {
            let _ = c.periph.disconnect().await;
            self.status(kind, false, &c.name, false, false);
        }
    }

    /// Send a target. An `Err` means it didn't reach the trainer and the UI should send it again.
    async fn write_control(&self, target: Target) -> Result<(), String> {
        let mut slot = self.trainer.lock().await;
        let Some(c) = slot.as_mut() else { return Ok(()) };
        let Some(cp) = c.control.clone() else { return Ok(()) };
        // inside the trainer's range, so it isn't rejected as an invalid parameter
        let target = match target {
            Target::Watts(w) => Target::Watts(c.range.clamp(w)),
            t => t,
        };
        if c.last_target == Some(target) {
            return Ok(());
        }
        let bytes = target.bytes();
        let bytes = bytes.as_slice();
        let wait = c.acks.then_some(REPLY_RIDE);
        let mut reply = c.command(&cp, bytes, wait).await;
        if reply == Ok(Reply::Denied) {
            // the trainer lost or handed over control (reset, another app): ask once more, then resend
            if c.command(&cp, &[OP_REQUEST_CONTROL], wait).await == Ok(Reply::Success) {
                let _ = c.command(&cp, &[OP_START], wait).await;
                reply = c.command(&cp, bytes, wait).await;
            }
        }
        match reply {
            Ok(reply) => {
                match reply {
                    Reply::Denied => eprintln!("FTMS target not permitted — another app may control the trainer"),
                    // invalid parameter / not supported: resending the same bytes won't help
                    Reply::Failed(code) => eprintln!("FTMS target rejected (result {code:#04x})"),
                    _ => {}
                }
                // ERG stays on either way; a refusal is not resent for the same target
                c.last_target = Some(target);
                let denied = denied_after(c.denied, reply);
                if denied != c.denied {
                    c.denied = denied;
                    self.conn_status(Kind::Trainer, c);
                }
                Ok(())
            }
            Err(e) => {
                eprintln!("FTMS write failed: {e}");
                Err(format!("Trainer target not sent: {e}"))
            }
        }
    }

    /// ERG target in watts (kept inside the trainer's supported power range).
    pub async fn set_power(&self, watts: i32) -> Result<(), String> {
        self.write_control(Target::Watts(watts)).await
    }

    /// Free ride: leave ERG and simulate a flat road.
    pub async fn free_ride(&self) -> Result<(), String> {
        self.write_control(Target::Free).await
    }

    /// Re-send start/resume and force the next target to be re-sent.
    pub async fn resume(&self) {
        let mut slot = self.trainer.lock().await;
        if let Some(c) = slot.as_mut() {
            if let Some(cp) = c.control.clone() {
                let wait = c.acks.then_some(REPLY_RIDE);
                let _ = c.command(&cp, &[OP_START], wait).await;
            }
            c.last_target = None;
        }
    }

    pub async fn current(&self, kind: Kind) -> Option<Value> {
        self.slot(kind).lock().await.as_ref().map(Conn::info)
    }

    /// Watch adapter events and transparently reconnect dropped devices.
    fn watch_events(self: Arc<Self>, adapter: Adapter) {
        tauri::async_runtime::spawn(async move {
            let Ok(mut events) = adapter.events().await else { return };
            while let Some(ev) = events.next().await {
                if let CentralEvent::DeviceDisconnected(pid) = ev {
                    let pid = pid.to_string();
                    let _ = self.dropped.send(pid.clone());
                    for kind in [Kind::Trainer, Kind::Hr] {
                        // one reconnect per dropped connection, even if the adapter reports it twice
                        let dropped = {
                            let mut slot = self.slot(kind).lock().await;
                            slot.as_mut().filter(|c| c.id == pid && !c.reconnecting).map(|c| {
                                c.reconnecting = true;
                                (c.serial, c.name.clone(), c.periph.clone())
                            })
                        };
                        if let Some((serial, name, periph)) = dropped {
                            let me = self.clone();
                            let id = pid.clone();
                            tauri::async_runtime::spawn(async move { me.reconnect(kind, serial, id, name, periph).await });
                        }
                    }
                }
            }
        });
    }

    /// Reconnect the dropped connection `serial`. It stops as soon as the slot no longer holds that
    /// connection (the user disconnected or connected another device), also after a slow `setup()`.
    async fn reconnect(self: Arc<Self>, kind: Kind, serial: u64, id: String, name: String, periph: Peripheral) {
        self.status(kind, false, &name, false, true);
        let mine = |slot: &Option<Conn>| takeover(slot.as_ref().map(Conn::token), serial, &id);
        for attempt in 1..=8u64 {
            tokio::time::sleep(Duration::from_millis(1500 * attempt.min(4))).await;
            if mine(&*self.slot(kind).lock().await) != Takeover::Mine {
                return;
            }
            let Ok(conn) = self.setup(kind, periph.clone(), id.clone()).await else { continue };
            // setup can take a while: check again before replacing anything
            let mut slot = self.slot(kind).lock().await;
            match mine(&slot) {
                Takeover::Mine => {
                    self.conn_status(kind, &conn);
                    *slot = Some(conn); // drops the dead connection
                }
                Takeover::Superseded { close_link } => {
                    drop(slot);
                    drop(conn); // stops its notification task and battery polling
                    if close_link {
                        let _ = periph.disconnect().await;
                    }
                }
            }
            return;
        }
        let mut slot = self.slot(kind).lock().await;
        let outcome = mine(&slot);
        if outcome == Takeover::Mine {
            slot.take();
        }
        drop(slot);
        if outcome != (Takeover::Superseded { close_link: false }) {
            // the last attempt may have left a half set-up link open
            let _ = periph.disconnect().await;
        }
        if outcome == Takeover::Mine {
            self.status(kind, false, &name, false, false);
        }
    }
}

// ---------------------------------------------------------------- parsers

fn u16le(v: &[u8], o: usize) -> Option<u16> {
    v.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]))
}
fn i16le(v: &[u8], o: usize) -> Option<i16> {
    v.get(o..o + 2).map(|b| i16::from_le_bytes([b[0], b[1]]))
}

/// FTMS Indoor Bike Data (0x2AD2).
pub fn parse_bike_data(v: &[u8]) -> Option<Map<String, Value>> {
    let flags = u16le(v, 0)?;
    let mut o = 2;
    let mut out = Map::new();
    if flags & 0x0001 == 0 {
        out.insert("speed".into(), json!((u16le(v, o)? as f64) / 100.0));
        o += 2;
    }
    if flags & 0x0002 != 0 { o += 2; }
    if flags & 0x0004 != 0 {
        out.insert("cadence".into(), json!((u16le(v, o)? as f64) / 2.0));
        o += 2;
    }
    if flags & 0x0008 != 0 { o += 2; }
    if flags & 0x0010 != 0 { o += 3; }
    if flags & 0x0020 != 0 { o += 2; }
    if flags & 0x0040 != 0 {
        out.insert("power".into(), json!(i16le(v, o)?));
        o += 2;
    }
    if flags & 0x0080 != 0 { o += 2; }
    if flags & 0x0100 != 0 { o += 5; }
    if flags & 0x0200 != 0 {
        if let Some(hr) = v.get(o) {
            if *hr > 0 {
                out.insert("hr".into(), json!(*hr));
            }
        }
    }
    Some(out)
}

pub struct CrankState {
    revs: u16,
    time: u16,
    last_change: std::time::Instant,
}

/// Cycling Power Measurement (0x2A63), cadence derived from crank revolution data.
pub fn parse_power(v: &[u8], crank: &mut Option<CrankState>) -> Option<Map<String, Value>> {
    let flags = u16le(v, 0)?;
    let mut out = Map::new();
    out.insert("power".into(), json!(i16le(v, 2)?));
    let mut o = 4;
    if flags & 0x01 != 0 { o += 1; }
    if flags & 0x04 != 0 { o += 2; }
    if flags & 0x10 != 0 { o += 6; }
    if flags & 0x20 != 0 {
        let (revs, time) = (u16le(v, o)?, u16le(v, o + 2)?);
        let now = std::time::Instant::now();
        match crank {
            Some(c) => {
                let dr = revs.wrapping_sub(c.revs);
                let dt = time.wrapping_sub(c.time) as f64 / 1024.0;
                if dt > 0.0 && dr < 20 {
                    out.insert("cadence".into(), json!(((dr as f64 / dt) * 60.0).round()));
                    c.last_change = now;
                } else if now.duration_since(c.last_change) > Duration::from_secs(3) {
                    out.insert("cadence".into(), json!(0));
                }
                c.revs = revs;
                c.time = time;
            }
            None => *crank = Some(CrankState { revs, time, last_change: now }),
        }
    }
    Some(out)
}

/// Heart Rate Measurement (0x2A37).
pub fn parse_hr(v: &[u8]) -> Option<Map<String, Value>> {
    let flags = *v.first()?;
    let hr = if flags & 1 != 0 { u16le(v, 1)? } else { *v.get(1)? as u16 };
    let mut out = Map::new();
    out.insert("hr".into(), json!(hr));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_point_response() {
        // request control → success
        assert_eq!(parse_cp_response(&[0x80, 0x00, 0x01]), Some((0x00, 0x01)));
        // set target power → control not permitted (another app holds control)
        assert_eq!(parse_cp_response(&[0x80, 0x05, 0x05]), Some((0x05, 0x05)));
        // extra response parameters are ignored
        assert_eq!(parse_cp_response(&[0x80, 0x11, 0x01, 0xaa]), Some((0x11, 0x01)));
        // not a response, or too short
        assert_eq!(parse_cp_response(&[0x05, 0x64, 0x00]), None);
        assert_eq!(parse_cp_response(&[0x80, 0x00]), None);
        assert_eq!(parse_cp_response(&[]), None);
    }

    #[test]
    fn control_point_result_codes() {
        assert_eq!(Reply::from_result(0x01), Reply::Success);
        assert_eq!(Reply::from_result(0x05), Reply::Denied);
        assert_eq!(Reply::from_result(0x02), Reply::Failed(0x02)); // op code not supported
        assert_eq!(Reply::from_result(0x03), Reply::Failed(0x03)); // invalid parameter
        assert_eq!(Reply::from_result(0x04), Reply::Failed(0x04)); // operation failed
    }

    #[test]
    fn supported_power_range() {
        // 0–1500 W, 1 W steps
        let r = PowerRange::parse(&[0x00, 0x00, 0xdc, 0x05, 0x01, 0x00]).unwrap();
        assert_eq!(r, PowerRange { min: 0, max: 1500, step: 1 });
        // 25–2500 W, 5 W steps: the maximum is capped at our own 2000 W
        let r = PowerRange::parse(&[0x19, 0x00, 0xc4, 0x09, 0x05, 0x00]).unwrap();
        assert_eq!(r, PowerRange { min: 25, max: 2000, step: 5 });
        // nonsense is ignored: max ≤ min, short value, step wider than the range
        assert_eq!(PowerRange::parse(&[0x64, 0x00, 0x64, 0x00, 0x01, 0x00]), None);
        assert_eq!(PowerRange::parse(&[0x00, 0x00, 0xdc]), None);
        assert_eq!(PowerRange::parse(&[0x00, 0x00, 0x0a, 0x00, 0x64, 0x00]), None);
        // a negative minimum counts as 0; a zero step as 1
        assert_eq!(PowerRange::parse(&[0xf6, 0xff, 0xe8, 0x03, 0x00, 0x00]), Some(PowerRange { min: 0, max: 1000, step: 1 }));
    }

    #[test]
    fn targets_stay_inside_the_power_range() {
        let r = PowerRange { min: 25, max: 1500, step: 5 };
        assert_eq!(r.clamp(10), 25, "below the minimum");
        assert_eq!(r.clamp(1800), 1500, "above the maximum");
        assert_eq!(r.clamp(152), 150, "rounded to the step, counted from min");
        assert_eq!(r.clamp(153), 155);
        assert_eq!(PowerRange { min: 0, max: 1003, step: 5 }.clamp(1003), 1000, "never above max after snapping");
        assert_eq!(PowerRange::default().clamp(-20), 0);
        assert_eq!(PowerRange::default().clamp(2500), 2000);
        assert_eq!(PowerRange::default().clamp(173), 173);
    }

    #[test]
    fn target_bytes() {
        assert_eq!(Target::Watts(200).bytes(), vec![0x05, 0xc8, 0x00]);
        assert_eq!(Target::Free.bytes(), vec![0x11, 0, 0, 0, 0, 40, 51]);
    }

    #[test]
    fn denied_warning_never_depends_on_silence() {
        assert!(denied_after(false, Reply::Denied), "a refusal raises the warning");
        assert!(!denied_after(true, Reply::Success), "an accepted target clears it");
        assert!(denied_after(true, Reply::Silent), "no reply keeps it");
        assert!(!denied_after(false, Reply::Silent));
        assert!(denied_after(true, Reply::Failed(0x03)), "other errors keep it");
        assert!(!denied_after(false, Reply::Failed(0x03)));
    }

    #[test]
    fn reconnect_takeover() {
        // still the connection that dropped
        assert_eq!(takeover(Some((7, "A")), 7, "A"), Takeover::Mine);
        // user disconnected meanwhile: slot empty, close our link
        assert_eq!(takeover(None, 7, "A"), Takeover::Superseded { close_link: true });
        // user connected trainer B meanwhile: keep B, close A
        assert_eq!(takeover(Some((9, "B")), 7, "A"), Takeover::Superseded { close_link: true });
        // user reconnected A by hand meanwhile: keep theirs, don't cut the shared link
        assert_eq!(takeover(Some((9, "A")), 7, "A"), Takeover::Superseded { close_link: false });
    }

    #[tokio::test]
    async fn wait_dropped_ignores_other_devices_and_returns_for_its_own() {
        let (tx, mut rx) = broadcast::channel(16);
        tx.send("other".to_string()).unwrap();
        tx.send("mine".to_string()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), wait_dropped(&mut rx, "mine")).await.expect("returns once its id is reported");

        let (tx2, mut rx2) = broadcast::channel(16);
        tx2.send("other".to_string()).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(100), wait_dropped(&mut rx2, "mine")).await.is_err(), "other ids don't end the watch");
    }

    #[test]
    fn bike_data() {
        // flags: cadence + power present, speed present (bit0 = 0)
        let flags: u16 = 0x0004 | 0x0040;
        let mut v = flags.to_le_bytes().to_vec();
        v.extend(2850u16.to_le_bytes()); // 28.50 km/h
        v.extend(180u16.to_le_bytes()); // 90 rpm
        v.extend(215i16.to_le_bytes()); // 215 W
        let o = parse_bike_data(&v).unwrap();
        assert_eq!(o["speed"], json!(28.5));
        assert_eq!(o["cadence"], json!(90.0));
        assert_eq!(o["power"], json!(215));
    }

    #[test]
    fn heart_rate() {
        assert_eq!(parse_hr(&[0x00, 142]).unwrap()["hr"], json!(142));
        assert_eq!(parse_hr(&[0x01, 0x2c, 0x01]).unwrap()["hr"], json!(300));
    }

    #[test]
    fn power_with_crank() {
        let mut st = None;
        let mk = |revs: u16, t: u16| {
            let mut v = 0x20u16.to_le_bytes().to_vec();
            v.extend(250i16.to_le_bytes());
            v.extend(revs.to_le_bytes());
            v.extend(t.to_le_bytes());
            v
        };
        parse_power(&mk(10, 0), &mut st).unwrap();
        let o = parse_power(&mk(11, 683), &mut st).unwrap(); // 1 rev in 0.667 s ≈ 90 rpm
        assert_eq!(o["power"], json!(250));
        assert_eq!(o["cadence"], json!(90.0));
    }
}

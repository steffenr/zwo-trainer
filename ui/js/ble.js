// Device layer. Real devices live in Rust (btleplug) and talk to us via Tauri commands/events;
// the simulator runs here so the app can be tried without hardware.
import { t } from './i18n/index.js';

/** Tauri globals (withGlobalTauri); the browser mock provides the same shape. */
const T = () => window.__TAURI__;
/** Call a Rust #[tauri::command] (the only IPC surface, see lib.rs). */
export const invoke = (cmd, args) => T().core.invoke(cmd, args);
/** Subscribe to an event from Rust (device-status, sensor, button, battery …); `fn` gets the payload. */
export const listen = (ev, fn) => T().event.listen(ev, (e) => fn(e.payload));

/** Minimal on/emit event emitter for the device objects. */
class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, data) { (this.handlers[ev] || []).forEach((fn) => fn(data)); }
}

/** A Bluetooth device role (trainer or heart-rate monitor): connection state mirrored from Rust
 * events, connect/disconnect via commands, and a simulator for ?sim=1. */
class Device extends Emitter {
  constructor(kind) {
    super();
    this.kind = kind;
    this.mode = null;        // 'ble' | 'sim' | null
    this.name = '';
    this.erg = false;
    this.reconnecting = false;
    this.simTimer = null;
  }

  get connected() { return this.mode !== null && !this.reconnecting; }

  /** Display name. The simulator's is translated when it is read, so it follows a language switch;
   *  real devices keep the name they advertise. */
  get name() { return this.mode === 'sim' ? t('simulator') : this.devName; }
  set name(v) { this.devName = v; }

  /** Rust → UI status updates for this kind. */
  onStatus(s) {
    if (this.mode === 'sim') return;
    this.reconnecting = !!s.reconnecting;
    this.mode = s.connected || s.reconnecting ? 'ble' : null;
    this.name = s.name || '';
    this.erg = !!s.erg;
    this.emitStatus();
  }

  /** Tell listeners (top bar, ride screen) the current connection state. */
  emitStatus() {
    this.emit('status', { connected: this.connected, sim: this.mode === 'sim', name: this.name, erg: this.erg, ergDenied: !!this.ergDenied, reconnecting: this.reconnecting });
  }

  scan(secs = 4) { return invoke('ble_scan', { kind: this.kind, secs }); }

  /** Connect to a device found by ble_scan; Rust keeps reconnecting silently afterwards. */
  async connect(id) {
    this.stopSim();
    const info = await invoke('ble_connect', { kind: this.kind, id });
    this.id = id;
    this.mode = 'ble';
    this.name = info.name;
    this.erg = !!info.erg;
    this.ergDenied = !!info.ergDenied;
    this.reconnecting = false;
    this.emitStatus();
    return info;
  }

  /** Disconnect the device. */
  async disconnect() {
    if (this.mode === 'sim') { this.stopSim(); this.mode = null; this.emitStatus(); return; }
    await invoke('ble_disconnect', { kind: this.kind }).catch(() => {});
    this.mode = null;
    this.emitStatus();
  }

  stopSim() { if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null; } }
}

/** The smart trainer: ERG targets (deduplicated here and in Rust), free ride and resume. */
export class Trainer extends Device {
  constructor() { super('trainer'); this.simTarget = 150; this.lastSent = undefined; }
  get canErg() { return this.mode === 'sim' || (this.mode === 'ble' && this.erg); }

  /** ERG target in watts (deduplicated here and again in Rust). */
  setTargetPower(watts) {
    if (this.mode === 'sim') { this.simTarget = watts; return; }
    if (!this.canErg || this.reconnecting) return;
    const w = Math.round(watts);
    if (w === this.lastSent) return;
    this.send('trainer_set_power', { watts: w }, w);
  }

  /** Release ERG (free-ride segments, all-out efforts, virtual shifting). */
  setFreeRide() {
    if (this.mode === 'sim') { this.simTarget = null; return; }
    if (!this.canErg || this.lastSent === 'free') return;
    this.send('trainer_free_ride', {}, 'free');
  }

  /** Send a target once; if it didn't reach the trainer, forget it so the next ride tick sends it again. */
  send(cmd, args, target) {
    this.lastSent = target;
    invoke(cmd, args).catch(() => { if (this.lastSent === target) this.lastSent = undefined; });
  }

  /** Back to ERG after a free-ride segment. */
  resume() {
    this.lastSent = undefined;
    if (this.mode === 'ble') invoke('trainer_resume').catch(() => {});
  }

  onStatus(s) { this.lastSent = undefined; this.ergDenied = !!s.ergDenied; super.onStatus(s); }

  startSim() {
    this.stopSim();
    if (this.mode === 'ble') invoke('ble_disconnect', { kind: 'trainer' }).catch(() => {});
    this.mode = 'sim'; this.erg = true; this.reconnecting = false;
    let cad = 88;
    this.simTimer = setInterval(() => {
      const base = this.simTarget ?? 160;
      cad += (Math.random() - 0.5) * 2; cad = Math.max(78, Math.min(98, cad));
      const power = Math.max(0, Math.round(base + (Math.random() - 0.5) * 12));
      this.emit('data', { power, cadence: Math.round(cad), speed: +(Math.cbrt(power) * 5.6).toFixed(1) });
    }, 1000);
    this.emitStatus();
  }
}

/** Heart-rate monitor (or a watch broadcasting HR). */
export class HeartRate extends Device {
  constructor() { super('hr'); }

  startSim() {
    this.stopSim();
    if (this.mode === 'ble') invoke('ble_disconnect', { kind: 'hr' }).catch(() => {});
    this.mode = 'sim'; this.reconnecting = false;
    let hr = 110;
    this.simTimer = setInterval(() => { hr += (Math.random() - 0.45) * 2; hr = Math.max(95, Math.min(175, hr)); this.emit('data', { hr: Math.round(hr) }); }, 1000);
    this.emitStatus();
  }
}

/** Zwift Ride / Click / Play and OpenBikeControl controllers (virtual shifting). Several can be connected (Ride L + R). */
export class Controllers extends Emitter {
  constructor() { super(); this.names = ''; this.count = 0; this.ids = []; }
  get connected() { return this.count > 0; }
  scan(secs = 4) { return invoke('ctrl_scan', { secs }); }
  async connect(id) { const info = await invoke('ctrl_connect', { id }); return info; }
  async disconnect() { await invoke('ctrl_disconnect').catch(() => {}); }
  list() { return invoke('ctrl_list').catch(() => []); }
  onStatus(s) { this.count = s.count || 0; this.names = s.name || ''; this.ids = s.ids || []; this.emit('status', { connected: this.count > 0, reconnecting: !!s.reconnecting, name: this.names }); }
}

/** Wire Rust events to the device objects. Sensor data from real devices goes to `onData`. */
export async function bindNative(trainer, hrm, onData, ctrls, onButton, onBattery) {
  await listen('device-status', (s) => (s.kind === 'controller' ? ctrls?.onStatus(s) : (s.kind === 'trainer' ? trainer : hrm).onStatus(s)));
  await listen('button', (e) => onButton?.(e.button, e.device, e.erg));
  await listen('battery', (e) => onBattery?.(e));
  await listen('ctrl-raw', (e) => ctrls?.emit('raw', e));
  await listen('sensor', (d) => {
    // ignore real readings for a kind that is being simulated
    const out = { ...d };
    if (trainer.mode === 'sim') { delete out.power; delete out.cadence; delete out.speed; }
    if (hrm.mode === 'sim') delete out.hr;
    if (Object.keys(out).length) onData(out);
  });
}

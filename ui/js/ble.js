// Device layer. Real devices live in Rust (btleplug) and talk to us via Tauri commands/events;
// the simulator runs here so the app can be tried without hardware.

const T = () => window.__TAURI__;
export const invoke = (cmd, args) => T().core.invoke(cmd, args);
export const listen = (ev, fn) => T().event.listen(ev, (e) => fn(e.payload));

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, data) { (this.handlers[ev] || []).forEach((fn) => fn(data)); }
}

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

  /** Rust → UI status updates for this kind. */
  onStatus(s) {
    if (this.mode === 'sim') return;
    this.reconnecting = !!s.reconnecting;
    this.mode = s.connected || s.reconnecting ? 'ble' : null;
    this.name = s.name || '';
    this.erg = !!s.erg;
    this.emitStatus();
  }

  emitStatus() {
    this.emit('status', { connected: this.connected, name: this.name, erg: this.erg, reconnecting: this.reconnecting });
  }

  scan(secs = 4) { return invoke('ble_scan', { kind: this.kind, secs }); }

  async connect(id) {
    this.stopSim();
    const info = await invoke('ble_connect', { kind: this.kind, id });
    this.id = id;
    this.mode = 'ble';
    this.name = info.name;
    this.erg = !!info.erg;
    this.reconnecting = false;
    this.emitStatus();
    return info;
  }

  async disconnect() {
    if (this.mode === 'sim') { this.stopSim(); this.mode = null; this.emitStatus(); return; }
    await invoke('ble_disconnect', { kind: this.kind }).catch(() => {});
    this.mode = null;
    this.emitStatus();
  }

  stopSim() { if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null; } }
}

export class Trainer extends Device {
  constructor() { super('trainer'); this.simTarget = 150; this.lastSent = undefined; }
  get canErg() { return this.mode === 'sim' || (this.mode === 'ble' && this.erg); }

  /** ERG target in watts (deduplicated here and again in Rust). */
  setTargetPower(watts) {
    if (this.mode === 'sim') { this.simTarget = watts; return; }
    if (!this.canErg || this.reconnecting) return;
    const w = Math.round(watts);
    if (w === this.lastSent) return;
    this.lastSent = w;
    invoke('trainer_set_power', { watts: w }).catch(() => {});
  }

  setFreeRide() {
    if (this.mode === 'sim') { this.simTarget = null; return; }
    if (!this.canErg || this.lastSent === 'free') return;
    this.lastSent = 'free';
    invoke('trainer_free_ride').catch(() => {});
  }

  resume() {
    this.lastSent = undefined;
    if (this.mode === 'ble') invoke('trainer_resume').catch(() => {});
  }

  onStatus(s) { this.lastSent = undefined; super.onStatus(s); }

  startSim() {
    this.stopSim();
    if (this.mode === 'ble') invoke('ble_disconnect', { kind: 'trainer' }).catch(() => {});
    this.mode = 'sim'; this.name = 'Simulator'; this.erg = true; this.reconnecting = false;
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

export class HeartRate extends Device {
  constructor() { super('hr'); }

  startSim() {
    this.stopSim();
    if (this.mode === 'ble') invoke('ble_disconnect', { kind: 'hr' }).catch(() => {});
    this.mode = 'sim'; this.name = 'Simulator'; this.reconnecting = false;
    let hr = 110;
    this.simTimer = setInterval(() => { hr += (Math.random() - 0.45) * 2; hr = Math.max(95, Math.min(175, hr)); this.emit('data', { hr: Math.round(hr) }); }, 1000);
    this.emitStatus();
  }
}

/** Zwift Ride / Click / Play controllers (virtual shifting). Several can be connected (Ride L + R). */
export class Controllers extends Emitter {
  constructor() { super(); this.names = ''; this.count = 0; }
  get connected() { return this.count > 0; }
  scan(secs = 4) { return invoke('ctrl_scan', { secs }); }
  async connect(id) { const info = await invoke('ctrl_connect', { id }); return info; }
  async disconnect() { await invoke('ctrl_disconnect').catch(() => {}); }
  list() { return invoke('ctrl_list').catch(() => []); }
  onStatus(s) { this.count = s.count || 0; this.names = s.name || ''; this.emit('status', { connected: this.count > 0, name: this.names }); }
}

/** Wire Rust events to the device objects. Sensor data from real devices goes to `onData`. */
export async function bindNative(trainer, hrm, onData, ctrls, onButton) {
  await listen('device-status', (s) => (s.kind === 'controller' ? ctrls?.onStatus(s) : (s.kind === 'trainer' ? trainer : hrm).onStatus(s)));
  await listen('button', (e) => onButton?.(e.button, e.device));
  await listen('ctrl-raw', (e) => ctrls?.emit('raw', e));
  await listen('sensor', (d) => {
    // ignore real readings for a kind that is being simulated
    const out = { ...d };
    if (trainer.mode === 'sim') { delete out.power; delete out.cadence; delete out.speed; }
    if (hrm.mode === 'sim') delete out.hr;
    if (Object.keys(out).length) onData(out);
  });
}

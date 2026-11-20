// Browser-side mock of the Tauri backend for the screenshot runner (scripts/shots/run.mjs).
// Injected with page.addInitScript(tauriMock, data) before the app loads, so it must be self-contained:
// no imports, no closures over module variables. Never part of ui/ or the app bundle.
//
// data = { library, workouts, profile, sync, garmin, services, freePower }
// window.__shots: emit(event, payload) to fake Rust events, ride (virtual rider: target, free watts),
// calls[] / unknown[] for debugging. Saved devices auto-connect as in the app, no ?sim=1 needed.
export function tauriMock(data) {
  // deterministic "random" so unchanged screens give identical pixels: one generator for the app,
  // a separate one for the virtual rider, so the app's own random calls can't shift the rider's data
  const prng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = prng(0x2f6b9a1d);
  const noise = prng(0x51ed270b);

  let profile = data.profile;
  const listeners = {};
  const shots = (window.__shots = { calls: [], unknown: [], emit: (ev, payload) => (listeners[ev] || []).forEach((fn) => fn({ event: ev, payload })) });
  const appState = () => ({ profiles: [{ id: profile.id, name: profile.name }], profile: structuredClone(profile), sync: data.sync });
  const now = () => new Date().toISOString();

  // ---- virtual devices: what Rust + a real trainer would do (connect, ERG targets, sensor and battery events)
  // The rider holds the ERG target (±2 %); in free ride / all-out efforts it rides `ride.free` watts (shots
  // can change window.__shots.ride). Sensor data comes once per ride second, also when fast-forwarded (?speed=N).
  const speed = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1);
  const ride = (shots.ride = { target: null, free: data.freePower ?? 200, cadence: 88, hr: 104, ftp: data.profile.settings.ftp || 250 });
  const NAMES = { trainer: 'Wahoo KICKR CORE', hr: 'HRM-Pro Plus' };
  const BATTERY = { hr: ['h1', 82], controller: ['c1', 24] };
  const status = (kind, extra = {}) => setTimeout(() => {
    shots.emit('device-status', { kind, connected: true, reconnecting: false, name: NAMES[kind] || 'Zwift Ride (left)', erg: kind === 'trainer', ...extra });
    if (BATTERY[kind]) shots.emit('battery', { kind, id: BATTERY[kind][0], level: BATTERY[kind][1] });
  }, 0);
  let feed = null;
  const startFeed = () => {
    if (feed) return;
    feed = setInterval(() => {
      const base = ride.target ?? ride.free;
      const power = Math.max(0, Math.round(base * (1 + (noise() - 0.5) * 0.04)));
      // cadence wanders around the rider's preferred 90 rpm (mean-reverting, so it never drifts into coach warnings)
      ride.cadence += (90 - ride.cadence) * 0.15 + (noise() - 0.5) * 2;
      // heart rate drifts towards a level set by the effort (slow, like a real rider)
      ride.hr += ((96 + (power / ride.ftp) * 62) - ride.hr) * 0.02;
      shots.emit('sensor', { power, cadence: Math.round(ride.cadence), speed: +(Math.cbrt(power) * 5.6).toFixed(1), hr: Math.round(ride.hr) });
    }, 1000 / speed);
  };

  const R = {
    ble_connect: ({ kind }) => { status(kind); if (kind === 'trainer') startFeed(); return { name: NAMES[kind], erg: kind === 'trainer', ergDenied: false }; },
    ble_disconnect: () => null,
    ctrl_connect: () => { status('controller', { count: 1, ids: ['c1'] }); return { name: 'Zwift Ride (left)' }; },
    ctrl_disconnect: () => null,
    trainer_set_power: ({ watts }) => { ride.target = watts; return null; },
    trainer_free_ride: () => { ride.target = null; return null; },
    trainer_resume: () => null,
    service_upload: () => ({ id: 'i12345', url: 'https://intervals.icu/activities/i12345' }),
    app_state: appState,
    save_profile: ({ profile: p }) => { profile = structuredClone(p); return { ok: true }; },
    scan_library: () => data.library,
    load_workout: ({ file }) => {
      const w = data.workouts[file];
      if (!w) throw new Error(`fixture has no workout ${file}`);
      return w;
    },
    sync_targets: () => [
      { provider: 'icloud', label: 'iCloud Drive', path: '/Users/lena/Library/Mobile Documents/com~apple~CloudDocs', found: true },
      { provider: 'dropbox', label: 'Dropbox', path: null, found: false },
      { provider: 'nextcloud', label: 'Nextcloud', path: '/Users/lena/Nextcloud', found: true },
    ],
    sync_now: () => ({ at: now(), changed: false, pulled: 0 }),
    garmin_status: () => data.garmin,
    garmin_upload: () => ({ activityId: 18273645, url: 'https://connect.garmin.com/modern/activity/18273645' }),
    services_status: () => data.services,
    update_status: () => ({ auto: true, available: true }),
    update_check: () => null,
    save_activity: () => ({ path: '/Users/lena/Library/Application Support/zwoTrainer/activities/ride.fit', summary: { distanceKm: 38.4 } }),
    ble_current: () => ({}),
    ctrl_list: () => [],
    keep_awake: () => null,
    ride_window: () => null,
    ride_window_bar: (a) => { shots.bar = !!a.bar; return null; },
    ride_window_size: (a) => { shots.size = [a.width, a.height]; return null; },
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        shots.calls.push(cmd);
        if (!(cmd in R)) { shots.unknown.push(cmd); return null; }
        return structuredClone(R[cmd](args));
      },
    },
    event: {
      listen: async (ev, fn) => {
        (listeners[ev] ||= []).push(fn);
        return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); };
      },
    },
    app: { getVersion: async () => data.version || 'dev' },
  };
}

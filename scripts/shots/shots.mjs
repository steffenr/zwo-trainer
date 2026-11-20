// The website screenshots: one entry per image pair site/img/<name>-{dark,light}.webp.
//
//   name      file name in site/img (without -dark/-light.webp)
//   about     one line for --list
//   viewport  [width, height] in CSS px (default 1600 × 1000)
//   scale     device pixel ratio (default 1; dialogs and cards use 2)
//   free      watts the virtual rider pushes when ERG is off (free ride, all-out efforts); default 200
//   rider(p)  optional: change the sample rider (rider.mjs) before the app boots
//   run(s)    drive the app; return a selector / locator to capture that element, or nothing for the viewport
//
// `s` (see helpers() in run.mjs): open(hash, params), click(selector, n), key(k), tick(ms) (fake clock),
// emit(event, payload) (fake Rust events), resize(w, h), wait(selector), page (Playwright page), theme.
// Saved devices auto-connect to the mock's virtual trainer / strap / controller (mock.js), which holds
// every ERG target. Ride shots fast-forward with ?speed=N: tick(ms) of fake time = N × ms of ride time.

export const SSS = 'sweet-spot-sessions/Sweet_Spot_3x12.zwo';
const VO2 = 'base-builder-6wk/Week05_Day05_VO2_Ladder.zwo';
const TEMPO = 'base-builder-6wk/Week02_Day03_Tempo_Surges.zwo';
/** Fake ms from opening a workout until auto-start has started the ride clock. */
const START = 1250;

/** Start a workout from the Workouts list (rider mode 'workouts') and ride until `rideSeconds`. */
export async function rideTo(s, file, rideSeconds, speed = 10) {
  await s.open('', { speed: String(speed) });
  await s.click(`.wrow[data-file="${file}"] [data-act="ride-free"], .wrow[data-file="${file}"] [data-act="start"]`);
  await s.tick((rideSeconds * 1000) / speed + START); // pedalling starts the ride after about START ms
}

/** Start a built-in FTP test from the FTP Tests page (rider mode 'tests') and ride until `rideSeconds`. */
export async function testTo(s, id, rideSeconds, speed = 20) {
  await s.open('', { speed: String(speed) });
  await s.click(`[data-act="start-test"][data-test="${id}"]`);
  await s.tick((rideSeconds * 1000) / speed + START);
}

const mode = (m, more) => (p) => { p.settings.mode = m; more?.(p); };

export default [
  // ---------------------------------------------------------------- screens (1600 × 1000 frames)
  { name: 'home', about: 'Plans home: active plan, up next, plan cards', async run(s) { await s.open(); } },
  { name: 'plan', about: 'Plan page of Base Builder 6wk with weeks, progress and description', async run(s) { await s.open('#/plan/base-builder-6wk'); } },
  { name: 'workouts', about: 'Workout library with sidebar, filters and rows', rider: mode('workouts'), async run(s) { await s.open(); } },
  { name: 'tests', about: 'FTP Tests page: current FTP, trend, protocols', rider: mode('tests'), async run(s) { await s.open(); } },
  {
    name: 'ride', about: 'Ride screen mid-workout (Sweet Spot 3x12, first interval)',
    rider: mode('workouts'),
    async run(s) { await rideTo(s, SSS, 18 * 60 + 15); },
  },
  {
    name: 'test-20min', about: '20-minute FTP test during the 20-minute effort, real gears',
    free: 282, rider: mode('tests', (p) => { p.settings.shifting = { mode: 'gears', difficulty: 'medium' }; }),
    async run(s) { await testTo(s, '20min', 54 * 60 + 15); },
  },
  {
    name: 'test-20min-vs', about: '20-minute FTP test on virtual gears (gear 19 of 24)',
    rider: mode('tests', (p) => { p.settings.shifting = { mode: 'virtual', difficulty: 'medium', startGear: 19 }; }),
    async run(s) { await testTo(s, '20min', 54 * 60 + 15); },
  },
  // ---------------------------------------------------------------- compact view (960 × 200 window at 2×)
  {
    name: 'compact', about: 'Compact ride view next to a video (960 × 200 window)',
    scale: 2, rider: mode('workouts'),
    async run(s) {
      await rideTo(s, SSS, 18 * 60 + 44);
      await s.click('#btn-compact');
      await s.resize(960, 200);
      await s.tick(600);
    },
  },
  // ---------------------------------------------------------------- dialogs and cards (2×)
  {
    name: 'preview-card', about: 'Workout details dialog (VO2 Ladder, opened from Workouts)',
    viewport: [1400, 1000], scale: 2, rider: mode('workouts'),
    async run(s) { await s.open(); await s.click(`.wrow[data-file="${VO2}"]`); return '#modal'; },
  },
  {
    name: 'history-card', about: 'Ride history table with Garmin upload marks',
    viewport: [1000, 1000], scale: 2,
    async run(s) { await s.open('#/history'); return '.hlist'; },
  },
  {
    name: 'devices-card', about: 'Devices popover with battery levels',
    viewport: [1400, 1000], scale: 2,
    async run(s) { await s.open(); await s.click('#btn-devices'); return '#popover'; },
  },
  {
    name: 'summary-card', about: 'Ride summary after finishing a workout, uploaded to Garmin and Intervals.icu',
    viewport: [1400, 1000], scale: 2, rider: mode('workouts'),
    async run(s) {
      await rideTo(s, TEMPO, 45 * 60 + 30, 30);
      await s.wait('#modal[open]');
      await s.tick(2000);
      return '#modal';
    },
  },
  {
    name: 'settings-card', about: 'Settings → Rider tab',
    viewport: [1400, 1400], scale: 2,
    async run(s) { await s.open(); await s.click('#btn-settings'); await s.click('[data-tab="rider"]'); return '#modal'; },
  },
  {
    name: 'riding-card', about: 'Settings → Riding tab (sounds, ride behaviour, virtual shifting)',
    viewport: [1400, 1400], scale: 2,
    async run(s) { await s.open(); await s.click('#btn-settings'); await s.click('[data-tab="riding"]'); return '#modal'; },
  },
  {
    name: 'sync-card', about: 'Settings → Connections tab (profile sync, Garmin)',
    viewport: [1400, 1400], scale: 2,
    async run(s) { await s.open(); await s.click('#btn-settings'); await s.click('[data-tab="sync"]'); return '#modal'; },
  },
];

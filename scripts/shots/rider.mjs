// Sample rider "Lena" for the screenshots: settings, plan progress, ride history, FTP tests.
// All dates are relative to NOW, the fixed clock time every shot runs at (so "2 days ago" never drifts).

/** Fixed clock for every shot (Playwright page.clock). Monday afternoon, Berlin time. */
export const NOW = '2026-10-19T13:30:00+02:00';
export const TIMEZONE = 'Europe/Berlin';

const at = (days, hh = 18, mm = 14) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hh - 2, mm, 0, 0); // Berlin (CEST) → UTC
  return d.toISOString();
};

const BB = 'base-builder-6wk';
const f = (week, day, name) => `${BB}/Week${String(week).padStart(2, '0')}_Day${String(day).padStart(2, '0')}_${name.replace(/ /g, '_')}.zwo`;

/** One ridden workout as the app stores it in history (see Ride.finish in ui/js/ride/ride.js). */
function ride({ file, plan = BB, title, days, hh, mm, dur, avg, np, hr, cad = 88, garmin = true }) {
  const end = at(days, hh, mm);
  return {
    file, plan, title, startedAt: new Date(Date.parse(end) - dur * 1000).toISOString(), at: end,
    status: 'done', planDuration: dur, doneDuration: dur, completed: true,
    avgPower: avg, np, avgHr: hr, maxHr: hr + 24, avgCadence: cad, kj: Math.round((avg * dur) / 1000),
    fitPath: `/Users/lena/Library/Application Support/zwoTrainer/activities/${end.slice(0, 10)}.fit`,
    distanceKm: Math.round(dur / 100) / 10 * 3,
    ...(garmin ? { garmin: { activityId: 18000000 + days, url: 'https://connect.garmin.com/modern/activity/18000000', at: end } } : {}),
  };
}

export function rider() {
  const history = [
    ride({ file: 'lunch-break-rides/VO2_Ladder.zwo', plan: null, title: 'VO2 Ladder', days: 0, hh: 13, mm: 26, dur: 2700, avg: 198, np: 221, hr: 141, garmin: false }),
    ride({ file: f(2, 1, 'Aerobic Foundation'), title: 'Aerobic Foundation', days: 2, dur: 3720, avg: 170, np: 176, hr: 137 }),
    ride({ file: f(1, 5, 'Sweet Spot 3x12'), title: 'Sweet Spot 3x12', days: 4, dur: 4320, avg: 205, np: 221, hr: 134 }),
    ride({ file: f(1, 3, 'Cadence Builder'), title: 'Cadence Builder', days: 6, dur: 3060, avg: 172, np: 178, hr: 131, cad: 96 }),
    ride({ file: f(1, 1, 'Aerobic Foundation'), title: 'Aerobic Foundation', days: 8, dur: 3720, avg: 168, np: 173, hr: 128 }),
  ];
  const entries = Object.fromEntries(history.filter((h) => h.plan === BB).map((h) => [h.file, { status: 'done', at: h.at, planDuration: h.planDuration, doneDuration: h.doneDuration, completed: true }]));
  const test = (days, ftp, prevFtp, vo2) => ({
    at: at(days, 18, 40), protocol: 'ramp', name: 'Ramp Test', ftp, prevFtp, incomplete: false,
    details: [['Best 1 min', `${Math.round(ftp / 0.75)} W`], ['Last step', `${Math.round(ftp / 0.75) + 8} W`]],
    cp: null, wPrime: null, vo2, vo2abs: Math.round(vo2 * 68) / 1000, weight: 68, accepted: true,
  });
  const now = new Date(NOW).toISOString();
  return {
    id: 'p_lena', name: 'Lena', avatar: { color: '#0ea5c6', emoji: '🚴' }, createdAt: at(120), updatedAt: now,
    settings: {
      ftp: 265, maxHr: 188, weight: 68, zones: [55, 75, 90, 105], bests: { s5: 960, m1: 448, m5: 318, m20: 279 },
      theme: 'system', language: 'en', mode: 'plans', beeps: true, beepDirection: true, endChime: true, autoPause: true,
      coachHints: true, keyboardShortcuts: true, overlay: { power: true, cadence: false, hr: true },
      shifting: { mode: 'ask', difficulty: 'medium' }, zwoDir: '/Users/lena/Training/Workouts',
      devices: { trainer: { id: 't1', name: 'Wahoo KICKR CORE' }, hr: { id: 'h1', name: 'HRM-Pro Plus' }, controllers: [{ id: 'c1', name: 'Zwift Ride (left)' }] },
      garmin: { mode: 'auto', autoOpen: false, folder: null }, services: { intervals: { mode: 'auto' } }, folderKinds: {},
    },
    activePlan: BB,
    plans: { [BB]: { startedAt: at(9), entries } },
    history,
    tests: [test(10, 265, 256, 54.3), test(38, 256, 248, 52.9), test(66, 248, 240, 51.6)],
    favorites: [],
  };
}

/** Everything else the mock answers with (see mock.js). */
export const backend = {
  sync: { provider: 'icloud', dir: '/Users/lena/Library/Mobile Documents/com~apple~CloudDocs/zwoTrainer', auto: true, lastSync: new Date(NOW).toISOString() },
  garmin: { connected: true, name: 'Lena Berg' },
  services: [
    { id: 'intervals', name: 'Intervals.icu', kind: 'apikey', connected: true, account: 'Lena Berg', manualUrl: null, manualZip: false, hint: 'Paste your personal API key from intervals.icu → Settings → Developer Settings.' },
    { id: 'coros', name: 'COROS', kind: 'manual', connected: false, account: null, manualUrl: 'https://t.coros.com', manualZip: true, hint: 'Training Hub → Activity List → Import Data, then choose the highlighted ZIP.' },
  ],
};

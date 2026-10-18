// FTP test protocols and result evaluation.
// Segments use the same shape as parsed ZWO workouts; extra fields:
//   erg: false      → all-out effort: trainer leaves ERG (flat-road sim), rider uses the gears;
//                     p0/p1 are only a pacing guide
//   measure: 'xx'   → marks the effort the result is computed from

const seg = (type, duration, p0, p1 = p0, extra = {}) => ({ type, duration, p0, p1, texts: [], ...extra });
const say = (t, msg) => ({ t, msg });

function finalize(name, segments) {
  let t = 0, block = 0;
  for (const s of segments) {
    block++;
    s.idx = block;
    s.label = String(block);
    s.start = t;
    t += s.duration;
  }
  return { name, author: 'zwoTrainer', description: '', tags: ['FTP TEST'], segments, duration: t };
}

/** Highest average over any `secs`-long window of 1 Hz samples (null if too short). */
export function bestAvg(samples, secs, filter = () => true) {
  const p = samples.filter(filter).map((s) => (s.p != null && s.p > 0 ? s.p : 0));
  if (p.length < secs) return null;
  let sum = 0;
  for (let i = 0; i < secs; i++) sum += p[i];
  let best = sum;
  for (let i = secs; i < p.length; i++) {
    sum += p[i] - p[i - secs];
    if (sum > best) best = sum;
  }
  return Math.round(best / secs);
}

export const PROTOCOLS = [
  {
    id: 'ramp',
    name: 'Ramp Test',
    short: 'Ramp',
    method: 'FTP = 75 % of your best 1-minute power',
    about: 'ERG mode raises the resistance by 20 W every minute after a 5-minute warm-up at 100 W. Keep a steady cadence and ride until you can no longer hold the target — the test ends automatically when you stop. Short, repeatable, no pacing needed.',
    level: 'All riders',
    build: (ftp) => {
      const steps = [];
      const top = Math.max(400, Math.round(ftp * 2.0 / 20) * 20); // well beyond the typical failure point (~FTP / 0.75)
      for (let w = 120; w <= top; w += 20) steps.push(seg('ramp-step', 60, w / ftp, w / ftp, { ramp: true }));
      steps[0].texts.push(say(0, 'Ramp starts — +20 W every minute. Stay seated, steady cadence.'));
      return finalize('Ramp Test', [
        seg('warmup', 300, 100 / ftp, 100 / ftp, { texts: [say(0, 'Easy 5 minutes at 100 W'), say(240, 'Ramp begins in 1 minute')] }),
        ...steps,
      ]);
    },
    evaluate: (samples) => {
      const m1 = bestAvg(samples, 60);
      return m1 && { ftp: Math.round(m1 * 0.75), details: [['Best 1 min', `${m1} W`], ['× 0.75', '']], bests: { m1 } };
    },
  },
  {
    id: 'ramp-lite',
    name: 'Ramp Test Lite',
    short: 'Ramp Lite',
    method: 'FTP = 75 % of your best 1-minute power',
    about: 'Same as the Ramp Test with a gentler slope of +10 W per minute — better suited to lighter riders, beginners or a lower FTP.',
    level: 'Beginners · light riders',
    build: (ftp) => {
      const steps = [];
      const top = Math.max(300, Math.round(ftp * 1.8 / 10) * 10);
      for (let w = 90; w <= top; w += 10) steps.push(seg('ramp-step', 60, w / ftp, w / ftp, { ramp: true }));
      steps[0].texts.push(say(0, 'Ramp starts — +10 W every minute. Stay seated, steady cadence.'));
      return finalize('Ramp Test Lite', [
        seg('warmup', 300, 80 / ftp, 80 / ftp, { texts: [say(0, 'Easy 5 minutes at 80 W'), say(240, 'Ramp begins in 1 minute')] }),
        ...steps,
      ]);
    },
    evaluate: (samples) => PROTOCOLS[0].evaluate(samples),
  },
  {
    id: '20min',
    name: '20-Minute Test',
    short: '20 min',
    method: 'FTP = 95 % of your 20-minute average',
    about: 'The classic protocol from “Training and Racing with a Power Meter” (Allen & Coggan): warm-up with high-cadence spin-ups, a 5-minute all-out effort to clear the legs, recovery, then 20 minutes as hard as you can sustain. The efforts are ridden off ERG — you control the power with your gears.',
    level: 'Experienced riders',
    build: (ftp) => finalize('20-Minute Test', [
      seg('warmup', 1200, 0.65, 0.65, { texts: [say(0, 'Easy warm-up — 20 minutes')] }),
      seg('steady', 60, 0.70, 0.70, { cadence: 110, texts: [say(0, 'Spin-up: high cadence')] }),
      seg('steady', 60, 0.65),
      seg('steady', 60, 0.70, 0.70, { cadence: 110, texts: [say(0, 'Spin-up: high cadence')] }),
      seg('steady', 60, 0.65),
      seg('steady', 60, 0.70, 0.70, { cadence: 110, texts: [say(0, 'Spin-up: high cadence')] }),
      seg('steady', 300, 0.65, 0.65, { texts: [say(240, '5-minute all-out effort in 1 minute — shift into a big gear')] }),
      seg('effort', 300, 1.20, 1.20, { erg: false, texts: [say(0, '5 min ALL OUT — use your gears')] }),
      seg('steady', 600, 0.65, 0.65, { texts: [say(0, 'Recover — easy spinning'), say(540, '20-minute test in 1 minute')] }),
      seg('effort', 1200, 1.05, 1.05, { erg: false, measure: '20', texts: [say(0, '20 min — hardest pace you can hold. Start controlled!'), say(600, 'Halfway — hold it'), say(1080, 'Last 2 minutes — empty the tank')] }),
      seg('cooldown', 600, 0.60, 0.45, { texts: [say(0, 'Done! Cool down')] }),
    ]),
    evaluate: (samples) => {
      const m20 = bestAvg(samples, 1200, (s) => s.measure === '20') ?? bestAvg(samples, 1200);
      const m5 = bestAvg(samples, 300);
      return m20 && { ftp: Math.round(m20 * 0.95), details: [['20-min average', `${m20} W`], ['× 0.95', '']], bests: { m20, m5 } };
    },
  },
  {
    id: '8min',
    name: '8-Minute Test',
    short: '2 × 8 min',
    method: 'FTP = 90 % of the better 8-minute effort',
    about: 'Two 8-minute all-out efforts with 10 minutes of recovery in between (CTS protocol). Shorter and mentally easier than the 20-minute test. Efforts are ridden off ERG with your gears.',
    level: 'Intermediate',
    build: () => finalize('8-Minute Test', [
      seg('warmup', 600, 0.50, 0.75, { texts: [say(0, 'Warm-up — 10 minutes, building gradually'), say(540, 'First effort in 1 minute')] }),
      seg('effort', 480, 1.08, 1.08, { erg: false, measure: 'a', texts: [say(0, 'Effort 1: 8 min ALL OUT — use your gears'), say(420, 'Last minute!')] }),
      seg('steady', 600, 0.50, 0.50, { texts: [say(0, 'Recover — easy spinning'), say(540, 'Second effort in 1 minute')] }),
      seg('effort', 480, 1.08, 1.08, { erg: false, measure: 'b', texts: [say(0, 'Effort 2: 8 min ALL OUT'), say(420, 'Last minute!')] }),
      seg('cooldown', 600, 0.55, 0.40, { texts: [say(0, 'Done! Cool down')] }),
    ]),
    evaluate: (samples) => {
      const a = bestAvg(samples, 480, (s) => s.measure === 'a');
      const b = bestAvg(samples, 480, (s) => s.measure === 'b');
      const best = Math.max(a || 0, b || 0) || bestAvg(samples, 480);
      return best && { ftp: Math.round(best * 0.9), details: [['Effort 1', a ? `${a} W` : '–'], ['Effort 2', b ? `${b} W` : '–'], ['Better × 0.90', `${best} W`]], bests: {} };
    },
  },
  {
    id: 'profile',
    name: 'Power Profile Test',
    short: 'Profile',
    method: 'FTP = 95 % of 20 min · plus 5 s / 1 min / 5 min bests, CP and W′',
    about: 'The do-it-yourself performance test from Germany’s TOUR magazine: an 8-second sprint, then 1-minute, 5-minute and 20-minute maximal efforts, each with full recovery. Gives your FTP plus a complete power profile, Critical Power and anaerobic work capacity (W′) via Monod & Scherrer. Efforts are ridden off ERG.',
    level: 'Advanced · ~90 min',
    build: () => finalize('Power Profile Test', [
      seg('warmup', 720, 0.55, 0.55, { texts: [say(0, 'Warm-up — 12 minutes easy')] }),
      seg('steady', 10, 0.80), seg('steady', 230, 0.55),
      seg('steady', 10, 0.80), seg('steady', 200, 0.55, 0.55, { texts: [say(170, 'Sprint coming — get ready')] }),
      seg('steady', 30, 0.70),
      seg('effort', 8, 2.00, 2.00, { erg: false, measure: 's5', texts: [say(0, 'SPRINT! 8 seconds flat out')] }),
      seg('steady', 570, 0.55, 0.55, { texts: [say(0, 'Recover'), say(540, '1-minute effort coming')] }),
      seg('steady', 30, 0.70),
      seg('effort', 60, 1.50, 1.50, { erg: false, measure: 'm1', texts: [say(0, '1 minute ALL OUT')] }),
      seg('steady', 570, 0.55, 0.55, { texts: [say(0, 'Recover'), say(540, '5-minute effort coming')] }),
      seg('steady', 30, 0.70),
      seg('effort', 300, 1.30, 1.30, { erg: false, measure: 'm5', texts: [say(0, '5 minutes ALL OUT'), say(240, 'Last minute!')] }),
      seg('steady', 570, 0.55, 0.55, { texts: [say(0, 'Recover'), say(540, '20-minute effort coming')] }),
      seg('steady', 30, 0.70),
      seg('effort', 1200, 1.05, 1.05, { erg: false, measure: 'm20', texts: [say(0, '20 minutes — hardest pace you can hold'), say(600, 'Halfway'), say(1080, 'Last 2 minutes!')] }),
      seg('cooldown', 600, 0.50, 0.40, { texts: [say(0, 'Done! Cool down')] }),
    ]),
    evaluate: (samples) => {
      const s5 = bestAvg(samples, 5);
      const m1 = bestAvg(samples, 60);
      const m5 = bestAvg(samples, 300);
      const m20 = bestAvg(samples, 1200, (s) => s.measure === 'm20') ?? bestAvg(samples, 1200);
      if (!m20) return m5 ? { ftp: null, details: [['5 s', `${s5} W`], ['1 min', `${m1} W`], ['5 min', `${m5} W`], ['20 min', 'not completed']], bests: { s5, m1, m5 } } : null;
      // Monod & Scherrer two-parameter model from the 5- and 20-minute efforts
      const cp = Math.round((m20 * 1200 - m5 * 300) / 900);
      const wPrime = Math.round(((m5 - cp) * 300) / 100) / 10; // kJ
      return {
        ftp: Math.round(m20 * 0.95),
        details: [['5 s', `${s5} W`], ['1 min', `${m1} W`], ['5 min', `${m5} W`], ['20 min', `${m20} W`], ['Critical Power', `${cp} W`], ['W′ (AWC)', `${wPrime} kJ`]],
        bests: { s5, m1, m5, m20 }, cp, wPrime,
      };
    },
  },
];

export const protocolById = (id) => PROTOCOLS.find((p) => p.id === id);

// ------------------------------------------------------------------ VO2max
/**
 * VO2max estimates (need body weight):
 *  - from the power you can hold for ~8 min,
 *    using the ACSM leg-cycling equation  VO2 = 10.8 · W/kg + 7  [ml/kg/min]
 *  - from ramp-test peak power (PPO) with Hawley & Noakes (1992)  VO2 = 0.01141 · PPO + 0.435  [L/min]
 */
export function vo2max(basis, kg) {
  if (!basis || !kg) return null;
  if (basis.method === 'p8') {
    const rel = 10.8 * (basis.power / kg) + 7;
    return { rel: Math.round(rel * 10) / 10, abs: Math.round(rel * kg / 100) / 10, method: `ACSM from ${basis.power} W (8-min power)` };
  }
  if (basis.method === 'ppo') {
    const abs = 0.01141 * basis.power + 0.435;
    return { rel: Math.round((abs * 1000 / kg) * 10) / 10, abs: Math.round(abs * 10) / 10, method: `Hawley & Noakes from ${basis.power} W ramp peak power` };
  }
  return null;
}

/** Critical Power model (Monod & Scherrer) from two maximal efforts (t in s). */
export function cpModel(p1, t1, p2, t2) {
  if (!p1 || !p2 || t1 === t2) return null;
  const cp = (p2 * t2 - p1 * t1) / (t2 - t1);
  const wPrime = (p1 - cp) * t1; // J
  if (cp <= 0 || wPrime <= 0) return null;
  return { cp: Math.round(cp), wPrime: Math.round(wPrime / 100) / 10, p8: Math.round(cp + wPrime / 480) };
}

// add VO2max bases to the built-in protocols
const withVo2 = {
  ramp: (r, s) => r && { ...r, vo2: { method: 'ppo', power: r.bests.m1 } },
  'ramp-lite': (r) => r && { ...r, vo2: { method: 'ppo', power: r.bests.m1 } },
  '20min': (r) => {
    if (!r) return r;
    const m = cpModel(r.bests.m5, 300, r.bests.m20, 1200);
    return m ? { ...r, cp: m.cp, wPrime: m.wPrime, vo2: { method: 'p8', power: m.p8 }, details: [...r.details, ['Critical Power (5 + 20 min)', `${m.cp} W`]] } : r;
  },
  '8min': (r, samples) => {
    if (!r) return r;
    const best = Math.round(r.ftp / 0.9);
    return { ...r, vo2: { method: 'p8', power: best }, bests: { ...r.bests, m5: bestAvg(samples, 300) } };
  },
  profile: (r) => (r && r.cp ? { ...r, vo2: { method: 'p8', power: Math.round(r.cp + (r.wPrime * 1000) / 480) } } : r),
};
for (const p of PROTOCOLS) {
  const ev = p.evaluate;
  p.evaluate = (samples) => withVo2[p.id](ev(samples), samples);
}

// ------------------------------------------------------------------ tests in the library
const TEST_RE = /ftp[ _-]*test|ramp[ _-]*test|crit(ical)?[ _-]*power[ _-]*test|power[ _-]*test|best[ _-]*effort|benchmark|verification[ _-]*test/i;

/** Library ZWO files whose theme is a test (title or name). */
export const isTestWorkout = (w) => TEST_RE.test(`${w.title} ${w.name}`);

/** Effort detection, Zwift convention: max efforts are free-ride blocks; exported files sometimes
 *  carry a ≥10-min block at ≥100 % FTP instead — that one must be ridden all-out too, not in ERG. */
const isEffort = (dur, p0, kind) => (p0 === null && kind !== 'warmup' && dur >= 60) || (p0 !== null && p0 >= 1.0 && dur >= 600);

/** Classify a library test from its compact profile [[dur, p0, p1], …]. */
export function classifyTest(profile, title) {
  const efforts = profile.filter(([d, p0]) => isEffort(d, p0)).map(([d]) => d);
  const longest = Math.max(0, ...efforts);
  const hasRamp = (() => { // ≥5 consecutive rising steps of ≤ 3 min
    let run = 0;
    for (let i = 1; i < profile.length; i++) {
      const [d, a] = profile[i], [, b] = profile[i - 1];
      run = a !== null && b !== null && a > b && d <= 180 ? run + 1 : 0;
      if (run >= 5) return true;
    }
    return false;
  })();
  if (/ramp/i.test(title) && !hasRamp) return { kind: 'broken-ramp', label: 'Ramp missing in file → built-in Ramp Test', lite: /lite/i.test(title) };
  if (hasRamp) return { kind: 'ramp', label: 'Ramp · 75 % of best 1 min' };
  if (longest >= 1140) return { kind: '20', label: '20-min effort · 95 %' };
  if (longest >= 480) return { kind: '8', label: `${Math.round(longest / 60)}-min effort · 90 %` };
  if (efforts.length) return { kind: 'bests', label: `${efforts.length} effort${efforts.length > 1 ? 's' : ''} · power bests` };
  return { kind: 'bests', label: 'Power bests' };
}

/** Prepare a library test workout for riding: efforts leave ERG and are tagged for evaluation. */
export function prepareTestWorkout(workout) {
  const segments = workout.segments.map((s, i) => (isEffort(s.duration, s.p0, s.type)
    ? { ...s, erg: false, measure: `e${i}`, texts: s.texts.length ? s.texts : [{ t: 0, msg: `${Math.round(s.duration / 60) || s.duration + ' s'}${s.duration >= 60 ? ' min' : ''} ALL OUT — use your gears` }] }
    : s));
  return { ...workout, segments };
}

/** Evaluate a library test from the efforts actually ridden. */
export function evaluateGeneric(samples, workout) {
  const efforts = workout.segments
    .filter((s) => s.measure)
    .map((s) => ({ dur: s.duration, power: bestAvg(samples, Math.min(s.duration, samples.filter((x) => x.measure === s.measure).length || 1), (x) => x.measure === s.measure), ridden: samples.filter((x) => x.measure === s.measure).length }))
    .filter((e) => e.power && e.ridden >= e.dur * 0.9);
  const bests = { s5: bestAvg(samples, 5), m1: bestAvg(samples, 60), m5: bestAvg(samples, 300), m20: bestAvg(samples, 1200) };
  const details = efforts.map((e) => [`${e.dur >= 60 ? `${Math.round(e.dur / 60)}-min` : `${e.dur}-s`} effort`, `${e.power} W`]);
  const long = efforts.filter((e) => e.dur >= 1140).sort((a, b) => b.power - a.power)[0];
  const mid = efforts.filter((e) => e.dur >= 480 && e.dur < 1140).sort((a, b) => b.power - a.power)[0];
  const short = efforts.filter((e) => e.dur >= 150 && e.dur <= 420).sort((a, b) => b.power - a.power)[0];
  let ftp = null, method = '';
  if (long) { ftp = Math.round(long.power * 0.95); method = '95 % of the 20-min effort'; }
  else if (mid) { ftp = Math.round(mid.power * 0.9); method = `90 % of the ${Math.round(mid.dur / 60)}-min effort`; }
  else if (workout.segments.filter((s) => s.p0 !== null).some((s, i, a) => i > 4 && a.slice(i - 5, i + 1).every((x, j, arr) => j === 0 || x.p0 > arr[j - 1].p0)) && bests.m1) {
    ftp = Math.round(bests.m1 * 0.75); method = '75 % of best 1 min (ramp)';
  }
  if (method) details.push(['Method', method]);
  let cp = null, wPrime = null, vo2 = null;
  const other = long || mid;
  if (short && other) {
    const m = cpModel(short.power, short.dur, other.power, other.dur);
    if (m) { cp = m.cp; wPrime = m.wPrime; vo2 = { method: 'p8', power: m.p8 }; details.push(['Critical Power', `${m.cp} W`], ['W′ (AWC)', `${m.wPrime} kJ`]); }
  }
  if (!vo2 && mid && mid.dur <= 600) vo2 = { method: 'p8', power: mid.power };
  if (!vo2 && method.includes('ramp')) vo2 = { method: 'ppo', power: bests.m1 };
  if (!ftp && !efforts.length && !bests.m1) return null;
  if (!ftp) details.push(['FTP', 'needs a ≥ 8-min all-out effort — bests saved']);
  const clean = Object.fromEntries(Object.entries(bests).filter(([, v]) => v));
  return { ftp, details, bests: clean, cp, wPrime, vo2 };
}

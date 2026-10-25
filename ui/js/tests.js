// FTP test protocols and result evaluation. Every text is looked up in the UI language when it's
// needed (protocol names and descriptions are getters; messages are built when a test starts).
import { t } from './i18n/index.js';
// Segments use the same shape as parsed ZWO workouts; extra fields:
//   erg: false      → all-out effort: trainer leaves ERG (flat-road sim), rider uses the gears;
//                     p0/p1 are only a pacing guide
//   measure: 'xx'   → marks the effort the result is computed from

const seg = (type, duration, p0, p1 = p0, extra = {}) => ({ type, duration, p0, p1, texts: [], ...extra });
const say = (at, msg) => ({ t: at, msg });

function finalize(name, segments) {
  let at = 0, block = 0;
  for (const s of segments) {
    block++;
    s.idx = block;
    s.label = String(block);
    s.start = at;
    at += s.duration;
  }
  return { name, author: 'zwoTrainer', description: '', tags: ['FTP TEST'], segments, duration: at };
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

/** An effort counts as completed when at least this share of it was ridden. */
export const COMPLETE = 0.95;
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** Power of one tagged effort: { power, ridden, dur, done }. power is only set when the effort was
 *  completed — an abandoned effort must never turn into a (too low) FTP. */
export function effort(samples, tag, dur) {
  const ridden = samples.filter((s) => s.measure === tag).length;
  const done = ridden >= dur * COMPLETE;
  return { ridden, dur, done, power: done ? bestAvg(samples, Math.min(dur, ridden), (s) => s.measure === tag) : null };
}

/** Result for a test whose FTP effort was not completed: no FTP, an explanation, bests kept. */
function incomplete(label, e, bests = {}, extra = []) {
  const Label = label[0].toUpperCase() + label.slice(1);
  const text = e.ridden ? t('incRode', { ridden: mmss(e.ridden), label, Label }) : t('incNotReached', { label, Label });
  return {
    ftp: null,
    incomplete: { label, ridden: e.ridden, needed: e.dur, text },
    details: [[Label, e.ridden ? t('notCompletedOf', { ridden: mmss(e.ridden), dur: mmss(e.dur) }) : t('notReached')], ...extra],
    bests,
  };
}

export const PROTOCOLS = [
  {
    id: 'ramp',
    get name() { return t('p.ramp.name'); },
    get short() { return t('p.ramp.short'); },
    get method() { return t('p.ramp.method'); },
    get about() { return t('p.ramp.about'); },
    get level() { return t('p.ramp.level'); },
    build: (ftp) => {
      const steps = [];
      const top = Math.max(400, Math.round(ftp * 2.0 / 20) * 20); // well beyond the typical failure point (~FTP / 0.75)
      for (let w = 120; w <= top; w += 20) steps.push(seg('ramp-step', 60, w / ftp, w / ftp, { ramp: true, measure: 'ramp' }));
      steps[0].texts.push(say(0, t('tm.rampStarts', { w: 20 })));
      return finalize(t('p.ramp.name'), [
        seg('warmup', 300, 100 / ftp, 100 / ftp, { texts: [say(0, t('tm.easy5', { w: 100 })), say(240, t('tm.rampIn1'))] }),
        ...steps,
      ]);
    },
    evaluate: (samples) => {
      // the ramp ends when you can't go on, so any ramp ≥ 1 minute is a valid test — but the
      // best minute must come from the ramp itself, not from the warm-up
      const ridden = samples.filter((s) => s.measure === 'ramp').length;
      if (ridden < 60) {
        const r = incomplete(t('rampNoun'), { ridden, dur: 60 });
        if (ridden) {
          r.incomplete.text = t('rampStoppedText', { time: mmss(ridden) });
          r.details = [[t('segRamp'), t('stoppedAfter', { time: mmss(ridden) })]];
        }
        return r;
      }
      const m1 = bestAvg(samples, 60, (s) => s.measure === 'ramp');
      return m1 && { ftp: Math.round(m1 * 0.75), details: [[t('best1min'), `${m1} W`], ['× 0.75', ''], [t('rampRidden'), mmss(ridden)]], bests: { m1 } };
    },
  },
  {
    id: 'ramp-lite',
    get name() { return t('p.rampLite.name'); },
    get short() { return t('p.rampLite.short'); },
    get method() { return t('p.rampLite.method'); },
    get about() { return t('p.rampLite.about'); },
    get level() { return t('p.rampLite.level'); },
    build: (ftp) => {
      const steps = [];
      const top = Math.max(300, Math.round(ftp * 1.8 / 10) * 10);
      for (let w = 90; w <= top; w += 10) steps.push(seg('ramp-step', 60, w / ftp, w / ftp, { ramp: true, measure: 'ramp' }));
      steps[0].texts.push(say(0, t('tm.rampStarts', { w: 10 })));
      return finalize(t('p.rampLite.name'), [
        seg('warmup', 300, 80 / ftp, 80 / ftp, { texts: [say(0, t('tm.easy5', { w: 80 })), say(240, t('tm.rampIn1'))] }),
        ...steps,
      ]);
    },
    evaluate: (samples) => PROTOCOLS[0].evaluate(samples),
  },
  {
    id: '20min',
    get name() { return t('p.m20.name'); },
    get short() { return t('p.m20.short'); },
    get method() { return t('p.m20.method'); },
    get about() { return t('p.m20.about'); },
    get level() { return t('p.m20.level'); },
    build: () => finalize(t('p.m20.name'), [
      seg('warmup', 1200, 0.65, 0.65, { texts: [say(0, t('tm.easyWarmup20'))] }),
      seg('steady', 60, 0.70, 0.70, { cadence: 110, texts: [say(0, t('tm.spinUp'))] }),
      seg('steady', 60, 0.65),
      seg('steady', 60, 0.70, 0.70, { cadence: 110, texts: [say(0, t('tm.spinUp'))] }),
      seg('steady', 60, 0.65),
      seg('steady', 60, 0.70, 0.70, { cadence: 110, texts: [say(0, t('tm.spinUp'))] }),
      seg('steady', 300, 0.65, 0.65, { texts: [say(240, t('tm.allOut5In1'))] }),
      seg('effort', 300, 1.20, 1.20, { erg: false, texts: [say(0, t('tm.allOut5'))] }),
      seg('steady', 600, 0.65, 0.65, { texts: [say(0, t('tm.recover')), say(540, t('tm.test20In1'))] }),
      seg('effort', 1200, 1.05, 1.05, { erg: false, measure: '20', texts: [say(0, t('tm.go20')), say(600, t('tm.halfwayHold')), say(1080, t('tm.last2Empty'))] }),
      seg('cooldown', 600, 0.60, 0.45, { texts: [say(0, t('tm.doneCool'))] }),
    ]),
    evaluate: (samples) => {
      const m5 = bestAvg(samples, 300);
      const e = effort(samples, '20', 1200);
      if (!e.done) return incomplete(t('effMin', { n: 20 }), e, { m5 }, m5 ? [[t('best5min'), `${m5} W`]] : []);
      return { ftp: Math.round(e.power * 0.95), details: [[t('avg20min'), `${e.power} W`], ['× 0.95', '']], bests: { m20: e.power, m5 } };
    },
  },
  {
    id: '8min',
    get name() { return t('p.m8.name'); },
    get short() { return t('p.m8.short'); },
    get method() { return t('p.m8.method'); },
    get about() { return t('p.m8.about'); },
    get level() { return t('p.m8.level'); },
    build: () => finalize(t('p.m8.name'), [
      seg('warmup', 600, 0.50, 0.75, { texts: [say(0, t('tm.warmup10')), say(540, t('tm.firstIn1'))] }),
      seg('effort', 480, 1.08, 1.08, { erg: false, measure: 'a', texts: [say(0, t('tm.effort1')), say(420, t('tm.lastMinute'))] }),
      seg('steady', 600, 0.50, 0.50, { texts: [say(0, t('tm.recover')), say(540, t('tm.secondIn1'))] }),
      seg('effort', 480, 1.08, 1.08, { erg: false, measure: 'b', texts: [say(0, t('tm.effort2')), say(420, t('tm.lastMinute'))] }),
      seg('cooldown', 600, 0.55, 0.40, { texts: [say(0, t('tm.doneCool'))] }),
    ]),
    evaluate: (samples) => {
      const a = effort(samples, 'a', 480);
      const b = effort(samples, 'b', 480);
      const show = (e) => (e.done ? `${e.power} W` : e.ridden ? t('notCompletedOf', { ridden: mmss(e.ridden), dur: '8:00' }) : t('notRidden'));
      const best = Math.max(a.power || 0, b.power || 0);
      if (!best) {
        const r = incomplete(t('effMin', { n: 8 }), a.ridden >= b.ridden ? a : b);
        r.details = [[t('effortN', { n: 1 }), show(a)], [t('effortN', { n: 2 }), show(b)]];
        if (a.ridden && b.ridden) r.incomplete.text = t('neither8');
        return r;
      }
      return { ftp: Math.round(best * 0.9), details: [[t('effortN', { n: 1 }), show(a)], [t('effortN', { n: 2 }), show(b)], [t('better090'), `${best} W`]], bests: {} };
    },
  },
  {
    id: 'profile',
    get name() { return t('p.profile.name'); },
    get short() { return t('p.profile.short'); },
    get method() { return t('p.profile.method'); },
    get about() { return t('p.profile.about'); },
    get level() { return t('p.profile.level'); },
    build: () => finalize(t('p.profile.name'), [
      seg('warmup', 720, 0.55, 0.55, { texts: [say(0, t('tm.warmup12'))] }),
      seg('steady', 10, 0.80), seg('steady', 230, 0.55),
      seg('steady', 10, 0.80), seg('steady', 200, 0.55, 0.55, { texts: [say(170, t('tm.sprintComing'))] }),
      seg('steady', 30, 0.70),
      seg('effort', 8, 2.00, 2.00, { erg: false, measure: 's5', texts: [say(0, t('tm.sprint'))] }),
      seg('steady', 570, 0.55, 0.55, { texts: [say(0, t('tm.recoverShort')), say(540, t('tm.effortComing', { what: t('effMin', { n: 1 }) }))] }),
      seg('steady', 30, 0.70),
      seg('effort', 60, 1.50, 1.50, { erg: false, measure: 'm1', texts: [say(0, t('tm.allOut1'))] }),
      seg('steady', 570, 0.55, 0.55, { texts: [say(0, t('tm.recoverShort')), say(540, t('tm.effortComing', { what: t('effMin', { n: 5 }) }))] }),
      seg('steady', 30, 0.70),
      seg('effort', 300, 1.30, 1.30, { erg: false, measure: 'm5', texts: [say(0, t('tm.allOut5min')), say(240, t('tm.lastMinute'))] }),
      seg('steady', 570, 0.55, 0.55, { texts: [say(0, t('tm.recoverShort')), say(540, t('tm.effortComing', { what: t('effMin', { n: 20 }) }))] }),
      seg('steady', 30, 0.70),
      seg('effort', 1200, 1.05, 1.05, { erg: false, measure: 'm20', texts: [say(0, t('tm.go20min')), say(600, t('tm.halfway')), say(1080, t('tm.last2'))] }),
      seg('cooldown', 600, 0.50, 0.40, { texts: [say(0, t('tm.doneCool'))] }),
    ]),
    evaluate: (samples) => {
      const s5 = bestAvg(samples, 5);
      const m1 = bestAvg(samples, 60);
      const m5 = bestAvg(samples, 300);
      const e20 = effort(samples, 'm20', 1200);
      const m20 = e20.power;
      if (!e20.done) {
        const extra = [['5 s', s5 ? `${s5} W` : '–'], ['1 min', m1 ? `${m1} W` : '–'], ['5 min', m5 ? `${m5} W` : '–']].filter(([, v]) => v !== '–');
        return incomplete(t('effMin', { n: 20 }), e20, Object.fromEntries(Object.entries({ s5, m1, m5 }).filter(([, v]) => v)), extra);
      }
      // Monod & Scherrer two-parameter model from the 5- and 20-minute efforts
      const cp = Math.round((m20 * 1200 - m5 * 300) / 900);
      const wPrime = Math.round(((m5 - cp) * 300) / 100) / 10; // kJ
      return {
        ftp: Math.round(m20 * 0.95),
        details: [['5 s', `${s5} W`], ['1 min', `${m1} W`], ['5 min', `${m5} W`], ['20 min', `${m20} W`], [t('criticalPower'), `${cp} W`], [t('wPrime'), `${wPrime} kJ`]],
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
    return { rel: Math.round(rel * 10) / 10, abs: Math.round(rel * kg / 100) / 10, method: t('vo2Acsm', { w: basis.power }) };
  }
  if (basis.method === 'ppo') {
    const abs = 0.01141 * basis.power + 0.435;
    return { rel: Math.round((abs * 1000 / kg) * 10) / 10, abs: Math.round(abs * 10) / 10, method: t('vo2Hawley', { w: basis.power }) };
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
  ramp: (r) => (r?.ftp ? { ...r, vo2: { method: 'ppo', power: r.bests.m1 } } : r),
  'ramp-lite': (r) => (r?.ftp ? { ...r, vo2: { method: 'ppo', power: r.bests.m1 } } : r),
  '20min': (r) => {
    if (!r?.ftp) return r;
    const m = cpModel(r.bests.m5, 300, r.bests.m20, 1200);
    return m ? { ...r, cp: m.cp, wPrime: m.wPrime, vo2: { method: 'p8', power: m.p8 }, details: [...r.details, [t('cp520'), `${m.cp} W`]] } : r;
  },
  '8min': (r, samples) => {
    if (!r?.ftp) return r;
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
  if (/ramp/i.test(title) && !hasRamp) return { kind: 'broken-ramp', label: t('clsBrokenRamp'), lite: /lite/i.test(title) };
  if (hasRamp) return { kind: 'ramp', label: t('clsRamp') };
  if (longest >= 1140) return { kind: '20', label: `${t('effMinShort', { n: 20 })} · 95 %` };
  if (longest >= 480) return { kind: '8', label: `${t('effMinShort', { n: Math.round(longest / 60) })} · 90 %` };
  if (efforts.length) return { kind: 'bests', label: t('clsEfforts', { n: efforts.length }) };
  return { kind: 'bests', label: t('powerBests') };
}

/** Prepare a library test workout for riding: efforts leave ERG and are tagged for evaluation. */
export function prepareTestWorkout(workout) {
  const segments = workout.segments.map((s, i) => (isEffort(s.duration, s.p0, s.type)
    ? { ...s, erg: false, measure: `e${i}`, texts: s.texts.length ? s.texts : [{ t: 0, msg: t('tm.allOutGears', { dur: s.duration >= 60 ? `${Math.round(s.duration / 60)} min` : `${s.duration} s` }) }] }
    : s));
  return { ...workout, segments };
}

/** Evaluate a library test from the efforts actually ridden. */
export function evaluateGeneric(samples, workout) {
  const all = workout.segments.filter((s) => s.measure).map((s) => effort(samples, s.measure, s.duration));
  const efforts = all.filter((e) => e.done && e.power).map((e) => ({ dur: e.dur, power: e.power, ridden: e.ridden }));
  // the longest FTP-relevant effort (≥ 8 min) that was started but abandoned
  const abandoned = all.filter((e) => !e.done && e.ridden > 0 && e.dur >= 480).sort((a, b) => b.dur - a.dur)[0];
  const bests = { s5: bestAvg(samples, 5), m1: bestAvg(samples, 60), m5: bestAvg(samples, 300), m20: bestAvg(samples, 1200) };
  const details = efforts.map((e) => [e.dur >= 60 ? t('effMinShort', { n: Math.round(e.dur / 60) }) : t('effSecShort', { n: e.dur }), `${e.power} W`]);
  const long = efforts.filter((e) => e.dur >= 1140).sort((a, b) => b.power - a.power)[0];
  const mid = efforts.filter((e) => e.dur >= 480 && e.dur < 1140).sort((a, b) => b.power - a.power)[0];
  const short = efforts.filter((e) => e.dur >= 150 && e.dur <= 420).sort((a, b) => b.power - a.power)[0];
  let ftp = null, method = '', isRamp = false;
  if (long) { ftp = Math.round(long.power * 0.95); method = t('method95', { n: 20 }); }
  else if (mid) { ftp = Math.round(mid.power * 0.9); method = t('method90', { n: Math.round(mid.dur / 60) }); }
  else if (workout.segments.filter((s) => s.p0 !== null).some((s, i, a) => i > 4 && a.slice(i - 5, i + 1).every((x, j, arr) => j === 0 || x.p0 > arr[j - 1].p0)) && bests.m1) {
    ftp = Math.round(bests.m1 * 0.75); method = t('method75'); isRamp = true;
  }
  if (method) details.push([t('method'), method]);
  let cp = null, wPrime = null, vo2 = null;
  const other = long || mid;
  if (short && other) {
    const m = cpModel(short.power, short.dur, other.power, other.dur);
    if (m) { cp = m.cp; wPrime = m.wPrime; vo2 = { method: 'p8', power: m.p8 }; details.push([t('criticalPower'), `${m.cp} W`], [t('wPrime'), `${m.wPrime} kJ`]); }
  }
  if (!vo2 && mid && mid.dur <= 600) vo2 = { method: 'p8', power: mid.power };
  if (!vo2 && isRamp) vo2 = { method: 'ppo', power: bests.m1 };
  const clean = Object.fromEntries(Object.entries(bests).filter(([, v]) => v));
  if (!ftp && abandoned) {
    const r = incomplete(t('effMin', { n: Math.round(abandoned.dur / 60) }), abandoned, clean, details);
    return { ...r, cp, wPrime, vo2 };
  }
  if (!ftp && !efforts.length && !bests.m1) return null;
  if (!ftp) details.push(['FTP', t('needs8min')]);
  return { ftp, details, bests: clean, cp, wPrime, vo2 };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOLS, protocolById, bestAvg, effort, COMPLETE, cpModel, vo2max,
  classifyTest, isTestWorkout, prepareTestWorkout, evaluateGeneric,
} from '../ui/js/tests.js';

// 1 Hz samples shaped like the ones Ride.tick records ({ t, p, c, hr, …, measure }).
// `parts` is a list of [seconds, watts, measure tag?]; watts may be null (no power reading).
function samples(...parts) {
  const out = [];
  for (const [secs, p, measure] of parts) {
    for (let i = 0; i < secs; i++) out.push({ t: out.length, p, c: 90, hr: 150, measure });
  }
  return out;
}

/** Ride a built workout exactly at its targets (watts = p × ftp, ramps interpolated). */
function rideAtTarget(workout, ftp) {
  const out = [];
  for (const s of workout.segments) {
    for (let i = 0; i < s.duration; i++) {
      const f = s.p0 + ((s.p1 ?? s.p0) - s.p0) * (i / s.duration);
      out.push({ t: out.length, p: Math.round(f * ftp), measure: s.measure });
    }
  }
  return out;
}

const ramp = protocolById('ramp');
const rampLite = protocolById('ramp-lite');
const m20 = protocolById('20min');
const m8 = protocolById('8min');
const profile = protocolById('profile');

// ------------------------------------------------------------------ helpers

test('bestAvg: best rolling average, null when too short, missing power counts as 0', () => {
  const s = samples([10, 100], [5, 400], [10, 100]);
  assert.equal(bestAvg(s, 5), 400);
  assert.equal(bestAvg(s, 25), 160);
  assert.equal(bestAvg(s, 26), null);
  assert.equal(bestAvg(samples([4, 200], [2, null], [4, 200]), 10), 160);
  assert.equal(bestAvg(samples([5, -50]), 5), 0);
  assert.equal(bestAvg(samples([10, 300], [10, 200, 'x']), 5, (x) => x.measure === 'x'), 200);
});

test('effort: power only when at least COMPLETE (95 %) of the effort was ridden', () => {
  assert.equal(COMPLETE, 0.95);
  const done = effort(samples([95, 300, 'e']), 'e', 100);
  assert.deepEqual(done, { ridden: 95, dur: 100, done: true, power: 300 });
  const short = effort(samples([94, 300, 'e']), 'e', 100);
  assert.deepEqual(short, { ridden: 94, dur: 100, done: false, power: null });
  assert.deepEqual(effort([], 'e', 100), { ridden: 0, dur: 100, done: false, power: null });
});

test('effort: only tagged samples count, the rest of the ride never fills in', () => {
  const s = samples([3600, 400], [100, 250, 'e'], [600, 400]);
  assert.equal(effort(s, 'e', 100).power, 250);
  assert.equal(effort(s, 'other', 100).power, null);
});

test('effort: stops inside the effort count as 0 W', () => {
  const s = samples([50, 300, 'e'], [10, null, 'e'], [40, 300, 'e']);
  assert.equal(effort(s, 'e', 100).power, 270);
});

// ------------------------------------------------------------------ built-in protocols

test('every protocol, ridden at its targets, gives an FTP from its own tagged efforts', () => {
  for (const p of PROTOCOLS) {
    const w = p.build(250);
    assert.ok(w.segments.some((s) => s.measure), `${p.id} has measured segments`);
    assert.equal(w.duration, w.segments.reduce((a, s) => a + s.duration, 0), `${p.id} duration`);
    const r = p.evaluate(rideAtTarget(w, 250));
    assert.ok(r && r.ftp > 0, `${p.id} gives an FTP`);
    assert.equal(r.incomplete, undefined, `${p.id} is complete`);
  }
});

test('ramp: 75 % of the best ramp minute, peak power as VO2max basis', () => {
  // warm-up at 100 W, then 1-minute steps 120, 140, … 320 W, then the rider fails
  const steps = [];
  for (let w = 120; w <= 320; w += 20) steps.push([60, w, 'ramp']);
  const r = ramp.evaluate(samples([300, 100], ...steps, [20, 340, 'ramp']));
  assert.equal(r.ftp, 245); // 0.75 × 327
  assert.deepEqual(r.bests, { m1: 327 }); // last 40 s at 320 W + 20 s at 340 W
  assert.deepEqual(r.vo2, { method: 'ppo', power: 327 });
  assert.deepEqual(r.details.at(-1), ['Ramp ridden', '11:20']);
});

test('ramp: the warm-up never counts, even when it is harder than the ramp', () => {
  const r = ramp.evaluate(samples([300, 500], [60, 120, 'ramp'], [60, 140, 'ramp']));
  assert.equal(r.bests.m1, 140);
  assert.equal(r.ftp, 105);
});

test('ramp: less than 1 minute of ramp is incomplete', () => {
  const r = ramp.evaluate(samples([300, 100], [45, 120, 'ramp']));
  assert.equal(r.ftp, null);
  assert.equal(r.incomplete.label, 'ramp');
  assert.equal(r.incomplete.ridden, 45);
  assert.equal(r.incomplete.needed, 60);
  assert.match(r.incomplete.text, /stopped after 0:45/);
  assert.equal(r.vo2, undefined);

  const none = ramp.evaluate(samples([300, 300]));
  assert.equal(none.ftp, null);
  assert.deepEqual({ ...none.incomplete, text: undefined }, { label: 'ramp', ridden: 0, needed: 60, text: undefined });
  assert.equal(none.incomplete.text, 'The ramp wasn\'t reached.');
});

test('ramp lite: evaluated like the ramp', () => {
  const s = samples([300, 80], [60, 200, 'ramp'], [60, 300, 'ramp']);
  assert.equal(rampLite.evaluate(s).ftp, ramp.evaluate(s).ftp);
  assert.equal(rampLite.evaluate(s).ftp, 225);
  assert.deepEqual(rampLite.evaluate(s).vo2, { method: 'ppo', power: 300 });
});

test('20 min: 95 % of the tagged 20 minutes, CP from best 5 min + 20 min', () => {
  const r = m20.evaluate(samples([1200, 150], [300, 350], [600, 150], [1200, 280, '20'], [600, 120]));
  assert.equal(r.ftp, 266);
  assert.deepEqual(r.bests, { m20: 280, m5: 350 });
  // CP = (280·1200 − 350·300) / 900 ≈ 256.7 W, W′ = (350 − CP)·300 = 28 kJ, p8 = CP + W′/480
  assert.equal(r.cp, 257);
  assert.equal(r.wPrime, 28);
  assert.deepEqual(r.vo2, { method: 'p8', power: 315 });
  assert.deepEqual(r.details.at(-1), ['Critical Power (5 + 20 min)', '257 W']);
});

test('20 min: at 95 % ridden the average is over what was ridden', () => {
  const r = m20.evaluate(samples([1140, 300, '20']));
  assert.equal(r.ftp, 285);
  assert.equal(r.bests.m20, 300);
});

test('20 min: an abandoned effort gives no FTP, never the best 20 min of the ride', () => {
  const r = m20.evaluate(samples([3600, 300], [1100, 260, '20'], [600, 300]));
  assert.equal(r.ftp, null);
  assert.deepEqual(r.incomplete, {
    label: '20-minute effort', ridden: 1100, needed: 1200, text: 'You rode 18:20 of the 20-minute effort.',
  });
  assert.deepEqual(r.bests, { m5: 300 });
  assert.deepEqual(r.details[0], ['20-minute effort', 'not completed — 18:20 of 20:00']);
  assert.equal(r.vo2, undefined);

  const never = m20.evaluate(samples([3600, 300]));
  assert.equal(never.ftp, null);
  assert.equal(never.incomplete.ridden, 0);
  assert.equal(never.incomplete.text, 'The 20-minute effort wasn\'t reached.');
});

test('8 min: 90 % of the better effort', () => {
  const r = m8.evaluate(samples([600, 150], [480, 300, 'a'], [600, 120], [480, 320, 'b'], [600, 110]));
  assert.equal(r.ftp, 288);
  assert.deepEqual(r.details.slice(0, 3), [['Effort 1', '300 W'], ['Effort 2', '320 W'], ['Better × 0.90', '320 W']]);
  assert.deepEqual(r.vo2, { method: 'p8', power: 320 });
  assert.equal(r.bests.m5, 320);
});

test('8 min: one completed effort is enough', () => {
  const r = m8.evaluate(samples([480, 300, 'a'], [600, 120], [200, 350, 'b']));
  assert.equal(r.ftp, 270);
  assert.deepEqual(r.details[1], ['Effort 2', 'not completed — 3:20 of 8:00']);
});

test('8 min: neither effort completed gives no FTP', () => {
  const both = m8.evaluate(samples([300, 300, 'a'], [600, 120], [400, 300, 'b']));
  assert.equal(both.ftp, null);
  assert.equal(both.incomplete.label, '8-minute effort');
  assert.equal(both.incomplete.ridden, 400); // the longer attempt
  assert.equal(both.incomplete.needed, 480);
  assert.equal(both.incomplete.text, 'Neither 8-minute effort was completed.');

  const one = m8.evaluate(samples([3600, 400], [300, 300, 'a']));
  assert.equal(one.ftp, null);
  assert.equal(one.incomplete.ridden, 300);
  assert.equal(one.incomplete.text, 'You rode 5:00 of the 8-minute effort.');
  assert.deepEqual(one.details[1], ['Effort 2', 'not ridden']);
});

test('power profile: FTP from the 20 minutes, CP and W′ from 5 + 20 min', () => {
  const r = profile.evaluate(samples(
    [720, 150], [8, 900, 's5'], [570, 140], [60, 500, 'm1'], [570, 140],
    [300, 380, 'm5'], [570, 140], [1200, 300, 'm20'], [600, 120],
  ));
  assert.equal(r.ftp, 285);
  assert.deepEqual(r.bests, { s5: 900, m1: 500, m5: 380, m20: 300 });
  // CP = (300·1200 − 380·300) / 900 ≈ 273 W, W′ = (380 − 273)·300 J = 32.1 kJ
  assert.equal(r.cp, 273);
  assert.equal(r.wPrime, 32.1);
  assert.deepEqual(r.vo2, { method: 'p8', power: 340 });
});

test('power profile: without the 20 minutes there is no FTP, the shorter bests stay', () => {
  const r = profile.evaluate(samples([720, 150], [8, 900, 's5'], [570, 140], [60, 500, 'm1'], [600, 300, 'm20']));
  assert.equal(r.ftp, null);
  assert.equal(r.incomplete.ridden, 600);
  assert.equal(r.incomplete.needed, 1200);
  assert.deepEqual(Object.keys(r.bests).sort(), ['m1', 'm5', 's5']);
  assert.equal(r.cp, undefined);
  assert.equal(r.vo2, undefined);
});

// ------------------------------------------------------------------ models

test('cpModel: two-parameter critical power, null for unusable input', () => {
  assert.deepEqual(cpModel(350, 300, 280, 1200), { cp: 257, wPrime: 28, p8: 315 });
  assert.equal(cpModel(null, 300, 280, 1200), null);
  assert.equal(cpModel(350, 300, 0, 1200), null);
  assert.equal(cpModel(350, 300, 280, 300), null);
  assert.equal(cpModel(250, 300, 280, 1200), null); // longer effort stronger → W′ < 0
});

test('vo2max: ACSM from 8-min power, Hawley & Noakes from ramp peak power', () => {
  const p8 = vo2max({ method: 'p8', power: 300 }, 75);
  assert.equal(p8.rel, 50.2); // 10.8 · 4 W/kg + 7
  assert.equal(p8.abs, 3.8);
  assert.match(p8.method, /ACSM from 300 W/);
  const ppo = vo2max({ method: 'ppo', power: 400 }, 75);
  assert.equal(ppo.abs, 5); // 0.01141 · 400 + 0.435 L/min
  assert.equal(ppo.rel, 66.7);
  assert.equal(vo2max(null, 75), null);
  assert.equal(vo2max({ method: 'p8', power: 300 }, 0), null);
  assert.equal(vo2max({ method: 'other', power: 300 }, 75), null);
});

// ------------------------------------------------------------------ library tests

const seg = (duration, p0, type = 'steady') => ({ type, duration, p0, p1: p0, texts: [] });

test('isTestWorkout and classifyTest recognise library tests', () => {
  assert.ok(isTestWorkout({ title: 'FTP Test (shorter)', name: 'a.zwo' }));
  assert.ok(isTestWorkout({ title: 'Week 1', name: 'ramp_test.zwo' }));
  assert.ok(!isTestWorkout({ title: 'Sweet spot', name: 'ss.zwo' }));
  const rampProfile = [[300, 0.5, 0.5], ...[0.6, 0.7, 0.8, 0.9, 1.0, 1.1].map((p) => [60, p, p])];
  assert.equal(classifyTest(rampProfile, 'Ramp Test').kind, 'ramp');
  assert.equal(classifyTest([[600, 0.5, 0.5]], 'Ramp Test').kind, 'broken-ramp');
  assert.equal(classifyTest([[600, 0.5, 0.5], [1200, null, null]], 'FTP test').kind, '20');
  assert.equal(classifyTest([[600, 0.5, 0.5], [480, null, null]], 'FTP test').kind, '8');
  assert.equal(classifyTest([[600, 0.5, 0.5], [60, null, null]], 'FTP test').kind, 'bests');
});

test('prepareTestWorkout tags free-ride and long ≥ 100 % blocks as efforts e<i>', () => {
  const w = prepareTestWorkout({ segments: [seg(600, null, 'warmup'), seg(300, 0.6), seg(1200, null), seg(600, 1.05), seg(120, 1.2)] });
  assert.deepEqual(w.segments.map((s) => s.measure), [undefined, undefined, 'e2', 'e3', undefined]);
  assert.equal(w.segments[2].erg, false);
  assert.equal(w.segments[2].texts.length, 1);
});

test('evaluateGeneric: 95 % of a 20-min effort, CP with a 5-min effort', () => {
  const w = prepareTestWorkout({ segments: [seg(600, 0.6), seg(300, null), seg(600, 0.5), seg(1200, null), seg(300, 0.5)] });
  const r = evaluateGeneric(samples([600, 150], [300, 350, 'e1'], [600, 120], [1200, 280, 'e3'], [300, 120]), w);
  assert.equal(r.ftp, 266);
  assert.equal(r.cp, 257);
  assert.equal(r.wPrime, 28);
  assert.deepEqual(r.vo2, { method: 'p8', power: 315 });
  assert.deepEqual(r.details[2], ['Method', '95 % of the 20-min effort']);
});

test('evaluateGeneric: 90 % of an 8-min effort, its power as VO2max basis', () => {
  const w = prepareTestWorkout({ segments: [seg(600, 0.6), seg(480, null), seg(300, 0.5)] });
  const r = evaluateGeneric(samples([600, 150], [480, 300, 'e1'], [300, 120]), w);
  assert.equal(r.ftp, 270);
  assert.deepEqual(r.vo2, { method: 'p8', power: 300 });
});

test('evaluateGeneric: an abandoned long effort gives no FTP, never the ride\'s best 20 min', () => {
  const w = prepareTestWorkout({ segments: [seg(3600, 0.8), seg(1200, null), seg(300, 0.5)] });
  const r = evaluateGeneric(samples([3600, 300], [600, 280, 'e1'], [300, 120]), w);
  assert.equal(r.ftp, null);
  assert.equal(r.incomplete.label, '20-minute effort');
  assert.equal(r.incomplete.ridden, 600);
  assert.equal(r.incomplete.needed, 1200);
  assert.equal(r.bests.m20, 300); // kept as a best, not used as FTP
});

test('evaluateGeneric: short efforts only keep bests, no FTP', () => {
  const w = prepareTestWorkout({ segments: [seg(600, 0.6), seg(60, null), seg(300, 0.5)] });
  const r = evaluateGeneric(samples([600, 150], [60, 500, 'e1'], [300, 120]), w);
  assert.equal(r.ftp, null);
  assert.equal(r.incomplete, undefined);
  assert.equal(r.bests.m1, 500);
  assert.deepEqual(r.details.at(-1), ['FTP', 'needs a ≥ 8-min all-out effort — bests saved']);
  assert.equal(evaluateGeneric([], w), null);
});

test('evaluateGeneric: a library ramp gives 75 % of the best minute', () => {
  const w = prepareTestWorkout({ segments: [seg(300, 0.4), ...[0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((p) => seg(60, p))] });
  const r = evaluateGeneric(samples([300, 100], [60, 125], [60, 150], [60, 175], [60, 200], [60, 225], [60, 250]), w);
  assert.equal(r.ftp, 188);
  assert.deepEqual(r.vo2, { method: 'ppo', power: 250 });
});

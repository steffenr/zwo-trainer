import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WHEEL_M, DIFFICULTY, DEFAULT_SHIFTING, gearTable, virtualSpeed, flatPower, targetWatts,
} from '../ui/js/vshift.js';

/** Speed (km/h) a rider holds on the flat at `watts`: flatPower inverted by bisection. */
function speedFor(watts, kg = 75, difficulty = 'medium') {
  let lo = 0, hi = 150;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (flatPower(mid, kg, difficulty) < watts) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

test('gearTable: defaults give 24 gears from 0.75 to 5.0', () => {
  const g = gearTable();
  assert.equal(g.length, 24);
  assert.equal(g[0], 0.75);
  assert.equal(g.at(-1), 5);
  assert.deepEqual(gearTable(DEFAULT_SHIFTING), g);
});

test('gearTable: ratios rise with an even (geometric) step between neighbours', () => {
  const g = gearTable();
  const steps = g.slice(1).map((r, i) => r / g[i]);
  for (const s of steps) {
    assert.ok(s > 1, 'every gear is harder than the one before');
    assert.ok(Math.abs(s - steps[0]) < 0.03, `step ${s} close to ${steps[0]}`);
  }
  for (const r of g) assert.equal(Math.round(r * 100) / 100, r, 'two decimals');
});

test('gearTable: custom range and count, at least two gears', () => {
  assert.deepEqual(gearTable({ minRatio: 1, maxRatio: 4, gears: 3 }), [1, 2, 4]);
  assert.equal(gearTable({ gears: 11 }).length, 11);
  assert.equal(gearTable({ gears: 11.4 }).length, 11);
  assert.deepEqual(gearTable({ minRatio: 1, maxRatio: 2, gears: 1 }), [1, 2]);
  assert.deepEqual(gearTable({ minRatio: 1, maxRatio: 2, gears: 0 }), [1, 2]);
});

test('DEFAULT_SHIFTING starts in a gear that exists', () => {
  const g = gearTable(DEFAULT_SHIFTING);
  assert.ok(DEFAULT_SHIFTING.startGear >= 1 && DEFAULT_SHIFTING.startGear <= g.length);
  assert.ok(DEFAULT_SHIFTING.difficulty in DIFFICULTY);
});

test('virtualSpeed: cadence × ratio × wheel circumference', () => {
  assert.equal(WHEEL_M, 2.105);
  // 60 rpm in a 1:1 gear = one wheel turn per second
  assert.ok(Math.abs(virtualSpeed(60, 1) - WHEEL_M * 3.6) < 1e-9);
  assert.ok(Math.abs(virtualSpeed(90, 2) - 3 * WHEEL_M * 3.6) < 1e-9);
  assert.equal(virtualSpeed(0, 3), 0);
  assert.equal(virtualSpeed(null, 3), 0);
  assert.equal(virtualSpeed(undefined, 3), 0);
});

test('virtualSpeed: harder gear and higher cadence are faster', () => {
  const g = gearTable();
  for (let i = 1; i < g.length; i++) assert.ok(virtualSpeed(90, g[i]) > virtualSpeed(90, g[i - 1]));
  assert.ok(virtualSpeed(100, g[10]) > virtualSpeed(80, g[10]));
});

test('flatPower: zero at standstill, rising steeply with speed', () => {
  assert.equal(flatPower(0), 0);
  let prev = 0;
  for (let kmh = 5; kmh <= 60; kmh += 5) {
    const p = flatPower(kmh);
    assert.ok(p > prev, `${kmh} km/h needs more than ${kmh - 5} km/h`);
    prev = p;
  }
  // aerodynamic drag dominates: doubling the speed needs far more than double the power
  assert.ok(flatPower(40) > 4 * flatPower(20));
});

test('flatPower: plausible watts for a 75 kg rider on the flat', () => {
  const p30 = flatPower(30);
  const p40 = flatPower(40);
  assert.ok(p30 > 120 && p30 < 170, `30 km/h ≈ ${p30.toFixed(0)} W`);
  assert.ok(p40 > 250 && p40 < 350, `40 km/h ≈ ${p40.toFixed(0)} W`);
  assert.equal(flatPower(30, undefined), flatPower(30, 75));
  assert.ok(flatPower(30, 100) > flatPower(30, 60), 'heavier rider, more rolling resistance');
});

test('speed from power and back: plausible and consistent', () => {
  const v200 = speedFor(200);
  assert.ok(v200 > 31 && v200 < 36, `200 W ≈ ${v200.toFixed(1)} km/h`);
  assert.ok(Math.abs(flatPower(v200) - 200) < 1e-6);
  let prev = 0;
  for (const w of [50, 100, 150, 200, 300, 400]) {
    const v = speedFor(w);
    assert.ok(v > prev, `${w} W is faster than less power`);
    prev = v;
  }
});

test('flatPower: difficulty scales the power, unknown difficulty is medium', () => {
  const p = flatPower(35);
  assert.deepEqual(DIFFICULTY, { easy: 0.8, medium: 1.0, hard: 1.25 });
  assert.ok(Math.abs(flatPower(35, 75, 'easy') - p * 0.8) < 1e-9);
  assert.ok(Math.abs(flatPower(35, 75, 'hard') - p * 1.25) < 1e-9);
  assert.equal(flatPower(35, 75, 'nonsense'), p);
  assert.equal(flatPower(35, 75, undefined), p);
});

test('targetWatts: flat-road power for cadence and gear, rounded', () => {
  const g = gearTable();
  const w = targetWatts(90, g[15], 75, 'medium');
  assert.equal(w, Math.round(flatPower(virtualSpeed(90, g[15]), 75, 'medium')));
  assert.ok(w > 100 && w < 250, `gear 16 at 90 rpm ≈ ${w} W`);
  for (let i = 1; i < g.length; i++) {
    assert.ok(targetWatts(90, g[i], 75, 'medium') >= targetWatts(90, g[i - 1], 75, 'medium'), 'shifting up never gets easier');
  }
});

test('targetWatts: 30 W floor (also when not pedalling) and 1500 W cap', () => {
  const g = gearTable();
  assert.equal(targetWatts(0, g[10], 75, 'medium'), 30);
  assert.equal(targetWatts(null, g[10], 75, 'medium'), 30);
  assert.equal(targetWatts(14, g[23], 75, 'medium'), 30);
  assert.equal(targetWatts(20, g[0], 75, 'medium'), 30); // tiny gear, slow pedalling
  assert.equal(targetWatts(150, g.at(-1), 75, 'hard'), 1500);
});

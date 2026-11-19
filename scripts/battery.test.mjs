import test from 'node:test';
import assert from 'node:assert/strict';
import { batteryState, lowestLevel, batteryBadge } from '../ui/js/battery.js';

test('batteryState: ok from 40 %, low from 16 %, critical at 15 % and below', () => {
  assert.equal(batteryState(100), 'ok');
  assert.equal(batteryState(40), 'ok');
  assert.equal(batteryState(39), 'low');
  assert.equal(batteryState(16), 'low');
  assert.equal(batteryState(15), 'critical');
  assert.equal(batteryState(0), 'critical');
});

test('batteryState: unknown levels have no state', () => {
  assert.equal(batteryState(null), null);
  assert.equal(batteryState(undefined), null);
  assert.equal(batteryState(Number.NaN), null);
});

test('lowestLevel: the weakest of several devices, null when there are none', () => {
  assert.equal(lowestLevel({ a: 80, b: 20, c: 55 }), 20);
  assert.equal(lowestLevel({ a: 0, b: 90 }), 0);
  assert.equal(lowestLevel({}), null);
  assert.equal(lowestLevel(undefined), null);
});

test('batteryBadge: colour class, percentage text and accessible label', () => {
  const ok = batteryBadge(78, 'Battery 78%');
  assert.match(ok, /class="batt ok"/);
  assert.match(ok, /78%/);
  assert.match(ok, /aria-label="Battery 78%"/);
  assert.match(batteryBadge(78, 't', (n) => `${n}\u202f%`), /78\u202f%/);
  assert.match(batteryBadge(30, 't'), /class="batt low"/);
  assert.match(batteryBadge(10, 't'), /class="batt critical"/);
});

test('batteryBadge: fill width follows the level, clamped, and never invisible above 0', () => {
  const w = (level) => Number(batteryBadge(level, 't').match(/class="fill" [^>]*width="(\d+)"/)[1]);
  assert.equal(w(100), 16);
  assert.equal(w(50), 8);
  assert.equal(w(0), 0);
  assert.equal(w(1), 1);
  assert.equal(w(250), 16);
  assert.equal(w(-5), 0);
});

test('batteryBadge: no level, no badge', () => {
  assert.equal(batteryBadge(null, 't'), '');
  assert.equal(batteryBadge(undefined, 't'), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactView } from '../ui/js/compact.js';

function fixture(resize = async () => {}) {
  const applied = [], errors = [];
  const view = new CompactView({ resize, apply: (on) => applied.push(on), report: (error) => errors.push(error) });
  return { view, applied, errors };
}

// A missing state transition, premature presentation change, or unqueued native request
// must fail these tests. Only the external native resize boundary is substituted.
test('entry and exit change presentation after native resizing', async () => {
  let release;
  const f = fixture(() => new Promise((resolve) => { release = resolve; }));
  const entering = f.view.set(true);
  await Promise.resolve();
  assert.equal(f.view.active, false);
  assert.deepEqual(f.applied, []);
  release();
  assert.equal(await entering, true);
  assert.equal(f.view.active, true);
  assert.deepEqual(f.applied, [true]);
  const exiting = f.view.set(false);
  await Promise.resolve();
  assert.equal(f.view.active, true);
  release();
  assert.equal(await exiting, true);
  assert.equal(f.view.active, false);
  assert.deepEqual(f.applied, [true, false]);
});

test('repeated entry and exit do not resize or apply twice', async () => {
  const requests = [];
  const f = fixture(async (on) => requests.push(on));
  assert.equal(await f.view.set(false), true);
  await Promise.all([f.view.set(true), f.view.set(true)]);
  await Promise.all([f.view.set(false), f.view.set(false)]);
  assert.deepEqual(requests, [true, false]);
  assert.deepEqual(f.applied, [true, false]);
});

test('an exit requested during entry runs after entry and leaves the full view active', async () => {
  let release;
  const requests = [];
  const f = fixture(async (on) => {
    requests.push(on);
    if (on) await new Promise((resolve) => { release = resolve; });
  });
  const entering = f.view.set(true), exiting = f.view.set(false);
  await Promise.resolve();
  assert.deepEqual(requests, [true]);
  release();
  assert.deepEqual(await Promise.all([entering, exiting]), [true, true]);
  assert.deepEqual(requests, [true, false]);
  assert.equal(f.view.active, false);
  assert.deepEqual(f.applied, [true, false]);
});

test('failed entry reports an error without changing presentation and can be retried', async () => {
  let fail = true;
  const error = new Error('Native resize failed');
  const f = fixture(async () => { if (fail) throw error; });
  assert.equal(await f.view.set(true), false);
  assert.equal(f.view.active, false);
  assert.deepEqual(f.applied, []);
  assert.deepEqual(f.errors, [error]);
  fail = false;
  assert.equal(await f.view.set(true), true);
  assert.equal(f.view.active, true);
});

test('failed exit keeps the compact view available for retry', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw new Error('Native resize failed'); });
  await f.view.set(true);
  fail = true;
  assert.equal(await f.view.set(false), false);
  assert.equal(f.view.active, true);
  assert.deepEqual(f.applied, [true]);
  fail = false;
  assert.equal(await f.view.set(false), true);
  assert.equal(f.view.active, false);
});

test('leaving asks the native side to leave and applies the full view even when it fails', async () => {
  let fail = false;
  const requests = [];
  const f = fixture(async (...args) => { requests.push(args); if (fail) throw new Error('Cannot restore'); });
  await f.view.set(true);
  fail = true;
  assert.equal(await f.view.leave(), false);
  assert.deepEqual(requests, [[true], [false, true]]);
  assert.equal(f.view.active, false);
  assert.deepEqual(f.applied, [true, false]);
  assert.equal(f.errors.length, 1);
  fail = false;
  assert.equal(await f.view.set(true), true);
  assert.deepEqual(requests.at(-1), [true]);
});

test('leaving the full view does not touch the window', async () => {
  const requests = [];
  const f = fixture(async (...args) => requests.push(args));
  assert.equal(await f.view.leave(), true);
  assert.deepEqual(requests, []);
  assert.deepEqual(f.applied, []);
});

// While the native window resizes (entering, leaving) the window passes through sizes of both layouts; the UI must not
// react to them (it would set window limits that fight the resize), so the view says when it is busy.
test('busy while the native resize runs, also after a failure and when leaving', async () => {
  let release;
  const f = fixture(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(f.view.busy, false);
  const entering = f.view.set(true);
  await Promise.resolve();
  assert.equal(f.view.busy, true);
  release();
  await entering;
  assert.equal(f.view.busy, false);

  const failing = fixture(async () => { throw new Error('Native resize failed'); });
  await failing.view.set(true);
  assert.equal(failing.view.busy, false);

  let finish;
  const g = fixture(async (on) => { if (!on) await new Promise((resolve) => { finish = resolve; }); });
  await g.view.set(true);
  const leaving = g.view.leave();
  await Promise.resolve();
  assert.equal(g.view.busy, true);
  finish();
  await leaving;
  assert.equal(g.view.busy, false);
});

import { compactMode, fitFontSize, levelView, maxPOf, segmentPoints, placeGraphLabels, fitHorizontalLabels } from '../ui/js/compact.js';

test('compactMode: layout choice', () => {
  assert.equal(compactMode(639, 150).layout, 'v');
  assert.equal(compactMode(640, 150).layout, 'h');
  assert.equal(compactMode(640, 426).layout, 'h');
  assert.equal(compactMode(640, 427).layout, 'v'); // 640 < 1.5 * 427
  assert.equal(compactMode(1400, 150).layout, 'h');
  assert.equal(compactMode(960, 340).layout, 'h');
  assert.equal(compactMode(700, 700).layout, 'v');
});

test('compactMode: horizontal is fixed, vertical thresholds', () => {
  assert.deepEqual(compactMode(960, 150), { layout: 'h', live: 'row', graph: true, foot: 'rail', tiles: true });
  assert.equal(compactMode(240, 519).live, 'row'); assert.equal(compactMode(240, 520).live, 'col');
  assert.equal(compactMode(240, 359).graph, false); assert.equal(compactMode(240, 360).graph, true);
  assert.equal(compactMode(240, 243).foot, 'head'); assert.equal(compactMode(240, 244).foot, 'foot');
  assert.equal(compactMode(240, 189).tiles, false); assert.equal(compactMode(240, 190).tiles, true);
});

test('fitFontSize: largest size that fits, clamped', () => {
  const m = (s) => s * 5;
  assert.equal(fitFontSize(m, 60, 11, 24), 12);
  assert.equal(fitFontSize(m, 59, 11, 24), 11);
  assert.equal(fitFontSize(m, 10, 14, 24), 14); // never below the floor
  assert.equal(fitFontSize(m, 1000, 14, 24), 24); // never above the cap
});

test('levelView: watts, ramp, free, max effort, all-out, intensity', () => {
  assert.deepEqual(levelView({ p0: 0.56, p1: 0.56 }, 1, 250), { kind: 'watts', a: 140, b: 140 });
  assert.deepEqual(levelView({ p0: 0.28, p1: 0.84 }, 1, 250), { kind: 'range', a: 70, b: 210 });
  assert.deepEqual(levelView({ p0: 0.5, p1: 0.5 }, 1.2, 250), { kind: 'watts', a: 150, b: 150 });
  assert.equal(levelView({ p0: null, p1: null, type: 'freeride' }, 1, 250).kind, 'free');
  assert.equal(levelView({ p0: null, p1: null, type: 'maxeffort' }, 1, 250).kind, 'maxeffort');
  assert.equal(levelView({ p0: 1, p1: 1, erg: false }, 1, 250).kind, 'allout');
});

test('maxPOf and segmentPoints', () => {
  assert.ok(Math.abs(maxPOf([{ p0: 0.5, p1: 0.5 }, { p0: 1, p1: 1.3 }]) - 1.404) < 1e-9);
  assert.ok(Math.abs(maxPOf([{ p0: 0.5, p1: 0.5 }]) - 1.296) < 1e-9);
  const h = { orientation: 'h', total: 60, maxP: 1.1, length: 200, breadth: 110, top: 10 };
  assert.equal(segmentPoints({ start: 10, duration: 10, p0: 0.5, p1: 1.1 }, h), '33.33,110.00 33.33,64.55 66.67,10.00 66.67,110.00');
  const v = { orientation: 'v', total: 60, maxP: 1.1, length: 120, breadth: 100, gutter: 20 };
  assert.equal(segmentPoints({ start: 30, duration: 30, p0: 1.1, p1: 0.55 }, v), '20.00,60.00 100.00,60.00 60.00,120.00 20.00,120.00');
  assert.equal(segmentPoints({ start: 0, duration: 60, p0: null, p1: null }, v), '20.00,0.00 56.36,0.00 56.36,120.00 20.00,120.00'); // free block drawn at 0.5
});

test('placeGraphLabels: clamps, overlap, no next', () => {
  assert.deepEqual(placeGraphLabels({ height: 200, yNow: 60, yNext: 80 }), { nowBase: 60, next: { top: 80, lines: 3 } });
  assert.deepEqual(placeGraphLabels({ height: 200, yNow: 10, yNext: 14 }), { nowBase: 54, next: null });
  // the large watts line makes the Next block 52 px high with three lines, 40 with two
  assert.deepEqual(placeGraphLabels({ height: 100, yNow: 40, yNext: 70 }), { nowBase: 54, next: { top: 60, lines: 2 } });
  assert.deepEqual(placeGraphLabels({ height: 130, yNow: 40, yNext: 70 }), { nowBase: 54, next: { top: 70, lines: 3 } });
  assert.deepEqual(placeGraphLabels({ height: 100, yNow: 60, yNext: 70 }), { nowBase: 60, next: null });
  assert.deepEqual(placeGraphLabels({ height: 80, yNow: 60, yNext: 70 }), { nowBase: 60, next: null });
  assert.deepEqual(placeGraphLabels({ height: 200, yNow: 5, yNext: null }), { nowBase: 54, next: null });
});

test('fitHorizontalLabels: shortening ladder', () => {
  const measure = (s) => s.length * 7;
  const now = ['Now 140 W', '140 W'], next = ['Next 220 W · in 8:00', 'Next 220 W'];
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 67, xNext: 93, now, next, measure }), { now: '140 W', next: 'Next 220 W', nowSide: 'left' });
  assert.deepEqual(fitHorizontalLabels({ width: 600, xNow: 200, xNext: 260, now, next, measure }), { now: 'Now 140 W', next: 'Next 220 W · in 8:00', nowSide: 'left' });
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 67, xNext: 190, now, next, measure }), { now: '140 W', next: '', nowSide: 'left' });
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 67, xNext: 93, now, next: null, measure }), { now: '140 W', next: '', nowSide: 'left' });
  // the position line is too close to the left edge: Now moves to its right, and Next must clear it
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 20, xNext: 93, now, next, measure }), { now: '140 W', next: 'Next 220 W', nowSide: 'right' });
  assert.deepEqual(fitHorizontalLabels({ width: 200, xNow: 20, xNext: 40, now, next, measure }), { now: '140 W', next: '', nowSide: 'right' });
  assert.deepEqual(fitHorizontalLabels({ width: 60, xNow: 20, xNext: 50, now, next, measure }), { now: '', next: '', nowSide: 'right' }); // nothing fits
});

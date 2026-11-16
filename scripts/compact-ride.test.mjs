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

import { compactMode } from '../ui/js/compact.js';

test('compactMode: wide tiers', () => {
  assert.equal(compactMode(960, 200).mode, 'ws');
  assert.equal(compactMode(900, 640).mode, 'wt');
  assert.equal(compactMode(560, 259).mode, 'ws');
  assert.equal(compactMode(560, 260).mode, 'wt');
});

test('compactMode: narrow tiers', () => {
  assert.equal(compactMode(320, 200).mode, 'ns');
  assert.equal(compactMode(240, 520).mode, 'nt');
  assert.equal(compactMode(559, 299).mode, 'ns');
  assert.equal(compactMode(559, 300).mode, 'nt');
});

test('compactMode: flag boundaries', () => {
  assert.equal(compactMode(600, 239).short, true);
  assert.equal(compactMode(600, 240).short, false);
  assert.equal(compactMode(259, 400).tiny, true);
  assert.equal(compactMode(260, 400).tiny, false);
  assert.equal(compactMode(600, 169).tiny, true);
  assert.equal(compactMode(600, 170).tiny, false);
  assert.equal(compactMode(419, 400).narrow, true);
  assert.equal(compactMode(420, 400).narrow, false);
  assert.equal(compactMode(299, 400).xs, true);
  assert.equal(compactMode(300, 400).xs, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { noteStarts } from '../ui/js/sound.js';

const RATE = 44100;

/** Seeded noise in [-amp, amp] (deterministic runs). */
function noise(amp, seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648 * 2 - 1) * amp;
  };
}

/**
 * Synthetic decoded audio like power-up.mp3: `delay` s of decoder silence, then one note per
 * entry of `notes` ([start s after the delay, frequency Hz]), each `len` s with a fast attack and
 * an exponential decay, on top of a noise floor of `floor`.
 */
function track({ delay = 0.05, notes = [[0, 660], [1, 784], [2, 988]], len = 0.4, total = 3, floor = 0, rate = RATE } = {}) {
  const data = new Float32Array(Math.round((delay + total) * rate));
  const rnd = noise(floor);
  for (let i = 0; i < data.length; i++) data[i] = rnd();
  for (const [at, f] of notes) {
    const from = Math.round((delay + at) * rate);
    for (let i = 0; i < len * rate && from + i < data.length; i++) {
      const x = i / rate;
      const env = Math.min(1, x / 0.005) * Math.exp(-x * 6);
      data[from + i] += 0.6 * env * Math.sin(2 * Math.PI * f * x);
    }
  }
  return data;
}

/** Same number of starts as `expected`, each within `tol` seconds. */
function near(actual, expected, tol = 0.003) {
  assert.equal(actual.length, expected.length, `${actual.length} notes: ${actual.map((x) => x.toFixed(3))}`);
  actual.forEach((a, i) => assert.ok(Math.abs(a - expected[i]) <= tol, `note ${i + 1} at ${a.toFixed(4)} s, expected ${expected[i]} s`));
}

test('three notes 1 s apart after a decoder delay', () => {
  near(noteStarts(track({ delay: 0.05 }), RATE), [0.05, 1.05, 2.05]);
});

test('the decoder delay shifts every start, whatever its length', () => {
  for (const delay of [0, 0.0261, 0.1, 0.5]) {
    near(noteStarts(track({ delay }), RATE), [delay, delay + 1, delay + 2]);
  }
});

test('a noise floor below the threshold is ignored', () => {
  near(noteStarts(track({ delay: 0.08, floor: 0.015 }), RATE), [0.08, 1.08, 2.08]);
});

test('other sample rates', () => {
  for (const rate of [22050, 48000]) near(noteStarts(track({ delay: 0.03, rate }), rate), [0.03, 1.03, 2.03]);
});

test('zero crossings and quiet moments inside a note never start a new one', () => {
  // a long note whose tail dips under the threshold for less than the 0.3 s gap
  const data = track({ notes: [[0, 440]], len: 0.6, total: 1 });
  const from = Math.round((0.05 + 0.3) * RATE);
  data.fill(0, from, from + Math.round(0.2 * RATE));
  near(noteStarts(data, RATE), [0.05]);
});

test('notes closer than the gap merge; a shorter gap separates them', () => {
  const close = track({ notes: [[0, 660], [0.5, 784]], len: 0.3, total: 1 });
  near(noteStarts(close, RATE), [0.05]);
  near(noteStarts(close, RATE, 0.02, 0.1), [0.05, 0.55]);
});

test('threshold and gap are adjustable', () => {
  const data = track({ floor: 0.03 });
  // noise above the default threshold never goes quiet: one "note" from the first sample
  near(noteStarts(data, RATE), [0]);
  near(noteStarts(data, RATE, 0.1), [0.05, 1.05, 2.05], 0.005);
});

test('silence and empty buffers have no notes', () => {
  assert.deepEqual(noteStarts(new Float32Array(RATE), RATE), []);
  assert.deepEqual(noteStarts(new Float32Array(0), RATE), []);
  assert.deepEqual(noteStarts(track({ notes: [], floor: 0.01 }), RATE), []);
});

test('negative samples count like positive ones', () => {
  const data = new Float32Array(RATE);
  data[1000] = -0.5;
  near(noteStarts(data, RATE), [1000 / RATE], 1e-9);
});

test('a click before the first note shows up as an extra start (countdown then plays the beep)', () => {
  const data = track({ delay: 0.5 });
  data[100] = 0.4;
  assert.equal(noteStarts(data, RATE).length, 4);
});

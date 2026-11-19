import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarInk, luminance } from '../ui/js/components/avatar.js';

test('luminance: black 0, white 1', () => {
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('#ffffff'), 1);
});

test('avatarInk: every preset colour gets dark initials (white is below 4.5:1 on all of them)', () => {
  for (const c of ['#338cff', '#59bf59', '#ff6639', '#b47cff', '#00a3c4', '#e0a800', '#ff4d8d', '#7f7f7f']) assert.equal(avatarInk(c), 'dark', c);
});

test('avatarInk: dark custom colours keep white initials', () => {
  for (const c of ['#000000', '#1d1d1f', '#007690', '#5a2d82', '#c62f26']) assert.equal(avatarInk(c), 'light', c);
  assert.equal(avatarInk('#ffffff'), 'dark');
});

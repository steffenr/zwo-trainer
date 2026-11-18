#!/usr/bin/env node
// Builds the sample workout library for the screenshots:
//   1. writes .zwo files and plan descriptions from the compact definitions below into a temp folder,
//   2. lets the real Rust code scan and parse them (`library::tests::dump_fixture`, ignored test),
//   3. stores the result as library.json (scan_library) and workouts.json (load_workout per file).
// Run after changing the definitions or the parser/scan output:  node scripts/shots/fixture/make.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
/** Root path the app shows for the sample library (Settings → App). */
export const ROOT = '/Users/lena/Training/Workouts';

// --------------------------------------------------------------- workouts
// Segments: [type, …] with power as a fraction of FTP and durations in seconds.
//   ['warm', dur, lo, hi]  ['cool', dur, hi, lo]  ['ramp', dur, lo, hi]  ['ss', dur, p, cadence?]
//   ['int', reps, on, off, pOn, pOff, cadenceOn?]  ['free', dur]  ['text', offsetInWorkout, message]
const W = {
  'Aerobic Foundation': { desc: 'Steady endurance with a few cadence lifts. Stay relaxed and keep the pedal stroke smooth.', segs: [['warm', 600, 0.45, 0.65], ['ss', 1200, 0.68], ['ss', 300, 0.7, 100], ['ss', 1200, 0.68], ['cool', 420, 0.6, 0.4]] },
  'Cadence Builder': { desc: 'Endurance with short high-cadence blocks to build a fluid pedal stroke.', segs: [['warm', 480, 0.45, 0.65], ['int', 8, 60, 120, 0.7, 0.62, 110], ['ss', 1020, 0.66], ['cool', 360, 0.6, 0.4]] },
  'Sweet Spot 3x12': { desc: 'Three blocks just below threshold: the classic way to raise FTP without burying yourself.', segs: [['warm', 540, 0.45, 0.75], ['ss', 720, 0.9, 90], ['ss', 300, 0.55], ['ss', 720, 0.9, 90], ['ss', 300, 0.55], ['ss', 720, 0.9, 90], ['ss', 300, 0.55], ['cool', 540, 0.6, 0.4]] },
  'Tempo Surges': { desc: 'Tempo with three short surges. Hold the tempo pace right after each surge.', segs: [['warm', 480, 0.45, 0.7], ['ss', 1320, 0.8], ['text', 780, 'Surge!'], ['text', 1140, 'Surge!'], ['text', 1500, 'Last one!'], ['ss', 300, 0.55], ['ss', 300, 0.75], ['cool', 300, 0.6, 0.4]] },
  'Hill Repeats': { desc: 'Five threshold climbs at low cadence. Seated, steady, strong.', segs: [['warm', 600, 0.45, 0.7], ['int', 5, 240, 180, 1.0, 0.55, 70], ['ss', 480, 0.6], ['cool', 600, 0.6, 0.4]] },
  'VO2 Ladder': { desc: 'Short, sharp efforts that climb to 120 % — then a long breather.', segs: [['warm', 600, 0.45, 0.72], ['ss', 60, 1.1], ['ss', 120, 0.5], ['ss', 120, 1.15], ['ss', 120, 0.5], ['ss', 180, 1.2], ['ss', 180, 0.5], ['ss', 120, 1.15], ['ss', 120, 0.5], ['ss', 60, 1.1], ['cool', 480, 0.65, 0.42]] },
  'Over-Unders': { desc: 'Alternate just over and just under threshold to train lactate clearance.', segs: [['warm', 600, 0.45, 0.72], ['int', 3, 120, 180, 1.05, 0.92], ['ss', 300, 0.55], ['int', 3, 120, 180, 1.05, 0.92], ['cool', 480, 0.6, 0.4]] },
  'Recovery Spin': { desc: 'Easy spinning to flush the legs. No hero watts today.', segs: [['warm', 300, 0.4, 0.5], ['ss', 1200, 0.5], ['cool', 300, 0.5, 0.4]] },
  'Long Endurance': { desc: 'A long steady Z2 ride. Fuel and drink as you would outside.', segs: [['warm', 600, 0.45, 0.65], ['ss', 3600, 0.68], ['ss', 1200, 0.72], ['cool', 600, 0.6, 0.4]] },
  'Threshold 2x15': { desc: 'Two 15-minute blocks at FTP. Settle in, then hold.', segs: [['warm', 720, 0.45, 0.75], ['ss', 900, 0.98], ['ss', 420, 0.55], ['ss', 900, 0.98], ['cool', 540, 0.6, 0.4]] },
  'Seated Climbs': { desc: 'Long low-cadence tempo climbs to build torque.', segs: [['warm', 600, 0.45, 0.7], ['int', 3, 600, 300, 0.85, 0.55, 65], ['cool', 480, 0.6, 0.4]] },
  'Sweet Spot 2x20': { desc: 'Two long sweet-spot blocks. Keep it steady from the first minute.', segs: [['warm', 600, 0.45, 0.75], ['ss', 1200, 0.9], ['ss', 480, 0.55], ['ss', 1200, 0.9], ['cool', 480, 0.6, 0.4]] },
  'Openers': { desc: 'Short race openers: a few hard efforts to wake the legs the day before.', segs: [['warm', 600, 0.45, 0.7], ['int', 3, 30, 150, 1.3, 0.55], ['ss', 300, 0.9], ['cool', 300, 0.55, 0.4]] },
  'Free Ride Mix': { desc: 'Steady tempo with two free-ride blocks: ride them by feel on your gears.', segs: [['warm', 480, 0.45, 0.7], ['ss', 600, 0.78], ['free', 300], ['ss', 600, 0.78], ['free', 300], ['cool', 360, 0.6, 0.4]] },
};

// --------------------------------------------------------------- library layout
/** Plans: folder → { md, days: [[week, day, workout], …] }. Collections: folder → [workout, …] (no week/day). */
const PLANS = {
  'base-builder-6wk': {
    md: `# Base Builder · 6 weeks

Six weeks to build a big aerobic engine before the season starts. Three rides a week, 4–5 hours in total, with one key session each week.

## How the weeks work

- **Weeks 1–2:** endurance and cadence work, a first taste of sweet spot.
- **Weeks 3–4:** longer sweet-spot blocks and tempo.
- **Week 5:** threshold and a short VO2 session.
- **Week 6:** recovery week, then an FTP test.
`,
    days: [
      [1, 1, 'Aerobic Foundation'], [1, 3, 'Cadence Builder'], [1, 5, 'Sweet Spot 3x12'],
      [2, 1, 'Aerobic Foundation'], [2, 3, 'Tempo Surges'], [2, 5, 'Sweet Spot 3x12'],
      [3, 1, 'Long Endurance'], [3, 3, 'Over-Unders'], [3, 5, 'Sweet Spot 2x20'],
      [4, 1, 'Aerobic Foundation'], [4, 3, 'Cadence Builder'], [4, 5, 'Threshold 2x15'],
      [5, 1, 'Aerobic Foundation'], [5, 3, 'Threshold 2x15'], [5, 5, 'VO2 Ladder'],
      [6, 1, 'Recovery Spin'], [6, 3, 'Openers'], [6, 5, 'Long Endurance'],
    ],
  },
  'climb-prep-4wk': {
    md: `# Climb Prep · 4 weeks

Get ready for long alpine climbs: seated low-cadence strength work, threshold repeats and long endurance rides.
`,
    days: [
      [1, 1, 'Aerobic Foundation'], [1, 2, 'Hill Repeats'], [1, 3, 'Recovery Spin'], [1, 4, 'Seated Climbs'],
      [2, 1, 'Cadence Builder'], [2, 2, 'Hill Repeats'], [2, 3, 'Recovery Spin'], [2, 4, 'Long Endurance'],
      [3, 1, 'Seated Climbs'], [3, 2, 'Threshold 2x15'], [3, 3, 'Recovery Spin'], [3, 4, 'Long Endurance'],
      [4, 1, 'Over-Unders'], [4, 2, 'Recovery Spin'], [4, 3, 'Openers'], [4, 4, 'Aerobic Foundation'],
    ],
  },
};
const COLLECTIONS = {
  'lunch-break-rides': ['Cadence Builder', 'Openers', 'Recovery Spin', 'Tempo Surges', 'VO2 Ladder'],
  'sweet-spot-sessions': ['Free Ride Mix', 'Over-Unders', 'Sweet Spot 2x20', 'Sweet Spot 3x12', 'Tempo Surges', 'Threshold 2x15'],
};

// --------------------------------------------------------------- .zwo writer
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const f2 = (x) => x.toFixed(2);
function zwo(name, { desc, segs }) {
  const body = [];
  let pendingText = segs.filter((s) => s[0] === 'text');
  let at = 0;
  for (const s of segs) {
    if (s[0] === 'text') continue;
    const [type] = s;
    const dur = type === 'int' ? s[1] * (s[2] + s[3]) : s[1];
    // text events live inside the segment they fall into (timeoffset is relative to it)
    const texts = pendingText.filter((tx) => tx[1] >= at && tx[1] < at + dur);
    pendingText = pendingText.filter((tx) => !texts.includes(tx));
    const inner = texts.map((tx) => `\n      <textevent timeoffset="${tx[1] - at}" message="${esc(tx[2])}"/>`).join('');
    const close = (tag, attrs) => (inner ? `    <${tag} ${attrs}>${inner}\n    </${tag}>` : `    <${tag} ${attrs}/>`);
    if (type === 'warm') body.push(close('Warmup', `Duration="${s[1]}" PowerLow="${f2(s[2])}" PowerHigh="${f2(s[3])}"`));
    else if (type === 'cool') body.push(close('Cooldown', `Duration="${s[1]}" PowerLow="${f2(s[2])}" PowerHigh="${f2(s[3])}"`));
    else if (type === 'ramp') body.push(close('Ramp', `Duration="${s[1]}" PowerLow="${f2(s[2])}" PowerHigh="${f2(s[3])}"`));
    else if (type === 'ss') body.push(close('SteadyState', `Duration="${s[1]}" Power="${f2(s[2])}"${s[3] ? ` Cadence="${s[3]}"` : ''}`));
    else if (type === 'free') body.push(close('FreeRide', `Duration="${s[1]}"`));
    else if (type === 'int') body.push(close('IntervalsT', `Repeat="${s[1]}" OnDuration="${s[2]}" OffDuration="${s[3]}" OnPower="${f2(s[4])}" OffPower="${f2(s[5])}"${s[6] ? ` Cadence="${s[6]}"` : ''}`));
    at += dur;
  }
  return `<workout_file>
  <author>zwoTrainer</author>
  <name>${esc(name)}</name>
  <description>${esc(desc)}</description>
  <sportType>bike</sportType>
  <workout>
${body.join('\n')}
  </workout>
</workout_file>
`;
}

const pad = (n) => String(n).padStart(2, '0');
const fileName = (name) => name.replace(/ /g, '_');

function writeLibrary(dir) {
  for (const [folder, plan] of Object.entries(PLANS)) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, `${folder}.md`), plan.md);
    for (const [wk, d, name] of plan.days) fs.writeFileSync(path.join(dir, folder, `Week${pad(wk)}_Day${pad(d)}_${fileName(name)}.zwo`), zwo(name, W[name]));
  }
  for (const [folder, names] of Object.entries(COLLECTIONS)) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(dir, folder, `${fileName(name)}.zwo`), zwo(name, W[name]));
  }
}

// --------------------------------------------------------------- main
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zwo-fixture-'));
  const lib = path.join(tmp, 'Workouts');
  writeLibrary(lib);
  execFileSync('cargo', ['test', '--quiet', '--lib', 'dump_fixture', '--', '--ignored'], {
    cwd: path.join(repo, 'src-tauri'),
    env: { ...process.env, FIXTURE_DIR: lib, FIXTURE_OUT: tmp },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // swap the temp path for the sample rider's folder
  const fix = (s) => s.split(lib).join(ROOT);
  fs.writeFileSync(path.join(here, 'library.json'), fix(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')));
  fs.writeFileSync(path.join(here, 'workouts.json'), fix(fs.readFileSync(path.join(tmp, 'workouts.json'), 'utf8')));
  fs.rmSync(tmp, { recursive: true, force: true });
  const l = JSON.parse(fs.readFileSync(path.join(here, 'library.json'), 'utf8'));
  console.log(`fixture: ${l.plans.map((p) => `${p.name} (${p.kind}, ${p.count})`).join(', ')}`);
}

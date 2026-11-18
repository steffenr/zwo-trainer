#!/usr/bin/env node
// Guards the html`` convention (ui/js/html.js): markup reaches the DOM through mount(el, html`…`),
// which escapes every interpolated value. Direct innerHTML / outerHTML writes and insertAdjacentHTML
// bypass that, so their number per file may only go down. When you convert one, lower its BASELINE
// entry (the script tells you); never raise it, use mount() in new code instead.
// Run: node scripts/check-html.mjs (CI does too).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Direct markup writes still allowed per file (legacy code that builds strings with esc()).
const BASELINE = {
  'html.js': 1,      // mount() itself
  'render.js': 1,
  // left in app.js: the ride screen skeleton in Ride.build() (title, screen, chart tooltip, live status,
  // overlay toggle), the top-bar avatar, the ⋯ menu copy from its <template>, the preview's segment info
  // and star, and two clears (innerHTML = '')
  'app.js': 11,
};

const root = fileURLToPath(new URL('../ui/js/', import.meta.url));
const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith('.js') ? [join(d, e.name)] : []));
const WRITE = /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(/g;
const errors = [], lower = [];
let total = 0;
for (const f of files(root)) {
  const rel = relative(root, f).split('\\').join('/');
  const n = readFileSync(f, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // comments don't count
    .reduce((a, l) => a + (l.match(WRITE)?.length ?? 0), 0);
  total += n;
  const max = BASELINE[rel] ?? 0;
  if (n > max) errors.push(`${rel}: ${n} direct innerHTML/outerHTML writes (allowed ${max}). Build the markup with html\`\` and use mount(el, fragment).`);
  else if (n < max) lower.push(`${rel}: ${n} (baseline ${max}) — lower BASELINE in scripts/check-html.mjs`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
if (lower.length) { console.error(`Fewer direct writes than recorded, nice. Update the baseline:\n${lower.join('\n')}`); process.exit(1); }
console.log(`html ok: ${total} direct markup writes left (all within the baseline)`);

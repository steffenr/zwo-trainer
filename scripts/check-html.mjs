#!/usr/bin/env node
// Guards the html`` convention (ui/js/html.js): markup reaches the DOM only through mount(el, html`…`),
// which escapes every interpolated value. Any other innerHTML / outerHTML write or insertAdjacentHTML
// bypasses that and fails this check: build the markup with html`` and call mount(); to empty an
// element use el.replaceChildren(). Run: node scripts/check-html.mjs (CI does too).
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The only places allowed to write markup directly.
const BASELINE = {
  'html.js': 1,      // mount() itself
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

#!/usr/bin/env node
// Checks the UI translations (ui/js/i18n): de.js and fr.js define exactly the keys of en.js, plural
// entries keep their { one, other } shape, placeholders match en ({Label} counts as {label}), and every
// t('key') / data-i18n="key" in ui/ exists in en.js. Run: node scripts/check-i18n.mjs (CI does too).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../ui/js/i18n/en.js';
import { de } from '../ui/js/i18n/de.js';
import { fr } from '../ui/js/i18n/fr.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v]);
const holes = (v) => new Set(forms(v).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1].toLowerCase())));

for (const [lang, dict] of Object.entries({ de, fr })) {
  for (const k of Object.keys(en)) {
    if (!(k in dict)) { errors.push(`${lang}: missing "${k}"`); continue; }
    const a = en[k], b = dict[k];
    if (typeof a === 'object' && (typeof b !== 'object' || !b.one || !b.other)) errors.push(`${lang}: "${k}" must be { one, other }`);
    const want = holes(a);
    for (const h of holes(b)) if (!want.has(h)) errors.push(`${lang}: "${k}" uses {${h}}, which en.js doesn't pass`);
  }
  for (const k of Object.keys(dict)) if (!(k in en)) errors.push(`${lang}: "${k}" is not in en.js`);
}

const dir = join(root, 'ui/js');
const code = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')), readFileSync(join(root, 'ui/index.html'), 'utf8')].join('\n');
for (const m of code.matchAll(/\bt\('([\w.]+)'|data-i18n(?:-title|-aria)?="([\w.]+)"/g)) {
  const k = m[1] || m[2];
  if (!(k in en)) errors.push(`code uses "${k}", which en.js doesn't define`);
}

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`i18n ok: ${Object.keys(en).length} keys in en, de, fr`);

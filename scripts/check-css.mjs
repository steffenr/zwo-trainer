#!/usr/bin/env node
// Checks the CSS structure (ui/css): styles.css declares the layer order and imports every other
// .css file exactly once into a declared layer; imports point at existing files; braces balance;
// nested rules start with "&"; components/ never mention a view (DESIGN.md → CSS structure).
// Run: node scripts/check-css.mjs (CI does too).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../ui/css/', import.meta.url));
const errors = [];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// roots of the screens in views/ (body states, screen containers, the settings dialog)
const VIEW_ROOT = /(body\.(?:riding|compact-riding)|\.(?:ride|compact-ride|view|topbar|wk-layout|tab-pane)(?![\w-])|dialog\.settings)/;
const entry = strip(readFileSync(join(dir, 'styles.css'), 'utf8'));

const order = entry.match(/@layer\s+([\w\s,-]+);/)?.[1].split(',').map((s) => s.trim()) ?? [];
if (!order.length) errors.push('styles.css: no "@layer a, b, …;" order statement');
const imported = new Map();
for (const m of entry.matchAll(/@import\s+url\("([^"]+)"\)\s*(?:layer\(([\w-]+)\))?\s*;/g)) {
  const [, file, layer] = m;
  if (!layer) errors.push(`styles.css: ${file} is imported without layer() (unlayered CSS beats every layer)`);
  else if (!order.includes(layer)) errors.push(`styles.css: ${file} goes into undeclared layer "${layer}"`);
  if (!existsSync(join(dir, file))) errors.push(`styles.css: ${file} does not exist`);
  if (imported.has(file)) errors.push(`styles.css: ${file} is imported twice`);
  imported.set(file, layer);
}
if (strip(entry).replace(/@layer[^;]+;|@import[^;]+;/g, '').trim()) errors.push('styles.css: only @layer and @import belong in the entry file');

const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith('.css') ? [join(d, e.name)] : []));
for (const path of files(dir)) {
  const rel = relative(dir, path).split('\\').join('/');
  if (rel === 'styles.css') continue;
  if (!imported.has(rel)) errors.push(`${rel}: not imported by styles.css`);
  const css = strip(readFileSync(path, 'utf8'));
  if (/@import\b/.test(css)) errors.push(`${rel}: @import only in styles.css`);
  if (/@layer\b/.test(css)) errors.push(`${rel}: the layer comes from styles.css, don't declare one here`);
  if (rel.startsWith('components/')) {
    // a component never knows the screen it is used on; screen-specific variants live in views/
    const m = css.match(VIEW_ROOT);
    if (m) errors.push(`${rel}: mentions the view "${m[1]}"; move that rule to views/`);
  }
  let depth = 0, line = 1, ok = true;
  for (const ch of css) {
    if (ch === '\n') line++;
    if (ch === '{') depth++;
    if (ch === '}' && --depth < 0) { errors.push(`${rel}:${line}: unmatched "}"`); ok = false; break; }
  }
  if (ok && depth) errors.push(`${rel}: ${depth} unclosed "{"`);
  // nested selectors: inside a style rule, a selector must start with & (or be an at-rule)
  const stack = [];
  let buf = '';
  line = 1;
  for (const ch of css) {
    if (ch === '\n') line++;
    if (ch === '{') {
      const sel = buf.trim();
      // nested = any enclosing style rule, also through a nested @media / @supports / @container
      const parentIsRule = stack.includes('rule');
      const isAt = sel.startsWith('@');
      const inKeyframes = stack.includes('keyframes');
      if (parentIsRule && !isAt && !inKeyframes && !sel.split(',').every((s) => s.trim().startsWith('&'))) {
        errors.push(`${rel}:${line}: nested selector "${sel.slice(0, 60)}" must start with &`);
      }
      stack.push(sel.startsWith('@keyframes') ? 'keyframes' : isAt ? 'at' : inKeyframes ? 'frame' : 'rule');
      buf = '';
    } else if (ch === '}') { stack.pop(); buf = ''; }
    else if (ch === ';') buf = '';
    else buf += ch;
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`css ok: ${imported.size} files in layers ${order.join(' → ')}`);

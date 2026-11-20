#!/usr/bin/env node
// Overflow check for the compact ride view, on the real ui/ in headless Chromium against the screenshot mock.
//
//   npx -y -p playwright node scripts/shots/compact-fit.mjs [--theme dark|light] [--lang en|de|fr] [--scenario name]
//
// For every size and scenario: the layout attribute matches compactMode(), no element leaves its panel or the
// window, no text is clipped, no SVG text leaves its SVG, and no text says null / NaN / undefined.
// One line per case; the last line is `compact-fit: <n> problems`; exit code 1 when there are problems.
// Playwright comes from npx (no package.json on purpose); run `npx -y playwright install chromium` once.
import { loadPlaywright, startServer, loadFixture, newShotPage, helpers } from './lib.mjs';
import { compactMode } from '../../ui/js/compact.js';
import SHOTS, { SSS, rideTo, testTo } from './shots.mjs';

void SHOTS;
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const themes = opt('--theme') ? [opt('--theme')] : ['dark', 'light'];
const langs = opt('--lang') ? [opt('--lang')] : ['en', 'de', 'fr'];
const only = opt('--scenario');

const VERTICAL = [[240, 200], [240, 300], [240, 400], [240, 520], [240, 640], [240, 760], [320, 560]];
const HORIZONTAL = [[640, 195], [960, 195], [1400, 195], [1800, 200], [2400, 200], [960, 340]]; // the wide bar window is 195-200 px high
const SIZES = [...VERTICAL, ...HORIZONTAL];

const mode = (m, more) => (p) => { p.settings.mode = m; more?.(p); };
/** Scenarios: how the ride is set up before the sizes are walked through. */
const SCENARIOS = {
  steady: { rider: mode('workouts'), setup: (s) => rideTo(s, SSS, 18 * 60 + 44) },
  allout: { rider: mode('tests'), setup: (s) => testTo(s, '20min', 54 * 60 + 15) },
  nosensor: {
    rider: mode('workouts', (p) => { p.settings.devices = {}; }),
    async setup(s) {
      await s.open('', { speed: '10' });
      await s.click(`.wrow[data-file="${SSS}"] [data-act="ride-free"], .wrow[data-file="${SSS}"] [data-act="start"]`);
      await s.tick(2000);
    },
  },
  // the longest values the layout has to take: a ramp 100–1000 W, four-digit power, ten hours, three-digit heart rate / cadence
  stress: {
    rider: mode('workouts'),
    setup: (s) => rideTo(s, SSS, 18 * 60 + 44),
    async prepare(page) {
      await page.evaluate(async () => {
        const set = (el, text) => { if (el) el.textContent = text; };
        set(document.querySelector('#cmp-target-v'), '100–1000 W');
        set(document.querySelector('#cmp-pow'), '1234');
        set(document.querySelector('#cmp-hr'), '188');
        set(document.querySelector('#cmp-cad'), '120');
        document.querySelectorAll('.cmp-wleft').forEach((e) => set(e, '10:15:00'));
        (await import('/js/compact.js')).fitTexts(document.querySelector('.compact-ride'));
        // the longest graph labels (French / German words, ten hours, a wide ramp); the ride repaints them on its next tick
        const { ride } = await import('/js/core.js');
        ride.cGraph.update(ride.t, {
          nowKicker: 'Maintenant', now: ['Maintenant Maximalbelastung', 'Maximalbelastung'], nowSub: '10:15:00 restant',
          nextKicker: 'Nächstes', nextWatts: '100–1000 W', nextSub: 'dans 10:15:00',
          next: ['Nächstes 100–1000 W · dans 10:15:00', 'Nächstes 100–1000 W'],
        });
      });
    },
    /** every shrinkable value stays at or above its floor (data-fit) */
    async floors(page) {
      return page.evaluate(() => [...document.querySelectorAll('.compact-ride [data-fit]')]
        .filter((e) => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < Number(e.dataset.fit) - 0.01)
        .map((e) => `below its floor: ${e.id || e.className} ${getComputedStyle(e).fontSize} < ${e.dataset.fit}px`));
    },
  },
  last: {
    rider: mode('workouts'),
    async setup(s) {
      await rideTo(s, SSS, 18 * 60 + 44);
      // jump to the last 60 s and pause, so the ride does not end while the sizes are walked through
      await s.page.evaluate(async () => { const { ride } = await import('/js/core.js'); ride.go(ride.w.duration - 60); });
      await s.page.evaluate(() => document.querySelector('#ride [data-act="play"]').click());
      await s.tick(500);
    },
  },
};

/** Runs in the page: every problem found in the compact view, as readable strings. */
function inspect() {
  const root = document.querySelector('.compact-ride');
  const out = [];
  if (!root) return ['no .compact-ride'];
  const boxes = '.cp, .compact-foot, .compact-head, .compact-rail';
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''} "${(el.textContent || '').trim().slice(0, 24)}"`;
  const win = { w: window.innerWidth, h: window.innerHeight };
  for (const el of root.querySelectorAll('*')) {
    if (el.closest('svg') && !(el instanceof SVGTextElement)) continue;
    if (el.closest('[hidden]') || el.classList.contains('cg-measure')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) continue; // visually hidden helpers
    const parent = (el.matches(boxes) ? el.parentElement : el).closest(boxes) || root;
    let b = parent.getBoundingClientRect();
    // the heading row and the rail keep the macOS window buttons free: compare with their content box
    if (parent.matches('.compact-head, .compact-rail')) {
      const pcs = getComputedStyle(parent);
      b = { left: b.left + parseFloat(pcs.paddingLeft), top: b.top + parseFloat(pcs.paddingTop), right: b.right, bottom: b.bottom };
    }
    const outside = r.right > b.right + 0.5 || r.left < b.left - 0.5 || r.bottom > b.bottom + 0.5 || r.top < b.top - 0.5;
    const offscreen = r.right > win.w + 0.5 || r.bottom > win.h + 0.5;
    const clipped = !(el instanceof SVGElement) && el.children.length === 0 && cs.display !== 'inline' && el.scrollWidth > el.clientWidth + 1;
    if (outside || offscreen || clipped) out.push(`${outside ? 'outside panel' : offscreen ? 'outside window' : 'clipped'}: ${name(el)}`);
  }
  for (const svg of root.querySelectorAll('svg')) {
    const sr = svg.getBoundingClientRect();
    for (const tx of svg.querySelectorAll('text:not(.cg-measure)')) {
      if (getComputedStyle(tx).visibility === 'hidden' || !tx.textContent.trim()) continue;
      const b = tx.getBoundingClientRect();
      if (b.right > sr.right + 0.5 || b.left < sr.left - 0.5 || b.top < sr.top - 0.5 || b.bottom > sr.bottom + 0.5) out.push(`svg text outside svg: "${tx.textContent.trim().slice(0, 24)}" x ${b.left.toFixed(0)}..${b.right.toFixed(0)} in ${sr.left.toFixed(0)}..${sr.right.toFixed(0)}, y ${b.top.toFixed(0)}..${b.bottom.toFixed(0)} in ${sr.top.toFixed(0)}..${sr.bottom.toFixed(0)}`);
    }
  }
  const bad = /\b(null|NaN|undefined)\b/.exec(root.innerText);
  if (bad) out.push(`text says ${bad[0]}`);
  return out;
}

/** Runs in the page when the graph is shown: one polygon per segment, the position line inside the drawing, labels only where they belong. */
async function graphProblems(page, scenario, layout) {
  return page.evaluate(async ([scenario, layout]) => {
    const out = [];
    const { ride } = await import('/js/core.js');
    const svg = document.querySelector('#cmp-graph svg');
    if (!svg) return ['no graph drawn'];
    const n = svg.querySelectorAll('polygon').length;
    if (n !== ride.w.segments.length) out.push(`graph has ${n} bars for ${ride.w.segments.length} segments`);
    const sr = svg.getBoundingClientRect(), pr = svg.querySelector('.cg-pos').getBoundingClientRect();
    if (pr.left < sr.left - 1 || pr.right > sr.right + 1 || pr.top < sr.top - 1 || pr.bottom > sr.bottom + 1) out.push('position line outside the graph');
    if (layout === 'v') { // labels live in the 80 px gutter left of the bars
      for (const tx of svg.querySelectorAll('text:not(.cg-measure)')) {
        if (getComputedStyle(tx).visibility === 'hidden' || !tx.textContent.trim()) continue;
        const right = tx.getBoundingClientRect().right - sr.left;
        if (right > 80.5) out.push(`gutter overflow: "${tx.textContent.trim().slice(0, 24)}" reaches ${right.toFixed(0)} px of 80`);
      }
    }
    const shown = [...svg.querySelectorAll(layout === 'v' ? 'text.cg-k' : 'text.cg-lab:not(.cg-measure)')].filter((t) => getComputedStyle(t).visibility !== 'hidden' && t.textContent.trim());
    if (scenario === 'last' && shown.length !== 1) out.push(`last segment: ${shown.length} labels shown, expected only the "now" label`);
    // the stress strings are far longer than any real label: in a narrow bar (a 190 px graph) none of them has to fit
    if (scenario !== 'last' && shown.length < 1 && !(scenario === 'stress' && layout === 'h' && window.innerWidth < 900)) out.push('no label shown');
    return out;
  }, [scenario, layout]);
}

/** The wide bar is read from a distance: its values are large (bigger again when the bar is tall). Narrow windows shrink them to fit, so only >= 900 px wide is checked. */
async function fontProblems(page, w) {
  if (w < 900) return [];
  return page.evaluate(() => {
    const out = [], px = (sel) => { const e = document.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    const tall = document.querySelector('.compact-main').getBoundingClientRect().height >= 170;
    const lab = [...document.querySelectorAll('.cg-lab:not(.cg-measure)')].find((t) => t.textContent.trim());
    const want = tall ? { tgt: 34, tile: 40, wl: 34, lab: 17 } : { tgt: 24, tile: 30, wl: 26, lab: 14 };
    const got = { tgt: px('#cmp-target'), tile: px('#cmp-hr'), wl: px('.cp-graph .cmp-wleft'), lab: lab ? parseFloat(getComputedStyle(lab).fontSize) : 0 };
    const wlText = document.querySelector('.cp-graph .cmp-wleft')?.textContent ?? '';
    for (const k of Object.keys(want)) if (!(k === 'wl' && wlText.length > 5) && got[k] < want[k] - 0.01) out.push(`${tall ? 'tall' : 'flat'} bar: ${k} is ${got[k]} px, expected at least ${want[k]}`);
    return out;
  });
}

/** The window must be draggable: empty spots of the heading row (vertical) or of the rail and the gap (horizontal) carry data-tauri-drag-region, and the buttons are equally sized. */
async function dragProblems(page, layout) {
  return page.evaluate((layout) => {
    const out = [];
    const spot = (label, x, y) => {
      const el = document.elementFromPoint(x, y);
      if (!el?.closest('[data-tauri-drag-region]') || !el.hasAttribute('data-tauri-drag-region')) out.push(`not draggable: ${label} (${el ? `${el.tagName.toLowerCase()}.${el.className}` : 'nothing'})`);
    };
    if (layout === 'h') {
      const r = document.querySelector('.compact-rail').getBoundingClientRect();
      spot('rail, beside the macOS window buttons', r.left + 6, r.top + 4); // the rail's 32 px top padding stays free even with the gear row shown
      const g = document.querySelector('.cp-gap').getBoundingClientRect();
      if (g.width > 12) spot('gap between live block and graph', g.left + g.width / 2, g.top + g.height / 2);
    } else {
      const r = document.querySelector('.compact-head').getBoundingClientRect();
      spot('heading row, beside the window buttons', r.left + 6, r.top + r.height / 2);
    }
    if (layout === 'h') { // a wide window is a bar: its panels stop growing and the window height is limited
      const m = document.querySelector('.compact-main').getBoundingClientRect();
      if (m.height > 184.5) out.push(`horizontal panels are ${m.height.toFixed(0)} px high, expected at most 184`);
    }
    if (layout === 'h') { // live block and graph keep at least 16 px between them
      const gap = document.querySelector('.cp-gap').getBoundingClientRect().width;
      if (gap < 15.5) out.push(`gap between live block and graph is ${gap.toFixed(0)} px, expected at least 16`);
    }
    const bar = !!window.__shots.bar, wantBar = layout === 'h';
    if (bar !== wantBar) out.push(`window held to the bar height: ${bar}, expected ${wantBar}`);
    const sizes = [...document.querySelectorAll('.compact-ride .ctl, .compact-ride .icon-btn')].filter((b) => b.getClientRects().length).map((b) => `${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
    if (new Set(sizes).size > 1) out.push(`buttons differ in size: ${[...new Set(sizes)].join(', ')}`);
    return out;
  }, layout);
}

/** With the paused fake clock the page only renders when asked: a tiny screenshot is a frame, and observers (resize) run in it. */
async function settle(s) {
  for (let i = 0; i < 3; i++) { await s.tick(300); await s.page.screenshot({ type: 'jpeg', quality: 1 }); }
}

const { chromium } = loadPlaywright('scripts/shots/compact-fit.mjs');
const server = await startServer();
const fixture = loadFixture();
const browser = await chromium.launch();
let problems = 0;
const report = (ok, label, details = []) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) { problems += Math.max(1, details.length); for (const d of details.slice(0, 8)) console.log(`     ${d}`); }
};

for (const theme of themes) {
  for (const lang of langs) {
    for (const [scenario, def] of Object.entries(SCENARIOS)) {
      if (only && only !== scenario) continue;
      const { page, context, errors } = await newShotPage(browser, { base: server.base, fixture, theme, viewport: [960, 340], tweakRider: (p) => { def.rider(p); p.settings.language = lang; } });
      const s = helpers(page, server.base, theme);
      try {
        await def.setup(s);
        await s.click('#btn-compact');
        for (const [w, h] of SIZES) {
          await s.resize(w, h);
          await settle(s);
          if (def.prepare) await def.prepare(page);
          const label = `${w}x${h} ${lang} ${theme} ${scenario}`;
          const found = await page.evaluate(inspect);
          if (def.floors) found.push(...await def.floors(page));
          const layout = await page.evaluate(() => document.querySelector('.compact-ride')?.dataset.layout);
          const want = compactMode(w, h).layout;
          if (layout !== want) found.unshift(`data-layout is ${layout}, expected ${want}`);
          found.push(...await dragProblems(page, want));
          if (want === 'h' && scenario !== 'stress') found.push(...await fontProblems(page, w));
          if (compactMode(w, h).graph) found.push(...await graphProblems(page, scenario, want));
          report(found.length === 0, label, found);
        }
        if (scenario === 'steady' && theme === themes[0] && lang === langs[0]) {
          // resizing across the layout switch must not rebuild the compact DOM
          await s.resize(960, 150); await settle(s);
          await page.evaluate(() => { document.querySelector('.compact-ride').dataset.probe = '1'; });
          await s.resize(240, 520); await settle(s);
          await s.resize(960, 150); await settle(s);
          const kept = await page.evaluate(() => document.querySelector('.compact-ride').dataset.probe === '1');
          report(kept, `flip 960x150 -> 240x520 -> 960x150 keeps the DOM`, kept ? [] : ['the compact section was rebuilt']);
          // the horizontal labels are measured when their text or place changes, not on every tick (4 ticks per second)
          await s.tick(1000); await s.page.screenshot({ type: 'jpeg', quality: 1 }); // warm up: the widths of the unchanged strings get cached
          await page.evaluate(() => { window.__tl = 0; const f = SVGTextContentElement.prototype.getComputedTextLength; SVGTextContentElement.prototype.getComputedTextLength = function (...a) { window.__tl++; return f.apply(this, a); }; });
          await s.tick(1000); await s.page.screenshot({ type: 'jpeg', quality: 1 });
          const measured = await page.evaluate(() => window.__tl);
          report(measured <= 4, `graph labels measured ${measured}x in 1 s of ticks (limit 4)`, measured <= 4 ? [] : ['text is measured on every tick']);
        }
        if (errors.length) report(false, `page errors ${lang} ${theme} ${scenario}`, errors);
      } catch (e) {
        report(false, `${lang} ${theme} ${scenario}`, [e.message.split('\n')[0]]);
      } finally {
        await context.close();
      }
    }
  }
}
await browser.close();
server.close();
console.log(`compact-fit: ${problems} problems`);
process.exit(problems ? 1 : 0);

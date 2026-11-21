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
const HORIZONTAL = [[640, 195], [960, 195], [1400, 195], [1800, 195], [2400, 195]]; // the wide bar window is 195 px high and at least 640 wide
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
        // the longest card texts (a wide ramp, ten hours, French words); the ride repaints them on its next tick
        set(document.querySelector('#cmp-cur'), '10:15:00'); set(document.querySelector('#cmp-cur-s'), 'à 100–1000 W');
        set(document.querySelector('#cmp-next'), '100–1000 W'); set(document.querySelector('#cmp-next-s'), 'pendant 10:15:00');
        (await import('/js/compact.js')).fitTexts(document.querySelector('.compact-ride'));
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
    // an ellipsis is the deliberate last resort (the Current / Next cards in a narrow column), not a clip
    const clipped = !(el instanceof SVGElement) && el.children.length === 0 && cs.display !== 'inline' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
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

/** Runs in the page when the graph is shown: one polygon per segment, the position line inside the drawing, no text in the drawing, and the Current / Next cards where they belong. */
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
    if (svg.querySelector('text')) out.push('the graph still draws text (Current and Next are cards)');
    const cards = document.querySelector('.compact-ride').dataset.cards === '1';
    const cur = document.querySelector('.cp-card.cur'), next = document.querySelector('.cp-card.next');
    const shown = (e) => e.getClientRects().length > 0;
    if (cards !== shown(cur) || cards !== shown(next)) out.push(`cards ${shown(cur) ? 'shown' : 'hidden'}, expected ${cards ? 'shown' : 'hidden'}`);
    if (cards) {
      const panel = document.querySelector('.cp-graph').getBoundingClientRect(), a = cur.getBoundingClientRect(), b = next.getBoundingClientRect();
      for (const [name, r] of [['Current', a], ['Next', b]]) if (r.left < panel.left - 0.5 || r.right > panel.right + 0.5 || r.top < panel.top - 0.5 || r.bottom > panel.bottom + 0.5) out.push(`${name} card sticks out of the graph panel`);
      if (layout === 'v') {
        if (a.top < sr.bottom - 1 || b.top < sr.bottom - 1) out.push('vertical: the cards are not under the graph');
        if (sr.height < 60) out.push(`vertical: the graph is only ${sr.height.toFixed(0)} px high beside the cards, expected at least 60`);
      } else {
        if (a.left < sr.right - 1 || b.left < sr.right - 1) out.push('horizontal: the cards are not right of the graph');
        if (Math.abs(a.left - b.left) > 1 || b.top < a.bottom - 1) out.push('horizontal: the cards are not one above the other');
        if (sr.height < 120) out.push(`horizontal: the graph is only ${sr.height.toFixed(0)} px high, expected at least 120`);
      }
      const val = (c) => c.querySelector('b').textContent.trim();
      if (!/^\d+:\d\d/.test(val(cur))) out.push(`Current card says "${val(cur)}", expected the time left`);
      if (!cur.querySelector('small').textContent.trim()) out.push('Current card shows no target');
      if (scenario === 'last') { if (val(next) !== '–') out.push(`last segment: Next card says "${val(next)}", expected –`); }
      else if (val(next) === '–' || !next.querySelector('small').textContent.trim()) out.push('Next card is empty');
    }
    return out;
  }, [scenario, layout]);
}

/** Vertical layout: the target and the gauge number are large. */
async function verticalFontProblems(page) {
  return page.evaluate(() => {
    const out = [], px = (sel) => { const e = document.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    const col = document.querySelector('.compact-ride').dataset.live === 'col';
    const tgt = px('#cmp-target'), pow = px('#cmp-pow');
    if (tgt < (col ? 26 : 22)) out.push(`vertical ${col ? 'column' : 'row'}: target is ${tgt} px, expected at least ${col ? 26 : 22}`);
    if (pow < (col ? 34 : 24)) out.push(`vertical ${col ? 'column' : 'row'}: gauge number is ${pow.toFixed(1)} px, expected at least ${col ? 34 : 24}`);
    return out;
  });
}

/** The wide bar is read from a distance: its values are large (bigger again when the bar is tall). Narrow windows shrink them to fit, so only >= 900 px wide is checked. */
async function fontProblems(page, w) {
  if (w < 900) return [];
  return page.evaluate(() => {
    const out = [], px = (sel) => { const e = document.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    const tall = document.querySelector('.compact-main').getBoundingClientRect().height >= 170;
    const want = tall ? { tgt: 34, tile: 40, wl: 34, card: 22 } : { tgt: 24, tile: 30, wl: 26, card: 22 };
    const got = { tgt: px('#cmp-target'), tile: px('#cmp-hr'), wl: px('.cp-graph .cmp-wleft'), card: px('#cmp-cur') };
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
    if (layout === 'h') { // the graph is at least 60 % of the window width once the window is wide enough (the live block keeps its 460 px first: 100vw - 540 px bound)
      const g = document.querySelector('.cp-graph').getBoundingClientRect().width;
      if (innerWidth >= 1400 && g < innerWidth * 0.6 - 1) out.push(`graph is ${g.toFixed(0)} px of ${innerWidth} px (${(g / innerWidth * 100).toFixed(0)} %), expected at least 60 %`);
      const rail = [...document.querySelectorAll('.compact-rail .ctl, .compact-rail .icon-btn')].filter((b) => b.getClientRects().length && !b.closest('.compact-gears'));
      if (new Set(rail.map((b) => Math.round(b.getBoundingClientRect().left))).size > 1) out.push('rail buttons are not in one column');
    }
    if (layout === 'h') { // on macOS the window buttons (80 px wide from the window edge, 32 px high) must not cover the live block or its heading
      const root = document.documentElement, was = root.dataset.os;
      root.dataset.os = 'mac';
      const left = document.querySelector('.cp-live').getBoundingClientRect().left;
      if (left < 80) out.push(`macOS: the live block starts at ${left.toFixed(0)} px, the window buttons reach 80 px`);
      if (was === undefined) delete root.dataset.os; else root.dataset.os = was;
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

/** The switch button and the V key flip between the wide bar and the tall column, each at the size it had last (defaults 960x195 and 300x640). */
async function switchProblems(page, s) {
  const out = [];
  const click = () => page.evaluate(() => { const b = [...document.querySelectorAll('.compact-ride [data-act="layout"]')].find((e) => e.getClientRects().length); if (b) b.click(); return !!b; });
  const asked = () => page.evaluate(() => ({ size: window.__shots.size, bar: window.__shots.bar }));
  const expect = async (label, size, bar) => { const a = await asked(); if (JSON.stringify(a.size) !== JSON.stringify(size) || a.bar !== bar) out.push(`${label}: asked for ${JSON.stringify(a)}, expected size ${JSON.stringify(size)} and bar ${bar}`); };
  await s.resize(960, 195); await settle(s);
  if (!await click()) return ['no visible layout switch button in the bar'];
  await s.tick(300); await expect('bar -> column', [300, 640], false);
  await s.resize(280, 500); await settle(s); // the rider drags the column to another size
  if (!await click()) return [...out, 'no visible layout switch button in the column'];
  await s.tick(300); await expect('column -> bar', [960, 195], true);
  await s.resize(960, 195); await settle(s);
  await page.keyboard.press('v'); await s.tick(300); await expect('V key, bar -> column (remembered size)', [280, 500], false);
  await s.resize(280, 500); await settle(s);
  return out;
}

/**
 * Leaving compact: while the native window resizes it passes through sizes of both layouts. The UI must not set
 * window limits for them (they would fight the resize and leave the full view with a 320 px maximum width), and the
 * compact view is gone afterwards. Entering again works.
 */
async function exitProblems(page, s) {
  const out = [];
  await s.resize(960, 195); await settle(s);
  await page.evaluate(() => { window.__shots.windowDelay = 600; window.__shots.mark = window.__shots.calls.length; });
  await page.evaluate(() => [...document.querySelectorAll('.compact-ride [data-act="expand"]')].find((e) => e.getClientRects().length).click());
  for (const [w, h] of [[960, 400], [900, 640], [900, 900]]) { await s.resize(w, h); await s.tick(40); await page.screenshot({ type: 'jpeg', quality: 1 }); }
  const during = await page.evaluate(() => window.__shots.calls.slice(window.__shots.mark).filter((c) => c === 'ride_window_bar').length);
  if (during) out.push(`${during} ride_window_bar call(s) while the native window was resizing`);
  await s.tick(800); await settle(s);
  if (await page.evaluate(() => document.body.classList.contains('compact-riding'))) out.push('the compact view is still showing after leaving');
  await page.evaluate(() => { window.__shots.windowDelay = 0; });
  await s.click('#btn-compact'); await s.resize(960, 195); await settle(s);
  if (!await page.evaluate(() => document.body.classList.contains('compact-riding'))) out.push('entering compact again did not work');
  return out;
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
          if (want === 'v' && scenario === 'steady' && h >= 360) found.push(...await verticalFontProblems(page));
          if (compactMode(w, h).graph) found.push(...await graphProblems(page, scenario, want));
          if (opt('--png')) await page.screenshot({ path: `${opt('--png')}/${label.replaceAll(' ', '_')}.png` }); // for a look at the real UI
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
          const sw = await switchProblems(page, s);
          report(sw.length === 0, 'layout switch (button and V key) between bar and column, remembering sizes', sw);
          await s.resize(960, 195); await settle(s);
          // the horizontal labels are measured when their text or place changes, not on every tick (4 ticks per second)
          await s.tick(1000); await s.page.screenshot({ type: 'jpeg', quality: 1 }); // warm up: the widths of the unchanged strings get cached
          await page.evaluate(() => { window.__tl = 0; const f = SVGTextContentElement.prototype.getComputedTextLength; SVGTextContentElement.prototype.getComputedTextLength = function (...a) { window.__tl++; return f.apply(this, a); }; });
          await s.tick(1000); await s.page.screenshot({ type: 'jpeg', quality: 1 });
          const measured = await page.evaluate(() => window.__tl);
          report(measured <= 4, `graph labels measured ${measured}x in 1 s of ticks (limit 4)`, measured <= 4 ? [] : ['text is measured on every tick']);
          const exit = await exitProblems(page, s);
          report(exit.length === 0, 'leaving compact: no window limits fight the native resize', exit);
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

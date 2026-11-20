// Shared by the screenshot runner (run.mjs) and the compact-view overflow check (compact-fit.mjs):
// Playwright loader, static server for ui/, and a page with the mocked Tauri backend and a fake clock.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tauriMock } from './mock.js';
import { rider, backend, NOW, TIMEZONE } from './rider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../..');
export const uiDir = path.join(repo, 'ui');

/** Playwright comes from npx (no package.json on purpose). `script` only names the command in the error. */
export function loadPlaywright(script = 'scripts/shots/run.mjs') {
  const roots = process.env.PATH.split(path.delimiter).filter((d) => d.endsWith(`node_modules${path.sep}.bin`)).map((d) => path.dirname(d));
  roots.push(path.join(repo, 'node_modules'));
  try { roots.push(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* no npm */ }
  for (const root of roots) {
    try { return createRequire(path.join(root, 'noop.js'))('playwright'); } catch { /* next */ }
  }
  console.error(`Playwright not found. Run: npx -y -p playwright node ${script} (once before: npx -y playwright install chromium)`);
  process.exit(1);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.png': 'image/png', '.woff2': 'font/woff2' };

/** Static server for ui/ on a free local port. */
export async function startServer(ui = uiDir) {
  const server = http.createServer((req, res) => {
    const p = path.join(ui, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!p.startsWith(ui) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/** The sample library (2 plans, 2 collections, 45 workouts) the mock serves. */
export const loadFixture = () => ({
  library: JSON.parse(fs.readFileSync(path.join(here, 'fixture', 'library.json'), 'utf8')),
  workouts: JSON.parse(fs.readFileSync(path.join(here, 'fixture', 'workouts.json'), 'utf8')),
});

/**
 * A page with the Tauri mock, the sample rider (`tweakRider(profile)` may change it first) and a fake clock
 * that is paused: time moves only through page.clock.runFor(), so every run renders the same pixels.
 */
export async function newShotPage(browser, { base, fixture, theme, viewport = [1600, 1000], scale = 1, free, tweakRider }) {
  const context = await browser.newContext({
    viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: scale, colorScheme: theme,
    timezoneId: TIMEZONE, locale: 'en-US', reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const profile = rider();
  tweakRider?.(profile);
  await page.clock.install({ time: new Date(Date.parse(NOW) - 1000) });
  await page.clock.pauseAt(new Date(NOW));
  await page.addInitScript(tauriMock, { ...fixture, ...backend, profile, freePower: free, version: 'dev' });
  return { page, context, errors };
}

/** The API shots use to drive the app (open, tick, click, key, emit, resize, wait). */
export function helpers(page, base, theme) {
  const s = {
    page, theme,
    /** Open the app at a hash route (e.g. '#/history'), after `boot` has finished. */
    async open(hash = '', params = {}) {
      const q = new URLSearchParams({ profile: 'p_lena', ...params });
      await page.goto(`${base}index.html?${q}${hash}`);
      await page.waitForFunction(() => document.querySelector('#view')?.childElementCount > 0 || !document.querySelector('#ride')?.hidden);
      await s.tick(600);
    },
    /** Advance the fake clock: timers, the ride loop and the simulator run exactly this long. */
    tick: (ms) => page.clock.runFor(ms),
    /** Click the n-th match (default the first) and let the UI settle. */
    async click(selector, n = 0) {
      await page.locator(selector).nth(n).click();
      await s.tick(400);
    },
    async key(k) { await page.keyboard.press(k); await s.tick(300); },
    /** Fake an event from Rust (device-status, battery, sensor, button …). */
    emit: (event, payload) => page.evaluate(([e, p]) => window.__shots.emit(e, p), [event, payload]),
    /** Resize the viewport mid-shot (compact view). */
    resize: (w, h) => page.setViewportSize({ width: w, height: h }),
    /** Wait for an element. */
    wait: (selector) => page.locator(selector).first().waitFor(),
  };
  return s;
}

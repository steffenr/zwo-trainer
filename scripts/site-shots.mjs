#!/usr/bin/env node
// Website screenshots of the Settings dialog (site/img/*-card-{dark,light}.webp), taken from the
// real UI in headless Chromium with a stubbed Tauri IPC (sample rider "Lena", no Rust, no devices).
//
//   npx -y -p playwright node scripts/site-shots.mjs               # all shots → site/img
//   npx -y -p playwright node scripts/site-shots.mjs --out /tmp/x  # elsewhere, to compare first
//   npx -y -p playwright node scripts/site-shots.mjs riding sync   # only these tabs
//
// Playwright is not a repo dependency (there is no package.json on purpose): npx fetches it, and
// `npx -y playwright install chromium` downloads the browser once. A global install works too.
// The mock lives only here; it is never part of ui/ or the app bundle.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.join(repo, 'ui');

/** Settings tab → site image name. */
const SHOTS = { rider: 'settings-card', riding: 'riding-card', sync: 'sync-card' };
const QUALITY = 0.82; // WebP quality; keeps each image around 30–60 KB

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? path.resolve(args.splice(oi, 2)[1]) : path.join(repo, 'site', 'img');
const tabs = args.length ? args : Object.keys(SHOTS);
for (const tab of tabs) if (!SHOTS[tab]) { console.error(`unknown tab "${tab}" (use: ${Object.keys(SHOTS).join(', ')})`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

/** Playwright from `npx -p playwright` (its node_modules/.bin is on PATH), the project or the global npm root. */
function loadPlaywright() {
  const roots = process.env.PATH.split(path.delimiter).filter((d) => d.endsWith(`node_modules${path.sep}.bin`)).map((d) => path.dirname(d));
  roots.push(path.join(repo, 'node_modules'));
  try { roots.push(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { /* no npm */ }
  for (const root of roots) {
    try { return createRequire(path.join(root, 'noop.js'))('playwright'); } catch { /* next */ }
  }
  console.error('Playwright not found. Run: npx -y -p playwright node scripts/site-shots.mjs (once before: npx -y playwright install chromium)');
  process.exit(1);
}
const { chromium } = loadPlaywright();

// static server for ui/ (fetch() of sounds and ES modules need http, not file://)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = path.join(ui, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(ui) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/`;

/** Runs in the page before app.js: window.__TAURI__ answering the commands boot and Settings use. */
function tauriStub(theme) {
  const now = new Date().toISOString();
  const profile = {
    id: 'p_lena', name: 'Lena', avatar: { color: '#0ea5c6', emoji: null }, createdAt: now, updatedAt: now,
    settings: {
      ftp: 265, maxHr: 188, weight: 68, zones: [55, 75, 90, 105], bests: { s5: 960, m1: 448, m5: 318, m20: 279 },
      theme, language: 'en', mode: 'plans', beeps: true, beepDirection: true, endChime: true, autoPause: true,
      coachHints: true, keyboardShortcuts: true, overlay: { power: true, cadence: true, hr: true },
      shifting: { mode: 'ask', difficulty: 'medium' }, zwoDir: '/Users/lena/Training/Workouts',
      devices: { trainer: { name: 'KICKR CORE 5D2A' }, hr: { name: 'HRM-Pro+ 41822' }, controllers: [{ name: 'Zwift Ride' }] },
      garmin: { mode: 'auto', autoOpen: false, folder: null }, services: { intervals: { mode: 'auto' } }, folderKinds: {},
    },
    activePlan: null, plans: {}, history: [], tests: [], favorites: [],
  };
  const R = {
    app_state: { profiles: [{ id: 'p_lena', name: 'Lena' }], profile, sync: { provider: 'icloud', dir: '/Users/lena/Library/Mobile Documents/com~apple~CloudDocs/zwoTrainer', auto: true, lastSync: now } },
    scan_library: { root: '/Users/lena/Training/Workouts', plans: [], singles: [] },
    sync_now: { at: now, changed: false, pulled: 0 },
    sync_targets: [
      { provider: 'icloud', label: 'iCloud Drive', path: '/Users/lena/Library/Mobile Documents/com~apple~CloudDocs', found: true },
      { provider: 'dropbox', label: 'Dropbox', path: null, found: false },
      { provider: 'nextcloud', label: 'Nextcloud', path: '/Users/lena/Nextcloud', found: true },
    ],
    garmin_status: { connected: true, name: 'Lena Berg' },
    services_status: [
      { id: 'intervals', name: 'Intervals.icu', kind: 'apikey', connected: true, account: 'Lena Berg', manualUrl: null, manualZip: false, hint: 'Paste your personal API key from intervals.icu → Settings → Developer Settings.' },
      { id: 'coros', name: 'COROS', kind: 'manual', connected: false, account: null, manualUrl: 'https://t.coros.com', manualZip: true, hint: 'Training Hub → Activity List → Import Data, then choose the highlighted ZIP.' },
    ],
    update_status: { auto: true, available: true },
    ble_current: {}, ctrl_list: [],
  };
  window.__TAURI__ = {
    core: { invoke: async (cmd) => (cmd in R ? structuredClone(R[cmd]) : null) },
    event: { listen: async () => () => {} },
    app: { getVersion: async () => 'dev' },
  };
}

/** PNG buffer → WebP buffer via Chromium's canvas encoder (no image tools needed). */
async function toWebp(page, png) {
  const url = await page.evaluate(async ([data, q]) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', q);
  }, [png.toString('base64'), QUALITY]);
  return Buffer.from(url.split(',')[1], 'base64');
}

const browser = await chromium.launch();
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1400 }, deviceScaleFactor: 2, colorScheme: theme });
    page.on('pageerror', (e) => { failed = true; console.error(`page error (${theme}): ${e.message}`); });
    await page.addInitScript(tauriStub, theme);
    await page.goto(`${base}index.html?profile=p_lena`);
    await page.waitForSelector('#btn-settings');
    await page.waitForTimeout(500);
    await page.click('#btn-settings');
    await page.waitForSelector('#modal[open]');
    for (const tab of tabs) {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(300);
      await page.mouse.move(0, 0); // no hover state in the shot
      const png = await page.locator('#modal').screenshot({ animations: 'disabled' });
      const file = path.join(out, `${SHOTS[tab]}-${theme}.webp`);
      const webp = await toWebp(page, png);
      fs.writeFileSync(file, webp);
      console.log(`${path.relative(repo, file)}  ${Math.round(webp.length / 1024)} KB`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);

#!/usr/bin/env node
// Screenshot runner for the website (site/img). Drives the real ui/ in headless Chromium against a
// mocked Tauri backend (mock.js), a sample rider (rider.mjs), the fixture library (fixture/) and a
// fixed, fake clock — so the same code gives the same pixels and unchanged shots are skipped.
//
//   npx -y -p playwright node scripts/shots/run.mjs                # every shot, both themes → site/img
//   npx -y -p playwright node scripts/shots/run.mjs ride compact   # only these shots
//   … --list                     list the shots and exit
//   … --theme dark               one theme only
//   … --out <dir>                write somewhere else (compare first); site/*.html is left alone
//   … --sheet <file.png>         contact sheet of the changed shots (default: <tmp>/zwo-shots-sheet.png)
//   … --force                    write even when the pixels did not change
//
// Output: one line per image (unchanged / updated n % / new / FAILED). Only changed images are
// written, the width/height attributes in site/*.html are kept in sync, and all changed images land
// on one contact sheet, so a review needs a single look instead of one per file.
// Shots are defined in shots.mjs. Playwright comes from npx (no package.json on purpose);
// run `npx -y playwright install chromium` once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SHOTS from './shots.mjs';
import { repo, loadPlaywright, startServer, loadFixture, newShotPage, helpers as shotHelpers } from './lib.mjs';

const siteDir = path.join(repo, 'site');
const QUALITY = 0.82;            // WebP quality (images stay ~20–70 KB)
const NOISE = { delta: 16, share: 0.002 }; // ≤ 0.2 % of pixels off by > 16 = encoder noise, not a change

// ------------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : null; };
const flag = (name) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const outOpt = opt('--out');
const themeOpt = opt('--theme');
const sheetPath = opt('--sheet') || path.join(os.tmpdir(), 'zwo-shots-sheet.png');
const force = flag('--force');
const list = flag('--list');
const out = outOpt ? path.resolve(outOpt) : path.join(siteDir, 'img');
const themes = themeOpt ? [themeOpt] : ['dark', 'light'];

if (list) {
  for (const s of SHOTS) console.log(`${s.name.padEnd(16)} ${s.about}`);
  process.exit(0);
}
const unknownNames = argv.filter((n) => !SHOTS.some((s) => s.name === n));
if (unknownNames.length) { console.error(`unknown shot(s): ${unknownNames.join(', ')} — see --list`); process.exit(1); }
const selected = argv.length ? SHOTS.filter((s) => argv.includes(s.name)) : SHOTS;
fs.mkdirSync(out, { recursive: true });

// ------------------------------------------------------------------ Playwright
const { chromium } = loadPlaywright();

// ------------------------------------------------------------------ static server for ui/
const server = await startServer();
const base = server.base;
const fixture = loadFixture();

// ------------------------------------------------------------------ image helpers (run in a blank page)
const browser = await chromium.launch();
const tools = await browser.newPage();
const b64 = (buf) => buf.toString('base64');

/** PNG → WebP via Chromium's canvas encoder (no image tools needed). */
async function toWebp(png) {
  const url = await tools.evaluate(async ([data, q]) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', q);
  }, [b64(png), QUALITY]);
  return Buffer.from(url.split(',')[1], 'base64');
}

/** { share, box }: share of pixels (0…1) that differ by more than NOISE.delta in any channel (1 when the
 *  sizes differ) and the bounding box [x, y, w, h] of those pixels, so a report says where something changed. */
async function pixelDiff(a, b) {
  return tools.evaluate(async ([x, y, delta]) => {
    const load = async (d) => { const i = new Image(); i.src = `data:image/webp;base64,${d}`; await i.decode(); return i; };
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.naturalWidth !== ib.naturalWidth || ia.naturalHeight !== ib.naturalHeight) return { share: 1, box: null };
    const W = ia.naturalWidth;
    const px = (img) => { const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const da = px(ia), db = px(ib);
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > delta || Math.abs(da[i + 1] - db[i + 1]) > delta || Math.abs(da[i + 2] - db[i + 2]) > delta) {
        n++;
        const p = i / 4, px_ = p % W, py = (p - px_) / W;
        if (px_ < x0) x0 = px_; if (px_ > x1) x1 = px_; if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
    }
    return { share: n / (da.length / 4), box: n ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
  }, [b64(a), b64(b), NOISE.delta]);
}

const webpSize = async (buf) => tools.evaluate(async (d) => { const i = new Image(); i.src = `data:image/webp;base64,${d}`; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, b64(buf));

/** One overview image of the changed shots: a labelled grid, readable in a single look. */
async function contactSheet(items, file) {
  const png = await tools.evaluate(async (tiles) => {
    const COLS = 3, TILE = 620, GAP = 14, LABEL = 24;
    const W = COLS * TILE + (COLS + 1) * GAP;
    const load = async (d) => { const i = new Image(); i.src = `data:image/webp;base64,${d}`; await i.decode(); return i; };
    const imgs = await Promise.all(tiles.map((t) => load(t.image)));
    const fit = (img) => { const k = Math.min(TILE / img.naturalWidth, 900 / img.naturalHeight, 1); return [img.naturalWidth * k, img.naturalHeight * k]; };
    const rows = [];
    for (let i = 0; i < imgs.length; i += COLS) rows.push(imgs.slice(i, i + COLS).map((img, k) => ({ img, label: tiles[i + k].label, size: fit(img) })));
    const H = rows.reduce((s, r) => s + LABEL + Math.max(...r.map((t) => t.size[1])) + GAP, GAP);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.fillStyle = '#7f7f7f'; g.fillRect(0, 0, W, H);
    g.font = 'bold 16px sans-serif'; g.fillStyle = '#fff';
    let y = GAP;
    for (const r of rows) {
      r.forEach((t, k) => {
        const x = GAP + k * (TILE + GAP);
        g.fillText(t.label, x, y + 17);
        g.drawImage(t.img, x, y + LABEL, t.size[0], t.size[1]);
      });
      y += LABEL + Math.max(...r.map((t) => t.size[1])) + GAP;
    }
    return c.toDataURL('image/png');
  }, items.map((it) => ({ label: it.label, image: b64(it.image) })));
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
}

/** Keep width/height of every <img> showing img/<name>-(dark|light).webp in site/*.html equal to the file. */
function syncHtml(name, [w, h]) {
  const changed = [];
  for (const f of fs.readdirSync(siteDir).filter((x) => x.endsWith('.html'))) {
    const file = path.join(siteDir, f);
    const src = fs.readFileSync(file, 'utf8');
    const re = new RegExp(`<img\\b[^>]*\\bsrc="img/${name}-(?:dark|light)\\.webp"[^>]*>`, 'g');
    const next = src.replace(re, (tag) => tag.replace(/\bwidth="\d+"/, `width="${w}"`).replace(/\bheight="\d+"/, `height="${h}"`));
    if (next !== src) { fs.writeFileSync(file, next); changed.push(f); }
  }
  return changed;
}

// ------------------------------------------------------------------ shot context (the API shots.mjs uses: see helpers() in lib.mjs)
async function capture(shot, theme) {
  // fake clock, paused: time moves only through s.tick() (runFor), never with the real time the
  // machine needs, so every run renders the same pixels
  const { page, context, errors } = await newShotPage(browser, { base, fixture, theme, viewport: shot.viewport, scale: shot.scale || 1, free: shot.free, tweakRider: shot.rider });
  try {
    const target = await shot.run(shotHelpers(page, base, theme));
    await page.mouse.move(0, 0);
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    const png = loc ? await loc.screenshot({ animations: 'disabled' }) : await page.screenshot({ animations: 'disabled' });
    const unknown = await page.evaluate(() => [...new Set(window.__shots.unknown)]);
    return { png, errors, unknown };
  } catch (e) {
    const debug = path.join(os.tmpdir(), `zwo-shot-${shot.name}-${theme}-failed.png`);
    await page.screenshot({ path: debug }).catch(() => {});
    const acts = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-act]')].map((el) => el.dataset.act))].join(' ')).catch(() => '');
    throw Object.assign(e, { debug, acts, errors });
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------ main
const sheet = [];
let failed = 0;
for (const shot of selected) {
  const row = { label: shot.name, images: [] };
  let size = null;
  for (const theme of themes) {
    const file = path.join(out, `${shot.name}-${theme}.webp`);
    const label = `${shot.name}-${theme}`.padEnd(26);
    try {
      const { png, errors, unknown } = await capture(shot, theme);
      const webp = await toWebp(png);
      size = await webpSize(webp);
      const old = fs.existsSync(file) ? fs.readFileSync(file) : (fs.existsSync(path.join(siteDir, 'img', path.basename(file))) ? fs.readFileSync(path.join(siteDir, 'img', path.basename(file))) : null);
      const d = old ? (old.equals(webp) ? { share: 0, box: null } : await pixelDiff(old, webp)) : { share: 1, box: null };
      const diff = d.share;
      const where = d.box && d.share < 1 ? ` in ${d.box[2]}×${d.box[3]} at ${d.box[0]},${d.box[1]}` : '';
      const note = [errors.length && `page errors: ${errors.slice(0, 3).join(' | ')}`, unknown.length && `unmocked: ${unknown.join(' ')}`].filter(Boolean).join('; ');
      if (old && diff <= NOISE.share && !force) {
        console.log(`${label} unchanged${note ? `  (${note})` : ''}`);
        continue;
      }
      fs.writeFileSync(file, webp);
      row.images.push(webp);
      sheet.push({ label: `${shot.name}-${theme}`, image: webp });
      console.log(`${label} ${old ? `updated ${(diff * 100).toFixed(1)} % px${where}` : 'new'}  ${size.join('×')}  ${Math.round(webp.length / 1024)} KB${note ? `  (${note})` : ''}`);
    } catch (e) {
      failed++;
      console.log(`${label} FAILED: ${e.message.split('\n')[0]}`);
      if (e.errors?.length) console.log(`  page errors: ${e.errors.slice(0, 3).join(' | ')}`);
      if (e.acts) console.log(`  data-act on screen: ${e.acts}`);
      if (e.debug) console.log(`  screen at failure: ${e.debug}`);
    }
  }
  if (row.images.length && size && !outOpt) {
    const html = syncHtml(shot.name, size);
    if (html.length) console.log(`  ${shot.name}: width/height updated in ${html.join(', ')}`);
  }
}
if (sheet.length) {
  await contactSheet(sheet, sheetPath);
  console.log(`\ncontact sheet of ${sheet.length} changed shot(s): ${sheetPath}`);
} else if (!failed) console.log('\nno changes');
await browser.close();
server.close();
process.exit(failed ? 1 : 0);

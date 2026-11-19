// In-app updates (updater.rs does the work): when to check, the "update available" card, install with
// progress. Uses only core.js and leaf modules, so it is not part of an import cycle.
import { invoke, listen } from './ble.js';
import { motionOK } from './render.js';
import { t } from './i18n/index.js';
import { html, tHtml, mount } from './html.js';
import { IC } from './components/icons.js';
import { OS, $, ride, restartAnim, toast } from './core.js';

export { updPrefs, setUpdPrefs, updFound, updLater, initUpdates, checkUpdate, showUpdateCard };

// ------------------------------------------------------------------ app updates (signed, from GitHub releases)
// Rust does the work (updater.rs); this only decides when. Never checks, shows or installs during a ride.
const RELEASES = 'https://github.com/steffenr/zwo-trainer/releases';
let updPrefs = { auto: true, available: false }; // available: this build carries an updater key
const setUpdPrefs = (p) => { updPrefs = p; };
let updFound = null;     // { version, current, notes } from the last check
let updLater = null;     // version postponed with "Later" (until the next launch)
let updBusy = false;

/** In-app updates: read the preferences, then check 8 s after start and every 6 h (never while riding). */
async function initUpdates() {
  updPrefs = await invoke('update_status').catch(() => updPrefs);
  if (!updPrefs.available) return;
  await listen('update-progress', updateProgress).catch(() => {});
  setTimeout(autoCheckUpdate, 8000);
  setInterval(autoCheckUpdate, 6 * 3600 * 1000);
}

/** Periodic update check, skipped while riding, when switched off, or while one is in progress. */
function autoCheckUpdate() {
  if (updPrefs.auto !== false && !ride && !updBusy) checkUpdate(true);
}

/** One check. quiet: no toast for "up to date" or errors (automatic checks). */
async function checkUpdate(quiet = false) {
  if (updBusy) return null;
  updBusy = true;
  try {
    updFound = await invoke('update_check');
    if (!updFound) { if (!quiet) toast(t('updUpToDate')); return null; }
    if (ride) { if (!quiet) toast(t('updAfterRide', { v: updFound.version })); }
    else if (!quiet || updLater !== updFound.version) showUpdateCard();
    return updFound;
  } catch (e) {
    if (!quiet) toast(String(e));
    return null;
  } finally { updBusy = false; }
}

/** Show the "update available" card for an update found earlier (not while riding; Later hides it for this version). */
function showUpdateCard() {
  if (!updFound || ride) return;
  const u = updFound;
  let card = $('#update-card');
  if (!card) { card = document.createElement('div'); card.id = 'update-card'; card.className = 'update-card'; card.setAttribute('role', 'status'); document.body.append(card); }
  mount(card, html`<div class="uc-head"><span class="uc-ico">${IC.download}</span><div><b>${tHtml('updAvailable', { v: u.version })}</b><small class="muted">${tHtml('updYouHave', { v: u.current })}</small></div></div>
    <div class="uc-actions"><button class="btn ghost sm" data-u="notes">${tHtml('updWhatsNew')}</button><span class="grow"></span><button class="btn ghost sm" data-u="later">${tHtml('updLater')}</button><button class="btn primary sm" data-u="install">${tHtml('updInstall')}</button></div>`);
  card.hidden = false;
  if (motionOK()) restartAnim(card, 'in');
  card.onclick = (e) => {
    const a = e.target.closest('[data-u]')?.dataset.u;
    if (a === 'notes') invoke('open_link', { url: `${RELEASES}/tag/v${u.version}` }).catch((err) => toast(String(err)));
    if (a === 'later') { updLater = u.version; hideUpdateCard(); }
    if (a === 'install') installUpdate();
  };
}

function hideUpdateCard() {
  const card = $('#update-card');
  if (card) card.hidden = true;
}

/** Download, verify and install the pending update, showing progress in the card; the app restarts afterwards. */
async function installUpdate() {
  const card = $('#update-card');
  if (ride || !card) return;
  const ask = OS === 'linux' && html` ${tHtml('updPassword')}`;
  mount(card, html`<div class="uc-head"><span class="uc-ico">${IC.download}</span><div><b id="uc-status">${tHtml('updDownloading', { v: updFound.version })}</b><small class="muted">${tHtml('updRestarts')}${ask}</small></div></div>
    <div class="pbar uc-bar"><i class="d" id="uc-bar" style="width:0%"></i></div>`);
  card.onclick = null;
  try {
    await invoke('update_install'); // restarts the app (Windows: the installer quits it)
  } catch (e) {
    toast(String(e));
    showUpdateCard();
  }
}

function updateProgress({ done, total }) {
  const st = $('#uc-status'), bar = $('#uc-bar');
  if (!st || !bar) return;
  if (total) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    bar.style.width = `${pct}%`;
    if (pct >= 100) st.textContent = t('updInstalling');
  }
}

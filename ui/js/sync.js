// Profile sync through a cloud-synced folder (sync.rs does the work): the folder settings (syncCfg, changed
// through setSyncCfg), a debounced scheduleSync() after every save, runSync() for one round, and the
// checks on window focus and every 5 minutes. Never syncs during a ride.
//
// Import cycle with app.js (app.js saves and boots through this module; a sync that changed something
// re-applies the app state and reloads the library through app.js). Safe because the listeners below only
// call into app.js when they fire, never while the modules are evaluated.
import { invoke } from './ble.js';
import { t } from './i18n/index.js';
import { relDate, ride, modal, toast } from './core.js';
import { applyAppState, loadLibrary } from './app.js';

export { syncCfg, setSyncCfg, syncOn, agoText, syncLabel, scheduleSync, runSync };

// ------------------------------------------------------------------ profile sync (iCloud Drive / Dropbox / Nextcloud folder)
let syncCfg = {};
const setSyncCfg = (c) => { syncCfg = c; };
let syncTimer = null;
let syncBusy = false;
const syncOn = () => syncCfg.provider && syncCfg.provider !== 'off' && !!syncCfg.dir;
const agoText = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 45 ? t('justNow') : s < 3600 ? t('minAgo', { n: Math.round(s / 60) }) : s < 86400 ? t('hAgo', { n: Math.round(s / 3600) }) : relDate(iso);
};
const SYNC_LABEL = { icloud: 'iCloud Drive', dropbox: 'Dropbox', nextcloud: 'Nextcloud' };
const syncLabel = (p) => SYNC_LABEL[p] || t('syncFolder');

/** Debounced profile sync after a change; never during a ride (sync can re-render). */
function scheduleSync(delay = 4000) {
  if (!syncOn() || syncCfg.auto === false) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(true), delay);
}

/** One sync round; quietly applies changes from other Macs (never during a ride). */
async function runSync(quiet = false) {
  if (!syncOn()) return null;
  if (ride || syncBusy) { scheduleSync(30000); return null; }
  syncBusy = true;
  try {
    const r = await invoke('sync_now');
    syncCfg = { ...syncCfg, lastSync: r.at, lastError: null };
    if (r.changed && !ride && !modal.open) { applyAppState(r.app); await loadLibrary(); }
    else if (r.changed) syncCfg.dirty = true;
    if (!quiet) toast(`${t('syncedWith', { where: syncLabel(syncCfg.provider) })}${r.pulled ? ` · ${t('nUpdated', { n: r.pulled })}` : ''}${r.pending ? ` · ${t('waitingIcloud')}` : ''}`);
    return r;
  } catch (e) {
    syncCfg.lastError = String(e);
    if (!quiet) toast(t('syncFailed', { e }));
    return null;
  } finally { syncBusy = false; }
}

window.addEventListener('focus', () => { if (syncOn() && Date.now() - Date.parse(syncCfg.lastSync || 0) > 60000) scheduleSync(500); });
setInterval(() => scheduleSync(0), 5 * 60 * 1000);

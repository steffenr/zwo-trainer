// Other platforms and ride files: the connection state of Intervals.icu and COROS (svcCache, reloaded by
// refreshServices(), replaced through setSvcCache()), upload modes, uploads to a connected platform and
// COROS's manual import; FIT export, the Garmin import folder and Garmin Connect uploads with the ride's
// name and description. Used by the history view, the ride summary and Settings → Connections.
//
// Import cycle with app.js (api.saveState). Safe because nothing from app.js is used while this module is
// evaluated, only inside functions that run after boot.
import { invoke } from './ble.js';
import { t } from './i18n/index.js';
import { state, planById, workoutInfo, toast } from './core.js';
import { api } from './app.js';
import { showWeekDay } from './views/parts.js';

export {
  svcCache, setSvcCache, SVC_LOGO, refreshServices, svcMode, svcRoute, syncMode, uploadToService, manualImport,
  exportFit, garminImport, uploadToGarmin,
};

// ------------------------------------------------------------------ other platforms (Intervals.icu automatic, COROS manual import)
let svcCache = [];
const setSvcCache = (c) => { svcCache = c; };
const SVC_LOGO = { intervals: 'i', coros: 'C' };
/** Reload the connection state of Intervals.icu / COROS for the Connections tab. */
async function refreshServices() { svcCache = await invoke('services_status').catch(() => []); return svcCache; }
/** Upload mode per platform: 'off' | 'manual' | 'auto' (auto only for connected platforms). */
function svcMode(sv) {
  const m = state.settings.services?.[sv.id]?.mode;
  if (sv.connected) return m || 'auto';
  if (sv.manualUrl) return m === 'auto' ? 'manual' : (m || 'off');
  return 'off';
}
/** Can this platform take a ride right now, and how? → 'api' | 'manual' | null */
const svcRoute = (sv) => (sv.connected ? 'api' : sv.manualUrl ? 'manual' : null);
/** Upload mode selector: “Off / manual / auto”. */
function syncMode(svc) {
  return (state.settings[svc] || {}).mode || 'auto';
}

/** Upload one saved ride (FIT) to a connected service and store the result in history[].services. */
async function uploadToService(h, id) {
  const sv = svcCache.find((x) => x.id === id);
  const { name, description } = rideMeta(h);
  try {
    const r = await invoke('service_upload', { id, path: h.fitPath, name, description });
    (h.services ||= {})[id] = { id: r.id ?? null, url: r.url ?? null, at: new Date().toISOString() };
    await api.saveState();
    return r;
  } catch (e) {
    (h.services ||= {})[id] = { error: String(e) };
    await api.saveState();
    throw new Error(`${sv?.name || id}: ${e}`);
  }
}

/** Manual import for services without automatic upload (COROS Training Hub): prepare the file and open the import page. */
async function manualImport(id, path) {
  const sv = svcCache.find((x) => x.id === id);
  try {
    const p = await invoke('service_manual', { id, path });
    toast(t('dragInto', { file: p.split(/[\\/]/).pop(), name: `${sv?.name || id}${sv?.manualZip ? ' (Import Data)' : ''}` }));
  } catch (e) { toast(String(e)); }
}

// ------------------------------------------------------------------ activities & sync
async function exportFit(path) {
  try { const p = await invoke('export_activity', { path }); if (p) toast(t('savedFile', { file: p.split(/[\\/]/).pop() })); }
  catch (e) { toast(t('exportFailed', { e })); }
}

async function garminImport(path) {
  try { const p = await invoke('garmin_import', { path }); toast(t('savedDragGarmin', { file: p.split(/[\\/]/).pop() })); }
  catch (e) { toast(`Garmin: ${e}`); }
}

/** Activity title + description for uploads: the workout's name as shown in zwoTrainer, and
 *  plan · week/day as context. */
function rideMeta(h) {
  const plan = h.plan ? planById(h.plan) : null;
  const info = workoutInfo(h.file);
  const wd = plan && info?.week && showWeekDay(info) ? `W${info.week} D${info.day}` : null;
  return {
    name: h.title || info?.title || t('zwoWorkout'),
    description: [[plan?.name, wd].filter(Boolean).join(' · ') || null, t('riddenWith')].filter(Boolean).join(' — '),
  };
}

/** Ride start (unix seconds) — lets Garmin uploads find the activity while it's processing. */
const rideStart = (h) => Math.round((h.startedAt ? Date.parse(h.startedAt) : Date.parse(h.at) - (h.doneDuration || 0) * 1000) / 1000);

/** Upload a history entry to Garmin Connect; updates the entry in place and saves. */
async function uploadToGarmin(h) {
  try {
    const r = await invoke('garmin_upload', { path: h.fitPath, ...rideMeta(h), start: rideStart(h) });
    h.garmin = { activityId: r.activityId, url: r.url, at: new Date().toISOString() };
    await api.saveState();
    return r;
  } catch (e) {
    h.garmin = { error: String(e) };
    await api.saveState();
    throw e;
  }
}

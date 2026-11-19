// zwoTrainer UI controller. Sections, top to bottom:
//   state & helpers · library and plan progress · profile sync · in-app updates · theme, riders, top bar
//   · devices menu · routing and views (renderHome / renderPlan / renderWorkouts / renderTests /
//   renderHistory) · actions (bindActions, ⋯ menus) · dialogs (openModal, preview, settings, devices,
//   connections) · the Ride class (ride screen and loop) · ride summary.
// Markup: html`` from ./html.js (auto-escaping) and the helpers in ./components/ for shared pieces;
// markup reaches the DOM only through mount() (scripts/check-html.mjs). Rust is reached only through
// invoke() / listen() (ble.js).
import { CompactView, compactMode } from './compact.js';
import { powerAt, segmentAt, estimateTss } from './zwo.js';
import { ZONES, FREE_COLOR, zoneOf, zoneColor, zoneInk, fmtTime, fmtDur, miniProfile, Diagram, Gauge, ProgressRing, motionOK } from './render.js';
import { Trainer, HeartRate, Controllers, bindNative, invoke, listen } from './ble.js';
import { batteryBadge, lowestLevel } from './battery.js';
import { renderMarkdown, markdownSummary, markdownPlain, smartTrim } from './markdown.js';
import { DEFAULT_SHIFTING, gearTable, virtualSpeed, targetWatts } from './vshift.js';
import { PROTOCOLS, protocolById, isTestWorkout, evaluateGeneric, classifyTest, prepareTestWorkout, vo2max } from './tests.js';
import { t, LOCALES, setLocale, systemLocale, coerceLocale, fmtLocale, translateDom } from './i18n/index.js';
import { loadSounds, countdown, endChime } from './sound.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import { IC } from './components/icons.js';
import { badge, wdTag, zoneTag } from './components/indicators.js';
import { dialogHead, closeBtn } from './components/dialog.js';
import { segCtl, segRow, selectSeg, menuBtn } from './components/buttons.js';

// Platform wording: zwoTrainer runs on macOS, Windows and Linux; only labels differ.
const OS = (() => {
  const p = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  return p.includes('mac') ? 'mac' : p.includes('win') ? 'win' : 'linux';
})();
document.documentElement.dataset.os = OS;
// Each wording is looked up in the dictionary when it's used, so it follows the UI language.
const PLAT = Object.defineProperties({ emojiKey: { mac: ' (⌃⌘Space)', win: ' (Win + .)', linux: '' }[OS] },
  Object.fromEntries(['files', 'trash', 'machine', 'onThisMachine', 'bt'].map((k) => [k, { get: () => t(`${OS}.${k}`) }])));

// ------------------------------------------------------------------ state
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
/**
 * Write text only when it changed. The ride screen updates ~40 readouts 4× a second; most values are the
 * same as last tick, and skipping the write avoids needless style/layout work. null/undefined → ''.
 */
const setText = (el, v) => {
  if (!el) return;
  const s = String(v ?? '');
  if (el.textContent !== s) el.textContent = s;
};
/**
 * Same for an html`` fragment, written through mount(). Compares with the fragment written last by
 * setHtml (kept on the element), so use it as the only writer of that element.
 */
const setHtml = (el, frag) => {
  if (!el || el._html === frag.s) return;
  mount(el, frag);
  el._html = frag.s;
};
const params = new URLSearchParams(location.search);
const SPEED = Math.max(1, Number(params.get('speed')) || 1); // dev: fast-forward time

let library = { plans: [], singles: [], root: '' };
let profiles = [];        // [{ id, name }]
let state = null;         // the active profile: { id, name, settings, activePlan, plans, history }
let lastRidden = new Map(); // file -> { at, count }
const live = { power: null, cadence: null, speed: null, hr: null, at: {} };

const trainer = new Trainer();
const hrm = new HeartRate();
const ctrls = new Controllers();
const shifting = () => ({ ...DEFAULT_SHIFTING, ...(state.settings.shifting || {}) });

const api = {
  appState: () => invoke('app_state'),
  library: () => invoke('scan_library'),
  workout: (file) => invoke('load_workout', { file }),
  saveState: () => { indexHistory(); return invoke('save_profile', { profile: state }).then((r) => { scheduleSync(); return r; }).catch((e) => toast(t('couldNotSave', { e }))); },
};

const bounds = () => state.settings.zones;
const ftp = () => Number(state.settings.ftp) || 250;
const maxHr = () => Number(state.settings.maxHr) || 185;
const weight = () => Number(state.settings.weight) || null;
const wkg = (w) => (weight() && w ? (w / weight()).toFixed(2) : null);
const mode = () => (['workouts', 'tests'].includes(state.settings.mode) ? state.settings.mode : 'plans');
const planById = (id) => library.plans.find((p) => p.id === id);
const allWorkouts = () => [...library.singles, ...library.plans.flatMap((p) => p.workouts)];
/** Folder shown under Plans? Rider override first, then folders already ridden as a plan, then
 *  the library's guess (≥ 2 weeks = plan, otherwise a collection that lives in Workouts only). */
function isPlan(p) {
  if (!p) return false;
  const o = state.settings.folderKinds?.[p.id];
  if (o) return o === 'plan';
  if (state.activePlan === p.id || Object.keys(state.plans?.[p.id]?.entries || {}).length) return true;
  return p.kind !== 'collection';
}
const planWeeks = (p) => (p.kind === 'plan' && p.weeks ? p.weeks : null);
const planMeta = (p) => [t('nWorkouts', { n: p.count }), planWeeks(p) ? t('nWeeks', { n: planWeeks(p) }) : null, fmtDur(p.duration)].filter(Boolean).join(' · ');
/** Workouts of a collection carry fake Week01_DayNN numbers — don't show them. */
const showWeekDay = (w) => planById(folderOf(w.file))?.kind === 'plan';

/** Description block: a smart-trimmed ~300-character preview that expands to the full Markdown. */
const DESC_PREVIEW = 300;
function descriptionBlock(md) {
  if (!md) return html``;
  const { text, cut } = smartTrim(markdownPlain(md), DESC_PREVIEW);
  // renderMarkdown() escapes everything itself and only emits its own tags, so its output is trusted
  const full = raw(renderMarkdown(md));
  if (!cut) return html`<section class="plan-desc card"><div class="md">${full}</div></section>`;
  return html`<section class="plan-desc card is-collapsed">
    <div class="md md-preview"><p>${text} <a href="#" class="md-toggle" data-act="desc-toggle">${tHtml('showMore')}</a></p></div>
    <div class="md md-full">${full}<p><a href="#" class="md-toggle" data-act="desc-toggle">${tHtml('showLess')}</a></p></div>
  </section>`;
}
let workoutIndex = new Map();
let lastView = null;         // micro animations: last rendered view (fade in on change)
const pbarMemo = new Map();  // plan id -> last progress-bar widths (glide on change)
let justDone = null;         // file just marked done (its check draws itself once)
const workoutInfo = (file) => workoutIndex.get(file);
const folderOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/** Rebuild the lookup maps over the scanned library (workout by file, plan by id) after a scan. */
function indexLibrary() {
  workoutIndex = new Map(allWorkouts().map((w) => [w.file, w]));
}

/** Rebuild "last ridden" per workout file from the rider's history (for the ✓ marks and the "ridden 3 d ago" line). */
function indexHistory() {
  lastRidden = new Map();
  for (const h of state?.history || []) {
    const cur = lastRidden.get(h.file);
    if (!cur) lastRidden.set(h.file, { at: h.at, count: 1 });
    else { cur.count++; if (h.at > cur.at) cur.at = h.at; }
  }
}

function relDate(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  if (days < 7) return t('daysAgo', { n: days });
  return d.toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function lastRiddenText(file) {
  const r = lastRidden.get(file);
  return r ? `${t('lastRidden', { when: relDate(r.at) })}${r.count > 1 ? ` · ${r.count}×` : ''}` : '';
}

const favs = () => (state.favorites ||= []);
const isFav = (file) => favs().includes(file);
async function toggleFav(file) {
  const f = favs();
  const i = f.indexOf(file);
  if (i >= 0) f.splice(i, 1); else f.push(file);
  await api.saveState();
  toast(i >= 0 ? t('favRemoved') : t('favAdded'));
}
/** Favourite toggle (☆ / ★) for a workout file. */
const starBtn = (file) => html`<button class="star ${isFav(file) ? 'on' : ''}" data-act="fav" data-file="${file}" title="${tText(isFav(file) ? 'favRemove' : 'favAdd')}" aria-label="${tText('favorite')}">${isFav(file) ? '★' : '☆'}</button>`;

/** Progress of a plan for the active rider: done / skipped counts, the next workout, started / finished flags. */
function planProgress(plan) {
  const ps = state.plans[plan.id];
  const entries = ps?.entries || {};
  let done = 0, skipped = 0;
  for (const w of plan.workouts) {
    const e = entries[w.file];
    if (e?.status === 'done') done++;
    else if (e?.status === 'skipped') skipped++;
  }
  const next = plan.workouts.find((w) => !entries[w.file]) || null;
  return { started: !!ps, done, skipped, total: plan.workouts.length, next, finished: !!ps && !next, entries };
}

// ------------------------------------------------------------------ boot
/**
 * The styles need cascade layers and CSS nesting (Safari 17+, current WebView2 / WebKitGTK). base.css
 * sets --css-ok only when both work; without it the app would look broken, so say why instead. The
 * notice is styled inline because the stylesheet may not apply at all.
 */
function checkEngine() {
  const run = () => {
    if (getComputedStyle(document.documentElement).getPropertyValue('--css-ok').trim() === '1') return;
    const note = document.createElement('div');
    note.setAttribute('role', 'alert');
    note.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:9999;padding:14px 18px;background:#fff4d6;color:#000;font:15px/1.4 system-ui,sans-serif;border-bottom:1px solid #d9b45a';
    note.textContent = t('engineOutdated');
    document.body.prepend(note);
  };
  if (document.readyState === 'complete') run(); else window.addEventListener('load', run, { once: true });
}

async function boot() {
  translateDom();
  checkEngine();
  if (!window.__TAURI__) throw new Error(t('needsDesktop'));
  const a = await api.appState();
  applyAppState(a);
  bindChrome();
  if (syncOn()) await Promise.race([runSync(true), new Promise((r) => setTimeout(r, 4000))]);
  await bindNative(trainer, hrm, onSensor, ctrls, onButton, setBattery);
  window.addEventListener('hashchange', route);
  if (profiles.length > 1 && !params.get('profile')) await whoIsRiding();
  await loadLibrary();
  refreshServices();
  autoConnect();
  initUpdates();
  if (params.get('sim') === '1') { trainer.startSim(); hrm.startSim(); }
}

/** Take a fresh app_state summary from Rust (after create / edit / switch / delete rider or a sync) and make it the UI state. */
function applyAppState(a) {
  if (a.sync !== undefined) syncCfg = a.sync || {};
  profiles = a.profiles;
  state = a.profile;
  indexHistory();
  applyTheme();
  applyLanguage();
  renderProfileChip();
  renderModeSwitch();
}

/** Scan the workouts folder (scan_library in Rust; cached by mtime) and re-index it. */
async function loadLibrary() {
  library = await api.library();
  indexLibrary();
  route();
}

// ------------------------------------------------------------------ profile sync (iCloud Drive / Dropbox / Nextcloud folder)
let syncCfg = {};
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

// ------------------------------------------------------------------ app updates (signed, from GitHub releases)
// Rust does the work (updater.rs); this only decides when. Never checks, shows or installs during a ride.
const RELEASES = 'https://github.com/steffenr/zwo-trainer/releases';
let updPrefs = { auto: true, available: false }; // available: this build carries an updater key
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

// ------------------------------------------------------------------ theme & language
const THEME_LABEL = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' };

/** The rider's UI language (settings.language), else the system language. Re-renders static text. */
function applyLanguage() {
  setLocale(coerceLocale(state?.settings?.language) || systemLocale());
  translateDom();
  devicesTitle();
}

function applyTheme() {
  const th = state?.settings?.theme || 'system';
  if (th === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = th;
}

async function setTheme(th) {
  state.settings.theme = th;
  applyTheme();
  await api.saveState();
}

// ------------------------------------------------------------------ chrome: profile, mode, devices
const initials = (n) => (n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const AVATAR_COLORS = ['#338cff', '#59bf59', '#ff6639', '#b47cff', '#00a3c4', '#e0a800', '#ff4d8d', '#7f7f7f'];
const avatarColor = (id) => AVATAR_COLORS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
const AVATAR_EMOJI = ['🚴', '🚵', '🏃', '🏊', '⚡', '🔥', '🚀', '🦊', '🐻', '🐼', '🦁', '🐯', '🐺', '🦅', '🐢', '🐝', '🌵', '🌊', '⛰️', '🌞', '⭐', '💪', '🎧', '🏁'];
/** Only a #rrggbb colour may reach markup or CSS (same rule as clean_avatar in state.rs). */
const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
const avatarBg = (p) => safeColor(p.avatar?.color) || avatarColor(p.id);
/** Rider avatar: emoji on a tint, or the initials on the rider's colour (only a #rrggbb colour reaches CSS). */
const avatar = (p, cls = '') => {
  const e = p.avatar?.emoji;
  return html`<span class="avatar ${cls} ${e ? 'emoji' : ''}" style="--av:${avatarBg(p)}">${e || initials(p.name)}</span>`;
};
/** DOM version of avatar() for live previews: user input is only ever set as text, never parsed as HTML. */
const avatarNode = (p, cls = '') => {
  const e = p.avatar?.emoji;
  const s = document.createElement('span');
  s.className = `avatar ${cls} ${e ? 'emoji' : ''}`.trim();
  s.style.setProperty('--av', avatarBg(p));
  s.textContent = e || initials(p.name);
  return s;
};

function renderProfileChip() {
  const b = $('#btn-profile');
  mount(b, avatar(state));
  b.title = t('ridersTitle', { name: state.name });
  b.setAttribute('aria-label', t('riderAria', { name: state.name }));
}

function renderModeSwitch() {
  const m = mode();
  $$('#mode-switch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}

async function setMode(m) {
  if (mode() === m) { if (location.hash.length > 2) location.hash = '#/'; return; }
  state.settings.mode = m;
  renderModeSwitch();
  await api.saveState();
  if (location.hash.length > 2) location.hash = '#/'; else route();
}

function syncTopbarHeight() {
  document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').getBoundingClientRect().height}px`);
}

/** Wire the static shell once: top bar buttons, mode switch, device and button events from Rust. */
function bindChrome() {
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  $('#btn-devices').onclick = (e) => devicesMenu(e.currentTarget);
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-compact').onclick = () => ride?.compact.set(true);
  $('#btn-profile').onclick = profileMenu;
  $('#mode-switch').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };
  let ergDenied = false; // warn once when the trainer refuses ERG control (auto-connect, reconnect, mid-ride); ERG stays on
  trainer.on('status', (s) => {
    setDev('trainer', s);
    ride?.onDeviceStatus();
    if (s.ergDenied && !ergDenied) toast(t('ergDenied'));
    ergDenied = !!s.ergDenied;
  });
  trainer.on('data', onSensor);
  hrm.on('status', (s) => setDev('hr', s));
  hrm.on('data', onSensor);
  ctrls.on('status', (s) => { setDev('controller', s); ride?.render(true); });
  document.addEventListener('keydown', (e) => ride?.onKey(e));
}

// kinds with a connection attempt from connectSaved() still running (hides "Retry auto-connect" meanwhile)
const connectingKinds = new Set();

/** Saved devices of the active profile that aren't connected, as [kind, ids]; with several controllers only the missing ones. */
function offlineSaved() {
  const devs = state.settings.devices || {};
  const out = [];
  for (const [kind, dev] of [['trainer', trainer], ['hr', hrm]]) {
    if (devs[kind]?.id && !dev.connected && dev.mode !== 'sim') out.push([kind, [devs[kind].id]]);
  }
  const missing = (devs.controllers || []).filter((c) => !ctrls.ids.includes(c.id)).map((c) => c.id);
  if (missing.length) out.push(['controller', missing]);
  return out;
}

/** What "Retry auto-connect" would try: offline saved devices without an attempt running (ours, or Rust's own reconnect). */
function retryable() {
  return offlineSaved().filter(([kind]) => !connectingKinds.has(kind) && !sensorDevice(kind)?.reconnecting);
}

const sensorDevice = (kind) => (kind === 'trainer' ? trainer : kind === 'hr' ? hrm : null);

/** Connect saved devices silently (they may be switched off); a failure only resets the status. */
function connectSaved(list) {
  const devs = state.settings.devices || {};
  for (const [kind, ids] of list) {
    connectingKinds.add(kind);
    let job;
    if (kind === 'controller') {
      if (!ctrls.connected) setDev('controller', { reconnecting: true, name: (devs.controllers || []).map((c) => c.name).join(' + ') });
      job = Promise.allSettled(ids.map((id) => ctrls.connect(id))).then((r) => { if (!ctrls.connected && !r.some((x) => x.status === 'fulfilled')) setDev('controller', { connected: false }); });
    } else {
      setDev(kind, { reconnecting: true, name: devs[kind]?.name });
      job = sensorDevice(kind).connect(ids[0]).catch(() => setDev(kind, { connected: false }));
    }
    job.finally(() => { connectingKinds.delete(kind); refreshDevicesMenu(); });
  }
  refreshDevicesMenu();
}

/** Reconnect the devices saved in the active profile (at launch and after switching riders). */
function autoConnect() { connectSaved(offlineSaved()); }

/** Controller button → [workout action, dictionary key of its description] (Zwift Ride / Play / Click, OpenBikeControl). */
export const BUTTON_ACTIONS = {
  shiftUp: ['gear+', 'btnShiftUp'],
  shiftDown: ['gear-', 'btnShiftDown'],
  up: ['int+', 'btnIntUp'],
  down: ['int-', 'btnIntDown'],
  right: ['next', 'btnNext'],
  left: ['prev', 'btnPrev'],
  a: ['play', 'btnPlay'],
  powerup: ['play', 'btnPlay'],
  z: ['pct', 'btnPct'],
  y: ['play', 'btnPlay'],
  b: [null, 'btnNone'],
  onoff: [null, 'btnOnOff'],
};
const BUTTON_LABEL = { shiftUp: 'Shift +', shiftDown: 'Shift −', up: '▲', down: '▼', left: '◀', right: '▶', a: 'A', b: 'B', y: 'Y', z: 'Z', powerup: 'Power-up', onoff: 'On/Off' };
let buttonTester = null;

/** `erg`: OpenBikeControl's pick for ERG segments when one press sent several ids (difficulty before shift). */
function onButton(button, device, erg) {
  if (erg && ride && !ride.freeLike) button = erg;
  buttonTester?.(button, device);
  const action = BUTTON_ACTIONS[button]?.[0];
  if (ride && action) ride.button(action);
}

function onSensor(d) {
  const now = Date.now();
  for (const k of ['power', 'cadence', 'speed', 'hr']) if (d[k] !== undefined) { live[k] = d[k]; live.at[k] = now; }
}
// treat values older than 4 s as missing
const fresh = (k) => (Date.now() - (live.at[k] || 0) < 4000 ? live[k] : null);

// ------------------------------------------------------------------ devices menu (one top-bar button)
const DEVICE_KINDS = [
  ['trainer', 'devTrainer', '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>'],
  ['hr', 'devHr', '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>'],
  ['controller', 'devShifter', '<svg viewBox="0 0 24 24"><path d="M8 3v18M8 3 4 7M8 3l4 4M16 21V3M16 21l-4-4M16 21l4-4"/></svg>'],
];
const devState = { trainer: {}, hr: {}, controller: {} };
// battery levels per kind and device id (controllers can be several); only shown in the devices popover
const battery = { trainer: {}, hr: {}, controller: {} };

function setBattery(e) {
  if (!battery[e.kind]) return;
  battery[e.kind][e.id] = e.level;
  refreshDevicesMenu();
}

function refreshDevicesMenu() {
  const pop = $('#popover.dev-pop');
  if (pop) renderDevicesMenu(pop);
}

function setDev(kind, s) {
  const was = devState[kind] || {};
  devState[kind] = { connected: !!s.connected, reconnecting: !!s.reconnecting, name: s.name || '' };
  // a device that is gone has no battery; with several controllers keep only the ones still connected
  if (!s.connected) battery[kind] = {};
  else if (kind === 'controller' && s.ids) battery[kind] = Object.fromEntries(Object.entries(battery[kind]).filter(([id]) => s.ids.includes(id)));
  const dot = $(`#btn-devices .dev-dots i[data-k="${kind}"]`);
  dot.className = s.connected ? 'on' : s.reconnecting ? 'warn' : '';
  if (motionOK() && s.connected && !was.connected) restartAnim(dot, 'pop');
  if (motionOK() && was.connected && !s.connected) restartAnim(dot, 'drop');
  devicesTitle();
  refreshDevicesMenu();
}

function devicesTitle() {
  const on = Object.values(devState).filter((d) => d.connected).length;
  $('#btn-devices').title = on ? t('devicesOn', { n: on }) : t('devicesNone');
}

/** Content of the devices popover: one row per device kind (state, battery, Change / Connect), then "Retry auto-connect" when saved devices are missing. */
function renderDevicesMenu(pop) {
  const saved = state.settings.devices || {};
  const row = ([k, label, icon]) => {
    const d = devState[k];
    const level = d.connected ? lowestLevel(battery[k]) : null;
    const batt = raw(batteryBadge(level, t('batteryPct', { n: level })));
    const savedName = k === 'controller' ? (saved.controllers || []).map((c) => c.name).join(' + ') : saved[k]?.name;
    const status = d.connected ? html`<span class="ok-text">${d.name || tHtml('connected')}</span>`
      : d.reconnecting ? html`<span class="warn-text">${d.name ? tHtml('connectingName', { name: d.name }) : tHtml('connectingDots')}</span>`
        : html`<span class="muted">${savedName ? tHtml('savedOff', { name: savedName }) : tHtml('notPaired')}</span>`;
    return html`<button class="dev-row" data-dev="${k}"><span class="dev-ico ${d.connected ? 'on' : d.reconnecting ? 'warn' : ''}">${raw(icon)}</span><span class="dev-txt"><span class="dev-head"><b>${tHtml(label)}</b>${batt}</span>${status}</span><span class="dev-act">${tHtml(d.connected ? 'change' : 'connect')}</span></button>`;
  };
  const retry = retryable().length > 0 && html`<hr><button class="dev-retry" data-retry title="${tText('retryConnectTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>${tHtml('retryConnect')}</button>`;
  mount(pop, html`<div class="pop-title">${tHtml('devices')}</div>${DEVICE_KINDS.map(row)}${retry}`);
}

function devicesMenu(anchor) {
  if ($('#popover.dev-pop')) return $('#popover').remove();
  $('#popover')?.remove();
  const pop = document.createElement('div');
  pop.id = 'popover';
  pop.className = 'popover dev-pop';
  renderDevicesMenu(pop);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  const close = () => { pop.remove(); document.removeEventListener('click', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', outside, true));
  pop.onclick = (e) => {
    // retry keeps the popover open, so the rows show "Connecting…" and then the result
    if (e.target.closest('[data-retry]')) return connectSaved(retryable());
    const b = e.target.closest('[data-dev]');
    if (b) { close(); deviceDialog(b.dataset.dev); }
  };
}

// ------------------------------------------------------------------ profiles
function whoIsRiding() {
  return new Promise((resolve) => {
    openModal(html`
      <div class="who">
        <h2>${tHtml('whoRiding')}</h2>
        <div class="who-grid">${profiles.map((p) => html`<button class="who-card" data-id="${p.id}">${raw(avatar(p, 'xl'))}<span>${p.name}</span></button>`)}</div>
      </div>`, 'small sticky');
    $('.who-grid', modal).onclick = async (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      closeModal();
      if (b.dataset.id !== state.id) applyAppState(await invoke('switch_profile', { id: b.dataset.id }));
      resolve();
    };
  });
}

/** Name, colour and emoji of a rider (the avatar replaces the initials when an emoji is set). */
function profileEditor(p) {
  const cur = { color: p.avatar?.color || null, emoji: p.avatar?.emoji || null };
  const previewProfile = () => ({ ...p, avatar: { color: cur.color, emoji: cur.emoji }, name: $('[name=pname]', modal)?.value || p.name });
  const preview = () => avatar(previewProfile(), 'xl');
  const own = cur.emoji && !AVATAR_EMOJI.includes(cur.emoji) ? cur.emoji : '';
  openModal(html`
    ${dialogHead(tHtml('editRider'))}
    <div class="pe">
      <div class="pe-preview" id="pe-preview">${raw(preview())}</div>
      <div class="pe-fields">
        <label class="pe-name">${tHtml('name')}<input type="text" name="pname" value="${p.name}" maxlength="40" autocomplete="off"></label>
        <div class="pe-label">${tHtml('colour')}</div>
        <div class="swatches" id="pe-colors">${AVATAR_COLORS.map((c) => html`<button type="button" data-color="${c}" style="--sw:${c}" class="${avatarBg({ ...p, avatar: cur }) === c ? 'on' : ''}" aria-label="${c}"></button>`)}<label class="sw-custom" title="${tText('customColour')}"><input type="color" id="pe-custom" value="${avatarBg(p)}">＋</label></div>
        <div class="pe-label">${tHtml('emoji')} <small class="muted">${tHtml('emojiHint')}</small></div>
        <div class="emoji-grid" id="pe-emoji"><button type="button" data-e="" class="${cur.emoji ? '' : 'on'}" title="${tText('initials')}">${initials(p.name)}</button>${AVATAR_EMOJI.map((e) => html`<button type="button" data-e="${e}" class="${cur.emoji === e ? 'on' : ''}">${e}</button>`)}</div>
        <input type="text" id="pe-emoji-own" class="pe-own" placeholder="${tText('emojiOwn')}${PLAT.emojiKey}" maxlength="8" value="${own}">
      </div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-act="back">${tHtml('back')}</button><button class="btn primary" data-act="save">${tHtml('save')}</button></div>`, 'small');
  const refresh = () => {
    $('#pe-preview', modal).replaceChildren(avatarNode(previewProfile(), 'xl'));
    $$('#pe-colors [data-color]', modal).forEach((x) => x.classList.toggle('on', x.dataset.color === cur.color));
    $$('#pe-emoji [data-e]', modal).forEach((x) => x.classList.toggle('on', (x.dataset.e || null) === cur.emoji));
  };
  $('#pe-colors', modal).onclick = (e) => { const b = e.target.closest('[data-color]'); if (b) { cur.color = b.dataset.color; refresh(); } };
  $('#pe-custom', modal).oninput = (e) => { cur.color = safeColor(e.target.value); refresh(); };
  $('#pe-emoji', modal).onclick = (e) => { const b = e.target.closest('[data-e]'); if (b) { cur.emoji = b.dataset.e || null; $('#pe-emoji-own', modal).value = ''; refresh(); } };
  $('#pe-emoji-own', modal).oninput = (e) => { cur.emoji = e.target.value.trim() || null; refresh(); };
  $('[name=pname]', modal).oninput = refresh;
  bindActions(modal, {
    close: closeModal,
    back: profileMenu,
    save: async () => {
      try {
        applyAppState(await invoke('edit_profile', { id: p.id, name: $('[name=pname]', modal).value, avatar: cur }));
        scheduleSync();
        profileMenu();
      } catch (err) { toast(String(err)); }
    },
  });
}

function profileMenu() {
  if (ride) return toast(t('finishToSwitch'));
  openModal(html`
    ${dialogHead(tHtml('riders'))}
    <div class="profile-list">
      ${profiles.map((p) => html`
        <div class="profile-row ${p.id === state.id ? 'on' : ''}" data-id="${p.id}">
          <button class="profile-pick" data-act="switch">${raw(avatar(p))}<span>${p.name}</span>${p.id === state.id && html`<small class="muted">· ${tHtml('riding')}</small>`}</button>
          <button class="btn ghost sm" data-act="edit">${tHtml('edit')}</button>
          ${profiles.length > 1 && html`<button class="btn ghost sm" data-act="delete">${tHtml('delete')}</button>`}
        </div>`)}
    </div>
    <form class="add-profile" id="add-profile"><input type="text" name="name" placeholder="${tText('newRiderName')}" maxlength="40" autocomplete="off"><button class="btn primary" type="submit">${tHtml('addRider')}</button></form>
    <p class="muted small">${tHtml('ridersHint')}</p>`, 'small');
  $('#add-profile', modal).onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try { closeModal(); await afterProfileChange(await invoke('create_profile', { name })); toast(t('welcomeRider', { name })); openSettings('rider'); }
    catch (err) { toast(String(err)); }
  };
  const rowOf = (el) => { const id = el.closest('[data-id]').dataset.id; return { id, p: profiles.find((x) => x.id === id) }; };
  bindActions(modal, {
    close: closeModal,
    switch: async (el) => { const { id } = rowOf(el); closeModal(); if (id !== state.id) await afterProfileChange(await invoke('switch_profile', { id })); },
    edit: (el) => profileEditor(rowOf(el).p),
    delete: async (el) => {
      const { id, p } = rowOf(el);
      if (await confirmDialog(t('deleteRiderQ', { name: p.name }), t('deleteRiderText'), t('delete'), true)) await afterProfileChange(await invoke('delete_profile', { id }));
      else profileMenu();
    },
  });
}

/** After switching/creating/deleting: reload everything that depends on the rider. */
async function afterProfileChange(a) {
  refreshServices();
  applyAppState(a);
  location.hash = '#/';
  // a rider with their own saved device takes it over; otherwise keep what's connected
  for (const [kind, dev] of [['trainer', trainer], ['hr', hrm]]) {
    const want = state.settings.devices?.[kind]?.id;
    if (dev.mode === 'ble' && want && dev.id && dev.id !== want) await dev.disconnect();
  }
  await loadLibrary();
  autoConnect();
}

// ------------------------------------------------------------------ routing / views
function route() {
  routeView();
  afterRoute();
}

/** Micro animations after a render: the view fades in when it changed, progress bars glide to new values. */
function afterRoute() {
  if (!state || document.body.classList.contains('riding')) return;
  const key = `${mode()}|${location.hash.replace(/^#\/?/, '')}`;
  if (lastView !== null && key !== lastView && motionOK()) restartAnim($('#view'), 'view-in');
  lastView = key;
  const seen = {};
  for (const bar of $$('#view .pbar[data-pid]')) {
    const id = `${bar.dataset.pid}#${(seen[bar.dataset.pid] = (seen[bar.dataset.pid] || 0) + 1)}`;
    const to = [bar.dataset.d, bar.dataset.s], from = pbarMemo.get(id);
    pbarMemo.set(id, to);
    if (!from || (from[0] === to[0] && from[1] === to[1]) || !motionOK()) continue;
    const d = $('.d', bar), s = $('.s', bar);
    d.style.width = `${from[0]}%`; s.style.width = `${from[1]}%`;
    void bar.offsetWidth;
    bar.classList.add('glide');
    d.style.width = `${to[0]}%`; s.style.width = `${to[1]}%`;
  }
  justDone = null;
}

/** Render #view for the current hash and mode (plans, workouts, tests, history, plan page). Never called during a ride. */
function routeView() {
  if (!state) return;
  const h = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  $('#view').classList.toggle('wide', mode() === 'workouts' && !view);
  if (view === 'history') return renderHistory();
  if (view === 'plan') return renderPlan(decodeURIComponent(rest.join('/')));
  if (mode() === 'tests') return renderTests();
  if (library.exists === false || !allWorkouts().length) return renderEmpty();
  if (mode() === 'workouts') return renderWorkouts();
  renderHome();
}

/** First-run view: no workouts folder chosen yet. */
function renderEmpty() {
  const missing = library.exists === false;
  const dir = html`<code>${library.root}</code>`;
  mount($('#view'), html`<section class="hero card empty"><h1>${tHtml(missing ? 'emptyChoose' : 'emptyNone')}</h1>
    <p>${tHtml(missing ? 'emptyMissing' : 'emptyNoFiles', { dir })} ${tHtml('emptyHint')}</p>
    <div class="upnext-actions" style="margin-top:16px"><button class="btn primary" data-act="pick-dir">${tHtml('chooseFolder')}</button></div></section>`);
  bindActions($('#view'));
}

/** Plan progress bar (done / skipped); remembers the last widths per plan so the bar can glide to new values. */
function progressBar(pp, id) {
  const d = (pp.done / pp.total) * 100, s = (pp.skipped / pp.total) * 100;
  return html`<div class="pbar"${id && html` data-pid="${id}" data-d="${d}" data-s="${s}"`} title="${tText('progressTitle', { done: pp.done, skipped: pp.skipped, total: pp.total })}"><i class="d" style="width:${d}%"></i><i class="s" style="width:${s}%"></i></div>`;
}

/** "W3 D2" tag for a plan workout (nothing outside plans). */
function weekDay(w) {
  return w.week ? wdTag(tHtml('weekDayShort', { w: w.week, d: w.day })) : '';
}

/** Link that switches to Workouts mode, used inside hint texts. */
const workoutsLink = () => html`<a href="#/" data-act="mode-workouts" class="link">${tHtml('modeWorkouts')}</a>`;

/** Home hero for the active plan: progress, then the next workout with Start / Details / Skip (or "plan finished"). */
function activePlanHero(active) {
  const pp = planProgress(active);
  const n = pp.next;
  const upNext = n ? html`
        <div class="upnext">
          <div class="upnext-info">
            <div class="eyebrow">${tHtml('upNext')} ${weekDay(n)}</div>
            <h2>${n.title}</h2>
            <div class="meta">${fmtDur(n.duration)} · TSS ~${n.tss}${lastRidden.has(n.file) && html` · ${raw(lastRiddenText(n.file))}`}</div>
          </div>
          <div class="upnext-profile">${raw(miniProfile(n.profile, bounds(), { width: 420, height: 64 }))}</div>
          <div class="upnext-actions">
            <button class="btn primary big" data-act="start-next">${tHtml('startWorkout')}</button>
            <button class="btn ghost" data-act="preview" data-file="${n.file}">${tHtml('details')}</button>
            <button class="btn ghost" data-act="skip-next">${tHtml('skip')}</button>
          </div>
        </div>` : html`<div class="upnext-done"><p class="done-msg">${tHtml('planFinished')}</p><button class="btn primary" data-act="close-plan">${tHtml('pickNewPlan')}</button></div>`;
  return html`
      <section class="hero card">
        <div class="hero-head">
          <div>
            <div class="eyebrow">${tHtml('activePlan')}</div>
            <h1><a href="#/plan/${encodeURIComponent(active.id)}">${active.name}</a></h1>
          </div>
          <div class="hero-count"><b>${pp.done + pp.skipped}</b>/${pp.total}<small>${tHtml('doneSkipped', { done: pp.done, skipped: pp.skipped })}</small></div>
        </div>
        ${progressBar(pp, active.id)}
        ${upNext}
      </section>`;
}

/** Plan card on Home: name, active / done badge, meta, short description, progress once started. */
function planCard(p) {
  const pp = planProgress(p);
  const isActive = state.activePlan === p.id;
  return html`<a class="plan-card card ${isActive ? 'active' : ''}" href="#/plan/${encodeURIComponent(p.id)}">
        <div class="pc-top"><h3>${p.name}</h3>${isActive ? badge(tHtml('badgeActive')) : pp.finished && badge(tHtml('badgeDone'), 'ok')}</div>
        <div class="meta">${raw(planMeta(p))}</div>
        ${p.description && html`<p class="pc-desc">${markdownSummary(p.description, 110)}</p>`}
        ${pp.started && progressBar(pp, p.id)}
      </a>`;
}

/** Home (Plans mode): hero with the active plan and its next workout, then all plans as cards with a search. */
function renderHome() {
  const v = $('#view');
  const active = state.activePlan && planById(state.activePlan);
  const hero = active ? activePlanHero(active)
    : html`<section class="hero card empty"><h1>${tHtml('pickPlan')}</h1><p>${tHtml('pickPlanText', { dir: html`<code>${library.root}</code>`, workouts: workoutsLink() })}</p></section>`;
  const plans = library.plans.filter(isPlan);
  const collections = library.plans.length - plans.length;
  mount(v, html`
    ${hero}
    <section class="section">
      <div class="section-head">
        <h2>${tHtml('plans')} <small>${plans.length}</small></h2>
        <input type="search" id="plan-search" placeholder="${tText('filterPlans')}" autocomplete="off">
      </div>
      <div class="plan-grid" id="plan-grid"></div>
      ${collections > 0 && html`<p class="muted small coll-note">${tHtml('collNote', { n: collections, workouts: workoutsLink() })}</p>`}
    </section>`);
  const grid = $('#plan-grid');
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    const shown = plans.filter((p) => !ql || p.name.toLowerCase().includes(ql) || p.id.toLowerCase().includes(ql));
    mount(grid, shown.length ? html`${shown.map(planCard)}` : html`<p class="muted">${tHtml('noPlansMatch')}</p>`);
  };
  draw();
  $('#plan-search').oninput = (e) => draw(e.target.value);
  bindActions(v);
}


/** One workout row (.wrow): status, title, mini profile, duration, zone/TSS and actions. Used by plans, Workouts, Favorites and FTP Tests. */
function workoutRow(w, { status, isNext, locked, free, showFolder, note, favTools } = {}) {
  // status column: done (pops once right after the ride) · skipped · next · locked · ridden before · empty
  const st = (cls, titleKey, mark) => html`<span class="st ${cls}" title="${tText(titleKey)}">${mark}</span>`;
  const icon = status === 'done' ? st(`done${justDone === w.file && !document.body.classList.contains('riding') ? ' just-done' : ''}`, 'stDone', '✓')
    : status === 'skipped' ? st('skipped', 'stSkipped', '↷')
      : isNext ? st('next', 'upNext', '●')
        : locked ? st('locked', 'stLocked', '🔒')
          : lastRidden.has(w.file) ? st('ridden', 'stRidden', '✓') : html`<span class="st"></span>`;
  const folder = showFolder ? (planById(folderOf(w.file))?.name || '') : '';
  const wd = w.week && showWeekDay(w);
  const sub = [note, folder, wd ? t('weekDayShort', { w: w.week, d: w.day }) : '', lastRiddenText(w.file)].filter(Boolean).join(' · ');
  const subLine = sub && (showFolder || note || lastRidden.has(w.file)) && html`<small>${showFolder || note ? sub : lastRiddenText(w.file)}</small>`;
  const favMove = favTools && html`<span class="favtools"><button class="btn ghost sm" data-act="fav-up" data-file="${w.file}" title="${tText('moveUp')}">↑</button><button class="btn ghost sm" data-act="fav-down" data-file="${w.file}" title="${tText('moveDown')}">↓</button></span>`;
  // the last button depends on the row's role: next plan workout · skipped · free ride
  const main = isNext ? html`<button class="btn primary sm" data-act="start-next">${tHtml('start')}</button><button class="btn ghost sm" data-act="skip-next">${tHtml('skip')}</button>`
    : status === 'skipped' ? html`<button class="btn ghost sm" data-act="unskip" data-file="${w.file}">${tHtml('undoSkip')}</button>`
      : free && html`<button class="btn ghost sm" data-act="ride-free" data-file="${w.file}">${tHtml('ride')}</button>`;
  return html`<div class="wrow ${isNext ? 'is-next' : ''} ${status || ''}" data-act="preview" data-file="${w.file}" tabindex="0">
    ${icon}
    <div class="wtitle">${!showFolder && wd && wdTag(tHtml('dayShort', { d: w.day }))}<div class="wt"><span>${w.title}</span>${subLine}</div></div>
    <div class="wprof">${raw(miniProfile(w.profile, bounds(), { width: 200, height: 28 }))}</div>
    <div class="wdur">${fmtDur(w.duration)}</div>
    <div class="wtss">${zoneTag(w.zone)}<span title="${tText('tssTitle')}">${w.tss ?? '–'}<small> TSS</small></span></div>
    <div class="wact">${favMove}${starBtn(w.file)}<button class="more" data-act="more" data-file="${w.file}" title="${tText('more')}" aria-label="${tText('moreActions')}">⋯</button>${main}</div>
  </div>`;
}

/** Plan page: header with progress and actions, optional description, then the workouts grouped by week (or one list for collections). */
function renderPlan(id) {
  const plan = planById(id);
  const v = $('#view');
  if (!plan) { mount(v, html`<p class="muted">${tHtml('planNotFound')} <a href="#/">${tHtml('back')}</a></p>`); return; }
  const pp = planProgress(plan);
  const isActive = state.activePlan === plan.id;

  // one group per week (plans), or a single list (collections and plans without week numbers)
  const groups = new Map();
  for (const w of plan.workouts) {
    const k = planWeeks(plan) && w.week ? t('weekN', { n: w.week }) : t('modeWorkouts');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const rowOf = (w) => {
    const e = pp.entries[w.file];
    const isNext = isActive && pp.next?.file === w.file;
    return workoutRow(w, { status: e?.status, isNext, locked: isActive && !e && !isNext });
  };
  const weeks = [...groups].map(([k, ws]) => html`
    <div class="week"><h3>${k}</h3><div class="wlist">
      ${ws.map(rowOf)}
    </div></div>`);

  const actions = isActive ? html`<button class="btn ghost" data-act="pause-plan">${tHtml('leavePlan')}</button>`
    : pp.finished ? html`<button class="btn primary" data-act="restart-plan" data-plan="${plan.id}">${tHtml('startAgain')}</button>`
      : html`<button class="btn primary" data-act="start-plan" data-plan="${plan.id}">${tHtml(pp.started ? 'resumePlan' : 'startPlan')}</button>`;
  const menu = html`${pp.started && html`<button data-act="reset-plan" data-plan="${plan.id}">${tHtml('resetProgressMenu')}</button>`}<button data-act="reveal" data-rel="${plan.id}">${tHtml('showIn', { app: PLAT.files })}</button><button data-act="set-kind" data-kind="collection" data-rel="${plan.id}">${tHtml('showAsCollectionLong')}</button><hr><button class="danger-text" data-act="trash-folder" data-rel="${plan.id}">${tHtml('trashPlanFolder', { trash: PLAT.trash })}</button>`;

  mount(v, html`
    <a class="back" href="#/">← ${tHtml('allPlans')}</a>
    <section class="plan-head card">
      <div>
        <div class="eyebrow">${tHtml(isActive ? 'activePlan' : 'plan')}</div>
        <h1>${plan.name}</h1>
        <div class="meta">${tHtml('planMetaTotal', { meta: raw(planMeta(plan)) })} · <code>${plan.id}</code></div>
      </div>
      <div class="plan-actions">${actions}${menuBtn(menu, tText('planActions'))}</div>
      ${pp.started && html`<div class="plan-prog">${progressBar(pp, plan.id)}<span class="muted">${tHtml('doneSkippedToGo', { done: pp.done, skipped: pp.skipped, left: pp.total - pp.done - pp.skipped })}</span></div>`}
    </section>
    ${descriptionBlock(plan.description)}
    <div class="weeks">${weeks}</div>`);
  bindActions(v);
}

// ------------------------------------------------------------------ workouts mode
const wf = { folder: '', q: '', dur: 'all', sort: 'name', limit: 80, zones: new Set() };
const DUR_FILTERS = [['all', 'anyLength'], ['30', '≤ 30 min'], ['60', '30–60 min'], ['90', '60–90 min'], ['90+', '> 90 min']];

/** Workouts mode list after folder, search, duration, zone filters and sort. */
function filteredWorkouts() {
  let list = wf.folder === '@fav'
    ? favs().map((f) => workoutInfo(f)).filter(Boolean)
    : wf.folder === '@recent'
    ? [...lastRidden.entries()].sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).map(([f]) => workoutInfo(f)).filter(Boolean)
    : wf.folder === '@singles' ? library.singles
      : wf.folder ? (planById(wf.folder)?.workouts || []) : allWorkouts();
  const q = wf.q.trim().toLowerCase();
  if (q) list = list.filter((w) => w.title.toLowerCase().includes(q) || w.name.toLowerCase().includes(q) || w.file.toLowerCase().includes(q));
  const m = (w) => w.duration / 60;
  if (wf.dur === '30') list = list.filter((w) => m(w) <= 30);
  if (wf.dur === '60') list = list.filter((w) => m(w) > 30 && m(w) <= 60);
  if (wf.dur === '90') list = list.filter((w) => m(w) > 60 && m(w) <= 90);
  if (wf.dur === '90+') list = list.filter((w) => m(w) > 90);
  if (wf.zones.size) list = list.filter((w) => wf.zones.has(w.zone));
  if (!['@recent', '@fav'].includes(wf.folder) || wf.sort !== 'name') {
    const by = {
      name: (a, b) => (wf.folder ? 0 : a.title.localeCompare(b.title, undefined, { numeric: true })),
      short: (a, b) => a.duration - b.duration,
      long: (a, b) => b.duration - a.duration,
      tss: (a, b) => b.tss - a.tss,
      zone: (a, b) => (b.zone || 0) - (a.zone || 0) || b.tss - a.tss,
      recent: (a, b) => (lastRidden.get(b.file)?.at || '').localeCompare(lastRidden.get(a.file)?.at || ''),
    }[wf.sort];
    list = [...list].sort(by);
  }
  return list;
}

/** Workouts mode: folder sidebar, filters, and the (paged) list of matching workouts. */
function renderWorkouts() {
  const v = $('#view');
  const folders = library.plans;
  const recentCount = lastRidden.size;
  const folderBtn = (id, label, count) => html`<button class="wk-folder ${wf.folder === id ? 'on' : ''}" data-folder="${id}"><span>${label}</span><small>${count}</small></button>`;
  const groups = [[tHtml('plans'), folders.filter(isPlan)], [tHtml('collections'), folders.filter((p) => !isPlan(p))]].filter(([, l]) => l.length);
  const SORTS = [['name', 'name'], ['short', 'sortShortest'], ['long', 'sortLongest'], ['tss', 'sortHardest'], ['zone', 'intensity'], ['recent', 'recentlyRidden']];
  mount(v, html`
    <div class="wk-layout">
      <aside class="wk-side">
        ${folderBtn('', tHtml('allWorkouts'), allWorkouts().length)}
        ${folderBtn('@fav', html`★ ${tHtml('favorites')}`, favs().filter((f) => workoutInfo(f)).length)}
        ${recentCount > 0 && folderBtn('@recent', tHtml('recentlyRidden'), recentCount)}
        ${library.singles.length > 0 && folderBtn('@singles', tHtml('singleWorkouts'), library.singles.length)}
        ${groups.map(([label, list]) => html`<div class="wk-sep">${label}</div>
        ${list.map((p) => folderBtn(p.id, p.name, p.count))}`)}
      </aside>
      <section class="wk-main">
        <div class="wk-head" id="wk-head"></div>
        <div class="wk-tools">
          <input type="search" id="wk-q" placeholder="${tText('searchWorkouts')}" value="${wf.q}" autocomplete="off">
          ${segCtl('wk-dur', DUR_FILTERS.map(([k, l]) => [k, tHtml(l)]), wf.dur, { label: tText('filterLength') })}
          <div class="zone-filter" id="wk-zones" title="${tText('filterIntensity')}">${ZONES.map((z, i) => html`<button data-z="${i + 1}" class="${wf.zones.has(i + 1) ? 'on' : ''}" style="--zc:${z.color}" title="${z.short} ${z.name}"><i></i>${z.short}<span>${z.name}</span></button>`)}</div>
          <select id="wk-sort">${SORTS.map(([k, l]) => html`<option value="${k}" ${wf.sort === k ? 'selected' : ''}>${tHtml(l)}</option>`)}</select>
        </div>
        <div class="wk-count muted" id="wk-count"></div>
        <div class="wlist" id="wk-list"></div>
        <div class="wk-more" id="wk-more"></div>
      </section>
    </div>`);
  // heading of the list: folder name and actions, Favorites hint, or "All workouts"
  const head = () => {
    const f = wf.folder;
    const plan = !f.startsWith('@') && f ? planById(f) : null;
    let frag = html``;
    if (plan) {
      const items = html`<button data-act="reveal" data-rel="${plan.id}">${tHtml('showIn', { app: PLAT.files })}</button>${isPlan(plan)
        ? html`<button data-act="set-kind" data-kind="collection" data-rel="${plan.id}">${tHtml('showAsCollection')}</button>`
        : html`<button data-act="set-kind" data-kind="plan" data-rel="${plan.id}">${tHtml('useAsPlan')}</button>`}<hr><button class="danger-text" data-act="trash-folder" data-rel="${plan.id}">${tHtml('trashFolder', { trash: PLAT.trash })}</button>`;
      frag = html`<h2>${plan.name}</h2>${badge(isPlan(plan) ? tHtml('plan') : tHtml('collection'), 'muted')}<span class="grow"></span>${isPlan(plan) && html`<a class="btn ghost sm" href="#/plan/${encodeURIComponent(plan.id)}" data-act="open-plan">${tHtml('openPlan')}</a>`}${menuBtn(items, tText('folderActions'))}${plan.description && html`<div class="wk-desc">${descriptionBlock(plan.description)}</div>`}`;
    } else if (f === '@fav') frag = html`<h2>${tHtml('favorites')}</h2><span class="muted small">${tHtml('favHint')}</span>`;
    else if (f === '') frag = html`<h2>${tHtml('allWorkouts')}</h2><span class="grow"></span>${menuBtn(html`<button data-act="reveal" data-rel="">${tHtml('showLibraryIn', { app: PLAT.files })}</button>`, tText('libraryActions'))}`;
    mount($('#wk-head'), frag);
    bindActions($('#wk-head'));
  };
  const draw = (animate) => {
    head();
    const list = filteredWorkouts();
    $('#wk-count').textContent = t('nWorkouts', { n: list.length });
    const opts = { free: true, showFolder: !wf.folder || wf.folder.startsWith('@'), favTools: wf.folder === '@fav' && !wf.q && wf.dur === 'all' };
    mount($('#wk-list'), list.length ? html`${list.slice(0, wf.limit).map((w) => workoutRow(w, opts))}` : html`<p class="muted">${tHtml(wf.folder === '@fav' ? 'noFavs' : 'nothingMatches')}</p>`);
    mount($('#wk-more'), list.length > wf.limit ? html`<button class="btn ghost" data-more>${tHtml('showMoreLeft', { n: list.length - wf.limit })}</button>` : html``);
    if (animate && motionOK()) restartAnim($('#wk-list'), 'list-in');
  };
  draw();
  $('.wk-side', v).onclick = (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    wf.folder = b.dataset.folder; wf.limit = 80;
    $$('.wk-folder', v).forEach((x) => x.classList.toggle('on', x === b));
    draw(true);
  };
  $('#wk-q').oninput = (e) => { wf.q = e.target.value; wf.limit = 80; draw(); };
  $('#wk-dur').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; wf.dur = b.dataset.v; selectSeg(e.currentTarget, b); wf.limit = 80; draw(true); };
  $('#wk-dur').onkeydown = rovingKey;
  $('#wk-sort').onchange = (e) => { wf.sort = e.target.value; draw(true); };
  $('#wk-zones').onclick = (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    const z = +b.dataset.z;
    if (wf.zones.has(z)) wf.zones.delete(z); else wf.zones.add(z);
    b.classList.toggle('on', wf.zones.has(z));
    wf.limit = 80; draw(true);
  };
  $('#wk-more').onclick = (e) => { if (e.target.closest('[data-more]')) { wf.limit += 200; draw(); } };
  bindActions($('#wk-list'));
}

// ------------------------------------------------------------------ FTP tests mode
const profileOf = (w) => w.segments.map((x) => [x.duration, x.p0, x.p1]);

function ftpSparkline(tests) {
  const pts = tests.filter((x) => x.accepted && x.ftp).slice(0, 12).reverse();
  if (pts.length < 2) return '';
  const W = 260, H = 56, vals = pts.map((x) => x.ftp);
  const lo = Math.min(...vals) * 0.97, hi = Math.max(...vals) * 1.03;
  const xy = pts.map((x, i) => [(i / (pts.length - 1)) * (W - 12) + 6, H - 6 - ((x.ftp - lo) / (hi - lo || 1)) * (H - 12)]);
  return html`<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="${tText('ftpHistory')}"><polyline points="${xy.map((p) => p.join(',')).join(' ')}"/>${xy.map(([x, y], i) => html`<circle cx="${x}" cy="${y}" r="3"><title>${new Date(pts[i].at).toLocaleDateString(fmtLocale())} · ${pts[i].ftp} W</title></circle>`)}</svg>`;
}

/** Card of a built-in test protocol: name, level, duration, profile, description, Start. */
function testCard(p, F) {
  const w = p.build(F);
  // a ramp ends when the rider fails — typically around FTP / 0.75
  const isRamp = p.id.startsWith('ramp');
  const rampTop = F / 0.75;
  const shown = isRamp ? { segments: w.segments.filter((x) => !x.ramp || x.p0 * F <= rampTop) } : w;
  const dur = isRamp ? `~${Math.round(shown.segments.reduce((a, x) => a + x.duration, 0) / 60)} min` : fmtDur(w.duration);
  return html`<article class="test-card card">
            <div class="pc-top"><h3>${p.name}</h3>${badge(p.level, 'muted')}</div>
            <div class="meta">${dur}</div>
            ${raw(miniProfile(profileOf(shown), bounds(), { width: 320, height: 44 }))}
            <p class="test-about">${p.about}</p>
            <div class="test-method">${p.method}</div>
            <button class="btn primary" data-act="start-test" data-test="${p.id}">${tHtml('startTest')}</button>
          </article>`;
}

/** One row of the test history (date, test, result, change, apply). */
function testRow(x, i) {
  const details = [...(x.details || []).filter((d) => d[1]).map((d) => `${d[0]} ${d[1]}`), x.vo2 ? `VO2max ~${x.vo2} ml/kg/min` : ''].filter(Boolean).join(' · ');
  const change = x.ftp && x.prevFtp && `${x.ftp >= x.prevFtp ? '+' : ''}${Math.round(((x.ftp - x.prevFtp) / x.prevFtp) * 100)} %`;
  return html`<div class="hrow trow">
          <div class="hdate">${new Date(x.at).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          <div class="htitle"><b>${testName(x)}</b><small class="muted">${details}</small></div>
          <div class="hstat">${x.ftp ? html`<b>${x.ftp} W</b>` : x.incomplete ? badge(tHtml('notCompleted'), 'warn') : html`<b>–</b>`}</div>
          <div class="hstat">${change}</div>
          <div class="hact">${x.accepted ? badge(tHtml('applied'), 'ok') : x.ftp && html`<button class="btn ghost sm" data-act="apply-ftp" data-i="${i}">${tHtml('useW', { w: x.ftp })}</button>`}</div>
        </div>`;
}

/** FTP Tests mode: current FTP, zones and bests, the built-in test protocols, test workouts from the library, test history. */
function renderTests() {
  const v = $('#view');
  const F = ftp();
  const tests = state.tests || [];
  const last = tests.find((x) => x.ftp);
  const b = state.settings.bests || {};
  const libTests = allWorkouts().filter(isTestWorkout);
  const zoneChips = ZONES.map((z, i) => {
    const lo = i === 0 ? 0 : Math.round((bounds()[i - 1] / 100) * F) + 1;
    const hi = i < 4 ? Math.round((bounds()[i] / 100) * F) : null;
    return html`<span class="zchip"><i style="background:${z.color}"></i>${z.short} ${hi ? `${lo}–${hi}` : `> ${lo - 1}`} W</span>`;
  });
  const lastLine = last ? html`${tHtml('lastTest', { when: relDate(last.at), name: testName(last), ftp: last.ftp })}${!last.accepted && html` ${tHtml('notApplied')}`}`
    : html`${tHtml(tests.length ? 'noCompletedTest' : 'noTest')} — ${tHtml('pickTestBelow')}`;
  const tv = tests.find((x) => x.vo2);
  const vo2 = tv ? html`<div class="vo2"><span class="k">${tHtml('vo2Est')}</span><b>${tv.vo2}</b> ml/kg/min<small class="muted">${testName(tv)} · ${relDate(tv.at)}</small></div>`
    : !weight() && html`<button class="btn ghost sm" data-act="add-weight">${tHtml('addWeight')}</button>`;
  mount(v, html`
    <section class="hero card ftp-hero">
      <div class="ftp-now">
        <div class="eyebrow">${tHtml('currentFtp')} · ${state.name}</div>
        <div class="ftp-val"><b>${F}</b> W${wkg(F) && html` <span class="wkg">${wkg(F)} W/kg</span>`}</div>
        <div class="meta">${lastLine}</div>
      </div>
      <div class="ftp-side">
        ${ftpSparkline(tests)}
        ${vo2}
        <div class="bests">${[['5 s', b.s5], ['1 min', b.m1], ['5 min', b.m5], ['20 min', b.m20]].map(([k, val]) => html`<div><span class="k">${k}</span><b>${val ? `${val} W` : '–'}</b></div>`)}</div>
      </div>
      <div class="zone-strip">${zoneChips}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>${tHtml('tests')}</h2><span class="muted small">${tHtml('testsHint')}</span></div>
      <div class="test-grid">
        ${PROTOCOLS.map((p) => testCard(p, F))}
      </div>
    </section>
    ${libTests.length > 0 && html`<section class="section"><div class="section-head"><h2>${tHtml('libTests')} <small>${libTests.length}</small></h2><span class="muted small">${tHtml('libTestsHint')}</span></div>
      <div class="wlist">${libTests.map((w) => workoutRow(w, { free: true, showFolder: true, note: classifyTest(w.profile, w.title).label }))}</div></section>`}
    <section class="section">
      <div class="section-head"><h2>${tHtml('testHistory')}</h2></div>
      ${tests.length ? html`<div class="hlist"><div class="hrow trow hhead"><div>${tHtml('colDate')}</div><div>${tHtml('colTest')}</div><div class="hstat">${tHtml('colResult')}</div><div class="hstat">${tHtml('colChange')}</div><div></div></div>
        ${tests.map(testRow)}</div>` : html`<p class="muted">${tHtml('testResultsHere')}</p>`}
    </section>`);
  bindActions(v, {
    'start-test': (el) => startTest(el.dataset.test),
    'apply-ftp': (el) => applyFtp(state.tests[+el.dataset.i]),
    'add-weight': () => openSettings('rider'),
  });
}


async function applyFtp(entry) {
  const prev = ftp();
  state.settings.ftp = entry.ftp;
  for (const x of state.tests) x.accepted = x === entry;
  await api.saveState();
  toast(t('ftpSet', { ftp: entry.ftp, prev }));
  route();
}

/** A built-in test is named in the current language; library tests keep their file's title. */
const testName = (x) => protocolById(x.protocol)?.name || x.name;

function startTest(id) {
  const p = protocolById(id);
  ride = new Ride(p.build(ftp()), `test:${id}`, null, { protocol: p });
}

// ------------------------------------------------------------------ history
/** ✓ badges for platforms a ride reached. */
function svcBadges(h) {
  return Object.entries(h.services || {}).filter(([, v]) => v && !v.error).map(([id]) => {
    const name = svcCache.find((x) => x.id === id)?.name || id;
    const v = h.services[id];
    return v.url ? html`<a class="sync gok" data-act="open-url" data-url="${v.url}">${name} ✓</a>` : html`<span class="sync gok">${name} ✓</span>`;
  });
}

/** "⋯" with upload / import actions for the other platforms. */
function historyMenu(h, i) {
  const items = svcCache.filter((sv) => svcRoute(sv) && !(h.services?.[sv.id] && !h.services[sv.id].error)).map((sv) => (svcRoute(sv) === 'api'
    ? html`<button data-act="h-svc" data-i="${i}" data-id="${sv.id}">${tHtml('uploadTo', { name: sv.name })}</button>`
    : html`<button data-act="h-svc-man" data-i="${i}" data-id="${sv.id}">${tHtml('importTo', { name: sv.name })}</button>`));
  return items.length ? menuBtn(html`${items}`, tText('sendOther')) : '';
}

/** One ride in the history: date, workout and plan, time, power, HR, where it was uploaded, actions. */
function historyRow(h, i) {
  const at = new Date(h.at);
  const garmin = h.garmin?.url ? html`<a class="sync gok" data-act="open-url" data-url="${h.garmin.url}">Garmin ✓</a>`
    : h.fitPath && html`<button class="btn ghost sm" data-act="h-garmin" data-i="${i}" title="${tText('uploadTo', { name: 'Garmin Connect' })}">Garmin</button>`;
  return html`<div class="hrow">
      <div class="hdate">${at.toLocaleDateString(fmtLocale(), { weekday: 'short', day: 'numeric', month: 'short' })}<small>${at.toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' })}</small></div>
      <div class="htitle"><b>${h.title}</b><small class="muted">${h.plan ? planById(h.plan)?.name || h.plan : tHtml('freeRide')}${h.completed === false && html` · ${tHtml('endedEarly')}`}</small></div>
      <div class="hstat">${fmtTime(h.doneDuration || 0)}</div>
      <div class="hstat">${h.avgPower ? `${h.avgPower} W` : '–'}</div>
      <div class="hstat">${h.avgHr ? `${h.avgHr} bpm` : '–'}</div>
      <div class="hact">${garmin}${svcBadges(h)}${h.fitPath && html`<button class="btn ghost sm" data-act="h-fit" data-i="${i}" title="${tText('saveFitFile')}">FIT</button>${historyMenu(h, i)}`}</div>
    </div>`;
}

/** Ride history: one row per ride with stats, upload state per service and the ⋯ menu. */
function renderHistory() {
  const v = $('#view');
  const head = html`<div class="hrow hhead"><div>${tHtml('colDate')}</div><div>${tHtml('colWorkout')}</div><div class="hstat">${tHtml('colTime')}</div><div class="hstat">${tHtml('colPower')}</div><div class="hstat">${tHtml('colHr')}</div><div></div></div>`;
  mount(v, html`
    <a class="back" href="#/">← ${tHtml('back')}</a>
    <section class="section-head"><h1>${tHtml('rideHistory')} <small class="muted">${state.name}</small></h1></section>
    ${state.history.length ? html`<div class="hlist">${head}${state.history.map(historyRow)}</div>` : html`<p class="muted">${tHtml('noRides')}</p>`}`);
  bindActions(v);
}



// ------------------------------------------------------------------ actions
// Every clickable thing carries data-act="name" (plus data-* arguments such as data-file, data-plan,
// data-rel, data-i = history index). bindActions(root, handlers) delegates clicks inside `root`:
// a handler from `handlers` (dialog- or screen-specific) wins, otherwise the shared VIEW_ACTIONS below.
// Handlers get (el, event) and may be async.

const activePlanObj = () => state.activePlan && planById(state.activePlan);
const historyOf = (el) => state.history[+el.dataset.i];
const openExternal = (cmd, args) => invoke(cmd, args).catch((err) => toast(String(err)));

/** Actions available in every view, row, ⋯ menu and dialog. */
const VIEW_ACTIONS = {
  close: () => closeModal(),   // ✕ in every dialog header
  preview: (el) => openPreview(el.dataset.file),
  'start-next': () => { const plan = activePlanObj(), n = plan && planProgress(plan).next; if (n) startRide(n.file, plan.id); },
  'skip-next': async () => {
    const plan = activePlanObj(), n = plan && planProgress(plan).next;
    if (n && await confirmDialog(t('skipQ', { title: n.title }), t('skipText'), t('skip'))) markEntry(plan.id, n.file, { status: 'skipped' });
  },
  unskip: (el) => unskip(el.dataset.file),
  'ride-free': (el) => startRide(el.dataset.file, null),
  'start-plan': (el) => activatePlan(el.dataset.plan),
  'restart-plan': (el) => { delete state.plans[el.dataset.plan]; return activatePlan(el.dataset.plan); },
  'mode-workouts': () => setMode('workouts'),
  'pause-plan': async () => {
    if (await confirmDialog(t('leavePlanQ'), t('leavePlanText'), t('leavePlan'))) { state.activePlan = null; await api.saveState(); route(); }
  },
  'pick-dir': () => pickDir(),
  'close-plan': async () => { state.activePlan = null; await api.saveState(); route(); },
  'reset-plan': async (el) => {
    if (!await confirmDialog(t('resetQ'), t('resetText'), t('reset'), true)) return;
    delete state.plans[el.dataset.plan];
    if (state.activePlan === el.dataset.plan) state.activePlan = null;
    await api.saveState(); route();
  },
  fav: async (el) => { await toggleFav(el.dataset.file); refreshView(); },
  'fav-up': (el) => moveFav(el.dataset.file, -1),
  'fav-down': (el) => moveFav(el.dataset.file, 1),
  more: (el) => moreMenu(el, el.dataset.file),
  menu: (el) => openMenu(el),
  'md-link': (el) => openExternal('open_link', { url: el.dataset.link }),
  'desc-toggle': (el) => {
    const box = el.closest('.plan-desc');
    const collapsed = box.classList.toggle('is-collapsed');
    if (collapsed && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },
  'open-plan': async () => { location.hash = `#/plan/${encodeURIComponent(wf.folder)}`; if (mode() !== 'plans') await setMode('plans'); },
  'set-kind': async (el) => {
    const id = el.dataset.rel, kind = el.dataset.kind, p = planById(id);
    if (kind === 'collection' && state.activePlan === id) {
      if (!await confirmDialog(t('showAsCollectionQ'), t('showAsCollectionText', { name: p.name }), t('showAsCollection'))) return;
      state.activePlan = null;
    }
    state.settings.folderKinds = { ...(state.settings.folderKinds || {}), [id]: kind };
    await api.saveState();
    toast(kind === 'plan' ? t('nowPlan', { name: p.name }) : t('nowCollection', { name: p.name }));
    if (kind === 'plan') { if (mode() !== 'plans') await setMode('plans'); location.hash = `#/plan/${encodeURIComponent(id)}`; return; }
    if (location.hash.startsWith('#/plan/')) location.hash = '#/';
    route();
  },
  reveal: (el) => openExternal('reveal_in_library', { rel: el.dataset.rel }),
  'trash-folder': (el) => trashItem(el.dataset.rel, true),
  'open-url': (el) => openExternal('open_url', { url: el.dataset.url }),
  // ride history rows (data-i = index in state.history)
  'h-fit': (el) => exportFit(historyOf(el).fitPath),
  'h-svc-man': (el) => manualImport(el.dataset.id, historyOf(el).fitPath),
  'h-svc': async (el) => {
    toast(t('uploading'));
    try { await uploadToService(historyOf(el), el.dataset.id); toast(t('uploaded')); } catch (err) { toast(String(err.message || err)); }
    refreshView();
  },
  'h-garmin': async (el) => {
    const h = historyOf(el);
    const g = await invoke('garmin_status').catch(() => ({}));
    if (!g.connected) return garminImport(h.fitPath);
    el.disabled = true; el.textContent = t('uploading');
    await uploadToGarmin(h).catch((err) => toast(String(err)));
    renderHistory();
  },
};

/** Swap a favourite with its neighbour (dir −1 = up, +1 = down) in the rider's order. */
async function moveFav(file, dir) {
  const f = favs(), i = f.indexOf(file), j = i + dir;
  if (i < 0 || j < 0 || j >= f.length) return;
  [f[i], f[j]] = [f[j], f[i]];
  await api.saveState();
  refreshView();
}

/**
 * Delegate clicks on [data-act] inside `root` to handlers[act] or VIEW_ACTIONS[act]. Replaces any
 * earlier delegation on the same root (each view / dialog render binds afresh). Enter on a focused
 * workout row opens it, like a click.
 */
function bindActions(root, handlers = {}) {
  root.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.act] ?? VIEW_ACTIONS[el.dataset.act];
    if (!fn) return;
    if (el.matches('a, button')) e.preventDefault();   // links have no real href target; buttons may sit in forms
    e.stopPropagation();
    await fn(el, e);
  };
  root.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('.wrow')) e.target.click(); };
}

/** Re-render the current view keeping scroll position. */
function refreshView() {
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
}

/** A quiet "⋯" button whose items (regular data-act buttons) open in a popover. */

function openMenu(anchor) {
  $('#popover')?.remove();
  const tpl = anchor.parentElement.querySelector('template');
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.id = 'popover';
  pop.className = 'popover';
  pop.append(tpl.content.cloneNode(true));
  document.body.appendChild(pop);
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  const close = () => { pop.remove(); document.removeEventListener('click', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', outside, true));
  bindActions(pop);
  pop.addEventListener('click', (e) => { if (e.target.closest('[data-act]')) setTimeout(close); });
}

/** ⋯ menu of a workout row / the preview: favourite, open its folder, show in the file manager, move to the trash. */
function moreMenu(anchor, file) {
  $('#popover')?.remove();
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.id = 'popover';
  pop.className = 'popover';
  mount(pop, html`
    <button data-act="fav">${isFav(file) ? html`★ ${tHtml('favRemove')}` : html`☆ ${tHtml('favAdd')}`}</button>
    <button data-act="reveal">${tHtml('showIn', { app: PLAT.files })}</button>
    <button data-act="folder">${tHtml('openItsFolder')}</button>
    <hr><button data-act="trash" class="danger-text">${tHtml('trashWorkout', { trash: PLAT.trash })}</button>`);
  document.body.appendChild(pop);
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  const close = () => { pop.remove(); document.removeEventListener('click', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', outside, true));
  // every item closes the menu first, then acts on this workout
  const act = (fn) => async () => { close(); await fn(); };
  bindActions(pop, {
    fav: act(async () => { await toggleFav(file); refreshView(); }),
    reveal: act(() => openExternal('reveal_in_library', { rel: file })),
    folder: act(async () => { const f = folderOf(file); if (mode() !== 'workouts') await setMode('workouts'); wf.folder = f && planById(f) ? f : '@singles'; route(); }),
    trash: act(() => trashItem(file, false)),
  });
}

/** Move a workout or a whole plan folder to the Trash and clean up references. */
async function trashItem(rel, isFolder) {
  const plan = isFolder ? planById(rel) : null;
  const info = isFolder ? null : workoutInfo(rel);
  const title = t('trashQ', { name: isFolder ? plan?.name || rel : info?.title || rel, trash: PLAT.trash });
  const text = isFolder
    ? t('trashFolderText', { n: plan?.count ?? '?', trash: PLAT.trash })
    : t('trashFileText', { trash: PLAT.trash });
  if (!await confirmDialog(title, text, t('moveTo', { trash: PLAT.trash }), true)) return;
  try { await invoke('trash_in_library', { rel }); } catch (e) { return toast(String(e)); }
  const inFolder = (f) => (isFolder ? f.startsWith(`${rel}/`) : f === rel);
  state.favorites = favs().filter((f) => !inFolder(f));
  if (isFolder) {
    delete state.plans[rel];
    if (state.activePlan === rel) state.activePlan = null;
    if (wf.folder === rel) wf.folder = '';
  } else {
    for (const ps of Object.values(state.plans)) if (ps.entries?.[rel]) delete ps.entries[rel];
  }
  await api.saveState();
  toast(t('movedTo', { trash: PLAT.trash }));
  if (isFolder && location.hash.startsWith('#/plan/')) location.hash = '#/';
  await loadLibrary();
}

async function activatePlan(id) {
  if (state.activePlan && state.activePlan !== id) {
    const cur = planById(state.activePlan);
    if (!await confirmDialog(t('switchPlanQ'), t('switchPlanText', { name: cur?.name }), t('switch'))) return;
  }
  state.plans[id] ||= { startedAt: new Date().toISOString(), entries: {} };
  state.activePlan = id;
  await api.saveState();
  location.hash = '#/';
  route();
}

async function markEntry(planId, file, entry) {
  const ps = (state.plans[planId] ||= { startedAt: new Date().toISOString(), entries: {} });
  ps.entries[file] = { ...entry, at: new Date().toISOString() };
  if (entry.status === 'done') justDone = file;
  const plan = planById(planId);
  if (plan && !planProgress(plan).next) ps.finishedAt = new Date().toISOString();
  await api.saveState();
  route();
}

async function unskip(file) {
  const id = state.activePlan;
  if (!id || !state.plans[id]?.entries[file]) return;
  delete state.plans[id].entries[file];
  delete state.plans[id].finishedAt;
  await api.saveState();
  toast(t('upNextAgain'));
  route();
}

// ------------------------------------------------------------------ modals
const modal = $('#modal');
let modalCloseTimer = null;
/** Show #modal with an html`` fragment and size classes (small, wide, settings …). One dialog at a time; a plain string would show as text. */
function openModal(markup, cls = '') {
  if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; } // reopened while fading out: keep it open
  modal.className = cls;
  modal.onclick = null;   // the previous dialog's action delegation must not handle this one's buttons
  mount($('.modal-body', modal), markup);
  if (!modal.open) modal.showModal();
  return modal;
}
/** Close #modal with its animation; onModalClose (e.g. Settings) runs afterwards. */
function closeModal() {
  if (!modal.open || modalCloseTimer) return;
  if (!motionOK()) return modal.close();
  modal.classList.add('closing');
  modalCloseTimer = setTimeout(() => { modalCloseTimer = null; modal.classList.remove('closing'); modal.close(); }, 120);
}
modal.addEventListener('click', (e) => { if (e.target === modal && !modal.classList.contains('sticky')) closeModal(); });
modal.addEventListener('cancel', (e) => { if (modal.classList.contains('sticky')) e.preventDefault(); });
// a dialog's own clean-up when it closes (Settings redraws the views once)
let onModalClose = null;
modal.addEventListener('close', () => { const fn = onModalClose; onModalClose = null; fn?.(); });

/** Yes/no dialog; resolves true when confirmed. Texts are plain text (escaped here). */
function confirmDialog(title, text, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    openModal(html`<h2>${title}</h2><p>${text}</p><div class="modal-actions"><button class="btn ghost" data-r="0">${tHtml('cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${ok}</button></div>`, 'small');
    const done = (r) => { modal.removeEventListener('close', onClose); closeModal(); resolve(r); };
    const onClose = () => resolve(false);
    modal.addEventListener('close', onClose, { once: true });
    $$('[data-r]', modal).forEach((b) => (b.onclick = () => done(b.dataset.r === '1')));
  });
}

/** Dialog with one text field (rename); resolves the entered value, or nothing on cancel. */
function promptDialog(title, value = '') {
  return new Promise((resolve) => {
    openModal(html`<h2>${title}</h2><form id="pf"><input type="text" name="v" value="${value}" maxlength="40" class="full" autocomplete="off"><div class="modal-actions"><button class="btn ghost" type="button" data-r="0">${tHtml('cancel')}</button><button class="btn primary" type="submit">${tHtml('save')}</button></div></form>`, 'small');
    let settled = false;
    const f = $('#pf', modal);
    f.v.select();
    f.onsubmit = (e) => { e.preventDefault(); settled = true; const v = f.v.value.trim(); closeModal(); resolve(v || null); };
    $('[data-r]', modal).onclick = () => { settled = true; closeModal(); resolve(null); };
    modal.addEventListener('close', () => { if (!settled) resolve(null); }, { once: true });
  });
}

let toastTimer;
/** Short plain-text notice at the bottom (3.2 s). */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  if (el.hidden || el.classList.contains('out')) { el.classList.remove('out'); el.hidden = false; if (motionOK()) restartAnim(el, 'in'); }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (!motionOK()) { el.hidden = true; return; }
    el.classList.add('out');
    toastTimer = setTimeout(() => { el.hidden = true; el.classList.remove('in', 'out'); }, 180);
  }, 3200);
}

/** Workout preview dialog: header, interactive chart with segment info, zones, description and start buttons. */
async function openPreview(file) {
  const info = workoutInfo(file);
  openModal(html`<div class="loading">${tHtml('loading')}</div>`, 'wide');
  const { workout } = await api.workout(file);
  const planId = folderOf(file);
  const plan = planById(planId);
  const active = state.activePlan && planById(state.activePlan);
  const pp = active && planProgress(active);
  const inActive = active && planId === active.id;
  const isNext = inActive && pp.next?.file === file;
  const entry = planId && state.plans[planId]?.entries[file];

  // secondary "Open plan" link whenever the workout belongs to a plan (and we're not on that plan's page)
  const onPlanPage = location.hash === `#/plan/${encodeURIComponent(planId)}`;
  const planLink = plan && isPlan(plan) && !onPlanPage && html`<button class="btn ghost" data-act="plan" title="${tText('goTo', { name: plan.name })}">${tHtml('openPlan')}</button>`;
  const status = entry ? tHtml(entry.status === 'done' ? 'markedDone' : 'markedSkipped') : tHtml('lockedText');
  // what can be done with this workout right now: ride it freely, start / skip it as the next plan
  // workout, see its state in the active plan, or open the plan it belongs to
  const actions = mode() !== 'plans' ? html`<span class="muted small">${tHtml('freeRideNotCounted')}</span>${planLink}<button class="btn primary" data-act="free">${tHtml('ride')}</button>`
    : isNext ? html`${planLink}<button class="btn ghost" data-act="skip">${tHtml('skip')}</button><button class="btn primary" data-act="start">${tHtml('startWorkout')}</button>`
      : inActive ? html`<span class="muted">${status}</span>${planLink}`
        : plan ? html`<span class="muted small">${tHtml('partOf', { name: plan.name })}</span><button class="btn primary" data-act="plan">${tHtml('openPlan')}</button>`
          : html`<button class="btn primary" data-act="free">${tHtml('ride')}</button>`;

  const lr = lastRiddenText(file);
  const weekDay = info?.week && showWeekDay(info) && html` · ${tHtml('weekDayLong', { w: info.week, d: info.day })}`;
  openModal(html`
    <div class="pv-head">
      <div><div class="eyebrow">${plan ? plan.name : tHtml('workout')}${weekDay}</div><h2>${info?.title || workout.name}</h2>
      <div class="meta">${fmtDur(workout.duration)} · TSS ~${estimateTss(workout.segments)} · ${tHtml('nSegments', { n: workout.segments.length })}${workout.author && html` · ${workout.author}`}${lr && html` · <b class="lr">${lr}</b>`}</div></div>
      <div class="pv-tools">${starBtn(file)}<button class="more" data-act="more" data-file="${file}" title="${tText('more')}" aria-label="${tText('moreActions')}">⋯</button>${closeBtn()}</div>
    </div>
    <div class="pv-diagram"></div>
    <div class="seg-info muted">${tHtml('tapSegment', { ftp: ftp() })}</div>
    ${raw(zoneBreakdown(workout))}
    ${workout.description && html`<p class="pv-desc">${workout.description}</p>`}
    <div class="modal-actions">${actions}</div>`, 'wide');

  const d = new Diagram($('.pv-diagram', modal), workout, {
    bounds: bounds(), ftp: ftp(),
    onSelect: (i, s) => { d.highlight(i); mount($('.seg-info', modal), segmentText(s)); },
  });
  if (motionOK()) d.segEls.forEach((g, i) => { g.style.animationDelay = `${80 + Math.min(i, 30) * 12}ms`; g.classList.add('grow'); });
  // the dialog closes first, then the chosen action runs
  const leave = (fn) => async (el) => { closeModal(); await fn(el); };
  bindActions(modal, {
    fav: async (el) => { await toggleFav(file); el.replaceWith(mount(document.createElement('template'), starBtn(file)).content); refreshView(); },
    more: (el) => { closeModal(); setTimeout(() => moreMenu(document.querySelector(`.wrow[data-file="${CSS.escape(file)}"] .more`) || el, file), 0); },
    start: leave(() => startRide(file, active.id)),
    free: leave(() => startRide(file, null)),
    plan: leave(async () => { if (mode() !== 'plans') await setMode('plans'); location.hash = `#/plan/${encodeURIComponent(planId)}`; }),
    skip: leave(async () => { if (await confirmDialog(t('skipQ', { title: info.title }), t('skipText'), t('skip'))) markEntry(active.id, file, { status: 'skipped' }); }),
  });
}

/** Seconds per zone of a workout, for the zone bar and legend in the preview. */
function zoneBreakdown(workout) {
  const secs = [0, 0, 0, 0, 0];
  let free = 0;
  for (const s of workout.segments) {
    if (s.p0 === null) { free += s.duration; continue; }
    const n = Math.max(1, Math.round(s.duration / 5));
    for (let i = 0; i < n; i++) secs[zoneOf(powerAt(s, ((i + 0.5) / n) * s.duration), bounds()).id - 1] += s.duration / n;
  }
  const total = workout.duration || 1;
  return `<div class="zones-bar">${ZONES.map((z, i) => secs[i] ? `<i style="flex:${secs[i]};background:${z.color}" title="${z.short} ${z.name}: ${fmtTime(secs[i])}"></i>` : '').join('')}${free ? `<i style="flex:${free};background:${FREE_COLOR}" title="${t('freeRide')} ${fmtTime(free)}"></i>` : ''}</div>
  <div class="zones-legend">${ZONES.map((z, i) => `<span><i style="background:${z.color}"></i>${z.short} ${z.name} <b>${Math.round((secs[i] / total) * 100)}%</b></span>`).join('')}</div>`;
}

function targetText(s, mult = 1) {
  if (s.p0 === null) return s.type === 'maxeffort' ? t('maxEffort') : t('freeRide');
  const a = Math.round(s.p0 * 100 * mult), b = Math.round(s.p1 * 100 * mult);
  const wa = Math.round(s.p0 * ftp() * mult), wb = Math.round(s.p1 * ftp() * mult);
  return a === b ? `${a}% · ${wa} W` : `${a}–${b}% · ${wa}–${wb} W`;
}

/** One segment in words (name, type, duration, target, cadence, zone): chart tooltip and preview line. */
function segmentText(s) {
  const kind = tHtml({ steady: 'segSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'segOn', off: 'segOff', freeride: 'freeRide', maxeffort: 'maxEffort' }[s.type] || 'segment');
  const z = s.p0 !== null ? zoneOf((s.p0 + s.p1) / 2, bounds()) : null;
  return html`<b>${s.label}${s.reps > 0 && ` (${s.rep}/${s.reps})`}</b> ${kind} · ${fmtTime(s.duration)} · ${targetText(s)}${s.cadence > 0 && ` · ${s.cadence} rpm`}${z && html` · <span style="color:var(--z${z.id}-ink)">${z.short} ${z.name}</span>`}`;
}

// ------------------------------------------------------------------ settings
/** Upload mode selector: “Off / manual / auto”. */
function syncMode(svc) {
  return (state.settings[svc] || {}).mode || 'auto';
}
const MODES = [['off', 'off'], ['manual', 'manual'], ['auto', 'automatic']];
const modeSelect = (name, cur) => segRow(`mode-${name}`, tHtml('upload'), MODES.map(([k, l]) => [k, tHtml(l)]), cur, 'sync-mode');

/** Arrow keys / Home / End inside tab lists and segmented controls (selection follows focus). */
function rovingKey(e) {
  const el = e.target.closest?.('[role=tab], .seg-ctl [role=radio]');
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' }[e.key];
  if (!el || step === undefined) return;
  const items = [...el.parentElement.children].filter((x) => x.getAttribute('role') === el.getAttribute('role') && !x.disabled);
  const i = items.indexOf(el);
  const next = items[step === 'first' ? 0 : step === 'last' ? items.length - 1 : (i + step + items.length) % items.length];
  e.preventDefault();
  next.focus();
  next.click();
}
modal.addEventListener('keydown', rovingKey);

const fmtNum = (n) => n.toLocaleString(fmtLocale());

/** Language of the UI right now: the rider's choice, else the system language. */
const uiLang = () => coerceLocale(state.settings.language) || systemLocale();

/** Hint under a platform in Settings: our own text when we have one, else what Rust sent. */
const svcHint = (sv) => (t(`svcHint.${sv.id}`) !== `svcHint.${sv.id}` ? tHtml(`svcHint.${sv.id}`) : sv.hint);

// set by Settings while open; the views redraw once when the dialog closes
let settingsDirty = false;

// ---- Settings: small markup builders shared by the tabs ------------------------------------------

/** Number field: label · input · unit, plus the (hidden) error line it points to. `attrs` is trusted (min/max/step). */
const numField = (name, label, value, attrs, unit = '') => html`<label for="set-${name}">${label} <span><input type="number" id="set-${name}" name="${name}" value="${value ?? ''}" ${raw(attrs)} aria-describedby="err-${name}">${unit && html` ${unit}`}</span></label><p class="field-err" id="err-${name}" hidden></p>`;
/** Checkbox row (`cls: 'sub'` indents it under the option it depends on). */
const checkField = (name, on, label, cls = '') => html`<label class="check ${cls}"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;

const SETTINGS_TABS = [['rider', 'tabRider'], ['riding', 'tabRiding'], ['sync', 'tabConnections'], ['app', 'tabApp']];
/** One tab panel; only the current tab is visible. */
const tabPane = (key, cur, body) => html`<div class="tab-pane" role="tabpanel" id="pane-${key}" aria-labelledby="tab-${key}" data-pane="${key}" ${key === cur ? '' : raw('hidden')}>${body}</div>`;

/** Rider: FTP, max HR, weight, personal bests, zone limits. */
function settingsRiderTab(s) {
  return html`
      <div class="form">
        ${numField('ftp', 'FTP', s.ftp, 'min="50" max="600"', 'W')}
        ${numField('maxHr', tHtml('maxHr'), s.maxHr, 'min="100" max="230"', 'bpm')}
        ${numField('weight', tHtml('weight'), s.weight, 'min="30" max="200" step="0.1"', 'kg')}
      </div>
      <h3>${tHtml('personalBests')} <small class="muted">${tHtml('personalBestsHint')}</small></h3>
      <div class="form">${[['s5', '5 s'], ['m1', '1 min'], ['m5', '5 min'], ['m20', '20 min']].map(([k, l]) => numField(`b_${k}`, l, s.bests?.[k], 'min="1" max="3000"', 'W'))}</div>
      <h3>${tHtml('trainingZones')} <small class="muted">${tHtml('trainingZonesHint')}</small></h3>
      <div class="zone-form" id="zone-form">
        ${ZONES.map((z, i) => html`<div class="zf"><i style="background:${z.color}"></i><span>${z.short} ${z.name}</span>
          ${i < 4
            ? html`<span>≤ <input type="number" name="z${i}" value="${s.zones[i]}" min="30" max="200" aria-label="${tText('zoneLimitAria', { zone: `${z.short} ${z.name}` })}" aria-describedby="err-zones"> %</span>`
            : html`<span>&gt; <b class="z5-lim" id="z5-lim">${s.zones[3]}</b> %</span>`}</div>`)}
        <p class="field-err" id="err-zones" hidden></p>
      </div>`;
}

/** Riding: sounds, ride behaviour, virtual shifting (gear tuning under Advanced). */
function settingsRidingTab(s, sh) {
  return html`
      <h3>${tHtml('grpSounds')}</h3>
      <div class="form">
        ${checkField('beeps', s.beeps, tHtml('optBeeps'))}
        ${checkField('beepDirection', s.beepDirection !== false, tHtml('optBeepDirection'), 'sub')}
        ${checkField('endChime', s.endChime !== false, tHtml('optEndChime'))}
      </div>
      <h3>${tHtml('grpDuringRide')}</h3>
      <div class="form">
        ${checkField('autoPause', s.autoPause !== false, tHtml('optAutoPause'))}
        ${checkField('coachHints', s.coachHints !== false, tHtml('optCoach'))}
        ${checkField('keyboardShortcuts', s.keyboardShortcuts !== false, tHtml('optKeys'))}
      </div>
      <h3>${tHtml('virtualShifting')} <small class="muted">${tHtml('virtualShiftingHint')}</small></h3>
      <div class="form">
        ${segRow('vs-mode', tHtml('vsDefault'), [['ask', tHtml('vsAsk')], ['gears', tHtml('realGears')], ['virtual', tHtml('virtualGears')]], sh.mode)}
        <p class="muted small hint" id="vs-mode-hint">${tHtml(`vsHint.${sh.mode}`)}</p>
        ${segRow('vs-diff', tHtml('difficulty'), ['easy', 'medium', 'hard'].map((k) => [k, tHtml(`diff.${k}`)]), sh.difficulty)}
        <p class="muted small hint">${tHtml('difficultyHint')}</p>
      </div>
      <details class="adv">
        <summary>${tHtml('advanced')}</summary>
        <div class="form">
          <label for="set-vsMin">${tHtml('gearRange')} <span><input type="number" id="set-vsMin" name="vsMin" value="${sh.minRatio}" min="0.4" max="2" step="0.05" aria-label="${tText('gearRangeMin')}" aria-describedby="err-vsMin"> – <input type="number" name="vsMax" value="${sh.maxRatio}" min="2.5" max="7" step="0.05" aria-label="${tText('gearRangeMax')}" aria-describedby="err-vsMax"></span></label>
          <p class="field-err" id="err-vsMin" hidden></p><p class="field-err" id="err-vsMax" hidden></p>
          <p class="muted small hint">${tHtml('gearRangeHint', { n: sh.gears })}</p>
          ${numField('vsStart', tHtml('startGear'), sh.startGear, `min="1" max="${sh.gears}"`, tHtml('ofN', { n: sh.gears }))}
        </div>
      </details>`;
}

const SYNC_ICON = raw('<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/></svg>');

/** One platform card (Intervals.icu, COROS): status, connect / disconnect, upload mode or import button. */
function serviceCard(sv) {
  const mode = svcMode(sv);
  const status = sv.connected ? (sv.account ? tHtml('connectedAs', { name: sv.account }) : tHtml('connectedCap')) : tHtml(sv.kind === 'manual' ? 'manualImport' : 'notConnected');
  const keyLabel = tText('apiKeyPlaceholder', { name: sv.name });
  const body = sv.connected ? modeSelect(`svc-${sv.id}`, mode)
    : sv.kind === 'apikey' ? html`<div class="cred"><input type="password" name="key-${sv.id}" placeholder="${keyLabel}" aria-label="${keyLabel}" autocomplete="off"><button class="btn primary sm" data-act="svc-key" data-id="${sv.id}">${tHtml('connect')}</button></div>
      <p class="muted small">${svcHint(sv)} <a href="#" class="link" data-act="svc-getkey">${tHtml('openIntervalsSettings')}</a></p>`
      : sv.manualUrl ? html`${segRow(`mode-svc-${sv.id}`, tHtml('afterRide'), [['off', tHtml('off')], ['manual', tHtml('showImportButton')]], mode, 'sync-mode')}<p class="muted small">${svcHint(sv)}</p>`
        : null;
  return html`<div class="svc svc-ext ${sv.connected ? 'on' : ''}"><div class="svc-head"><span class="svc-logo ext">${SVC_LOGO[sv.id] || sv.name[0]}</span><div><b>${sv.name}</b><small class="muted">${status}</small></div>${sv.connected && html`<button class="btn ghost sm" data-act="svc-off" data-id="${sv.id}">${tHtml('disconnect')}</button>`}</div>${body}</div>`;
}

/** Connections: profile sync folder, Garmin Connect, other platforms. */
function settingsSyncTab(s, { garmin, targets, svcs }) {
  const sp = syncOn() ? syncCfg.provider : 'off';
  const where = PLAT.onThisMachine;
  const syncRow = (id, label, path, found, extra = null) => html`<label class="sync-opt ${found ? '' : 'na'}"><input type="radio" name="syncp" value="${id}" ${sp === id ? 'checked' : ''} ${found ? '' : 'disabled'}><span><b>${label}</b><small class="muted">${extra || (path ? path.replace(/^\/Users\/[^/]+/, '~') : tHtml('syncNotFound', { where }))}</small></span></label>`;
  const syncState = syncCfg.lastError ? html`<span class="warn-text">${syncCfg.lastError}</span>` : syncCfg.lastSync ? tHtml('lastSynced', { when: agoText(syncCfg.lastSync) }) : tHtml('notSyncedYet');
  return html`
      <div class="svc">
        <div class="svc-head"><span class="svc-logo sync">${SYNC_ICON}</span>
          <div><b>${tHtml('profileSync')}</b><small class="muted" id="sync-status">${syncOn() ? html`${syncLabel(sp)} · ${syncState}` : tHtml('syncOffStatus', { where })}</small></div>
          ${syncOn() && html`<button class="btn ghost sm" data-act="sync-now">${tHtml('syncNow')}</button>`}</div>
        <div class="sync-opts" id="sync-opts" role="radiogroup" aria-label="${tText('profileSync')}">
          ${syncRow('off', tHtml('off'), null, true, tHtml('syncOffHint', { where }))}
          ${targets.map((tg) => syncRow(tg.provider, tg.label, tg.path, tg.found))}
          ${syncRow('folder', tHtml('otherFolder'), sp === 'folder' ? syncCfg.dir : null, true, sp === 'folder' ? syncCfg.dir : tHtml('otherFolderHint'))}
        </div>
        <p class="muted small">${tHtml('syncHint', { machine: PLAT.machine })}</p>
      </div>
      <div class="svc">
        <div class="svc-head"><span class="svc-logo garmin">G</span><div><b>Garmin Connect</b><small class="muted">${garmin.connected ? (garmin.name ? tHtml('signedInAs', { name: garmin.name }) : tHtml('signedIn')) : tHtml('notSignedIn')}</small></div>
          ${garmin.connected ? html`<button class="btn ghost sm" data-act="garmin-off">${tHtml('signOut')}</button>` : html`<button class="btn garmin" data-act="garmin-on">${tHtml('signInGarmin')}</button>`}</div>
        ${garmin.connected ? modeSelect('garminMode', syncMode('garmin')) : html`<p class="muted small">${tHtml('garminHint', { where })}</p>`}
        <p class="muted small">${tHtml('stravaHint')}</p>
        <details class="adv">
          <summary>${tHtml('manualFit')}</summary>
          <p class="muted small">${tHtml('manualFitHint', { app: PLAT.files })}</p>
          <div class="folder-row"><code>${s.garmin?.folder || 'Downloads'}</code><button class="btn ghost sm" data-act="garmin-dir">${tHtml('changeDots')}</button></div>
          ${checkField('garminAuto', s.garmin?.autoOpen, tHtml('manualFitAuto'))}
        </details>
      </div>
      ${svcs.length > 0 && html`<h3 class="svc-group">${tHtml('morePlatforms')}</h3>${svcs.map(serviceCard)}`}`;
}

const ABOUT_LINKS = [['https://steffenr.github.io/zwo-trainer/', 'website'], ['https://github.com/steffenr/zwo-trainer', 'sourceCode'], ['https://github.com/steffenr/zwo-trainer/releases/latest/download/THIRD-PARTY-NOTICES.html', 'thirdParty'], ['https://buymeacoffee.com/steffenr', 'buyCoffee']];

/** App: appearance, language, workouts folder, devices, updates, about. */
function settingsAppTab(s) {
  const devs = s.devices || {};
  const none = t('none');
  return html`
      <div class="form">
        ${segRow('theme-ctl', tHtml('appearance'), ['system', 'light', 'dark'].map((th) => [th, tHtml(THEME_LABEL[th])]), s.theme || 'system')}
        ${segRow('lang-ctl', tHtml('language'), LOCALES.map((l) => [l.value, l.nativeLabel, { lang: l.value }]), uiLang())}
      </div>
      <h3>${tHtml('workoutsFolder')}</h3>
      <div class="folder-row"><code>${library.root}</code><button class="btn ghost sm" data-act="dir">${tHtml('changeDots')}</button><button class="btn ghost sm" data-act="rescan" title="${tText('rescanTitle')}">${tHtml('rescan')}</button></div>
      <h3>${tHtml('devices')}</h3>
      <div class="dev-sum"><p class="muted small">${tHtml('devicesSummary', { trainer: devs.trainer?.name || none, hr: devs.hr?.name || none, shifter: (devs.controllers || []).map((c) => c.name).join(' + ') || none })}</p><button class="btn ghost sm" data-act="devices">${tHtml('manageDevices')}</button></div>
      ${updPrefs.available && html`<h3>${tHtml('updates')}</h3><div class="form upd-form"><div class="frow">${checkField('updAuto', updPrefs.auto !== false, tHtml('updAuto'))}<button class="btn ghost sm" data-act="upd-check">${tHtml('checkNow')}</button></div></div>`}
      <h3>${tHtml('about')}</h3>
      <p class="muted small">zwoTrainer <span id="app-ver"></span> · ${tHtml('mitLicense')} · © 2026 SteffenR</p>
      <p class="about-links small">${ABOUT_LINKS.map(([url, l], i) => html`${i > 0 && html`<span aria-hidden="true"> · </span>`}<a href="#" class="link" data-act="link" data-url="${url}">${tHtml(l)}</a>`)}</p>`;
}

/**
 * Settings: every control saves as soon as it changes (numbers when the field is left and valid).
 * There is no Cancel: Done, ✕, Esc and a click outside all just close. Views redraw once on close.
 * Markup: settings*Tab(); behaviour: bindSettingsFields() (inputs, checkboxes, segmented controls,
 * sync folder) and settingsActions() (buttons).
 */
async function openSettings(tab = 'rider') {
  const s = state.settings;
  const [garmin, targets, svcs] = await Promise.all([invoke('garmin_status').catch(() => ({})), invoke('sync_targets').catch(() => []), refreshServices()]);
  const ctx = { garmin, targets, svcs };
  openModal(html`
    ${dialogHead(html`${tHtml('settings')} <small class="muted">· ${state.name}</small>`)}
    <div class="tabs" id="set-tabs" role="tablist" aria-label="${tText('settings')}">${SETTINGS_TABS.map(([k, l]) => html`<button role="tab" id="tab-${k}" aria-controls="pane-${k}" aria-selected="${String(tab === k)}" tabindex="${tab === k ? 0 : -1}" data-tab="${k}" class="${tab === k ? 'on' : ''}">${tHtml(l)}</button>`)}</div>
    <div class="set-panes">
      ${tabPane('rider', tab, settingsRiderTab(s))}
      ${tabPane('riding', tab, settingsRidingTab(s, shifting()))}
      ${tabPane('sync', tab, settingsSyncTab(s, ctx))}
      ${tabPane('app', tab, settingsAppTab(s))}
    </div>
    <div class="modal-actions set-foot"><span class="set-status muted small" id="set-status" role="status">${tHtml('autoSaved')}</span><button class="btn" data-act="close">${tHtml('done')}</button></div>`, 'small settings');

  // ---- saving: one model for everything
  let statusTimer = null;
  const status = $('#set-status', modal);
  const savedOk = () => mount(status, html`<span class="ok-text">${IC.check} ${tHtml('savedOk')}</span>`);
  const save = async () => {
    settingsDirty = true;
    await api.saveState();
    savedOk();
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (status.textContent = t('autoSaved')), 1800);
  };
  // views (FTP, zones, …) redraw once, when the dialog closes — never while typing
  onModalClose = () => { if (settingsDirty && !ride) route(); settingsDirty = false; };

  $('#set-tabs', modal).onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('#set-tabs [role=tab]', modal).forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; });
    $$('.tab-pane', modal).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    $('.set-panes', modal).scrollTop = 0;
  };
  bindSettingsFields(s, { save, savedOk, svcs, targets });
  window.__TAURI__?.app?.getVersion?.().then((v) => { const el = $('#app-ver', modal); if (el) el.textContent = v; }).catch(() => {});
  bindActions(modal, settingsActions(svcs));
}

/**
 * Settings behaviour for everything that isn't a button: number fields (checked on input once an error
 * shows, saved on change when valid), zone limits (must increase), checkboxes and segmented controls
 * (saved at once), and the profile-sync folder choice.
 */
function bindSettingsFields(s, { save, savedOk, svcs, targets }) {
  const f = (n) => $(`[name=${n}]`, modal);
  const showErr = (id, msg, inputs) => {
    const el = $(`#err-${id}`, modal);
    el.textContent = msg || '';
    el.hidden = !msg;
    inputs.forEach((i) => i.setAttribute('aria-invalid', msg ? 'true' : 'false'));
  };
  const rangeErr = (el, optional = false) => {
    if (el.value === '') return optional ? '' : t('errRange', { min: fmtNum(+el.min), max: fmtNum(+el.max) });
    const v = +el.value;
    return Number.isFinite(v) && v >= +el.min && v <= +el.max ? '' : t('errRange', { min: fmtNum(+el.min), max: fmtNum(+el.max) });
  };
  // number fields → where the valid value goes
  const FIELDS = {
    ftp: { apply: (v) => (s.ftp = Math.round(v)) },
    maxHr: { apply: (v) => (s.maxHr = Math.round(v)) },
    weight: { optional: true, apply: (v) => (s.weight = v === null ? null : Math.round(v * 10) / 10) },
    vsMin: { apply: (v) => (s.shifting = { ...shifting(), minRatio: v }) },
    vsMax: { apply: (v) => (s.shifting = { ...shifting(), maxRatio: v }) },
    vsStart: { apply: (v) => (s.shifting = { ...shifting(), startGear: Math.round(v) }) },
  };
  for (const k of ['s5', 'm1', 'm5', 'm20']) FIELDS[`b_${k}`] = { optional: true, apply: (v) => { const b = { ...(s.bests || {}) }; if (v === null) delete b[k]; else b[k] = Math.round(v); s.bests = b; } };
  const validate = (name) => {
    const el = f(name);
    const msg = rangeErr(el, FIELDS[name].optional);
    showErr(name, msg, [el]);
    return !msg;
  };
  const zoneInputs = [0, 1, 2, 3].map((i) => f(`z${i}`));
  const checkZones = () => {
    const bad = zoneInputs.find((el) => rangeErr(el));
    const z = zoneInputs.map((el) => +el.value);
    const msg = bad ? rangeErr(bad) : z.every((v, i) => i === 0 || v > z[i - 1]) ? '' : t('errZones');
    showErr('zones', msg, zoneInputs);
    return msg ? null : z;
  };
  for (const name of Object.keys(FIELDS)) {
    const el = f(name);
    el.addEventListener('input', () => { if (el.getAttribute('aria-invalid') === 'true') validate(name); });
    el.addEventListener('change', () => { if (!validate(name)) return; FIELDS[name].apply(el.value === '' ? null : +el.value); save(); });
  }
  zoneInputs.forEach((el) => {
    el.addEventListener('input', () => { $('#z5-lim', modal).textContent = zoneInputs[3].value; if (el.getAttribute('aria-invalid') === 'true') checkZones(); });
    el.addEventListener('change', () => { const z = checkZones(); if (z) { s.zones = z; save(); } });
  });

  // checkboxes save at once
  for (const name of ['beeps', 'beepDirection', 'endChime', 'autoPause', 'coachHints', 'keyboardShortcuts']) f(name).onchange = (e) => { s[name] = e.target.checked; save(); };
  // the up/down cue belongs to the countdown beeps
  f('beepDirection').disabled = !s.beeps;
  f('beeps').addEventListener('change', (e) => { f('beepDirection').disabled = !e.target.checked; });
  f('garminAuto').onchange = (e) => { s.garmin = { ...(s.garmin || {}), autoOpen: e.target.checked }; save(); };
  const updAuto = f('updAuto');
  if (updAuto) updAuto.onchange = () => invoke('update_prefs', { auto: updAuto.checked }).then((p) => { updPrefs = p; savedOk(); }).catch((err) => toast(String(err)));

  // segmented controls (radio groups) save at once
  const SEGS = {
    'theme-ctl': (v) => { s.theme = v; applyTheme(); save(); },
    'vs-mode': (v) => { s.shifting = { ...shifting(), mode: v }; $('#vs-mode-hint', modal).textContent = t(`vsHint.${v}`); save(); },
    'vs-diff': (v) => { s.shifting = { ...shifting(), difficulty: v }; save(); },
    'mode-garminMode': (v) => { s.garmin = { ...(s.garmin || {}), mode: v }; save(); },
    // a new language redraws the app and this dialog
    'lang-ctl': async (v) => {
      if (v === uiLang()) return;
      s.language = v;
      await save();
      applyLanguage();
      renderProfileChip();
      if (!ride) route();
      settingsDirty = false;
      toast(t('languageSet', { label: LOCALES.find((x) => x.value === v).nativeLabel }));
      openSettings('app');
    },
  };
  for (const sv of svcs) SEGS[`mode-svc-${sv.id}`] = (v) => { s.services = { ...(s.services || {}), [sv.id]: { ...(s.services?.[sv.id] || {}), mode: v } }; save(); };
  $$('[role=radiogroup].seg-ctl', modal).forEach((ctl) => (ctl.onclick = (e) => {
    const b = e.target.closest('[role=radio]');
    if (!b || b.getAttribute('aria-checked') === 'true') return;
    selectSeg(ctl, b);
    SEGS[ctl.id]?.(b.dataset.v);
  }));

  // profile sync: a known cloud folder, a folder of your choice, or off
  $('#sync-opts', modal).onchange = async (e) => {
    const v = e.target.value;
    let dir = null;
    if (v === 'folder') { dir = await invoke('pick_sync_dir').catch((err) => toast(String(err))); if (!dir) return openSettings('sync'); }
    else if (v !== 'off') dir = targets.find((tg) => tg.provider === v)?.path;
    try {
      syncCfg = await invoke('sync_config', { provider: v, dir, auto: true });
      if (syncOn()) await runSync(false); else toast(t('profileSyncOff'));
    } catch (err) { toast(String(err)); }
    openSettings('sync');
  };
}

/** Settings buttons (data-act). Most reopen Settings on the same tab so it shows the new state. */
function settingsActions(svcs) {
  /** Show a busy label on the button while `fn` runs; restore it afterwards (also on errors). */
  const busy = async (el, label, fn) => {
    const old = el.textContent;
    el.disabled = true; el.textContent = label;
    try { return await fn(); } finally { if (el.isConnected) { el.disabled = false; el.textContent = old; } }
  };
  return {
    // an invalid number isn't saved: show it once instead of closing
    close: () => {
      const bad = $('[aria-invalid=true]', modal);
      if (!bad) return closeModal();
      const pane = bad.closest('.tab-pane');
      if (pane.hidden) $(`#tab-${pane.dataset.pane}`, modal).click();
      const adv = $('details.adv', pane);
      if (adv?.contains(bad)) adv.open = true;
      bad.focus();
    },
    link: (el) => openExternal('open_link', { url: el.dataset.url }),
    devices: () => { closeModal(); devicesMenu($('#btn-devices')); },
    'upd-check': async (el) => { const u = await busy(el, t('checking'), () => checkUpdate(false)); if (u && !ride) closeModal(); },
    dir: async () => { await pickDir(); openSettings('app'); },
    rescan: async (el) => {
      await busy(el, t('rescanning'), loadLibrary);
      settingsDirty = true;
      toast(t('plansFound', { n: library.plans.length }));
    },
    'garmin-dir': async () => {
      const dir = await invoke('pick_garmin_dir').catch((err) => toast(String(err)));
      if (dir) { state = (await api.appState()).profile; openSettings('sync'); }
    },
    'svc-getkey': () => openExternal('open_url', { url: 'https://intervals.icu/settings' }),
    'svc-key': async (el) => {
      const id = el.dataset.id;
      const apiKey = $(`[name=key-${id}]`, modal).value.trim();
      if (!apiKey) return toast(t('pasteKeyFirst'));
      try {
        svcCache = await busy(el, t('checking'), () => invoke('service_connect', { id, apiKey }));
        state.settings.services = { ...(state.settings.services || {}), [id]: { mode: 'auto' } };
        await api.saveState();
        const sv = svcCache.find((x) => x.id === id);
        toast(`${t('nameConnected', { name: sv?.name })}${sv?.account ? ` — ${sv.account}` : ''}`);
        openSettings('sync');
      } catch (err) { toast(String(err)); }
    },
    'svc-off': async (el) => {
      const sv = svcs.find((x) => x.id === el.dataset.id);
      if (await confirmDialog(t('disconnectQ', { name: sv.name }), t('disconnectText'), t('disconnect'), true)) {
        svcCache = await invoke('service_disconnect', { id: sv.id }).catch((err) => { toast(String(err)); return svcCache; });
      }
      openSettings('sync');
    },
    'sync-now': async (el) => { el.disabled = true; await runSync(false); openSettings('sync'); },
    'garmin-on': async (el) => {
      try {
        const st = await busy(el, t('signInWindow'), () => invoke('garmin_connect'));
        state.settings.garmin = { ...(state.settings.garmin || {}), mode: 'auto' };
        await api.saveState();
        toast(`${t('garminLinked')}${st.name ? ` — ${st.name}` : ''}`);
        openSettings('sync');
      } catch (err) { toast(String(err)); }
    },
    'garmin-off': async () => {
      if (await confirmDialog(t('garminSignOutQ'), t('garminSignOutText'), t('signOut'), true)) await invoke('garmin_disconnect').catch((err) => toast(String(err)));
      openSettings('sync');
    },
  };
}

/** Ask Rust for a folder (native dialog); resolves the path or null. */
async function pickDir() {
  const dir = await invoke('pick_zwo_dir').catch((e) => toast(String(e)));
  if (!dir) return;
  state = (await api.appState()).profile;
  await loadLibrary();
  toast(t('plansIn', { n: library.plans.length, dir: dir.split(/[\\/]/).pop() }));
}

/** Controller dialog: scan / connect Zwift Ride, Click, Play and OpenBikeControl devices, and the button tester. */
async function controllerDialog() {
  const connected = await ctrls.list();
  const saved = state.settings.devices?.controllers || [];
  openModal(html`<h2>${tHtml('shifterTitle')}</h2>
    <p class="muted">${tHtml('shifterIntro')}</p>
    ${connected.length > 0 && html`<div class="dev-list">${connected.map((c) => html`<div class="dev on"><span>${c.name}</span><small class="ok-text">${tHtml('connected')}</small></div>`)}</div>
    <div class="btn-test" id="btn-test"><span class="k">${tHtml('buttonTest')}</span><b id="bt-last">${tHtml('pressButton')}</b><small class="muted" id="bt-raw"></small></div>
    <table class="btn-map small">${Object.entries(BUTTON_ACTIONS).filter(([, [a]]) => a).map(([k, [, l]]) => html`<tr data-btn="${k}"><td><kbd>${BUTTON_LABEL[k]}</kbd></td><td>${tHtml(l)}</td></tr>`)}</table>`}
    <div class="dev-list" id="dev-list">${scanningLine(tHtml('searchingCtrl'))}</div>
    <ul class="tips small muted">
      <li>${tHtml('tipRide')}</li>
      <li>${tHtml('tipClick')}</li>
      <li>${tHtml('tipObc')}</li>
      <li>${tHtml('tipCloseZwift')}</li>
    </ul>
    <div class="modal-actions">${connected.length > 0 && html`<button class="btn ghost" data-act="disc">${tHtml('disconnectAll')}</button>`}<button class="btn ghost" data-act="rescan">${tHtml('searchAgain')}</button><button class="btn ghost" data-act="close">${tHtml('close')}</button></div>`, 'small');
  const list = $('#dev-list', modal);
  if (connected.length) {
    // button tester: shows the last button (and the raw message count) while the dialog is open
    let rawCount = 0;
    const onRaw = (e) => { const el = $('#bt-raw', modal); if (el) el.textContent = t('rawMessages', { n: ++rawCount, hex: e.hex.slice(0, 24) }); };
    ctrls.handlers.raw = [onRaw];
    buttonTester = (button, device) => {
      const el = $('#bt-last', modal);
      if (!el?.isConnected) { buttonTester = null; return; }
      el.textContent = `${BUTTON_LABEL[button] || button} · ${device}`;
      $$('.btn-map tr', modal).forEach((r) => r.classList.toggle('hit', r.dataset.btn === button));
    };
  }
  const search = async () => {
    mount(list, scanningLine(tHtml('searchingCtrl')));
    try {
      const found = await ctrls.scan(5);
      if (!list.isConnected) return;
      mount(list, foundDevices(found, (f) => saved.some((x) => x.id === f.id), tHtml('noController')));
    } catch (e) { mount(list, html`<p class="warn-text">${String(e)}</p>`); }
  };
  list.onclick = async (e) => {
    const b = e.target.closest('.dev[data-id]');
    if (!b) return;
    mount(b, html`<span><span class="spinner"></span> ${tHtml('connectingTo', { name: b.dataset.name })}</span>`);
    try {
      const info = await ctrls.connect(b.dataset.id);
      const devs = (state.settings.devices ||= {});
      devs.controllers = [...(devs.controllers || []).filter((c) => c.id !== b.dataset.id), { id: b.dataset.id, name: info.name }];
      await api.saveState();
      toast(t('ctrlConnected', { name: info.name }));
      controllerDialog();
    } catch (err) { mount(b, html`<span class="warn-text">${tHtml('failedE', { e: String(err) })}</span>`); }
  };
  bindActions(modal, {
    rescan: search,
    disc: async () => {
      await ctrls.disconnect();
      if (state.settings.devices) state.settings.devices.controllers = [];
      await api.saveState();
      closeModal();
    },
  });
  search();
}

/** "Searching …" line with a spinner, shown in a device list while scanning or connecting. */
const scanningLine = (text) => html`<div class="scanning"><span class="spinner"></span>${text}</div>`;

/** Scan results as buttons (name, "last used", signal strength), or `empty` when nothing was found. */
const foundDevices = (found, lastUsed, empty) => (found.length
  ? html`${found.map((f) => html`<button class="dev" data-id="${f.id}" data-name="${f.name}"><span>${f.name}${lastUsed(f) && html` <small class="muted">· ${tHtml('lastUsed')}</small>`}</span><small class="muted">${f.rssi != null && `${f.rssi} dBm`}</small></button>`)}`
  : html`<p class="muted">${empty}</p>`);

/** Trainer or heart-rate dialog: the connected device (disconnect / forget), or scan, pick one, or use the simulator. */
function deviceDialog(kind) {
  if (kind === 'controller') return controllerDialog();
  const dev = kind === 'trainer' ? trainer : hrm;
  const label = tHtml(kind === 'trainer' ? 'devTrainer' : 'hrMonitor');
  const saved = state.settings.devices?.[kind];
  // every button closes the dialog first, then acts
  const leave = (fn) => async () => { closeModal(); await fn(); };
  const common = {
    disc: leave(() => dev.disconnect()),
    sim: leave(() => dev.startSim()),
    forget: leave(async () => {
      await dev.disconnect();
      if (state.settings.devices) delete state.settings.devices[kind];
      await api.saveState();
    }),
  };
  if (dev.connected || dev.reconnecting) {
    const erg = kind === 'trainer' && dev.connected && html` · ${tHtml(trainer.canErg ? (trainer.ergDenied ? 'ergActiveDenied' : 'ergActive') : 'powerOnlyNoErg')}`;
    openModal(html`<h2>${label}</h2><p>${tHtml(dev.reconnecting ? 'reconnectingTo' : 'connectedTo', { name: html`<b>${dev.name}</b>` })}${erg}.</p>
      <div class="modal-actions"><button class="btn ghost" data-act="forget">${tHtml('forgetDevice')}</button><button class="btn ghost" data-act="close">${tHtml('close')}</button><button class="btn danger" data-act="disc">${tHtml('disconnect')}</button></div>`, 'small');
    bindActions(modal, common);
    return;
  }
  openModal(html`<h2>${label}</h2>
    <p class="muted">${tHtml(kind === 'trainer' ? 'trainerIntro' : 'hrIntro')}</p>
    <div class="dev-list" id="dev-list">${scanningLine(tHtml('searching'))}</div>
    <div class="modal-actions"><button class="btn ghost" data-act="sim">${tHtml('useSimulator')}</button><button class="btn ghost" data-act="rescan">${tHtml('searchAgain')}</button><button class="btn ghost" data-act="close">${tHtml('close')}</button></div>`, 'small');
  const list = $('#dev-list', modal);
  const search = async () => {
    mount(list, scanningLine(tHtml('searching')));
    try {
      const found = await dev.scan(4);
      if (!modal.open || !list.isConnected) return;
      mount(list, foundDevices(found, (f) => saved?.id === f.id, tHtml('nothingFound')));
    } catch (e) {
      mount(list, html`<p class="warn-text">${String(e)}</p><p class="muted small">${raw(PLAT.bt)}</p>`);
    }
  };
  list.onclick = async (e) => {
    const b = e.target.closest('.dev');
    if (!b) return;
    mount(list, scanningLine(tHtml('connectingTo', { name: b.dataset.name })));
    try {
      const info = await dev.connect(b.dataset.id);
      state.settings.devices = { ...(state.settings.devices || {}), [kind]: { id: b.dataset.id, name: info.name } };
      await api.saveState();
      closeModal();
      if (kind === 'trainer' && info.ergDenied) toast(t('ergDenied'));
      else toast(`${t('nameConnected', { name: info.name })}${kind === 'trainer' ? ` · ${info.erg ? t('ergReady') : t('powerOnly')}` : ''}`);
    } catch (err) {
      mount(list, html`<p class="warn-text">${tHtml('connectionFailed', { e: String(err) })}</p>`);
    }
  };
  bindActions(modal, { ...common, rescan: search });
  search();
}

// ------------------------------------------------------------------ other platforms (Intervals.icu automatic, COROS manual import)
let svcCache = [];
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

// ------------------------------------------------------------------ ride
let ride = null;

/** Load a workout (and test preparation if it is an FTP test) and open the ride screen. */
async function startRide(file, planId) {
  const { workout } = await api.workout(file);
  if (!workout.segments.length) return toast(t('noSegments'));
  const info = workoutInfo(file);
  if (info && isTestWorkout(info)) {
    const kind = classifyTest(info.profile, info.title);
    if (kind.kind === 'broken-ramp') {
      const p = protocolById(kind.lite ? 'ramp-lite' : 'ramp');
      if (!await confirmDialog(t('builtinRampQ'), `${t('builtinRampText', { title: info.title, name: p.name })}${planId ? ` ${t('countsForPlan')}` : ''}`, t('startName', { name: p.name }))) return;
      ride = new Ride(p.build(ftp()), file, planId, { protocol: p });
      return;
    }
    ride = new Ride(prepareTestWorkout(workout), file, planId, { generic: true });
    return;
  }
  ride = new Ride(workout, file, planId);
}

/** Plausibility note for a test result that differs a lot (> 15 %) from the current FTP. */
function ftpCheck(next, cur, source) {
  if (!next || !cur) return html``;
  const d = (next - cur) / cur;
  if (Math.abs(d) <= 0.15) return html``;
  const pct = `${Math.round(Math.abs(d) * 100)} %`;
  const src = source ? tHtml('ftpSrcFrom', { name: html`<b>${source}</b>` }) : tHtml('ftpSrcRight');
  return html`<p class="ftp-check">${tHtml(d > 0 ? 'ftpHigh' : 'ftpLow', { pct, src })}</p>`;
}

const SEG_KIND = { steady: 'kindSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'kindOn', off: 'kindOff', freeride: 'freeRide', maxeffort: 'maxEffort' };
/** Short label for the current segment type (warm-up, interval, ramp, free ride, all-out …). */
const segKind = (s) => `${t(s.erg === false ? 'kindAllOut' : SEG_KIND[s.type] || 'segment')}${s.reps ? ` ${s.rep}/${s.reps}` : ''}`;
/** Fill a metric bar: frac 0…1, optional target marker (0…1) and colour. */
/** Count a number up (or down) to its final value once, ~0.8 s ease-out; the end text is exact. */
function countUp(el, from, to, fmt, delay = 0) {
  if (from === to) return;
  el.textContent = fmt(from);
  setTimeout(() => {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 800), e = 1 - (1 - k) ** 3;
      el.textContent = fmt(k < 1 ? Math.round(from + (to - from) * e) : to);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, delay);
}

/** Restart a CSS animation class (removes the given classes first). */
function restartAnim(el, cls, all = [cls]) {
  if (!el) return;
  el.classList.remove(...all);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Fill a small metric bar (0–1) and optionally mark a target band. */
function setBar(el, frac, { mark = null, color = null, band = null } = {}) {
  if (!el) return;
  const f = el.querySelector('.fill');
  f.style.width = `${Math.max(0, Math.min(1, frac || 0)) * 100}%`;
  f.style.background = color || '';
  const m = el.querySelector('.mark');
  if (m) { m.hidden = mark == null; if (mark != null) m.style.left = `${Math.max(0, Math.min(1, mark)) * 100}%`; }
  const b = el.querySelector('.band');
  if (b) { b.hidden = !band; if (band) { b.style.left = `${band[0] * 100}%`; b.style.width = `${Math.max(0.01, band[1] - band[0]) * 100}%`; } }
}

const OVERLAY = [['power', 'colPower'], ['cadence', 'cadence'], ['hr', 'devHr']];

// ------------------------------------------------------------------ ride summary pieces (Ride.showSummary)

/** Test detail rows (label, value) as a definition list body. */
const detailRows = (details) => details.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`);

/**
 * FTP test block: the new FTP with apply / keep, or why there is none (effort not completed, only power
 * bests, not enough data). Only for test rides.
 */
function summaryTest(r) {
  const cur = ftp();
  if (r?.ftp) {
    const vo2 = r.vo2est ? html`<dt>${tHtml('vo2Estimate')}</dt><dd>${r.vo2est.rel} ml/kg/min · ${r.vo2est.abs} L/min <small class="muted">${r.vo2est.method}</small></dd>`
      : r.vo2 && !weight() ? html`<dt>VO2max</dt><dd class="muted">${tHtml('addWeightSettings')}</dd>` : null;
    return html`
        <div class="ftp-result">
          <div><span class="k">${tHtml('yourFtpIs')}</span><b>${r.ftp} W</b><small class="${r.ftp >= cur ? 'up' : 'down'}">${tHtml('vsCurrent', { diff: `${r.ftp >= cur ? '+' : ''}${r.ftp - cur}`, cur })}</small></div>
          <dl>${detailRows(r.details)}
            ${wkg(r.ftp) && html`<dt>${tHtml('ftpPerKg')}</dt><dd>${wkg(r.ftp)} W/kg</dd>`}
            ${vo2}</dl>
          ${ftpCheck(r.ftp, cur, trainer.connected ? trainer.name : null)}
          <div class="ftp-actions"><button class="btn primary" data-act="apply">${tHtml('useAsFtp', { w: r.ftp })}</button><button class="btn ghost" data-act="keep">${tHtml('keepW', { w: cur })}</button></div>
        </div>`;
  }
  if (r?.incomplete) {
    return html`<div class="ftp-result incomplete">
          <div><span class="k">${tHtml('effortNotCompleted')}</span></div>
          <p>${r.incomplete.text} ${tHtml('incompleteStays', { w: cur })}${Object.keys(r.bests || {}).length > 0 && html` ${tHtml('bestsSaved')}`}</p>
          <dl>${detailRows(r.details)}</dl>
          <p class="muted small">${tHtml('repeatFresh')}</p>
        </div>`;
  }
  if (r?.details) {
    return html`<div class="ftp-result"><div><span class="k">${tHtml('powerBestsSaved')}</span></div><dl>${detailRows(r.details)}${r.vo2est && html`<dt>${tHtml('vo2Estimate')}</dt><dd>${r.vo2est.rel} ml/kg/min</dd>`}</dl></div>`;
  }
  return html`<p class="warn-text">${tHtml('notEnoughData')} — ${tHtml('powerSourceQ')}.</p>`;
}

/** The six ride numbers (time, average power, NP, HR, cadence, energy); '–' when not recorded. */
function summaryStats(st, ridden) {
  const cell = (k, v) => html`<div><span class="k">${k}</span><b>${v ?? '–'}</b></div>`;
  return html`<div class="stats">
          ${cell(tHtml('stTime'), fmtTime(ridden))}${cell(tHtml('stAvgPower'), st.avgPower && `${st.avgPower} W`)}${cell('NP', st.np && `${st.np} W`)}
          ${cell(tHtml('stAvgHr'), st.avgHr && `${st.avgHr} bpm`)}${cell(tHtml('stCadence'), st.avgCadence && `${st.avgCadence} rpm`)}${cell(tHtml('stEnergy'), st.kj && `${st.kj} kJ`)}
        </div>`;
}

/** Rides shorter than this (seconds) are not uploaded automatically; the summary asks first (#37). */
const SHORT_RIDE_S = 15 * 60;

/**
 * Short ride with automatic uploads pending: "Short ride (8:42). Upload to Garmin Connect?" with
 * Upload / Don't upload. Until answered, the destinations show their manual buttons.
 */
const summaryShortRide = (seconds, names) => html`<div class="short-ride" role="group" aria-labelledby="short-ride-q">
          <p id="short-ride-q">${tHtml('shortRideQ', { time: fmtTime(seconds), names: names.join(', ') })}</p>
          <button class="btn ghost sm" data-act="short-skip">${tHtml('dontUpload')}</button><button class="btn primary sm" data-act="short-up">${tHtml('upload')}</button>
        </div>`;

/**
 * Where the ride goes: Garmin (automatic, upload, or manual import), other platforms, the FIT file.
 * `hold`: automatic uploads wait for the short-ride question, so their rows show the manual buttons.
 */
function summarySyncList({ garmin, autoGarmin, rideSvcs, hold = false }) {
  const garminState = autoGarmin && !hold ? html`<span class="spinner"></span> ${tHtml('uploading')}`
    : garmin.connected && syncMode('garmin') !== 'off' ? html`<button class="btn ghost sm" data-act="garmin-up">${tHtml('upload')}</button>`
      : html`<button class="btn ghost sm" data-act="garmin">${tHtml('importDots')}</button>`;
  const svcRow = (sv) => {
    const auto = sv.connected && svcMode(sv) === 'auto' && !hold;
    const act = auto ? html`<span class="spinner"></span> ${tHtml('uploading')}`
      : sv.connected ? html`<button class="btn ghost sm" data-act="svc-up" data-id="${sv.id}">${tHtml('upload')}</button>`
        : html`<button class="btn ghost sm" data-act="svc-man" data-id="${sv.id}">${tHtml('importDots')}</button>`;
    return html`<div class="sl-row"><span class="svc-logo ext sm">${SVC_LOGO[sv.id]}</span><span class="sl-name">${sv.name}</span><span class="sl-state" id="svc-${sv.id}">${act}</span></div>`;
  };
  return html`<div class="sync-list">
          <div class="sl-row"><span class="svc-logo garmin sm">G</span><span class="sl-name">Garmin Connect</span><span class="sl-state" id="garmin-state">${garminState}</span></div>
          ${rideSvcs.map(svcRow)}
          <div class="sl-row sl-file"><span class="sl-name muted">${tHtml('rideFile')}</span><span class="sl-state"><button class="btn ghost sm" data-act="fit">${tHtml('saveFit')}</button></span></div>
        </div>`;
}

/** Plan rides: the next workout of the plan, or "that was the last one". */
function summaryNext(plan, next) {
  if (!next) return html`<p class="done-msg">${tHtml('lastWorkoutDone')}</p>`;
  return html`<div class="next-card"><div class="eyebrow">${tHtml('upNextIn', { name: plan.name })} ${weekDay(next)}</div><h3>${next.title}</h3><div class="meta">${fmtDur(next.duration)} · TSS ~${next.tss}</div>${raw(miniProfile(next.profile, bounds(), { width: 420, height: 48 }))}</div>`;
}

class Ride {
  /** A ride: owns the clock, the target power, recording, auto-pause, controller input and the ride screen.
   * Lives from startRide() until close(); while it exists nothing else may re-render or block (see AGENTS.md). */
  constructor(workout, file, planId, test = null) {
    this.test = test;
    this.lowCount = 0;
    this.w = workout;
    const sh = shifting();
    this.gears = gearTable(sh);
    this.gear = Math.min(this.gears.length - 1, Math.max(0, (sh.startGear || 16) - 1));
    this.hasFree = workout.segments.some((x) => x.p0 === null || x.erg === false);
    this.vs = { on: sh.mode === 'virtual', difficulty: sh.difficulty || 'medium', watts: null, sentAt: 0 };
    this.file = file;
    this.planId = planId;
    this.info = workoutInfo(file);
    this.t = 0;
    this.running = false;
    this.started = false;
    this.intensity = 100;
    this.samples = [];
    this.lastSec = -1;
    this.segIdx = -1;
    this.showPct = false;
    this.startedAt = null;
    this.ridden = 0;
    this.beeped = new Set();
    loadSounds(['up', 'down', 'done']);
    this.autoStartCount = 0;
    this.compact = new CompactView({
      resize: (compact) => invoke('ride_window', { compact }),
      apply: (compact) => {
        document.body.classList.toggle('compact-riding', compact);
        if (!compact) this.diagram.update(this.t, this.samples);
      },
      report: (error) => toast(String(error)),
    });
    this.build();
    this.wake();
    this.loop = setInterval(() => this.tick(), 250);
    this.last = performance.now();
    this.render(true);
  }

  /** Render the ride screen once (panels, chart, controls, compact view). Never called again on resize: compact mode only toggles CSS. */
  build() {
    const r = $('#ride');
    r.hidden = false;
    document.body.classList.add('riding');
    const plan = this.planId && planById(this.planId);
    const ov = state.settings.overlay || { power: true };
    // compact view: play/stop and "workout left" appear twice (heading row when short, footer otherwise)
    const cmpCtl = html`<span class="compact-ctl"><button class="ctl play" data-act="play" title="${tText('btnPlay')}" aria-label="${tText('btnPlay')}"><svg viewBox="0 0 24 24" class="i-play" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" class="i-pause" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button><button class="ctl" data-act="stop" title="${tText('endWorkout')}" aria-label="${tText('endWorkout')}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button></span>`;
    const cmpWl = html`<span class="cmp-wl"><small>${tHtml('compactWorkoutLeft')}</small><b class="cmp-wleft">0:00</b></span>`;
    // the ride title lives in the regular top bar (in place of the mode switch)
    const rt = $('#ride-title');
    mount(rt, html`${this.test && badge(tHtml('ftpTest'), 'test')}${plan ? badge(html`${plan.name}${this.info?.week && html` · ${tHtml('weekDayCompact', { w: this.info.week, d: this.info.day })}`}`) : !this.test && badge(tHtml('workout'), 'muted')}
      <h1 title="${this.info?.title || this.w.name}">${this.info?.title || this.w.name}</h1><span class="erg" id="erg-state"></span>`);
    rt.hidden = false;
    $('#btn-compact').hidden = false;
    mount(r, html`
      <div class="ride-top">
        <section class="panel live">
          <header class="ph"><span class="ph-dot" id="live-dot"></span><b>${tHtml('live')}</b>${IC.pulse}<span class="ph-status" id="live-status"></span></header>
          <div class="live-body">
            <button class="gauge" id="gauge" title="${tText('gaugeTitle')}">
              <div class="gauge-mount"></div>
              <div class="gauge-center"><span class="k" id="g-unit">${tHtml('watt')}</span><b id="v-pow">–</b><small id="t-pow">–</small></div>
            </button>
            <div class="metrics">
              <div class="metric">${IC.bolt}<div class="m-txt"><span class="k">${tHtml('colPower')}</span><span class="m-val"><b id="m-pow">–</b><small>W</small></span><div class="mbar" id="b-pow"><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.cad}<div class="m-txt"><span class="k">${tHtml('cadence')}</span><span class="m-val"><b id="v-cad">–</b><em id="t-cad"></em><small>rpm</small></span><div class="mbar" id="b-cad"><i class="band"></i><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.speed}<div class="m-txt"><span class="k">${tHtml('speed')}</span><span class="m-val"><b id="v-spd">–</b><small>km/h</small></span><div class="mbar" id="b-spd"><i class="fill"></i></div></div></div>
              <div class="metric">${IC.heart}<div class="m-txt"><span class="k">${tHtml('devHr')}</span><span class="m-val"><b id="v-hr">–</b><small>bpm</small><em id="t-hr"></em></span><div class="mbar" id="b-hr"><i class="fill"></i></div></div></div>
            </div>
          </div>
        </section>
        <section class="panel seg">
          <header class="ph">${IC.target}<b>${tHtml('currentSegment')}</b><span class="ph-status" id="seg-kind"></span></header>
          <div class="seg-body">
            <div class="seg-left">
              <div class="seg-ring">
                <div class="ring-mount"></div>
                <div class="ring-center">
                  <b id="s-target">–</b>
                  <small id="s-watts"></small>
                </div>
                <svg class="ring-check" viewBox="0 0 100 100" aria-hidden="true"><path d="M27 52 L44 68 L74 34"/></svg>
              </div>
              <div class="gearbox" id="gearbox" hidden><button class="btn round sm" data-shift="-1" title="${tText('shiftDownKey')}">−</button><span id="gear-lbl" class="gear-lbl">${tHtml('gear')}</span><button class="btn round sm" data-shift="1" title="${tText('shiftUpKey')}">+</button></div>
            </div>
            <div class="seg-stats">
              <div class="stat">${IC.bolt}<div><span class="k" id="s-tw-k">${tHtml('targetPower')}</span><b id="s-tw">–</b></div></div>
              <div class="stat cad">${IC.cad}<div><span class="k">${tHtml('targetCadence')}</span><b id="s-cad">–</b></div></div>
              <div class="stat">${IC.watch}<div><span class="k">${tHtml('segment')}</span><b id="s-dur">0:00</b><div class="sbar"><i id="s-bar"></i></div></div></div>
              <div class="stat rem">${IC.flag}<div><span class="k">${tHtml('remaining')}</span><b id="s-rem">0:00</b></div></div>
            </div>
          </div>
          <div class="coach-line" id="coach" role="status" aria-live="polite"></div>
        </section>
        <section class="panel next">
          <header class="ph">${IC.layers}<b>${tHtml('btnNext')}</b></header>
          <div class="nx-card" id="next-card"></div>
        </section>
      </div>
      <div class="ride-diagram panel">
        <div class="dg-times">
          <div class="wt-head"><span class="ph-mini">${IC.bars}<b>${tHtml('workout')}</b></span><div class="wt-time"><span class="k">${tHtml('elapsed')}</span><b id="d-el">0:00</b></div></div>
          <span class="overlay-toggles" id="ov">${OVERLAY.map(([k, l]) => html`<button data-ov="${k}" class="ov ov-${k} ${ov[k] ? 'on' : ''}"><i></i>${tHtml(l)}</button>`)}</span>
          <div class="wt-time rem"><span class="k">${tHtml('remainingLc')}</span><b id="d-rem">${fmtTime(this.w.duration)}</b><small id="d-tot">${tHtml('ofTime', { time: fmtTime(this.w.duration) })}</small></div>
        </div>
        <div class="dg-mount"></div>
        <div class="dg-tip" id="dg-tip" hidden></div>
      </div>
      <div class="ride-controls" data-msg="${tText('autoPaused')}">
        <button class="ctl" data-act="prev" title="${tText('btnPrev')} (←)"><svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-9 7 9 7z"/></svg></button>
        <button class="ctl" data-act="back" title="${tText('back1min')}"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg></button>
        <button class="ctl play" data-act="play" title="${tText('btnPlay')} (${tText('spaceKey')})" id="btn-play"><svg viewBox="0 0 24 24" class="i-play"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" class="i-pause"><path d="M8 5v14M16 5v14"/></svg></button>
        <button class="ctl" data-act="stop" title="${tText('endWorkout')}"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
        <button class="ctl" data-act="fwd" title="${tText('fwd1min')}"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/></svg></button>
        <button class="ctl" data-act="next" title="${tText('btnNext')} (→)"><svg viewBox="0 0 24 24"><path d="M18 5v14M5 5l9 7-9 7z"/></svg></button>
        <div class="int-group" title="${tText('intensityTitle')}">
          <div class="int-read"><span class="k">${tHtml('intensity')}</span><b id="int-val" class="int-val">100%</b></div>
          <button class="ctl int-b" data-int="-1" title="${tText('intDownTitle')}" aria-label="${tText('btnIntDown')}">−</button>
          <button class="ctl int-b" data-int="1" title="${tText('intUpTitle')}" aria-label="${tText('btnIntUp')}">+</button>
        </div>
      </div>
      <section class="compact-ride" aria-label="${tText('compactView')}">
        <header class="compact-head" data-tauri-drag-region>
          <span class="compact-name" data-tauri-drag-region title="${this.info?.title || this.w.name}">${this.info?.title || this.w.name}</span>
          <span class="compact-state" id="cmp-state"><i id="cmp-dot"></i><span id="cmp-status" role="status"></span></span>
          <div class="compact-gears" id="cmp-gears" hidden><button class="icon-btn" data-shift="-1" title="${tText('shiftDownKey')}" aria-label="${tText('shiftDownKey')}">−</button><span id="cmp-gear"></span><button class="icon-btn" data-shift="1" title="${tText('shiftUpKey')}" aria-label="${tText('shiftUpKey')}">+</button></div>
          <span class="compact-short">${cmpWl}${cmpCtl}</span>
          <button class="icon-btn" data-act="expand" title="${tText('expandView')}" aria-label="${tText('expandView')}">${IC.expand}</button>
        </header>
        <div class="compact-main">
          <section class="cp cp-live">
            <div class="cp-ph"><i></i>${tHtml('live')}</div>
            <div class="cp-body">
              <div class="cp-cell"><div class="cp-dial"><div class="cp-mount" id="cmp-gauge"></div><div class="cp-center"><b id="cmp-pow">–</b><small id="cmp-pow-sub"></small></div></div></div>
              <div class="cp-meta cp-opt"><span><small>${tHtml('devHr')}</small><b id="cmp-hr">–</b></span><span><small>${tHtml('cadence')}</small><b id="cmp-cad">–</b></span></div>
            </div>
          </section>
          <section class="cp cp-cur">
            <div class="cp-ph"><i></i>${tHtml('compactCurrent')}</div>
            <div class="cp-body">
              <div class="cp-cell"><div class="cp-dial"><div class="cp-mount" id="cmp-ring"></div><div class="cp-center"><b id="cmp-seg">0:00</b><small id="cmp-seg-sub"></small></div></div></div>
              <div class="cp-info cp-opt"><b id="cmp-tgt">–</b><div class="cp-bar"><i id="cmp-bar"></i></div></div>
            </div>
          </section>
          <section class="cp cp-next">
            <div class="cp-ph"><i></i>${tHtml('compactNext')}</div>
            <div class="cp-body"><div class="cp-nx" id="cmp-next"></div></div>
          </section>
        </div>
        <div class="compact-foot">${cmpCtl}${cmpWl}</div>
      </section>
      <div class="ready" id="ready"><div><b>${tHtml('ready')}</b><span>${tHtml('readyText')}${trainer.connected && html` ${tHtml('readyPedal')}`}.</span></div>
        ${this.hasFree && html`<div class="vs-ask"><span class="k" id="vs-choice-l">${tHtml('freeRideSegments')}</span>${segCtl('vs-choice', [['gears', 'realGears'], ['easy', 'vgEasy'], ['medium', 'diff.medium'], ['hard', 'diff.hard']].map(([k, l]) => [k, tHtml(l)]), this.vs.on ? this.vs.difficulty : 'gears', { labelledBy: 'vs-choice-l' })}</div>`}</div>`);

    this.gauge = new Gauge($('.gauge-mount', r));
    this.ring = new ProgressRing($('.ring-mount', r));
    this.cGauge = new Gauge($('#cmp-gauge', r));
    this.cRing = new ProgressRing($('#cmp-ring', r));
    const cmpEl = $('.compact-ride', r);
    const fitCompact = () => {
      const m = compactMode(cmpEl.clientWidth, cmpEl.clientHeight);
      cmpEl.dataset.mode = m.mode;
      for (const k of ['short', 'tiny', 'narrow', 'xs']) cmpEl.dataset[k] = m[k] ? '1' : '0';
    };
    this.cObs = new ResizeObserver(fitCompact);
    this.cObs.observe(cmpEl);
    fitCompact();
    this.diagram = new Diagram($('.dg-mount', r), this.w, {
      bounds: bounds(), ftp: ftp(), maxHr: maxHr(), overlay: ov,
      onSelect: (i, s) => {
        const tip = $('#dg-tip');
        mount(tip, html`${segmentText(s)} <button class="btn ghost sm" data-act="goto" data-i="${i}">${tHtml('jumpHere')}</button>`);
        tip.hidden = false;
        clearTimeout(this.tipTimer);
        this.tipTimer = setTimeout(() => (tip.hidden = true), 6000);
      },
    });
    // arrow keys move inside the free-ride choice and must not also skip segments (ride shortcuts)
    const vsc = $('#vs-choice', r);
    if (vsc) vsc.onkeydown = (e) => { rovingKey(e); if (e.defaultPrevented) e.stopPropagation(); };
    r.onclick = (e) => {
      if (this.ending) return;
      const menu = e.target.closest('[data-act="menu"]');
      if (menu) return openMenu(menu);
      const vsb = e.target.closest('#vs-choice [data-v]');
      if (vsb) return this.chooseShifting(vsb.dataset.v);
      const sb = e.target.closest('[data-shift]');
      if (sb) return this.shift(+sb.dataset.shift);
      const o = e.target.closest('[data-ov]');
      if (o) return this.toggleOverlay(o.dataset.ov, o);
      const c = e.target.closest('[data-act]');
      if (c) return this.control(c.dataset.act, c);
      const i = e.target.closest('[data-int]');
      if (i) return this.adjust(+i.dataset.int * (e.shiftKey ? 10 : 1));
      if (e.target.closest('#gauge')) { this.showPct = !this.showPct; this.render(true); }
    };
    this.onDeviceStatus();
  }

  /** Show or hide one live trace (power, cadence, HR) on the chart; remembered in settings.overlay. */
  toggleOverlay(k, btn) {
    const ov = { ...(state.settings.overlay || {}) };
    ov[k] = !ov[k];
    state.settings.overlay = ov;
    btn.classList.toggle('on', ov[k]);
    this.diagram.setOverlay(ov);
    this.diagram.update(this.t, this.samples);
    api.saveState();
  }

  /** Free-ride segments: real gears (trainer free ride) or virtual gears at a difficulty; saved as the rider's default. */
  chooseShifting(v) {
    this.vs.on = v !== 'gears';
    if (this.vs.on) this.vs.difficulty = v;
    state.settings.shifting = { ...shifting(), mode: this.vs.on ? 'virtual' : 'gears', difficulty: this.vs.on ? v : shifting().difficulty };
    api.saveState();
    const ctl = $('#vs-choice');
    if (ctl) selectSeg(ctl, $(`[data-v="${v}"]`, ctl));
    this.render(true);
  }

  get freeLike() {
    const s = this.w.segments[this.segIdx];
    return !!s && (s.p0 === null || s.erg === false);
  }

  /** Controller button actions (see BUTTON_ACTIONS). */
  button(a) {
    if (this.ending) return; // the ride is being saved: no second finish, no new ERG target
    switch (a) {
      case 'gear+': case 'gear-': {
        const d = a === 'gear+' ? 1 : -1;
        if (this.freeLike) { this.shift(d); return this.hint(t('gearN', { n: this.gear + 1 })); }
        this.adjust(d); return this.hint(t('intensityPct', { n: this.intensity }));
      }
      case 'int+': this.adjust(1); return this.hint(t('intensityPct', { n: this.intensity }));
      case 'int-': this.adjust(-1); return this.hint(t('intensityPct', { n: this.intensity }));
      case 'next': if (this.control('next') !== false) this.hint(`${t('btnNext')} ⏭`); return;
      case 'prev': if (this.control('prev') !== false) this.hint(`⏮ ${t('btnPrev')}`); return;
      case 'play': this.toggle(); return this.hint(this.running ? `▶ ${t('running')}` : `⏸ ${t('paused')}`);
      case 'pct': this.showPct = !this.showPct; this.render(true); return this.hint(this.showPct ? '% FTP' : t('watts'));
    }
  }

  /** Brief centred hint over the ride screen (controller / key actions). */
  hint(text) {
    let el = $('#ride-hint');
    if (!el) { el = document.createElement('div'); el.id = 'ride-hint'; el.className = 'ride-hint'; $('#ride').append(el); }
    el.textContent = text;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  /** Virtual gear up/down (controller or +/−); a shift in a free segment switches virtual gears on. */
  shift(dir) {
    const n = Math.max(0, Math.min(this.gears.length - 1, this.gear + dir));
    if (n === this.gear) return;
    this.gear = n;
    if (this.freeLike && !this.vs.on) { this.vs.on = true; } // shifting implies virtual gears
    const lbl = $('#gear-lbl');
    lbl?.classList.remove('flash'); void lbl?.offsetWidth; lbl?.classList.add('flash');
    this.render(true);
  }

  /** Update the LIVE panel's connection state (dot and label) when a device connects or drops out. */
  onDeviceStatus() {
    const st = $('#live-status'), dot = $('#live-dot');
    if (st) {
      const on = trainer.connected;
      mount(st, on ? html`${IC.plug}${tHtml(trainer.mode === 'sim' ? 'simulator' : 'connectedCap')}` : tHtml('noTrainer'));
      st.className = `ph-status ${on ? 'ok' : ''}`;
      dot.className = `ph-dot ${on ? 'on' : ''}`;
    }
    const e = $('#erg-state');
    if (!e) return;
    if (!trainer.connected) { e.textContent = t('noTrainerTimer'); e.className = 'erg off'; }
    else if (trainer.canErg) { e.textContent = 'ERG'; e.className = 'erg on'; }
    else { e.textContent = t('powerOnlyCap'); e.className = 'erg'; }
  }

  async wake() {
    invoke('keep_awake', { on: true }).catch(() => {});
    // Windows (WebView2) has no helper process for this — use the Screen Wake Lock API
    if (OS === 'win' && navigator.wakeLock && !this.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
  }

  mult() { return this.intensity / 100; }

  /** Intensity ± in % (controller, keys, buttons); scales every target until the end of the ride. */
  adjust(d) {
    const old = this.intensity;
    this.intensity = Math.max(50, Math.min(150, this.intensity + d));
    this.render(true);
    if (this.intensity !== old && motionOK()) restartAnim($('#int-val'), this.intensity > old ? 'roll-up' : 'roll-down', ['roll-up', 'roll-down']);
  }

  /** Seek with test rules: no skipping inside a measured effort (ramp or all-out), and a jump never
   *  lands in the middle of one — forward snaps to its start, backward to its end — so efforts are
   *  always ridden in one piece and never counted twice. Returns false when blocked. */
  go(to) {
    if (!this.test) return this.seek(to);
    const segs = this.w.segments;
    if (segs[this.segIdx]?.measure && !this.cooling) { this.hint(t('noSkipTest')); return false; }
    const k = segmentAt(segs, Math.max(0, Math.min(to, this.w.duration - 0.01)));
    const s = segs[k];
    if (s?.measure && to > s.start) {
      let a = k, b = k;
      while (a > 0 && segs[a - 1].measure === s.measure) a--;
      while (b < segs.length - 1 && segs[b + 1].measure === s.measure) b++;
      to = to >= this.t ? segs[a].start : segs[b].start + segs[b].duration;
    }
    return this.seek(to);
  }

  /** Jump to a time in the workout. Callers go through go(), which applies the FTP-test rules (no skipping inside a measured effort). */
  seek(to) {
    this.t = Math.max(0, Math.min(this.w.duration - 0.01, to));
    this.lastSec = Math.floor(this.t) - 1; // record from where the jump lands, never the skipped seconds
    this.beeped.clear();
    this.render(true);
  }

  /** Ride controls (buttons, keys, controllers): play/pause, previous/next segment, ±1 min, stop. */
  control(c, elm) {
    const seg = this.w.segments[this.segIdx];
    switch (c) {
      case 'play': return this.toggle();
      case 'expand': return this.compact.set(false);
      case 'stop': return this.stop();
      case 'back': return this.go(this.t - 60);
      case 'fwd': return this.go(this.t + 60);
      case 'prev': {
        const inSeg = this.t - seg.start;
        const target = inSeg > 3 || this.segIdx === 0 ? seg.start : this.w.segments[this.segIdx - 1].start;
        return this.go(target);
      }
      case 'next': {
        const n = this.w.segments[this.segIdx + 1];
        if (this.test && seg?.measure && !this.cooling) return this.go(this.t + 1); // blocked → hint
        return n ? this.go(n.start) : this.finish(true);
      }
      case 'goto': $('#dg-tip').hidden = true; return this.go(this.w.segments[+elm.dataset.i].start);
    }
  }

  /** Start, pause or resume. auto = true when auto-pause triggered it (resumes by pedalling). */
  toggle(auto = false) {
    if (this.ending) return;
    if (!this.started) { this.started = true; this.startedAt = new Date(); $('#ready')?.remove(); }
    this.running = !this.running;
    this.autoPaused = !this.running && auto;
    this.idleFor = 0; this.pedalFor = 0;
    if (this.running) trainer.resume();
    $('#ride').classList.toggle('paused', !this.running);
    $('#ride').classList.toggle('auto-paused', this.autoPaused);
    this.render(true);
  }

  /** Autopause: pause after a few seconds without power, resume as soon as the rider pedals again. */
  autoPause(realDt) {
    if (state.settings.autoPause === false || !this.started || !trainer.connected) return;
    const p = fresh('power'), c = fresh('cadence');
    const pedalling = (p != null && p > 15) || (c != null && c > 15);
    if (this.running) {
      const cs = this.w.segments[this.segIdx];
      // ramp tests end by themselves, and in a measured test effort a stop must count as 0 W —
      // pausing would leave the rest out and make the effort average too high
      if (cs?.ramp || (this.test && cs?.measure)) { this.idleFor = 0; return; }
      this.idleFor = pedalling ? 0 : (this.idleFor || 0) + realDt;
      if (this.idleFor >= 3) { this.toggle(true); this.hint(`⏸ ${t('autoPaused')}`); }
    } else if (this.autoPaused) {
      this.pedalFor = pedalling ? (this.pedalFor || 0) + realDt : 0;
      if (this.pedalFor >= 1) { this.toggle(); this.hint(`▶ ${t('resumed')}`); }
    }
  }

  /** Keyboard shortcuts while riding (space, arrows, +/−); ignored in dialogs, inputs, or when switched off in Settings. */
  onKey(e) {
    if (this.ending || modal.open || e.target.matches('input') || state.settings.keyboardShortcuts === false) return;
    // Space / Enter on a focused radio (free-ride choice) selects it instead of play/pause. Plain buttons
    // keep the shortcut: after clicking "next", Space should still pause, not skip again.
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest?.('[role=radio], [role=tab]')) return;
    const map = { ' ': 'play', ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'stop' };
    if (map[e.key]) { e.preventDefault(); return this.control(map[e.key]); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); return this.shift(1); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); return this.shift(-1); }
    if (this.freeLike && this.vs.on && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); return this.shift(e.key === 'ArrowUp' ? 1 : -1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.adjust(e.shiftKey ? 10 : 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.adjust(e.shiftKey ? -10 : -1); }
  }

  /** Main loop, every 250 ms: advance time, target power and ERG, 1 Hz samples, auto-pause, countdown cues, coach line, render(). */
  tick() {
    const now = performance.now();
    const realDt = (now - this.last) / 1000;
    const dt = realDt * SPEED;
    this.last = now;
    this.autoPause(realDt);

    // auto-start when the rider starts pedalling
    if (!this.started && trainer.connected) {
      this.autoStartCount = (fresh('power') > 20 || fresh('cadence') > 20) ? this.autoStartCount + 1 : 0;
      if (this.autoStartCount >= 8) this.toggle();
    }

    if (this.running) {
      this.t += dt;
      this.ridden += dt;
      const sec = Math.floor(this.t);
      if (sec !== this.lastSec) {
        // Fill every second since the last sample so recordings stay 1 Hz: a late tick (the webview
        // throttles timers in a hidden or minimised window, or dev fast-forward with ?speed) must not
        // leave gaps in the FIT file or make test efforts look short. seek() moves lastSec to the
        // second before the new position, so a jump never records fake seconds in between.
        const from = sec > this.lastSec ? this.lastSec + 1 : sec;
        this.lastSec = sec;
        // wall time per sample: one second apart, ending at now (real time; fast-forward spaces them 1 s)
        const nowWall = SPEED > 1 ? this.startedAt.getTime() + (this.samples.length + sec - from) * 1000 : Date.now();
        for (let ts = from; ts <= sec; ts++) {
          const i = Math.max(0, segmentAt(this.w.segments, Math.min(ts, this.w.duration - 0.01)));
          const wall = nowWall - (sec - ts) * 1000;
          this.samples.push({ t: ts, p: fresh('power'), c: fresh('cadence'), hr: fresh('hr'), v: this.vsSpeed ?? fresh('speed'), tp: this.targetW, seg: i, measure: this.w.segments[i]?.measure, wall });
          const tag = this.w.segments[i]?.measure;
          if (tag) { const acc = ((this.effAcc ||= {})[tag] ||= { sum: 0, n: 0 }); acc.sum += this.samples[this.samples.length - 1].p || 0; acc.n++; }
        }
      }
      if (this.t >= this.w.duration) return this.finish(true);
      // ramp tests end by themselves once the rider can no longer hold the target
      const cs = this.w.segments[this.segIdx];
      if (this.test && cs?.ramp && trainer.connected && this.t - this.w.segments.find((x) => x.ramp).start > 60) {
        const p = fresh('power'), c = fresh('cadence'), tw = this.targetW;
        this.lowCount = ((c != null && c < 30) || (p != null && tw && p < tw * 0.5)) ? this.lowCount + dt : 0;
        if (this.lowCount >= 10) this.rampCooldown();
      }
    }
    this.render(false);
  }

  /** The rider can't hold the ramp any more: end the ramp here and continue with an easy
   *  5-minute cool-down (still recorded) instead of stopping abruptly. Stop shows the result. */
  rampCooldown() {
    if (this.cooling) return;
    this.cooling = true;
    const segs = this.w.segments;
    const i = this.segIdx;
    segs[i].duration = Math.max(1, Math.round(this.t - segs[i].start));
    const easy = segs[0].p0 ?? 100 / ftp(); // the warm-up power (100 W / 80 W)
    const cool = { type: 'cooldown', duration: 300, p0: easy, p1: easy * 0.8, texts: [{ t: 0, msg: t('rampDoneMsg') }] };
    this.w.segments = [...segs.slice(0, i + 1), cool];
    let total = 0;
    this.w.segments.forEach((x, k) => { x.idx = k + 1; x.label = String(k + 1); x.start = total; total += x.duration; });
    this.w.duration = total;
    this.diagram.w = this.w;
    this.diagram.draw();
    $('#d-tot').textContent = t('ofTime', { time: fmtTime(total) });
    this.hint(t('rampComplete'));
    this.render(true);
  }

  get targetFrac() {
    const s = this.w.segments[this.segIdx];
    const p = powerAt(s, this.t - s.start);
    return p === null ? null : p * this.mult();
  }

  get targetW() { const f = this.targetFrac; return f === null ? null : Math.round(f * ftp()); }

  /**
   * Element by id for render(): looked up once and cached for the rest of the ride. A cached element that
   * was replaced (build() again, a container re-rendered) is no longer connected and is looked up afresh.
   */
  q(id) {
    let el = this.els?.get(id);
    if (!el?.isConnected) {
      el = document.getElementById(id);
      (this.els ??= new Map()).set(id, el);
    }
    return el;
  }

  /** Update the ride screen from the current state. Cheap on purpose (4× per second): cached elements, writes only on change;
   * `force` redraws everything that otherwise only changes with the segment. */
  /** Same cache for a selector (first match), for elements without an id. */
  qs(sel) {
    let el = this.sels?.get(sel);
    if (!el?.isConnected) {
      el = document.querySelector(sel);
      (this.sels ??= new Map()).set(sel, el);
    }
    return el;
  }

  /** Same cache for all matches of a selector; looked up again when one of them was replaced. */
  qsa(sel) {
    let list = this.selsAll?.get(sel);
    if (!list || !list.every((x) => x.isConnected)) {
      list = $$(sel);
      (this.selsAll ??= new Map()).set(sel, list);
    }
    return list;
  }

  render(force) {
    const segs = this.w.segments;
    const idx = Math.max(0, segmentAt(segs, Math.min(this.t, this.w.duration - 0.01)));
    const segChanged = idx !== this.segIdx;
    this.segIdx = idx;
    const s = segs[idx];
    const inSeg = this.t - s.start;
    const rem = s.duration - inSeg;
    const tf = this.targetFrac;
    const tw = this.targetW;
    const F = ftp();

    // trainer control
    const allOut = s.erg === false;
    const freeLike = tw === null || allOut;
    // once the ride ends, finish() has released ERG; nothing may send a target again
    const vsActive = freeLike && this.vs.on && trainer.connected && trainer.canErg && !this.ending;
    let vsSpeed = null;
    if (vsActive) {
      const cad = fresh('cadence');
      const ratio = this.gears[this.gear];
      vsSpeed = virtualSpeed(cad, ratio);
      const raw = targetWatts(cad, ratio, weight() || 75, this.vs.difficulty);
      this.vs.watts = this.vs.watts == null ? raw : Math.round(this.vs.watts * 0.5 + raw * 0.5);
      const now = performance.now();
      if (now - this.vs.sentAt > 900 || force) { trainer.setTargetPower(this.vs.watts); this.vs.sentAt = now; }
    } else if (trainer.connected && !this.ending) { this.vs.watts = null; if (freeLike) trainer.setFreeRide(); else trainer.setTargetPower(tw); }
    this.vsSpeed = vsSpeed;
    const gb = this.q('gearbox');
    if (gb) {
      gb.hidden = !(freeLike && (this.vs.on || ctrls.connected));
      setHtml(this.q('gear-lbl'), html`<b>${tHtml('gearN', { n: this.gear + 1 })}</b><small>/${this.gears.length} · ${this.gears[this.gear].toFixed(2)}${vsActive && ` · ${this.vs.watts} W`}</small>`);
    }

    // beeps: last 3 s before a change of target
    const n = segs[idx + 1];
    if (state.settings.beeps && this.running && n && rem <= 3.05 && rem > 0) {
      const sec = Math.min(3, Math.ceil(rem)), k = `${idx}:${sec}`;
      if (!this.beeped.has(k)) { this.beeped.add(k); countdown(sec, state.settings.beepDirection !== false ? cueDir(s, n) : null); }
    }

    const ergEl = this.q('erg-state');
    if (ergEl && trainer.connected && trainer.canErg) {
      setText(ergEl, vsActive ? `${t('virtualGears')} · ${t(`diff.${this.vs.difficulty}`)}` : freeLike ? t('ergOffGears') : 'ERG');
      ergEl.className = vsActive ? 'erg vs' : freeLike ? 'erg off' : 'erg on';
    }

    // LIVE panel
    const p = fresh('power'), c = fresh('cadence'), hr = fresh('hr'), v = fresh('speed');
    const gt = vsActive ? this.vs.watts : allOut ? null : tw;
    setText(this.q('m-pow'), p ?? '–');
    // power bar: 0…1.5× target, coloured by the zone you're riding in (the target is on the gauge)
    const pRef = gt || F;
    setBar(this.q('b-pow'), p != null ? p / (pRef * 1.5) : 0, { color: p != null ? zoneColor(p / F, bounds()) : null });

    // cadence vs target (Zwift: Cadence / CadenceLow+High): green on target, amber ±5–10, red beyond 10 rpm
    const cLo = s.cadenceLow ?? s.cadence, cHi = s.cadenceHigh ?? s.cadence;
    setText(this.q('v-cad'), c != null ? Math.round(c) : '–');
    setText(this.q('t-cad'), cLo != null ? `/ ${cLo === cHi ? cLo : `${cLo}–${cHi}`}` : '');
    const dev = c != null && cLo != null ? (c < cLo ? cLo - c : c > cHi ? c - cHi : 0) : null;
    const cadState = dev == null ? '' : dev > 10 ? 'bad' : dev > 5 ? 'warn' : 'good';
    const live = this.running || !this.started;
    this.q('v-cad').classList.toggle('off-target', live && cadState === 'bad');
    this.q('t-cad').className = live ? cadState : '';
    const CMIN = 40, CMAX = 130, cf = (x) => (x - CMIN) / (CMAX - CMIN);
    setBar(this.q('b-cad'), c != null ? cf(c) : 0, {
      mark: cLo != null && cLo === cHi ? cf(cLo) : null,
      band: cLo != null && cLo !== cHi ? [cf(cLo), cf(cHi)] : null,
      color: cadState === 'bad' ? 'var(--danger)' : cadState === 'warn' ? 'var(--warn)' : cadState === 'good' ? 'var(--ok)' : null,
    });

    const spd = vsSpeed ?? v;
    setText(this.q('v-spd'), spd != null ? spd.toFixed(1) : '–');
    setBar(this.q('b-spd'), spd != null ? spd / 60 : 0, { color: 'var(--ok)' });
    setText(this.q('v-hr'), hr ?? '–');
    setText(this.q('t-hr'), hr != null ? `${Math.round((hr / maxHr()) * 100)}%` : '');
    setBar(this.q('b-hr'), hr != null ? hr / maxHr() : 0, { color: 'var(--hrline)' });

    setText(this.q('g-unit'), this.showPct ? '% FTP' : t('watt'));
    setText(this.q('v-pow'), p == null ? '–' : this.showPct ? `${Math.round((p / F) * 100)}%` : p);
    setText(this.q('t-pow'), gt == null ? t(s.type === 'maxeffort' ? 'gMax' : allOut ? 'gAllOut' : 'gFree') : this.showPct ? `${Math.round((gt / F) * 100)}%` : `${gt} W`);
    this.gauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });
    // on target: within ±5 % for 3 s -> soft glow in the zone colour around the gauge
    const onT = this.running && gt != null && p != null && Math.abs(p - gt) / gt <= 0.05;
    this.onSince = onT ? (this.onSince ?? performance.now()) : null;
    const gEl = this.q('gauge');
    if (gt != null) gEl.style.setProperty('--glow', zoneColor(gt / F, bounds()));
    gEl.classList.toggle('on-target', onT && performance.now() - this.onSince >= 3000);

    // CURRENT SEGMENT
    const color = zoneColor(tf, bounds());
    this.ring.update(Math.min(1, inSeg / s.duration), color);
    if (s.p0 === null) { this.q('s-target').classList.remove('range'); setText(this.q('s-target'), s.type === 'maxeffort' ? t('bigMax') : t('bigFree')); setText(this.q('s-watts'), vsActive ? t('virtualShiftingLc') : t('rideByFeel')); }
    else {
      const a = Math.round(s.p0 * 100 * this.mult()), b = Math.round(s.p1 * 100 * this.mult());
      setText(this.q('s-target'), allOut ? t('bigAllOut') : a === b ? `${a}%` : `${a}–${b}%`);
      this.q('s-target').classList.toggle('range', a !== b || allOut);
      setText(this.q('s-watts'), allOut ? t('aimW', { w: tw, how: vsActive ? t('howShift') : t('howGears') }) : `${tw} W`);
    }
    this.q('s-target').style.color = zoneInk(tf, bounds());
    setText(this.q('s-tw'), gt != null ? `${gt} W` : allOut ? t('allOut') : t('free'));
    this.q('s-tw').style.color = gt != null ? zoneInk(gt / F, bounds()) : '';
    // live pacing in long all-out test efforts: running average, projected FTP, "too fast" warning
    const pacing = this.test && allOut && s.measure && s.duration >= 300;
    setText(this.q('s-tw-k'), pacing ? (s.duration >= 480 ? t('estFtp') : t('effortAvg')) : t('targetPower'));
    this.q('s-watts').classList.remove('warn-text');
    let paceFast = false;
    if (pacing) {
      const acc = this.effAcc?.[s.measure];
      const avg = acc && acc.n >= 5 ? Math.round(acc.sum / acc.n) : null;
      const factor = s.duration >= 1140 ? 0.95 : s.duration >= 480 ? 0.9 : null;
      const fast = !!(avg && tw && acc.n >= 60 && avg > tw * 1.1);
      setText(this.q('s-target'), avg ? `${avg} W` : t('bigAllOut'));
      this.q('s-target').classList.toggle('range', !avg);
      if (avg) this.q('s-target').style.color = zoneInk(avg / F, bounds());
      setText(this.q('s-watts'), !avg ? t('aimW', { w: tw ?? '–', how: vsActive ? t('howShift') : t('howGears') }) : fast ? t('tooFastShort') : tw ? t('avgAim', { w: tw }) : t('effortAverage'));
      this.q('s-watts').classList.toggle('warn-text', fast);
      paceFast = fast;
      const proj = avg && factor && acc.n >= 30 ? Math.round(avg * factor) : null;
      setText(this.q('s-tw'), factor ? (proj ? `${proj} W` : '–') : (avg ? `${avg} W` : '–'));
      this.q('s-tw').style.color = '';
    }
    setText(this.q('s-cad'), cLo != null ? `${cLo === cHi ? cLo : `${cLo}–${cHi}`} rpm` : '–');
    this.q('s-cad').classList.toggle('range', cLo != null && cLo !== cHi);
    setText(this.q('s-dur'), fmtTime(s.duration));
    this.q('s-bar').style.width = `${Math.min(100, (inSeg / s.duration) * 100)}%`;
    this.q('s-bar').style.background = color;
    setText(this.q('s-rem'), fmtTime(Math.ceil(rem)));
    this.qs('.panel.seg').classList.toggle('closing', rem <= 5 && !!n);

    if (segChanged || force) {
      setText(this.q('seg-kind'), segKind(s));
      this.qs('.panel.seg').style.setProperty('--zc', color);
      // NEXT SEGMENT
      // One description of the next segment, rendered into both cards: the full view (#next-card) and
      // the compact panel (#cmp-next), whose optional lines (.cp-opt) drop out on small windows and which
      // has a slot for the "in 0:42" countdown (#cmp-next-in, filled every tick below).
      const card = this.q('next-card'), cn = this.q('cmp-next');
      let zc = 'var(--line-strong)', title = '', body;
      if (n) {
        const m = this.mult();
        const nf = n.p0 === null ? null : ((n.p0 + n.p1) / 2) * m;
        const pa = n.p0 === null ? null : Math.round(n.p0 * 100 * m), pb = n.p0 === null ? null : Math.round(n.p1 * 100 * m);
        const wa = n.p0 === null ? null : Math.round(n.p0 * F * m), wb = n.p0 === null ? null : Math.round(n.p1 * F * m);
        const big = n.p0 === null ? tHtml(n.type === 'maxeffort' ? 'maxEffort' : 'freeRide') : n.erg === false ? tHtml('allOut') : pa === pb ? `${pa}%` : `${pa}% → ${pb}%`;
        const watts = n.p0 === null ? tHtml('rideByFeel') : wa === wb ? `${wa} W` : `${wa} → ${wb} W`;
        const nLo = n.cadenceLow ?? n.cadence, nHi = n.cadenceHigh ?? n.cadence;
        const rpm = nLo == null ? null : `${nLo === nHi ? nLo : `${nLo}–${nHi}`} rpm`;
        zc = zoneColor(nf, bounds());
        title = nf == null ? t('freeRide') : zoneOf(nf, bounds()).name;
        body = (compact) => html`<div class="nc-txt"><b>${big}</b><span class="nc-v">${watts}</span><span class="nc-v${compact ? ' cp-opt' : ''}">${fmtTime(n.duration)} min</span>${compact
          ? html`<span class="nc-v cp-opt" id="cmp-next-in"></span>`
          : rpm && html`<span class="nc-v nc-rpm">${rpm}</span>`}</div>`;
      } else {
        // last segment: "Finish strong", or after a failed ramp test the result hint
        const note = (compact) => (this.cooling ? (compact ? null : tHtml('pressStopResult')) : tHtml('noMoreChanges'));
        body = (compact) => html`<div class="nc-txt"><b>${tHtml(this.cooling ? 'testDone' : 'finishStrong')}</b>${note(compact) && html`<span class="nc-v muted${compact ? ' cp-opt' : ''}">${note(compact)}</span>`}</div>`;
      }
      card.style.setProperty('--zc', zc);
      cn.style.setProperty('--zc', zc);
      card.title = title;
      mount(card, body(false));
      mount(cn, body(true));
      setText(this.q('int-val'), `${this.intensity}%`);
      this.q('int-val').classList.toggle('changed', this.intensity !== 100);
      this.diagram.highlight(idx);
      this.q('btn-play').classList.toggle('is-running', this.running);
      // segment change: zone-coloured sweep over Current segment, Next card slides up
      if (segChanged && this.animReady && motionOK()) { restartAnim(this.qs('.panel.seg'), 'seg-in'); restartAnim(card, 'nx-in'); }
    }
    this.animReady = true;

    this.coach(s, { segChanged, inSeg, rem, allOut, freeLike, gt, p, c, cLo, cHi, dev, cadState, paceFast });

    setText(this.q('d-el'), fmtTime(this.t));
    setText(this.q('d-rem'), fmtTime(Math.max(0, Math.ceil(this.w.duration - this.t))));

    // Both presentations share the same samples and Ride. No DOM is rebuilt on resize.
    // compact panels: same values as the full view (actual target, never a test-estimated FTP)
    const cmpSub = gt != null ? `${gt} W` : t(allOut ? 'gAllOut' : 'gFree');
    this.cGauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });
    setText(this.q('cmp-pow'), p ?? '–');
    setText(this.q('cmp-pow-sub'), cmpSub);
    this.cRing.update(Math.min(1, inSeg / s.duration), color);
    setText(this.q('cmp-seg'), fmtTime(Math.max(0, Math.ceil(rem))));
    setText(this.q('cmp-seg-sub'), cmpSub);
    setText(this.q('cmp-tgt'), this.q('s-target').textContent);
    this.q('cmp-tgt').style.color = this.q('s-target').style.color;
    this.q('cmp-bar').style.width = this.q('s-bar').style.width;
    this.q('cmp-bar').style.background = color;
    setText(this.q('cmp-hr'), hr ?? '–');
    setText(this.q('cmp-cad'), c != null ? Math.round(c) : '–');
    this.q('cmp-cad').classList.toggle('off-target', live && cadState === 'bad');
    this.qsa('.cmp-wleft').forEach((el) => { setText(el, this.q('d-rem').textContent); });
    this.q('cmp-gears').hidden = !freeLike;
    setText(this.q('cmp-gear'), t('gearN', { n: this.gear + 1 }));
    const nIn = this.q('cmp-next-in');
    if (nIn) setText(nIn, `${t('compactIn')} ${fmtTime(Math.max(0, Math.ceil(rem)))}`);
    const status = this.autoPaused ? t('compactAutoPaused') : this.running ? t('running') : this.started ? t('paused') : t('ready');
    if (this.q('cmp-status').textContent !== status) setText(this.q('cmp-status'), status);
    const connection = trainer.connected ? trainer.mode === 'sim' ? t('simulator') : t('connectedCap') : t('noTrainer');
    const statusDetail = this.autoPaused ? t('autoPaused') : status;
    this.q('cmp-state').title = `${statusDetail} · ${connection}`;
    this.q('cmp-state').setAttribute('aria-label', `${statusDetail} · ${connection}`);
    this.q('cmp-dot').classList.toggle('on', trainer.connected);
    this.qsa('#ride [data-act="play"]').forEach((el) => {
      el.classList.toggle('is-running', this.running);
      const label = this.running ? t('btnPause') : t('btnPlay');
      el.title = `${label} (${t('spaceKey')})`;
      el.setAttribute('aria-label', label);
    });
    if (!this.compact.active) this.diagram.update(this.t, this.samples);
  }

  /**
   * Coach line under the Current segment stats: one short message at a time, empty otherwise.
   * Priority: the workout's own text events > pacing (test "too fast", ERG power fading) >
   * cadence more than 5 rpm off for 5 s (clears after 3 s back on target) > hard-segment cues
   * (Z4 and up, all-out, max effort: start, halfway, last 30 s). A message stays at least 4 s
   * unless a more important one replaces it. Automatic hints can be switched off (Settings → App).
   */
  coach(s, { segChanged, inSeg, rem, allOut, freeLike, gt, p, c, cLo, cHi, dev, cadState, paceFast }) {
    const el = $('#coach');
    if (!el) return;
    const now = performance.now() / 1000;
    const k = (this.cz ||= { cadOff: null, cadOn: null, cadShown: false, powLow: null, cur: null, since: 0 });
    if (segChanged) Object.assign(k, { cadOff: null, cadOn: null, cadShown: false, powLow: null });
    const auto = this.running && state.settings.coachHints !== false;
    const cands = [];

    // 1. text events from the .zwo file (always shown, also while paused)
    const ev = s.texts.filter((x) => inSeg >= x.t && inSeg < x.t + 10).pop();
    if (ev?.msg) cands.push({ key: `zwo:${s.start}:${ev.t}`, pri: 4, icon: IC.chat, level: 'info', text: ev.msg });

    // 2. pacing: long test efforts started too fast; ERG target not reached (cadence collapsing)
    if (auto && paceFast) cands.push({ key: 'pace', pri: 3, icon: IC.bolt, level: 'bad', text: t('coachTooFast') });
    const erg = !freeLike && trainer.connected && trainer.canErg && gt >= 50;
    const low = auto && erg && p != null && inSeg >= 10 && p < gt * 0.85;
    k.powLow = low ? (k.powLow ?? now) : null;
    if (low && now - k.powLow >= 5) cands.push({ key: 'pow', pri: 3, icon: IC.bolt, level: 'bad', text: t('coachPowerFading', { p, gt }) });

    // 3. cadence target: > 5 rpm off for 5 s, clears after 3 s back on target
    if (!auto || dev == null) Object.assign(k, { cadOff: null, cadOn: null, cadShown: false });
    else if (dev > 5) { k.cadOn = null; k.cadOff ??= now; if (now - k.cadOff >= 5) k.cadShown = true; }
    else { k.cadOff = null; if (k.cadShown) { k.cadOn ??= now; if (now - k.cadOn >= 3) { k.cadShown = false; k.cadOn = null; } } }
    if (k.cadShown) {
      const aim = cLo === cHi ? `${cLo}` : `${cLo}–${cHi}`, rpm = Math.round(c);
      cands.push(dev > 5
        ? { key: 'cad', pri: 2, icon: IC.cad, level: cadState, text: t(c < cLo ? 'coachCadLow' : 'coachCadHigh', { rpm, aim }) }
        : { key: 'cad', pri: 0.5, icon: IC.cad, level: 'ok', text: t('coachBackOnTarget', { rpm }) });
    }

    // 4. hard segments: Z4 and up, all-out efforts, max efforts (not the ramp-test steps)
    if (auto && !s.ramp && s.duration >= 20) {
      const af = s.p0 === null ? null : ((s.p0 + s.p1) / 2) * this.mult(), zone = zoneOf(af, bounds());
      const max = s.type === 'maxeffort';
      if (allOut || max || zone?.id >= 4) {
        const name = allOut ? t('allOut') : max ? t('maxEffort') : zone.name, half = s.duration / 2;
        let text = null, cue = null;
        if (inSeg < 6) { cue = 'start'; text = `${name} · ${fmtTime(s.duration)} · ${allOut || max ? t('coachGo') : t('coachSettle')}`; }
        else if (s.duration >= 120 && inSeg >= half && inSeg < half + 6) { cue = 'half'; text = t('coachHalfway', { left: fmtTime(Math.ceil(rem)) }); }
        else if (s.duration >= 60 && rem <= 30 && rem > 22) { cue = 'last'; text = t('coachLast30'); }
        if (text) cands.push({ key: `hard:${s.start}:${cue}`, pri: 1, icon: IC.flame, level: 'push', text, color: zone ? zoneInk(af, bounds()) : 'var(--danger)' });
      }
    }

    const cand = cands.sort((a, b) => b.pri - a.pri)[0] || null;
    const cur = k.cur;
    let show = cand;
    if (cur && cand?.key !== cur.key && now - k.since < 4 && (!cand || cand.pri <= cur.pri)) show = cur; // hold ≥ 4 s
    if (!show) { if (cur) { el.classList.remove('show'); k.cur = null; } return; }
    if (!cur || show.key !== cur.key) {
      k.since = now;
      mount(el, html`${show.icon}<span></span>`);
      el.classList.remove('show'); void el.offsetWidth;
    }
    el.className = `coach-line show ${show.level}`;
    if (show.color) el.style.setProperty('--cc', show.color); else el.style.removeProperty('--cc');
    const span = el.querySelector('span');
    if (span.textContent !== show.text) span.textContent = show.text;
    k.cur = show;
  }

  /** Stop button / Esc: expand from compact and pause; a ride that never started just closes, otherwise the rider decides how to end it. */
  async stop() {
    if (this.ending) return;
    if (!await this.compact.set(false)) return;
    const wasRunning = this.running;
    if (wasRunning) this.toggle();
    if (!this.started) return this.close();
    if (this.test && this.cooling) return this.finish(true); // the ramp is over — show the result
    if (this.test) {
      const c = await choiceDialog(t('endTestQ'), this.w.segments[this.segIdx]?.ramp ? t('endTestRamp') : t('endTestText', { time: fmtTime(this.ridden) }), [
        ['resume', t('resume'), 'ghost'], ['discard', t('discard'), 'ghost'], ['save', t('finishEvaluate'), 'primary']]);
      if (c === 'resume' || !c) { if (wasRunning) this.toggle(); return; }
      if (c === 'discard') return this.close();
      return this.finish(true);
    }
    const pct = Math.round((this.t / this.w.duration) * 100);
    const choice = await choiceDialog(t('endWorkoutQ'), t('endWorkoutText', { pct, time: fmtTime(this.ridden) }), [
      ['resume', t('resume'), 'ghost'],
      ...(this.planId ? [['skip', t('countSkipped'), 'ghost']] : []),
      ['discard', t('discard'), 'ghost'],
      ['save', this.planId ? t('saveAsDone') : t('save'), 'primary'],
    ]);
    if (choice === 'resume' || !choice) { if (wasRunning) this.toggle(); return; }
    if (choice === 'discard') return this.close();
    if (choice === 'skip') { await markEntry(this.planId, this.file, { status: 'skipped', doneDuration: Math.round(this.ridden), planDuration: this.w.duration }); return this.close(); }
    this.finish(false);
  }

  /** Summary numbers of the recorded samples: duration, average / normalized power, HR, cadence, kJ, distance. */
  stats() {
    const ps = this.samples.filter((s) => s.p != null);
    const avg = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null && x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    let np = null;
    if (ps.length >= 30) {
      const roll = [];
      for (let i = 29; i < ps.length; i++) { let s = 0; for (let j = i - 29; j <= i; j++) s += ps[j].p; roll.push(Math.pow(s / 30, 4)); }
      np = Math.round(Math.pow(roll.reduce((a, b) => a + b, 0) / roll.length, 0.25));
    }
    const kj = Math.round(ps.reduce((a, s) => a + s.p, 0) / 1000);
    const IF = np ? np / ftp() : null;
    const tss = IF ? Math.round(((this.ridden * np * IF) / (ftp() * 3600)) * 100) : null;
    return { avgPower: avg(this.samples, 'p'), np, avgHr: avg(this.samples, 'hr'), maxHr: Math.max(0, ...this.samples.map((s) => s.hr || 0)) || null, avgCadence: avg(this.samples, 'c'), kj: kj || null, tss };
  }

  /** End of the ride: save the FIT file, add to history and plan, evaluate FTP tests, show the summary, upload to Garmin and services. */
  async finish(completed) {
    // Runs once: a controller ▶ on the last segment or a key during the save would otherwise
    // save a second FIT file and history entry. Every ride input checks `ending`.
    if (this.ending) return;
    this.ending = true;
    $('#btn-compact').hidden = true;
    clearInterval(this.loop);
    this.running = false;
    trainer.setFreeRide(); // don't leave the trainer holding the last ERG target while the summary is open
    // Saving/results must still proceed if the OS rejects a window resize.
    await this.compact.set(false);
    // ridden to the end: the ring closes and turns into a check, then the summary rises
    const ridToEnd = completed && this.t >= this.w.duration - 1;
    const endAnim = ridToEnd && motionOK();
    if (ridToEnd && !this.test && state.settings.endChime !== false) endChime();
    const animStart = performance.now();
    if (endAnim) {
      this.ring.update(1, 'var(--ok)');
      $('.panel.seg')?.classList.remove('closing');
      $('.seg-ring')?.classList.add('finished');
      $('#gauge')?.classList.remove('on-target');
    }
    const st = this.stats();
    const title = this.info?.title || this.w.name;
    const result = { status: 'done', planDuration: this.w.duration, doneDuration: Math.round(this.ridden), completed, ...st };

    const fit = await this.saveFit(title);
    const entry = { file: this.file, plan: this.planId, title, startedAt: this.startedAt?.toISOString(), at: new Date().toISOString(), ...result, fitPath: fit?.path || null, distanceKm: fit?.summary?.distanceKm ?? null };
    state.history.unshift(entry);
    state.history = state.history.slice(0, 1000);
    if (this.planId) await markEntry(this.planId, this.file, result); else await api.saveState();
    const testResult = this.test ? await this.recordTest(title) : null;

    if (endAnim) { const wait = 650 - (performance.now() - animStart); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
    await this.showSummary({ title, completed, st, fit, entry, testResult, endAnim });
  }

  /**
   * Store the ride as a FIT file (for Garmin and export). The planned workout goes in as well: Garmin
   * names the activity after it (and forwards that name to Strava); the rename after the upload comes
   * too late for Strava. Resolves Rust's { path, garminPath, summary } or null (nothing recorded / error).
   */
  async saveFit(title) {
    if (!this.samples.length) return null;
    const F = ftp(), m = this.mult();
    const steps = this.w.segments.map((sg) => ({
      duration: Math.max(1, Math.round(sg.duration)),
      lo: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p0 * F * m),
      hi: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p1 * F * m),
      kind: sg.type === 'warmup' ? 'warmup' : sg.type === 'cooldown' ? 'cooldown' : sg.type === 'off' ? 'rest' : null,
    }));
    return invoke('save_activity', { ride: { name: title, ftp: F, steps, samples: this.samples.map(({ wall, p, c, hr, v, seg }) => ({ wall, p, c, hr, v, seg })) } })
      .catch((e) => { toast(t('couldNotSaveRide', { e })); return null; });
  }

  /** FTP test: evaluate the tagged samples, keep new power bests, and add the result to state.tests (not applied yet). */
  async recordTest(title) {
    const testResult = this.test.protocol ? this.test.protocol.evaluate(this.samples) : evaluateGeneric(this.samples, this.w);
    if (!testResult) return null;
    const v = vo2max(testResult.vo2, weight());
    if (v) testResult.vo2est = v;
    const bests = { ...(state.settings.bests || {}) };
    for (const [k, val] of Object.entries(testResult.bests || {})) if (val && (!bests[k] || val > bests[k])) bests[k] = val;
    state.settings.bests = bests;
    state.tests = [{ at: new Date().toISOString(), protocol: this.test.protocol?.id || 'library', name: this.test.protocol?.name || title, ftp: testResult.ftp, incomplete: !!testResult.incomplete, prevFtp: ftp(), details: testResult.details, cp: testResult.cp ?? null, wPrime: testResult.wPrime ?? null, vo2: testResult.vo2est?.rel ?? null, vo2abs: testResult.vo2est?.abs ?? null, weight: weight(), accepted: false }, ...(state.tests || [])].slice(0, 200);
    await api.saveState();
    return testResult;
  }

  /**
   * The ride summary dialog: test result, stats, where the ride goes (Garmin, platforms, FIT file) and
   * the next plan workout. Automatic uploads start right away and update their row when done; for a
   * ride under SHORT_RIDE_S they wait until the rider answers the short-ride question.
   */
  async showSummary({ title, completed, st, fit, entry, testResult, endAnim }) {
    const [garmin, svcs] = fit ? await Promise.all([invoke('garmin_status').catch(() => ({})), refreshServices()]) : [{}, []];
    const autoGarmin = fit && garmin.connected && syncMode('garmin') === 'auto';
    const rideSvcs = svcs.filter((sv) => svcRoute(sv) && svcMode(sv) !== 'off');
    // automatic destinations: Garmin upload, platforms in auto mode, or opening Garmin's import page
    const autoSvcs = rideSvcs.filter((sv) => sv.connected && svcMode(sv) === 'auto');
    const autoImport = fit && !garmin.connected && !!state.settings.garmin?.autoOpen;
    const autoNames = [...(autoGarmin || autoImport ? ['Garmin Connect'] : []), ...autoSvcs.map((sv) => sv.name)];
    const hold = autoNames.length > 0 && (entry.doneDuration ?? 0) < SHORT_RIDE_S;
    const plan = this.planId && planById(this.planId);
    const next = plan && planProgress(plan).next;
    const heading = tHtml(this.test ? 'ftpTestResult' : completed ? 'workoutComplete' : 'workoutSaved');
    openModal(html`
      <div class="summary">
        <div class="eyebrow">${heading}</div>
        <h2>${title}</h2>
        ${this.test && summaryTest(testResult)}
        ${summaryStats(st, this.ridden)}
        ${hold && summaryShortRide(entry.doneDuration ?? 0, autoNames)}
        ${fit && summarySyncList({ garmin, autoGarmin, rideSvcs, hold })}
        ${plan && summaryNext(plan, next)}
        <div class="modal-actions">
          <button class="btn ${next ? 'ghost' : 'primary'}" data-act="home">${tHtml('done')}</button>
          ${next && html`<button class="btn primary" data-act="next">${tHtml('startNextNow')}</button>`}
        </div>
      </div>`, endAnim ? 'small sticky rise' : 'small sticky');
    const ftpEl = this.test && testResult?.ftp && motionOK() ? $('.ftp-result > div > b', modal) : null;
    if (ftpEl) countUp(ftpEl, ftp(), testResult.ftp, (v) => `${v} W`, endAnim ? 450 : 150);

    // upload state per destination row: spinner → link / ✓ / failure with retry
    const rowState = (id, frag) => { const el = $(`#${id}`, modal); if (el?.isConnected) mount(el, frag); return el; };
    const uploaded = (url) => (url ? html`<a href="#" class="link" data-act="open-url" data-url="${url}">${tHtml('uploaded')}</a>` : html`<span class="ok-text">${tHtml('uploaded')}</span>`);
    const doGarmin = async () => {
      rowState('garmin-state', html`<span class="spinner"></span> ${tHtml('uploadingGarmin')}`);
      try { rowState('garmin-state', uploaded((await uploadToGarmin(entry)).url)); } catch (e) {
        rowState('garmin-state', html`<span class="warn-text" title="${String(e)}">${tHtml('uploadFailed')}</span> <button class="btn ghost sm" data-act="garmin-up">${tHtml('retry')}</button> <button class="btn ghost sm" data-act="garmin">${tHtml('manual')}</button>`);
      }
    };
    const doSvc = async (id) => {
      rowState(`svc-${id}`, html`<span class="spinner"></span> ${tHtml('uploading')}`);
      try { rowState(`svc-${id}`, uploaded((await uploadToService(entry, id)).url)); } catch (err) {
        rowState(`svc-${id}`, html`<span class="warn-text" title="${String(err)}">${tHtml('failed')}</span> <button class="btn ghost sm" data-act="svc-up" data-id="${id}">${tHtml('retry')}</button>`);
      }
    };
    const leave = () => { closeModal(); this.close(); };
    const startAutoUploads = () => {
      if (autoGarmin) doGarmin();
      for (const sv of autoSvcs) doSvc(sv.id);
      if (autoImport) garminImport(fit.path);
    };
    bindActions(modal, {
      // short-ride question: upload everywhere it would have gone automatically, or leave it manual
      'short-up': (el) => { el.closest('.short-ride').remove(); startAutoUploads(); },
      'short-skip': (el) => el.closest('.short-ride').remove(),
      apply: (el) => { applyFtp(state.tests[0]); mount(el.closest('.ftp-actions'), badge(tHtml('ftpUpdated', { w: state.tests[0].ftp }), 'ok')); },
      keep: (el) => mount(el.closest('.ftp-actions'), html`<span class="muted small">${tHtml('keptFtp')}</span>`),
      garmin: () => garminImport(fit.path),
      'garmin-up': doGarmin,
      'svc-up': (el) => doSvc(el.dataset.id),
      'svc-man': (el) => manualImport(el.dataset.id, fit.path),
      fit: () => exportFit(fit.path),
      home: leave,
      next: () => { leave(); startRide(next.file, plan.id); },
    });
    if (!hold) startAutoUploads();
  }

  /** Leave the ride screen: expand from compact, release devices to idle, restore the normal views and pending updates. */
  async close() {
    if (!await this.compact.set(false)) return;
    clearInterval(this.loop);
    this.ending = true;
    trainer.setFreeRide(); // release ERG (also on Discard, which skips finish())
    this.cObs?.disconnect();
    invoke('keep_awake', { on: false }).catch(() => {});
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    $('#ride').hidden = true;
    $('#ride').replaceChildren();
    $('#ride').classList.remove('paused');
    document.body.classList.remove('riding');
    $('#ride-title').hidden = true;
    $('#btn-compact').hidden = true;
    $('#ride-title').replaceChildren();
    ride = null;
    route();
    if (updFound && updLater !== updFound.version) showUpdateCard();
  }
}

function choiceDialog(title, text, options) {
  return new Promise((resolve) => {
    openModal(html`<h2>${title}</h2><p>${text}</p><div class="modal-actions">${options.map(([v, l, c]) => html`<button class="btn ${c}" data-v="${v}">${l}</button>`)}</div>`, 'small');
    let settled = false;
    modal.addEventListener('close', () => { if (!settled) resolve(null); }, { once: true });
    $$('[data-v]', modal).forEach((b) => (b.onclick = () => { settled = true; closeModal(); resolve(b.dataset.v); }));
  });
}

// Direction of the coming change for the countdown cue: 'up', 'down', or null for about the same
// (within 3 % FTP) or no fixed target (free ride). All-out efforts count as higher than any target.
function cueDir(cur, next) {
  const level = (x, end) => (x.erg === false || x.type === 'maxeffort' ? Infinity : x.p0 === null ? null : end ? x.p1 : x.p0);
  const a = level(cur, true), b = level(next, false);
  if (a === null || b === null || a === b) return null;
  return b - a > 0.03 ? 'up' : a - b > 0.03 ? 'down' : null;
}

boot().catch((e) => {
  mount($('#view'), html`<div class="card"><h2>${tHtml('couldNotLoad')}</h2><p>${e.message || String(e)}</p></div>`);
});

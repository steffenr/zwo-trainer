import { powerAt, segmentAt, estimateTss } from './zwo.js';
import { ZONES, FREE_COLOR, zoneOf, zoneColor, zoneInk, fmtTime, fmtDur, miniProfile, Diagram, Gauge, ProgressRing, motionOK } from './render.js';
import { Trainer, HeartRate, Controllers, bindNative, invoke, listen } from './ble.js';
import { renderMarkdown, markdownSummary, markdownPlain, smartTrim } from './markdown.js';
import { DEFAULT_SHIFTING, gearTable, virtualSpeed, targetWatts } from './vshift.js';
import { PROTOCOLS, protocolById, isTestWorkout, evaluateGeneric, classifyTest, prepareTestWorkout, vo2max } from './tests.js';
import { t, LOCALES, setLocale, systemLocale, coerceLocale, fmtLocale, translateDom } from './i18n/index.js';

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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  if (!md) return '';
  const { text, cut } = smartTrim(markdownPlain(md), DESC_PREVIEW);
  if (!cut) return `<section class="plan-desc card"><div class="md">${renderMarkdown(md)}</div></section>`;
  return `<section class="plan-desc card is-collapsed">
    <div class="md md-preview"><p>${esc(text)} <a href="#" class="md-toggle" data-act="desc-toggle">${t('showMore')}</a></p></div>
    <div class="md md-full">${renderMarkdown(md)}<p><a href="#" class="md-toggle" data-act="desc-toggle">${t('showLess')}</a></p></div>
  </section>`;
}
let workoutIndex = new Map();
let lastView = null;         // micro animations: last rendered view (fade in on change)
const pbarMemo = new Map();  // plan id -> last progress-bar widths (glide on change)
let justDone = null;         // file just marked done (its check draws itself once)
const workoutInfo = (file) => workoutIndex.get(file);
const folderOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

function indexLibrary() {
  workoutIndex = new Map(allWorkouts().map((w) => [w.file, w]));
}

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
const starBtn = (file) => `<button class="star ${isFav(file) ? 'on' : ''}" data-act="fav" data-file="${esc(file)}" title="${isFav(file) ? t('favRemove') : t('favAdd')}" aria-label="${t('favorite')}">${isFav(file) ? '★' : '☆'}</button>`;

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
async function boot() {
  translateDom();
  if (!window.__TAURI__) throw new Error(t('needsDesktop'));
  const a = await api.appState();
  applyAppState(a);
  bindChrome();
  if (syncOn()) await Promise.race([runSync(true), new Promise((r) => setTimeout(r, 4000))]);
  await bindNative(trainer, hrm, onSensor, ctrls, onButton);
  window.addEventListener('hashchange', route);
  if (profiles.length > 1 && !params.get('profile')) await whoIsRiding();
  await loadLibrary();
  refreshServices();
  autoConnect();
  initUpdates();
  if (params.get('sim') === '1') { trainer.startSim(); hrm.startSim(); }
}

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

async function initUpdates() {
  updPrefs = await invoke('update_status').catch(() => updPrefs);
  if (!updPrefs.available) return;
  await listen('update-progress', updateProgress).catch(() => {});
  setTimeout(autoCheckUpdate, 8000);
  setInterval(autoCheckUpdate, 6 * 3600 * 1000);
}

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

const updIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

function showUpdateCard() {
  if (!updFound || ride) return;
  const u = updFound;
  let card = $('#update-card');
  if (!card) { card = document.createElement('div'); card.id = 'update-card'; card.className = 'update-card'; card.setAttribute('role', 'status'); document.body.append(card); }
  card.innerHTML = `<div class="uc-head"><span class="uc-ico">${updIcon}</span><div><b>${t('updAvailable', { v: esc(u.version) })}</b><small class="muted">${t('updYouHave', { v: esc(u.current) })}</small></div></div>
    <div class="uc-actions"><button class="btn ghost sm" data-u="notes">${t('updWhatsNew')}</button><span class="grow"></span><button class="btn ghost sm" data-u="later">${t('updLater')}</button><button class="btn primary sm" data-u="install">${t('updInstall')}</button></div>`;
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

async function installUpdate() {
  const card = $('#update-card');
  if (ride || !card) return;
  const ask = OS === 'linux' ? ` ${t('updPassword')}` : '';
  card.innerHTML = `<div class="uc-head"><span class="uc-ico">${updIcon}</span><div><b id="uc-status">${t('updDownloading', { v: esc(updFound.version) })}</b><small class="muted">${t('updRestarts')}${ask}</small></div></div>
    <div class="pbar uc-bar"><i class="d" id="uc-bar" style="width:0%"></i></div>`;
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
const avatar = (p, cls = '') => {
  const e = p.avatar?.emoji;
  return `<span class="avatar ${esc(cls)} ${e ? 'emoji' : ''}" style="--av:${esc(avatarBg(p))}">${e ? esc(e) : esc(initials(p.name))}</span>`;
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
  b.innerHTML = avatar(state);
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

function bindChrome() {
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  $('#btn-devices').onclick = (e) => devicesMenu(e.currentTarget);
  $('#btn-settings').onclick = () => openSettings();
  $('#btn-profile').onclick = profileMenu;
  $('#mode-switch').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); };
  $$('.chip[data-device]').forEach((c) => (c.onclick = () => deviceDialog(c.dataset.device)));
  trainer.on('status', (s) => { setDev('trainer', s); ride?.onDeviceStatus(); });
  trainer.on('data', onSensor);
  hrm.on('status', (s) => setDev('hr', s));
  hrm.on('data', onSensor);
  ctrls.on('status', (s) => { setDev('controller', s); ride?.render(true); });
  document.addEventListener('keydown', (e) => ride?.onKey(e));
}

/** Reconnect the devices saved in the active profile (silently — they may be switched off). */
async function autoConnect() {
  const devs = state.settings.devices || {};
  for (const [kind, dev] of [['trainer', trainer], ['hr', hrm]]) {
    const saved = devs[kind];
    if (!saved?.id || dev.connected || dev.mode === 'sim') continue;
    setDev(kind, { reconnecting: true, name: saved.name });
    dev.connect(saved.id).catch(() => setDev(kind, { connected: false }));
  }
  const cs = state.settings.devices?.controllers || [];
  if (cs.length && !ctrls.connected) {
    setDev('controller', { reconnecting: true, name: cs.map((c) => c.name).join(' + ') });
    Promise.allSettled(cs.map((c) => ctrls.connect(c.id))).then((r) => { if (!r.some((x) => x.status === 'fulfilled')) setDev('controller', { connected: false }); });
  }
}

/** Controller button → [workout action, dictionary key of its description] (Zwift Ride / Play / Click). */
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

function onButton(button, device) {
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

function setDev(kind, s) {
  const was = devState[kind] || {};
  devState[kind] = { connected: !!s.connected, reconnecting: !!s.reconnecting, name: s.name || '' };
  const dot = $(`#btn-devices .dev-dots i[data-k="${kind}"]`);
  dot.className = s.connected ? 'on' : s.reconnecting ? 'warn' : '';
  if (motionOK() && s.connected && !was.connected) restartAnim(dot, 'pop');
  if (motionOK() && was.connected && !s.connected) restartAnim(dot, 'drop');
  devicesTitle();
  if ($('#popover.dev-pop')) renderDevicesMenu($('#popover.dev-pop'));
}

function devicesTitle() {
  const on = Object.values(devState).filter((d) => d.connected).length;
  $('#btn-devices').title = on ? t('devicesOn', { n: on }) : t('devicesNone');
}

function renderDevicesMenu(pop) {
  const saved = state.settings.devices || {};
  pop.innerHTML = `<div class="pop-title">${t('devices')}</div>${DEVICE_KINDS.map(([k, label, icon]) => {
    const d = devState[k];
    const savedName = k === 'controller' ? (saved.controllers || []).map((c) => c.name).join(' + ') : saved[k]?.name;
    const status = d.connected ? `<span class="ok-text">${esc(d.name || t('connected'))}</span>` : d.reconnecting ? `<span class="warn-text">${d.name ? t('connectingName', { name: esc(d.name) }) : t('connectingDots')}</span>` : `<span class="muted">${savedName ? t('savedOff', { name: esc(savedName) }) : t('notPaired')}</span>`;
    return `<button class="dev-row" data-dev="${k}"><span class="dev-ico ${d.connected ? 'on' : d.reconnecting ? 'warn' : ''}">${icon}</span><span class="dev-txt"><b>${t(label)}</b>${status}</span><span class="dev-act">${d.connected ? t('change') : t('connect')}</span></button>`;
  }).join('')}`;
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
  pop.onclick = (e) => { const b = e.target.closest('[data-dev]'); if (b) { close(); deviceDialog(b.dataset.dev); } };
}

// ------------------------------------------------------------------ profiles
function whoIsRiding() {
  return new Promise((resolve) => {
    openModal(`
      <div class="who">
        <h2>${t('whoRiding')}</h2>
        <div class="who-grid">${profiles.map((p) => `<button class="who-card" data-id="${esc(p.id)}">${avatar(p, 'xl')}<span>${esc(p.name)}</span></button>`).join('')}</div>
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
  openModal(`
    <div class="pv-head"><h2>${t('editRider')}</h2><button class="icon-btn" data-a="close" aria-label="${t('close')}">✕</button></div>
    <div class="pe">
      <div class="pe-preview" id="pe-preview">${preview()}</div>
      <div class="pe-fields">
        <label class="pe-name">${t('name')}<input type="text" name="pname" value="${esc(p.name)}" maxlength="40" autocomplete="off"></label>
        <div class="pe-label">${t('colour')}</div>
        <div class="swatches" id="pe-colors">${AVATAR_COLORS.map((c) => `<button type="button" data-c="${c}" style="--sw:${c}" class="${avatarBg({ ...p, avatar: cur }) === c ? 'on' : ''}" aria-label="${c}"></button>`).join('')}<label class="sw-custom" title="${t('customColour')}"><input type="color" id="pe-custom" value="${avatarBg(p)}">＋</label></div>
        <div class="pe-label">${t('emoji')} <small class="muted">${t('emojiHint')}</small></div>
        <div class="emoji-grid" id="pe-emoji"><button type="button" data-e="" class="${cur.emoji ? '' : 'on'}" title="${t('initials')}">${esc(initials(p.name))}</button>${AVATAR_EMOJI.map((e) => `<button type="button" data-e="${e}" class="${cur.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div>
        <input type="text" id="pe-emoji-own" class="pe-own" placeholder="${t('emojiOwn')}${PLAT.emojiKey}" maxlength="8" value="${cur.emoji && !AVATAR_EMOJI.includes(cur.emoji) ? esc(cur.emoji) : ''}">
      </div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-a="back">${t('back')}</button><button class="btn primary" data-a="save">${t('save')}</button></div>`, 'small');
  const refresh = () => {
    $('#pe-preview', modal).replaceChildren(avatarNode(previewProfile(), 'xl'));
    $$('#pe-colors [data-c]', modal).forEach((x) => x.classList.toggle('on', x.dataset.c === cur.color));
    $$('#pe-emoji [data-e]', modal).forEach((x) => x.classList.toggle('on', (x.dataset.e || null) === cur.emoji));
  };
  $('#pe-colors', modal).onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { cur.color = b.dataset.c; refresh(); } };
  $('#pe-custom', modal).oninput = (e) => { cur.color = safeColor(e.target.value); refresh(); };
  $('#pe-emoji', modal).onclick = (e) => { const b = e.target.closest('[data-e]'); if (b) { cur.emoji = b.dataset.e || null; $('#pe-emoji-own', modal).value = ''; refresh(); } };
  $('#pe-emoji-own', modal).oninput = (e) => { cur.emoji = e.target.value.trim() || null; refresh(); };
  $('[name=pname]', modal).oninput = refresh;
  $$('[data-a]', modal).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'close') return closeModal();
    if (a === 'back') return profileMenu();
    if (a === 'save') {
      try {
        const r = await invoke('edit_profile', { id: p.id, name: $('[name=pname]', modal).value, avatar: cur });
        applyAppState(r);
        scheduleSync();
        profileMenu();
      } catch (err) { toast(String(err)); }
    }
  }));
}

function profileMenu() {
  if (ride) return toast(t('finishToSwitch'));
  openModal(`
    <div class="pv-head"><h2>${t('riders')}</h2><button class="icon-btn" data-a="close" aria-label="${t('close')}">✕</button></div>
    <div class="profile-list">
      ${profiles.map((p) => `
        <div class="profile-row ${p.id === state.id ? 'on' : ''}" data-id="${esc(p.id)}">
          <button class="profile-pick" data-a="switch">${avatar(p)}<span>${esc(p.name)}</span>${p.id === state.id ? `<small class="muted">· ${t('riding')}</small>` : ''}</button>
          <button class="btn ghost sm" data-a="edit">${t('edit')}</button>
          ${profiles.length > 1 ? `<button class="btn ghost sm" data-a="delete">${t('delete')}</button>` : ''}
        </div>`).join('')}
    </div>
    <form class="add-profile" id="add-profile"><input type="text" name="name" placeholder="${t('newRiderName')}" maxlength="40" autocomplete="off"><button class="btn primary" type="submit">${t('addRider')}</button></form>
    <p class="muted small">${t('ridersHint')}</p>`, 'small');
  $('#add-profile', modal).onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try { closeModal(); await afterProfileChange(await invoke('create_profile', { name })); toast(t('welcomeRider', { name })); openSettings('rider'); }
    catch (err) { toast(String(err)); }
  };
  $('.profile-list', modal).onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    const p = profiles.find((x) => x.id === id);
    if (b.dataset.a === 'switch') { closeModal(); if (id !== state.id) await afterProfileChange(await invoke('switch_profile', { id })); }
    if (b.dataset.a === 'edit') return profileEditor(p);
    if (b.dataset.a === 'delete') {
      if (await confirmDialog(t('deleteRiderQ', { name: p.name }), t('deleteRiderText'), t('delete'), true)) {
        await afterProfileChange(await invoke('delete_profile', { id }));
      } else profileMenu();
    }
  };
  $('[data-a=close]', modal).onclick = closeModal;
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

function renderEmpty() {
  const missing = library.exists === false;
  const root = `<code>${esc(library.root)}</code>`;
  $('#view').innerHTML = `<section class="hero card empty"><h1>${missing ? t('emptyChoose') : t('emptyNone')}</h1>
    <p>${missing ? t('emptyMissing', { dir: root }) : t('emptyNoFiles', { dir: root })} ${t('emptyHint')}</p>
    <div class="upnext-actions" style="margin-top:16px"><button class="btn primary" data-act="pick-dir">${t('chooseFolder')}</button></div></section>`;
  bindActions($('#view'));
}

function progressBar(pp, id) {
  const d = (pp.done / pp.total) * 100, s = (pp.skipped / pp.total) * 100;
  return `<div class="pbar"${id ? ` data-pid="${esc(id)}" data-d="${d}" data-s="${s}"` : ''} title="${t('progressTitle', { done: pp.done, skipped: pp.skipped, total: pp.total })}"><i class="d" style="width:${d}%"></i><i class="s" style="width:${s}%"></i></div>`;
}

function weekDay(w) {
  return w.week ? `<span class="wd">${t('weekDayShort', { w: w.week, d: w.day })}</span>` : '';
}

function renderHome() {
  const v = $('#view');
  const active = state.activePlan && planById(state.activePlan);
  let hero;
  if (active) {
    const pp = planProgress(active);
    const n = pp.next;
    hero = `
      <section class="hero card">
        <div class="hero-head">
          <div>
            <div class="eyebrow">${t('activePlan')}</div>
            <h1><a href="#/plan/${encodeURIComponent(active.id)}">${esc(active.name)}</a></h1>
          </div>
          <div class="hero-count"><b>${pp.done + pp.skipped}</b>/${pp.total}<small>${t('doneSkipped', { done: pp.done, skipped: pp.skipped })}</small></div>
        </div>
        ${progressBar(pp, active.id)}
        ${n ? `
        <div class="upnext">
          <div class="upnext-info">
            <div class="eyebrow">${t('upNext')} ${weekDay(n)}</div>
            <h2>${esc(n.title)}</h2>
            <div class="meta">${fmtDur(n.duration)} · TSS ~${n.tss}${lastRidden.has(n.file) ? ` · ${lastRiddenText(n.file)}` : ''}</div>
          </div>
          <div class="upnext-profile">${miniProfile(n.profile, bounds(), { width: 420, height: 64 })}</div>
          <div class="upnext-actions">
            <button class="btn primary big" data-act="start-next">${t('startWorkout')}</button>
            <button class="btn ghost" data-act="preview" data-file="${esc(n.file)}">${t('details')}</button>
            <button class="btn ghost" data-act="skip-next">${t('skip')}</button>
          </div>
        </div>` : `<div class="upnext-done"><p class="done-msg">${t('planFinished')}</p><button class="btn primary" data-act="close-plan">${t('pickNewPlan')}</button></div>`}
      </section>`;
  } else {
    hero = `<section class="hero card empty"><h1>${t('pickPlan')}</h1><p>${t('pickPlanText', { dir: `<code>${esc(library.root)}</code>`, workouts: `<a href="#/" data-act="mode-workouts" class="link">${t('modeWorkouts')}</a>` })}</p></section>`;
  }

  const plans = library.plans.filter(isPlan);
  const collections = library.plans.length - plans.length;
  v.innerHTML = `
    ${hero}
    <section class="section">
      <div class="section-head">
        <h2>${t('plans')} <small>${plans.length}</small></h2>
        <input type="search" id="plan-search" placeholder="${t('filterPlans')}" autocomplete="off">
      </div>
      <div class="plan-grid" id="plan-grid"></div>
      ${collections ? `<p class="muted small coll-note">${t('collNote', { n: collections, workouts: `<a href="#/" data-act="mode-workouts" class="link">${t('modeWorkouts')}</a>` })}</p>` : ''}
    </section>`;
  const grid = $('#plan-grid');
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    grid.innerHTML = plans.filter((p) => !ql || p.name.toLowerCase().includes(ql) || p.id.toLowerCase().includes(ql)).map((p) => {
      const pp = planProgress(p);
      const isActive = state.activePlan === p.id;
      return `<a class="plan-card card ${isActive ? 'active' : ''}" href="#/plan/${encodeURIComponent(p.id)}">
        <div class="pc-top"><h3>${esc(p.name)}</h3>${isActive ? `<span class="badge">${t('badgeActive')}</span>` : pp.finished ? `<span class="badge ok">${t('badgeDone')}</span>` : ''}</div>
        <div class="meta">${planMeta(p)}</div>
        ${p.description ? `<p class="pc-desc">${esc(markdownSummary(p.description, 110))}</p>` : ''}
        ${pp.started ? progressBar(pp, p.id) : ''}
      </a>`;
    }).join('') || `<p class="muted">${t('noPlansMatch')}</p>`;
  };
  draw();
  $('#plan-search').oninput = (e) => draw(e.target.value);
  bindActions(v);
}

const zoneTag = (z) => (z ? `<span class="ztag" style="--zc:${ZONES[z - 1].color}" title="${t('trainingIntensity', { zone: `${ZONES[z - 1].short} ${ZONES[z - 1].name}` })}">${ZONES[z - 1].short}</span>` : '');

function workoutRow(w, { status, isNext, locked, free, showFolder, note, favTools } = {}) {
  const icon = status === 'done' ? `<span class="st done${justDone === w.file && !document.body.classList.contains('riding') ? ' just-done' : ''}" title="${t('stDone')}">✓</span>`
    : status === 'skipped' ? `<span class="st skipped" title="${t('stSkipped')}">↷</span>`
      : isNext ? `<span class="st next" title="${t('upNext')}">●</span>`
        : locked ? `<span class="st locked" title="${t('stLocked')}">🔒</span>`
          : lastRidden.has(w.file) ? `<span class="st ridden" title="${t('stRidden')}">✓</span>` : '<span class="st"></span>';
  const folder = showFolder ? (planById(folderOf(w.file))?.name || '') : '';
  const wd = w.week && showWeekDay(w);
  const sub = [note, folder, wd ? t('weekDayShort', { w: w.week, d: w.day }) : '', lastRiddenText(w.file)].filter(Boolean).join(' · ');
  return `<div class="wrow ${isNext ? 'is-next' : ''} ${status || ''}" data-act="preview" data-file="${esc(w.file)}" tabindex="0">
    ${icon}
    <div class="wtitle">${!showFolder && wd ? `<span class="wd">${t('dayShort', { d: w.day })}</span>` : ''}<div class="wt"><span>${esc(w.title)}</span>${sub && (showFolder || note || lastRidden.has(w.file)) ? `<small>${esc(showFolder || note ? sub : lastRiddenText(w.file))}</small>` : ''}</div></div>
    <div class="wprof">${miniProfile(w.profile, bounds(), { width: 200, height: 28 })}</div>
    <div class="wdur">${fmtDur(w.duration)}</div>
    <div class="wtss">${zoneTag(w.zone)}<span title="${t('tssTitle')}">${w.tss ?? '–'}<small> TSS</small></span></div>
    <div class="wact">${favTools ? `<span class="favtools"><button class="btn ghost sm" data-act="fav-up" data-file="${esc(w.file)}" title="${t('moveUp')}">↑</button><button class="btn ghost sm" data-act="fav-down" data-file="${esc(w.file)}" title="${t('moveDown')}">↓</button></span>` : ''}${starBtn(w.file)}<button class="more" data-act="more" data-file="${esc(w.file)}" title="${t('more')}" aria-label="${t('moreActions')}">⋯</button>${isNext ? `<button class="btn primary sm" data-act="start-next">${t('start')}</button><button class="btn ghost sm" data-act="skip-next">${t('skip')}</button>`
      : status === 'skipped' ? `<button class="btn ghost sm" data-act="unskip" data-file="${esc(w.file)}">${t('undoSkip')}</button>`
        : free ? `<button class="btn ghost sm" data-act="ride-free" data-file="${esc(w.file)}">${t('ride')}</button>` : ''}</div>
  </div>`;
}

function renderPlan(id) {
  const plan = planById(id);
  const v = $('#view');
  if (!plan) { v.innerHTML = `<p class="muted">${t('planNotFound')} <a href="#/">${t('back')}</a></p>`; return; }
  const pp = planProgress(plan);
  const isActive = state.activePlan === plan.id;

  const groups = new Map();
  for (const w of plan.workouts) {
    const k = planWeeks(plan) && w.week ? t('weekN', { n: w.week }) : t('modeWorkouts');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  const rows = [...groups].map(([k, ws]) => `
    <div class="week"><h3>${esc(k)}</h3><div class="wlist">
      ${ws.map((w) => {
        const e = pp.entries[w.file];
        const isNext = isActive && pp.next?.file === w.file;
        const locked = isActive && !e && !isNext;
        return workoutRow(w, { status: e?.status, isNext, locked });
      }).join('')}
    </div></div>`).join('');

  const actions = isActive
    ? `<button class="btn ghost" data-act="pause-plan">${t('leavePlan')}</button>`
    : pp.finished ? `<button class="btn primary" data-act="restart-plan" data-plan="${esc(plan.id)}">${t('startAgain')}</button>`
      : `<button class="btn primary" data-act="start-plan" data-plan="${esc(plan.id)}">${pp.started ? t('resumePlan') : t('startPlan')}</button>`;

  v.innerHTML = `
    <a class="back" href="#/">← ${t('allPlans')}</a>
    <section class="plan-head card">
      <div>
        <div class="eyebrow">${isActive ? t('activePlan') : t('plan')}</div>
        <h1>${esc(plan.name)}</h1>
        <div class="meta">${t('planMetaTotal', { meta: planMeta(plan) })} · <code>${esc(plan.id)}</code></div>
      </div>
      <div class="plan-actions">${actions}${menuBtn(`${pp.started ? `<button data-act="reset-plan" data-plan="${esc(plan.id)}">${t('resetProgressMenu')}</button>` : ''}<button data-act="reveal" data-rel="${esc(plan.id)}">${t('showIn', { app: PLAT.files })}</button><button data-act="set-kind" data-kind="collection" data-rel="${esc(plan.id)}">${t('showAsCollectionLong')}</button><hr><button class="danger-text" data-act="trash-folder" data-rel="${esc(plan.id)}">${t('trashPlanFolder', { trash: PLAT.trash })}</button>`, t('planActions'))}</div>
      ${pp.started ? `<div class="plan-prog">${progressBar(pp, plan.id)}<span class="muted">${t('doneSkippedToGo', { done: pp.done, skipped: pp.skipped, left: pp.total - pp.done - pp.skipped })}</span></div>` : ''}
    </section>
    ${descriptionBlock(plan.description)}
    ${rows}`;
  bindActions(v);
}

// ------------------------------------------------------------------ workouts mode
const wf = { folder: '', q: '', dur: 'all', sort: 'name', limit: 80, zones: new Set() };
const DUR_FILTERS = [['all', 'anyLength'], ['30', '≤ 30 min'], ['60', '30–60 min'], ['90', '60–90 min'], ['90+', '> 90 min']];

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

function renderWorkouts() {
  const v = $('#view');
  const folders = library.plans;
  const recentCount = lastRidden.size;
  v.innerHTML = `
    <div class="wk-layout">
      <aside class="wk-side">
        <button class="wk-folder ${wf.folder === '' ? 'on' : ''}" data-folder=""><span>${t('allWorkouts')}</span><small>${allWorkouts().length}</small></button>
        <button class="wk-folder ${wf.folder === '@fav' ? 'on' : ''}" data-folder="@fav"><span>★ ${t('favorites')}</span><small>${favs().filter((f) => workoutInfo(f)).length}</small></button>
        ${recentCount ? `<button class="wk-folder ${wf.folder === '@recent' ? 'on' : ''}" data-folder="@recent"><span>${t('recentlyRidden')}</span><small>${recentCount}</small></button>` : ''}
        ${library.singles.length ? `<button class="wk-folder ${wf.folder === '@singles' ? 'on' : ''}" data-folder="@singles"><span>${t('singleWorkouts')}</span><small>${library.singles.length}</small></button>` : ''}
        ${[[t('plans'), folders.filter(isPlan)], [t('collections'), folders.filter((p) => !isPlan(p))]].filter(([, l]) => l.length).map(([label, list]) => `<div class="wk-sep">${label}</div>
        ${list.map((p) => `<button class="wk-folder ${wf.folder === p.id ? 'on' : ''}" data-folder="${esc(p.id)}"><span>${esc(p.name)}</span><small>${p.count}</small></button>`).join('')}`).join('')}
      </aside>
      <section class="wk-main">
        <div class="wk-head" id="wk-head"></div>
        <div class="wk-tools">
          <input type="search" id="wk-q" placeholder="${t('searchWorkouts')}" value="${esc(wf.q)}" autocomplete="off">
          <div class="seg-ctl" id="wk-dur">${DUR_FILTERS.map(([k, l]) => `<button data-dur="${k}" class="${wf.dur === k ? 'on' : ''}">${t(l)}</button>`).join('')}</div>
          <div class="zone-filter" id="wk-zones" title="${t('filterIntensity')}">${ZONES.map((z, i) => `<button data-z="${i + 1}" class="${wf.zones.has(i + 1) ? 'on' : ''}" style="--zc:${z.color}" title="${z.short} ${z.name}"><i></i>${z.short}<span>${z.name}</span></button>`).join('')}</div>
          <select id="wk-sort">${[['name', 'name'], ['short', 'sortShortest'], ['long', 'sortLongest'], ['tss', 'sortHardest'], ['zone', 'intensity'], ['recent', 'recentlyRidden']].map(([k, l]) => `<option value="${k}" ${wf.sort === k ? 'selected' : ''}>${t(l)}</option>`).join('')}</select>
        </div>
        <div class="wk-count muted" id="wk-count"></div>
        <div class="wlist" id="wk-list"></div>
        <div class="wk-more" id="wk-more"></div>
      </section>
    </div>`;
  const head = () => {
    const f = wf.folder;
    const plan = !f.startsWith('@') && f ? planById(f) : null;
    $('#wk-head').innerHTML = plan
      ? `<h2>${esc(plan.name)}</h2><span class="badge muted">${isPlan(plan) ? t('plan') : t('collection')}</span><span class="grow"></span>${isPlan(plan) ? `<a class="btn ghost sm" href="#/plan/${encodeURIComponent(plan.id)}" data-act="open-plan">${t('openPlan')}</a>` : ''}${menuBtn(`<button data-act="reveal" data-rel="${esc(plan.id)}">${t('showIn', { app: PLAT.files })}</button>${isPlan(plan) ? `<button data-act="set-kind" data-kind="collection" data-rel="${esc(plan.id)}">${t('showAsCollection')}</button>` : `<button data-act="set-kind" data-kind="plan" data-rel="${esc(plan.id)}">${t('useAsPlan')}</button>`}<hr><button class="danger-text" data-act="trash-folder" data-rel="${esc(plan.id)}">${t('trashFolder', { trash: PLAT.trash })}</button>`, t('folderActions'))}${plan.description ? `<div class="wk-desc">${descriptionBlock(plan.description)}</div>` : ''}`
      : f === '@fav' ? `<h2>${t('favorites')}</h2><span class="muted small">${t('favHint')}</span>`
        : f === '' ? `<h2>${t('allWorkouts')}</h2><span class="grow"></span>${menuBtn(`<button data-act="reveal" data-rel="">${t('showLibraryIn', { app: PLAT.files })}</button>`, t('libraryActions'))}` : '';
    bindActions($('#wk-head'));
  };
  const draw = (animate) => {
    head();
    const list = filteredWorkouts();
    $('#wk-count').textContent = t('nWorkouts', { n: list.length });
    $('#wk-list').innerHTML = list.slice(0, wf.limit).map((w) => workoutRow(w, { free: true, showFolder: !wf.folder || wf.folder.startsWith('@'), favTools: wf.folder === '@fav' && !wf.q && wf.dur === 'all' })).join('') || `<p class="muted">${wf.folder === '@fav' ? t('noFavs') : t('nothingMatches')}</p>`;
    $('#wk-more').innerHTML = list.length > wf.limit ? `<button class="btn ghost" data-more>${t('showMoreLeft', { n: list.length - wf.limit })}</button>` : '';
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
  $('#wk-dur').onclick = (e) => { const b = e.target.closest('[data-dur]'); if (!b) return; wf.dur = b.dataset.dur; $$('#wk-dur button').forEach((x) => x.classList.toggle('on', x === b)); wf.limit = 80; draw(true); };
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
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="${t('ftpHistory')}"><polyline points="${xy.map((p) => p.join(',')).join(' ')}"/>${xy.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="3"><title>${new Date(pts[i].at).toLocaleDateString(fmtLocale())} · ${pts[i].ftp} W</title></circle>`).join('')}</svg>`;
}

function renderTests() {
  const v = $('#view');
  const F = ftp();
  const tests = state.tests || [];
  const last = tests.find((x) => x.ftp);
  const b = state.settings.bests || {};
  const libTests = allWorkouts().filter(isTestWorkout);
  const zoneRow = ZONES.map((z, i) => {
    const lo = i === 0 ? 0 : Math.round((bounds()[i - 1] / 100) * F) + 1;
    const hi = i < 4 ? Math.round((bounds()[i] / 100) * F) : null;
    return `<span class="zchip"><i style="background:${z.color}"></i>${z.short} ${hi ? `${lo}–${hi}` : `> ${lo - 1}`} W</span>`;
  }).join('');
  v.innerHTML = `
    <section class="hero card ftp-hero">
      <div class="ftp-now">
        <div class="eyebrow">${t('currentFtp')} · ${esc(state.name)}</div>
        <div class="ftp-val"><b>${F}</b> W${wkg(F) ? ` <span class="wkg">${wkg(F)} W/kg</span>` : ''}</div>
        <div class="meta">${last ? `${t('lastTest', { when: relDate(last.at), name: esc(testName(last)), ftp: last.ftp })}${last.accepted ? '' : ` ${t('notApplied')}`}` : `${tests.length ? t('noCompletedTest') : t('noTest')} — ${t('pickTestBelow')}`}</div>
      </div>
      <div class="ftp-side">
        ${ftpSparkline(tests)}
        ${(() => { const tv = tests.find((x) => x.vo2); return tv ? `<div class="vo2"><span class="k">${t('vo2Est')}</span><b>${tv.vo2}</b> ml/kg/min<small class="muted">${esc(testName(tv))} · ${relDate(tv.at)}</small></div>` : weight() ? '' : `<button class="btn ghost sm" data-act="add-weight">${t('addWeight')}</button>`; })()}
        <div class="bests">${[['5 s', b.s5], ['1 min', b.m1], ['5 min', b.m5], ['20 min', b.m20]].map(([k, val]) => `<div><span class="k">${k}</span><b>${val ? `${val} W` : '–'}</b></div>`).join('')}</div>
      </div>
      <div class="zone-strip">${zoneRow}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>${t('tests')}</h2><span class="muted small">${t('testsHint')}</span></div>
      <div class="test-grid">
        ${PROTOCOLS.map((p) => {
          const w = p.build(F);
          // a ramp ends when the rider fails — typically around FTP / 0.75
          const isRamp = p.id.startsWith('ramp');
          const rampTop = F / 0.75;
          const shown = isRamp ? { segments: w.segments.filter((x) => !x.ramp || x.p0 * F <= rampTop) } : w;
          const dur = isRamp ? `~${Math.round(shown.segments.reduce((a, x) => a + x.duration, 0) / 60)} min` : fmtDur(w.duration);
          return `<article class="test-card card">
            <div class="pc-top"><h3>${esc(p.name)}</h3><span class="badge muted">${esc(p.level)}</span></div>
            <div class="meta">${dur}</div>
            ${miniProfile(profileOf(shown), bounds(), { width: 320, height: 44 })}
            <p class="test-about">${esc(p.about)}</p>
            <div class="test-method">${esc(p.method)}</div>
            <button class="btn primary" data-act="start-test" data-test="${p.id}">${t('startTest')}</button>
          </article>`;
        }).join('')}
      </div>
    </section>
    ${libTests.length ? `<section class="section"><div class="section-head"><h2>${t('libTests')} <small>${libTests.length}</small></h2><span class="muted small">${t('libTestsHint')}</span></div>
      <div class="wlist">${libTests.map((w) => workoutRow(w, { free: true, showFolder: true, note: classifyTest(w.profile, w.title).label })).join('')}</div></section>` : ''}
    <section class="section">
      <div class="section-head"><h2>${t('testHistory')}</h2></div>
      ${tests.length ? `<div class="hlist"><div class="hrow trow hhead"><div>${t('colDate')}</div><div>${t('colTest')}</div><div class="hstat">${t('colResult')}</div><div class="hstat">${t('colChange')}</div><div></div></div>
        ${tests.map((x, i) => `<div class="hrow trow">
          <div class="hdate">${new Date(x.at).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          <div class="htitle"><b>${esc(testName(x))}</b><small class="muted">${esc([...(x.details || []).filter((d) => d[1]).map((d) => `${d[0]} ${d[1]}`), x.vo2 ? `VO2max ~${x.vo2} ml/kg/min` : ''].filter(Boolean).join(' · '))}</small></div>
          <div class="hstat">${x.ftp ? `<b>${x.ftp} W</b>` : x.incomplete ? `<span class="badge warn">${t('notCompleted')}</span>` : '<b>–</b>'}</div>
          <div class="hstat">${x.ftp && x.prevFtp ? `${x.ftp >= x.prevFtp ? '+' : ''}${Math.round(((x.ftp - x.prevFtp) / x.prevFtp) * 100)} %` : ''}</div>
          <div class="hact">${x.accepted ? `<span class="badge ok">${t('applied')}</span>` : x.ftp ? `<button class="btn ghost sm" data-act="apply-ftp" data-i="${i}">${t('useW', { w: x.ftp })}</button>` : ''}</div>
        </div>`).join('')}</div>` : `<p class="muted">${t('testResultsHere')}</p>`}
    </section>`;
  v.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    e.preventDefault();
    if (el.dataset.act === 'start-test') return startTest(el.dataset.test);
    if (el.dataset.act === 'apply-ftp') return applyFtp(state.tests[+el.dataset.i]);
    if (el.dataset.act === 'add-weight') return openSettings('rider');
    if (el.dataset.act === 'preview') return openPreview(el.dataset.file);
    if (el.dataset.act === 'ride-free') return startRide(el.dataset.file, null);
  };
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
    const sv = svcCache.find((x) => x.id === id);
    const v = h.services[id];
    return v.url ? `<a class="sync gok" data-act="open-url" data-url="${esc(v.url)}">${esc(sv?.name || id)} ✓</a>` : `<span class="sync gok">${esc(sv?.name || id)} ✓</span>`;
  }).join('');
}

/** "⋯" with upload / import actions for the other platforms. */
function historyMenu(h, i) {
  const items = svcCache.filter((sv) => svcRoute(sv) && !(h.services?.[sv.id] && !h.services[sv.id].error)).map((sv) => svcRoute(sv) === 'api'
    ? `<button data-act="h-svc" data-i="${i}" data-id="${sv.id}">${t('uploadTo', { name: esc(sv.name) })}</button>`
    : `<button data-act="h-svc-man" data-i="${i}" data-id="${sv.id}">${t('importTo', { name: esc(sv.name) })}</button>`).join('');
  return items ? menuBtn(items, t('sendOther')) : '';
}

function renderHistory() {
  const v = $('#view');
  const rows = state.history.map((h, i) => {
    return `<div class="hrow">
      <div class="hdate">${new Date(h.at).toLocaleDateString(fmtLocale(), { weekday: 'short', day: 'numeric', month: 'short' })}<small>${new Date(h.at).toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' })}</small></div>
      <div class="htitle"><b>${esc(h.title)}</b><small class="muted">${h.plan ? esc(planById(h.plan)?.name || h.plan) : t('freeRide')}${h.completed === false ? ` · ${t('endedEarly')}` : ''}</small></div>
      <div class="hstat">${fmtTime(h.doneDuration || 0)}</div>
      <div class="hstat">${h.avgPower ? `${h.avgPower} W` : '–'}</div>
      <div class="hstat">${h.avgHr ? `${h.avgHr} bpm` : '–'}</div>
      <div class="hact">${h.garmin?.url ? `<a class="sync gok" data-act="open-url" data-url="${esc(h.garmin.url)}">Garmin ✓</a>` : h.fitPath ? `<button class="btn ghost sm" data-act="h-garmin" data-i="${i}" title="${t('uploadTo', { name: 'Garmin Connect' })}">Garmin</button>` : ''}${svcBadges(h)}${h.fitPath ? `<button class="btn ghost sm" data-act="h-fit" data-i="${i}" title="${t('saveFitFile')}">FIT</button>${historyMenu(h, i)}` : ''}</div>
    </div>`;
  }).join('');
  v.innerHTML = `
    <a class="back" href="#/">← ${t('back')}</a>
    <section class="section-head"><h1>${t('rideHistory')} <small class="muted">${esc(state.name)}</small></h1></section>
    ${rows ? `<div class="hlist"><div class="hrow hhead"><div>${t('colDate')}</div><div>${t('colWorkout')}</div><div class="hstat">${t('colTime')}</div><div class="hstat">${t('colPower')}</div><div class="hstat">${t('colHr')}</div><div></div></div>${rows}</div>` : `<p class="muted">${t('noRides')}</p>`}`;
  bindActions(v);
}

function bindActions(root) {
  root.onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const act = el.dataset.act;
    const plan = state.activePlan && planById(state.activePlan);
    const h = el.dataset.i !== undefined ? state.history[+el.dataset.i] : null;
    switch (act) {
      case 'preview': return openPreview(el.dataset.file);
      case 'start-next': { const n = plan && planProgress(plan).next; if (n) startRide(n.file, plan.id); return; }
      case 'skip-next': { const n = plan && planProgress(plan).next; if (n && await confirmDialog(t('skipQ', { title: n.title }), t('skipText'), t('skip'))) markEntry(plan.id, n.file, { status: 'skipped' }); return; }
      case 'unskip': return unskip(el.dataset.file);
      case 'ride-free': return startRide(el.dataset.file, null);
      case 'start-plan': return activatePlan(el.dataset.plan);
      case 'restart-plan': delete state.plans[el.dataset.plan]; return activatePlan(el.dataset.plan);
      case 'mode-workouts': return setMode('workouts');
      case 'pause-plan':
        if (await confirmDialog(t('leavePlanQ'), t('leavePlanText'), t('leavePlan'))) { state.activePlan = null; await api.saveState(); route(); }
        return;
      case 'pick-dir': return pickDir();
      case 'close-plan': state.activePlan = null; await api.saveState(); return route();
      case 'reset-plan':
        if (await confirmDialog(t('resetQ'), t('resetText'), t('reset'), true)) {
          delete state.plans[el.dataset.plan];
          if (state.activePlan === el.dataset.plan) state.activePlan = null;
          await api.saveState(); route();
        }
        return;
      case 'fav': await toggleFav(el.dataset.file); return refreshView();
      case 'fav-up': case 'fav-down': {
        const f = favs(), i = f.indexOf(el.dataset.file), j = i + (act === 'fav-up' ? -1 : 1);
        if (i < 0 || j < 0 || j >= f.length) return;
        [f[i], f[j]] = [f[j], f[i]];
        await api.saveState();
        return refreshView();
      }
      case 'more': return moreMenu(el, el.dataset.file);
      case 'menu': return openMenu(el);
      case 'md-link': return invoke('open_link', { url: el.dataset.link }).catch((err) => toast(String(err)));
      case 'desc-toggle': {
        const box = el.closest('.plan-desc');
        const collapsed = box.classList.toggle('is-collapsed');
        if (collapsed && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      case 'open-plan': location.hash = `#/plan/${encodeURIComponent(wf.folder)}`; if (mode() !== 'plans') await setMode('plans'); return;
      case 'set-kind': {
        const id = el.dataset.rel;
        const p = planById(id);
        if (el.dataset.kind === 'collection' && state.activePlan === id) {
          if (!await confirmDialog(t('showAsCollectionQ'), t('showAsCollectionText', { name: p.name }), t('showAsCollection'))) return;
          state.activePlan = null;
        }
        state.settings.folderKinds = { ...(state.settings.folderKinds || {}), [id]: el.dataset.kind };
        await api.saveState();
        toast(el.dataset.kind === 'plan' ? t('nowPlan', { name: p.name }) : t('nowCollection', { name: p.name }));
        if (el.dataset.kind === 'plan') { if (mode() !== 'plans') await setMode('plans'); location.hash = `#/plan/${encodeURIComponent(id)}`; return; }
        if (location.hash.startsWith('#/plan/')) location.hash = '#/';
        return route();
      }
      case 'reveal': return invoke('reveal_in_library', { rel: el.dataset.rel }).catch((err) => toast(String(err)));
      case 'trash-folder': return trashItem(el.dataset.rel, true);
      case 'open-url': return invoke('open_url', { url: el.dataset.url }).catch((err) => toast(String(err)));
      case 'h-fit': return exportFit(h.fitPath);
      case 'h-svc-man': return manualImport(el.dataset.id, h.fitPath);
      case 'h-svc': {
        toast(t('uploading'));
        try { await uploadToService(h, el.dataset.id); toast(t('uploaded')); } catch (err) { toast(String(err.message || err)); }
        return refreshView();
      }
      case 'h-garmin': {
        const g = await invoke('garmin_status').catch(() => ({}));
        if (!g.connected) return garminImport(h.fitPath);
        el.disabled = true; el.textContent = t('uploading');
        await uploadToGarmin(h).catch((err) => toast(String(err)));
        return renderHistory();
      }
    }
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
const menuBtn = (items, label = t('moreActions')) => `<span class="menu-wrap"><button class="more" data-act="menu" title="${label}" aria-label="${label}">⋯</button><template>${items}</template></span>`;

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

function moreMenu(anchor, file) {
  $('#popover')?.remove();
  const r = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.id = 'popover';
  pop.className = 'popover';
  pop.innerHTML = `
    <button data-p="fav">${isFav(file) ? `★ ${t('favRemove')}` : `☆ ${t('favAdd')}`}</button>
    <button data-p="reveal">${t('showIn', { app: PLAT.files })}</button>
    <button data-p="folder">${t('openItsFolder')}</button>
    <hr><button data-p="trash" class="danger-text">${t('trashWorkout', { trash: PLAT.trash })}</button>`;
  document.body.appendChild(pop);
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
  const close = () => { pop.remove(); document.removeEventListener('click', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('click', outside, true));
  pop.onclick = async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    close();
    const a = b.dataset.p;
    if (a === 'fav') { await toggleFav(file); refreshView(); }
    if (a === 'reveal') invoke('reveal_in_library', { rel: file }).catch((err) => toast(String(err)));
    if (a === 'folder') { const f = folderOf(file); if (mode() !== 'workouts') await setMode('workouts'); wf.folder = f && planById(f) ? f : '@singles'; route(); }
    if (a === 'trash') trashItem(file, false);
  };
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
function openModal(html, cls = '') {
  if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; } // reopened while fading out: keep it open
  modal.className = cls;
  $('.modal-body', modal).innerHTML = html;
  if (!modal.open) modal.showModal();
  return modal;
}
function closeModal() {
  if (!modal.open || modalCloseTimer) return;
  if (!motionOK()) return modal.close();
  modal.classList.add('closing');
  modalCloseTimer = setTimeout(() => { modalCloseTimer = null; modal.classList.remove('closing'); modal.close(); }, 120);
}
modal.addEventListener('click', (e) => { if (e.target === modal && !modal.classList.contains('sticky')) closeModal(); });
modal.addEventListener('cancel', (e) => { if (modal.classList.contains('sticky')) e.preventDefault(); });

function confirmDialog(title, text, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal-actions"><button class="btn ghost" data-r="0">${t('cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`, 'small');
    const done = (r) => { modal.removeEventListener('close', onClose); closeModal(); resolve(r); };
    const onClose = () => resolve(false);
    modal.addEventListener('close', onClose, { once: true });
    $$('[data-r]', modal).forEach((b) => (b.onclick = () => done(b.dataset.r === '1')));
  });
}

function promptDialog(title, value = '') {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><form id="pf"><input type="text" name="v" value="${esc(value)}" maxlength="40" class="full" autocomplete="off"><div class="modal-actions"><button class="btn ghost" type="button" data-r="0">${t('cancel')}</button><button class="btn primary" type="submit">${t('save')}</button></div></form>`, 'small');
    let settled = false;
    const f = $('#pf', modal);
    f.v.select();
    f.onsubmit = (e) => { e.preventDefault(); settled = true; const v = f.v.value.trim(); closeModal(); resolve(v || null); };
    $('[data-r]', modal).onclick = () => { settled = true; closeModal(); resolve(null); };
    modal.addEventListener('close', () => { if (!settled) resolve(null); }, { once: true });
  });
}

let toastTimer;
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

async function openPreview(file) {
  const info = workoutInfo(file);
  openModal(`<div class="loading">${t('loading')}</div>`, 'wide');
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
  const planLink = plan && isPlan(plan) && !onPlanPage ? `<button class="btn ghost" data-a="plan" title="${t('goTo', { name: esc(plan.name) })}">${t('openPlan')}</button>` : '';
  let actions = '';
  if (mode() !== 'plans') actions = `<span class="muted small">${t('freeRideNotCounted')}</span>${planLink}<button class="btn primary" data-a="free">${t('ride')}</button>`;
  else if (isNext) actions = `${planLink}<button class="btn ghost" data-a="skip">${t('skip')}</button><button class="btn primary" data-a="start">${t('startWorkout')}</button>`;
  else if (inActive) actions = `<span class="muted">${entry ? (entry.status === 'done' ? t('markedDone') : t('markedSkipped')) : t('lockedText')}</span>${planLink}`;
  else if (plan) actions = `<span class="muted small">${t('partOf', { name: esc(plan.name) })}</span><button class="btn primary" data-a="plan">${t('openPlan')}</button>`;
  else actions = `<button class="btn primary" data-a="free">${t('ride')}</button>`;

  const lr = lastRiddenText(file);
  openModal(`
    <div class="pv-head">
      <div><div class="eyebrow">${plan ? esc(plan.name) : t('workout')}${info?.week && showWeekDay(info) ? ` · ${t('weekDayLong', { w: info.week, d: info.day })}` : ''}</div><h2>${esc(info?.title || workout.name)}</h2>
      <div class="meta">${fmtDur(workout.duration)} · TSS ~${estimateTss(workout.segments)} · ${t('nSegments', { n: workout.segments.length })}${workout.author ? ` · ${esc(workout.author)}` : ''}${lr ? ` · <b class="lr">${esc(lr)}</b>` : ''}</div></div>
      <div class="pv-tools">${starBtn(file)}<button class="more" data-act="more" data-file="${esc(file)}" title="${t('more')}" aria-label="${t('moreActions')}">⋯</button><button class="icon-btn" data-a="close" aria-label="${t('close')}">✕</button></div>
    </div>
    <div class="pv-diagram"></div>
    <div class="seg-info muted">${t('tapSegment', { ftp: ftp() })}</div>
    ${zoneBreakdown(workout)}
    ${workout.description ? `<p class="pv-desc">${esc(workout.description)}</p>` : ''}
    <div class="modal-actions">${actions}</div>`, 'wide');

  $('.pv-tools', modal).onclick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'fav') { await toggleFav(file); el.outerHTML = starBtn(file); refreshView(); }
    if (el.dataset.act === 'more') { closeModal(); setTimeout(() => moreMenu(document.querySelector(`.wrow[data-file="${CSS.escape(file)}"] .more`) || el, file), 0); }
  };
  const d = new Diagram($('.pv-diagram', modal), workout, {
    bounds: bounds(), ftp: ftp(),
    onSelect: (i, s) => { d.highlight(i); $('.seg-info', modal).innerHTML = segmentText(s); },
  });
  if (motionOK()) d.segEls.forEach((g, i) => { g.style.animationDelay = `${80 + Math.min(i, 30) * 12}ms`; g.classList.add('grow'); });
  $$('[data-a]', modal).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'close') return closeModal();
    closeModal();
    if (a === 'start') startRide(file, active.id);
    if (a === 'free') startRide(file, null);
    if (a === 'plan') { if (mode() !== 'plans') await setMode('plans'); location.hash = `#/plan/${encodeURIComponent(planId)}`; }
    if (a === 'skip' && await confirmDialog(t('skipQ', { title: info.title }), t('skipText'), t('skip'))) markEntry(active.id, file, { status: 'skipped' });
  }));
}

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

function segmentText(s) {
  const kind = t({ steady: 'segSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'segOn', off: 'segOff', freeride: 'freeRide', maxeffort: 'maxEffort' }[s.type] || 'segment');
  const z = s.p0 !== null ? zoneOf((s.p0 + s.p1) / 2, bounds()) : null;
  return `<b>${s.label}${s.reps ? ` (${s.rep}/${s.reps})` : ''}</b> ${kind} · ${fmtTime(s.duration)} · ${targetText(s)}${s.cadence ? ` · ${s.cadence} rpm` : ''}${z ? ` · <span style="color:var(--z${z.id}-ink)">${z.short} ${z.name}</span>` : ''}`;
}

// ------------------------------------------------------------------ settings
/** Upload mode selector: “Off / manual / auto”. */
function syncMode(svc) {
  return (state.settings[svc] || {}).mode || 'auto';
}
const MODES = [['off', 'off'], ['manual', 'manual'], ['auto', 'automatic']];
const modeSelect = (name, cur) => `<div class="frow sync-mode">${t('upload')} <span class="seg-ctl" data-mode-ctl="${name}">${MODES.map(([k, l]) => `<button type="button" data-v="${k}" class="${cur === k ? 'on' : ''}">${t(l)}</button>`).join('')}</span></div>`;

/** Language of the UI right now: the rider's choice, else the system language. */
const uiLang = () => coerceLocale(state.settings.language) || systemLocale();

/** Hint under a platform in Settings: our own text when we have one, else what Rust sent. */
const svcHint = (sv) => (t(`svcHint.${sv.id}`) !== `svcHint.${sv.id}` ? t(`svcHint.${sv.id}`) : esc(sv.hint));

async function openSettings(tab = 'rider') {
  const s = state.settings;
  const themeBefore = s.theme || 'system';
  const [garmin, targets, svcs] = await Promise.all([invoke('garmin_status').catch(() => ({})), invoke('sync_targets').catch(() => []), refreshServices()]);
  const svcCard = (sv) => {
    const mode = svcMode(sv);
    const status = sv.connected ? (sv.account ? t('connectedAs', { name: esc(sv.account) }) : t('connectedCap')) : sv.kind === 'manual' ? t('manualImport') : t('notConnected');
    const action = sv.connected ? `<button class="btn ghost sm" data-a="svc-off" data-id="${sv.id}">${t('disconnect')}</button>` : '';
    let body = '';
    if (sv.connected) body = modeSelect(`svc-${sv.id}`, mode);
    else if (sv.kind === 'apikey') body = `<div class="cred"><input type="password" name="key-${sv.id}" placeholder="${t('apiKeyPlaceholder', { name: esc(sv.name) })}" autocomplete="off"><button class="btn primary sm" data-a="svc-key" data-id="${sv.id}">${t('connect')}</button></div>
      <p class="muted small">${svcHint(sv)} <a href="#" class="link" data-a="svc-getkey">${t('openIntervalsSettings')}</a></p>`;
    else if (sv.manualUrl) body = `<div class="frow sync-mode">${t('afterRide')} <span class="seg-ctl" data-mode-ctl="svc-${sv.id}">${[['off', 'off'], ['manual', 'showImportButton']].map(([k, l]) => `<button type="button" data-v="${k}" class="${mode === k ? 'on' : ''}">${t(l)}</button>`).join('')}</span></div><p class="muted small">${svcHint(sv)}</p>`;
    return `<div class="svc svc-ext ${sv.connected ? 'on' : ''}"><div class="svc-head"><span class="svc-logo ext">${SVC_LOGO[sv.id] || sv.name[0]}</span><div><b>${esc(sv.name)}</b><small class="muted">${status}</small></div>${action}</div>${body}</div>`;
  };
  const sp = syncOn() ? syncCfg.provider : 'off';
  const syncRow = (id, label, path, found, extra = '') => `<label class="sync-opt ${found ? '' : 'na'}"><input type="radio" name="syncp" value="${id}" ${sp === id ? 'checked' : ''} ${found ? '' : 'disabled'}><span><b>${label}</b><small class="muted">${extra || (path ? esc(path.replace(/^\/Users\/[^/]+/, '~')) : t('syncNotFound', { where: PLAT.onThisMachine }))}</small></span></label>`;
  openModal(`
    <div class="pv-head"><h2>${t('settings')} <small class="muted">· ${esc(state.name)}</small></h2><button class="icon-btn" data-a="close" aria-label="${t('close')}">✕</button></div>
    <div class="tabs" id="set-tabs">${[['rider', 'tabRider'], ['app', 'tabApp'], ['sync', 'tabConnections']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${t(l)}</button>`).join('')}</div>

    <div class="tab-pane" data-pane="rider" ${tab === 'rider' ? '' : 'hidden'}>
      <div class="form">
        <label>FTP <span><input type="number" name="ftp" value="${s.ftp}" min="50" max="600"> W</span></label>
        <label>${t('maxHr')} <span><input type="number" name="maxHr" value="${s.maxHr}" min="100" max="230"> bpm</span></label>
        <label>${t('weight')} <span><input type="number" name="weight" value="${s.weight ?? ''}" min="30" max="200" step="0.1" placeholder="kg"> kg</span></label>
      </div>
      <h3>${t('personalBests')} <small class="muted">${t('personalBestsHint')}</small></h3>
      <div class="bests-form">${[['s5', '5 s'], ['m1', '1 min'], ['m5', '5 min'], ['m20', '20 min']].map(([k, l]) => `<label>${l}<span><input type="number" name="b_${k}" value="${s.bests?.[k] ?? ''}" min="0" max="3000"> W</span></label>`).join('')}</div>
      <h3>${t('trainingZones')} <small class="muted">${t('trainingZonesHint')}</small></h3>
      <div class="zone-form">
        ${ZONES.map((z, i) => `<div class="zf"><i style="background:${z.color}"></i><span>${z.short} ${z.name}</span>
          ${i < 4 ? `<span>≤ <input type="number" name="z${i}" value="${s.zones[i]}" min="30" max="200"> %</span>` : `<span>&gt; <em id="z5-lim">${s.zones[3]}</em> %</span>`}</div>`).join('')}
      </div>
    </div>

    <div class="tab-pane" data-pane="app" ${tab === 'app' ? '' : 'hidden'}>
      <div class="form">
        <div class="frow">${t('appearance')} <span class="seg-ctl" id="theme-ctl">${['system', 'light', 'dark'].map((th) => `<button type="button" data-theme="${th}" class="${(s.theme || 'system') === th ? 'on' : ''}">${t(THEME_LABEL[th])}</button>`).join('')}</span></div>
        <div class="frow">${t('language')} <span class="seg-ctl" id="lang-ctl">${LOCALES.map((l) => `<button type="button" data-lang="${l.value}" lang="${l.value}" class="${uiLang() === l.value ? 'on' : ''}">${l.nativeLabel}</button>`).join('')}</span></div>
        <label class="check"><input type="checkbox" name="beeps" ${s.beeps ? 'checked' : ''}> ${t('optBeeps')}</label>
        <label class="check"><input type="checkbox" name="autoPause" ${s.autoPause !== false ? 'checked' : ''}> ${t('optAutoPause')}</label>
        <label class="check"><input type="checkbox" name="coachHints" ${s.coachHints !== false ? 'checked' : ''}> ${t('optCoach')}</label>
      </div>
      <h3>${t('workoutsFolder')}</h3>
      <div class="folder-row"><code>${esc(library.root)}</code><button class="btn ghost sm" data-a="dir">${t('changeDots')}</button><button class="btn ghost sm" data-a="rescan" title="${t('rescanTitle')}">${t('rescan')}</button></div>
      <h3>${t('virtualShifting')} <small class="muted">${t('virtualShiftingHint')}</small></h3>
      <div class="form">
        <div class="frow">${t('vsDefault')} <span class="seg-ctl" id="vs-mode">${[['ask', 'vsAsk'], ['gears', 'realGears'], ['virtual', 'virtualGears']].map(([k, l]) => `<button type="button" data-v="${k}" class="${shifting().mode === k ? 'on' : ''}">${t(l)}</button>`).join('')}</span></div>
        <div class="frow">${t('difficulty')} <span class="seg-ctl" id="vs-diff">${['easy', 'medium', 'hard'].map((k) => `<button type="button" data-v="${k}" class="${shifting().difficulty === k ? 'on' : ''}">${t(`diff.${k}`)}</button>`).join('')}</span></div>
        <label>${t('gearRange')} <span><input type="number" name="vsMin" value="${shifting().minRatio}" min="0.4" max="2" step="0.05"> – <input type="number" name="vsMax" value="${shifting().maxRatio}" min="2.5" max="7" step="0.05"></span></label>
        <label>${t('startGear')} <span><input type="number" name="vsStart" value="${shifting().startGear}" min="1" max="${shifting().gears}"> ${t('ofN', { n: shifting().gears })}</span></label>
      </div>
      <h3>${t('devices')}</h3>
      <p class="muted small">${t('devicesSummary', { trainer: esc(s.devices?.trainer?.name || t('none')), hr: esc(s.devices?.hr?.name || t('none')), shifter: esc((s.devices?.controllers || []).map((c) => c.name).join(' + ') || t('none')) })}</p>
      <h3>${t('about')}</h3>
      <p class="muted small">zwoTrainer <span id="app-ver"></span> · ${t('mitLicense')} · © 2026 SteffenR</p>
      ${updPrefs.available ? `<div class="form upd-form"><div class="frow"><label class="check"><input type="checkbox" id="upd-auto" ${updPrefs.auto !== false ? 'checked' : ''}> ${t('updAuto')}</label><button class="btn ghost sm" data-a="upd-check">${t('checkNow')}</button></div></div>` : ''}
      <div class="about-links">
        <button class="btn ghost sm" data-a="link" data-url="https://steffenr.github.io/zwo-trainer/">${t('website')}</button>
        <button class="btn ghost sm" data-a="link" data-url="https://github.com/steffenr/zwo-trainer">${t('sourceCode')}</button>
        <button class="btn ghost sm" data-a="link" data-url="https://github.com/steffenr/zwo-trainer/releases/latest/download/THIRD-PARTY-NOTICES.html">${t('thirdParty')}</button>
        <button class="btn ghost sm" data-a="link" data-url="https://buymeacoffee.com/steffenr">☕ ${t('buyCoffee')}</button>
      </div>
    </div>

    <div class="tab-pane" data-pane="sync" ${tab === 'sync' ? '' : 'hidden'}>
      <div class="svc">
        <div class="svc-head"><span class="svc-logo sync"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/></svg></span>
          <div><b>${t('profileSync')}</b><small class="muted" id="sync-status">${syncOn() ? `${syncLabel(sp)} · ${syncCfg.lastError ? `<span class="warn-text">${esc(syncCfg.lastError)}</span>` : syncCfg.lastSync ? t('lastSynced', { when: agoText(syncCfg.lastSync) }) : t('notSyncedYet')}` : t('syncOffStatus', { where: PLAT.onThisMachine })}</small></div>
          ${syncOn() ? `<button class="btn ghost sm" data-a="sync-now">${t('syncNow')}</button>` : ''}</div>
        <div class="sync-opts" id="sync-opts">
          ${syncRow('off', t('off'), null, true, t('syncOffHint', { where: PLAT.onThisMachine }))}
          ${targets.map((tg) => syncRow(tg.provider, tg.label, tg.path, tg.found)).join('')}
          ${syncRow('folder', t('otherFolder'), sp === 'folder' ? syncCfg.dir : null, true, sp === 'folder' ? esc(syncCfg.dir) : t('otherFolderHint'))}
        </div>
        <p class="muted small">${t('syncHint', { machine: PLAT.machine })}</p>
      </div>
      <div class="svc">
        <div class="svc-head"><span class="svc-logo garmin">G</span><div><b>Garmin Connect</b><small class="muted">${garmin.connected ? (garmin.name ? t('signedInAs', { name: esc(garmin.name) }) : t('signedIn')) : t('notSignedIn')}</small></div>
          ${garmin.connected ? `<button class="btn ghost sm" data-a="garmin-off">${t('signOut')}</button>` : `<button class="btn garmin" data-a="garmin-on">${t('signInGarmin')}</button>`}</div>
        ${garmin.connected ? modeSelect('garminMode', syncMode('garmin')) : `<p class="muted small">${t('garminHint', { where: PLAT.onThisMachine })}</p>`}
        <p class="muted small">${t('stravaHint')}</p>
        <details class="adv">
          <summary>${t('manualFit')}</summary>
          <p class="muted small">${t('manualFitHint', { app: PLAT.files })}</p>
          <div class="folder-row"><code>${esc(s.garmin?.folder || 'Downloads')}</code><button class="btn ghost sm" data-a="garmin-dir">${t('changeDots')}</button></div>
          <label class="check"><input type="checkbox" name="garminAuto" ${s.garmin?.autoOpen ? 'checked' : ''}> ${t('manualFitAuto')}</label>
        </details>
      </div>
      <h3 class="svc-group">${t('morePlatforms')}</h3>
      ${svcs.map(svcCard).join('')}
    </div>

    <div class="modal-actions"><button class="btn ghost" data-a="cancel">${t('cancel')}</button><button class="btn primary" data-a="save">${t('save')}</button></div>`, 'small settings');

  $('#set-tabs', modal).onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('#set-tabs button', modal).forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab-pane', modal).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  };
  const z3 = $('[name=z3]', modal);
  z3.oninput = () => ($('#z5-lim', modal).textContent = z3.value);
  $('#sync-opts', modal).onchange = async (e) => {
    const v = e.target.value;
    collect(); await api.saveState();
    let dir = null;
    if (v === 'folder') { dir = await invoke('pick_sync_dir').catch((err) => toast(String(err))); if (!dir) return openSettings('sync'); }
    else if (v !== 'off') dir = targets.find((tg) => tg.provider === v)?.path;
    try {
      syncCfg = await invoke('sync_config', { provider: v, dir, auto: true });
      if (syncOn()) await runSync(false); else toast(t('profileSyncOff'));
    } catch (err) { toast(String(err)); }
    openSettings('sync');
  };
  $('#theme-ctl', modal).onclick = (e) => {
    const th = e.target.closest('[data-theme]')?.dataset.theme;
    if (!th) return;
    s.theme = th;
    applyTheme();
    $$('#theme-ctl button', modal).forEach((x) => x.classList.toggle('on', x.dataset.theme === th));
  };
  // a new language applies at once: keep what was typed, save, redraw the app and this dialog
  $('#lang-ctl', modal).onclick = async (e) => {
    const l = e.target.closest('[data-lang]')?.dataset.lang;
    if (!l || l === uiLang()) return;
    collect();
    s.language = l;
    await api.saveState();
    applyLanguage();
    renderProfileChip();
    if (!ride) route(); // the ride screen picks the language up with the next ride
    toast(t('languageSet', { label: LOCALES.find((x) => x.value === l).nativeLabel }));
    openSettings('app');
  };
  $$('#vs-mode, #vs-diff', modal).forEach((ctl) => (ctl.onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (b) $$('button', ctl).forEach((x) => x.classList.toggle('on', x === b));
  }));
  $$('[data-mode-ctl]', modal).forEach((ctl) => (ctl.onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (b) $$('button', ctl).forEach((x) => x.classList.toggle('on', x === b));
  }));
  const collect = () => {
    const f = (n) => $(`[name=${n}]`, modal);
    s.ftp = Math.round(+f('ftp').value) || s.ftp;
    s.maxHr = Math.round(+f('maxHr').value) || s.maxHr;
    { const kg = Math.round(+f('weight').value * 10) / 10; s.weight = kg >= 30 && kg <= 200 ? kg : null; }
    s.beeps = f('beeps').checked;
    s.autoPause = f('autoPause').checked;
    s.coachHints = f('coachHints').checked;
    const z = [0, 1, 2, 3].map((i) => +f(`z${i}`).value);
    if (z.every((v, i) => v > 0 && (i === 0 || v > z[i - 1]))) s.zones = z; else toast(t('zonesMustIncrease'));
    const bests = {};
    for (const k of ['s5', 'm1', 'm5', 'm20']) { const v = Math.round(+f(`b_${k}`).value); if (v > 0) bests[k] = v; }
    s.bests = bests;
    for (const [svc, name] of [['garmin', 'garminMode']]) {
      const v = $(`[data-mode-ctl=${name}] .on`, modal)?.dataset.v;
      if (v) s[svc] = { ...(s[svc] || {}), mode: v };
    }
    for (const sv of svcs) {
      const v = $(`[data-mode-ctl=svc-${sv.id}] .on`, modal)?.dataset.v;
      if (v) s.services = { ...(s.services || {}), [sv.id]: { ...(s.services?.[sv.id] || {}), mode: v } };
    }
    s.garmin = { ...(s.garmin || {}), autoOpen: f('garminAuto').checked };
    {
      const sh = shifting();
      const mn = +f('vsMin').value, mx = +f('vsMax').value, st = Math.round(+f('vsStart').value);
      s.shifting = {
        ...sh,
        mode: $('#vs-mode .on', modal)?.dataset.v || sh.mode,
        difficulty: $('#vs-diff .on', modal)?.dataset.v || sh.difficulty,
        minRatio: mn > 0 && mn < mx ? mn : sh.minRatio,
        maxRatio: mx > mn ? mx : sh.maxRatio,
        startGear: st >= 1 && st <= sh.gears ? st : sh.startGear,
      };
    }
  };
  window.__TAURI__?.app?.getVersion?.().then((v) => { const el = $('#app-ver', modal); if (el) el.textContent = v; }).catch(() => {});
  const updAuto = $('#upd-auto', modal);
  if (updAuto) updAuto.onchange = () => invoke('update_prefs', { auto: updAuto.checked }).then((p) => (updPrefs = p)).catch((err) => toast(String(err)));
  $$('[data-a]', modal).forEach((b) => (b.onclick = async (e) => {
    e.preventDefault();
    const a = b.dataset.a;
    if (a === 'close' || a === 'cancel') { if (s.theme !== themeBefore) setTheme(themeBefore); return closeModal(); }
    if (a === 'link') return invoke('open_link', { url: b.dataset.url }).catch((err) => toast(String(err)));
    if (a === 'upd-check') {
      b.disabled = true; b.textContent = t('checking');
      const u = await checkUpdate(false);
      b.disabled = false; b.textContent = t('checkNow');
      if (u && !ride) closeModal();
      return;
    }
    if (a === 'dir') { closeModal(); return pickDir(); }
    if (a === 'rescan') { closeModal(); await loadLibrary(); return toast(t('plansFound', { n: library.plans.length })); }
    if (a === 'garmin-dir') {
      collect(); await api.saveState();
      const dir = await invoke('pick_garmin_dir').catch((err) => toast(String(err)));
      if (dir) { state = (await api.appState()).profile; return openSettings('sync'); }
      return;
    }
    if (a === 'svc-getkey') return invoke('open_url', { url: 'https://intervals.icu/settings' }).catch((err) => toast(String(err)));
    if (a === 'svc-key') {
      const id = b.dataset.id;
      const apiKey = $(`[name=key-${id}]`, modal).value.trim();
      if (!apiKey) return toast(t('pasteKeyFirst'));
      collect(); await api.saveState();
      const label = b.textContent;
      b.disabled = true; b.textContent = t('checking');
      try {
        svcCache = await invoke('service_connect', { id, apiKey });
        state.settings.services = { ...(state.settings.services || {}), [id]: { mode: 'auto' } };
        await api.saveState();
        const sv = svcCache.find((x) => x.id === id);
        toast(`${t('nameConnected', { name: sv?.name })}${sv?.account ? ` — ${sv.account}` : ''}`);
        return openSettings('sync');
      } catch (err) { b.disabled = false; b.textContent = label; return toast(String(err)); }
    }
    if (a === 'svc-off') {
      const sv = svcs.find((x) => x.id === b.dataset.id);
      if (!await confirmDialog(t('disconnectQ', { name: sv.name }), t('disconnectText'), t('disconnect'), true)) return openSettings('sync');
      collect(); await api.saveState();
      svcCache = await invoke('service_disconnect', { id: sv.id }).catch((err) => { toast(String(err)); return svcCache; });
      return openSettings('sync');
    }
    if (a === 'sync-now') { b.disabled = true; await runSync(false); return openSettings('sync'); }
    if (a === 'garmin-on') {
      collect(); await api.saveState();
      b.disabled = true; b.textContent = t('signInWindow');
      try {
        const st = await invoke('garmin_connect');
        state.settings.garmin = { ...(state.settings.garmin || {}), mode: 'auto' };
        await api.saveState();
        toast(`${t('garminLinked')}${st.name ? ` — ${st.name}` : ''}`);
        return openSettings('sync');
      } catch (err) { b.disabled = false; b.textContent = t('signInGarmin'); return toast(String(err)); }
    }
    if (a === 'garmin-off') {
      if (!await confirmDialog(t('garminSignOutQ'), t('garminSignOutText'), t('signOut'), true)) return openSettings('sync');
      await invoke('garmin_disconnect').catch((err) => toast(String(err)));
      return openSettings('sync');
    }
    if (a === 'save') {
      collect();
      await api.saveState();
      route();
      closeModal();
    }
  }));
}

async function pickDir() {
  const dir = await invoke('pick_zwo_dir').catch((e) => toast(String(e)));
  if (!dir) return;
  state = (await api.appState()).profile;
  await loadLibrary();
  toast(t('plansIn', { n: library.plans.length, dir: dir.split(/[\\/]/).pop() }));
}

async function controllerDialog() {
  const connected = await ctrls.list();
  const saved = state.settings.devices?.controllers || [];
  openModal(`<h2>${t('shifterTitle')}</h2>
    <p class="muted">${t('shifterIntro')}</p>
    ${connected.length ? `<div class="dev-list">${connected.map((c) => `<div class="dev on"><span>${esc(c.name)}</span><small class="ok-text">${t('connected')}</small></div>`).join('')}</div>
    <div class="btn-test" id="btn-test"><span class="k">${t('buttonTest')}</span><b id="bt-last">${t('pressButton')}</b><small class="muted" id="bt-raw"></small></div>
    <table class="btn-map small">${Object.entries(BUTTON_ACTIONS).filter(([, [a]]) => a).map(([k, [, l]]) => `<tr data-btn="${k}"><td><kbd>${BUTTON_LABEL[k]}</kbd></td><td>${t(l)}</td></tr>`).join('')}</table>` : ''}
    <div class="dev-list" id="dev-list"><div class="scanning"><span class="spinner"></span>${t('searchingCtrl')}</div></div>
    <ul class="tips small muted">
      <li>${t('tipRide')}</li>
      <li>${t('tipClick')}</li>
      <li>${t('tipCloseZwift')}</li>
    </ul>
    <div class="modal-actions">${connected.length ? `<button class="btn ghost" data-a="disc">${t('disconnectAll')}</button>` : ''}<button class="btn ghost" data-a="rescan">${t('searchAgain')}</button><button class="btn ghost" data-a="close">${t('close')}</button></div>`, 'small');
  const list = $('#dev-list', modal);
  if (connected.length) {
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
    list.innerHTML = `<div class="scanning"><span class="spinner"></span>${t('searchingCtrl')}</div>`;
    try {
      const found = await ctrls.scan(5);
      if (!list.isConnected) return;
      list.innerHTML = found.length
        ? found.map((f) => `<button class="dev" data-id="${esc(f.id)}" data-name="${esc(f.name)}"><span>${esc(f.name)}${saved.some((x) => x.id === f.id) ? ` <small class="muted">· ${t('lastUsed')}</small>` : ''}</span><small class="muted">${f.rssi != null ? `${f.rssi} dBm` : ''}</small></button>`).join('')
        : `<p class="muted">${t('noController')}</p>`;
    } catch (e) { list.innerHTML = `<p class="warn-text">${esc(String(e))}</p>`; }
  };
  list.onclick = async (e) => {
    const b = e.target.closest('.dev[data-id]');
    if (!b) return;
    b.innerHTML = `<span><span class="spinner"></span> ${t('connectingTo', { name: esc(b.dataset.name) })}</span>`;
    try {
      const info = await ctrls.connect(b.dataset.id);
      const devs = (state.settings.devices ||= {});
      devs.controllers = [...(devs.controllers || []).filter((c) => c.id !== b.dataset.id), { id: b.dataset.id, name: info.name }];
      await api.saveState();
      toast(t('ctrlConnected', { name: info.name }));
      controllerDialog();
    } catch (err) { b.innerHTML = `<span class="warn-text">${t('failedE', { e: esc(String(err)) })}</span>`; }
  };
  $$('[data-a]', modal).forEach((b) => (b.onclick = async () => {
    if (b.dataset.a === 'rescan') return search();
    if (b.dataset.a === 'disc') {
      await ctrls.disconnect();
      if (state.settings.devices) state.settings.devices.controllers = [];
      await api.saveState();
    }
    closeModal();
  }));
  search();
}

function deviceDialog(kind) {
  if (kind === 'controller') return controllerDialog();
  const dev = kind === 'trainer' ? trainer : hrm;
  const label = kind === 'trainer' ? t('devTrainer') : t('hrMonitor');
  const saved = state.settings.devices?.[kind];
  if (dev.connected || dev.reconnecting) {
    openModal(`<h2>${label}</h2><p>${t(dev.reconnecting ? 'reconnectingTo' : 'connectedTo', { name: `<b>${esc(dev.name)}</b>` })}${kind === 'trainer' && dev.connected ? ` · ${trainer.canErg ? t('ergActive') : t('powerOnlyNoErg')}` : ''}.</p>
      <div class="modal-actions"><button class="btn ghost" data-a="forget">${t('forgetDevice')}</button><button class="btn ghost" data-a="close">${t('close')}</button><button class="btn danger" data-a="disc">${t('disconnect')}</button></div>`, 'small');
  } else {
    openModal(`<h2>${label}</h2>
      <p class="muted">${kind === 'trainer' ? t('trainerIntro') : t('hrIntro')}</p>
      <div class="dev-list" id="dev-list"><div class="scanning"><span class="spinner"></span>${t('searching')}</div></div>
      <div class="modal-actions"><button class="btn ghost" data-a="sim">${t('useSimulator')}</button><button class="btn ghost" data-a="rescan">${t('searchAgain')}</button><button class="btn ghost" data-a="close">${t('close')}</button></div>`, 'small');
    const list = $('#dev-list', modal);
    const search = async () => {
      list.innerHTML = `<div class="scanning"><span class="spinner"></span>${t('searching')}</div>`;
      try {
        const found = await dev.scan(4);
        if (!modal.open || !list.isConnected) return;
        list.innerHTML = found.length
          ? found.map((f) => `<button class="dev" data-id="${esc(f.id)}" data-name="${esc(f.name)}"><span>${esc(f.name)}${saved?.id === f.id ? ` <small class="muted">· ${t('lastUsed')}</small>` : ''}</span><small class="muted">${f.rssi != null ? `${f.rssi} dBm` : ''}</small></button>`).join('')
          : `<p class="muted">${t('nothingFound')}</p>`;
      } catch (e) {
        list.innerHTML = `<p class="warn-text">${esc(String(e))}</p><p class="muted small">${PLAT.bt}</p>`;
      }
    };
    list.onclick = async (e) => {
      const b = e.target.closest('.dev');
      if (!b) return;
      list.innerHTML = `<div class="scanning"><span class="spinner"></span>${t('connectingTo', { name: esc(b.dataset.name) })}</div>`;
      try {
        const info = await dev.connect(b.dataset.id);
        state.settings.devices = { ...(state.settings.devices || {}), [kind]: { id: b.dataset.id, name: info.name } };
        await api.saveState();
        closeModal();
        toast(`${t('nameConnected', { name: info.name })}${kind === 'trainer' ? ` · ${info.erg ? t('ergReady') : t('powerOnly')}` : ''}`);
      } catch (err) {
        list.innerHTML = `<p class="warn-text">${t('connectionFailed', { e: esc(String(err)) })}</p>`;
      }
    };
    search();
    $('[data-a=rescan]', modal).onclick = search;
  }
  $$('[data-a]:not([data-a=rescan])', modal).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    closeModal();
    if (a === 'disc') await dev.disconnect();
    if (a === 'sim') dev.startSim();
    if (a === 'forget') {
      await dev.disconnect();
      if (state.settings.devices) delete state.settings.devices[kind];
      await api.saveState();
    }
  }));
}

// ------------------------------------------------------------------ other platforms (Intervals.icu automatic, COROS manual import)
let svcCache = [];
const SVC_LOGO = { intervals: 'i', coros: 'C' };
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

/** Ride-screen icons (24×24, stroke = currentColor). */
const svgI = (d, extra = '') => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`;
const IC = {
  pulse: svgI('<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>', ' style="opacity:.6"'),
  bolt: svgI('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  cad: svgI('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M12 10V3.5M13.7 13l4.6 4.6"/>'),
  speed: svgI('<path d="M3.5 17a9 9 0 1 1 17 0"/><path d="m12 14 4.5-4.5"/>'),
  heart: svgI('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  target: svgI('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  watch: svgI('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M10 2h4M19 6l-1.5 1.5"/>'),
  flag: svgI('<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>'),
  layers: svgI('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  dial: svgI('<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 14 3-4"/>'),
  bars: svgI('<path d="M5 20v-8M12 20V5M19 20v-5"/>'),
  chat: svgI('<path d="M4 5h16v11H10l-5 4v-4H4z"/>'),
  flame: svgI('<path d="M12 3c.8 3.6 5 5.4 5 10a5 5 0 0 1-10 0c0-2.4 1.3-3.9 2.4-5 .3 1.9 1.2 2.9 2.4 3-.6-2.9-.4-5.4.2-8z"/>'),
  plug: svgI('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'),
};
/** Plausibility note for a test result that differs a lot (> 15 %) from the current FTP. */
function ftpCheck(next, cur, source) {
  if (!next || !cur) return '';
  const d = (next - cur) / cur;
  if (Math.abs(d) <= 0.15) return '';
  const pct = `${Math.round(Math.abs(d) * 100)} %`;
  const src = source ? t('ftpSrcFrom', { name: `<b>${esc(source)}</b>` }) : t('ftpSrcRight');
  const why = d > 0 ? t('ftpHigh', { pct, src }) : t('ftpLow', { pct, src });
  return `<p class="ftp-check">${why}</p>`;
}

const SEG_KIND = { steady: 'kindSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'kindOn', off: 'kindOff', freeride: 'freeRide', maxeffort: 'maxEffort' };
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

class Ride {
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
    this.autoStartCount = 0;
    this.build();
    this.wake();
    this.loop = setInterval(() => this.tick(), 250);
    this.last = performance.now();
    this.render(true);
  }

  build() {
    const r = $('#ride');
    r.hidden = false;
    document.body.classList.add('riding');
    const plan = this.planId && planById(this.planId);
    const ov = state.settings.overlay || { power: true };
    // the ride title lives in the regular top bar (in place of the mode switch)
    const rt = $('#ride-title');
    rt.innerHTML = `${this.test ? `<span class="badge test">${t('ftpTest')}</span>` : ''}${plan ? `<span class="badge">${esc(plan.name)}${this.info?.week ? ` · ${t('weekDayCompact', { w: this.info.week, d: this.info.day })}` : ''}</span>` : this.test ? '' : `<span class="badge muted">${t('workout')}</span>`}
      <h1 title="${esc(this.info?.title || this.w.name)}">${esc(this.info?.title || this.w.name)}</h1><span class="erg" id="erg-state"></span>`;
    rt.hidden = false;
    r.innerHTML = `
      <div class="ride-top">
        <section class="panel live">
          <header class="ph"><span class="ph-dot" id="live-dot"></span><b>${t('live')}</b>${IC.pulse}<span class="ph-status" id="live-status"></span></header>
          <div class="live-body">
            <button class="gauge" id="gauge" title="${t('gaugeTitle')}">
              <div class="gauge-mount"></div>
              <div class="gauge-center"><span class="k" id="g-unit">${t('watt')}</span><b id="v-pow">–</b><small id="t-pow">–</small></div>
            </button>
            <div class="metrics">
              <div class="metric">${IC.bolt}<div class="m-txt"><span class="k">${t('colPower')}</span><span class="m-val"><b id="m-pow">–</b><small>W</small></span><div class="mbar" id="b-pow"><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.cad}<div class="m-txt"><span class="k">${t('cadence')}</span><span class="m-val"><b id="v-cad">–</b><em id="t-cad"></em><small>rpm</small></span><div class="mbar" id="b-cad"><i class="band"></i><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.speed}<div class="m-txt"><span class="k">${t('speed')}</span><span class="m-val"><b id="v-spd">–</b><small>km/h</small></span><div class="mbar" id="b-spd"><i class="fill"></i></div></div></div>
              <div class="metric">${IC.heart}<div class="m-txt"><span class="k">${t('devHr')}</span><span class="m-val"><b id="v-hr">–</b><small>bpm</small><em id="t-hr"></em></span><div class="mbar" id="b-hr"><i class="fill"></i></div></div></div>
            </div>
          </div>
        </section>
        <section class="panel seg">
          <header class="ph">${IC.target}<b>${t('currentSegment')}</b><span class="ph-status" id="seg-kind"></span></header>
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
              <div class="gearbox" id="gearbox" hidden><button class="btn round sm" data-shift="-1" title="${t('shiftDownKey')}">−</button><span id="gear-lbl">${t('gear')}</span><button class="btn round sm" data-shift="1" title="${t('shiftUpKey')}">+</button></div>
            </div>
            <div class="seg-stats">
              <div class="stat">${IC.bolt}<div><span class="k" id="s-tw-k">${t('targetPower')}</span><b id="s-tw">–</b></div></div>
              <div class="stat cad">${IC.cad}<div><span class="k">${t('targetCadence')}</span><b id="s-cad">–</b></div></div>
              <div class="stat">${IC.watch}<div><span class="k">${t('segment')}</span><b id="s-dur">0:00</b><div class="sbar"><i id="s-bar"></i></div></div></div>
              <div class="stat rem">${IC.flag}<div><span class="k">${t('remaining')}</span><b id="s-rem">0:00</b></div></div>
            </div>
          </div>
          <div class="coach-line" id="coach" role="status" aria-live="polite"></div>
        </section>
        <section class="panel next">
          <header class="ph">${IC.layers}<b>${t('btnNext')}</b></header>
          <div class="nx-card" id="next-card"></div>
        </section>
      </div>
      <div class="ride-diagram panel">
        <div class="dg-times">
          <div class="wt-head"><span class="ph-mini">${IC.bars}<b>${t('workout')}</b></span><div class="wt-time"><span class="k">${t('elapsed')}</span><b id="d-el">0:00</b></div></div>
          <span class="overlay-toggles" id="ov">${OVERLAY.map(([k, l]) => `<button data-ov="${k}" class="ov ov-${k} ${ov[k] ? 'on' : ''}"><i></i>${t(l)}</button>`).join('')}</span>
          <div class="wt-time rem"><span class="k">${t('remainingLc')}</span><b id="d-rem">${fmtTime(this.w.duration)}</b><small id="d-tot">${t('ofTime', { time: fmtTime(this.w.duration) })}</small></div>
        </div>
        <div class="dg-mount"></div>
        <div class="dg-tip" id="dg-tip" hidden></div>
      </div>
      <div class="ride-controls">
        <button class="ctl" data-c="prev" title="${t('btnPrev')} (←)"><svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-9 7 9 7z"/></svg></button>
        <button class="ctl" data-c="back" title="${t('back1min')}"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg></button>
        <button class="ctl play" data-c="play" title="${t('btnPlay')} (${t('spaceKey')})" id="btn-play"><svg viewBox="0 0 24 24" class="i-play"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" class="i-pause"><path d="M8 5v14M16 5v14"/></svg></button>
        <button class="ctl" data-c="stop" title="${t('endWorkout')}"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
        <button class="ctl" data-c="fwd" title="${t('fwd1min')}"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/></svg></button>
        <button class="ctl" data-c="next" title="${t('btnNext')} (→)"><svg viewBox="0 0 24 24"><path d="M18 5v14M5 5l9 7-9 7z"/></svg></button>
        <div class="int-group" title="${t('intensityTitle')}">
          <div class="int-read"><span class="k">${t('intensity')}</span><b id="int-val">100%</b></div>
          <button class="ctl int-b" data-int="-1" title="${t('intDownTitle')}" aria-label="${t('btnIntDown')}">−</button>
          <button class="ctl int-b" data-int="1" title="${t('intUpTitle')}" aria-label="${t('btnIntUp')}">+</button>
        </div>
      </div>
      <div class="ready" id="ready"><div><b>${t('ready')}</b><span>${t('readyText')}${trainer.connected ? ` ${t('readyPedal')}` : ''}.</span></div>
        ${this.hasFree ? `<div class="vs-ask"><span class="k">${t('freeRideSegments')}</span><span class="seg-ctl" id="vs-choice">${[['gears', 'realGears'], ['easy', 'vgEasy'], ['medium', 'diff.medium'], ['hard', 'diff.hard']].map(([k, l]) => `<button data-vs="${k}" class="${(k === 'gears' ? !this.vs.on : this.vs.on && this.vs.difficulty === k) ? 'on' : ''}">${t(l)}</button>`).join('')}</span></div>` : ''}</div>`;

    this.gauge = new Gauge($('.gauge-mount', r));
    this.ring = new ProgressRing($('.ring-mount', r));
    this.diagram = new Diagram($('.dg-mount', r), this.w, {
      bounds: bounds(), ftp: ftp(), maxHr: maxHr(), overlay: ov,
      onSelect: (i, s) => {
        const tip = $('#dg-tip');
        tip.innerHTML = `${segmentText(s)} <button class="btn ghost sm" data-c="goto" data-i="${i}">${t('jumpHere')}</button>`;
        tip.hidden = false;
        clearTimeout(this.tipTimer);
        this.tipTimer = setTimeout(() => (tip.hidden = true), 6000);
      },
    });
    r.onclick = (e) => {
      const vsb = e.target.closest('[data-vs]');
      if (vsb) return this.chooseShifting(vsb.dataset.vs);
      const sb = e.target.closest('[data-shift]');
      if (sb) return this.shift(+sb.dataset.shift);
      const o = e.target.closest('[data-ov]');
      if (o) return this.toggleOverlay(o.dataset.ov, o);
      const c = e.target.closest('[data-c]');
      if (c) return this.control(c.dataset.c, c);
      const i = e.target.closest('[data-int]');
      if (i) return this.adjust(+i.dataset.int * (e.shiftKey ? 10 : 1));
      if (e.target.closest('#gauge')) { this.showPct = !this.showPct; this.render(true); }
    };
    this.onDeviceStatus();
  }

  toggleOverlay(k, btn) {
    const ov = { ...(state.settings.overlay || {}) };
    ov[k] = !ov[k];
    state.settings.overlay = ov;
    btn.classList.toggle('on', ov[k]);
    this.diagram.setOverlay(ov);
    this.diagram.update(this.t, this.samples);
    api.saveState();
  }

  chooseShifting(v) {
    this.vs.on = v !== 'gears';
    if (this.vs.on) this.vs.difficulty = v;
    state.settings.shifting = { ...shifting(), mode: this.vs.on ? 'virtual' : 'gears', difficulty: this.vs.on ? v : shifting().difficulty };
    api.saveState();
    $$('#vs-choice button').forEach((b) => b.classList.toggle('on', b.dataset.vs === v));
    this.render(true);
  }

  get freeLike() {
    const s = this.w.segments[this.segIdx];
    return !!s && (s.p0 === null || s.erg === false);
  }

  /** Controller button actions (see BUTTON_ACTIONS). */
  button(a) {
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

  hint(text) {
    let el = $('#ride-hint');
    if (!el) { el = document.createElement('div'); el.id = 'ride-hint'; $('#ride').append(el); }
    el.textContent = text;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  shift(dir) {
    const n = Math.max(0, Math.min(this.gears.length - 1, this.gear + dir));
    if (n === this.gear) return;
    this.gear = n;
    if (this.freeLike && !this.vs.on) { this.vs.on = true; } // shifting implies virtual gears
    const lbl = $('#gear-lbl');
    lbl?.classList.remove('flash'); void lbl?.offsetWidth; lbl?.classList.add('flash');
    this.render(true);
  }

  onDeviceStatus() {
    const st = $('#live-status'), dot = $('#live-dot');
    if (st) {
      const on = trainer.connected;
      st.innerHTML = on ? `${IC.plug}${trainer.mode === 'sim' ? t('simulator') : t('connectedCap')}` : t('noTrainer');
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

  seek(to) {
    this.t = Math.max(0, Math.min(this.w.duration - 0.01, to));
    this.beeped.clear();
    this.render(true);
  }

  control(c, elm) {
    const seg = this.w.segments[this.segIdx];
    switch (c) {
      case 'play': return this.toggle();
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

  toggle(auto = false) {
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

  onKey(e) {
    if (modal.open || e.target.matches('input')) return;
    const map = { ' ': 'play', ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'stop' };
    if (map[e.key]) { e.preventDefault(); return this.control(map[e.key]); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); return this.shift(1); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); return this.shift(-1); }
    if (this.freeLike && this.vs.on && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); return this.shift(e.key === 'ArrowUp' ? 1 : -1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.adjust(e.shiftKey ? 10 : 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.adjust(e.shiftKey ? -10 : -1); }
  }

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
        // dev fast-forward (SPEED > 1): fill skipped seconds so recordings stay 1 Hz
        const from = SPEED > 1 && sec > this.lastSec ? this.lastSec + 1 : sec;
        this.lastSec = sec;
        for (let ts = from; ts <= sec; ts++) {
          const i = Math.max(0, segmentAt(this.w.segments, Math.min(ts, this.w.duration - 0.01)));
          const wall = SPEED > 1 ? (this.startedAt.getTime() + this.samples.length * 1000) : Date.now();
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
    const vsActive = freeLike && this.vs.on && trainer.connected && trainer.canErg;
    let vsSpeed = null;
    if (vsActive) {
      const cad = fresh('cadence');
      const ratio = this.gears[this.gear];
      vsSpeed = virtualSpeed(cad, ratio);
      const raw = targetWatts(cad, ratio, weight() || 75, this.vs.difficulty);
      this.vs.watts = this.vs.watts == null ? raw : Math.round(this.vs.watts * 0.5 + raw * 0.5);
      const now = performance.now();
      if (now - this.vs.sentAt > 900 || force) { trainer.setTargetPower(this.vs.watts); this.vs.sentAt = now; }
    } else if (trainer.connected) { this.vs.watts = null; if (freeLike) trainer.setFreeRide(); else trainer.setTargetPower(tw); }
    this.vsSpeed = vsSpeed;
    const gb = $('#gearbox');
    if (gb) {
      gb.hidden = !(freeLike && (this.vs.on || ctrls.connected));
      $('#gear-lbl').innerHTML = `<b>${t('gearN', { n: this.gear + 1 })}</b><small>/${this.gears.length} · ${this.gears[this.gear].toFixed(2)}${vsActive ? ` · ${this.vs.watts} W` : ''}</small>`;
    }

    // beeps: last 3 s before a change of target
    const n = segs[idx + 1];
    if (state.settings.beeps && this.running && n && rem <= 3.05 && rem > 0) {
      const k = `${idx}:${Math.ceil(rem)}`;
      if (!this.beeped.has(k)) { this.beeped.add(k); beep(Math.ceil(rem) === 1 ? 880 : 660); }
    }

    const ergEl = $('#erg-state');
    if (ergEl && trainer.connected && trainer.canErg) {
      ergEl.textContent = vsActive ? `${t('virtualGears')} · ${t(`diff.${this.vs.difficulty}`)}` : freeLike ? t('ergOffGears') : 'ERG';
      ergEl.className = vsActive ? 'erg vs' : freeLike ? 'erg off' : 'erg on';
    }

    // LIVE panel
    const p = fresh('power'), c = fresh('cadence'), hr = fresh('hr'), v = fresh('speed');
    const gt = vsActive ? this.vs.watts : allOut ? null : tw;
    $('#m-pow').textContent = p ?? '–';
    // power bar: 0…1.5× target, coloured by the zone you're riding in (the target is on the gauge)
    const pRef = gt || F;
    setBar($('#b-pow'), p != null ? p / (pRef * 1.5) : 0, { color: p != null ? zoneColor(p / F, bounds()) : null });

    // cadence vs target (Zwift: Cadence / CadenceLow+High): green on target, amber ±5–10, red beyond 10 rpm
    const cLo = s.cadenceLow ?? s.cadence, cHi = s.cadenceHigh ?? s.cadence;
    $('#v-cad').textContent = c != null ? Math.round(c) : '–';
    $('#t-cad').textContent = cLo != null ? `/ ${cLo === cHi ? cLo : `${cLo}–${cHi}`}` : '';
    const dev = c != null && cLo != null ? (c < cLo ? cLo - c : c > cHi ? c - cHi : 0) : null;
    const cadState = dev == null ? '' : dev > 10 ? 'bad' : dev > 5 ? 'warn' : 'good';
    const live = this.running || !this.started;
    $('#v-cad').classList.toggle('off-target', live && cadState === 'bad');
    $('#t-cad').className = live ? cadState : '';
    const CMIN = 40, CMAX = 130, cf = (x) => (x - CMIN) / (CMAX - CMIN);
    setBar($('#b-cad'), c != null ? cf(c) : 0, {
      mark: cLo != null && cLo === cHi ? cf(cLo) : null,
      band: cLo != null && cLo !== cHi ? [cf(cLo), cf(cHi)] : null,
      color: cadState === 'bad' ? 'var(--danger)' : cadState === 'warn' ? 'var(--warn)' : cadState === 'good' ? 'var(--ok)' : null,
    });

    const spd = vsSpeed ?? v;
    $('#v-spd').textContent = spd != null ? spd.toFixed(1) : '–';
    setBar($('#b-spd'), spd != null ? spd / 60 : 0, { color: 'var(--ok)' });
    $('#v-hr').textContent = hr ?? '–';
    $('#t-hr').textContent = hr != null ? `${Math.round((hr / maxHr()) * 100)}%` : '';
    setBar($('#b-hr'), hr != null ? hr / maxHr() : 0, { color: 'var(--hrline)' });

    $('#g-unit').textContent = this.showPct ? '% FTP' : t('watt');
    $('#v-pow').textContent = p == null ? '–' : this.showPct ? `${Math.round((p / F) * 100)}%` : p;
    $('#t-pow').textContent = gt == null ? t(s.type === 'maxeffort' ? 'gMax' : allOut ? 'gAllOut' : 'gFree') : this.showPct ? `${Math.round((gt / F) * 100)}%` : `${gt} W`;
    this.gauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });
    // on target: within ±5 % for 3 s -> soft glow in the zone colour around the gauge
    const onT = this.running && gt != null && p != null && Math.abs(p - gt) / gt <= 0.05;
    this.onSince = onT ? (this.onSince ?? performance.now()) : null;
    const gEl = $('#gauge');
    if (gt != null) gEl.style.setProperty('--glow', zoneColor(gt / F, bounds()));
    gEl.classList.toggle('on-target', onT && performance.now() - this.onSince >= 3000);

    // CURRENT SEGMENT
    const color = zoneColor(tf, bounds());
    this.ring.update(Math.min(1, inSeg / s.duration), color);
    if (s.p0 === null) { $('#s-target').classList.remove('range'); $('#s-target').textContent = s.type === 'maxeffort' ? t('bigMax') : t('bigFree'); $('#s-watts').textContent = vsActive ? t('virtualShiftingLc') : t('rideByFeel'); }
    else {
      const a = Math.round(s.p0 * 100 * this.mult()), b = Math.round(s.p1 * 100 * this.mult());
      $('#s-target').textContent = allOut ? t('bigAllOut') : a === b ? `${a}%` : `${a}–${b}%`;
      $('#s-target').classList.toggle('range', a !== b || allOut);
      $('#s-watts').textContent = allOut ? t('aimW', { w: tw, how: vsActive ? t('howShift') : t('howGears') }) : `${tw} W`;
    }
    $('#s-target').style.color = zoneInk(tf, bounds());
    $('#s-tw').textContent = gt != null ? `${gt} W` : allOut ? t('allOut') : t('free');
    $('#s-tw').style.color = gt != null ? zoneInk(gt / F, bounds()) : '';
    // live pacing in long all-out test efforts: running average, projected FTP, "too fast" warning
    const pacing = this.test && allOut && s.measure && s.duration >= 300;
    $('#s-tw-k').textContent = pacing ? (s.duration >= 480 ? t('estFtp') : t('effortAvg')) : t('targetPower');
    $('#s-watts').classList.remove('warn-text');
    let paceFast = false;
    if (pacing) {
      const acc = this.effAcc?.[s.measure];
      const avg = acc && acc.n >= 5 ? Math.round(acc.sum / acc.n) : null;
      const factor = s.duration >= 1140 ? 0.95 : s.duration >= 480 ? 0.9 : null;
      const fast = !!(avg && tw && acc.n >= 60 && avg > tw * 1.1);
      $('#s-target').textContent = avg ? `${avg} W` : t('bigAllOut');
      $('#s-target').classList.toggle('range', !avg);
      if (avg) $('#s-target').style.color = zoneInk(avg / F, bounds());
      $('#s-watts').textContent = !avg ? t('aimW', { w: tw ?? '–', how: vsActive ? t('howShift') : t('howGears') }) : fast ? t('tooFastShort') : tw ? t('avgAim', { w: tw }) : t('effortAverage');
      $('#s-watts').classList.toggle('warn-text', fast);
      paceFast = fast;
      const proj = avg && factor && acc.n >= 30 ? Math.round(avg * factor) : null;
      $('#s-tw').textContent = factor ? (proj ? `${proj} W` : '–') : (avg ? `${avg} W` : '–');
      $('#s-tw').style.color = '';
    }
    $('#s-cad').textContent = cLo != null ? `${cLo === cHi ? cLo : `${cLo}–${cHi}`} rpm` : '–';
    $('#s-cad').classList.toggle('range', cLo != null && cLo !== cHi);
    $('#s-dur').textContent = fmtTime(s.duration);
    $('#s-bar').style.width = `${Math.min(100, (inSeg / s.duration) * 100)}%`;
    $('#s-bar').style.background = color;
    $('#s-rem').textContent = fmtTime(Math.ceil(rem));
    $('.panel.seg').classList.toggle('closing', rem <= 5 && !!n);

    if (segChanged || force) {
      $('#seg-kind').textContent = segKind(s);
      $('.panel.seg').style.setProperty('--zc', color);
      // NEXT SEGMENT
      const card = $('#next-card');
      if (n) {
        const m = this.mult();
        const nf = n.p0 === null ? null : ((n.p0 + n.p1) / 2) * m;
        const pa = n.p0 === null ? null : Math.round(n.p0 * 100 * m), pb = n.p0 === null ? null : Math.round(n.p1 * 100 * m);
        const wa = n.p0 === null ? null : Math.round(n.p0 * F * m), wb = n.p0 === null ? null : Math.round(n.p1 * F * m);
        const big = n.p0 === null ? (n.type === 'maxeffort' ? t('maxEffort') : t('freeRide')) : n.erg === false ? t('allOut') : pa === pb ? `${pa}%` : `${pa}% → ${pb}%`;
        const watts = n.p0 === null ? t('rideByFeel') : wa === wb ? `${wa} W` : `${wa} → ${wb} W`;
        const nLo = n.cadenceLow ?? n.cadence, nHi = n.cadenceHigh ?? n.cadence;
        card.style.setProperty('--zc', zoneColor(nf, bounds()));
        card.title = nf == null ? t('freeRide') : zoneOf(nf, bounds()).name;
        card.innerHTML = `<div class="nc-txt"><b>${big}</b><span class="nc-v">${watts}</span><span class="nc-v">${fmtTime(n.duration)} min</span>${nLo != null ? `<span class="nc-v nc-rpm">${nLo === nHi ? nLo : `${nLo}–${nHi}`} rpm</span>` : ''}</div>`;
      } else {
        card.style.setProperty('--zc', 'var(--line-strong)');
        card.title = '';
        card.innerHTML = this.cooling
          ? `<div class="nc-txt"><b>${t('testDone')}</b><span class="nc-v muted">${t('pressStopResult')}</span></div>`
          : `<div class="nc-txt"><b>${t('finishStrong')}</b><span class="nc-v muted">${t('noMoreChanges')}</span></div>`;
      }
      $('#int-val').textContent = `${this.intensity}%`;
      $('#int-val').classList.toggle('changed', this.intensity !== 100);
      this.diagram.highlight(idx);
      $('#btn-play').classList.toggle('is-running', this.running);
      // segment change: zone-coloured sweep over Current segment, Next card slides up
      if (segChanged && this.animReady && motionOK()) { restartAnim($('.panel.seg'), 'seg-in'); restartAnim(card, 'nx-in'); }
    }
    this.animReady = true;

    this.coach(s, { segChanged, inSeg, rem, allOut, freeLike, gt, p, c, cLo, cHi, dev, cadState, paceFast });

    $('#d-el').textContent = fmtTime(this.t);
    $('#d-rem').textContent = fmtTime(Math.max(0, Math.ceil(this.w.duration - this.t)));
    this.diagram.update(this.t, this.samples);
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
      el.innerHTML = `${show.icon}<span></span>`;
      el.classList.remove('show'); void el.offsetWidth;
    }
    el.className = `coach-line show ${show.level}`;
    if (show.color) el.style.setProperty('--cc', show.color); else el.style.removeProperty('--cc');
    const span = el.querySelector('span');
    if (span.textContent !== show.text) span.textContent = show.text;
    k.cur = show;
  }

  async stop() {
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

  async finish(completed) {
    clearInterval(this.loop);
    this.running = false;
    // ridden to the end: the ring closes and turns into a check, then the summary rises
    const endAnim = completed && this.t >= this.w.duration - 1 && motionOK();
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

    // store the ride as FIT (for Garmin / export)
    let fit = null;
    if (this.samples.length) {
      // the planned workout goes into the FIT file as well: Garmin names the activity after it
      // (and forwards that name to Strava) — the rename after the upload comes too late for Strava
      const F = ftp(), m = this.mult();
      const steps = this.w.segments.map((sg) => ({
        duration: Math.max(1, Math.round(sg.duration)),
        lo: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p0 * F * m),
        hi: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p1 * F * m),
        kind: sg.type === 'warmup' ? 'warmup' : sg.type === 'cooldown' ? 'cooldown' : sg.type === 'off' ? 'rest' : null,
      }));
      fit = await invoke('save_activity', { ride: { name: title, ftp: F, steps, samples: this.samples.map(({ wall, p, c, hr, v, seg }) => ({ wall, p, c, hr, v, seg })) } })
        .catch((e) => { toast(t('couldNotSaveRide', { e })); return null; });
    }
    const entry = { file: this.file, plan: this.planId, title, startedAt: this.startedAt?.toISOString(), at: new Date().toISOString(), ...result, fitPath: fit?.path || null, distanceKm: fit?.summary?.distanceKm ?? null };
    state.history.unshift(entry);
    state.history = state.history.slice(0, 1000);
    if (this.planId) await markEntry(this.planId, this.file, result); else await api.saveState();

    let testResult = null;
    if (this.test) {
      testResult = this.test.protocol ? this.test.protocol.evaluate(this.samples) : evaluateGeneric(this.samples, this.w);
      const v = testResult && vo2max(testResult.vo2, weight());
      if (v) testResult.vo2est = v;
      if (testResult) {
        const bests = { ...(state.settings.bests || {}) };
        for (const [k, val] of Object.entries(testResult.bests || {})) if (val && (!bests[k] || val > bests[k])) bests[k] = val;
        state.settings.bests = bests;
        state.tests = [{ at: new Date().toISOString(), protocol: this.test.protocol?.id || 'library', name: this.test.protocol?.name || title, ftp: testResult.ftp, incomplete: !!testResult.incomplete, prevFtp: ftp(), details: testResult.details, cp: testResult.cp ?? null, wPrime: testResult.wPrime ?? null, vo2: testResult.vo2est?.rel ?? null, vo2abs: testResult.vo2est?.abs ?? null, weight: weight(), accepted: false }, ...(state.tests || [])].slice(0, 200);
        await api.saveState();
      }
    }
    const [garmin, svcs] = fit ? await Promise.all([invoke('garmin_status').catch(() => ({})), refreshServices()]) : [{}, []];
    const autoGarmin = fit && garmin.connected && syncMode('garmin') === 'auto';
    const rideSvcs = svcs.filter((sv) => svcRoute(sv) && svcMode(sv) !== 'off');
    const svcRow = (sv) => {
      const auto = sv.connected && svcMode(sv) === 'auto';
      const act = auto ? `<span class="spinner"></span> ${t('uploading')}` : sv.connected ? `<button class="btn ghost sm" data-a="svc-up" data-id="${sv.id}">${t('upload')}</button>` : `<button class="btn ghost sm" data-a="svc-man" data-id="${sv.id}">${t('importDots')}</button>`;
      return `<div class="sl-row"><span class="svc-logo ext sm">${SVC_LOGO[sv.id]}</span><span class="sl-name">${esc(sv.name)}</span><span class="sl-state" id="svc-${sv.id}">${act}</span></div>`;
    };

    const plan = this.planId && planById(this.planId);
    const next = plan && planProgress(plan).next;
    const cell = (k, v) => `<div><span class="k">${k}</span><b>${v ?? '–'}</b></div>`;
    if (endAnim) { const wait = 650 - (performance.now() - animStart); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
    openModal(`
      <div class="summary">
        <div class="eyebrow">${this.test ? t('ftpTestResult') : completed ? t('workoutComplete') : t('workoutSaved')}</div>
        <h2>${esc(title)}</h2>
        ${this.test ? (testResult?.ftp ? `
        <div class="ftp-result">
          <div><span class="k">${t('yourFtpIs')}</span><b>${testResult.ftp} W</b><small class="${testResult.ftp >= ftp() ? 'up' : 'down'}">${t('vsCurrent', { diff: `${testResult.ftp >= ftp() ? '+' : ''}${testResult.ftp - ftp()}`, cur: ftp() })}</small></div>
          <dl>${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
            ${wkg(testResult.ftp) ? `<dt>${t('ftpPerKg')}</dt><dd>${wkg(testResult.ftp)} W/kg</dd>` : ''}
            ${testResult.vo2est ? `<dt>${t('vo2Estimate')}</dt><dd>${testResult.vo2est.rel} ml/kg/min · ${testResult.vo2est.abs} L/min <small class="muted">${esc(testResult.vo2est.method)}</small></dd>` : testResult.vo2 && !weight() ? `<dt>VO2max</dt><dd class="muted">${t('addWeightSettings')}</dd>` : ''}</dl>
          ${ftpCheck(testResult.ftp, ftp(), trainer.connected ? trainer.name : null)}
          <div class="ftp-actions"><button class="btn primary" data-a="apply">${t('useAsFtp', { w: testResult.ftp })}</button><button class="btn ghost" data-a="keep">${t('keepW', { w: ftp() })}</button></div>
        </div>` : testResult?.incomplete ? `<div class="ftp-result incomplete">
          <div><span class="k">${t('effortNotCompleted')}</span></div>
          <p>${esc(testResult.incomplete.text)} ${t('incompleteStays', { w: ftp() })}${Object.keys(testResult.bests || {}).length ? ` ${t('bestsSaved')}` : ''}</p>
          <dl>${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
          <p class="muted small">${t('repeatFresh')}</p>
        </div>` : testResult?.details ? `<div class="ftp-result"><div><span class="k">${t('powerBestsSaved')}</span></div><dl>${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${testResult.vo2est ? `<dt>${t('vo2Estimate')}</dt><dd>${testResult.vo2est.rel} ml/kg/min</dd>` : ''}</dl></div>` : `<p class="warn-text">${t('notEnoughData')}${testResult?.details ? '' : ` — ${t('powerSourceQ')}`}.</p>${testResult?.details ? `<dl class="ftp-dl">${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}`) : ''}
        <div class="stats">
          ${cell(t('stTime'), fmtTime(this.ridden))}${cell(t('stAvgPower'), st.avgPower && `${st.avgPower} W`)}${cell('NP', st.np && `${st.np} W`)}
          ${cell(t('stAvgHr'), st.avgHr && `${st.avgHr} bpm`)}${cell(t('stCadence'), st.avgCadence && `${st.avgCadence} rpm`)}${cell(t('stEnergy'), st.kj && `${st.kj} kJ`)}
        </div>
        ${fit ? `<div class="sync-list">
          <div class="sl-row"><span class="svc-logo garmin sm">G</span><span class="sl-name">Garmin Connect</span><span class="sl-state" id="garmin-state">${autoGarmin ? `<span class="spinner"></span> ${t('uploading')}` : garmin.connected && syncMode('garmin') !== 'off' ? `<button class="btn ghost sm" data-a="garmin-up">${t('upload')}</button>` : `<button class="btn ghost sm" data-a="garmin">${t('importDots')}</button>`}</span></div>
          ${rideSvcs.map(svcRow).join('')}
          <div class="sl-row sl-file"><span class="sl-name muted">${t('rideFile')}</span><span class="sl-state"><button class="btn ghost sm" data-a="fit">${t('saveFit')}</button></span></div>
        </div>` : ''}
        ${plan ? (next ? `<div class="next-card"><div class="eyebrow">${t('upNextIn', { name: esc(plan.name) })} ${weekDay(next)}</div><h3>${esc(next.title)}</h3><div class="meta">${fmtDur(next.duration)} · TSS ~${next.tss}</div>${miniProfile(next.profile, bounds(), { width: 420, height: 48 })}</div>`
          : `<p class="done-msg">${t('lastWorkoutDone')}</p>`) : ''}
        <div class="modal-actions">
          <button class="btn ${next ? 'ghost' : 'primary'}" data-a="home">${t('done')}</button>
          ${next ? `<button class="btn primary" data-a="next">${t('startNextNow')}</button>` : ''}
        </div>
      </div>`, endAnim ? 'small sticky rise' : 'small sticky');
    const ftpEl = this.test && testResult?.ftp && motionOK() ? $('.ftp-result > div > b', modal) : null;
    if (ftpEl) countUp(ftpEl, ftp(), testResult.ftp, (v) => `${v} W`, endAnim ? 450 : 150);

    const doGarmin = async () => {
      const el = $('#garmin-state', modal);
      if (el) el.innerHTML = `<span class="spinner"></span> ${t('uploadingGarmin')}`;
      try {
        const r = await uploadToGarmin(entry);
        if (el?.isConnected) el.innerHTML = `<a href="#" class="link" data-a="open-url" data-url="${esc(r.url)}">${t('uploaded')}</a>`;
      } catch (e) {
        if (el?.isConnected) el.innerHTML = `<span class="warn-text" title="${esc(String(e))}">${t('uploadFailed')}</span> <button class="btn ghost sm" data-a="garmin-up">${t('retry')}</button> <button class="btn ghost sm" data-a="garmin">${t('manual')}</button>`;
      }
    };
    const doSvc = async (id) => {
      const el = $(`#svc-${id}`, modal);
      if (el) el.innerHTML = `<span class="spinner"></span> ${t('uploading')}`;
      try {
        const r = await uploadToService(entry, id);
        if (el?.isConnected) el.innerHTML = r.url ? `<a href="#" class="link" data-a="open-url" data-url="${esc(r.url)}">${t('uploaded')}</a>` : `<span class="ok-text">${t('uploaded')}</span>`;
      } catch (err) {
        if (el?.isConnected) el.innerHTML = `<span class="warn-text" title="${esc(String(err))}">${t('failed')}</span> <button class="btn ghost sm" data-a="svc-up" data-id="${id}">${t('retry')}</button>`;
      }
    };
    modal.querySelector('.summary').onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      e.preventDefault();
      const a = b.dataset.a;
      if (a === 'apply' || a === 'keep') {
        const box = b.closest('.ftp-actions');
        if (a === 'apply') { applyFtp(state.tests[0]); box.innerHTML = `<span class="badge ok">${t('ftpUpdated', { w: state.tests[0].ftp })}</span>`; }
        else box.innerHTML = `<span class="muted small">${t('keptFtp')}</span>`;
        return;
      }
      if (a === 'open-url') return invoke('open_url', { url: b.dataset.url });
      if (a === 'garmin') return garminImport(fit.path);
      if (a === 'garmin-up') return doGarmin();
      if (a === 'svc-up') return doSvc(b.dataset.id);
      if (a === 'svc-man') return manualImport(b.dataset.id, fit.path);
      if (a === 'fit') return exportFit(fit.path);
      closeModal();
      this.close();
      if (a === 'next') startRide(next.file, plan.id);
    };
    if (autoGarmin) doGarmin();
    for (const sv of rideSvcs) if (sv.connected && svcMode(sv) === 'auto') doSvc(sv.id);
    else if (fit && !garmin.connected && state.settings.garmin?.autoOpen) garminImport(fit.path);
  }

  close() {
    clearInterval(this.loop);
    invoke('keep_awake', { on: false }).catch(() => {});
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    $('#ride').hidden = true;
    $('#ride').innerHTML = '';
    $('#ride').classList.remove('paused');
    document.body.classList.remove('riding');
    $('#ride-title').hidden = true;
    $('#ride-title').innerHTML = '';
    ride = null;
    route();
    if (updFound && updLater !== updFound.version) showUpdateCard();
  }
}

function choiceDialog(title, text, options) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal-actions">${options.map(([v, l, c]) => `<button class="btn ${c}" data-v="${v}">${esc(l)}</button>`).join('')}</div>`, 'small');
    let settled = false;
    modal.addEventListener('close', () => { if (!settled) resolve(null); }, { once: true });
    $$('[data-v]', modal).forEach((b) => (b.onclick = () => { settled = true; closeModal(); resolve(b.dataset.v); }));
  });
}

let audioCtx;
function beep(freq) {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.2);
  } catch { /* audio optional */ }
}

boot().catch((e) => {
  $('#view').innerHTML = `<div class="card"><h2>${t('couldNotLoad')}</h2><p>${esc(e.message || e)}</p></div>`;
});

import { powerAt, segmentAt, estimateTss } from './zwo.js';
import { ZONES, FREE_COLOR, zoneOf, zoneColor, zoneInk, fmtTime, fmtDur, miniProfile, Diagram, Gauge, ProgressRing } from './render.js';
import { Trainer, HeartRate, Controllers, bindNative, invoke } from './ble.js';
import { renderMarkdown, markdownSummary, markdownPlain, smartTrim } from './markdown.js';
import { DEFAULT_SHIFTING, gearTable, virtualSpeed, targetWatts } from './vshift.js';
import { PROTOCOLS, protocolById, isTestWorkout, evaluateGeneric, classifyTest, prepareTestWorkout, vo2max } from './tests.js';

// Platform wording: zwoTrainer runs on macOS, Windows and Linux; only labels differ.
const OS = (() => {
  const p = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  return p.includes('mac') ? 'mac' : p.includes('win') ? 'win' : 'linux';
})();
document.documentElement.dataset.os = OS;
const PLAT = {
  mac: { files: 'Finder', trash: 'Trash', trashFull: 'the Trash', machine: 'Mac', emojiKey: ' (⌃⌘Space)', bt: 'If macOS asked for Bluetooth access, allow it in System Settings → Privacy &amp; Security → Bluetooth.' },
  win: { files: 'Explorer', trash: 'Recycle Bin', trashFull: 'the Recycle Bin', machine: 'PC', emojiKey: ' (Win + .)', bt: 'Make sure Bluetooth is turned on in Settings → Bluetooth &amp; devices (no pairing needed — zwoTrainer connects itself).' },
  linux: { files: 'Files', trash: 'Trash', trashFull: 'the Trash', machine: 'computer', emojiKey: '', bt: 'Make sure Bluetooth is on and the BlueZ service (bluetoothd) is running.' },
}[OS];

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
  saveState: () => { indexHistory(); return invoke('save_profile', { profile: state }).then((r) => { scheduleSync(); return r; }).catch((e) => toast(`Could not save: ${e}`)); },
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
const planMeta = (p) => [plural(p.count, 'workout'), planWeeks(p) ? plural(planWeeks(p), 'week') : null, fmtDur(p.duration)].filter(Boolean).join(' · ');
/** Workouts of a collection carry fake Week01_DayNN numbers — don't show them. */
const showWeekDay = (w) => planById(folderOf(w.file))?.kind === 'plan';

/** Description block: a smart-trimmed ~300-character preview that expands to the full Markdown. */
const DESC_PREVIEW = 300;
function descriptionBlock(md) {
  if (!md) return '';
  const { text, cut } = smartTrim(markdownPlain(md), DESC_PREVIEW);
  if (!cut) return `<section class="plan-desc card"><div class="md">${renderMarkdown(md)}</div></section>`;
  return `<section class="plan-desc card is-collapsed">
    <div class="md md-preview"><p>${esc(text)} <a href="#" class="md-toggle" data-act="desc-toggle">Show more</a></p></div>
    <div class="md md-full">${renderMarkdown(md)}<p><a href="#" class="md-toggle" data-act="desc-toggle">Show less</a></p></div>
  </section>`;
}
let workoutIndex = new Map();
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
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function lastRiddenText(file) {
  const r = lastRidden.get(file);
  return r ? `Last ridden ${relDate(r.at)}${r.count > 1 ? ` · ${r.count}×` : ''}` : '';
}

const favs = () => (state.favorites ||= []);
const isFav = (file) => favs().includes(file);
async function toggleFav(file) {
  const f = favs();
  const i = f.indexOf(file);
  if (i >= 0) f.splice(i, 1); else f.push(file);
  await api.saveState();
  toast(i >= 0 ? 'Removed from favorites' : 'Added to favorites ★');
}
const starBtn = (file) => `<button class="star ${isFav(file) ? 'on' : ''}" data-act="fav" data-file="${esc(file)}" title="${isFav(file) ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite">${isFav(file) ? '★' : '☆'}</button>`;

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
  if (!window.__TAURI__) throw new Error('zwoTrainer must run inside its desktop app.');
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
  if (params.get('sim') === '1') { trainer.startSim(); hrm.startSim(); }
}

function applyAppState(a) {
  if (a.sync !== undefined) syncCfg = a.sync || {};
  profiles = a.profiles;
  state = a.profile;
  indexHistory();
  applyTheme();
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
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const agoText = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : relDate(iso);
};
const SYNC_LABEL = { icloud: 'iCloud Drive', dropbox: 'Dropbox', nextcloud: 'Nextcloud', folder: 'Folder' };

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
    if (!quiet) toast(`Synced with ${SYNC_LABEL[syncCfg.provider] || 'folder'}${r.pulled ? ` · ${r.pulled} updated` : ''}${r.pending ? ' · waiting for iCloud downloads' : ''}`);
    return r;
  } catch (e) {
    syncCfg.lastError = String(e);
    if (!quiet) toast(`Sync failed: ${e}`);
    return null;
  } finally { syncBusy = false; }
}

window.addEventListener('focus', () => { if (syncOn() && Date.now() - Date.parse(syncCfg.lastSync || 0) > 60000) scheduleSync(500); });
setInterval(() => scheduleSync(0), 5 * 60 * 1000);

// ------------------------------------------------------------------ theme
const THEME_LABEL = { system: 'Match system', light: 'Light', dark: 'Dark' };

function applyTheme() {
  const t = state?.settings?.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

async function setTheme(t) {
  state.settings.theme = t;
  applyTheme();
  await api.saveState();
}

// ------------------------------------------------------------------ chrome: profile, mode, devices
const initials = (n) => (n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const AVATAR_COLORS = ['#338cff', '#59bf59', '#ff6639', '#b47cff', '#00a3c4', '#e0a800', '#ff4d8d', '#7f7f7f'];
const avatarColor = (id) => AVATAR_COLORS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
const AVATAR_EMOJI = ['🚴', '🚵', '🏃', '🏊', '⚡', '🔥', '🚀', '🦊', '🐻', '🐼', '🦁', '🐯', '🐺', '🦅', '🐢', '🐝', '🌵', '🌊', '⛰️', '🌞', '⭐', '💪', '🎧', '🏁'];
const avatarBg = (p) => p.avatar?.color || avatarColor(p.id);
const avatar = (p, cls = '') => {
  const e = p.avatar?.emoji;
  return `<span class="avatar ${cls} ${e ? 'emoji' : ''}" style="--av:${avatarBg(p)}">${e ? esc(e) : esc(initials(p.name))}</span>`;
};

function renderProfileChip() {
  const b = $('#btn-profile');
  b.innerHTML = avatar(state);
  b.title = `${state.name} — riders`;
  b.setAttribute('aria-label', `Rider: ${state.name}`);
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

/** Controller button → workout action (Zwift Ride / Play / Click). */
export const BUTTON_ACTIONS = {
  shiftUp: ['gear+', 'Shift up · in ERG segments: intensity +1 %'],
  shiftDown: ['gear-', 'Shift down · in ERG segments: intensity −1 %'],
  up: ['int+', 'Intensity +1 %'],
  down: ['int-', 'Intensity −1 %'],
  right: ['next', 'Next segment'],
  left: ['prev', 'Previous segment'],
  a: ['play', 'Start / pause'],
  powerup: ['play', 'Start / pause'],
  z: ['pct', 'Watts ↔ % FTP'],
  y: ['play', 'Start / pause'],
  b: [null, '—'],
  onoff: [null, '— (switches the controller off)'],
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
  ['trainer', 'Smart trainer', '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>'],
  ['hr', 'Heart rate', '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>'],
  ['controller', 'Shifter', '<svg viewBox="0 0 24 24"><path d="M8 3v18M8 3 4 7M8 3l4 4M16 21V3M16 21l-4-4M16 21l4-4"/></svg>'],
];
const devState = { trainer: {}, hr: {}, controller: {} };

function setDev(kind, s) {
  devState[kind] = { connected: !!s.connected, reconnecting: !!s.reconnecting, name: s.name || '' };
  const dot = $(`#btn-devices .dev-dots i[data-k="${kind}"]`);
  dot.className = s.connected ? 'on' : s.reconnecting ? 'warn' : '';
  const on = Object.values(devState).filter((d) => d.connected).length;
  $('#btn-devices').title = on ? `Devices — ${on} connected` : 'Devices — none connected';
  if ($('#popover.dev-pop')) renderDevicesMenu($('#popover.dev-pop'));
}

function renderDevicesMenu(pop) {
  const saved = state.settings.devices || {};
  pop.innerHTML = `<div class="pop-title">Devices</div>${DEVICE_KINDS.map(([k, label, icon]) => {
    const d = devState[k];
    const savedName = k === 'controller' ? (saved.controllers || []).map((c) => c.name).join(' + ') : saved[k]?.name;
    const status = d.connected ? `<span class="ok-text">${esc(d.name || 'connected')}</span>` : d.reconnecting ? `<span class="warn-text">connecting${d.name ? ` ${esc(d.name)}` : ''}…</span>` : `<span class="muted">${savedName ? `${esc(savedName)} · off` : 'not paired'}</span>`;
    return `<button class="dev-row" data-dev="${k}"><span class="dev-ico ${d.connected ? 'on' : d.reconnecting ? 'warn' : ''}">${icon}</span><span class="dev-txt"><b>${label}</b>${status}</span><span class="dev-act">${d.connected ? 'Change' : 'Connect'}</span></button>`;
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
        <h2>Who's riding?</h2>
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
  const preview = () => avatar({ ...p, avatar: { color: cur.color, emoji: cur.emoji }, name: $('[name=pname]', modal)?.value || p.name }, 'xl');
  openModal(`
    <div class="pv-head"><h2>Edit rider</h2><button class="icon-btn" data-a="close" aria-label="Close">✕</button></div>
    <div class="pe">
      <div class="pe-preview" id="pe-preview">${preview()}</div>
      <div class="pe-fields">
        <label class="pe-name">Name<input type="text" name="pname" value="${esc(p.name)}" maxlength="40" autocomplete="off"></label>
        <div class="pe-label">Colour</div>
        <div class="swatches" id="pe-colors">${AVATAR_COLORS.map((c) => `<button type="button" data-c="${c}" style="--sw:${c}" class="${avatarBg({ ...p, avatar: cur }) === c ? 'on' : ''}" aria-label="${c}"></button>`).join('')}<label class="sw-custom" title="Custom colour"><input type="color" id="pe-custom" value="${avatarBg(p)}">＋</label></div>
        <div class="pe-label">Emoji <small class="muted">— shown instead of the initials</small></div>
        <div class="emoji-grid" id="pe-emoji"><button type="button" data-e="" class="${cur.emoji ? '' : 'on'}" title="Initials">${esc(initials(p.name))}</button>${AVATAR_EMOJI.map((e) => `<button type="button" data-e="${e}" class="${cur.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div>
        <input type="text" id="pe-emoji-own" class="pe-own" placeholder="…or type / paste any emoji${PLAT.emojiKey}" maxlength="8" value="${cur.emoji && !AVATAR_EMOJI.includes(cur.emoji) ? esc(cur.emoji) : ''}">
      </div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-a="back">Back</button><button class="btn primary" data-a="save">Save</button></div>`, 'small');
  const refresh = () => {
    $('#pe-preview', modal).innerHTML = preview();
    $$('#pe-colors [data-c]', modal).forEach((x) => x.classList.toggle('on', x.dataset.c === cur.color));
    $$('#pe-emoji [data-e]', modal).forEach((x) => x.classList.toggle('on', (x.dataset.e || null) === cur.emoji));
  };
  $('#pe-colors', modal).onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { cur.color = b.dataset.c; refresh(); } };
  $('#pe-custom', modal).oninput = (e) => { cur.color = e.target.value; refresh(); };
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
  if (ride) return toast('Finish or end the workout to switch riders');
  openModal(`
    <div class="pv-head"><h2>Riders</h2><button class="icon-btn" data-a="close" aria-label="Close">✕</button></div>
    <div class="profile-list">
      ${profiles.map((p) => `
        <div class="profile-row ${p.id === state.id ? 'on' : ''}" data-id="${esc(p.id)}">
          <button class="profile-pick" data-a="switch">${avatar(p)}<span>${esc(p.name)}</span>${p.id === state.id ? '<small class="muted">· riding</small>' : ''}</button>
          <button class="btn ghost sm" data-a="edit">Edit</button>
          ${profiles.length > 1 ? '<button class="btn ghost sm" data-a="delete">Delete</button>' : ''}
        </div>`).join('')}
    </div>
    <form class="add-profile" id="add-profile"><input type="text" name="name" placeholder="New rider name" maxlength="40" autocomplete="off"><button class="btn primary" type="submit">Add rider</button></form>
    <p class="muted small">Each rider has their own avatar, FTP, zones, plan progress, history, devices, workouts folder, theme and Garmin connection.</p>`, 'small');
  $('#add-profile', modal).onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try { closeModal(); await afterProfileChange(await invoke('create_profile', { name })); toast(`Welcome, ${name} — enter FTP, max HR and weight`); openSettings('rider'); }
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
      if (await confirmDialog(`Delete ${p.name}?`, 'Settings, plan progress, ride history, stored rides and the Garmin sign-in of this rider are removed. This cannot be undone.', 'Delete', true)) {
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
  $('#view').innerHTML = `<section class="hero card empty"><h1>${missing ? 'Choose your workouts folder' : 'No workouts found'}</h1>
    <p>${missing ? `<code>${esc(library.root)}</code> doesn't exist.` : `No <code>.zwo</code> files in <code>${esc(library.root)}</code>.`} Point zwoTrainer at a folder of ZWO files — every sub-folder becomes a plan.</p>
    <div class="upnext-actions" style="margin-top:16px"><button class="btn primary" data-act="pick-dir">Choose folder…</button></div></section>`;
  bindActions($('#view'));
}

function progressBar(pp) {
  const d = (pp.done / pp.total) * 100, s = (pp.skipped / pp.total) * 100;
  return `<div class="pbar" title="${pp.done} done · ${pp.skipped} skipped · ${pp.total} total"><i class="d" style="width:${d}%"></i><i class="s" style="width:${s}%"></i></div>`;
}

function weekDay(w) {
  return w.week ? `<span class="wd">W${w.week} · D${w.day}</span>` : '';
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
            <div class="eyebrow">Active plan</div>
            <h1><a href="#/plan/${encodeURIComponent(active.id)}">${esc(active.name)}</a></h1>
          </div>
          <div class="hero-count"><b>${pp.done + pp.skipped}</b>/${pp.total}<small>${pp.done} done · ${pp.skipped} skipped</small></div>
        </div>
        ${progressBar(pp)}
        ${n ? `
        <div class="upnext">
          <div class="upnext-info">
            <div class="eyebrow">Up next ${weekDay(n)}</div>
            <h2>${esc(n.title)}</h2>
            <div class="meta">${fmtDur(n.duration)} · TSS ~${n.tss}${lastRidden.has(n.file) ? ` · ${lastRiddenText(n.file)}` : ''}</div>
          </div>
          <div class="upnext-profile">${miniProfile(n.profile, bounds(), { width: 420, height: 64 })}</div>
          <div class="upnext-actions">
            <button class="btn primary big" data-act="start-next">Start workout</button>
            <button class="btn ghost" data-act="preview" data-file="${esc(n.file)}">Details</button>
            <button class="btn ghost" data-act="skip-next">Skip</button>
          </div>
        </div>` : `<div class="upnext-done"><p class="done-msg">Plan finished — well done! 🎉</p><button class="btn primary" data-act="close-plan">Pick a new plan</button></div>`}
      </section>`;
  } else {
    hero = `<section class="hero card empty"><h1>Pick a plan</h1><p>Folders in <code>${esc(library.root)}</code> with a weekly schedule are plans. Start one and zwoTrainer walks you through its workouts in order. Just want to ride something? Switch to <a href="#/" data-act="mode-workouts" class="link">Workouts</a>.</p></section>`;
  }

  const plans = library.plans.filter(isPlan);
  const collections = library.plans.length - plans.length;
  v.innerHTML = `
    ${hero}
    <section class="section">
      <div class="section-head">
        <h2>Plans <small>${plans.length}</small></h2>
        <input type="search" id="plan-search" placeholder="Filter plans…" autocomplete="off">
      </div>
      <div class="plan-grid" id="plan-grid"></div>
      ${collections ? `<p class="muted small coll-note">${plural(collections, 'more folder')} without a weekly schedule ${collections === 1 ? 'is' : 'are'} under <a href="#/" data-act="mode-workouts" class="link">Workouts</a> as collections.</p>` : ''}
    </section>`;
  const grid = $('#plan-grid');
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    grid.innerHTML = plans.filter((p) => !ql || p.name.toLowerCase().includes(ql) || p.id.toLowerCase().includes(ql)).map((p) => {
      const pp = planProgress(p);
      const isActive = state.activePlan === p.id;
      return `<a class="plan-card card ${isActive ? 'active' : ''}" href="#/plan/${encodeURIComponent(p.id)}">
        <div class="pc-top"><h3>${esc(p.name)}</h3>${isActive ? '<span class="badge">Active</span>' : pp.finished ? '<span class="badge ok">Done</span>' : ''}</div>
        <div class="meta">${planMeta(p)}</div>
        ${p.description ? `<p class="pc-desc">${esc(markdownSummary(p.description, 110))}</p>` : ''}
        ${pp.started ? progressBar(pp) : ''}
      </a>`;
    }).join('') || '<p class="muted">No plans match.</p>';
  };
  draw();
  $('#plan-search').oninput = (e) => draw(e.target.value);
  bindActions(v);
}

const zoneTag = (z) => (z ? `<span class="ztag" style="--zc:${ZONES[z - 1].color}" title="Training intensity: ${ZONES[z - 1].short} ${ZONES[z - 1].name}">${ZONES[z - 1].short}</span>` : '');

function workoutRow(w, { status, isNext, locked, free, showFolder, note, favTools } = {}) {
  const icon = status === 'done' ? '<span class="st done" title="Done">✓</span>'
    : status === 'skipped' ? '<span class="st skipped" title="Skipped">↷</span>'
      : isNext ? '<span class="st next" title="Up next">●</span>'
        : locked ? '<span class="st locked" title="Do the workouts in order">🔒</span>'
          : lastRidden.has(w.file) ? '<span class="st ridden" title="Ridden before">✓</span>' : '<span class="st"></span>';
  const folder = showFolder ? (planById(folderOf(w.file))?.name || '') : '';
  const wd = w.week && showWeekDay(w);
  const sub = [note, folder, wd ? `W${w.week} · D${w.day}` : '', lastRiddenText(w.file)].filter(Boolean).join(' · ');
  return `<div class="wrow ${isNext ? 'is-next' : ''} ${status || ''}" data-act="preview" data-file="${esc(w.file)}" tabindex="0">
    ${icon}
    <div class="wtitle">${!showFolder && wd ? `<span class="wd">D${w.day}</span>` : ''}<div class="wt"><span>${esc(w.title)}</span>${sub && (showFolder || note || lastRidden.has(w.file)) ? `<small>${esc(showFolder || note ? sub : lastRiddenText(w.file))}</small>` : ''}</div></div>
    <div class="wprof">${miniProfile(w.profile, bounds(), { width: 200, height: 28 })}</div>
    <div class="wdur">${fmtDur(w.duration)}</div>
    <div class="wtss">${zoneTag(w.zone)}<span title="Training Stress Score (estimate)">${w.tss ?? '–'}<small> TSS</small></span></div>
    <div class="wact">${favTools ? `<span class="favtools"><button class="btn ghost sm" data-act="fav-up" data-file="${esc(w.file)}" title="Move up">↑</button><button class="btn ghost sm" data-act="fav-down" data-file="${esc(w.file)}" title="Move down">↓</button></span>` : ''}${starBtn(w.file)}<button class="more" data-act="more" data-file="${esc(w.file)}" title="More" aria-label="More actions">⋯</button>${isNext ? `<button class="btn primary sm" data-act="start-next">Start</button><button class="btn ghost sm" data-act="skip-next">Skip</button>`
      : status === 'skipped' ? `<button class="btn ghost sm" data-act="unskip" data-file="${esc(w.file)}">Undo skip</button>`
        : free ? `<button class="btn ghost sm" data-act="ride-free" data-file="${esc(w.file)}">Ride</button>` : ''}</div>
  </div>`;
}

function renderPlan(id) {
  const plan = planById(id);
  const v = $('#view');
  if (!plan) { v.innerHTML = `<p class="muted">Plan not found. <a href="#/">Back</a></p>`; return; }
  const pp = planProgress(plan);
  const isActive = state.activePlan === plan.id;

  const groups = new Map();
  for (const w of plan.workouts) {
    const k = planWeeks(plan) && w.week ? `Week ${w.week}` : 'Workouts';
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
    ? `<button class="btn ghost" data-act="pause-plan">Leave plan</button>`
    : pp.finished ? `<button class="btn primary" data-act="restart-plan" data-plan="${esc(plan.id)}">Start again</button>`
      : `<button class="btn primary" data-act="start-plan" data-plan="${esc(plan.id)}">${pp.started ? 'Resume plan' : 'Start plan'}</button>`;

  v.innerHTML = `
    <a class="back" href="#/">← All plans</a>
    <section class="plan-head card">
      <div>
        <div class="eyebrow">${isActive ? 'Active plan' : 'Plan'}</div>
        <h1>${esc(plan.name)}</h1>
        <div class="meta">${planMeta(plan)} total · <code>${esc(plan.id)}</code></div>
      </div>
      <div class="plan-actions">${actions}${menuBtn(`${pp.started ? `<button data-act="reset-plan" data-plan="${esc(plan.id)}">Reset progress…</button>` : ''}<button data-act="reveal" data-rel="${esc(plan.id)}">Show in ${PLAT.files}</button><button data-act="set-kind" data-kind="collection" data-rel="${esc(plan.id)}">Show as collection (Workouts only)</button><hr><button class="danger-text" data-act="trash-folder" data-rel="${esc(plan.id)}">Move plan folder to ${PLAT.trash}…</button>`, 'Plan actions')}</div>
      ${pp.started ? `<div class="plan-prog">${progressBar(pp)}<span class="muted">${pp.done} done · ${pp.skipped} skipped · ${pp.total - pp.done - pp.skipped} to go</span></div>` : ''}
    </section>
    ${descriptionBlock(plan.description)}
    ${rows}`;
  bindActions(v);
}

// ------------------------------------------------------------------ workouts mode
const wf = { folder: '', q: '', dur: 'all', sort: 'name', limit: 80, zones: new Set() };
const DUR_FILTERS = [['all', 'Any length'], ['30', '≤ 30 min'], ['60', '30–60 min'], ['90', '60–90 min'], ['90+', '> 90 min']];

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
        <button class="wk-folder ${wf.folder === '' ? 'on' : ''}" data-folder=""><span>All workouts</span><small>${allWorkouts().length}</small></button>
        <button class="wk-folder ${wf.folder === '@fav' ? 'on' : ''}" data-folder="@fav"><span>★ Favorites</span><small>${favs().filter((f) => workoutInfo(f)).length}</small></button>
        ${recentCount ? `<button class="wk-folder ${wf.folder === '@recent' ? 'on' : ''}" data-folder="@recent"><span>Recently ridden</span><small>${recentCount}</small></button>` : ''}
        ${library.singles.length ? `<button class="wk-folder ${wf.folder === '@singles' ? 'on' : ''}" data-folder="@singles"><span>Single workouts</span><small>${library.singles.length}</small></button>` : ''}
        ${[['Plans', folders.filter(isPlan)], ['Collections', folders.filter((p) => !isPlan(p))]].filter(([, l]) => l.length).map(([label, list]) => `<div class="wk-sep">${label}</div>
        ${list.map((p) => `<button class="wk-folder ${wf.folder === p.id ? 'on' : ''}" data-folder="${esc(p.id)}"><span>${esc(p.name)}</span><small>${p.count}</small></button>`).join('')}`).join('')}
      </aside>
      <section class="wk-main">
        <div class="wk-head" id="wk-head"></div>
        <div class="wk-tools">
          <input type="search" id="wk-q" placeholder="Search workouts…" value="${esc(wf.q)}" autocomplete="off">
          <div class="seg-ctl" id="wk-dur">${DUR_FILTERS.map(([k, l]) => `<button data-dur="${k}" class="${wf.dur === k ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="zone-filter" id="wk-zones" title="Filter by training intensity">${ZONES.map((z, i) => `<button data-z="${i + 1}" class="${wf.zones.has(i + 1) ? 'on' : ''}" style="--zc:${z.color}" title="${z.short} ${z.name}"><i></i>${z.short}<span>${z.name}</span></button>`).join('')}</div>
          <select id="wk-sort">${[['name', 'Name'], ['short', 'Shortest'], ['long', 'Longest'], ['tss', 'Hardest (TSS)'], ['zone', 'Intensity'], ['recent', 'Recently ridden']].map(([k, l]) => `<option value="${k}" ${wf.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
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
      ? `<h2>${esc(plan.name)}</h2><span class="badge muted">${isPlan(plan) ? 'Plan' : 'Collection'}</span><span class="grow"></span>${isPlan(plan) ? `<a class="btn ghost sm" href="#/plan/${encodeURIComponent(plan.id)}" data-act="open-plan">Open plan</a>` : ''}${menuBtn(`<button data-act="reveal" data-rel="${esc(plan.id)}">Show in ${PLAT.files}</button>${isPlan(plan) ? `<button data-act="set-kind" data-kind="collection" data-rel="${esc(plan.id)}">Show as collection</button>` : `<button data-act="set-kind" data-kind="plan" data-rel="${esc(plan.id)}">Use as plan…</button>`}<hr><button class="danger-text" data-act="trash-folder" data-rel="${esc(plan.id)}">Move folder to ${PLAT.trash}…</button>`, 'Folder actions')}${plan.description ? `<div class="wk-desc">${descriptionBlock(plan.description)}</div>` : ''}`
      : f === '@fav' ? `<h2>Favorites</h2><span class="muted small">Star ☆ any workout to add it · ↑ ↓ to reorder</span>`
        : f === '' ? `<h2>All workouts</h2><span class="grow"></span>${menuBtn(`<button data-act="reveal" data-rel="">Show library in ${PLAT.files}</button>`, 'Library actions')}` : '';
    bindActions($('#wk-head'));
  };
  const draw = () => {
    head();
    const list = filteredWorkouts();
    $('#wk-count').textContent = `${list.length} workout${list.length === 1 ? '' : 's'}`;
    $('#wk-list').innerHTML = list.slice(0, wf.limit).map((w) => workoutRow(w, { free: true, showFolder: !wf.folder || wf.folder.startsWith('@'), favTools: wf.folder === '@fav' && !wf.q && wf.dur === 'all' })).join('') || (wf.folder === '@fav' ? '<p class="muted">No favorites yet — tap ☆ on any workout.</p>' : '<p class="muted">Nothing matches.</p>');
    $('#wk-more').innerHTML = list.length > wf.limit ? `<button class="btn ghost" data-more>Show more (${list.length - wf.limit} left)</button>` : '';
  };
  draw();
  $('.wk-side', v).onclick = (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    wf.folder = b.dataset.folder; wf.limit = 80;
    $$('.wk-folder', v).forEach((x) => x.classList.toggle('on', x === b));
    draw();
  };
  $('#wk-q').oninput = (e) => { wf.q = e.target.value; wf.limit = 80; draw(); };
  $('#wk-dur').onclick = (e) => { const b = e.target.closest('[data-dur]'); if (!b) return; wf.dur = b.dataset.dur; $$('#wk-dur button').forEach((x) => x.classList.toggle('on', x === b)); wf.limit = 80; draw(); };
  $('#wk-sort').onchange = (e) => { wf.sort = e.target.value; draw(); };
  $('#wk-zones').onclick = (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    const z = +b.dataset.z;
    if (wf.zones.has(z)) wf.zones.delete(z); else wf.zones.add(z);
    b.classList.toggle('on', wf.zones.has(z));
    wf.limit = 80; draw();
  };
  $('#wk-more').onclick = (e) => { if (e.target.closest('[data-more]')) { wf.limit += 200; draw(); } };
  bindActions($('#wk-list'));
}

// ------------------------------------------------------------------ FTP tests mode
const profileOf = (w) => w.segments.map((x) => [x.duration, x.p0, x.p1]);

function ftpSparkline(tests) {
  const pts = tests.filter((t) => t.accepted && t.ftp).slice(0, 12).reverse();
  if (pts.length < 2) return '';
  const W = 260, H = 56, vals = pts.map((t) => t.ftp);
  const lo = Math.min(...vals) * 0.97, hi = Math.max(...vals) * 1.03;
  const xy = pts.map((t, i) => [(i / (pts.length - 1)) * (W - 12) + 6, H - 6 - ((t.ftp - lo) / (hi - lo || 1)) * (H - 12)]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="FTP history"><polyline points="${xy.map((p) => p.join(',')).join(' ')}"/>${xy.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="3"><title>${new Date(pts[i].at).toLocaleDateString()} · ${pts[i].ftp} W</title></circle>`).join('')}</svg>`;
}

function renderTests() {
  const v = $('#view');
  const F = ftp();
  const tests = state.tests || [];
  const last = tests.find((t) => t.ftp);
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
        <div class="eyebrow">Current FTP · ${esc(state.name)}</div>
        <div class="ftp-val"><b>${F}</b> W${wkg(F) ? ` <span class="wkg">${wkg(F)} W/kg</span>` : ''}</div>
        <div class="meta">${last ? `Last test ${relDate(last.at)}: ${esc(last.name)} → ${last.ftp} W${last.accepted ? '' : ' (not applied)'}` : `${tests.length ? 'No completed test yet' : 'No test yet'} — pick one below to find your FTP.`}</div>
      </div>
      <div class="ftp-side">
        ${ftpSparkline(tests)}
        ${(() => { const t = tests.find((x) => x.vo2); return t ? `<div class="vo2"><span class="k">VO2max (est.)</span><b>${t.vo2}</b> ml/kg/min<small class="muted">${esc(t.name)} · ${relDate(t.at)}</small></div>` : weight() ? '' : '<button class="btn ghost sm" data-act="add-weight">Add your weight for W/kg &amp; VO2max</button>'; })()}
        <div class="bests">${[['5 s', b.s5], ['1 min', b.m1], ['5 min', b.m5], ['20 min', b.m20]].map(([k, val]) => `<div><span class="k">${k}</span><b>${val ? `${val} W` : '–'}</b></div>`).join('')}</div>
      </div>
      <div class="zone-strip">${zoneRow}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Tests</h2><span class="muted small">Efforts marked <b>ALL OUT</b> are ridden off ERG — use your gears.</span></div>
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
            <button class="btn primary" data-act="start-test" data-test="${p.id}">Start test</button>
          </article>`;
        }).join('')}
      </div>
    </section>
    ${libTests.length ? `<section class="section"><div class="section-head"><h2>Tests in your library <small>${libTests.length}</small></h2><span class="muted small">Free-ride blocks are your all-out efforts (Zwift convention) and are ridden off ERG</span></div>
      <div class="wlist">${libTests.map((w) => workoutRow(w, { free: true, showFolder: true, note: classifyTest(w.profile, w.title).label })).join('')}</div></section>` : ''}
    <section class="section">
      <div class="section-head"><h2>Test history</h2></div>
      ${tests.length ? `<div class="hlist"><div class="hrow trow hhead"><div>Date</div><div>Test</div><div class="hstat">Result</div><div class="hstat">Change</div><div></div></div>
        ${tests.map((t, i) => `<div class="hrow trow">
          <div class="hdate">${new Date(t.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          <div class="htitle"><b>${esc(t.name)}</b><small class="muted">${esc([...(t.details || []).filter((d) => d[1]).map((d) => `${d[0]} ${d[1]}`), t.vo2 ? `VO2max ~${t.vo2} ml/kg/min` : ''].filter(Boolean).join(' · '))}</small></div>
          <div class="hstat">${t.ftp ? `<b>${t.ftp} W</b>` : t.incomplete ? '<span class="badge warn">Not completed</span>' : '<b>–</b>'}</div>
          <div class="hstat">${t.ftp && t.prevFtp ? `${t.ftp >= t.prevFtp ? '+' : ''}${Math.round(((t.ftp - t.prevFtp) / t.prevFtp) * 100)} %` : ''}</div>
          <div class="hact">${t.accepted ? '<span class="badge ok">Applied</span>' : t.ftp ? `<button class="btn ghost sm" data-act="apply-ftp" data-i="${i}">Use ${t.ftp} W</button>` : ''}</div>
        </div>`).join('')}</div>` : '<p class="muted">Your test results will appear here.</p>'}
    </section>`;
  v.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.act === 'start-test') return startTest(t.dataset.test);
    if (t.dataset.act === 'apply-ftp') return applyFtp(state.tests[+t.dataset.i]);
    if (t.dataset.act === 'add-weight') return openSettings('rider');
    if (t.dataset.act === 'preview') return openPreview(t.dataset.file);
    if (t.dataset.act === 'ride-free') return startRide(t.dataset.file, null);
  };
}

async function applyFtp(entry) {
  const prev = ftp();
  state.settings.ftp = entry.ftp;
  for (const t of state.tests) t.accepted = t === entry;
  await api.saveState();
  toast(`FTP set to ${entry.ftp} W (was ${prev} W)`);
  route();
}

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
    ? `<button data-act="h-svc" data-i="${i}" data-id="${sv.id}">Upload to ${esc(sv.name)}</button>`
    : `<button data-act="h-svc-man" data-i="${i}" data-id="${sv.id}">Import to ${esc(sv.name)}…</button>`).join('');
  return items ? menuBtn(items, 'Send to other platforms') : '';
}

function renderHistory() {
  const v = $('#view');
  const rows = state.history.map((h, i) => {
    return `<div class="hrow">
      <div class="hdate">${new Date(h.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}<small>${new Date(h.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</small></div>
      <div class="htitle"><b>${esc(h.title)}</b><small class="muted">${h.plan ? esc(planById(h.plan)?.name || h.plan) : 'Free ride'}${h.completed === false ? ' · ended early' : ''}</small></div>
      <div class="hstat">${fmtTime(h.doneDuration || 0)}</div>
      <div class="hstat">${h.avgPower ? `${h.avgPower} W` : '–'}</div>
      <div class="hstat">${h.avgHr ? `${h.avgHr} bpm` : '–'}</div>
      <div class="hact">${h.garmin?.url ? `<a class="sync gok" data-act="open-url" data-url="${esc(h.garmin.url)}">Garmin ✓</a>` : h.fitPath ? `<button class="btn ghost sm" data-act="h-garmin" data-i="${i}" title="Upload to Garmin Connect">Garmin</button>` : ''}${svcBadges(h)}${h.fitPath ? `<button class="btn ghost sm" data-act="h-fit" data-i="${i}" title="Save .fit file">FIT</button>${historyMenu(h, i)}` : ''}</div>
    </div>`;
  }).join('');
  v.innerHTML = `
    <a class="back" href="#/">← Back</a>
    <section class="section-head"><h1>Ride history <small class="muted">${esc(state.name)}</small></h1></section>
    ${rows ? `<div class="hlist"><div class="hrow hhead"><div>Date</div><div>Workout</div><div class="hstat">Time</div><div class="hstat">Power</div><div class="hstat">HR</div><div></div></div>${rows}</div>` : '<p class="muted">No rides yet.</p>'}`;
  bindActions(v);
}

function bindActions(root) {
  root.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const act = t.dataset.act;
    const plan = state.activePlan && planById(state.activePlan);
    const h = t.dataset.i !== undefined ? state.history[+t.dataset.i] : null;
    switch (act) {
      case 'preview': return openPreview(t.dataset.file);
      case 'start-next': { const n = plan && planProgress(plan).next; if (n) startRide(n.file, plan.id); return; }
      case 'skip-next': { const n = plan && planProgress(plan).next; if (n && await confirmDialog(`Skip “${n.title}”?`, 'It will be marked as skipped and the plan moves on.', 'Skip')) markEntry(plan.id, n.file, { status: 'skipped' }); return; }
      case 'unskip': return unskip(t.dataset.file);
      case 'ride-free': return startRide(t.dataset.file, null);
      case 'start-plan': return activatePlan(t.dataset.plan);
      case 'restart-plan': delete state.plans[t.dataset.plan]; return activatePlan(t.dataset.plan);
      case 'mode-workouts': return setMode('workouts');
      case 'pause-plan':
        if (await confirmDialog('Leave this plan?', 'Your progress is kept — you can resume it any time.', 'Leave plan')) { state.activePlan = null; await api.saveState(); route(); }
        return;
      case 'pick-dir': return pickDir();
      case 'close-plan': state.activePlan = null; await api.saveState(); return route();
      case 'reset-plan':
        if (await confirmDialog('Reset progress?', 'All done/skipped marks for this plan are removed.', 'Reset', true)) {
          delete state.plans[t.dataset.plan];
          if (state.activePlan === t.dataset.plan) state.activePlan = null;
          await api.saveState(); route();
        }
        return;
      case 'fav': await toggleFav(t.dataset.file); return refreshView();
      case 'fav-up': case 'fav-down': {
        const f = favs(), i = f.indexOf(t.dataset.file), j = i + (act === 'fav-up' ? -1 : 1);
        if (i < 0 || j < 0 || j >= f.length) return;
        [f[i], f[j]] = [f[j], f[i]];
        await api.saveState();
        return refreshView();
      }
      case 'more': return moreMenu(t, t.dataset.file);
      case 'menu': return openMenu(t);
      case 'md-link': return invoke('open_link', { url: t.dataset.link }).catch((err) => toast(String(err)));
      case 'desc-toggle': {
        const box = t.closest('.plan-desc');
        const collapsed = box.classList.toggle('is-collapsed');
        if (collapsed && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
      case 'open-plan': location.hash = `#/plan/${encodeURIComponent(wf.folder)}`; if (mode() !== 'plans') await setMode('plans'); return;
      case 'set-kind': {
        const id = t.dataset.rel;
        const p = planById(id);
        if (t.dataset.kind === 'collection' && state.activePlan === id) {
          if (!await confirmDialog('Show as collection?', `“${p.name}” is your active plan. It will be left (progress is kept) and only appear under Workouts.`, 'Show as collection')) return;
          state.activePlan = null;
        }
        state.settings.folderKinds = { ...(state.settings.folderKinds || {}), [id]: t.dataset.kind };
        await api.saveState();
        toast(t.dataset.kind === 'plan' ? `“${p.name}” is now a plan` : `“${p.name}” now shows under Workouts only`);
        if (t.dataset.kind === 'plan') { if (mode() !== 'plans') await setMode('plans'); location.hash = `#/plan/${encodeURIComponent(id)}`; return; }
        if (location.hash.startsWith('#/plan/')) location.hash = '#/';
        return route();
      }
      case 'reveal': return invoke('reveal_in_library', { rel: t.dataset.rel }).catch((err) => toast(String(err)));
      case 'trash-folder': return trashItem(t.dataset.rel, true);
      case 'open-url': return invoke('open_url', { url: t.dataset.url }).catch((err) => toast(String(err)));
      case 'h-fit': return exportFit(h.fitPath);
      case 'h-svc-man': return manualImport(t.dataset.id, h.fitPath);
      case 'h-svc': {
        toast('Uploading…');
        try { await uploadToService(h, t.dataset.id); toast('Uploaded ✓'); } catch (err) { toast(String(err.message || err)); }
        return refreshView();
      }
      case 'h-garmin': {
        const g = await invoke('garmin_status').catch(() => ({}));
        if (!g.connected) return garminImport(h.fitPath);
        t.disabled = true; t.textContent = 'Uploading…';
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
const menuBtn = (items, label = 'More actions') => `<span class="menu-wrap"><button class="more" data-act="menu" title="${label}" aria-label="${label}">⋯</button><template>${items}</template></span>`;

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
    <button data-p="fav">${isFav(file) ? '★ Remove from favorites' : '☆ Add to favorites'}</button>
    <button data-p="reveal">Show in ${PLAT.files}</button>
    <button data-p="folder">Open its folder</button>
    <hr><button data-p="trash" class="danger-text">Move workout to ${PLAT.trash}…</button>`;
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
  const title = isFolder ? `Move “${plan?.name || rel}” to ${PLAT.trashFull}?` : `Move “${info?.title || rel}” to ${PLAT.trashFull}?`;
  const text = isFolder
    ? `The whole folder (${plan?.count ?? '?'} workouts) is moved to ${PLAT.trashFull} — you can restore it from there. Plan progress for this folder is removed; your ride history stays.`
    : `The .zwo file is moved to ${PLAT.trashFull} — you can restore it from there. Your ride history stays.`;
  if (!await confirmDialog(title, text, `Move to ${PLAT.trash}`, true)) return;
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
  toast(`Moved to ${PLAT.trash}`);
  if (isFolder && location.hash.startsWith('#/plan/')) location.hash = '#/';
  await loadLibrary();
}

async function activatePlan(id) {
  if (state.activePlan && state.activePlan !== id) {
    const cur = planById(state.activePlan);
    if (!await confirmDialog('Switch plan?', `“${cur?.name}” is active. Its progress is kept and you can resume it later.`, 'Switch')) return;
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
  toast('Workout is up next again');
  route();
}

// ------------------------------------------------------------------ modals
const modal = $('#modal');
function openModal(html, cls = '') {
  modal.className = cls;
  $('.modal-body', modal).innerHTML = html;
  if (!modal.open) modal.showModal();
  return modal;
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('click', (e) => { if (e.target === modal && !modal.classList.contains('sticky')) closeModal(); });
modal.addEventListener('cancel', (e) => { if (modal.classList.contains('sticky')) e.preventDefault(); });

function confirmDialog(title, text, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal-actions"><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`, 'small');
    const done = (r) => { modal.removeEventListener('close', onClose); closeModal(); resolve(r); };
    const onClose = () => resolve(false);
    modal.addEventListener('close', onClose, { once: true });
    $$('[data-r]', modal).forEach((b) => (b.onclick = () => done(b.dataset.r === '1')));
  });
}

function promptDialog(title, value = '') {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><form id="pf"><input type="text" name="v" value="${esc(value)}" maxlength="40" class="full" autocomplete="off"><div class="modal-actions"><button class="btn ghost" type="button" data-r="0">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`, 'small');
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
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

async function openPreview(file) {
  const info = workoutInfo(file);
  openModal(`<div class="loading">Loading…</div>`, 'wide');
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
  const planLink = plan && isPlan(plan) && !onPlanPage ? `<button class="btn ghost" data-a="plan" title="Go to “${esc(plan.name)}”">Open plan</button>` : '';
  let actions = '';
  if (mode() !== 'plans') actions = `<span class="muted small">Free ride — not counted in a plan</span>${planLink}<button class="btn primary" data-a="free">Ride</button>`;
  else if (isNext) actions = `${planLink}<button class="btn ghost" data-a="skip">Skip</button><button class="btn primary" data-a="start">Start workout</button>`;
  else if (inActive) actions = `<span class="muted">${entry ? `Marked ${entry.status}` : 'Locked — finish or skip the earlier workouts first.'}</span>${planLink}`;
  else if (plan) actions = `<span class="muted small">Part of “${esc(plan.name)}”</span><button class="btn primary" data-a="plan">Open plan</button>`;
  else actions = `<button class="btn primary" data-a="free">Ride</button>`;

  const lr = lastRiddenText(file);
  openModal(`
    <div class="pv-head">
      <div><div class="eyebrow">${plan ? esc(plan.name) : 'Workout'}${info?.week && showWeekDay(info) ? ` · Week ${info.week} · Day ${info.day}` : ''}</div><h2>${esc(info?.title || workout.name)}</h2>
      <div class="meta">${fmtDur(workout.duration)} · TSS ~${estimateTss(workout.segments)} · ${workout.segments.length} segments${workout.author ? ` · ${esc(workout.author)}` : ''}${lr ? ` · <b class="lr">${lr}</b>` : ''}</div></div>
      <div class="pv-tools">${starBtn(file)}<button class="more" data-act="more" data-file="${esc(file)}" title="More" aria-label="More actions">⋯</button><button class="icon-btn" data-a="close" aria-label="Close">✕</button></div>
    </div>
    <div class="pv-diagram"></div>
    <div class="seg-info muted">Tap a segment for details · FTP ${ftp()} W</div>
    ${zoneBreakdown(workout)}
    ${workout.description ? `<p class="pv-desc">${esc(workout.description)}</p>` : ''}
    <div class="modal-actions">${actions}</div>`, 'wide');

  $('.pv-tools', modal).onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'fav') { await toggleFav(file); t.outerHTML = starBtn(file); refreshView(); }
    if (t.dataset.act === 'more') { closeModal(); setTimeout(() => moreMenu(document.querySelector(`.wrow[data-file="${CSS.escape(file)}"] .more`) || t, file), 0); }
  };
  const d = new Diagram($('.pv-diagram', modal), workout, {
    bounds: bounds(), ftp: ftp(),
    onSelect: (i, s) => { d.highlight(i); $('.seg-info', modal).innerHTML = segmentText(s); },
  });
  $$('[data-a]', modal).forEach((b) => (b.onclick = async () => {
    const a = b.dataset.a;
    if (a === 'close') return closeModal();
    closeModal();
    if (a === 'start') startRide(file, active.id);
    if (a === 'free') startRide(file, null);
    if (a === 'plan') { if (mode() !== 'plans') await setMode('plans'); location.hash = `#/plan/${encodeURIComponent(planId)}`; }
    if (a === 'skip' && await confirmDialog(`Skip “${info.title}”?`, 'It will be marked as skipped and the plan moves on.', 'Skip')) markEntry(active.id, file, { status: 'skipped' });
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
  return `<div class="zones-bar">${ZONES.map((z, i) => secs[i] ? `<i style="flex:${secs[i]};background:${z.color}" title="${z.short} ${z.name}: ${fmtTime(secs[i])}"></i>` : '').join('')}${free ? `<i style="flex:${free};background:${FREE_COLOR}" title="Free ride ${fmtTime(free)}"></i>` : ''}</div>
  <div class="zones-legend">${ZONES.map((z, i) => `<span><i style="background:${z.color}"></i>${z.short} ${z.name} <b>${Math.round((secs[i] / total) * 100)}%</b></span>`).join('')}</div>`;
}

function targetText(s, mult = 1) {
  if (s.p0 === null) return s.type === 'maxeffort' ? 'Max effort' : 'Free ride';
  const a = Math.round(s.p0 * 100 * mult), b = Math.round(s.p1 * 100 * mult);
  const wa = Math.round(s.p0 * ftp() * mult), wb = Math.round(s.p1 * ftp() * mult);
  return a === b ? `${a}% · ${wa} W` : `${a}–${b}% · ${wa}–${wb} W`;
}

function segmentText(s) {
  const kind = { steady: 'Steady', warmup: 'Warm-up', cooldown: 'Cool-down', ramp: 'Ramp', on: 'Interval on', off: 'Interval off', freeride: 'Free ride', maxeffort: 'Max effort' }[s.type];
  const z = s.p0 !== null ? zoneOf((s.p0 + s.p1) / 2, bounds()) : null;
  return `<b>${s.label}${s.reps ? ` (${s.rep}/${s.reps})` : ''}</b> ${kind} · ${fmtTime(s.duration)} · ${targetText(s)}${s.cadence ? ` · ${s.cadence} rpm` : ''}${z ? ` · <span style="color:var(--z${z.id}-ink)">${z.short} ${z.name}</span>` : ''}`;
}

// ------------------------------------------------------------------ settings
/** Upload mode selector: “Off / manual / auto”. */
function syncMode(svc) {
  return (state.settings[svc] || {}).mode || 'auto';
}
const MODES = [['off', 'Off'], ['manual', 'Manual'], ['auto', 'Automatic']];
const modeSelect = (name, cur) => `<div class="frow sync-mode">Upload <span class="seg-ctl" data-mode-ctl="${name}">${MODES.map(([k, l]) => `<button type="button" data-v="${k}" class="${cur === k ? 'on' : ''}">${l}</button>`).join('')}</span></div>`;

async function openSettings(tab = 'rider') {
  const s = state.settings;
  const themeBefore = s.theme || 'system';
  const [garmin, targets, svcs] = await Promise.all([invoke('garmin_status').catch(() => ({})), invoke('sync_targets').catch(() => []), refreshServices()]);
  const svcCard = (sv) => {
    const mode = svcMode(sv);
    const status = sv.connected ? `Connected${sv.account ? ` as ${esc(sv.account)}` : ''}` : sv.kind === 'manual' ? 'Manual import' : 'Not connected';
    const action = sv.connected ? `<button class="btn ghost sm" data-a="svc-off" data-id="${sv.id}">Disconnect</button>` : '';
    let body = '';
    if (sv.connected) body = modeSelect(`svc-${sv.id}`, mode);
    else if (sv.kind === 'apikey') body = `<div class="cred"><input type="password" name="key-${sv.id}" placeholder="Intervals.icu API key" autocomplete="off"><button class="btn primary sm" data-a="svc-key" data-id="${sv.id}">Connect</button></div>
      <p class="muted small">${esc(sv.hint)} <a href="#" class="link" data-a="svc-getkey">Open Intervals.icu settings</a></p>`;
    else if (sv.manualUrl) body = `<div class="frow sync-mode">After a ride <span class="seg-ctl" data-mode-ctl="svc-${sv.id}">${[['off', 'Off'], ['manual', 'Show import button']].map(([k, l]) => `<button type="button" data-v="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</span></div><p class="muted small">${esc(sv.hint)}</p>`;
    return `<div class="svc svc-ext ${sv.connected ? 'on' : ''}"><div class="svc-head"><span class="svc-logo ext">${SVC_LOGO[sv.id] || sv.name[0]}</span><div><b>${esc(sv.name)}</b><small class="muted">${status}</small></div>${action}</div>${body}</div>`;
  };
  const sp = syncOn() ? syncCfg.provider : 'off';
  const syncRow = (id, label, path, found, extra = '') => `<label class="sync-opt ${found ? '' : 'na'}"><input type="radio" name="syncp" value="${id}" ${sp === id ? 'checked' : ''} ${found ? '' : 'disabled'}><span><b>${label}</b><small class="muted">${extra || (path ? esc(path.replace(/^\/Users\/[^/]+/, '~')) : `not found on this ${PLAT.machine} — install the desktop app`)}</small></span></label>`;
  openModal(`
    <div class="pv-head"><h2>Settings <small class="muted">· ${esc(state.name)}</small></h2><button class="icon-btn" data-a="close" aria-label="Close">✕</button></div>
    <div class="tabs" id="set-tabs">${[['rider', 'Rider'], ['app', 'App'], ['sync', 'Connections']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>

    <div class="tab-pane" data-pane="rider" ${tab === 'rider' ? '' : 'hidden'}>
      <div class="form">
        <label>FTP <span><input type="number" name="ftp" value="${s.ftp}" min="50" max="600"> W</span></label>
        <label>Max heart rate <span><input type="number" name="maxHr" value="${s.maxHr}" min="100" max="230"> bpm</span></label>
        <label>Weight <span><input type="number" name="weight" value="${s.weight ?? ''}" min="30" max="200" step="0.1" placeholder="kg"> kg</span></label>
      </div>
      <h3>Personal bests <small class="muted">updated by FTP tests</small></h3>
      <div class="bests-form">${[['s5', '5 s'], ['m1', '1 min'], ['m5', '5 min'], ['m20', '20 min']].map(([k, l]) => `<label>${l}<span><input type="number" name="b_${k}" value="${s.bests?.[k] ?? ''}" min="0" max="3000"> W</span></label>`).join('')}</div>
      <h3>Training zones <small class="muted">upper limit in % FTP</small></h3>
      <div class="zone-form">
        ${ZONES.map((z, i) => `<div class="zf"><i style="background:${z.color}"></i><span>${z.short} ${z.name}</span>
          ${i < 4 ? `<span>≤ <input type="number" name="z${i}" value="${s.zones[i]}" min="30" max="200"> %</span>` : `<span>&gt; <em id="z5-lim">${s.zones[3]}</em> %</span>`}</div>`).join('')}
      </div>
    </div>

    <div class="tab-pane" data-pane="app" ${tab === 'app' ? '' : 'hidden'}>
      <div class="form">
        <div class="frow">Appearance <span class="seg-ctl" id="theme-ctl">${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme="${t}" class="${(s.theme || 'system') === t ? 'on' : ''}">${THEME_LABEL[t]}</button>`).join('')}</span></div>
        <label class="check"><input type="checkbox" name="beeps" ${s.beeps ? 'checked' : ''}> Countdown beeps before segment changes</label>
        <label class="check"><input type="checkbox" name="autoPause" ${s.autoPause !== false ? 'checked' : ''}> Auto-pause when you stop pedalling (resumes automatically)</label>
      </div>
      <h3>Workouts folder</h3>
      <div class="folder-row"><code>${esc(library.root)}</code><button class="btn ghost sm" data-a="dir">Change…</button><button class="btn ghost sm" data-a="rescan" title="Re-read the folder">Rescan</button></div>
      <h3>Virtual shifting <small class="muted">free-ride &amp; all-out segments</small></h3>
      <div class="form">
        <div class="frow">Default <span class="seg-ctl" id="vs-mode">${[['ask', 'Ask'], ['gears', 'Real gears'], ['virtual', 'Virtual gears']].map(([k, l]) => `<button type="button" data-v="${k}" class="${shifting().mode === k ? 'on' : ''}">${l}</button>`).join('')}</span></div>
        <div class="frow">Difficulty <span class="seg-ctl" id="vs-diff">${['easy', 'medium', 'hard'].map((k) => `<button type="button" data-v="${k}" class="${shifting().difficulty === k ? 'on' : ''}">${k}</button>`).join('')}</span></div>
        <label>Gear ratio range <span><input type="number" name="vsMin" value="${shifting().minRatio}" min="0.4" max="2" step="0.05"> – <input type="number" name="vsMax" value="${shifting().maxRatio}" min="2.5" max="7" step="0.05"></span></label>
        <label>Start gear <span><input type="number" name="vsStart" value="${shifting().startGear}" min="1" max="${shifting().gears}"> of ${shifting().gears}</span></label>
      </div>
      <h3>Devices</h3>
      <p class="muted small">Trainer: ${esc(s.devices?.trainer?.name || 'none')} · Heart rate: ${esc(s.devices?.hr?.name || 'none')} · Shifter: ${esc((s.devices?.controllers || []).map((c) => c.name).join(' + ') || 'none')} — pair or forget them with the buttons in the top bar.</p>
    </div>

    <div class="tab-pane" data-pane="sync" ${tab === 'sync' ? '' : 'hidden'}>
      <div class="svc">
        <div class="svc-head"><span class="svc-logo sync"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/></svg></span>
          <div><b>Profile sync</b><small class="muted" id="sync-status">${syncOn() ? `${SYNC_LABEL[sp]} · ${syncCfg.lastError ? `<span class="warn-text">${esc(syncCfg.lastError)}</span>` : syncCfg.lastSync ? `last synced ${agoText(syncCfg.lastSync)}` : 'not synced yet'}` : `Off — riders stay on this ${PLAT.machine}`}</small></div>
          ${syncOn() ? '<button class="btn ghost sm" data-a="sync-now">Sync now</button>' : ''}</div>
        <div class="sync-opts" id="sync-opts">
          ${syncRow('off', 'Off', null, true, `Keep riders on this ${PLAT.machine} only`)}
          ${targets.map((t) => syncRow(t.provider, t.label, t.path, t.found)).join('')}
          ${syncRow('folder', 'Other folder…', sp === 'folder' ? syncCfg.dir : null, true, sp === 'folder' ? esc(syncCfg.dir) : 'Any folder that another app keeps in sync')}
        </div>
        <p class="muted small">Syncs all riders (avatar, FTP &amp; zones, plan progress, favorites, ride history, FTP tests) and the ride FIT files through a <code>zwoTrainer</code> folder. Paired devices, the workouts folder and the Garmin sign-in stay on each ${PLAT.machine}. The newest change wins; ride history is merged.</p>
      </div>
      <div class="svc">
        <div class="svc-head"><span class="svc-logo garmin">G</span><div><b>Garmin Connect</b><small class="muted">${garmin.connected ? `Signed in${garmin.name ? ` as ${esc(garmin.name)}` : ''}` : 'Not signed in'}</small></div>
          ${garmin.connected ? '<button class="btn ghost sm" data-a="garmin-off">Sign out</button>' : '<button class="btn garmin" data-a="garmin-on">Sign in to Garmin</button>'}</div>
        ${garmin.connected ? modeSelect('garminMode', syncMode('garmin')) : `<p class="muted small">Sign in once on Garmin's own page (MFA supported). zwoTrainer keeps only a session token for this rider on this ${PLAT.machine} — never your password — and uploads every finished ride (Edge identity: Training Effect, VO2max, challenges).</p>`}
        <p class="muted small"><b>Strava:</b> link Strava to your Garmin account once (Garmin Connect → Settings → Connected Apps → Strava) and rides go on to Strava from there.</p>
        <details class="adv">
          <summary>Manual FIT import (fallback)</summary>
          <p class="muted small">Saves the FIT file into this folder, shows it in ${PLAT.files} and opens Garmin Connect's import page.</p>
          <div class="folder-row"><code>${esc(s.garmin?.folder || 'Downloads')}</code><button class="btn ghost sm" data-a="garmin-dir">Change…</button></div>
          <label class="check"><input type="checkbox" name="garminAuto" ${s.garmin?.autoOpen ? 'checked' : ''}> Open the manual import after every finished workout (when not signed in)</label>
        </details>
      </div>
      <h3 class="svc-group">More platforms</h3>
      ${svcs.map(svcCard).join('')}
    </div>

    <div class="modal-actions"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="save">Save</button></div>`, 'small settings');

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
    else if (v !== 'off') dir = targets.find((t) => t.provider === v)?.path;
    try {
      syncCfg = await invoke('sync_config', { provider: v, dir, auto: true });
      if (syncOn()) await runSync(false); else toast('Profile sync off');
    } catch (err) { toast(String(err)); }
    openSettings('sync');
  };
  $('#theme-ctl', modal).onclick = (e) => {
    const t = e.target.closest('[data-theme]')?.dataset.theme;
    if (!t) return;
    s.theme = t;
    applyTheme();
    $$('#theme-ctl button', modal).forEach((x) => x.classList.toggle('on', x.dataset.theme === t));
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
    const z = [0, 1, 2, 3].map((i) => +f(`z${i}`).value);
    if (z.every((v, i) => v > 0 && (i === 0 || v > z[i - 1]))) s.zones = z; else toast('Zone limits must increase — kept the old ones');
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
  $$('[data-a]', modal).forEach((b) => (b.onclick = async (e) => {
    e.preventDefault();
    const a = b.dataset.a;
    if (a === 'close' || a === 'cancel') { if (s.theme !== themeBefore) setTheme(themeBefore); return closeModal(); }
    if (a === 'dir') { closeModal(); return pickDir(); }
    if (a === 'rescan') { closeModal(); await loadLibrary(); return toast(`${library.plans.length} plans found`); }
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
      if (!apiKey) return toast('Paste your API key first');
      collect(); await api.saveState();
      const label = b.textContent;
      b.disabled = true; b.textContent = 'Checking…';
      try {
        svcCache = await invoke('service_connect', { id, apiKey });
        state.settings.services = { ...(state.settings.services || {}), [id]: { mode: 'auto' } };
        await api.saveState();
        const sv = svcCache.find((x) => x.id === id);
        toast(`${sv?.name} connected${sv?.account ? ` — ${sv.account}` : ''}`);
        return openSettings('sync');
      } catch (err) { b.disabled = false; b.textContent = label; return toast(String(err)); }
    }
    if (a === 'svc-off') {
      const sv = svcs.find((x) => x.id === b.dataset.id);
      if (!await confirmDialog(`Disconnect ${sv.name}?`, 'Rides will no longer be uploaded there for this rider.', 'Disconnect', true)) return openSettings('sync');
      collect(); await api.saveState();
      svcCache = await invoke('service_disconnect', { id: sv.id }).catch((err) => { toast(String(err)); return svcCache; });
      return openSettings('sync');
    }
    if (a === 'sync-now') { b.disabled = true; await runSync(false); return openSettings('sync'); }
    if (a === 'garmin-on') {
      collect(); await api.saveState();
      b.disabled = true; b.textContent = 'Sign in in the Garmin window…';
      try {
        const st = await invoke('garmin_connect');
        state.settings.garmin = { ...(state.settings.garmin || {}), mode: 'auto' };
        await api.saveState();
        toast(`Garmin Connect linked${st.name ? ` — ${st.name}` : ''}`);
        return openSettings('sync');
      } catch (err) { b.disabled = false; b.textContent = 'Sign in to Garmin'; return toast(String(err)); }
    }
    if (a === 'garmin-off') {
      if (!await confirmDialog('Sign out of Garmin?', 'Rides will no longer be uploaded to Garmin Connect for this rider.', 'Sign out', true)) return openSettings('sync');
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
  toast(`${library.plans.length} plans in ${dir.split('/').pop()}`);
}

async function controllerDialog() {
  const connected = await ctrls.list();
  const saved = state.settings.devices?.controllers || [];
  openModal(`<h2>Shifter · virtual shifting</h2>
    <p class="muted">Zwift Ride, Zwift Click (v1/v2) or Zwift Play. Shifting drives the virtual gears in free-ride segments and the intensity in ERG segments; the other buttons control the workout.</p>
    ${connected.length ? `<div class="dev-list">${connected.map((c) => `<div class="dev on"><span>${esc(c.name)}</span><small class="ok-text">connected</small></div>`).join('')}</div>
    <div class="btn-test" id="btn-test"><span class="k">button test</span><b id="bt-last">press a button…</b><small class="muted" id="bt-raw"></small></div>
    <table class="btn-map small">${Object.entries(BUTTON_ACTIONS).filter(([, [a]]) => a).map(([k, [, l]]) => `<tr data-btn="${k}"><td><kbd>${BUTTON_LABEL[k]}</kbd></td><td>${l}</td></tr>`).join('')}</table>` : ''}
    <div class="dev-list" id="dev-list"><div class="scanning"><span class="spinner"></span>Searching… press a button on the controller to wake it</div></div>
    <ul class="tips small muted">
      <li><b>Zwift Ride:</b> connect only the <b>left</b> controller — it relays the right one's buttons.</li>
      <li><b>Zwift Click v2</b> stops after ~1 min unless unlocked: open the Zwift app on a phone once, connect the Click there, wait ~90 s, close Zwift (no subscription needed).</li>
      <li>Close Zwift and other training apps first — controllers accept only one connection.</li>
    </ul>
    <div class="modal-actions">${connected.length ? '<button class="btn ghost" data-a="disc">Disconnect all</button>' : ''}<button class="btn ghost" data-a="rescan">Search again</button><button class="btn ghost" data-a="close">Close</button></div>`, 'small');
  const list = $('#dev-list', modal);
  if (connected.length) {
    let rawCount = 0;
    const onRaw = (e) => { const el = $('#bt-raw', modal); if (el) el.textContent = `${++rawCount} messages · last ${e.hex.slice(0, 24)}`; };
    ctrls.handlers.raw = [onRaw];
    buttonTester = (button, device) => {
      const el = $('#bt-last', modal);
      if (!el?.isConnected) { buttonTester = null; return; }
      el.textContent = `${BUTTON_LABEL[button] || button} · ${device}`;
      $$('.btn-map tr', modal).forEach((r) => r.classList.toggle('hit', r.dataset.btn === button));
    };
  }
  const search = async () => {
    list.innerHTML = '<div class="scanning"><span class="spinner"></span>Searching… press a button on the controller to wake it</div>';
    try {
      const found = await ctrls.scan(5);
      if (!list.isConnected) return;
      list.innerHTML = found.length
        ? found.map((f) => `<button class="dev" data-id="${esc(f.id)}" data-name="${esc(f.name)}"><span>${esc(f.name)}${saved.some((x) => x.id === f.id) ? ' <small class="muted">· last used</small>' : ''}</span><small class="muted">${f.rssi != null ? `${f.rssi} dBm` : ''}</small></button>`).join('')
        : '<p class="muted">No controller found. Press any button on it and search again.</p>';
    } catch (e) { list.innerHTML = `<p class="warn-text">${esc(String(e))}</p>`; }
  };
  list.onclick = async (e) => {
    const b = e.target.closest('.dev[data-id]');
    if (!b) return;
    b.innerHTML = `<span><span class="spinner"></span> Connecting ${esc(b.dataset.name)}…</span>`;
    try {
      const info = await ctrls.connect(b.dataset.id);
      const devs = (state.settings.devices ||= {});
      devs.controllers = [...(devs.controllers || []).filter((c) => c.id !== b.dataset.id), { id: b.dataset.id, name: info.name }];
      await api.saveState();
      toast(`${info.name} connected — shift with its buttons`);
      controllerDialog();
    } catch (err) { b.innerHTML = `<span class="warn-text">Failed: ${esc(String(err))}</span>`; }
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
  const label = kind === 'trainer' ? 'Smart trainer' : 'Heart rate monitor';
  const saved = state.settings.devices?.[kind];
  if (dev.connected || dev.reconnecting) {
    openModal(`<h2>${label}</h2><p>${dev.reconnecting ? 'Reconnecting to' : 'Connected to'} <b>${esc(dev.name)}</b>${kind === 'trainer' && dev.connected ? (trainer.canErg ? ' · ERG control active' : ' · power only (no ERG control)') : ''}.</p>
      <div class="modal-actions"><button class="btn ghost" data-a="forget">Forget device</button><button class="btn ghost" data-a="close">Close</button><button class="btn danger" data-a="disc">Disconnect</button></div>`, 'small');
  } else {
    openModal(`<h2>${label}</h2>
      <p class="muted">${kind === 'trainer' ? 'Bluetooth FTMS trainers get ERG control; a Bluetooth power meter works too (no ERG). Close Zwift and other training apps first — most trainers accept only one connection.' : 'Any Bluetooth heart-rate strap or watch broadcasting HR.'}</p>
      <div class="dev-list" id="dev-list"><div class="scanning"><span class="spinner"></span>Searching…</div></div>
      <div class="modal-actions"><button class="btn ghost" data-a="sim">Use simulator</button><button class="btn ghost" data-a="rescan">Search again</button><button class="btn ghost" data-a="close">Close</button></div>`, 'small');
    const list = $('#dev-list', modal);
    const search = async () => {
      list.innerHTML = '<div class="scanning"><span class="spinner"></span>Searching…</div>';
      try {
        const found = await dev.scan(4);
        if (!modal.open || !list.isConnected) return;
        list.innerHTML = found.length
          ? found.map((f) => `<button class="dev" data-id="${esc(f.id)}" data-name="${esc(f.name)}"><span>${esc(f.name)}${saved?.id === f.id ? ' <small class="muted">· last used</small>' : ''}</span><small class="muted">${f.rssi != null ? `${f.rssi} dBm` : ''}</small></button>`).join('')
          : '<p class="muted">Nothing found. Wake the device (pedal / wet the strap) and search again.</p>';
      } catch (e) {
        list.innerHTML = `<p class="warn-text">${esc(String(e))}</p><p class="muted small">${PLAT.bt}</p>`;
      }
    };
    list.onclick = async (e) => {
      const b = e.target.closest('.dev');
      if (!b) return;
      list.innerHTML = `<div class="scanning"><span class="spinner"></span>Connecting to ${esc(b.dataset.name)}…</div>`;
      try {
        const info = await dev.connect(b.dataset.id);
        state.settings.devices = { ...(state.settings.devices || {}), [kind]: { id: b.dataset.id, name: info.name } };
        await api.saveState();
        closeModal();
        toast(`${info.name} connected${kind === 'trainer' ? (info.erg ? ' · ERG ready' : ' · power only') : ''}`);
      } catch (err) {
        list.innerHTML = `<p class="warn-text">Connection failed: ${esc(String(err))}</p>`;
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
    toast(`Drag ${p.split('/').pop()} into ${sv?.name || id}${sv?.manualZip ? ' (Import Data)' : ''}`);
  } catch (e) { toast(String(e)); }
}

// ------------------------------------------------------------------ activities & sync
async function exportFit(path) {
  try { const p = await invoke('export_activity', { path }); if (p) toast(`Saved ${p.split('/').pop()}`); }
  catch (e) { toast(`Export failed: ${e}`); }
}

async function garminImport(path) {
  try { const p = await invoke('garmin_import', { path }); toast(`Saved ${p.split('/').pop()} — drag it into Garmin Connect`); }
  catch (e) { toast(`Garmin: ${e}`); }
}

/** Activity title + description for uploads: the workout's name as shown in zwoTrainer, and
 *  plan · week/day as context. */
function rideMeta(h) {
  const plan = h.plan ? planById(h.plan) : null;
  const info = workoutInfo(h.file);
  const wd = plan && info?.week && showWeekDay(info) ? `W${info.week} D${info.day}` : null;
  return {
    name: h.title || info?.title || 'zwoTrainer workout',
    description: [[plan?.name, wd].filter(Boolean).join(' · ') || null, 'Ridden with zwoTrainer'].filter(Boolean).join(' — '),
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
  if (!workout.segments.length) return toast('This workout has no segments');
  const info = workoutInfo(file);
  if (info && isTestWorkout(info)) {
    const kind = classifyTest(info.profile, info.title);
    if (kind.kind === 'broken-ramp') {
      const p = protocolById(kind.lite ? 'ramp-lite' : 'ramp');
      if (!await confirmDialog('Use the built-in ramp?', `“${info.title}” doesn't contain the actual ramp (the exported file only has a warm-up and cool-down). Ride zwoTrainer's ${p.name} instead?${planId ? ' It counts for this plan.' : ''}`, `Start ${p.name}`)) return;
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
  plug: svgI('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'),
};
/** Plausibility note for a test result that differs a lot (> 15 %) from the current FTP. */
function ftpCheck(next, cur, source) {
  if (!next || !cur) return '';
  const d = (next - cur) / cur;
  if (Math.abs(d) <= 0.15) return '';
  const pct = `${Math.round(Math.abs(d) * 100)} %`;
  const src = source ? `the power came from <b>${esc(source)}</b>` : 'the right device measured your power';
  const why = d > 0
    ? `That's ${pct} above your current FTP. Before applying it, check that ${src} and that the trainer was calibrated (spin-down) recently — uncalibrated trainers often read high.`
    : `That's ${pct} below your current FTP. Fatigue, illness or pacing can cost a lot of watts, and an uncalibrated trainer can read low. Check that ${src} — or repeat the test when you're fresh.`;
  return `<p class="ftp-check">${why}</p>`;
}

const SEG_KIND = { steady: 'Steady state', warmup: 'Warm-up', cooldown: 'Cool-down', ramp: 'Ramp', on: 'Power interval', off: 'Recovery', freeride: 'Free ride', maxeffort: 'Max effort' };
const segKind = (s) => `${s.erg === false ? 'All-out effort' : SEG_KIND[s.type] || 'Segment'}${s.reps ? ` ${s.rep}/${s.reps}` : ''}`;
/** Fill a metric bar: frac 0…1, optional target marker (0…1) and colour. */
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

const OVERLAY = [['power', 'Power'], ['cadence', 'Cadence'], ['hr', 'Heart rate']];

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
    rt.innerHTML = `${this.test ? '<span class="badge test">FTP test</span>' : ''}${plan ? `<span class="badge">${esc(plan.name)}${this.info?.week ? ` · W${this.info.week} D${this.info.day}` : ''}</span>` : this.test ? '' : '<span class="badge muted">Workout</span>'}
      <h1 title="${esc(this.info?.title || this.w.name)}">${esc(this.info?.title || this.w.name)}</h1><span class="erg" id="erg-state"></span>`;
    rt.hidden = false;
    r.innerHTML = `
      <div class="ride-top">
        <section class="panel live">
          <header class="ph"><span class="ph-dot" id="live-dot"></span><b>Live</b>${IC.pulse}<span class="ph-status" id="live-status"></span></header>
          <div class="live-body">
            <div class="metrics">
              <div class="metric">${IC.bolt}<div class="m-txt"><span class="k">Power</span><span class="m-val"><b id="m-pow">–</b><small>W</small><em id="m-pow-t"></em></span><div class="mbar" id="b-pow"><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.cad}<div class="m-txt"><span class="k">Cadence</span><span class="m-val"><b id="v-cad">–</b><small>rpm</small><em id="t-cad"></em></span><div class="mbar" id="b-cad"><i class="band"></i><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.speed}<div class="m-txt"><span class="k">Speed</span><span class="m-val"><b id="v-spd">–</b><small>km/h</small></span><div class="mbar" id="b-spd"><i class="fill"></i></div></div></div>
              <div class="metric">${IC.heart}<div class="m-txt"><span class="k">Heart rate</span><span class="m-val"><b id="v-hr">–</b><small>bpm</small><em id="t-hr"></em></span><div class="mbar" id="b-hr"><i class="fill"></i></div></div></div>
            </div>
            <button class="gauge" id="gauge" title="Click: watts ↔ % FTP">
              <div class="gauge-mount"></div>
              <div class="gauge-center"><span class="k" id="g-unit">watt</span><b id="v-pow">–</b><small id="t-pow">–</small></div>
            </button>
          </div>
        </section>
        <section class="panel seg">
          <header class="ph">${IC.target}<b>Current segment</b><span class="ph-status" id="seg-kind"></span></header>
          <div class="seg-ring">
            <div class="ring-mount"></div>
            <div class="ring-center">
              <b id="s-target">–</b>
              <small id="s-watts"></small>
            </div>
          </div>
          <div class="gearbox" id="gearbox" hidden><button class="btn round sm" data-shift="-1" title="Shift down (−)">−</button><span id="gear-lbl">Gear</span><button class="btn round sm" data-shift="1" title="Shift up (+)">+</button></div>
          <div class="stat-row">
            <div class="stat">${IC.bolt}<div><span class="k" id="s-tw-k">Target power</span><b id="s-tw">–</b></div></div>
            <div class="stat">${IC.watch}<div><span class="k">Segment</span><b id="s-dur">0:00</b><div class="sbar"><i id="s-bar"></i></div></div></div>
            <div class="stat rem">${IC.flag}<div><span class="k">Remaining</span><b id="s-rem">0:00</b></div></div>
          </div>
        </section>
        <section class="panel next">
          <header class="ph">${IC.layers}<b>Next segment</b></header>
          <div class="nx-card" id="next-card"></div>
          <div class="stat-row">
            <div class="stat">${IC.bolt}<div><span class="k">Target power</span><b id="n-tw">–</b></div></div>
            <div class="stat">${IC.watch}<div><span class="k">Duration</span><b id="n-dur">–</b></div></div>
            <div class="stat int">${IC.dial}<div><span class="k">Intensity</span><b id="int-val">100%</b><span class="int-ctrl"><button class="int-btn" data-int="-1" title="−1 % (Shift: −10 %)" aria-label="Intensity −1 %">−</button><button class="int-btn" data-int="1" title="+1 % (Shift: +10 %)" aria-label="Intensity +1 %">+</button></span></div></div>
          </div>
        </section>
      </div>
      <div class="ride-diagram panel">
        <div class="dg-times">
          <div class="wt-head"><span class="ph-mini">${IC.bars}<b>Workout</b></span><div class="wt-time"><span class="k">elapsed</span><b id="d-el">0:00</b></div></div>
          <span class="overlay-toggles" id="ov">${OVERLAY.map(([k, l]) => `<button data-ov="${k}" class="ov ov-${k} ${ov[k] ? 'on' : ''}"><i></i>${l}</button>`).join('')}</span>
          <div class="wt-time rem"><span class="k">remaining</span><b id="d-rem">${fmtTime(this.w.duration)}</b><small id="d-tot">of ${fmtTime(this.w.duration)}</small></div>
        </div>
        <div class="dg-mount"></div>
        <div class="coach-msg" id="msg" hidden></div>
        <div class="dg-tip" id="dg-tip" hidden></div>
      </div>
      <div class="ride-controls">
        <button class="ctl" data-c="prev" title="Previous segment (←)"><svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-9 7 9 7z"/></svg></button>
        <button class="ctl" data-c="back" title="Back 1 minute"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg></button>
        <button class="ctl play" data-c="play" title="Start / pause (Space)" id="btn-play"><svg viewBox="0 0 24 24" class="i-play"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" class="i-pause"><path d="M8 5v14M16 5v14"/></svg></button>
        <button class="ctl" data-c="stop" title="End workout"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
        <button class="ctl" data-c="fwd" title="Forward 1 minute"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/></svg></button>
        <button class="ctl" data-c="next" title="Next segment (→)"><svg viewBox="0 0 24 24"><path d="M18 5v14M5 5l9 7-9 7z"/></svg></button>
      </div>
      <div class="ready" id="ready"><div><b>Ready?</b><span>Press <kbd>Space</kbd> or ▶ to start${trainer.connected ? ' — or just start pedalling' : ''}.</span></div>
        ${this.hasFree ? `<div class="vs-ask"><span class="k">free-ride segments</span><span class="seg-ctl" id="vs-choice">${[['gears', 'Real gears'], ['easy', 'Virtual gears easy'], ['medium', 'medium'], ['hard', 'hard']].map(([k, l]) => `<button data-vs="${k}" class="${(k === 'gears' ? !this.vs.on : this.vs.on && this.vs.difficulty === k) ? 'on' : ''}">${l}</button>`).join('')}</span></div>` : ''}</div>`;

    this.gauge = new Gauge($('.gauge-mount', r));
    this.ring = new ProgressRing($('.ring-mount', r));
    this.diagram = new Diagram($('.dg-mount', r), this.w, {
      bounds: bounds(), ftp: ftp(), maxHr: maxHr(), overlay: ov,
      onSelect: (i, s) => {
        const tip = $('#dg-tip');
        tip.innerHTML = `${segmentText(s)} <button class="btn ghost sm" data-c="goto" data-i="${i}">Jump here</button>`;
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
        if (this.freeLike) { this.shift(d); return this.hint(`Gear ${this.gear + 1}`); }
        this.adjust(d); return this.hint(`Intensity ${this.intensity}%`);
      }
      case 'int+': this.adjust(1); return this.hint(`Intensity ${this.intensity}%`);
      case 'int-': this.adjust(-1); return this.hint(`Intensity ${this.intensity}%`);
      case 'next': if (this.control('next') !== false) this.hint('Next segment ⏭'); return;
      case 'prev': if (this.control('prev') !== false) this.hint('⏮ Previous segment'); return;
      case 'play': this.toggle(); return this.hint(this.running ? '▶ Running' : '⏸ Paused');
      case 'pct': this.showPct = !this.showPct; this.render(true); return this.hint(this.showPct ? '% FTP' : 'Watts');
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
      st.innerHTML = on ? `${IC.plug}${trainer.mode === 'sim' ? 'Simulator' : 'Connected'}` : 'No trainer';
      st.className = `ph-status ${on ? 'ok' : ''}`;
      dot.className = `ph-dot ${on ? 'on' : ''}`;
    }
    const e = $('#erg-state');
    if (!e) return;
    if (!trainer.connected) { e.textContent = 'No trainer — timer only'; e.className = 'erg off'; }
    else if (trainer.canErg) { e.textContent = 'ERG'; e.className = 'erg on'; }
    else { e.textContent = 'Power only'; e.className = 'erg'; }
  }

  async wake() {
    invoke('keep_awake', { on: true }).catch(() => {});
    // Windows (WebView2) has no helper process for this — use the Screen Wake Lock API
    if (OS === 'win' && navigator.wakeLock && !this.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
  }

  mult() { return this.intensity / 100; }

  adjust(d) {
    this.intensity = Math.max(50, Math.min(150, this.intensity + d));
    this.render(true);
  }

  /** Seek with test rules: no skipping inside a measured effort (ramp or all-out), and a jump never
   *  lands in the middle of one — forward snaps to its start, backward to its end — so efforts are
   *  always ridden in one piece and never counted twice. Returns false when blocked. */
  go(t) {
    if (!this.test) return this.seek(t);
    const segs = this.w.segments;
    if (segs[this.segIdx]?.measure && !this.cooling) { this.hint('Skipping is off during a test effort'); return false; }
    const k = segmentAt(segs, Math.max(0, Math.min(t, this.w.duration - 0.01)));
    const s = segs[k];
    if (s?.measure && t > s.start) {
      let a = k, b = k;
      while (a > 0 && segs[a - 1].measure === s.measure) a--;
      while (b < segs.length - 1 && segs[b + 1].measure === s.measure) b++;
      t = t >= this.t ? segs[a].start : segs[b].start + segs[b].duration;
    }
    return this.seek(t);
  }

  seek(t) {
    this.t = Math.max(0, Math.min(this.w.duration - 0.01, t));
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
      if (this.idleFor >= 3) { this.toggle(true); this.hint('⏸ Auto-paused — pedal to continue'); }
    } else if (this.autoPaused) {
      this.pedalFor = pedalling ? (this.pedalFor || 0) + realDt : 0;
      if (this.pedalFor >= 1) { this.toggle(); this.hint('▶ Resumed'); }
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
        for (let t = from; t <= sec; t++) {
          const i = Math.max(0, segmentAt(this.w.segments, Math.min(t, this.w.duration - 0.01)));
          const wall = SPEED > 1 ? (this.startedAt.getTime() + this.samples.length * 1000) : Date.now();
          this.samples.push({ t, p: fresh('power'), c: fresh('cadence'), hr: fresh('hr'), v: this.vsSpeed ?? fresh('speed'), tp: this.targetW, seg: i, measure: this.w.segments[i]?.measure, wall });
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
    const cool = { type: 'cooldown', duration: 300, p0: easy, p1: easy * 0.8, texts: [{ t: 0, msg: 'Ramp done! Cool down easy — press ⏹ any time for your result' }] };
    this.w.segments = [...segs.slice(0, i + 1), cool];
    let t = 0;
    this.w.segments.forEach((x, k) => { x.idx = k + 1; x.label = String(k + 1); x.start = t; t += x.duration; });
    this.w.duration = t;
    this.diagram.w = this.w;
    this.diagram.draw();
    $('#d-tot').textContent = `of ${fmtTime(t)}`;
    this.hint('Ramp complete — cooling down');
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
      $('#gear-lbl').innerHTML = `<b>Gear ${this.gear + 1}</b><small>/${this.gears.length} · ${this.gears[this.gear].toFixed(2)}${vsActive ? ` · ${this.vs.watts} W` : ''}</small>`;
    }

    // beeps: last 3 s before a change of target
    const n = segs[idx + 1];
    if (state.settings.beeps && this.running && n && rem <= 3.05 && rem > 0) {
      const k = `${idx}:${Math.ceil(rem)}`;
      if (!this.beeped.has(k)) { this.beeped.add(k); beep(Math.ceil(rem) === 1 ? 880 : 660); }
    }

    const ergEl = $('#erg-state');
    if (ergEl && trainer.connected && trainer.canErg) {
      ergEl.textContent = vsActive ? `Virtual gears · ${this.vs.difficulty}` : freeLike ? 'ERG off · use gears' : 'ERG';
      ergEl.className = vsActive ? 'erg vs' : freeLike ? 'erg off' : 'erg on';
    }

    // LIVE panel
    const p = fresh('power'), c = fresh('cadence'), hr = fresh('hr'), v = fresh('speed');
    const gt = vsActive ? this.vs.watts : allOut ? null : tw;
    $('#m-pow').textContent = p ?? '–';
    $('#m-pow-t').textContent = gt != null ? `/ ${gt}` : '';
    // power bar: 0…1.5× target (marker at the target), coloured by the zone you're riding in
    const pRef = gt || F;
    setBar($('#b-pow'), p != null ? p / (pRef * 1.5) : 0, { mark: gt ? 1 / 1.5 : null, color: p != null ? zoneColor(p / F, bounds()) : null });

    // cadence vs target (Zwift: Cadence / CadenceLow+High): green on target, amber ±5–10, red beyond 10 rpm
    const cLo = s.cadenceLow ?? s.cadence, cHi = s.cadenceHigh ?? s.cadence;
    $('#v-cad').textContent = c != null ? Math.round(c) : '–';
    $('#t-cad').textContent = cLo != null ? `target ${cLo === cHi ? cLo : `${cLo}–${cHi}`}` : '';
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

    $('#g-unit').textContent = this.showPct ? '% FTP' : 'watt';
    $('#v-pow').textContent = p == null ? '–' : this.showPct ? `${Math.round((p / F) * 100)}%` : p;
    $('#t-pow').textContent = gt == null ? (s.type === 'maxeffort' ? 'max' : allOut ? 'all out' : 'free') : this.showPct ? `${Math.round((gt / F) * 100)}%` : `${gt} W`;
    this.gauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });

    // CURRENT SEGMENT
    const color = zoneColor(tf, bounds());
    this.ring.update(Math.min(1, inSeg / s.duration), color);
    if (s.p0 === null) { $('#s-target').classList.remove('range'); $('#s-target').textContent = s.type === 'maxeffort' ? 'MAX' : 'FREE'; $('#s-watts').textContent = vsActive ? 'virtual shifting' : 'ride by feel'; }
    else {
      const a = Math.round(s.p0 * 100 * this.mult()), b = Math.round(s.p1 * 100 * this.mult());
      $('#s-target').textContent = allOut ? 'ALL OUT' : a === b ? `${a}%` : `${a}–${b}%`;
      $('#s-target').classList.toggle('range', a !== b || allOut);
      $('#s-watts').textContent = allOut ? `aim ~${tw} W · ${vsActive ? 'shift' : 'gears'}` : `${tw} W`;
    }
    $('#s-target').style.color = zoneInk(tf, bounds());
    $('#s-tw').textContent = gt != null ? `${gt} W` : allOut ? 'All out' : 'Free';
    $('#s-tw').style.color = gt != null ? zoneInk(gt / F, bounds()) : '';
    // live pacing in long all-out test efforts: running average, projected FTP, "too fast" warning
    const pacing = this.test && allOut && s.measure && s.duration >= 300;
    $('#s-tw-k').textContent = pacing ? (s.duration >= 480 ? 'Est. FTP' : 'Effort avg') : 'Target power';
    $('#s-watts').classList.remove('warn-text');
    if (pacing) {
      const acc = this.effAcc?.[s.measure];
      const avg = acc && acc.n >= 5 ? Math.round(acc.sum / acc.n) : null;
      const factor = s.duration >= 1140 ? 0.95 : s.duration >= 480 ? 0.9 : null;
      const fast = !!(avg && tw && acc.n >= 60 && avg > tw * 1.1);
      $('#s-target').textContent = avg ? `${avg} W` : 'ALL OUT';
      $('#s-target').classList.toggle('range', !avg);
      if (avg) $('#s-target').style.color = zoneInk(avg / F, bounds());
      $('#s-watts').textContent = !avg ? `aim ~${tw ?? '–'} W · ${vsActive ? 'shift' : 'gears'}` : fast ? 'too fast · ease off' : tw ? `avg · aim ~${tw} W` : 'effort average';
      $('#s-watts').classList.toggle('warn-text', fast);
      if (fast && !this.paceWarned?.[s.measure]) { (this.paceWarned ||= {})[s.measure] = true; this.hint('Too fast — ease off a little, it\'s a long effort'); }
      const proj = avg && factor && acc.n >= 30 ? Math.round(avg * factor) : null;
      $('#s-tw').textContent = factor ? (proj ? `${proj} W` : '–') : (avg ? `${avg} W` : '–');
      $('#s-tw').style.color = '';
    }
    $('#s-dur').textContent = fmtTime(s.duration);
    $('#s-bar').style.width = `${Math.min(100, (inSeg / s.duration) * 100)}%`;
    $('#s-bar').style.background = color;
    $('#s-rem').textContent = fmtTime(Math.ceil(rem));
    $('.panel.seg').classList.toggle('closing', rem <= 5 && !!n);

    if (segChanged || force) {
      $('#seg-kind').textContent = segKind(s);
      // NEXT SEGMENT
      const card = $('#next-card');
      if (n) {
        const m = this.mult();
        const nf = n.p0 === null ? null : ((n.p0 + n.p1) / 2) * m;
        const pa = n.p0 === null ? null : Math.round(n.p0 * 100 * m), pb = n.p0 === null ? null : Math.round(n.p1 * 100 * m);
        const wa = n.p0 === null ? null : Math.round(n.p0 * F * m), wb = n.p0 === null ? null : Math.round(n.p1 * F * m);
        const big = n.p0 === null ? (n.type === 'maxeffort' ? 'Max effort' : 'Free ride') : n.erg === false ? 'All out' : pa === pb ? `${pa}%` : `${pa}% → ${pb}%`;
        const watts = n.p0 === null ? 'ride by feel' : wa === wb ? `${wa} W` : `${wa} → ${wb} W`;
        const nLo = n.cadenceLow ?? n.cadence, nHi = n.cadenceHigh ?? n.cadence;
        card.style.setProperty('--zc', zoneColor(nf, bounds()));
        card.innerHTML = `<div class="nc-txt"><b>${big}</b><span class="nc-w" style="color:${zoneInk(nf, bounds())}">${watts}</span></div>
          ${nLo != null ? `<span class="nc-cad" title="Target cadence">${IC.cad}<b>${nLo === nHi ? nLo : `${nLo}–${nHi}`}</b><small>rpm</small></span>` : `<span class="nc-zone" title="${nf == null ? 'Free ride' : zoneOf(nf, bounds()).name}">${IC.bars}</span>`}`;
        $('#n-tw').textContent = n.p0 === null ? '–' : wa === wb ? `${wa} W` : `${wa}–${wb}`;
        $('#n-tw').classList.toggle('range', n.p0 !== null && wa !== wb);
        $('#n-dur').textContent = fmtTime(n.duration);
      } else {
        card.style.setProperty('--zc', 'var(--line-strong)');
        card.innerHTML = this.cooling
          ? '<div class="nc-txt"><b>Test done</b><span class="nc-w muted">press ⏹ for your result</span></div>'
          : '<div class="nc-txt"><b>Finish strong</b><span class="nc-w muted">no more changes</span></div>';
        $('#n-tw').textContent = '–';
        $('#n-dur').textContent = '–';
      }
      $('#int-val').textContent = `${this.intensity}%`;
      $('#int-val').classList.toggle('changed', this.intensity !== 100);
      this.diagram.highlight(idx);
      $('#btn-play').classList.toggle('is-running', this.running);
    }

    // text events
    const ev = s.texts.filter((x) => inSeg >= x.t && inSeg < x.t + 10).pop();
    const msg = $('#msg');
    if (ev) { if (msg.textContent !== ev.msg) msg.textContent = ev.msg; msg.hidden = false; } else msg.hidden = true;

    $('#d-el').textContent = fmtTime(this.t);
    $('#d-rem').textContent = fmtTime(Math.max(0, Math.ceil(this.w.duration - this.t)));
    this.diagram.update(this.t, this.samples);
  }

  async stop() {
    const wasRunning = this.running;
    if (wasRunning) this.toggle();
    if (!this.started) return this.close();
    if (this.test && this.cooling) return this.finish(true); // the ramp is over — show the result
    if (this.test) {
      const c = await choiceDialog('End test?', this.w.segments[this.segIdx]?.ramp ? 'Your FTP is calculated from the ramp so far.' : `You rode ${fmtTime(this.ridden)}. The result is calculated from what you've done.`, [
        ['resume', 'Resume', 'ghost'], ['discard', 'Discard', 'ghost'], ['save', 'Finish & evaluate', 'primary']]);
      if (c === 'resume' || !c) { if (wasRunning) this.toggle(); return; }
      if (c === 'discard') return this.close();
      return this.finish(true);
    }
    const pct = Math.round((this.t / this.w.duration) * 100);
    const choice = await choiceDialog('End workout?', `You completed ${pct}% (${fmtTime(this.ridden)} ridden).`, [
      ['resume', 'Resume', 'ghost'],
      ...(this.planId ? [['skip', 'Count as skipped', 'ghost']] : []),
      ['discard', 'Discard', 'ghost'],
      ['save', this.planId ? 'Save as done' : 'Save', 'primary'],
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
        .catch((e) => { toast(`Could not save the ride file: ${e}`); return null; });
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
      const act = auto ? `<span class="spinner"></span> Uploading…` : sv.connected ? `<button class="btn ghost sm" data-a="svc-up" data-id="${sv.id}">Upload</button>` : `<button class="btn ghost sm" data-a="svc-man" data-id="${sv.id}">Import…</button>`;
      return `<div class="sl-row"><span class="svc-logo ext sm">${SVC_LOGO[sv.id]}</span><span class="sl-name">${esc(sv.name)}</span><span class="sl-state" id="svc-${sv.id}">${act}</span></div>`;
    };

    const plan = this.planId && planById(this.planId);
    const next = plan && planProgress(plan).next;
    const cell = (k, v) => `<div><span class="k">${k}</span><b>${v ?? '–'}</b></div>`;
    openModal(`
      <div class="summary">
        <div class="eyebrow">${this.test ? 'FTP test result' : completed ? 'Workout complete' : 'Workout saved'}</div>
        <h2>${esc(title)}</h2>
        ${this.test ? (testResult?.ftp ? `
        <div class="ftp-result">
          <div><span class="k">Your FTP is ~</span><b>${testResult.ftp} W</b><small class="${testResult.ftp >= ftp() ? 'up' : 'down'}">${testResult.ftp >= ftp() ? '+' : ''}${testResult.ftp - ftp()} W vs. current ${ftp()} W</small></div>
          <dl>${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
            ${wkg(testResult.ftp) ? `<dt>FTP per kg</dt><dd>${wkg(testResult.ftp)} W/kg</dd>` : ''}
            ${testResult.vo2est ? `<dt>VO2max (estimate)</dt><dd>${testResult.vo2est.rel} ml/kg/min · ${testResult.vo2est.abs} L/min <small class="muted">${esc(testResult.vo2est.method)}</small></dd>` : testResult.vo2 && !weight() ? '<dt>VO2max</dt><dd class="muted">add your weight in Settings → Rider</dd>' : ''}</dl>
          ${ftpCheck(testResult.ftp, ftp(), trainer.connected ? trainer.name : null)}
          <div class="ftp-actions"><button class="btn primary" data-a="apply">Use ${testResult.ftp} W as my FTP</button><button class="btn ghost" data-a="keep">Keep ${ftp()} W</button></div>
        </div>` : testResult?.incomplete ? `<div class="ftp-result incomplete">
          <div><span class="k">Effort not completed</span></div>
          <p>${esc(testResult.incomplete.text)} An FTP from an incomplete effort would be too low, so your FTP stays at <b>${ftp()} W</b>.${Object.keys(testResult.bests || {}).length ? ' Your power bests from this ride are saved.' : ''}</p>
          <dl>${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
          <p class="muted small">Repeat the test when you're fresh — pace the effort a little lower at the start.</p>
        </div>` : testResult?.details ? `<div class="ftp-result"><div><span class="k">Power bests saved</span></div><dl>${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}${testResult.vo2est ? `<dt>VO2max (estimate)</dt><dd>${testResult.vo2est.rel} ml/kg/min</dd>` : ''}</dl></div>` : `<p class="warn-text">Not enough power data to calculate an FTP${testResult?.details ? '' : ' — was a power source connected?'}.</p>${testResult?.details ? `<dl class="ftp-dl">${testResult.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}`) : ''}
        <div class="stats">
          ${cell('time', fmtTime(this.ridden))}${cell('avg power', st.avgPower && `${st.avgPower} W`)}${cell('NP', st.np && `${st.np} W`)}
          ${cell('avg HR', st.avgHr && `${st.avgHr} bpm`)}${cell('cadence', st.avgCadence && `${st.avgCadence} rpm`)}${cell('energy', st.kj && `${st.kj} kJ`)}
        </div>
        ${fit ? `<div class="sync-list">
          <div class="sl-row"><span class="svc-logo garmin sm">G</span><span class="sl-name">Garmin Connect</span><span class="sl-state" id="garmin-state">${autoGarmin ? '<span class="spinner"></span> Uploading…' : garmin.connected && syncMode('garmin') !== 'off' ? '<button class="btn ghost sm" data-a="garmin-up">Upload</button>' : '<button class="btn ghost sm" data-a="garmin">Import…</button>'}</span></div>
          ${rideSvcs.map(svcRow).join('')}
          <div class="sl-row sl-file"><span class="sl-name muted">Ride file</span><span class="sl-state"><button class="btn ghost sm" data-a="fit">Save .fit</button></span></div>
        </div>` : ''}
        ${plan ? (next ? `<div class="next-card"><div class="eyebrow">Up next in ${esc(plan.name)} ${weekDay(next)}</div><h3>${esc(next.title)}</h3><div class="meta">${fmtDur(next.duration)} · TSS ~${next.tss}</div>${miniProfile(next.profile, bounds(), { width: 420, height: 48 })}</div>`
          : `<p class="done-msg">That was the last workout — plan finished! 🎉</p>`) : ''}
        <div class="modal-actions">
          <button class="btn ${next ? 'ghost' : 'primary'}" data-a="home">Done</button>
          ${next ? '<button class="btn primary" data-a="next">Start next now</button>' : ''}
        </div>
      </div>`, 'small sticky');

    const doGarmin = async () => {
      const el = $('#garmin-state', modal);
      if (el) el.innerHTML = '<span class="spinner"></span> Uploading to Garmin…';
      try {
        const r = await uploadToGarmin(entry);
        if (el?.isConnected) el.innerHTML = `<a href="#" class="link" data-a="open-url" data-url="${esc(r.url)}">Uploaded ✓</a>`;
      } catch (e) {
        if (el?.isConnected) el.innerHTML = `<span class="warn-text" title="${esc(String(e))}">Upload failed</span> <button class="btn ghost sm" data-a="garmin-up">Retry</button> <button class="btn ghost sm" data-a="garmin">Manual</button>`;
      }
    };
    const doSvc = async (id) => {
      const el = $(`#svc-${id}`, modal);
      if (el) el.innerHTML = '<span class="spinner"></span> Uploading…';
      try {
        const r = await uploadToService(entry, id);
        if (el?.isConnected) el.innerHTML = r.url ? `<a href="#" class="link" data-a="open-url" data-url="${esc(r.url)}">Uploaded ✓</a>` : '<span class="ok-text">Uploaded ✓</span>';
      } catch (err) {
        if (el?.isConnected) el.innerHTML = `<span class="warn-text" title="${esc(String(err))}">Failed</span> <button class="btn ghost sm" data-a="svc-up" data-id="${id}">Retry</button>`;
      }
    };
    modal.querySelector('.summary').onclick = (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      e.preventDefault();
      const a = b.dataset.a;
      if (a === 'apply' || a === 'keep') {
        const box = b.closest('.ftp-actions');
        if (a === 'apply') { applyFtp(state.tests[0]); box.innerHTML = `<span class="badge ok">FTP updated to ${state.tests[0].ftp} W — zones adjusted</span>`; }
        else box.innerHTML = '<span class="muted small">Kept your current FTP — you can apply the result later under FTP Tests.</span>';
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
  $('#view').innerHTML = `<div class="card"><h2>Could not load</h2><p>${esc(e.message || e)}</p></div>`;
});

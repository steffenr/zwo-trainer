// zwoTrainer UI controller (entry module). Sections, top to bottom:
//   riders, api and library helpers · boot · theme, riders, top bar · devices menu · routing and views
//   (renderHome / renderPlan / renderWorkouts / renderTests / renderHistory) · actions (bindActions,
//   ⋯ menus) · dialogs (preview, workouts folder, devices) · other platforms and uploads.
// Elsewhere: shared state, DOM helpers, dialogs and toasts in ./core.js; the ride screen and summary in
// ./ride/ride.js; Settings in ./views/settings.js; profile sync in ./sync.js; in-app updates in ./updates.js.
// Markup: html`` from ./html.js (auto-escaping) and the helpers in ./components/ for shared pieces;
// markup reaches the DOM only through mount() (scripts/check-html.mjs). Rust is reached only through
// invoke() / listen() (ble.js).
import { powerAt, estimateTss } from './zwo.js';
import { ZONES, FREE_COLOR, zoneOf, fmtTime, fmtDur, miniProfile, Diagram, motionOK } from './render.js';
import { bindNative, invoke } from './ble.js';
import { batteryBadge, lowestLevel } from './battery.js';
import { renderMarkdown, markdownSummary, markdownPlain, smartTrim } from './markdown.js';
import { PROTOCOLS, protocolById, isTestWorkout, classifyTest } from './tests.js';
import { t, pct, setLocale, systemLocale, coerceLocale, fmtLocale, translateDom } from './i18n/index.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import { badge, wdTag, zoneTag } from './components/indicators.js';
import { dialogHead, closeBtn } from './components/dialog.js';
import { segCtl, selectSeg, menuBtn } from './components/buttons.js';
import { avatarInk } from './components/avatar.js';
import {
  PLAT, $, $$, params,
  library, setLibrary, state, setState, live, trainer, hrm, ctrls,
  bounds, ftp, weight, wkg, mode, planById, allWorkouts, workoutInfo, folderOf, indexLibrary,
  relDate, planProgress, ride, restartAnim,
  modal, openModal, closeModal, confirmDialog, toast, rovingKey,
} from './core.js';
import { startRide, startTest } from './ride/ride.js';
import { openSettings } from './views/settings.js';
import { setSyncCfg, syncOn, scheduleSync, runSync } from './sync.js';
import { initUpdates } from './updates.js';

// Used by ride/ride.js, views/settings.js and sync.js (which import from this module in turn; see the note there).
export {
  api, route, bindActions, openMenu, pointerFocused, weekDay, segmentText, markEntry, applyFtp,
  syncMode, svcMode, svcRoute, SVC_LOGO, refreshServices, uploadToService, manualImport,
  exportFit, garminImport, uploadToGarmin,
  openExternal, applyTheme, applyLanguage, renderProfileChip, THEME_LABEL, devicesMenu, pickDir, loadLibrary,
  svcCache, setSvcCache, applyAppState,
};

// ------------------------------------------------------------------ state
let profiles = [];        // [{ id, name }]
let lastRidden = new Map(); // file -> { at, count }

const api = {
  appState: () => invoke('app_state'),
  library: () => invoke('scan_library'),
  workout: (file) => invoke('load_workout', { file }),
  saveState: () => { indexHistory(); return invoke('save_profile', { profile: state }).then((r) => { scheduleSync(); return r; }).catch((e) => toast(t('couldNotSave', { e }))); },
};

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
let lastView = null;         // micro animations: last rendered view (fade in on change)
const pbarMemo = new Map();  // plan id -> last progress-bar widths (glide on change)
let justDone = null;         // file just marked done (its check draws itself once)


/** Rebuild "last ridden" per workout file from the rider's history (for the ✓ marks and the "ridden 3 d ago" line). */
function indexHistory() {
  lastRidden = new Map();
  for (const h of state?.history || []) {
    const cur = lastRidden.get(h.file);
    if (!cur) lastRidden.set(h.file, { at: h.at, count: 1 });
    else { cur.count++; if (h.at > cur.at) cur.at = h.at; }
  }
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
  if (a.sync !== undefined) setSyncCfg(a.sync || {});
  profiles = a.profiles;
  setState(a.profile);
  indexHistory();
  applyTheme();
  applyLanguage();
  renderProfileChip();
  renderModeSwitch();
}

/** Scan the workouts folder (scan_library in Rust; cached by mtime) and re-index it. */
async function loadLibrary() {
  setLibrary(await api.library());
  indexLibrary();
  route();
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
/** Classes of an avatar: emoji on a tint, or initials in black or white, whichever contrasts more with the fill. */
const avatarCls = (p, cls) => `avatar ${cls} ${p.avatar?.emoji ? 'emoji' : avatarInk(avatarBg(p)) === 'dark' ? 'ink-dark' : ''}`.replace(/\s+/g, ' ').trim();
/** Rider avatar: emoji on a tint, or the initials on the rider's colour (only a #rrggbb colour reaches CSS). */
const avatar = (p, cls = '') => html`<span class="${avatarCls(p, cls)}" style="--av:${avatarBg(p)}">${p.avatar?.emoji || initials(p.name)}</span>`;
/** DOM version of avatar() for live previews: user input is only ever set as text, never parsed as HTML. */
const avatarNode = (p, cls = '') => {
  const e = p.avatar?.emoji;
  const s = document.createElement('span');
  s.className = avatarCls(p, cls);
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
  // toggle buttons in a labelled group (not tabs: there is no tab panel, each click switches the whole view)
  $$('#mode-switch button').forEach((b) => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
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
  // where focus came from, for the ride's Space / Enter rule (Ride.keyTarget): an element focused by a click
  // or tap is remembered; one reached with Tab or focused by the app is not
  document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
  document.addEventListener('pointerup', () => { pointerDown = false; }, true);
  document.addEventListener('focusin', (e) => { pointerFocused = pointerDown ? e.target : null; }, true);
}
let pointerDown = false, pointerFocused = null;

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
  const btn = $('#btn-devices'), label = on ? t('devicesOn', { n: on }) : t('devicesNone');
  btn.title = label;
  btn.setAttribute('aria-label', label);   // the dots are aria-hidden, so the label carries the state
}

/** Content of the devices popover: one row per device kind (state, battery, Change / Connect), then "Retry auto-connect" when saved devices are missing. */
function renderDevicesMenu(pop) {
  const saved = state.settings.devices || {};
  const row = ([k, label, icon]) => {
    const d = devState[k];
    const level = d.connected ? lowestLevel(battery[k]) : null;
    const batt = raw(batteryBadge(level, t('batteryPct', { n: level }), pct));
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
  const close = popoverOpen(pop, anchor);
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

/** Shared behaviour of every popover (#popover): the first item gets focus, ↑/↓/Home/End move between
 *  items, Esc or Tab closes it and returns focus to the anchor, a click outside closes it, and the anchor
 *  carries aria-haspopup / aria-expanded. Keys are caught on document in the capture phase, so the
 *  ride's shortcuts (Esc = stop) never see them; Ride.onKey also ignores keys while a popover is open.
 *  Removing the popover in any other way (opening another one) also cleans up. Returns close(refocus). */
function popoverOpen(pop, anchor) {
  const items = () => [...pop.querySelectorAll('button:not([disabled]), a[href]')];
  anchor?.setAttribute('aria-haspopup', 'true');
  anchor?.setAttribute('aria-expanded', 'true');
  let closed = false;
  const close = (refocus = false) => {
    if (closed) return;
    closed = true;
    obs.disconnect();
    pop.remove();
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', key, true);
    anchor?.setAttribute('aria-expanded', 'false');
    if (refocus && anchor?.isConnected) anchor.focus();
  };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor?.contains(e.target)) close(); };
  const key = (e) => {
    if (!pop.isConnected) return close();
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return close(true); }
    const list = items();
    const i = list.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i < 0 ? -1 : i - 1, Home: 0, End: -1 }[e.key];
    if (to == null || !list.length) return;
    e.preventDefault(); e.stopPropagation();
    list[(to + list.length) % list.length].focus();
  };
  const obs = new MutationObserver(() => { if (!pop.isConnected) close(); });
  obs.observe(document.body, { childList: true });
  setTimeout(() => { if (!closed) document.addEventListener('click', outside, true); });
  document.addEventListener('keydown', key, true);
  items()[0]?.focus({ preventScroll: true });
  return close;
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
  const close = popoverOpen(pop, anchor);
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
  const close = popoverOpen(pop, anchor);
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
    ${zoneBreakdown(workout)}
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
  return html`<div class="zones-bar">${ZONES.map((z, i) => secs[i] > 0 && html`<i style="flex:${secs[i]};background:${z.color}" title="${z.short} ${z.name}: ${fmtTime(secs[i])}"></i>`)}${free > 0 && html`<i style="flex:${free};background:${FREE_COLOR}" title="${tText('freeRide')} ${fmtTime(free)}"></i>`}</div>
  <div class="zones-legend">${ZONES.map((z, i) => html`<span><i style="background:${z.color}"></i>${z.short} ${z.name} <b>${pct(Math.round((secs[i] / total) * 100))}</b></span>`)}</div>`;
}

function targetText(s, mult = 1) {
  if (s.p0 === null) return s.type === 'maxeffort' ? t('maxEffort') : t('freeRide');
  const a = Math.round(s.p0 * 100 * mult), b = Math.round(s.p1 * 100 * mult);
  const wa = Math.round(s.p0 * ftp() * mult), wb = Math.round(s.p1 * ftp() * mult);
  return a === b ? `${pct(a)} · ${wa} W` : `${pct(`${a}–${b}`)} · ${wa}–${wb} W`;
}

/** One segment in words (name, type, duration, target, cadence, zone): chart tooltip and preview line. */
function segmentText(s) {
  const kind = tHtml({ steady: 'segSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'segOn', off: 'segOff', freeride: 'freeRide', maxeffort: 'maxEffort' }[s.type] || 'segment');
  const z = s.p0 !== null ? zoneOf((s.p0 + s.p1) / 2, bounds()) : null;
  return html`<b>${s.label}${s.reps > 0 && ` (${s.rep}/${s.reps})`}</b> ${kind} · ${fmtTime(s.duration)} · ${targetText(s)}${s.cadence > 0 && ` · ${s.cadence} rpm`}${z && html` · <span style="color:var(--z${z.id}-ink)">${z.short} ${z.name}</span>`}`;
}

// ------------------------------------------------------------------ workouts folder & device dialogs
/** Ask Rust for a folder (native dialog); resolves the path or null. */
async function pickDir() {
  const dir = await invoke('pick_zwo_dir').catch((e) => toast(String(e)));
  if (!dir) return;
  setState((await api.appState()).profile);
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
    } catch (e) { mount(list, html`<p class="danger-text">${String(e)}</p>`); }
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
    } catch (err) { mount(b, html`<span class="danger-text">${tHtml('failedE', { e: String(err) })}</span>`); }
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
      mount(list, html`<p class="danger-text">${String(e)}</p><p class="muted small">${raw(PLAT.bt)}</p>`);
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
      mount(list, html`<p class="danger-text">${tHtml('connectionFailed', { e: String(err) })}</p>`);
    }
  };
  bindActions(modal, { ...common, rescan: search });
  search();
}

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

boot().catch((e) => {
  mount($('#view'), html`<div class="card"><h2>${tHtml('couldNotLoad')}</h2><p>${e.message || String(e)}</p></div>`);
});

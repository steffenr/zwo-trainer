// zwoTrainer UI controller (entry module). Sections, top to bottom:
//   riders, api and library helpers · boot · theme, riders, top bar · devices menu · routing and views
//   (renderHome / renderPlan / renderWorkouts / renderTests / renderHistory) · actions (bindActions,
//   ⋯ menus) · dialogs (preview, workouts folder, devices) · other platforms and uploads.
// Elsewhere: shared state, DOM helpers, dialogs and toasts in ./core.js; the ride screen and summary in
// ./ride/ride.js; Settings in ./views/settings.js; profile sync in ./sync.js; in-app updates in ./updates.js.
// Markup: html`` from ./html.js (auto-escaping) and the helpers in ./components/ for shared pieces;
// markup reaches the DOM only through mount() (scripts/check-html.mjs). Rust is reached only through
// invoke() / listen() (ble.js).
import { motionOK } from './render.js';
import { bindNative, invoke } from './ble.js';
import { batteryBadge, lowestLevel } from './battery.js';
import { t, pct, setLocale, systemLocale, coerceLocale, translateDom } from './i18n/index.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import { dialogHead } from './components/dialog.js';
import { avatarInk } from './components/avatar.js';
import {
  PLAT, $, $$, params, library, setLibrary, state, setState, profiles, setProfiles, indexHistory, live, trainer,
  hrm, ctrls, mode, allWorkouts, indexLibrary, ride, setJustDone, setPointerFocused, restartAnim, modal,
  openModal, closeModal, confirmDialog, toast,
} from './core.js';
import { bindActions, popoverOpen } from './actions.js';
import { renderHome, renderEmpty } from './views/home.js';
import { renderPlan } from './views/plan.js';
import { renderWorkouts } from './views/library.js';
import { renderTests } from './views/tests.js';
import { renderHistory } from './views/history.js';
import {
  refreshServices,
} from './connections.js';
import { openSettings } from './views/settings.js';
import { setSyncCfg, syncOn, scheduleSync, runSync } from './sync.js';
import { initUpdates } from './updates.js';

// Used by ride/ride.js, views/settings.js and sync.js (which import from this module in turn; see the note there).
export {
  api, route, applyTheme, applyLanguage, renderProfileChip, THEME_LABEL, devicesMenu, pickDir, loadLibrary,
  applyAppState, setMode, refreshView,
};

// ------------------------------------------------------------------ state
const api = {
  appState: () => invoke('app_state'),
  library: () => invoke('scan_library'),
  workout: (file) => invoke('load_workout', { file }),
  saveState: () => { indexHistory(); return invoke('save_profile', { profile: state }).then((r) => { scheduleSync(); return r; }).catch((e) => toast(t('couldNotSave', { e }))); },
};

let lastView = null;         // micro animations: last rendered view (fade in on change)
const pbarMemo = new Map();  // plan id -> last progress-bar widths (glide on change)




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
  setProfiles(a.profiles);
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
  document.addEventListener('focusin', (e) => { setPointerFocused(pointerDown ? e.target : null); }, true);
}
let pointerDown = false;

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
  setJustDone(null);
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












/** Re-render the current view keeping scroll position. */
function refreshView() {
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
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


boot().catch((e) => {
  mount($('#view'), html`<div class="card"><h2>${tHtml('couldNotLoad')}</h2><p>${e.message || String(e)}</p></div>`);
});

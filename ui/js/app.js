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
import { t, setLocale, systemLocale, coerceLocale, translateDom } from './i18n/index.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import { dialogHead } from './components/dialog.js';
import { avatarInk } from './components/avatar.js';
import {
  PLAT, $, $$, params, library, setLibrary, state, setState, profiles, setProfiles, indexHistory, trainer, hrm,
  ctrls, mode, allWorkouts, indexLibrary, ride, setJustDone, setPointerFocused, restartAnim, modal, openModal,
  closeModal, confirmDialog, toast,
} from './core.js';
import { bindActions } from './actions.js';
import { renderHome, renderEmpty } from './views/home.js';
import { renderPlan } from './views/plan.js';
import { renderWorkouts } from './views/library.js';
import { renderTests } from './views/tests.js';
import { renderHistory } from './views/history.js';
import { autoConnect, onButton, onSensor, setBattery, setDev, devicesTitle, devicesMenu } from './devices.js';
import {
  refreshServices,
} from './connections.js';
import { openSettings } from './views/settings.js';
import { setSyncCfg, syncOn, scheduleSync, runSync } from './sync.js';
import { initUpdates } from './updates.js';

// Used by ride/ride.js, views/settings.js and sync.js (which import from this module in turn; see the note there).
export {
  api, route, applyTheme, applyLanguage, renderProfileChip, THEME_LABEL, pickDir, loadLibrary, applyAppState,
  setMode, refreshView,
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



boot().catch((e) => {
  mount($('#view'), html`<div class="card"><h2>${tHtml('couldNotLoad')}</h2><p>${e.message || String(e)}</p></div>`);
});

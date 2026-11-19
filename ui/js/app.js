// zwoTrainer UI entry module, only wiring: boot, the app state from Rust (api, applyAppState, loadLibrary,
// pickDir), theme and language, the top bar (mode switch; its buttons and the device events are wired to
// their modules) and routing (route() renders the view for the hash and mode). The parts live in:
//   core.js              shared state (with setters), DOM helpers, dialogs and toasts
//   views/               one module per screen: home, plan, library (Workouts mode and the workout preview),
//                        tests, history, settings; parts.js holds the pieces several views share
//   actions.js           VIEW_ACTIONS and bindActions, popovers and ⋯ menus, favourites, plan progress, trash
//   riders.js            avatars, rider chip, "Who's riding?", the Riders dialog
//   devices.js           auto-connect, devices popover, device and controller dialogs, device events
//   connections.js       other platforms (Intervals.icu, COROS), FIT export and Garmin uploads
//   ride/                the ride screen, its coach line and the ride summary
//   sync.js, updates.js  profile sync, in-app updates
// Markup: html`` from ./html.js (auto-escaping) and the helpers in ./components/ for shared pieces;
// markup reaches the DOM only through mount() (scripts/check-html.mjs). Rust is reached only through
// invoke() / listen() (ble.js).
//
// Import cycles: most of those modules import api, route() and other wiring from here while this module
// imports them. That is safe because no module calls into another while it is evaluated; boot() runs last,
// when every module has been evaluated.
import { motionOK } from './render.js';
import { bindNative, invoke } from './ble.js';
import { t, setLocale, systemLocale, coerceLocale, translateDom } from './i18n/index.js';
import { html, tHtml, mount } from './html.js';
import {
  $, $$, params, library, setLibrary, state, setState, profiles, setProfiles, indexHistory, trainer, hrm, ctrls,
  mode, allWorkouts, indexLibrary, ride, setJustDone, setPointerFocused, restartAnim, toast,
} from './core.js';
import { renderHome, renderEmpty } from './views/home.js';
import { renderPlan } from './views/plan.js';
import { renderWorkouts } from './views/library.js';
import { renderTests } from './views/tests.js';
import { renderHistory } from './views/history.js';
import { renderProfileChip, whoIsRiding, profileMenu } from './riders.js';
import { autoConnect, onButton, onSensor, setBattery, setDev, devicesTitle, devicesMenu } from './devices.js';
import { refreshServices } from './connections.js';
import { openSettings } from './views/settings.js';
import { setSyncCfg, syncOn, scheduleSync, runSync } from './sync.js';
import { initUpdates } from './updates.js';

// Imported back by actions, riders, devices, connections, views/library, views/tests, views/settings,
// ride/ride, ride/summary and sync (see the note on import cycles above).
export {
  api, route, applyTheme, applyLanguage, THEME_LABEL, pickDir, loadLibrary, applyAppState, setMode, refreshView,
};

// ------------------------------------------------------------------ app state from Rust
const api = {
  appState: () => invoke('app_state'),
  library: () => invoke('scan_library'),
  workout: (file) => invoke('load_workout', { file }),
  saveState: () => { indexHistory(); return invoke('save_profile', { profile: state }).then((r) => { scheduleSync(); return r; }).catch((e) => toast(t('couldNotSave', { e }))); },
};

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

/** Ask Rust for a folder (native dialog); resolves the path or null. */
async function pickDir() {
  const dir = await invoke('pick_zwo_dir').catch((e) => toast(String(e)));
  if (!dir) return;
  setState((await api.appState()).profile);
  await loadLibrary();
  toast(t('plansIn', { n: library.plans.length, dir: dir.split(/[\\/]/).pop() }));
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

// ------------------------------------------------------------------ top bar: mode switch, buttons, device events
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

// ------------------------------------------------------------------ routing / views
let lastView = null;         // micro animations: last rendered view (fade in on change)
const pbarMemo = new Map();  // plan id -> last progress-bar widths (glide on change)

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

boot().catch((e) => {
  mount($('#view'), html`<div class="card"><h2>${tHtml('couldNotLoad')}</h2><p>${e.message || String(e)}</p></div>`);
});

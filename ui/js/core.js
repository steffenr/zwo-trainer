// Shared by the UI modules (app.js, ride.js, settings.js, sync.js, updates.js): platform wording, DOM
// helpers, the active rider and library, devices and live sensor values, the current ride, and dialogs
// and toasts. Imports only leaf modules, never one of the modules above, so it has no import cycles.
// Reassigned bindings (state, library, ride) are live exports: read them from any module, change
// them only through setState() / setLibrary() / setRide().
import { Trainer, HeartRate, Controllers } from './ble.js';
import { DEFAULT_SHIFTING } from './vshift.js';
import { motionOK } from './render.js';
import { t, fmtLocale } from './i18n/index.js';
import { html, tHtml, mount } from './html.js';

export {
  OS, PLAT, $, $$, setText, setAttr, setHtml, params, SPEED,
  library, setLibrary, state, setState, live, fresh, trainer, hrm, ctrls,
  shifting, bounds, ftp, maxHr, weight, wkg, mode, planById, allWorkouts, workoutInfo, folderOf, indexLibrary,
  relDate, planProgress, ride, setRide, restartAnim,
  modal, onDialogEnd, openModal, closeModal, confirmDialog, promptDialog, choiceDialog, announce, toast, rovingKey,
};

// Platform wording: zwoTrainer runs on macOS, Windows and Linux; only labels differ.
const OS = (() => {
  const p = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  return p.includes('mac') ? 'mac' : p.includes('win') ? 'win' : 'linux';
})();
document.documentElement.dataset.os = OS;
// Each wording is looked up in the dictionary when it's used, so it follows the UI language.
const PLAT = Object.defineProperties({ emojiKey: { mac: ' (⌃⌘Space)', win: ' (Win + .)', linux: '' }[OS] },
  Object.fromEntries(['files', 'trash', 'machine', 'onThisMachine', 'bt'].map((k) => [k, { get: () => t(`${OS}.${k}`) }])));

// ------------------------------------------------------------------ DOM helpers
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
/** Same for an attribute: written only when the value changed (aria-label, aria-pressed, title in render()). */
const setAttr = (el, name, v) => {
  if (!el) return;
  const s = String(v ?? '');
  if (el.getAttribute(name) !== s) el.setAttribute(name, s);
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

// ------------------------------------------------------------------ state
let library = { plans: [], singles: [], root: '' };
let state = null;         // the active profile: { id, name, settings, activePlan, plans, history }
const live = { power: null, cadence: null, speed: null, hr: null, at: {} };
const setLibrary = (l) => { library = l; };
const setState = (p) => { state = p; };

const trainer = new Trainer();
const hrm = new HeartRate();
const ctrls = new Controllers();
const shifting = () => ({ ...DEFAULT_SHIFTING, ...(state.settings.shifting || {}) });

const bounds = () => state.settings.zones;
const ftp = () => Number(state.settings.ftp) || 250;
const maxHr = () => Number(state.settings.maxHr) || 185;
const weight = () => Number(state.settings.weight) || null;
const wkg = (w) => (weight() && w ? (w / weight()).toFixed(2) : null);
const mode = () => (['workouts', 'tests'].includes(state.settings.mode) ? state.settings.mode : 'plans');
const planById = (id) => library.plans.find((p) => p.id === id);
const allWorkouts = () => [...library.singles, ...library.plans.flatMap((p) => p.workouts)];

let workoutIndex = new Map();
const workoutInfo = (file) => workoutIndex.get(file);
const folderOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');

/** Rebuild the lookup maps over the scanned library (workout by file, plan by id) after a scan. */
function indexLibrary() {
  workoutIndex = new Map(allWorkouts().map((w) => [w.file, w]));
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

// treat values older than 4 s as missing
const fresh = (k) => (Date.now() - (live.at[k] || 0) < 4000 ? live[k] : null);

// The ride on screen (a Ride from ride.js), or null.
let ride = null;
const setRide = (r) => { ride = r; };

/** Restart a CSS animation class (removes the given classes first). */
function restartAnim(el, cls, all = [cls]) {
  if (!el) return;
  el.classList.remove(...all);
  void el.offsetWidth;
  el.classList.add(cls);
}

// ------------------------------------------------------------------ modals
const modal = $('#modal');
let modalCloseTimer = null;
// The shown dialog's lifetime: aborted when #modal closes or the next openModal replaces the content.
let modalEnd = new AbortController();
/** Run fn once when the dialog just opened ends (closed or replaced). Call it right after openModal. */
const onDialogEnd = (fn) => modalEnd.signal.addEventListener('abort', fn, { once: true });
/** Show #modal with an html`` fragment and size classes (small, wide, settings …). One dialog at a time; a plain string would show as text. */
function openModal(markup, cls = '') {
  if (modalCloseTimer) { clearTimeout(modalCloseTimer); modalCloseTimer = null; } // reopened while fading out: keep it open
  modal.className = cls;
  modal.onclick = null;   // the previous dialog's action delegation must not handle this one's buttons
  modalEnd.abort();       // the previous dialog ends here, even if #modal never closed in between
  modalEnd = new AbortController();
  mount($('.modal-body', modal), markup);
  // name the dialog after its heading (dialogHead() or a plain <h2>); no heading, no reference
  const head = $('.modal-body h2', modal);
  if (head) { head.id ||= 'modal-title'; modal.setAttribute('aria-labelledby', head.id); } else modal.removeAttribute('aria-labelledby');
  if (!modal.open) modal.showModal();
  return modal;
}
/** Close #modal with its animation; the dialog's onDialogEnd handlers run when it has closed. */
function closeModal() {
  if (!modal.open || modalCloseTimer) return;
  if (!motionOK()) return modal.close();
  modal.classList.add('closing');
  modalCloseTimer = setTimeout(() => { modalCloseTimer = null; modal.classList.remove('closing'); modal.close(); }, 120);
}
modal.addEventListener('click', (e) => { if (e.target === modal && !modal.classList.contains('sticky')) closeModal(); });
modal.addEventListener('cancel', (e) => { if (modal.classList.contains('sticky')) e.preventDefault(); });
modal.addEventListener('close', () => modalEnd.abort());

/** Yes/no dialog; resolves true when confirmed. Texts are plain text (escaped here). */
function confirmDialog(title, text, ok = t('ok'), danger = false) {
  return new Promise((resolve) => {
    openModal(html`<h2>${title}</h2><p>${text}</p><div class="modal-actions"><button class="btn ghost" data-r="0">${tHtml('cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${ok}</button></div>`, 'small');
    onDialogEnd(() => resolve(false));   // Esc, backdrop or replaced by another dialog
    $$('[data-r]', modal).forEach((b) => (b.onclick = () => { resolve(b.dataset.r === '1'); closeModal(); }));
  });
}

/** Dialog with one text field (rename); resolves the entered value, or nothing on cancel. */
function promptDialog(title, value = '') {
  return new Promise((resolve) => {
    openModal(html`<h2>${title}</h2><form id="pf"><input type="text" name="v" value="${value}" maxlength="40" class="full" autocomplete="off"><div class="modal-actions"><button class="btn ghost" type="button" data-r="0">${tHtml('cancel')}</button><button class="btn primary" type="submit">${tHtml('save')}</button></div></form>`, 'small');
    const f = $('#pf', modal);
    f.v.select();
    onDialogEnd(() => resolve(null));
    f.onsubmit = (e) => { e.preventDefault(); resolve(f.v.value.trim() || null); closeModal(); };
    $('[data-r]', modal).onclick = () => { resolve(null); closeModal(); };
  });
}

/**
 * Read a short message out to screen readers. The polite live regions exist in index.html from the start
 * (a region created together with its text is often not announced): #live for the page, #modal-live
 * inside the dialog, because an open modal dialog makes everything outside it inert. The region is
 * emptied first so the same message twice is announced twice; play/skip symbols are left out.
 */
let liveTimer;
function announce(msg) {
  const el = modal.open ? $('#modal-live') : $('#live');
  const text = String(msg).replace(/[⏩-⏯⏸-⏺▶]️?/gu, '').trim();
  el.textContent = '';
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { el.textContent = text; }, 60);
}

let toastTimer;
/** Short plain-text notice at the bottom (3.2 s), also announced to screen readers. */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  announce(msg);
  if (el.hidden || el.classList.contains('out')) { el.classList.remove('out'); el.hidden = false; if (motionOK()) restartAnim(el, 'in'); }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (!motionOK()) { el.hidden = true; return; }
    el.classList.add('out');
    toastTimer = setTimeout(() => { el.hidden = true; el.classList.remove('in', 'out'); }, 180);
  }, 3200);
}

function choiceDialog(title, text, options) {
  return new Promise((resolve) => {
    openModal(html`<h2>${title}</h2><p>${text}</p><div class="modal-actions">${options.map(([v, l, c]) => html`<button class="btn ${c}" data-v="${v}">${l}</button>`)}</div>`, 'small');
    onDialogEnd(() => resolve(null));
    $$('[data-v]', modal).forEach((b) => (b.onclick = () => { resolve(b.dataset.v); closeModal(); }));
  });
}

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

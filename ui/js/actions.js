// Actions: VIEW_ACTIONS (the data-act handlers shared by every view, row, ⋯ menu and dialog) and
// bindActions(), the popovers (popoverOpen, openMenu, moreMenu) and what actions do to the rider's data:
// favourites, starting / leaving plans, done / skipped entries (markEntry, unskip), moving workouts and
// folders to the trash.
//
// Import cycles with app.js (api, route, setMode …) and with the views (they bind their actions here, and
// actions open the preview or redraw the history). Safe because nothing from those modules is used while
// this module is evaluated: VIEW_ACTIONS only holds functions that run on a click.
import { invoke } from './ble.js';
import { t } from './i18n/index.js';
import { html, tHtml, mount } from './html.js';
import {
  PLAT, $, state, mode, planById, workoutInfo, folderOf, planProgress, closeModal, confirmDialog, toast,
  setJustDone,
} from './core.js';
import { api, route, pickDir, loadLibrary, setMode, refreshView } from './app.js';
import { favs, isFav } from './views/parts.js';
import { wf, openPreview } from './views/library.js';
import { renderHistory } from './views/history.js';
import { uploadToService, manualImport, exportFit, garminImport, uploadToGarmin } from './connections.js';
import { startRide } from './ride/ride.js';

export { openExternal, bindActions, popoverOpen, openMenu, moreMenu, markEntry, toggleFav };

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
  if (entry.status === 'done') setJustDone(file);
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

async function toggleFav(file) {
  const f = favs();
  const i = f.indexOf(file);
  if (i >= 0) f.splice(i, 1); else f.push(file);
  await api.saveState();
  toast(i >= 0 ? t('favRemoved') : t('favAdded'));
}

// Workouts mode and the workout preview: the folder sidebar (all, favourites, recently ridden, single
// workouts, plans, collections), search, length / intensity filters and sort over a paged list of workout
// rows (filter state in `wf`, kept while the app runs), and openPreview(): the details dialog with chart,
// zones, description and Ride / Start / Skip / Open plan.
//
// Import cycles with app.js (api, setMode, refreshView; app.js routes here) and with actions.js (bindActions,
// moreMenu, markEntry, toggleFav here; its preview action and ⋯ menu use openPreview and `wf`), and through
// ride/ride.js (startRide). Safe because nothing from those modules is used while this module is evaluated,
// only inside functions that run after boot.
import { powerAt, estimateTss } from '../zwo.js';
import { ZONES, FREE_COLOR, zoneOf, fmtTime, fmtDur, Diagram, motionOK } from '../render.js';
import { t, pct } from '../i18n/index.js';
import { html, tHtml, tText, mount } from '../html.js';
import { badge } from '../components/indicators.js';
import { closeBtn } from '../components/dialog.js';
import { segCtl, selectSeg, menuBtn } from '../components/buttons.js';
import {
  PLAT, $, $$, library, state, bounds, ftp, mode, planById, allWorkouts, workoutInfo, folderOf, planProgress,
  restartAnim, modal, openModal, closeModal, confirmDialog, rovingKey, lastRidden, lastRiddenText,
} from '../core.js';
import { api, setMode, refreshView } from '../app.js';
import { bindActions, moreMenu, markEntry, toggleFav } from '../actions.js';
import { isPlan, showWeekDay, descriptionBlock, favs, starBtn, workoutRow, segmentText } from './parts.js';
import { startRide } from '../ride/ride.js';

export { wf, renderWorkouts, openPreview };

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

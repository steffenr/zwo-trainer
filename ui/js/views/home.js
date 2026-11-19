// Home in Plans mode: the active plan with its next workout (Start / Details / Skip) or a prompt to pick
// one, then all plans as cards with a filter; renderEmpty() is the first-run view without workouts.
//
// Import cycle through actions.js (bindActions) and app.js, which routes here. Safe because nothing from those
// modules is used while this module is evaluated, only inside functions that run after boot.
import { fmtDur, miniProfile } from '../render.js';
import { markdownSummary } from '../markdown.js';
import { html, raw, tHtml, tText, mount } from '../html.js';
import { badge } from '../components/indicators.js';
import { $, library, state, bounds, planById, planProgress, lastRidden, lastRiddenText } from '../core.js';
import { bindActions } from '../actions.js';
import { isPlan, planMeta, progressBar, weekDay } from './parts.js';

export { renderHome, renderEmpty };

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

/** First-run view: no workouts folder chosen yet. */
function renderEmpty() {
  const missing = library.exists === false;
  const dir = html`<code>${library.root}</code>`;
  mount($('#view'), html`<section class="hero card empty"><h1>${tHtml(missing ? 'emptyChoose' : 'emptyNone')}</h1>
    <p>${tHtml(missing ? 'emptyMissing' : 'emptyNoFiles', { dir })} ${tHtml('emptyHint')}</p>
    <div class="upnext-actions" style="margin-top:16px"><button class="btn primary" data-act="pick-dir">${tHtml('chooseFolder')}</button></div></section>`);
  bindActions($('#view'));
}

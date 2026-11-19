// Plan page (#/plan/<folder>): header with progress, Start / Resume / Leave plan and the ⋯ menu (reset,
// show in the file manager, show as collection, move to the trash), the plan's description, then its
// workouts grouped by week (or one list for a plan without week numbers).
//
// Import cycle with app.js (bindActions; app.js routes here). Safe because nothing from app.js is used while
// this module is evaluated, only inside functions that run after boot.
import { t } from '../i18n/index.js';
import { html, raw, tHtml, tText, mount } from '../html.js';
import { menuBtn } from '../components/buttons.js';
import { PLAT, $, state, planById, planProgress } from '../core.js';
import { bindActions } from '../app.js';
import { planWeeks, planMeta, descriptionBlock, progressBar, workoutRow } from './parts.js';

export { renderPlan };

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

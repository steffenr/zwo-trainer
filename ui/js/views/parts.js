// Pieces shared by the views (Home, plan page, Workouts, FTP Tests, the workout preview): plan or collection
// (isPlan, planMeta, showWeekDay), the plan description block, favourites (favs, isFav, starBtn), the plan
// progress bar, the "W3 D2" tag, one workout row (workoutRow) and one segment in words (segmentText, also
// the ride chart's tooltip). Imports only core.js and leaf modules, so it is not part of an import cycle.
import { zoneOf, fmtTime, fmtDur, miniProfile } from '../render.js';
import { renderMarkdown, markdownPlain, smartTrim } from '../markdown.js';
import { t, pct } from '../i18n/index.js';
import { html, raw, tHtml, tText } from '../html.js';
import { wdTag, zoneTag } from '../components/indicators.js';
import { state, bounds, ftp, planById, folderOf, lastRidden, lastRiddenText, justDone } from '../core.js';

export {
  isPlan, planWeeks, planMeta, showWeekDay, descriptionBlock, favs, isFav, starBtn, progressBar, weekDay,
  workoutRow, segmentText,
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

const favs = () => (state.favorites ||= []);
const isFav = (file) => favs().includes(file);

/** Favourite toggle (☆ / ★) for a workout file. */
const starBtn = (file) => html`<button class="star ${isFav(file) ? 'on' : ''}" data-act="fav" data-file="${file}" title="${tText(isFav(file) ? 'favRemove' : 'favAdd')}" aria-label="${tText('favorite')}">${isFav(file) ? '★' : '☆'}</button>`;

/** Plan progress bar (done / skipped); remembers the last widths per plan so the bar can glide to new values. */
function progressBar(pp, id) {
  const d = (pp.done / pp.total) * 100, s = (pp.skipped / pp.total) * 100;
  return html`<div class="pbar"${id && html` data-pid="${id}" data-d="${d}" data-s="${s}"`} title="${tText('progressTitle', { done: pp.done, skipped: pp.skipped, total: pp.total })}"><i class="d" style="width:${d}%"></i><i class="s" style="width:${s}%"></i></div>`;
}

/** "W3 D2" tag for a plan workout (nothing outside plans). */
function weekDay(w) {
  return w.week ? wdTag(tHtml('weekDayShort', { w: w.week, d: w.day })) : '';
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

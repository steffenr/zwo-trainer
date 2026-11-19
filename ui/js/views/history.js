// Ride history (#/history): one row per ride with date, workout and plan, time, power, heart rate, where it
// was uploaded (Garmin Connect, other platforms) and its FIT and ⋯ actions (handled by the h-* actions).
//
// Import cycle with actions.js (bindActions here; the Garmin action redraws this view) and through app.js,
// which routes here. Safe because nothing from those modules is used while this module is evaluated, only
// inside functions that run after boot.
import { fmtTime } from '../render.js';
import { fmtLocale } from '../i18n/index.js';
import { html, tHtml, tText, mount } from '../html.js';
import { menuBtn } from '../components/buttons.js';
import { $, state, planById } from '../core.js';
import { bindActions } from '../actions.js';
import { svcCache, svcRoute } from '../connections.js';

export { renderHistory };

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

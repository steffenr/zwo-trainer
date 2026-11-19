// FTP Tests mode: the current FTP with its trend, zones, bests and VO2max estimate, the built-in test
// protocols (tests.js), test workouts found in the library and the test history, where a result can be
// applied as the new FTP (applyFtp, also used by the ride summary).
//
// Import cycle with app.js (api, route, bindActions; app.js routes here). Safe because nothing from app.js is
// used while this module is evaluated, only inside functions that run after boot.
import { ZONES, fmtDur, miniProfile } from '../render.js';
import { PROTOCOLS, protocolById, isTestWorkout, classifyTest } from '../tests.js';
import { t, fmtLocale } from '../i18n/index.js';
import { html, raw, tHtml, tText, mount } from '../html.js';
import { badge } from '../components/indicators.js';
import { $, state, bounds, ftp, weight, wkg, allWorkouts, relDate, toast } from '../core.js';
import { api, route, bindActions } from '../app.js';
import { workoutRow } from './parts.js';
import { openSettings } from './settings.js';
import { startTest } from '../ride/ride.js';

export { renderTests, applyFtp };

// ------------------------------------------------------------------ FTP tests mode
const profileOf = (w) => w.segments.map((x) => [x.duration, x.p0, x.p1]);

function ftpSparkline(tests) {
  const pts = tests.filter((x) => x.accepted && x.ftp).slice(0, 12).reverse();
  if (pts.length < 2) return '';
  const W = 260, H = 56, vals = pts.map((x) => x.ftp);
  const lo = Math.min(...vals) * 0.97, hi = Math.max(...vals) * 1.03;
  const xy = pts.map((x, i) => [(i / (pts.length - 1)) * (W - 12) + 6, H - 6 - ((x.ftp - lo) / (hi - lo || 1)) * (H - 12)]);
  return html`<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="${tText('ftpHistory')}"><polyline points="${xy.map((p) => p.join(',')).join(' ')}"/>${xy.map(([x, y], i) => html`<circle cx="${x}" cy="${y}" r="3"><title>${new Date(pts[i].at).toLocaleDateString(fmtLocale())} · ${pts[i].ftp} W</title></circle>`)}</svg>`;
}

/** Card of a built-in test protocol: name, level, duration, profile, description, Start. */
function testCard(p, F) {
  const w = p.build(F);
  // a ramp ends when the rider fails — typically around FTP / 0.75
  const isRamp = p.id.startsWith('ramp');
  const rampTop = F / 0.75;
  const shown = isRamp ? { segments: w.segments.filter((x) => !x.ramp || x.p0 * F <= rampTop) } : w;
  const dur = isRamp ? `~${Math.round(shown.segments.reduce((a, x) => a + x.duration, 0) / 60)} min` : fmtDur(w.duration);
  return html`<article class="test-card card">
            <div class="pc-top"><h3>${p.name}</h3>${badge(p.level, 'muted')}</div>
            <div class="meta">${dur}</div>
            ${raw(miniProfile(profileOf(shown), bounds(), { width: 320, height: 44 }))}
            <p class="test-about">${p.about}</p>
            <div class="test-method">${p.method}</div>
            <button class="btn primary" data-act="start-test" data-test="${p.id}">${tHtml('startTest')}</button>
          </article>`;
}

/** One row of the test history (date, test, result, change, apply). */
function testRow(x, i) {
  const details = [...(x.details || []).filter((d) => d[1]).map((d) => `${d[0]} ${d[1]}`), x.vo2 ? `VO2max ~${x.vo2} ml/kg/min` : ''].filter(Boolean).join(' · ');
  const change = x.ftp && x.prevFtp && `${x.ftp >= x.prevFtp ? '+' : ''}${Math.round(((x.ftp - x.prevFtp) / x.prevFtp) * 100)} %`;
  return html`<div class="hrow trow">
          <div class="hdate">${new Date(x.at).toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          <div class="htitle"><b>${testName(x)}</b><small class="muted">${details}</small></div>
          <div class="hstat">${x.ftp ? html`<b>${x.ftp} W</b>` : x.incomplete ? badge(tHtml('notCompleted'), 'warn') : html`<b>–</b>`}</div>
          <div class="hstat">${change}</div>
          <div class="hact">${x.accepted ? badge(tHtml('applied'), 'ok') : x.ftp && html`<button class="btn ghost sm" data-act="apply-ftp" data-i="${i}">${tHtml('useW', { w: x.ftp })}</button>`}</div>
        </div>`;
}

/** FTP Tests mode: current FTP, zones and bests, the built-in test protocols, test workouts from the library, test history. */
function renderTests() {
  const v = $('#view');
  const F = ftp();
  const tests = state.tests || [];
  const last = tests.find((x) => x.ftp);
  const b = state.settings.bests || {};
  const libTests = allWorkouts().filter(isTestWorkout);
  const zoneChips = ZONES.map((z, i) => {
    const lo = i === 0 ? 0 : Math.round((bounds()[i - 1] / 100) * F) + 1;
    const hi = i < 4 ? Math.round((bounds()[i] / 100) * F) : null;
    return html`<span class="zchip"><i style="background:${z.color}"></i>${z.short} ${hi ? `${lo}–${hi}` : `> ${lo - 1}`} W</span>`;
  });
  const lastLine = last ? html`${tHtml('lastTest', { when: relDate(last.at), name: testName(last), ftp: last.ftp })}${!last.accepted && html` ${tHtml('notApplied')}`}`
    : html`${tHtml(tests.length ? 'noCompletedTest' : 'noTest')} — ${tHtml('pickTestBelow')}`;
  const tv = tests.find((x) => x.vo2);
  const vo2 = tv ? html`<div class="vo2"><span class="k">${tHtml('vo2Est')}</span><b>${tv.vo2}</b> ml/kg/min<small class="muted">${testName(tv)} · ${relDate(tv.at)}</small></div>`
    : !weight() && html`<button class="btn ghost sm" data-act="add-weight">${tHtml('addWeight')}</button>`;
  mount(v, html`
    <section class="hero card ftp-hero">
      <div class="ftp-now">
        <div class="eyebrow">${tHtml('currentFtp')} · ${state.name}</div>
        <div class="ftp-val"><b>${F}</b> W${wkg(F) && html` <span class="wkg">${wkg(F)} W/kg</span>`}</div>
        <div class="meta">${lastLine}</div>
      </div>
      <div class="ftp-side">
        ${ftpSparkline(tests)}
        ${vo2}
        <div class="bests">${[['5 s', b.s5], ['1 min', b.m1], ['5 min', b.m5], ['20 min', b.m20]].map(([k, val]) => html`<div><span class="k">${k}</span><b>${val ? `${val} W` : '–'}</b></div>`)}</div>
      </div>
      <div class="zone-strip">${zoneChips}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>${tHtml('tests')}</h2><span class="muted small">${tHtml('testsHint')}</span></div>
      <div class="test-grid">
        ${PROTOCOLS.map((p) => testCard(p, F))}
      </div>
    </section>
    ${libTests.length > 0 && html`<section class="section"><div class="section-head"><h2>${tHtml('libTests')} <small>${libTests.length}</small></h2><span class="muted small">${tHtml('libTestsHint')}</span></div>
      <div class="wlist">${libTests.map((w) => workoutRow(w, { free: true, showFolder: true, note: classifyTest(w.profile, w.title).label }))}</div></section>`}
    <section class="section">
      <div class="section-head"><h2>${tHtml('testHistory')}</h2></div>
      ${tests.length ? html`<div class="hlist"><div class="hrow trow hhead"><div>${tHtml('colDate')}</div><div>${tHtml('colTest')}</div><div class="hstat">${tHtml('colResult')}</div><div class="hstat">${tHtml('colChange')}</div><div></div></div>
        ${tests.map(testRow)}</div>` : html`<p class="muted">${tHtml('testResultsHere')}</p>`}
    </section>`);
  bindActions(v, {
    'start-test': (el) => startTest(el.dataset.test),
    'apply-ftp': (el) => applyFtp(state.tests[+el.dataset.i]),
    'add-weight': () => openSettings('rider'),
  });
}


async function applyFtp(entry) {
  const prev = ftp();
  state.settings.ftp = entry.ftp;
  for (const x of state.tests) x.accepted = x === entry;
  await api.saveState();
  toast(t('ftpSet', { ftp: entry.ftp, prev }));
  route();
}

/** A built-in test is named in the current language; library tests keep their file's title. */
const testName = (x) => protocolById(x.protocol)?.name || x.name;

// The end of a ride: finishRide() (called by Ride.finish) releases ERG, saves the FIT file, adds the ride to
// history and the plan, evaluates FTP tests and opens the ride summary (test result, stats, uploads to
// Garmin and other platforms, next plan workout). The functions take the Ride as their first argument.
//
// Import cycles: with app.js (upload helpers, bindActions …) and with ./ride.js (startRide for "Start next
// now", while ride.js imports finishRide from here). Both are safe because nothing from those modules is
// used while this module is evaluated: only inside functions that run after a ride has ended.
import { fmtTime, fmtDur, miniProfile, motionOK } from '../render.js';
import { invoke } from '../ble.js';
import { evaluateGeneric, vo2max } from '../tests.js';
import { t } from '../i18n/index.js';
import { endChime } from '../sound.js';
import { html, raw, tHtml, mount } from '../html.js';
import { badge } from '../components/indicators.js';
import {
  $, state, trainer, bounds, ftp, weight, wkg, planById, planProgress, modal, openModal, closeModal, toast,
} from '../core.js';
import {
  api, bindActions, markEntry, applyFtp,
} from '../app.js';
import { weekDay } from '../views/parts.js';
import {
  syncMode, svcMode, SVC_LOGO, refreshServices, svcRoute, uploadToGarmin, uploadToService, garminImport,
  manualImport, exportFit,
} from '../connections.js';
import { startRide } from './ride.js';

export { finishRide };

/** Plausibility note for a test result that differs a lot (> 15 %) from the current FTP. */
function ftpCheck(next, cur, source) {
  if (!next || !cur) return html``;
  const d = (next - cur) / cur;
  if (Math.abs(d) <= 0.15) return html``;
  const pct = `${Math.round(Math.abs(d) * 100)} %`;
  const src = source ? tHtml('ftpSrcFrom', { name: html`<b>${source}</b>` }) : tHtml('ftpSrcRight');
  return html`<p class="ftp-check">${tHtml(d > 0 ? 'ftpHigh' : 'ftpLow', { pct, src })}</p>`;
}

/** Count a number up (or down) to its final value once, ~0.8 s ease-out; the end text is exact. */
function countUp(el, from, to, fmt, delay = 0) {
  if (from === to) return;
  el.textContent = fmt(from);
  setTimeout(() => {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 800), e = 1 - (1 - k) ** 3;
      el.textContent = fmt(k < 1 ? Math.round(from + (to - from) * e) : to);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, delay);
}

// ------------------------------------------------------------------ summary pieces (showSummary)

/** Test detail rows (label, value) as a definition list body. */
const detailRows = (details) => details.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`);

/**
 * FTP test block: the new FTP with apply / keep, or why there is none (effort not completed, only power
 * bests, not enough data). Only for test rides.
 */
function summaryTest(r) {
  const cur = ftp();
  if (r?.ftp) {
    const vo2 = r.vo2est ? html`<dt>${tHtml('vo2Estimate')}</dt><dd>${r.vo2est.rel} ml/kg/min · ${r.vo2est.abs} L/min <small class="muted">${r.vo2est.method}</small></dd>`
      : r.vo2 && !weight() ? html`<dt>VO2max</dt><dd class="muted">${tHtml('addWeightSettings')}</dd>` : null;
    return html`
        <div class="ftp-result">
          <div><span class="k">${tHtml('yourFtpIs')}</span><b>${r.ftp} W</b><small class="${r.ftp >= cur ? 'up' : 'down'}">${tHtml('vsCurrent', { diff: `${r.ftp >= cur ? '+' : ''}${r.ftp - cur}`, cur })}</small></div>
          <dl>${detailRows(r.details)}
            ${wkg(r.ftp) && html`<dt>${tHtml('ftpPerKg')}</dt><dd>${wkg(r.ftp)} W/kg</dd>`}
            ${vo2}</dl>
          ${ftpCheck(r.ftp, cur, trainer.connected ? trainer.name : null)}
          <div class="ftp-actions"><button class="btn primary" data-act="apply">${tHtml('useAsFtp', { w: r.ftp })}</button><button class="btn ghost" data-act="keep">${tHtml('keepW', { w: cur })}</button></div>
        </div>`;
  }
  if (r?.incomplete) {
    return html`<div class="ftp-result incomplete">
          <div><span class="k">${tHtml('effortNotCompleted')}</span></div>
          <p>${r.incomplete.text} ${tHtml('incompleteStays', { w: cur })}${Object.keys(r.bests || {}).length > 0 && html` ${tHtml('bestsSaved')}`}</p>
          <dl>${detailRows(r.details)}</dl>
          <p class="muted small">${tHtml('repeatFresh')}</p>
        </div>`;
  }
  if (r?.details) {
    return html`<div class="ftp-result"><div><span class="k">${tHtml('powerBestsSaved')}</span></div><dl>${detailRows(r.details)}${r.vo2est && html`<dt>${tHtml('vo2Estimate')}</dt><dd>${r.vo2est.rel} ml/kg/min</dd>`}</dl></div>`;
  }
  return html`<p class="danger-text">${tHtml('notEnoughData')} — ${tHtml('powerSourceQ')}.</p>`;
}

/** The six ride numbers (time, average power, NP, HR, cadence, energy); '–' when not recorded. */
function summaryStats(st, ridden) {
  const cell = (k, v) => html`<div><span class="k">${k}</span><b>${v ?? '–'}</b></div>`;
  return html`<div class="stats">
          ${cell(tHtml('stTime'), fmtTime(ridden))}${cell(tHtml('stAvgPower'), st.avgPower && `${st.avgPower} W`)}${cell('NP', st.np && `${st.np} W`)}
          ${cell(tHtml('stAvgHr'), st.avgHr && `${st.avgHr} bpm`)}${cell(tHtml('stCadence'), st.avgCadence && `${st.avgCadence} rpm`)}${cell(tHtml('stEnergy'), st.kj && `${st.kj} kJ`)}
        </div>`;
}

/** Rides shorter than this (seconds) are not uploaded automatically; the summary asks first (#37). */
const SHORT_RIDE_S = 15 * 60;

/**
 * Short ride with automatic uploads pending: "Short ride (8:42). Upload to Garmin Connect?" with
 * Upload / Don't upload. Until answered, the destinations show their manual buttons.
 */
const summaryShortRide = (seconds, names) => html`<div class="short-ride" role="group" aria-labelledby="short-ride-q">
          <p id="short-ride-q">${tHtml('shortRideQ', { time: fmtTime(seconds), names: names.join(', ') })}</p>
          <button class="btn ghost sm" data-act="short-skip">${tHtml('dontUpload')}</button><button class="btn primary sm" data-act="short-up">${tHtml('upload')}</button>
        </div>`;

/**
 * Where the ride goes: Garmin (automatic, upload, or manual import), other platforms, the FIT file.
 * `hold`: automatic uploads wait for the short-ride question, so their rows show the manual buttons.
 */
function summarySyncList({ garmin, autoGarmin, rideSvcs, hold = false }) {
  const garminState = autoGarmin && !hold ? html`<span class="spinner"></span> ${tHtml('uploading')}`
    : garmin.connected && syncMode('garmin') !== 'off' ? html`<button class="btn ghost sm" data-act="garmin-up">${tHtml('upload')}</button>`
      : html`<button class="btn ghost sm" data-act="garmin">${tHtml('importDots')}</button>`;
  const svcRow = (sv) => {
    const auto = sv.connected && svcMode(sv) === 'auto' && !hold;
    const act = auto ? html`<span class="spinner"></span> ${tHtml('uploading')}`
      : sv.connected ? html`<button class="btn ghost sm" data-act="svc-up" data-id="${sv.id}">${tHtml('upload')}</button>`
        : html`<button class="btn ghost sm" data-act="svc-man" data-id="${sv.id}">${tHtml('importDots')}</button>`;
    return html`<div class="sl-row"><span class="svc-logo ext sm">${SVC_LOGO[sv.id]}</span><span class="sl-name">${sv.name}</span><span class="sl-state" id="svc-${sv.id}">${act}</span></div>`;
  };
  return html`<div class="sync-list">
          <div class="sl-row"><span class="svc-logo garmin sm">G</span><span class="sl-name">Garmin Connect</span><span class="sl-state" id="garmin-state">${garminState}</span></div>
          ${rideSvcs.map(svcRow)}
          <div class="sl-row sl-file"><span class="sl-name muted">${tHtml('rideFile')}</span><span class="sl-state"><button class="btn ghost sm" data-act="fit">${tHtml('saveFit')}</button></span></div>
        </div>`;
}

/** Plan rides: the next workout of the plan, or "that was the last one". */
function summaryNext(plan, next) {
  if (!next) return html`<p class="done-msg">${tHtml('lastWorkoutDone')}</p>`;
  return html`<div class="next-card"><div class="eyebrow">${tHtml('upNextIn', { name: plan.name })} ${weekDay(next)}</div><h3>${next.title}</h3><div class="meta">${fmtDur(next.duration)} · TSS ~${next.tss}</div>${raw(miniProfile(next.profile, bounds(), { width: 420, height: 48 }))}</div>`;
}

// ------------------------------------------------------------------ end of the ride

/** Summary numbers of the recorded samples: duration, average / normalized power, HR, cadence, kJ, distance. */
function stats(ride) {
  const ps = ride.samples.filter((s) => s.p != null);
  const avg = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null && x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  let np = null;
  if (ps.length >= 30) {
    const roll = [];
    for (let i = 29; i < ps.length; i++) { let s = 0; for (let j = i - 29; j <= i; j++) s += ps[j].p; roll.push(Math.pow(s / 30, 4)); }
    np = Math.round(Math.pow(roll.reduce((a, b) => a + b, 0) / roll.length, 0.25));
  }
  const kj = Math.round(ps.reduce((a, s) => a + s.p, 0) / 1000);
  const IF = np ? np / ftp() : null;
  const tss = IF ? Math.round(((ride.ridden * np * IF) / (ftp() * 3600)) * 100) : null;
  return { avgPower: avg(ride.samples, 'p'), np, avgHr: avg(ride.samples, 'hr'), maxHr: Math.max(0, ...ride.samples.map((s) => s.hr || 0)) || null, avgCadence: avg(ride.samples, 'c'), kj: kj || null, tss };
}

/** End of the ride: save the FIT file, add to history and plan, evaluate FTP tests, show the summary, upload to Garmin and services. */
async function finishRide(ride, completed) {
  // Runs once: a controller ▶ on the last segment or a key during the save would otherwise
  // save a second FIT file and history entry. Every ride input checks `ending`.
  if (ride.ending) return;
  ride.ending = true;
  $('#btn-compact').hidden = true;
  clearInterval(ride.loop);
  ride.running = false;
  trainer.setFreeRide(); // don't leave the trainer holding the last ERG target while the summary is open
  // Saving/results must still proceed if the OS rejects a window resize.
  await ride.compact.set(false);
  // ridden to the end: the ring closes and turns into a check, then the summary rises
  const ridToEnd = completed && ride.t >= ride.w.duration - 1;
  const endAnim = ridToEnd && motionOK();
  if (ridToEnd && !ride.test && state.settings.endChime !== false) endChime();
  const animStart = performance.now();
  if (endAnim) {
    ride.ring.update(1, 'var(--ok)');
    $('.panel.seg')?.classList.remove('closing');
    $('.seg-ring')?.classList.add('finished');
    $('#gauge')?.classList.remove('on-target');
  }
  const st = stats(ride);
  const title = ride.info?.title || ride.w.name;
  const result = { status: 'done', planDuration: ride.w.duration, doneDuration: Math.round(ride.ridden), completed, ...st };

  const fit = await saveFit(ride, title);
  const entry = { file: ride.file, plan: ride.planId, title, startedAt: ride.startedAt?.toISOString(), at: new Date().toISOString(), ...result, fitPath: fit?.path || null, distanceKm: fit?.summary?.distanceKm ?? null };
  state.history.unshift(entry); // never capped: old rides stay the rider's (and sync keeps them all)
  if (ride.planId) await markEntry(ride.planId, ride.file, result); else await api.saveState();
  const testResult = ride.test ? await recordTest(ride, title) : null;

  if (endAnim) { const wait = 650 - (performance.now() - animStart); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
  await showSummary(ride, { title, completed, st, fit, entry, testResult, endAnim });
}

/**
 * Store the ride as a FIT file (for Garmin and export). The planned workout goes in as well: Garmin
 * names the activity after it (and forwards that name to Strava); the rename after the upload comes
 * too late for Strava. Resolves Rust's { path, garminPath, summary } or null (nothing recorded / error).
 */
async function saveFit(ride, title) {
  if (!ride.samples.length) return null;
  const F = ftp(), m = ride.mult();
  const steps = ride.w.segments.map((sg) => ({
    duration: Math.max(1, Math.round(sg.duration)),
    lo: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p0 * F * m),
    hi: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p1 * F * m),
    kind: sg.type === 'warmup' ? 'warmup' : sg.type === 'cooldown' ? 'cooldown' : sg.type === 'off' ? 'rest' : null,
  }));
  return invoke('save_activity', { ride: { name: title, ftp: F, steps, samples: ride.samples.map(({ wall, p, c, hr, v, seg }) => ({ wall, p, c, hr, v, seg })) } })
    .catch((e) => { toast(t('couldNotSaveRide', { e })); return null; });
}

/** FTP test: evaluate the tagged samples, keep new power bests, and add the result to state.tests (not applied yet). */
async function recordTest(ride, title) {
  const testResult = ride.test.protocol ? ride.test.protocol.evaluate(ride.samples) : evaluateGeneric(ride.samples, ride.w);
  if (!testResult) return null;
  const v = vo2max(testResult.vo2, weight());
  if (v) testResult.vo2est = v;
  const bests = { ...(state.settings.bests || {}) };
  for (const [k, val] of Object.entries(testResult.bests || {})) if (val && (!bests[k] || val > bests[k])) bests[k] = val;
  state.settings.bests = bests;
  state.tests = [{ at: new Date().toISOString(), protocol: ride.test.protocol?.id || 'library', name: ride.test.protocol?.name || title, ftp: testResult.ftp, incomplete: !!testResult.incomplete, prevFtp: ftp(), details: testResult.details, cp: testResult.cp ?? null, wPrime: testResult.wPrime ?? null, vo2: testResult.vo2est?.rel ?? null, vo2abs: testResult.vo2est?.abs ?? null, weight: weight(), accepted: false }, ...(state.tests || [])].slice(0, 200);
  await api.saveState();
  return testResult;
}

/**
 * The ride summary dialog: test result, stats, where the ride goes (Garmin, platforms, FIT file) and
 * the next plan workout. Automatic uploads start right away and update their row when done; for a
 * ride under SHORT_RIDE_S they wait until the rider answers the short-ride question.
 */
async function showSummary(ride, { title, completed, st, fit, entry, testResult, endAnim }) {
  const [garmin, svcs] = fit ? await Promise.all([invoke('garmin_status').catch(() => ({})), refreshServices()]) : [{}, []];
  const autoGarmin = fit && garmin.connected && syncMode('garmin') === 'auto';
  const rideSvcs = svcs.filter((sv) => svcRoute(sv) && svcMode(sv) !== 'off');
  // automatic destinations: Garmin upload, platforms in auto mode, or opening Garmin's import page
  const autoSvcs = rideSvcs.filter((sv) => sv.connected && svcMode(sv) === 'auto');
  const autoImport = fit && !garmin.connected && !!state.settings.garmin?.autoOpen;
  const autoNames = [...(autoGarmin || autoImport ? ['Garmin Connect'] : []), ...autoSvcs.map((sv) => sv.name)];
  const hold = autoNames.length > 0 && (entry.doneDuration ?? 0) < SHORT_RIDE_S;
  const plan = ride.planId && planById(ride.planId);
  const next = plan && planProgress(plan).next;
  const heading = tHtml(ride.test ? 'ftpTestResult' : completed ? 'workoutComplete' : 'workoutSaved');
  openModal(html`
    <div class="summary">
      <div class="eyebrow">${heading}</div>
      <h2>${title}</h2>
      ${ride.test && summaryTest(testResult)}
      ${summaryStats(st, ride.ridden)}
      ${hold && summaryShortRide(entry.doneDuration ?? 0, autoNames)}
      ${fit && summarySyncList({ garmin, autoGarmin, rideSvcs, hold })}
      ${plan && summaryNext(plan, next)}
      <div class="modal-actions">
        <button class="btn ${next ? 'ghost' : 'primary'}" data-act="home">${tHtml('done')}</button>
        ${next && html`<button class="btn primary" data-act="next">${tHtml('startNextNow')}</button>`}
      </div>
    </div>`, endAnim ? 'small sticky rise' : 'small sticky');
  const ftpEl = ride.test && testResult?.ftp && motionOK() ? $('.ftp-result > div > b', modal) : null;
  if (ftpEl) countUp(ftpEl, ftp(), testResult.ftp, (v) => `${v} W`, endAnim ? 450 : 150);

  // upload state per destination row: spinner → link / ✓ / failure with retry
  const rowState = (id, frag) => { const el = $(`#${id}`, modal); if (el?.isConnected) mount(el, frag); return el; };
  const uploaded = (url) => (url ? html`<a href="#" class="link" data-act="open-url" data-url="${url}">${tHtml('uploaded')}</a>` : html`<span class="ok-text">${tHtml('uploaded')}</span>`);
  const doGarmin = async () => {
    rowState('garmin-state', html`<span class="spinner"></span> ${tHtml('uploadingGarmin')}`);
    try { rowState('garmin-state', uploaded((await uploadToGarmin(entry)).url)); } catch (e) {
      rowState('garmin-state', html`<span class="danger-text" title="${String(e)}">${tHtml('uploadFailed')}</span> <button class="btn ghost sm" data-act="garmin-up">${tHtml('retry')}</button> <button class="btn ghost sm" data-act="garmin">${tHtml('manual')}</button>`);
    }
  };
  const doSvc = async (id) => {
    rowState(`svc-${id}`, html`<span class="spinner"></span> ${tHtml('uploading')}`);
    try { rowState(`svc-${id}`, uploaded((await uploadToService(entry, id)).url)); } catch (err) {
      rowState(`svc-${id}`, html`<span class="danger-text" title="${String(err)}">${tHtml('failed')}</span> <button class="btn ghost sm" data-act="svc-up" data-id="${id}">${tHtml('retry')}</button>`);
    }
  };
  const leave = () => { closeModal(); ride.close(); };
  const startAutoUploads = () => {
    if (autoGarmin) doGarmin();
    for (const sv of autoSvcs) doSvc(sv.id);
    if (autoImport) garminImport(fit.path);
  };
  bindActions(modal, {
    // short-ride question: upload everywhere it would have gone automatically, or leave it manual
    'short-up': (el) => { el.closest('.short-ride').remove(); startAutoUploads(); },
    'short-skip': (el) => el.closest('.short-ride').remove(),
    apply: (el) => { applyFtp(state.tests[0]); mount(el.closest('.ftp-actions'), badge(tHtml('ftpUpdated', { w: state.tests[0].ftp }), 'ok')); },
    keep: (el) => mount(el.closest('.ftp-actions'), html`<span class="muted small">${tHtml('keptFtp')}</span>`),
    garmin: () => garminImport(fit.path),
    'garmin-up': doGarmin,
    'svc-up': (el) => doSvc(el.dataset.id),
    'svc-man': (el) => manualImport(el.dataset.id, fit.path),
    fit: () => exportFit(fit.path),
    home: leave,
    next: () => { leave(); startRide(next.file, plan.id); },
  });
  if (!hold) startAutoUploads();
}

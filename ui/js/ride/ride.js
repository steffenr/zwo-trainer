// The ride screen: startRide() / startTest() open it, the Ride class runs the loop (tick → drive → render,
// 4× a second), records 1 Hz samples, handles keys, controller buttons and the compact view, and ends
// with finish() → the ride summary (saveFit, recordTest, showSummary and the summary* pieces).
//
// Import cycle with app.js (app.js imports startRide / startTest from here, this module uses app-level
// actions such as route() and the upload helpers). It is safe because nothing from app.js is used while
// this module is evaluated: only inside functions and methods that run after boot.
import { CompactView, compactMode } from '../compact.js';
import { powerAt, segmentAt } from '../zwo.js';
import { zoneOf, zoneColor, zoneInk, fmtTime, fmtDur, miniProfile, Diagram, Gauge, ProgressRing, motionOK } from '../render.js';
import { invoke } from '../ble.js';
import { gearTable, virtualSpeed, targetWatts } from '../vshift.js';
import { protocolById, isTestWorkout, evaluateGeneric, classifyTest, prepareTestWorkout, vo2max } from '../tests.js';
import { t, pct } from '../i18n/index.js';
import { loadSounds, countdown, endChime } from '../sound.js';
import { html, raw, tHtml, tText, mount } from '../html.js';
import { IC } from '../components/icons.js';
import { badge } from '../components/indicators.js';
import { segCtl, selectSeg } from '../components/buttons.js';
import {
  OS, $, $$, setText, setAttr, setHtml, SPEED, state, live, fresh, trainer, ctrls,
  shifting, bounds, ftp, maxHr, weight, wkg, mode, planById, workoutInfo, planProgress, ride, setRide, restartAnim,
  modal, openModal, closeModal, confirmDialog, choiceDialog, announce, toast, rovingKey,
} from '../core.js';
import {
  api, route, bindActions, openMenu, pointerFocused, weekDay, segmentText, markEntry, applyFtp,
  syncMode, svcMode, svcRoute, SVC_LOGO, refreshServices, uploadToService, manualImport,
  exportFit, garminImport, uploadToGarmin,
} from '../app.js';
import { updFound, updLater, showUpdateCard } from '../updates.js';

export { startRide, startTest };

// ------------------------------------------------------------------ ride

/** Load a workout (and test preparation if it is an FTP test) and open the ride screen. */
async function startRide(file, planId) {
  const { workout } = await api.workout(file);
  if (!workout.segments.length) return toast(t('noSegments'));
  const info = workoutInfo(file);
  if (info && isTestWorkout(info)) {
    const kind = classifyTest(info.profile, info.title);
    if (kind.kind === 'broken-ramp') {
      const p = protocolById(kind.lite ? 'ramp-lite' : 'ramp');
      if (!await confirmDialog(t('builtinRampQ'), `${t('builtinRampText', { title: info.title, name: p.name })}${planId ? ` ${t('countsForPlan')}` : ''}`, t('startName', { name: p.name }))) return;
      setRide(new Ride(p.build(ftp()), file, planId, { protocol: p }));
      return;
    }
    setRide(new Ride(prepareTestWorkout(workout), file, planId, { generic: true }));
    return;
  }
  setRide(new Ride(workout, file, planId));
}

function startTest(id) {
  const p = protocolById(id);
  setRide(new Ride(p.build(ftp()), `test:${id}`, null, { protocol: p }));
}

/** Plausibility note for a test result that differs a lot (> 15 %) from the current FTP. */
function ftpCheck(next, cur, source) {
  if (!next || !cur) return html``;
  const d = (next - cur) / cur;
  if (Math.abs(d) <= 0.15) return html``;
  const pct = `${Math.round(Math.abs(d) * 100)} %`;
  const src = source ? tHtml('ftpSrcFrom', { name: html`<b>${source}</b>` }) : tHtml('ftpSrcRight');
  return html`<p class="ftp-check">${tHtml(d > 0 ? 'ftpHigh' : 'ftpLow', { pct, src })}</p>`;
}

const SEG_KIND = { steady: 'kindSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'kindOn', off: 'kindOff', freeride: 'freeRide', maxeffort: 'maxEffort' };
/** Short label for the current segment type (warm-up, interval, ramp, free ride, all-out …). */
const segKind = (s) => `${t(s.erg === false ? 'kindAllOut' : SEG_KIND[s.type] || 'segment')}${s.reps ? ` ${s.rep}/${s.reps}` : ''}`;
/** Fill a metric bar: frac 0…1, optional target marker (0…1) and colour. */
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

/** Fill a small metric bar (0–1) and optionally mark a target band. */
function setBar(el, frac, { mark = null, color = null, band = null } = {}) {
  if (!el) return;
  const f = el.querySelector('.fill');
  f.style.width = `${Math.max(0, Math.min(1, frac || 0)) * 100}%`;
  f.style.background = color || '';
  const m = el.querySelector('.mark');
  if (m) { m.hidden = mark == null; if (mark != null) m.style.left = `${Math.max(0, Math.min(1, mark)) * 100}%`; }
  const b = el.querySelector('.band');
  if (b) { b.hidden = !band; if (band) { b.style.left = `${band[0] * 100}%`; b.style.width = `${Math.max(0.01, band[1] - band[0]) * 100}%`; } }
}

const OVERLAY = [['power', 'colPower'], ['cadence', 'cadence'], ['hr', 'devHr']];

// ------------------------------------------------------------------ ride summary pieces (Ride.showSummary)

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

class Ride {
  /** A ride: owns the clock, the target power, recording, auto-pause, controller input and the ride screen.
   * Lives from startRide() until close(); while it exists nothing else may re-render or block (see AGENTS.md). */
  constructor(workout, file, planId, test = null) {
    this.test = test;
    this.lowCount = 0;
    this.w = workout;
    const sh = shifting();
    this.gears = gearTable(sh);
    this.gear = Math.min(this.gears.length - 1, Math.max(0, (sh.startGear || 16) - 1));
    this.hasFree = workout.segments.some((x) => x.p0 === null || x.erg === false);
    this.vs = { on: sh.mode === 'virtual', difficulty: sh.difficulty || 'medium', watts: null, sentAt: 0 };
    this.file = file;
    this.planId = planId;
    this.info = workoutInfo(file);
    this.t = 0;
    this.running = false;
    this.started = false;
    this.intensity = 100;
    this.samples = [];
    this.lastSec = -1;
    this.segIdx = -1;
    this.showPct = false;
    this.startedAt = null;
    this.ridden = 0;
    this.beeped = new Set();
    loadSounds(['up', 'down', 'done']);
    this.autoStartCount = 0;
    this.compact = new CompactView({
      resize: (compact) => invoke('ride_window', { compact }),
      apply: (compact) => {
        document.body.classList.toggle('compact-riding', compact);
        if (!compact) this.diagram.update(this.t, this.samples);
      },
      report: (error) => toast(String(error)),
    });
    this.build();
    this.wake();
    this.loop = setInterval(() => this.tick(), 250);
    this.last = performance.now();
    this.drive(); this.render(true);
  }

  /** Render the ride screen once (panels, chart, controls, compact view). Never called again on resize: compact mode only toggles CSS. */
  build() {
    const r = $('#ride');
    r.hidden = false;
    document.body.classList.add('riding');
    const plan = this.planId && planById(this.planId);
    const ov = state.settings.overlay || { power: true };
    // compact view: play/stop and "workout left" appear twice (heading row when short, footer otherwise)
    const cmpCtl = html`<span class="compact-ctl"><button class="ctl play" data-act="play" title="${tText('start')} (${tText('spaceKey')})" aria-label="${tText('start')}" aria-keyshortcuts="Space"><svg viewBox="0 0 24 24" class="i-play" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" class="i-pause" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button><button class="ctl" data-act="stop" title="${tText('endWorkout')}" aria-label="${tText('endWorkout')}" aria-keyshortcuts="Escape"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button></span>`;
    const cmpWl = html`<span class="cmp-wl"><small>${tHtml('compactWorkoutLeft')}</small><b class="cmp-wleft">0:00</b></span>`;
    // the ride title lives in the regular top bar (in place of the mode switch)
    const rt = $('#ride-title');
    mount(rt, html`${this.test && badge(tHtml('ftpTest'), 'test')}${plan ? badge(html`${plan.name}${this.info?.week && html` · ${tHtml('weekDayCompact', { w: this.info.week, d: this.info.day })}`}`) : !this.test && badge(tHtml('workout'), 'muted')}
      <h1 title="${this.info?.title || this.w.name}">${this.info?.title || this.w.name}</h1><span class="erg" id="erg-state"></span>`);
    rt.hidden = false;
    $('#btn-compact').hidden = false;
    mount(r, html`
      <div class="ride-top">
        <section class="panel live">
          <header class="ph"><span class="ph-dot" id="live-dot"></span><b>${tHtml('live')}</b>${IC.pulse}<span class="ph-status" id="live-status"></span></header>
          <div class="live-body">
            <button class="gauge" id="gauge" title="${tText('gaugeTitle')}" aria-label="${tText('gaugeAria')}" aria-pressed="false">
              <div class="gauge-mount"></div>
              <div class="gauge-center"><span class="k" id="g-unit">${tHtml('watt')}</span><b id="v-pow">–</b><small id="t-pow">–</small></div>
            </button>
            <div class="metrics">
              <div class="metric">${IC.bolt}<div class="m-txt"><span class="k">${tHtml('colPower')}</span><span class="m-val"><b id="m-pow">–</b><small>W</small></span><div class="mbar" id="b-pow"><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.cad}<div class="m-txt"><span class="k">${tHtml('cadence')}</span><span class="m-val"><b id="v-cad">–</b><em id="t-cad"></em><small>rpm</small></span><div class="mbar" id="b-cad"><i class="band"></i><i class="fill"></i><i class="mark"></i></div></div></div>
              <div class="metric">${IC.speed}<div class="m-txt"><span class="k">${tHtml('speed')}</span><span class="m-val"><b id="v-spd">–</b><small>km/h</small></span><div class="mbar" id="b-spd"><i class="fill"></i></div></div></div>
              <div class="metric">${IC.heart}<div class="m-txt"><span class="k">${tHtml('devHr')}</span><span class="m-val"><b id="v-hr">–</b><small>bpm</small><em id="t-hr"></em></span><div class="mbar" id="b-hr"><i class="fill"></i></div></div></div>
            </div>
          </div>
        </section>
        <section class="panel seg">
          <header class="ph">${IC.target}<b>${tHtml('currentSegment')}</b><span class="ph-status" id="seg-kind"></span></header>
          <div class="seg-body">
            <div class="seg-left">
              <div class="seg-ring">
                <div class="ring-mount"></div>
                <div class="ring-center">
                  <b id="s-target">–</b>
                  <small id="s-watts"></small>
                </div>
                <svg class="ring-check" viewBox="0 0 100 100" aria-hidden="true"><path d="M27 52 L44 68 L74 34"/></svg>
              </div>
              <div class="gearbox" id="gearbox" hidden><button class="btn round sm" data-shift="-1" title="${tText('shiftDownKey')}" aria-label="${tText('shiftDownKey')}">−</button><span id="gear-lbl" class="gear-lbl">${tHtml('gear')}</span><button class="btn round sm" data-shift="1" title="${tText('shiftUpKey')}" aria-label="${tText('shiftUpKey')}">+</button></div>
            </div>
            <div class="seg-stats">
              <div class="stat">${IC.bolt}<div><span class="k" id="s-tw-k">${tHtml('targetPower')}</span><b id="s-tw">–</b></div></div>
              <div class="stat cad">${IC.cad}<div><span class="k">${tHtml('targetCadence')}</span><b id="s-cad">–</b></div></div>
              <div class="stat">${IC.watch}<div><span class="k">${tHtml('segment')}</span><b id="s-dur">0:00</b><div class="sbar"><i id="s-bar"></i></div></div></div>
              <div class="stat rem">${IC.flag}<div><span class="k">${tHtml('remaining')}</span><b id="s-rem">0:00</b></div></div>
            </div>
          </div>
          <div class="coach-line" id="coach" role="status" aria-live="polite"></div>
        </section>
        <section class="panel next">
          <header class="ph">${IC.layers}<b>${tHtml('btnNext')}</b></header>
          <div class="nx-card" id="next-card"></div>
        </section>
      </div>
      <div class="ride-diagram panel">
        <div class="dg-times">
          <div class="wt-head"><span class="ph-mini">${IC.bars}<b>${tHtml('workout')}</b></span><div class="wt-time"><span class="k">${tHtml('elapsed')}</span><b id="d-el">0:00</b></div></div>
          <span class="overlay-toggles" id="ov" role="group" aria-label="${tText('chartLines')}">${OVERLAY.map(([k, l]) => html`<button data-ov="${k}" class="ov ov-${k} ${ov[k] ? 'on' : ''}" aria-pressed="${String(!!ov[k])}"><i aria-hidden="true"></i>${tHtml(l)}</button>`)}</span>
          <div class="wt-time rem"><span class="k">${tHtml('remainingLc')}</span><b id="d-rem">${fmtTime(this.w.duration)}</b><small id="d-tot">${tHtml('ofTime', { time: fmtTime(this.w.duration) })}</small></div>
        </div>
        <div class="dg-mount"></div>
        <div class="dg-tip" id="dg-tip" hidden></div>
      </div>
      <div class="ride-controls" data-msg="${tText('autoPaused')}">
        <button class="ctl" data-act="prev" title="${tText('btnPrev')} (←)" aria-label="${tText('btnPrev')}" aria-keyshortcuts="ArrowLeft"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5l-9 7 9 7z"/></svg></button>
        <button class="ctl" data-act="back" title="${tText('back1min')}" aria-label="${tText('back1min')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg></button>
        <button class="ctl play" data-act="play" title="${tText('start')} (${tText('spaceKey')})" aria-label="${tText('start')}" aria-keyshortcuts="Space" id="btn-play"><svg viewBox="0 0 24 24" aria-hidden="true" class="i-play"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" aria-hidden="true" class="i-pause"><path d="M8 5v14M16 5v14"/></svg></button>
        <button class="ctl" data-act="stop" title="${tText('endWorkout')}" aria-label="${tText('endWorkout')}" aria-keyshortcuts="Escape"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>
        <button class="ctl" data-act="fwd" title="${tText('fwd1min')}" aria-label="${tText('fwd1min')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/></svg></button>
        <button class="ctl" data-act="next" title="${tText('btnNext')} (→)" aria-label="${tText('btnNext')}" aria-keyshortcuts="ArrowRight"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l9 7-9 7z"/></svg></button>
        <div class="int-group" title="${tText('intensityTitle')}">
          <div class="int-read"><span class="k">${tHtml('intensity')}</span><b id="int-val" class="int-val">${pct(100)}</b></div>
          <button class="ctl int-b" data-int="-1" title="${tText('intDownTitle')}" aria-label="${tText('btnIntDown')}">−</button>
          <button class="ctl int-b" data-int="1" title="${tText('intUpTitle')}" aria-label="${tText('btnIntUp')}">+</button>
        </div>
      </div>
      <section class="compact-ride" aria-label="${tText('compactView')}">
        <header class="compact-head" data-tauri-drag-region>
          <span class="compact-name" data-tauri-drag-region title="${this.info?.title || this.w.name}">${this.info?.title || this.w.name}</span>
          <span class="compact-state" id="cmp-state"><i id="cmp-dot"></i><span id="cmp-status" role="status"></span></span>
          <div class="compact-gears" id="cmp-gears" hidden><button class="icon-btn" data-shift="-1" title="${tText('shiftDownKey')}" aria-label="${tText('shiftDownKey')}">−</button><span id="cmp-gear"></span><button class="icon-btn" data-shift="1" title="${tText('shiftUpKey')}" aria-label="${tText('shiftUpKey')}">+</button></div>
          <span class="compact-short">${cmpWl}${cmpCtl}</span>
          <button class="icon-btn" data-act="expand" title="${tText('expandView')}" aria-label="${tText('expandView')}">${IC.expand}</button>
        </header>
        <div class="compact-main">
          <section class="cp cp-live">
            <div class="cp-ph"><i></i>${tHtml('live')}</div>
            <div class="cp-body">
              <div class="cp-cell"><div class="cp-dial"><div class="cp-mount" id="cmp-gauge"></div><div class="cp-center"><b id="cmp-pow">–</b><small id="cmp-pow-sub"></small></div></div></div>
              <div class="cp-meta cp-opt"><span><small>${tHtml('devHr')}</small><b id="cmp-hr">–</b></span><span><small>${tHtml('cadence')}</small><b id="cmp-cad">–</b></span></div>
            </div>
          </section>
          <section class="cp cp-cur">
            <div class="cp-ph"><i></i>${tHtml('compactCurrent')}</div>
            <div class="cp-body">
              <div class="cp-cell"><div class="cp-dial"><div class="cp-mount" id="cmp-ring"></div><div class="cp-center"><b id="cmp-seg">0:00</b><small id="cmp-seg-sub"></small></div></div></div>
              <div class="cp-info cp-opt"><b id="cmp-tgt">–</b><div class="cp-bar"><i id="cmp-bar"></i></div></div>
            </div>
          </section>
          <section class="cp cp-next">
            <div class="cp-ph"><i></i>${tHtml('compactNext')}</div>
            <div class="cp-body"><div class="cp-nx" id="cmp-next"></div></div>
          </section>
        </div>
        <div class="compact-foot">${cmpCtl}${cmpWl}</div>
      </section>
      <div class="ready" id="ready"><div><b>${tHtml('ready')}</b><span>${tHtml('readyText')}${trainer.connected && html` ${tHtml('readyPedal')}`}.</span></div>
        ${this.hasFree && html`<div class="vs-ask"><span class="k" id="vs-choice-l">${tHtml('freeRideSegments')}</span>${segCtl('vs-choice', [['gears', 'realGears'], ['easy', 'vgEasy'], ['medium', 'diff.medium'], ['hard', 'diff.hard']].map(([k, l]) => [k, tHtml(l)]), this.vs.on ? this.vs.difficulty : 'gears', { labelledBy: 'vs-choice-l' })}</div>`}</div>`);

    this.gauge = new Gauge($('.gauge-mount', r));
    this.ring = new ProgressRing($('.ring-mount', r));
    this.cGauge = new Gauge($('#cmp-gauge', r));
    this.cRing = new ProgressRing($('#cmp-ring', r));
    const cmpEl = $('.compact-ride', r);
    const fitCompact = () => {
      const m = compactMode(cmpEl.clientWidth, cmpEl.clientHeight);
      cmpEl.dataset.mode = m.mode;
      for (const k of ['short', 'tiny', 'narrow', 'xs']) cmpEl.dataset[k] = m[k] ? '1' : '0';
    };
    this.cObs = new ResizeObserver(fitCompact);
    this.cObs.observe(cmpEl);
    fitCompact();
    this.diagram = new Diagram($('.dg-mount', r), this.w, {
      bounds: bounds(), ftp: ftp(), maxHr: maxHr(), overlay: ov,
      onSelect: (i, s) => {
        const tip = $('#dg-tip');
        mount(tip, html`${segmentText(s)} <button class="btn ghost sm" data-act="goto" data-i="${i}">${tHtml('jumpHere')}</button>`);
        tip.hidden = false;
        clearTimeout(this.tipTimer);
        this.tipTimer = setTimeout(() => (tip.hidden = true), 6000);
      },
    });
    // arrow keys move inside the free-ride choice and must not also skip segments (ride shortcuts)
    const vsc = $('#vs-choice', r);
    if (vsc) vsc.onkeydown = (e) => { rovingKey(e); if (e.defaultPrevented) e.stopPropagation(); };
    r.onclick = (e) => {
      if (this.ending) return;
      const menu = e.target.closest('[data-act="menu"]');
      if (menu) return openMenu(menu);
      const vsb = e.target.closest('#vs-choice [data-v]');
      if (vsb) return this.chooseShifting(vsb.dataset.v);
      const sb = e.target.closest('[data-shift]');
      if (sb) return this.shift(+sb.dataset.shift);
      const o = e.target.closest('[data-ov]');
      if (o) return this.toggleOverlay(o.dataset.ov, o);
      const c = e.target.closest('[data-act]');
      if (c) return this.control(c.dataset.act, c);
      const i = e.target.closest('[data-int]');
      if (i) return this.adjust(+i.dataset.int * (e.shiftKey ? 10 : 1));
      if (e.target.closest('#gauge')) { this.showPct = !this.showPct; this.render(true); }
    };
    this.onDeviceStatus();
  }

  /** Show or hide one live trace (power, cadence, HR) on the chart; remembered in settings.overlay. */
  toggleOverlay(k, btn) {
    const ov = { ...(state.settings.overlay || {}) };
    ov[k] = !ov[k];
    state.settings.overlay = ov;
    btn.classList.toggle('on', ov[k]);
    btn.setAttribute('aria-pressed', String(ov[k]));
    this.diagram.setOverlay(ov);
    this.diagram.update(this.t, this.samples);
    api.saveState();
  }

  /** Free-ride segments: real gears (trainer free ride) or virtual gears at a difficulty; saved as the rider's default. */
  chooseShifting(v) {
    this.vs.on = v !== 'gears';
    if (this.vs.on) this.vs.difficulty = v;
    state.settings.shifting = { ...shifting(), mode: this.vs.on ? 'virtual' : 'gears', difficulty: this.vs.on ? v : shifting().difficulty };
    api.saveState();
    const ctl = $('#vs-choice');
    if (ctl) selectSeg(ctl, $(`[data-v="${v}"]`, ctl));
    this.drive(); this.render(true);
  }

  get freeLike() {
    const s = this.w.segments[this.segIdx];
    return !!s && (s.p0 === null || s.erg === false);
  }

  /** Controller button actions (see BUTTON_ACTIONS). */
  button(a) {
    if (this.ending) return; // the ride is being saved: no second finish, no new ERG target
    switch (a) {
      case 'gear+': case 'gear-': {
        const d = a === 'gear+' ? 1 : -1;
        if (this.freeLike) { this.shift(d); return this.hint(t('gearN', { n: this.gear + 1 })); }
        this.adjust(d); return this.hint(t('intensityPct', { n: this.intensity }));
      }
      case 'int+': this.adjust(1); return this.hint(t('intensityPct', { n: this.intensity }));
      case 'int-': this.adjust(-1); return this.hint(t('intensityPct', { n: this.intensity }));
      case 'next': if (this.control('next') !== false) this.hint(`${t('btnNext')} ⏭`); return;
      case 'prev': if (this.control('prev') !== false) this.hint(`⏮ ${t('btnPrev')}`); return;
      case 'play': this.toggle(); return this.hint(this.running ? `▶ ${t('running')}` : `⏸ ${t('paused')}`);
      case 'pct': this.showPct = !this.showPct; this.render(true); return this.hint(this.showPct ? '% FTP' : t('watts'));
    }
  }

  /** Brief centred hint over the ride screen (controller / key actions), also announced to screen readers. */
  hint(text) {
    let el = $('#ride-hint');
    if (!el) { el = document.createElement('div'); el.id = 'ride-hint'; el.className = 'ride-hint'; $('#ride').append(el); }
    el.textContent = text;
    announce(text);
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }

  /** Virtual gear up/down (controller or +/−); a shift in a free segment switches virtual gears on. */
  shift(dir) {
    const n = Math.max(0, Math.min(this.gears.length - 1, this.gear + dir));
    if (n === this.gear) return;
    this.gear = n;
    if (this.freeLike && !this.vs.on) { this.vs.on = true; } // shifting implies virtual gears
    const lbl = $('#gear-lbl');
    lbl?.classList.remove('flash'); void lbl?.offsetWidth; lbl?.classList.add('flash');
    this.drive(); this.render(true);
  }

  /** Update the LIVE panel's connection state (dot and label) when a device connects or drops out. */
  onDeviceStatus() {
    const st = $('#live-status'), dot = $('#live-dot');
    if (st) {
      const on = trainer.connected;
      mount(st, on ? html`${IC.plug}${tHtml(trainer.mode === 'sim' ? 'simulator' : 'connectedCap')}` : tHtml('noTrainer'));
      st.className = `ph-status ${on ? 'ok' : ''}`;
      dot.className = `ph-dot ${on ? 'on' : ''}`;
    }
    const e = $('#erg-state');
    if (!e) return;
    if (!trainer.connected) { e.textContent = t('noTrainerTimer'); e.className = 'erg off'; }
    else if (trainer.canErg) { e.textContent = 'ERG'; e.className = 'erg on'; }
    else { e.textContent = t('powerOnlyCap'); e.className = 'erg'; }
  }

  async wake() {
    invoke('keep_awake', { on: true }).catch(() => {});
    // Windows (WebView2) has no helper process for this — use the Screen Wake Lock API
    if (OS === 'win' && navigator.wakeLock && !this.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
  }

  mult() { return this.intensity / 100; }

  /** Intensity ± in % (controller, keys, buttons); scales every target until the end of the ride. */
  adjust(d) {
    const old = this.intensity;
    this.intensity = Math.max(50, Math.min(150, this.intensity + d));
    this.drive(); this.render(true);
    if (this.intensity !== old && motionOK()) restartAnim($('#int-val'), this.intensity > old ? 'roll-up' : 'roll-down', ['roll-up', 'roll-down']);
  }

  /** Seek with test rules: no skipping inside a measured effort (ramp or all-out), and a jump never
   *  lands in the middle of one — forward snaps to its start, backward to its end — so efforts are
   *  always ridden in one piece and never counted twice. Returns false when blocked. */
  go(to) {
    if (!this.test) return this.seek(to);
    const segs = this.w.segments;
    if (segs[this.segIdx]?.measure && !this.cooling) { this.hint(t('noSkipTest')); return false; }
    const k = segmentAt(segs, Math.max(0, Math.min(to, this.w.duration - 0.01)));
    const s = segs[k];
    if (s?.measure && to > s.start) {
      let a = k, b = k;
      while (a > 0 && segs[a - 1].measure === s.measure) a--;
      while (b < segs.length - 1 && segs[b + 1].measure === s.measure) b++;
      to = to >= this.t ? segs[a].start : segs[b].start + segs[b].duration;
    }
    return this.seek(to);
  }

  /** Jump to a time in the workout. Callers go through go(), which applies the FTP-test rules (no skipping inside a measured effort). */
  seek(to) {
    this.t = Math.max(0, Math.min(this.w.duration - 0.01, to));
    this.lastSec = Math.floor(this.t) - 1; // record from where the jump lands, never the skipped seconds
    this.beeped.clear();
    this.drive(); this.render(true);
  }

  /** Ride controls (buttons, keys, controllers): play/pause, previous/next segment, ±1 min, stop. */
  control(c, elm) {
    const seg = this.w.segments[this.segIdx];
    switch (c) {
      case 'play': return this.toggle();
      case 'expand': return this.compact.set(false);
      case 'stop': return this.stop();
      case 'back': return this.go(this.t - 60);
      case 'fwd': return this.go(this.t + 60);
      case 'prev': {
        const inSeg = this.t - seg.start;
        const target = inSeg > 3 || this.segIdx === 0 ? seg.start : this.w.segments[this.segIdx - 1].start;
        return this.go(target);
      }
      case 'next': {
        const n = this.w.segments[this.segIdx + 1];
        if (this.test && seg?.measure && !this.cooling) return this.go(this.t + 1); // blocked → hint
        return n ? this.go(n.start) : this.finish(true);
      }
      case 'goto': $('#dg-tip').hidden = true; return this.go(this.w.segments[+elm.dataset.i].start);
    }
  }

  /** Start, pause or resume. auto = true when auto-pause triggered it (resumes by pedalling). */
  toggle(auto = false) {
    if (this.ending) return;
    if (!this.started) { this.started = true; this.startedAt = new Date(); $('#ready')?.remove(); }
    this.running = !this.running;
    this.autoPaused = !this.running && auto;
    this.idleFor = 0; this.pedalFor = 0;
    if (this.running) trainer.resume();
    $('#ride').classList.toggle('paused', !this.running);
    $('#ride').classList.toggle('auto-paused', this.autoPaused);
    this.drive(); this.render(true);
  }

  /** Autopause: pause after a few seconds without power, resume as soon as the rider pedals again. */
  autoPause(realDt) {
    if (state.settings.autoPause === false || !this.started || !trainer.connected) return;
    const p = fresh('power'), c = fresh('cadence');
    const pedalling = (p != null && p > 15) || (c != null && c > 15);
    if (this.running) {
      const cs = this.w.segments[this.segIdx];
      // ramp tests end by themselves, and in a measured test effort a stop must count as 0 W —
      // pausing would leave the rest out and make the effort average too high
      if (cs?.ramp || (this.test && cs?.measure)) { this.idleFor = 0; return; }
      this.idleFor = pedalling ? 0 : (this.idleFor || 0) + realDt;
      if (this.idleFor >= 3) { this.toggle(true); this.hint(`⏸ ${t('autoPaused')}`); }
    } else if (this.autoPaused) {
      this.pedalFor = pedalling ? (this.pedalFor || 0) + realDt : 0;
      if (this.pedalFor >= 1) { this.toggle(); this.hint(`▶ ${t('resumed')}`); }
    }
  }

  /** True when Space / Enter belong to the focused element rather than to the ride shortcuts: a control the
   *  rider reached with the keyboard, or any focused radio / tab. A control focused by a click keeps the shortcuts. */
  keyTarget(el) {
    if (!el?.matches?.('button, a[href], select, textarea, summary, [tabindex], [role]')) return false;
    return el.matches('[role=radio], [role=tab]') || el !== pointerFocused;
  }

  /** Keyboard shortcuts while riding (space, arrows, +/−); ignored in dialogs, inputs, or when switched off in Settings. */
  onKey(e) {
    // an open popover menu owns the keyboard (Esc closes it, never stops the ride)
    if (this.ending || modal.open || $('#popover') || e.target.matches('input') || state.settings.keyboardShortcuts === false) return;
    // Space / Enter activate a control the rider reached with the keyboard (Tab), and always
    // select a focused radio or tab (free-ride choice). A button that only has focus because it was clicked
    // keeps the shortcut: after clicking "next", Space should still pause, not skip again.
    if ((e.key === ' ' || e.key === 'Enter') && this.keyTarget(e.target)) return;
    const map = { ' ': 'play', ArrowRight: 'next', ArrowLeft: 'prev', Escape: 'stop' };
    if (map[e.key]) { e.preventDefault(); return this.control(map[e.key]); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); return this.shift(1); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); return this.shift(-1); }
    if (this.freeLike && this.vs.on && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); return this.shift(e.key === 'ArrowUp' ? 1 : -1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.adjust(e.shiftKey ? 10 : 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); this.adjust(e.shiftKey ? -10 : -1); }
  }

  /** Main loop, every 250 ms: advance time, 1 Hz samples, auto-pause, ramp-test end, then trainer control (drive()) and render(). */
  tick() {
    const now = performance.now();
    const realDt = (now - this.last) / 1000;
    const dt = realDt * SPEED;
    this.last = now;
    this.autoPause(realDt);

    // auto-start when the rider starts pedalling
    if (!this.started && trainer.connected) {
      this.autoStartCount = (fresh('power') > 20 || fresh('cadence') > 20) ? this.autoStartCount + 1 : 0;
      if (this.autoStartCount >= 8) this.toggle();
    }

    if (this.running) {
      this.t += dt;
      this.ridden += dt;
      const sec = Math.floor(this.t);
      if (sec !== this.lastSec) {
        // Fill every second since the last sample so recordings stay 1 Hz: a late tick (the webview
        // throttles timers in a hidden or minimised window, or dev fast-forward with ?speed) must not
        // leave gaps in the FIT file or make test efforts look short. seek() moves lastSec to the
        // second before the new position, so a jump never records fake seconds in between.
        const from = sec > this.lastSec ? this.lastSec + 1 : sec;
        this.lastSec = sec;
        // wall time per sample: one second apart, ending at now (real time; fast-forward spaces them 1 s)
        const nowWall = SPEED > 1 ? this.startedAt.getTime() + (this.samples.length + sec - from) * 1000 : Date.now();
        for (let ts = from; ts <= sec; ts++) {
          const i = Math.max(0, segmentAt(this.w.segments, Math.min(ts, this.w.duration - 0.01)));
          const wall = nowWall - (sec - ts) * 1000;
          this.samples.push({ t: ts, p: fresh('power'), c: fresh('cadence'), hr: fresh('hr'), v: this.vsSpeed ?? fresh('speed'), tp: this.targetW, seg: i, measure: this.w.segments[i]?.measure, wall });
          const tag = this.w.segments[i]?.measure;
          if (tag) { const acc = ((this.effAcc ||= {})[tag] ||= { sum: 0, n: 0 }); acc.sum += this.samples[this.samples.length - 1].p || 0; acc.n++; }
        }
      }
      if (this.t >= this.w.duration) return this.finish(true);
      // ramp tests end by themselves once the rider can no longer hold the target
      const cs = this.w.segments[this.segIdx];
      if (this.test && cs?.ramp && trainer.connected && this.t - this.w.segments.find((x) => x.ramp).start > 60) {
        const p = fresh('power'), c = fresh('cadence'), tw = this.targetW;
        this.lowCount = ((c != null && c < 30) || (p != null && tw && p < tw * 0.5)) ? this.lowCount + dt : 0;
        if (this.lowCount >= 10) this.rampCooldown();
      }
    }
    this.drive();
    this.render(false);
  }

  /** The rider can't hold the ramp any more: end the ramp here and continue with an easy
   *  5-minute cool-down (still recorded) instead of stopping abruptly. Stop shows the result. */
  rampCooldown() {
    if (this.cooling) return;
    this.cooling = true;
    const segs = this.w.segments;
    const i = this.segIdx;
    segs[i].duration = Math.max(1, Math.round(this.t - segs[i].start));
    const easy = segs[0].p0 ?? 100 / ftp(); // the warm-up power (100 W / 80 W)
    const cool = { type: 'cooldown', duration: 300, p0: easy, p1: easy * 0.8, texts: [{ t: 0, msg: t('rampDoneMsg') }] };
    this.w.segments = [...segs.slice(0, i + 1), cool];
    let total = 0;
    this.w.segments.forEach((x, k) => { x.idx = k + 1; x.label = String(k + 1); x.start = total; total += x.duration; });
    this.w.duration = total;
    this.diagram.w = this.w;
    this.diagram.draw();
    $('#d-tot').textContent = t('ofTime', { time: fmtTime(total) });
    this.hint(t('rampComplete'));
    this.drive(); this.render(true);
  }

  get targetFrac() {
    const s = this.w.segments[this.segIdx];
    const p = powerAt(s, this.t - s.start);
    return p === null ? null : p * this.mult();
  }

  get targetW() { const f = this.targetFrac; return f === null ? null : Math.round(f * ftp()); }

  /**
   * Element by id for render(): looked up once and cached for the rest of the ride. A cached element that
   * was replaced (build() again, a container re-rendered) is no longer connected and is looked up afresh.
   */
  q(id) {
    let el = this.els?.get(id);
    if (!el?.isConnected) {
      el = document.getElementById(id);
      (this.els ??= new Map()).set(id, el);
    }
    return el;
  }

  /** Same cache for a selector (first match), for elements without an id. */
  qs(sel) {
    let el = this.sels?.get(sel);
    if (!el?.isConnected) {
      el = document.querySelector(sel);
      (this.sels ??= new Map()).set(sel, el);
    }
    return el;
  }

  /** Same cache for all matches of a selector; looked up again when one of them was replaced. */
  qsa(sel) {
    let list = this.selsAll?.get(sel);
    if (!list || !list.every((x) => x.isConnected)) {
      list = $$(sel);
      (this.selsAll ??= new Map()).set(sel, list);
    }
    return list;
  }

  /**
   * Trainer control: ERG target, free ride, or a virtual-shifting target. Called every tick and right after
   * anything that changes the target (intensity, seek, start/resume, shifting, a shortened ramp), so the
   * resistance follows at once. ERG targets are deduplicated (Trainer.send); virtual-shifting targets go out
   * at most every 900 ms, also on a shift (the next tick sends the latest). Once the ride is ending finish()
   * has released ERG and nothing is sent again. Sets vsActive / vsSpeed / vs.watts for render() and recording.
   */
  drive() {
    const segs = this.w.segments;
    const s = segs[Math.max(0, segmentAt(segs, Math.min(this.t, this.w.duration - 0.01)))];
    const f = powerAt(s, this.t - s.start);
    const freeLike = f === null || s.erg === false;
    this.vsActive = freeLike && this.vs.on && trainer.connected && trainer.canErg && !this.ending;
    this.vsSpeed = null;
    if (this.vsActive) {
      const cad = fresh('cadence');
      const ratio = this.gears[this.gear];
      this.vsSpeed = virtualSpeed(cad, ratio);
      const raw = targetWatts(cad, ratio, weight() || 75, this.vs.difficulty);
      this.vs.watts = this.vs.watts == null ? raw : Math.round(this.vs.watts * 0.5 + raw * 0.5);
      const now = performance.now();
      if (now - this.vs.sentAt > 900) { trainer.setTargetPower(this.vs.watts); this.vs.sentAt = now; }
    } else if (trainer.connected && !this.ending) {
      this.vs.watts = null;
      if (freeLike) trainer.setFreeRide(); else trainer.setTargetPower(Math.round(f * this.mult() * ftp()));
    }
  }

  /**
   * What one render() paints from, computed once per tick: the segment (and whether it changed), time in it,
   * targets, fresh sensor values and the cadence state. renderPacing() adds `paceFast` for coach().
   * Moves segIdx to the segment at `t` first, so targetFrac / targetW read the current one.
   */
  frame() {
    const segs = this.w.segments;
    const idx = Math.max(0, segmentAt(segs, Math.min(this.t, this.w.duration - 0.01)));
    const segChanged = idx !== this.segIdx;
    this.segIdx = idx;
    const s = segs[idx];
    const inSeg = this.t - s.start;
    const rem = s.duration - inSeg;
    const tf = this.targetFrac;
    const tw = this.targetW;
    const F = ftp();
    const allOut = s.erg === false;
    const freeLike = tw === null || allOut;
    const vsActive = this.vsActive, vsSpeed = this.vsSpeed; // set by drive()
    const p = fresh('power'), c = fresh('cadence'), hr = fresh('hr'), v = fresh('speed');
    const gt = vsActive ? this.vs.watts : allOut ? null : tw;
    // cadence vs target (Zwift: Cadence / CadenceLow+High): green on target, amber ±5–10, red beyond 10 rpm
    const cLo = s.cadenceLow ?? s.cadence, cHi = s.cadenceHigh ?? s.cadence;
    const dev = c != null && cLo != null ? (c < cLo ? cLo - c : c > cHi ? c - cHi : 0) : null;
    const cadState = dev == null ? '' : dev > 10 ? 'bad' : dev > 5 ? 'warn' : 'good';
    const live = this.running || !this.started; // the cadence warning shows while riding or before the start
    return {
      idx, segChanged, s, n: segs[idx + 1], inSeg, rem, tf, tw, F, allOut, freeLike, vsActive, vsSpeed,
      p, c, hr, v, gt, cLo, cHi, dev, cadState, live, color: zoneColor(tf, bounds()), paceFast: false,
    };
  }

  /** Update the ride screen from the current state. Cheap on purpose (4× per second): cached elements, writes only on change;
   * `force` redraws everything that otherwise only changes with the segment. Only paints: it never talks to the trainer (drive()). */
  render(force) {
    const f = this.frame();
    this.renderGears(f);
    this.beeps(f);
    this.renderLive(f);
    this.renderSegment(f);
    if (f.segChanged || force) this.renderSegmentChange(f);
    this.animReady = true;
    this.coach(f.s, f);
    setText(this.q('d-el'), fmtTime(this.t));
    setText(this.q('d-rem'), fmtTime(Math.max(0, Math.ceil(this.w.duration - this.t))));
    this.renderCompact(f); // after the full view: it copies some of its values
    this.renderControls();
  }

  /** Gear box (free-ride segments with virtual shifting or a controller): current gear and ratio. */
  renderGears({ freeLike, vsActive }) {
    const gb = this.q('gearbox');
    if (gb) {
      gb.hidden = !(freeLike && (this.vs.on || ctrls.connected));
      setHtml(this.q('gear-lbl'), html`<b>${tHtml('gearN', { n: this.gear + 1 })}</b><small>/${this.gears.length} · ${this.gears[this.gear].toFixed(2)}${vsActive && ` · ${this.vs.watts} W`}</small>`);
    }
  }

  /** Countdown beeps: last 3 s before a change of target. */
  beeps({ idx, s, n, rem }) {
    if (state.settings.beeps && this.running && n && rem <= 3.05 && rem > 0) {
      const sec = Math.min(3, Math.ceil(rem)), k = `${idx}:${sec}`;
      if (!this.beeped.has(k)) { this.beeped.add(k); countdown(sec, state.settings.beepDirection !== false ? cueDir(s, n) : null); }
    }
  }

  /** ERG state label and the LIVE panel: power, cadence, speed, heart rate, gauge. */
  renderLive({ s, F, allOut, freeLike, vsActive, vsSpeed, p, c, hr, v, gt, cLo, cHi, cadState, live }) {
    const ergEl = this.q('erg-state');
    if (ergEl && trainer.connected && trainer.canErg) {
      setText(ergEl, vsActive ? `${t('virtualGears')} · ${t(`diff.${this.vs.difficulty}`)}` : freeLike ? t('ergOffGears') : 'ERG');
      ergEl.className = vsActive ? 'erg vs' : freeLike ? 'erg off' : 'erg on';
    }

    setText(this.q('m-pow'), p ?? '–');
    // power bar: 0…1.5× target, coloured by the zone you're riding in (the target is on the gauge)
    const pRef = gt || F;
    setBar(this.q('b-pow'), p != null ? p / (pRef * 1.5) : 0, { color: p != null ? zoneColor(p / F, bounds()) : null });

    setText(this.q('v-cad'), c != null ? Math.round(c) : '–');
    setText(this.q('t-cad'), cLo != null ? `/ ${cLo === cHi ? cLo : `${cLo}–${cHi}`}` : '');
    this.q('v-cad').classList.toggle('off-target', live && cadState === 'bad');
    this.q('t-cad').className = live ? cadState : '';
    const CMIN = 40, CMAX = 130, cf = (x) => (x - CMIN) / (CMAX - CMIN);
    setBar(this.q('b-cad'), c != null ? cf(c) : 0, {
      mark: cLo != null && cLo === cHi ? cf(cLo) : null,
      band: cLo != null && cLo !== cHi ? [cf(cLo), cf(cHi)] : null,
      color: cadState === 'bad' ? 'var(--danger)' : cadState === 'warn' ? 'var(--warn)' : cadState === 'good' ? 'var(--ok)' : null,
    });

    const spd = vsSpeed ?? v;
    setText(this.q('v-spd'), spd != null ? spd.toFixed(1) : '–');
    setBar(this.q('b-spd'), spd != null ? spd / 60 : 0, { color: 'var(--ok)' });
    setText(this.q('v-hr'), hr ?? '–');
    setText(this.q('t-hr'), hr != null ? pct(Math.round((hr / maxHr()) * 100)) : '');
    setBar(this.q('b-hr'), hr != null ? hr / maxHr() : 0, { color: 'var(--hrline)' });

    setText(this.q('g-unit'), this.showPct ? '% FTP' : t('watt'));
    setText(this.q('v-pow'), p == null ? '–' : this.showPct ? pct(Math.round((p / F) * 100)) : p);
    setText(this.q('t-pow'), gt == null ? t(s.type === 'maxeffort' ? 'gMax' : allOut ? 'gAllOut' : 'gFree') : this.showPct ? pct(Math.round((gt / F) * 100)) : `${gt} W`);
    this.gauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });
    // on target: within ±5 % for 3 s -> soft glow in the zone colour around the gauge
    const onT = this.running && gt != null && p != null && Math.abs(p - gt) / gt <= 0.05;
    this.onSince = onT ? (this.onSince ?? performance.now()) : null;
    const gEl = this.q('gauge');
    if (gt != null) gEl.style.setProperty('--glow', zoneColor(gt / F, bounds()));
    gEl.classList.toggle('on-target', onT && performance.now() - this.onSince >= 3000);
  }

  /** CURRENT SEGMENT panel: progress ring, target (or test pacing), cadence target, time left. */
  renderSegment(f) {
    const { s, n, inSeg, rem, tf, tw, F, allOut, vsActive, gt, cLo, cHi, color } = f;
    this.ring.update(Math.min(1, inSeg / s.duration), color);
    if (s.p0 === null) { this.q('s-target').classList.remove('range'); setText(this.q('s-target'), s.type === 'maxeffort' ? t('bigMax') : t('bigFree')); setText(this.q('s-watts'), vsActive ? t('virtualShiftingLc') : t('rideByFeel')); }
    else {
      const a = Math.round(s.p0 * 100 * this.mult()), b = Math.round(s.p1 * 100 * this.mult());
      setText(this.q('s-target'), allOut ? t('bigAllOut') : a === b ? pct(a) : pct(`${a}–${b}`));
      this.q('s-target').classList.toggle('range', a !== b || allOut);
      setText(this.q('s-watts'), allOut ? t('aimW', { w: tw, how: vsActive ? t('howShift') : t('howGears') }) : `${tw} W`);
    }
    this.q('s-target').style.color = zoneInk(tf, bounds());
    setText(this.q('s-tw'), gt != null ? `${gt} W` : allOut ? t('allOut') : t('free'));
    this.q('s-tw').style.color = gt != null ? zoneInk(gt / F, bounds()) : '';
    this.renderPacing(f);
    setText(this.q('s-cad'), cLo != null ? `${cLo === cHi ? cLo : `${cLo}–${cHi}`} rpm` : '–');
    this.q('s-cad').classList.toggle('range', cLo != null && cLo !== cHi);
    setText(this.q('s-dur'), fmtTime(s.duration));
    this.q('s-bar').style.width = `${Math.min(100, (inSeg / s.duration) * 100)}%`;
    this.q('s-bar').style.background = color;
    setText(this.q('s-rem'), fmtTime(Math.ceil(rem)));
    this.qs('.panel.seg').classList.toggle('closing', rem <= 5 && !!n);
  }

  /** Live pacing in long all-out test efforts: running average, projected FTP, "too fast" warning (sets f.paceFast). */
  renderPacing(f) {
    const { s, tw, F, allOut, vsActive } = f;
    const pacing = this.test && allOut && s.measure && s.duration >= 300;
    setText(this.q('s-tw-k'), pacing ? (s.duration >= 480 ? t('estFtp') : t('effortAvg')) : t('targetPower'));
    this.q('s-watts').classList.remove('warn-text');
    if (!pacing) return;
    const acc = this.effAcc?.[s.measure];
    const avg = acc && acc.n >= 5 ? Math.round(acc.sum / acc.n) : null;
    const factor = s.duration >= 1140 ? 0.95 : s.duration >= 480 ? 0.9 : null;
    const fast = !!(avg && tw && acc.n >= 60 && avg > tw * 1.1);
    setText(this.q('s-target'), avg ? `${avg} W` : t('bigAllOut'));
    this.q('s-target').classList.toggle('range', !avg);
    if (avg) this.q('s-target').style.color = zoneInk(avg / F, bounds());
    setText(this.q('s-watts'), !avg ? t('aimW', { w: tw ?? '–', how: vsActive ? t('howShift') : t('howGears') }) : fast ? t('tooFastShort') : tw ? t('avgAim', { w: tw }) : t('effortAverage'));
    this.q('s-watts').classList.toggle('warn-text', fast);
    f.paceFast = fast;
    const proj = avg && factor && acc.n >= 30 ? Math.round(avg * factor) : null;
    setText(this.q('s-tw'), factor ? (proj ? `${proj} W` : '–') : (avg ? `${avg} W` : '–'));
    this.q('s-tw').style.color = '';
  }

  /** On a new segment (or `force`): segment kind, zone colour, next-segment cards, intensity, chart highlight, sweep. */
  renderSegmentChange(f) {
    const { idx, segChanged, s, color } = f;
    setText(this.q('seg-kind'), segKind(s));
    this.qs('.panel.seg').style.setProperty('--zc', color);
    const card = this.renderNext(f);
    setText(this.q('int-val'), pct(this.intensity));
    this.q('int-val').classList.toggle('changed', this.intensity !== 100);
    this.diagram.highlight(idx);
    this.q('btn-play').classList.toggle('is-running', this.running);
    // segment change: zone-coloured sweep over Current segment, Next card slides up
    if (segChanged && this.animReady && motionOK()) { restartAnim(this.qs('.panel.seg'), 'seg-in'); restartAnim(card, 'nx-in'); }
  }

  /**
   * NEXT SEGMENT. One description of the next segment, rendered into both cards: the full view (#next-card) and
   * the compact panel (#cmp-next), whose optional lines (.cp-opt) drop out on small windows and which
   * has a slot for the "in 0:42" countdown (#cmp-next-in, filled every tick by renderCompact()). Returns the full card.
   */
  renderNext({ n, F }) {
    const card = this.q('next-card'), cn = this.q('cmp-next');
    let zc = 'var(--line-strong)', title = '', body;
    if (n) {
      const m = this.mult();
      const nf = n.p0 === null ? null : ((n.p0 + n.p1) / 2) * m;
      const pa = n.p0 === null ? null : Math.round(n.p0 * 100 * m), pb = n.p0 === null ? null : Math.round(n.p1 * 100 * m);
      const wa = n.p0 === null ? null : Math.round(n.p0 * F * m), wb = n.p0 === null ? null : Math.round(n.p1 * F * m);
      const big = n.p0 === null ? tHtml(n.type === 'maxeffort' ? 'maxEffort' : 'freeRide') : n.erg === false ? tHtml('allOut') : pa === pb ? pct(pa) : `${pct(pa)} → ${pct(pb)}`;
      const watts = n.p0 === null ? tHtml('rideByFeel') : wa === wb ? `${wa} W` : `${wa} → ${wb} W`;
      const nLo = n.cadenceLow ?? n.cadence, nHi = n.cadenceHigh ?? n.cadence;
      const rpm = nLo == null ? null : `${nLo === nHi ? nLo : `${nLo}–${nHi}`} rpm`;
      zc = zoneColor(nf, bounds());
      title = nf == null ? t('freeRide') : zoneOf(nf, bounds()).name;
      body = (compact) => html`<div class="nc-txt"><b>${big}</b><span class="nc-v">${watts}</span><span class="nc-v${compact ? ' cp-opt' : ''}">${fmtTime(n.duration)} min</span>${compact
        ? html`<span class="nc-v cp-opt" id="cmp-next-in"></span>`
        : rpm && html`<span class="nc-v nc-rpm">${rpm}</span>`}</div>`;
    } else {
      // last segment: "Finish strong", or after a failed ramp test the result hint
      const note = (compact) => (this.cooling ? (compact ? null : tHtml('pressStopResult')) : tHtml('noMoreChanges'));
      body = (compact) => html`<div class="nc-txt"><b>${tHtml(this.cooling ? 'testDone' : 'finishStrong')}</b>${note(compact) && html`<span class="nc-v muted${compact ? ' cp-opt' : ''}">${note(compact)}</span>`}</div>`;
    }
    card.style.setProperty('--zc', zc);
    cn.style.setProperty('--zc', zc);
    card.title = title;
    mount(card, body(false));
    mount(cn, body(true));
    return card;
  }

  /**
   * Compact panels: same values as the full view (actual target, never a test-estimated FTP). Both presentations
   * share the same samples and Ride; no DOM is rebuilt on resize. Runs after the full view, whose target, bar and
   * "workout left" it copies.
   */
  renderCompact({ s, rem, inSeg, F, allOut, freeLike, p, c, hr, gt, cadState, live, color }) {
    const cmpSub = gt != null ? `${gt} W` : t(allOut ? 'gAllOut' : 'gFree');
    this.cGauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });
    setText(this.q('cmp-pow'), p ?? '–');
    setText(this.q('cmp-pow-sub'), cmpSub);
    this.cRing.update(Math.min(1, inSeg / s.duration), color);
    setText(this.q('cmp-seg'), fmtTime(Math.max(0, Math.ceil(rem))));
    setText(this.q('cmp-seg-sub'), cmpSub);
    setText(this.q('cmp-tgt'), this.q('s-target').textContent);
    this.q('cmp-tgt').style.color = this.q('s-target').style.color;
    this.q('cmp-bar').style.width = this.q('s-bar').style.width;
    this.q('cmp-bar').style.background = color;
    setText(this.q('cmp-hr'), hr ?? '–');
    setText(this.q('cmp-cad'), c != null ? Math.round(c) : '–');
    this.q('cmp-cad').classList.toggle('off-target', live && cadState === 'bad');
    this.qsa('.cmp-wleft').forEach((el) => { setText(el, this.q('d-rem').textContent); });
    this.q('cmp-gears').hidden = !freeLike;
    setText(this.q('cmp-gear'), t('gearN', { n: this.gear + 1 }));
    const nIn = this.q('cmp-next-in');
    if (nIn) setText(nIn, `${t('compactIn')} ${fmtTime(Math.max(0, Math.ceil(rem)))}`);
    const status = this.autoPaused ? t('compactAutoPaused') : this.running ? t('running') : this.started ? t('paused') : t('ready');
    if (this.q('cmp-status').textContent !== status) setText(this.q('cmp-status'), status);
    const connection = trainer.connected ? trainer.mode === 'sim' ? t('simulator') : t('connectedCap') : t('noTrainer');
    const statusDetail = this.autoPaused ? t('autoPaused') : status;
    this.q('cmp-state').title = `${statusDetail} · ${connection}`;
    this.q('cmp-state').setAttribute('aria-label', `${statusDetail} · ${connection}`);
    this.q('cmp-dot').classList.toggle('on', trainer.connected);
  }

  /** Play buttons (full and compact view: Start before the ride, then Pause / Resume), gauge toggle state, workout chart. */
  renderControls() {
    const play = this.running ? t('btnPause') : this.started ? t('resume') : t('start');
    this.qsa('#ride [data-act="play"]').forEach((el) => {
      el.classList.toggle('is-running', this.running);
      setAttr(el, 'aria-label', play);
      setAttr(el, 'title', `${play} (${t('spaceKey')})`);
    });
    setAttr(this.q('gauge'), 'aria-pressed', String(this.showPct));
    if (!this.compact.active) this.diagram.update(this.t, this.samples);
  }

  /**
   * Coach line under the Current segment stats: one short message at a time, empty otherwise.
   * Priority: the workout's own text events > pacing (test "too fast", ERG power fading) >
   * cadence more than 5 rpm off for 5 s (clears after 3 s back on target) > hard-segment cues
   * (Z4 and up, all-out, max effort: start, halfway, last 30 s). A message stays at least 4 s
   * unless a more important one replaces it. Automatic hints can be switched off (Settings → App).
   */
  coach(s, { segChanged, inSeg, rem, allOut, freeLike, gt, p, c, cLo, cHi, dev, cadState, paceFast }) {
    const el = this.q('coach');
    if (!el) return;
    const now = performance.now() / 1000;
    const k = (this.cz ||= { cadOff: null, cadOn: null, cadShown: false, powLow: null, cur: null, since: 0 });
    if (segChanged) Object.assign(k, { cadOff: null, cadOn: null, cadShown: false, powLow: null });
    const auto = this.running && state.settings.coachHints !== false;
    const cands = [];

    // 1. text events from the .zwo file (always shown, also while paused)
    const ev = s.texts.filter((x) => inSeg >= x.t && inSeg < x.t + 10).pop();
    if (ev?.msg) cands.push({ key: `zwo:${s.start}:${ev.t}`, pri: 4, icon: IC.chat, level: 'info', text: ev.msg });

    // 2. pacing: long test efforts started too fast; ERG target not reached (cadence collapsing)
    if (auto && paceFast) cands.push({ key: 'pace', pri: 3, icon: IC.bolt, level: 'bad', text: t('coachTooFast') });
    const erg = !freeLike && trainer.connected && trainer.canErg && gt >= 50;
    const low = auto && erg && p != null && inSeg >= 10 && p < gt * 0.85;
    k.powLow = low ? (k.powLow ?? now) : null;
    if (low && now - k.powLow >= 5) cands.push({ key: 'pow', pri: 3, icon: IC.bolt, level: 'bad', text: t('coachPowerFading', { p, gt }) });

    // 3. cadence target: > 5 rpm off for 5 s, clears after 3 s back on target
    if (!auto || dev == null) Object.assign(k, { cadOff: null, cadOn: null, cadShown: false });
    else if (dev > 5) { k.cadOn = null; k.cadOff ??= now; if (now - k.cadOff >= 5) k.cadShown = true; }
    else { k.cadOff = null; if (k.cadShown) { k.cadOn ??= now; if (now - k.cadOn >= 3) { k.cadShown = false; k.cadOn = null; } } }
    if (k.cadShown) {
      const aim = cLo === cHi ? `${cLo}` : `${cLo}–${cHi}`, rpm = Math.round(c);
      cands.push(dev > 5
        ? { key: 'cad', pri: 2, icon: IC.cad, level: cadState, text: t(c < cLo ? 'coachCadLow' : 'coachCadHigh', { rpm, aim }) }
        : { key: 'cad', pri: 0.5, icon: IC.cad, level: 'ok', text: t('coachBackOnTarget', { rpm }) });
    }

    // 4. hard segments: Z4 and up, all-out efforts, max efforts (not the ramp-test steps)
    if (auto && !s.ramp && s.duration >= 20) {
      const af = s.p0 === null ? null : ((s.p0 + s.p1) / 2) * this.mult(), zone = zoneOf(af, bounds());
      const max = s.type === 'maxeffort';
      if (allOut || max || zone?.id >= 4) {
        const name = allOut ? t('allOut') : max ? t('maxEffort') : zone.name, half = s.duration / 2;
        let text = null, cue = null;
        if (inSeg < 6) { cue = 'start'; text = `${name} · ${fmtTime(s.duration)} · ${allOut || max ? t('coachGo') : t('coachSettle')}`; }
        else if (s.duration >= 120 && inSeg >= half && inSeg < half + 6) { cue = 'half'; text = t('coachHalfway', { left: fmtTime(Math.ceil(rem)) }); }
        else if (s.duration >= 60 && rem <= 30 && rem > 22) { cue = 'last'; text = t('coachLast30'); }
        if (text) cands.push({ key: `hard:${s.start}:${cue}`, pri: 1, icon: IC.flame, level: 'push', text, color: zone ? zoneInk(af, bounds()) : 'var(--danger)' });
      }
    }

    const cand = cands.sort((a, b) => b.pri - a.pri)[0] || null;
    const cur = k.cur;
    let show = cand;
    if (cur && cand?.key !== cur.key && now - k.since < 4 && (!cand || cand.pri <= cur.pri)) show = cur; // hold ≥ 4 s
    if (!show) { if (cur) { el.classList.remove('show'); k.cur = null; } return; }
    if (!cur || show.key !== cur.key) {
      k.since = now;
      mount(el, html`${show.icon}<span></span>`);
      el.classList.remove('show'); void el.offsetWidth;
    }
    el.className = `coach-line show ${show.level}`;
    if (show.color) el.style.setProperty('--cc', show.color); else el.style.removeProperty('--cc');
    const span = el.querySelector('span');
    if (span.textContent !== show.text) span.textContent = show.text;
    k.cur = show;
  }

  /** Stop button / Esc: expand from compact and pause; a ride that never started just closes, otherwise the rider decides how to end it. */
  async stop() {
    if (this.ending) return;
    if (!await this.compact.set(false)) return;
    const wasRunning = this.running;
    if (wasRunning) this.toggle();
    if (!this.started) return this.close();
    if (this.test && this.cooling) return this.finish(true); // the ramp is over — show the result
    if (this.test) {
      const c = await choiceDialog(t('endTestQ'), this.w.segments[this.segIdx]?.ramp ? t('endTestRamp') : t('endTestText', { time: fmtTime(this.ridden) }), [
        ['resume', t('resume'), 'ghost'], ['discard', t('discard'), 'ghost'], ['save', t('finishEvaluate'), 'primary']]);
      if (c === 'resume' || !c) { if (wasRunning) this.toggle(); return; }
      if (c === 'discard') return this.close();
      return this.finish(true);
    }
    const pct = Math.round((this.t / this.w.duration) * 100);
    const choice = await choiceDialog(t('endWorkoutQ'), t('endWorkoutText', { pct, time: fmtTime(this.ridden) }), [
      ['resume', t('resume'), 'ghost'],
      ...(this.planId ? [['skip', t('countSkipped'), 'ghost']] : []),
      ['discard', t('discard'), 'ghost'],
      ['save', this.planId ? t('saveAsDone') : t('save'), 'primary'],
    ]);
    if (choice === 'resume' || !choice) { if (wasRunning) this.toggle(); return; }
    if (choice === 'discard') return this.close();
    if (choice === 'skip') { await markEntry(this.planId, this.file, { status: 'skipped', doneDuration: Math.round(this.ridden), planDuration: this.w.duration }); return this.close(); }
    this.finish(false);
  }

  /** Summary numbers of the recorded samples: duration, average / normalized power, HR, cadence, kJ, distance. */
  stats() {
    const ps = this.samples.filter((s) => s.p != null);
    const avg = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null && x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    let np = null;
    if (ps.length >= 30) {
      const roll = [];
      for (let i = 29; i < ps.length; i++) { let s = 0; for (let j = i - 29; j <= i; j++) s += ps[j].p; roll.push(Math.pow(s / 30, 4)); }
      np = Math.round(Math.pow(roll.reduce((a, b) => a + b, 0) / roll.length, 0.25));
    }
    const kj = Math.round(ps.reduce((a, s) => a + s.p, 0) / 1000);
    const IF = np ? np / ftp() : null;
    const tss = IF ? Math.round(((this.ridden * np * IF) / (ftp() * 3600)) * 100) : null;
    return { avgPower: avg(this.samples, 'p'), np, avgHr: avg(this.samples, 'hr'), maxHr: Math.max(0, ...this.samples.map((s) => s.hr || 0)) || null, avgCadence: avg(this.samples, 'c'), kj: kj || null, tss };
  }

  /** End of the ride: save the FIT file, add to history and plan, evaluate FTP tests, show the summary, upload to Garmin and services. */
  async finish(completed) {
    // Runs once: a controller ▶ on the last segment or a key during the save would otherwise
    // save a second FIT file and history entry. Every ride input checks `ending`.
    if (this.ending) return;
    this.ending = true;
    $('#btn-compact').hidden = true;
    clearInterval(this.loop);
    this.running = false;
    trainer.setFreeRide(); // don't leave the trainer holding the last ERG target while the summary is open
    // Saving/results must still proceed if the OS rejects a window resize.
    await this.compact.set(false);
    // ridden to the end: the ring closes and turns into a check, then the summary rises
    const ridToEnd = completed && this.t >= this.w.duration - 1;
    const endAnim = ridToEnd && motionOK();
    if (ridToEnd && !this.test && state.settings.endChime !== false) endChime();
    const animStart = performance.now();
    if (endAnim) {
      this.ring.update(1, 'var(--ok)');
      $('.panel.seg')?.classList.remove('closing');
      $('.seg-ring')?.classList.add('finished');
      $('#gauge')?.classList.remove('on-target');
    }
    const st = this.stats();
    const title = this.info?.title || this.w.name;
    const result = { status: 'done', planDuration: this.w.duration, doneDuration: Math.round(this.ridden), completed, ...st };

    const fit = await this.saveFit(title);
    const entry = { file: this.file, plan: this.planId, title, startedAt: this.startedAt?.toISOString(), at: new Date().toISOString(), ...result, fitPath: fit?.path || null, distanceKm: fit?.summary?.distanceKm ?? null };
    state.history.unshift(entry); // never capped: old rides stay the rider's (and sync keeps them all)
    if (this.planId) await markEntry(this.planId, this.file, result); else await api.saveState();
    const testResult = this.test ? await this.recordTest(title) : null;

    if (endAnim) { const wait = 650 - (performance.now() - animStart); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
    await this.showSummary({ title, completed, st, fit, entry, testResult, endAnim });
  }

  /**
   * Store the ride as a FIT file (for Garmin and export). The planned workout goes in as well: Garmin
   * names the activity after it (and forwards that name to Strava); the rename after the upload comes
   * too late for Strava. Resolves Rust's { path, garminPath, summary } or null (nothing recorded / error).
   */
  async saveFit(title) {
    if (!this.samples.length) return null;
    const F = ftp(), m = this.mult();
    const steps = this.w.segments.map((sg) => ({
      duration: Math.max(1, Math.round(sg.duration)),
      lo: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p0 * F * m),
      hi: sg.p0 == null || sg.erg === false ? null : Math.round(sg.p1 * F * m),
      kind: sg.type === 'warmup' ? 'warmup' : sg.type === 'cooldown' ? 'cooldown' : sg.type === 'off' ? 'rest' : null,
    }));
    return invoke('save_activity', { ride: { name: title, ftp: F, steps, samples: this.samples.map(({ wall, p, c, hr, v, seg }) => ({ wall, p, c, hr, v, seg })) } })
      .catch((e) => { toast(t('couldNotSaveRide', { e })); return null; });
  }

  /** FTP test: evaluate the tagged samples, keep new power bests, and add the result to state.tests (not applied yet). */
  async recordTest(title) {
    const testResult = this.test.protocol ? this.test.protocol.evaluate(this.samples) : evaluateGeneric(this.samples, this.w);
    if (!testResult) return null;
    const v = vo2max(testResult.vo2, weight());
    if (v) testResult.vo2est = v;
    const bests = { ...(state.settings.bests || {}) };
    for (const [k, val] of Object.entries(testResult.bests || {})) if (val && (!bests[k] || val > bests[k])) bests[k] = val;
    state.settings.bests = bests;
    state.tests = [{ at: new Date().toISOString(), protocol: this.test.protocol?.id || 'library', name: this.test.protocol?.name || title, ftp: testResult.ftp, incomplete: !!testResult.incomplete, prevFtp: ftp(), details: testResult.details, cp: testResult.cp ?? null, wPrime: testResult.wPrime ?? null, vo2: testResult.vo2est?.rel ?? null, vo2abs: testResult.vo2est?.abs ?? null, weight: weight(), accepted: false }, ...(state.tests || [])].slice(0, 200);
    await api.saveState();
    return testResult;
  }

  /**
   * The ride summary dialog: test result, stats, where the ride goes (Garmin, platforms, FIT file) and
   * the next plan workout. Automatic uploads start right away and update their row when done; for a
   * ride under SHORT_RIDE_S they wait until the rider answers the short-ride question.
   */
  async showSummary({ title, completed, st, fit, entry, testResult, endAnim }) {
    const [garmin, svcs] = fit ? await Promise.all([invoke('garmin_status').catch(() => ({})), refreshServices()]) : [{}, []];
    const autoGarmin = fit && garmin.connected && syncMode('garmin') === 'auto';
    const rideSvcs = svcs.filter((sv) => svcRoute(sv) && svcMode(sv) !== 'off');
    // automatic destinations: Garmin upload, platforms in auto mode, or opening Garmin's import page
    const autoSvcs = rideSvcs.filter((sv) => sv.connected && svcMode(sv) === 'auto');
    const autoImport = fit && !garmin.connected && !!state.settings.garmin?.autoOpen;
    const autoNames = [...(autoGarmin || autoImport ? ['Garmin Connect'] : []), ...autoSvcs.map((sv) => sv.name)];
    const hold = autoNames.length > 0 && (entry.doneDuration ?? 0) < SHORT_RIDE_S;
    const plan = this.planId && planById(this.planId);
    const next = plan && planProgress(plan).next;
    const heading = tHtml(this.test ? 'ftpTestResult' : completed ? 'workoutComplete' : 'workoutSaved');
    openModal(html`
      <div class="summary">
        <div class="eyebrow">${heading}</div>
        <h2>${title}</h2>
        ${this.test && summaryTest(testResult)}
        ${summaryStats(st, this.ridden)}
        ${hold && summaryShortRide(entry.doneDuration ?? 0, autoNames)}
        ${fit && summarySyncList({ garmin, autoGarmin, rideSvcs, hold })}
        ${plan && summaryNext(plan, next)}
        <div class="modal-actions">
          <button class="btn ${next ? 'ghost' : 'primary'}" data-act="home">${tHtml('done')}</button>
          ${next && html`<button class="btn primary" data-act="next">${tHtml('startNextNow')}</button>`}
        </div>
      </div>`, endAnim ? 'small sticky rise' : 'small sticky');
    const ftpEl = this.test && testResult?.ftp && motionOK() ? $('.ftp-result > div > b', modal) : null;
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
    const leave = () => { closeModal(); this.close(); };
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

  /** Leave the ride screen: expand from compact, release devices to idle, restore the normal views and pending updates.
   *  The teardown always runs, even when the window can't be restored to full size: a stuck ride screen with
   *  `ride` still set would keep sync and profile switching deferred. CompactView already reported the error. */
  async close() {
    let restored = false;
    try { restored = await this.compact.set(false); } catch (err) { toast(String(err)); }
    if (!restored) document.body.classList.remove('compact-riding');
    clearInterval(this.loop);
    this.ending = true;
    trainer.setFreeRide(); // release ERG (also on Discard, which skips finish())
    this.cObs?.disconnect();
    invoke('keep_awake', { on: false }).catch(() => {});
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    $('#ride').hidden = true;
    $('#ride').replaceChildren();
    $('#ride').classList.remove('paused');
    document.body.classList.remove('riding');
    $('#ride-title').hidden = true;
    $('#btn-compact').hidden = true;
    $('#ride-title').replaceChildren();
    setRide(null);
    route();
    if (updFound && updLater !== updFound.version) showUpdateCard();
  }
}

// Direction of the coming change for the countdown cue: 'up', 'down', or null for about the same
// (within 3 % FTP) or no fixed target (free ride). All-out efforts count as higher than any target.
function cueDir(cur, next) {
  const level = (x, end) => (x.erg === false || x.type === 'maxeffort' ? Infinity : x.p0 === null ? null : end ? x.p1 : x.p0);
  const a = level(cur, true), b = level(next, false);
  if (a === null || b === null || a === b) return null;
  return b - a > 0.03 ? 'up' : a - b > 0.03 ? 'down' : null;
}

// The ride screen: startRide() / startTest() open it, the Ride class runs the loop (tick → drive → render,
// 4× a second), records 1 Hz samples, handles keys, controller buttons and the compact view, and ends
// with finish() → finishRide() in ./summary.js (FIT file, history, ride summary). The coach line is painted
// by coach() from ./coach.js.
//
// Import cycles: with actions.js (openMenu, markEntry here; its actions start rides through startRide), with
// ./summary.js (finishRide here, startRide there), and through app.js (api, route) and the views, which
// start rides and tests from here. They are safe because nothing from those modules is used while this
// module is evaluated: only inside functions and methods that run after boot.
import { CompactView, compactMode, levelView, fitTexts } from '../compact.js';
import { powerAt, segmentAt } from '../zwo.js';
import { zoneOf, zoneColor, zoneInk, fmtTime, Diagram, CompactGraph, Gauge, ProgressRing, motionOK } from '../render.js';
import { invoke } from '../ble.js';
import { gearTable, virtualSpeed, targetWatts } from '../vshift.js';
import { protocolById, isTestWorkout, classifyTest, prepareTestWorkout } from '../tests.js';
import { t, pct } from '../i18n/index.js';
import { loadSounds, countdown } from '../sound.js';
import { html, tHtml, tText, mount } from '../html.js';
import { IC } from '../components/icons.js';
import { badge } from '../components/indicators.js';
import { segCtl, selectSeg } from '../components/buttons.js';
import {
  OS, $, $$, setText, setAttr, setHtml, SPEED, state, fresh, trainer, ctrls,
  shifting, bounds, ftp, maxHr, weight, planById, workoutInfo, setRide, pointerFocused, restartAnim,
  modal, confirmDialog, choiceDialog, announce, toast, rovingKey,
} from '../core.js';
import { api, route } from '../app.js';
import { openMenu, markEntry } from '../actions.js';
import { segmentText } from '../views/parts.js';
import { updFound, updLater, showUpdateCard } from '../updates.js';
import { coach } from './coach.js';
import { finishRide } from './summary.js';

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

const SEG_KIND = { steady: 'kindSteady', warmup: 'segWarmup', cooldown: 'segCooldown', ramp: 'segRamp', on: 'kindOn', off: 'kindOff', freeride: 'freeRide', maxeffort: 'maxEffort' };
/** Short label for the current segment type (warm-up, interval, ramp, free ride, all-out …). */
const segKind = (s) => `${t(s.erg === false ? 'kindAllOut' : SEG_KIND[s.type] || 'segment')}${s.reps ? ` ${s.rep}/${s.reps}` : ''}`;
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
      resize: (compact, leave = false) => invoke('ride_window', { compact, leave }),
      apply: (compact) => {
        document.body.classList.toggle('compact-riding', compact);
        this.cBar = undefined; // the native side reset the bar height: send it again if the layout needs it
        if (!compact) this.diagram.update(this.t, this.samples);
        else this.render(true); // paint the compact view (graph included) right away
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
    // compact view: controls and "workout left" exist in several places (heading row when short, footer, rail, graph header); CSS shows the right ones
    const cmpPlay = html`<button class="ctl play" data-act="play" title="${tText('start')} (${tText('spaceKey')})" aria-label="${tText('start')}" aria-keyshortcuts="Space"><svg viewBox="0 0 24 24" class="i-play" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg><svg viewBox="0 0 24 24" class="i-pause" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg></button>`;
    const cmpStop = html`<button class="ctl" data-act="stop" title="${tText('endWorkout')}" aria-label="${tText('endWorkout')}" aria-keyshortcuts="Escape"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg></button>`;
    const cmpCtl = html`<span class="compact-ctl">${cmpPlay}${cmpStop}</span>`;
    const cmpWl = html`<span class="cmp-wl"><small>${tHtml('compactWorkoutLeft')}</small><b class="cmp-wleft" data-fit="14">0:00</b></span>`;
    const cmpWlNum = html`<span class="cmp-wl" title="${tText('compactWorkoutLeft')}"><b class="cmp-wleft" data-fit="12">0:00</b></span>`;
    const cmpExpand = html`<button class="ctl" data-act="expand" title="${tText('expandView')}" aria-label="${tText('expandView')}" aria-keyshortcuts="C">${IC.expand}</button>`;
    const cmpLayout = html`<button class="ctl cmp-layout" data-act="layout" title="${tText('compactSwitchLayout')} (V)" aria-label="${tText('compactSwitchLayout')}" aria-keyshortcuts="V"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="6" rx="1.5"/></svg></button>`;
    const cmpGears = html`<div class="compact-gears cmp-gears" role="group" hidden><button class="icon-btn" data-shift="-1" title="${tText('shiftDownKey')}" aria-label="${tText('shiftDownKey')}">−</button><span class="cmp-gear-n"></span><button class="icon-btn" data-shift="1" title="${tText('shiftUpKey')}" aria-label="${tText('shiftUpKey')}">+</button></div>`;
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
      <section class="compact-ride" aria-label="${tText('compactView')}" data-tauri-drag-region>
        <header class="compact-head" data-tauri-drag-region>
          <span class="compact-state" id="cmp-state"><i id="cmp-dot"></i><span id="cmp-status" class="sr-only" role="status"></span></span>
          ${cmpGears}
          <span class="compact-short">${cmpWlNum}<span class="compact-ctl">${cmpPlay}</span></span>
          ${cmpLayout}${cmpExpand}
        </header>
        <div class="compact-main">
          <section class="cp cp-live" data-tauri-drag-region>
            <div class="cp-ph" data-tauri-drag-region><i></i>${tHtml('live')}</div>
            <div class="cp-body" data-tauri-drag-region>
              <div class="cp-cell"><div class="cp-dial"><div class="cp-mount" id="cmp-gauge"></div><div class="cp-center"><b id="cmp-pow" data-fit="16">–</b><small>W</small></div></div></div>
              <div class="cp-ex" data-tauri-drag-region>
                <div class="cp-tgt" id="cmp-target" data-fit="12">${IC.bolt}<span id="cmp-target-v">–</span></div>
                <div class="cp-tiles">
                  <div class="cp-tile" role="group" title="${tText('devHr')}" aria-label="${tText('devHr')}">${IC.heart}<b id="cmp-hr" data-fit="14">–</b></div>
                  <div class="cp-tile" role="group" title="${tText('cadence')}" aria-label="${tText('cadence')}">${IC.cad}<b id="cmp-cad" data-fit="14">–</b></div>
                </div>
              </div>
            </div>
          </section>
          <div class="cp-gap" data-tauri-drag-region></div>
          <section class="cp cp-graph" data-tauri-drag-region>
            <div class="cp-ph" data-tauri-drag-region><i></i>${tHtml('workout')}${cmpWl}</div>
            <div class="cp-body" data-tauri-drag-region><div class="cp-gslot" id="cmp-graph" role="img" aria-label="${tText('compactGraphAria')}"></div></div>
          </section>
        </div>
        <div class="compact-foot" data-tauri-drag-region>${cmpCtl}${cmpWl}</div>
        <div class="compact-rail" data-tauri-drag-region>
          <div class="rail-row" data-tauri-drag-region>${cmpCtl}</div>
          <div class="rail-row" data-tauri-drag-region>${cmpExpand}${cmpLayout}</div>
          <div class="rail-row" data-tauri-drag-region>${cmpGears}</div>
        </div>
      </section>
      <div class="ready" id="ready"><div><b>${tHtml('ready')}</b><span>${tHtml('readyText')}${trainer.connected && html` ${tHtml('readyPedal')}`}.</span></div>
        ${this.hasFree && html`<div class="vs-ask"><span class="k" id="vs-choice-l">${tHtml('freeRideSegments')}</span>${segCtl('vs-choice', [['gears', 'realGears'], ['easy', 'vgEasy'], ['medium', 'diff.medium'], ['hard', 'diff.hard']].map(([k, l]) => [k, tHtml(l)]), this.vs.on ? this.vs.difficulty : 'gears', { labelledBy: 'vs-choice-l' })}</div>`}</div>`);

    this.gauge = new Gauge($('.gauge-mount', r));
    this.ring = new ProgressRing($('.ring-mount', r));
    this.cGauge = new Gauge($('#cmp-gauge', r), { compact: true });
    this.cGraph = new CompactGraph($('#cmp-graph', r), this.w, { bounds: bounds() });
    const cmpEl = $('.compact-ride', r);
    const fitCompact = () => {
      // thresholds are window sizes (the ride screen fills the window in compact view)
      const m = compactMode(window.innerWidth, window.innerHeight);
      cmpEl.dataset.layout = m.layout;
      cmpEl.dataset.live = m.live;
      cmpEl.dataset.foot = m.foot;
      cmpEl.dataset.graph = m.graph ? '1' : '0';
      cmpEl.dataset.tiles = m.tiles ? '1' : '0';
      this.cGraph.setOrientation(m.layout);
      fitTexts(cmpEl);
      // the wide bar is held to a window height of 195-200 px, the tall layout is not (the native side resets this on entering / leaving compact)
      if (this.compact.active) {
        const bar = m.layout === 'h';
        if (bar !== this.cBar) { this.cBar = bar; invoke('ride_window_bar', { bar }).catch(() => {}); }
      }
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
      case 'layout': return this.switchLayout();
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
    // C toggles the compact presentation; leave Ctrl/Cmd/Alt combinations alone (copy, …)
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return this.compact.set(!this.compact.active); }
    // V switches the compact window between the wide bar and the tall column
    if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return this.switchLayout(); }
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
    this.cGraph.setWorkout(this.w);
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
    coach(this, f.s, f);
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

  /** NEXT SEGMENT card of the full view (the compact view shows the next segment on its graph instead). Returns the card. */
  renderNext({ n, F }) {
    const card = this.q('next-card');
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
      body = html`<div class="nc-txt"><b>${big}</b><span class="nc-v">${watts}</span><span class="nc-v">${fmtTime(n.duration)} min</span>${rpm && html`<span class="nc-v nc-rpm">${rpm}</span>`}</div>`;
    } else {
      // last segment: "Finish strong", or after a failed ramp test the result hint
      const note = this.cooling ? tHtml('pressStopResult') : tHtml('noMoreChanges');
      body = html`<div class="nc-txt"><b>${tHtml(this.cooling ? 'testDone' : 'finishStrong')}</b><span class="nc-v muted">${note}</span></div>`;
    }
    card.style.setProperty('--zc', zc);
    card.title = title;
    mount(card, body);
    return card;
  }

  /**
   * Compact panels: same values as the full view (actual target, never a test-estimated FTP). Both presentations
   * share the same samples and Ride; no DOM is rebuilt on resize. Runs after the full view, whose target, bar and
   * "workout left" it copies.
   */
  renderCompact({ s, n, F, rem, freeLike, p, c, hr, gt, cadState, live }) {
    this.cGauge.update({ target: gt, actual: p, ftp: F, bounds: bounds() });
    setText(this.q('cmp-pow'), p ?? '–');
    // target line: the real target (virtual shifting included), a ramp's range, or the free / all-out words
    const m = this.mult(), lv = levelView(s, m, F);
    const word = (v) => (v.kind === 'range' ? `${v.a}–${v.b} W` : v.kind === 'watts' ? `${v.a} W`
      : t(v.kind === 'allout' ? 'gAllOut' : v.kind === 'maxeffort' ? 'maxEffort' : 'gFree'));
    const targetText = lv.kind !== 'range' && gt != null ? `${gt} W` : word(lv);
    setText(this.q('cmp-target-v'), targetText);
    if (this.compact.active) {
      // the workout graph: now (this segment) and next, from the same values as the target line
      const time = fmtTime(Math.max(0, Math.ceil(rem))), nxt = n && word(levelView(n, m, F));
      this.cGraph.update(this.t, {
        nowKicker: t('compactNow'), now: [`${t('compactNow')} ${targetText}`, targetText], nowSub: t('compactLeft', { time }),
        nextKicker: t('compactNext'), nextWatts: nxt, nextSub: n ? `${t('compactIn')} ${time}` : null,
        next: n ? [`${t('compactNext')} ${nxt} · ${t('compactIn')} ${time}`, `${t('compactNext')} ${nxt}`] : null,
      });
    }
    const ink = zoneInk(gt != null ? gt / F : null, bounds());
    if (this.cmpInk !== ink) { this.cmpInk = ink; this.q('cmp-target').style.color = ink; }
    setText(this.q('cmp-hr'), hr ?? '–');
    setText(this.q('cmp-cad'), c != null ? Math.round(c) : '–');
    this.q('cmp-cad').classList.toggle('off-target', live && cadState === 'bad');
    this.qsa('.cmp-wleft').forEach((el) => { setText(el, this.q('d-rem').textContent); });
    this.qsa('.cmp-gears').forEach((el) => { el.hidden = !freeLike; });
    this.qsa('.cmp-gears').forEach((el) => { setAttr(el, 'aria-label', t('gearN', { n: this.gear + 1 })); setAttr(el, 'title', t('gearN', { n: this.gear + 1 })); });
    this.qsa('.cmp-gear-n').forEach((el) => { setText(el, String(this.gear + 1)); });
    const status = this.autoPaused ? t('compactAutoPaused') : this.running ? t('running') : this.started ? t('paused') : t('ready');
    if (this.q('cmp-status').textContent !== status) setText(this.q('cmp-status'), status);
    const connection = trainer.connected ? trainer.mode === 'sim' ? t('simulator') : t('connectedCap') : t('noTrainer');
    const statusDetail = this.autoPaused ? t('autoPaused') : status;
    this.q('cmp-state').title = `${statusDetail} · ${connection}`;
    this.q('cmp-state').setAttribute('aria-label', `${statusDetail} · ${connection}`);
    this.q('cmp-dot').classList.toggle('on', trainer.connected);
    // long values shrink to fit (see fitTexts); only when one of them changed its length, never every tick
    const fitKey = [targetText, String(p ?? '–').length, String(hr ?? '–').length, String(c != null ? Math.round(c) : '–').length, this.q('d-rem').textContent.length].join('|');
    if (fitKey !== this.cmpFitKey) { this.cmpFitKey = fitKey; fitTexts(this.qs('.compact-ride')); }
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
   * Flip the compact window between the wide bar and the tall column, each at the size it had last (defaults 960 × 195
   * and 300 × 640). The two layouts' window limits never overlap (bar: 195 px high, from 640 wide; column: 240–320
   * wide), so this button / the V key is the way from one to the other: the limits are set first, then the size.
   */
  async switchLayout() {
    if (!this.compact.active) return;
    const from = compactMode(window.innerWidth, window.innerHeight).layout, bar = from === 'v';
    (this.cSizes ??= {})[from] = [window.innerWidth, window.innerHeight];
    const [width, height] = this.cSizes[bar ? 'h' : 'v'] || (bar ? [960, 195] : [300, 640]);
    try {
      this.cBar = bar; // fitCompact need not announce the new layout again
      await invoke('ride_window_bar', { bar });
      await invoke('ride_window_size', { width, height });
    } catch (err) { toast(String(err)); }
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

  /** End of the ride: save the FIT file, add to history and plan, evaluate FTP tests, show the summary, upload to Garmin and services (finishRide() in summary.js). */
  finish(completed) { return finishRide(this, completed); }

  /** Leave the ride screen: expand from compact, release devices to idle, restore the normal views and pending updates.
   *  The teardown always runs, even when the window can't be restored to full size: a stuck ride screen with
   *  `ride` still set would keep sync and profile switching deferred. `CompactView.leave()` retries the restore
   *  once and otherwise at least resets the minimum window size (it reports the error itself). */
  async close() {
    try { await this.compact.leave(); } catch (err) { toast(String(err)); }
    document.body.classList.remove('compact-riding');
    clearInterval(this.loop);
    this.ending = true;
    trainer.setFreeRide(); // release ERG (also on Discard, which skips finish())
    this.cObs?.disconnect();
    this.cGraph?.destroy();
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

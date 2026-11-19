// The coach line under the Current segment stats (ride screen): one short message at a time, picked
// from the workout's text events, pacing, cadence and hard-segment cues. Called by Ride.render() once per
// tick with the ride and its frame(); its state lives on the ride (`ride.cz`), so it ends with the ride.
// Imports only leaf modules and core.js (no cycle).
import { zoneOf, zoneInk, fmtTime } from '../render.js';
import { t } from '../i18n/index.js';
import { html, mount } from '../html.js';
import { IC } from '../components/icons.js';
import { state, trainer, bounds } from '../core.js';

export { coach };

/**
 * Coach line under the Current segment stats: one short message at a time, empty otherwise.
 * Priority: the workout's own text events > pacing (test "too fast", ERG power fading) >
 * cadence more than 5 rpm off for 5 s (clears after 3 s back on target) > hard-segment cues
 * (Z4 and up, all-out, max effort: start, halfway, last 30 s). A message stays at least 4 s
 * unless a more important one replaces it. Automatic hints can be switched off (Settings → App).
 */
function coach(ride, s, { segChanged, inSeg, rem, allOut, freeLike, gt, p, c, cLo, cHi, dev, cadState, paceFast }) {
  const el = ride.q('coach');
  if (!el) return;
  const now = performance.now() / 1000;
  const k = (ride.cz ||= { cadOff: null, cadOn: null, cadShown: false, powLow: null, cur: null, since: 0 });
  if (segChanged) Object.assign(k, { cadOff: null, cadOn: null, cadShown: false, powLow: null });
  const auto = ride.running && state.settings.coachHints !== false;
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
    const af = s.p0 === null ? null : ((s.p0 + s.p1) / 2) * ride.mult(), zone = zoneOf(af, bounds());
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

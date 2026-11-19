// Devices: auto-connect of the rider's saved trainer, heart-rate strap and controllers (connectSaved,
// autoConnect), the handlers for device, sensor, button and battery events from Rust (setDev, onSensor,
// onButton, setBattery), the top-bar devices button and its popover (state, battery, Change / Connect,
// Retry auto-connect), and the trainer / heart-rate and controller dialogs with the button tester.
// BUTTON_ACTIONS maps controller buttons to ride actions.
//
// Import cycles with app.js (api; app.js wires the events and the top-bar button to this module) and
// through actions.js (bindActions, popoverOpen). Safe because nothing from those modules is used while this
// module is evaluated, only inside functions that run after boot.
import { motionOK } from './render.js';
import { batteryBadge, lowestLevel } from './battery.js';
import { t, pct } from './i18n/index.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import {
  PLAT, $, $$, state, live, trainer, hrm, ctrls, ride, restartAnim, modal, openModal, closeModal, toast,
} from './core.js';
import { api } from './app.js';
import { bindActions, popoverOpen } from './actions.js';

export { autoConnect, onButton, onSensor, setBattery, setDev, devicesTitle, devicesMenu };

// kinds with a connection attempt from connectSaved() still running (hides "Retry auto-connect" meanwhile)
const connectingKinds = new Set();

/** Saved devices of the active profile that aren't connected, as [kind, ids]; with several controllers only the missing ones. */
function offlineSaved() {
  const devs = state.settings.devices || {};
  const out = [];
  for (const [kind, dev] of [['trainer', trainer], ['hr', hrm]]) {
    if (devs[kind]?.id && !dev.connected && dev.mode !== 'sim') out.push([kind, [devs[kind].id]]);
  }
  const missing = (devs.controllers || []).filter((c) => !ctrls.ids.includes(c.id)).map((c) => c.id);
  if (missing.length) out.push(['controller', missing]);
  return out;
}

/** What "Retry auto-connect" would try: offline saved devices without an attempt running (ours, or Rust's own reconnect). */
function retryable() {
  return offlineSaved().filter(([kind]) => !connectingKinds.has(kind) && !sensorDevice(kind)?.reconnecting);
}

const sensorDevice = (kind) => (kind === 'trainer' ? trainer : kind === 'hr' ? hrm : null);

/** Connect saved devices silently (they may be switched off); a failure only resets the status. */
function connectSaved(list) {
  const devs = state.settings.devices || {};
  for (const [kind, ids] of list) {
    connectingKinds.add(kind);
    let job;
    if (kind === 'controller') {
      if (!ctrls.connected) setDev('controller', { reconnecting: true, name: (devs.controllers || []).map((c) => c.name).join(' + ') });
      job = Promise.allSettled(ids.map((id) => ctrls.connect(id))).then((r) => { if (!ctrls.connected && !r.some((x) => x.status === 'fulfilled')) setDev('controller', { connected: false }); });
    } else {
      setDev(kind, { reconnecting: true, name: devs[kind]?.name });
      job = sensorDevice(kind).connect(ids[0]).catch(() => setDev(kind, { connected: false }));
    }
    job.finally(() => { connectingKinds.delete(kind); refreshDevicesMenu(); });
  }
  refreshDevicesMenu();
}

/** Reconnect the devices saved in the active profile (at launch and after switching riders). */
function autoConnect() { connectSaved(offlineSaved()); }

/** Controller button → [workout action, dictionary key of its description] (Zwift Ride / Play / Click, OpenBikeControl). */
const BUTTON_ACTIONS = {
  shiftUp: ['gear+', 'btnShiftUp'],
  shiftDown: ['gear-', 'btnShiftDown'],
  up: ['int+', 'btnIntUp'],
  down: ['int-', 'btnIntDown'],
  right: ['next', 'btnNext'],
  left: ['prev', 'btnPrev'],
  a: ['play', 'btnPlay'],
  powerup: ['play', 'btnPlay'],
  z: ['pct', 'btnPct'],
  y: ['play', 'btnPlay'],
  b: [null, 'btnNone'],
  onoff: [null, 'btnOnOff'],
};
const BUTTON_LABEL = { shiftUp: 'Shift +', shiftDown: 'Shift −', up: '▲', down: '▼', left: '◀', right: '▶', a: 'A', b: 'B', y: 'Y', z: 'Z', powerup: 'Power-up', onoff: 'On/Off' };
let buttonTester = null;

/** `erg`: OpenBikeControl's pick for ERG segments when one press sent several ids (difficulty before shift). */
function onButton(button, device, erg) {
  if (erg && ride && !ride.freeLike) button = erg;
  buttonTester?.(button, device);
  const action = BUTTON_ACTIONS[button]?.[0];
  if (ride && action) ride.button(action);
}

function onSensor(d) {
  const now = Date.now();
  for (const k of ['power', 'cadence', 'speed', 'hr']) if (d[k] !== undefined) { live[k] = d[k]; live.at[k] = now; }
}

// ------------------------------------------------------------------ devices menu (one top-bar button)
const DEVICE_KINDS = [
  ['trainer', 'devTrainer', '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>'],
  ['hr', 'devHr', '<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>'],
  ['controller', 'devShifter', '<svg viewBox="0 0 24 24"><path d="M8 3v18M8 3 4 7M8 3l4 4M16 21V3M16 21l-4-4M16 21l4-4"/></svg>'],
];
const devState = { trainer: {}, hr: {}, controller: {} };
// battery levels per kind and device id (controllers can be several); only shown in the devices popover
const battery = { trainer: {}, hr: {}, controller: {} };

function setBattery(e) {
  if (!battery[e.kind]) return;
  battery[e.kind][e.id] = e.level;
  refreshDevicesMenu();
}

function refreshDevicesMenu() {
  const pop = $('#popover.dev-pop');
  if (pop) renderDevicesMenu(pop);
}

function setDev(kind, s) {
  const was = devState[kind] || {};
  devState[kind] = { connected: !!s.connected, reconnecting: !!s.reconnecting, name: s.name || '' };
  // a device that is gone has no battery; with several controllers keep only the ones still connected
  if (!s.connected) battery[kind] = {};
  else if (kind === 'controller' && s.ids) battery[kind] = Object.fromEntries(Object.entries(battery[kind]).filter(([id]) => s.ids.includes(id)));
  const dot = $(`#btn-devices .dev-dots i[data-k="${kind}"]`);
  dot.className = s.connected ? 'on' : s.reconnecting ? 'warn' : '';
  if (motionOK() && s.connected && !was.connected) restartAnim(dot, 'pop');
  if (motionOK() && was.connected && !s.connected) restartAnim(dot, 'drop');
  devicesTitle();
  refreshDevicesMenu();
}

function devicesTitle() {
  const on = Object.values(devState).filter((d) => d.connected).length;
  const btn = $('#btn-devices'), label = on ? t('devicesOn', { n: on }) : t('devicesNone');
  btn.title = label;
  btn.setAttribute('aria-label', label);   // the dots are aria-hidden, so the label carries the state
}

/** Content of the devices popover: one row per device kind (state, battery, Change / Connect), then "Retry auto-connect" when saved devices are missing. */
function renderDevicesMenu(pop) {
  const saved = state.settings.devices || {};
  const row = ([k, label, icon]) => {
    const d = devState[k];
    const level = d.connected ? lowestLevel(battery[k]) : null;
    const batt = raw(batteryBadge(level, t('batteryPct', { n: level }), pct));
    const savedName = k === 'controller' ? (saved.controllers || []).map((c) => c.name).join(' + ') : saved[k]?.name;
    const status = d.connected ? html`<span class="ok-text">${d.name || tHtml('connected')}</span>`
      : d.reconnecting ? html`<span class="warn-text">${d.name ? tHtml('connectingName', { name: d.name }) : tHtml('connectingDots')}</span>`
        : html`<span class="muted">${savedName ? tHtml('savedOff', { name: savedName }) : tHtml('notPaired')}</span>`;
    return html`<button class="dev-row" data-dev="${k}"><span class="dev-ico ${d.connected ? 'on' : d.reconnecting ? 'warn' : ''}">${raw(icon)}</span><span class="dev-txt"><span class="dev-head"><b>${tHtml(label)}</b>${batt}</span>${status}</span><span class="dev-act">${tHtml(d.connected ? 'change' : 'connect')}</span></button>`;
  };
  const retry = retryable().length > 0 && html`<hr><button class="dev-retry" data-retry title="${tText('retryConnectTitle')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5"/></svg>${tHtml('retryConnect')}</button>`;
  mount(pop, html`<div class="pop-title">${tHtml('devices')}</div>${DEVICE_KINDS.map(row)}${retry}`);
}

function devicesMenu(anchor) {
  if ($('#popover.dev-pop')) return $('#popover').remove();
  $('#popover')?.remove();
  const pop = document.createElement('div');
  pop.id = 'popover';
  pop.className = 'popover dev-pop';
  renderDevicesMenu(pop);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`;
  const close = popoverOpen(pop, anchor);
  pop.onclick = (e) => {
    // retry keeps the popover open, so the rows show "Connecting…" and then the result
    if (e.target.closest('[data-retry]')) return connectSaved(retryable());
    const b = e.target.closest('[data-dev]');
    if (b) { close(); deviceDialog(b.dataset.dev); }
  };
}

/** Controller dialog: scan / connect Zwift Ride, Click, Play and OpenBikeControl devices, and the button tester. */
async function controllerDialog() {
  const connected = await ctrls.list();
  const saved = state.settings.devices?.controllers || [];
  openModal(html`<h2>${tHtml('shifterTitle')}</h2>
    <p class="muted">${tHtml('shifterIntro')}</p>
    ${connected.length > 0 && html`<div class="dev-list">${connected.map((c) => html`<div class="dev on"><span>${c.name}</span><small class="ok-text">${tHtml('connected')}</small></div>`)}</div>
    <div class="btn-test" id="btn-test"><span class="k">${tHtml('buttonTest')}</span><b id="bt-last">${tHtml('pressButton')}</b><small class="muted" id="bt-raw"></small></div>
    <table class="btn-map small">${Object.entries(BUTTON_ACTIONS).filter(([, [a]]) => a).map(([k, [, l]]) => html`<tr data-btn="${k}"><td><kbd>${BUTTON_LABEL[k]}</kbd></td><td>${tHtml(l)}</td></tr>`)}</table>`}
    <div class="dev-list" id="dev-list">${scanningLine(tHtml('searchingCtrl'))}</div>
    <ul class="tips small muted">
      <li>${tHtml('tipRide')}</li>
      <li>${tHtml('tipClick')}</li>
      <li>${tHtml('tipObc')}</li>
      <li>${tHtml('tipCloseZwift')}</li>
    </ul>
    <div class="modal-actions">${connected.length > 0 && html`<button class="btn ghost" data-act="disc">${tHtml('disconnectAll')}</button>`}<button class="btn ghost" data-act="rescan">${tHtml('searchAgain')}</button><button class="btn ghost" data-act="close">${tHtml('close')}</button></div>`, 'small');
  const list = $('#dev-list', modal);
  if (connected.length) {
    // button tester: shows the last button (and the raw message count) while the dialog is open
    let rawCount = 0;
    const onRaw = (e) => { const el = $('#bt-raw', modal); if (el) el.textContent = t('rawMessages', { n: ++rawCount, hex: e.hex.slice(0, 24) }); };
    ctrls.handlers.raw = [onRaw];
    buttonTester = (button, device) => {
      const el = $('#bt-last', modal);
      if (!el?.isConnected) { buttonTester = null; return; }
      el.textContent = `${BUTTON_LABEL[button] || button} · ${device}`;
      $$('.btn-map tr', modal).forEach((r) => r.classList.toggle('hit', r.dataset.btn === button));
    };
  }
  const search = async () => {
    mount(list, scanningLine(tHtml('searchingCtrl')));
    try {
      const found = await ctrls.scan(5);
      if (!list.isConnected) return;
      mount(list, foundDevices(found, (f) => saved.some((x) => x.id === f.id), tHtml('noController')));
    } catch (e) { mount(list, html`<p class="danger-text">${String(e)}</p>`); }
  };
  list.onclick = async (e) => {
    const b = e.target.closest('.dev[data-id]');
    if (!b) return;
    mount(b, html`<span><span class="spinner"></span> ${tHtml('connectingTo', { name: b.dataset.name })}</span>`);
    try {
      const info = await ctrls.connect(b.dataset.id);
      const devs = (state.settings.devices ||= {});
      devs.controllers = [...(devs.controllers || []).filter((c) => c.id !== b.dataset.id), { id: b.dataset.id, name: info.name }];
      await api.saveState();
      toast(t('ctrlConnected', { name: info.name }));
      controllerDialog();
    } catch (err) { mount(b, html`<span class="danger-text">${tHtml('failedE', { e: String(err) })}</span>`); }
  };
  bindActions(modal, {
    rescan: search,
    disc: async () => {
      await ctrls.disconnect();
      if (state.settings.devices) state.settings.devices.controllers = [];
      await api.saveState();
      closeModal();
    },
  });
  search();
}

/** "Searching …" line with a spinner, shown in a device list while scanning or connecting. */
const scanningLine = (text) => html`<div class="scanning"><span class="spinner"></span>${text}</div>`;

/** Scan results as buttons (name, "last used", signal strength), or `empty` when nothing was found. */
const foundDevices = (found, lastUsed, empty) => (found.length
  ? html`${found.map((f) => html`<button class="dev" data-id="${f.id}" data-name="${f.name}"><span>${f.name}${lastUsed(f) && html` <small class="muted">· ${tHtml('lastUsed')}</small>`}</span><small class="muted">${f.rssi != null && `${f.rssi} dBm`}</small></button>`)}`
  : html`<p class="muted">${empty}</p>`);

/** Trainer or heart-rate dialog: the connected device (disconnect / forget), or scan, pick one, or use the simulator. */
function deviceDialog(kind) {
  if (kind === 'controller') return controllerDialog();
  const dev = kind === 'trainer' ? trainer : hrm;
  const label = tHtml(kind === 'trainer' ? 'devTrainer' : 'hrMonitor');
  const saved = state.settings.devices?.[kind];
  // every button closes the dialog first, then acts
  const leave = (fn) => async () => { closeModal(); await fn(); };
  const common = {
    disc: leave(() => dev.disconnect()),
    sim: leave(() => dev.startSim()),
    forget: leave(async () => {
      await dev.disconnect();
      if (state.settings.devices) delete state.settings.devices[kind];
      await api.saveState();
    }),
  };
  if (dev.connected || dev.reconnecting) {
    const erg = kind === 'trainer' && dev.connected && html` · ${tHtml(trainer.canErg ? (trainer.ergDenied ? 'ergActiveDenied' : 'ergActive') : 'powerOnlyNoErg')}`;
    openModal(html`<h2>${label}</h2><p>${tHtml(dev.reconnecting ? 'reconnectingTo' : 'connectedTo', { name: html`<b>${dev.name}</b>` })}${erg}.</p>
      <div class="modal-actions"><button class="btn ghost" data-act="forget">${tHtml('forgetDevice')}</button><button class="btn ghost" data-act="close">${tHtml('close')}</button><button class="btn danger" data-act="disc">${tHtml('disconnect')}</button></div>`, 'small');
    bindActions(modal, common);
    return;
  }
  openModal(html`<h2>${label}</h2>
    <p class="muted">${tHtml(kind === 'trainer' ? 'trainerIntro' : 'hrIntro')}</p>
    <div class="dev-list" id="dev-list">${scanningLine(tHtml('searching'))}</div>
    <div class="modal-actions"><button class="btn ghost" data-act="sim">${tHtml('useSimulator')}</button><button class="btn ghost" data-act="rescan">${tHtml('searchAgain')}</button><button class="btn ghost" data-act="close">${tHtml('close')}</button></div>`, 'small');
  const list = $('#dev-list', modal);
  const search = async () => {
    mount(list, scanningLine(tHtml('searching')));
    try {
      const found = await dev.scan(4);
      if (!modal.open || !list.isConnected) return;
      mount(list, foundDevices(found, (f) => saved?.id === f.id, tHtml('nothingFound')));
    } catch (e) {
      mount(list, html`<p class="danger-text">${String(e)}</p><p class="muted small">${raw(PLAT.bt)}</p>`);
    }
  };
  list.onclick = async (e) => {
    const b = e.target.closest('.dev');
    if (!b) return;
    mount(list, scanningLine(tHtml('connectingTo', { name: b.dataset.name })));
    try {
      const info = await dev.connect(b.dataset.id);
      state.settings.devices = { ...(state.settings.devices || {}), [kind]: { id: b.dataset.id, name: info.name } };
      await api.saveState();
      closeModal();
      if (kind === 'trainer' && info.ergDenied) toast(t('ergDenied'));
      else toast(`${t('nameConnected', { name: info.name })}${kind === 'trainer' ? ` · ${info.erg ? t('ergReady') : t('powerOnly')}` : ''}`);
    } catch (err) {
      mount(list, html`<p class="danger-text">${tHtml('connectionFailed', { e: String(err) })}</p>`);
    }
  };
  bindActions(modal, { ...common, rescan: search });
  search();
}

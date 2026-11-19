// Settings dialog: openSettings() with one markup function per tab (settingsRiderTab, settingsRidingTab,
// settingsSyncTab, settingsAppTab), bindSettingsFields() for inputs, checkboxes and segmented controls
// (FIELDS: number fields and where their valid value goes) and settingsActions() for the buttons.
// Every control saves at once; the views redraw once when the dialog ends.
//
// Import cycle with app.js (app.js opens Settings; this module calls app-level helpers such as route(),
// applyTheme() and the sync / service functions). Safe because nothing from app.js is used while this
// module is evaluated, only inside functions that run after boot.
import { ZONES } from './render.js';
import { invoke } from './ble.js';
import { t, LOCALES, systemLocale, coerceLocale, fmtLocale } from './i18n/index.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import { IC } from './components/icons.js';
import { dialogHead } from './components/dialog.js';
import { segRow, selectSeg } from './components/buttons.js';
import {
  PLAT, $, $$, library, state, setState, ride, trainer, shifting, ftp, maxHr, weight,
  modal, onDialogEnd, openModal, closeModal, confirmDialog, toast,
} from './core.js';
import {
  api, route, bindActions, openExternal, applyTheme, applyLanguage, renderProfileChip, THEME_LABEL, devicesMenu,
  pickDir, loadLibrary, refreshServices, svcCache, setSvcCache, svcMode, syncMode, SVC_LOGO,
} from './app.js';
import { syncOn, syncCfg, setSyncCfg, agoText, syncLabel, runSync } from './sync.js';
import { updPrefs, setUpdPrefs, checkUpdate } from './updates.js';

export { openSettings };

// ------------------------------------------------------------------ settings

const MODES = [['off', 'off'], ['manual', 'manual'], ['auto', 'automatic']];
const modeSelect = (name, cur) => segRow(`mode-${name}`, tHtml('upload'), MODES.map(([k, l]) => [k, tHtml(l)]), cur, 'sync-mode');

const fmtNum = (n) => n.toLocaleString(fmtLocale());

/** Language of the UI right now: the rider's choice, else the system language. */
const uiLang = () => coerceLocale(state.settings.language) || systemLocale();

/** Hint under a platform in Settings: our own text when we have one, else what Rust sent. */
const svcHint = (sv) => (t(`svcHint.${sv.id}`) !== `svcHint.${sv.id}` ? tHtml(`svcHint.${sv.id}`) : sv.hint);

// set by Settings while open; the views redraw once when the dialog closes
let settingsDirty = false;

// ---- Settings: small markup builders shared by the tabs ------------------------------------------

/** Number field: label · input · unit, plus the (hidden) error line it points to. `attrs` is trusted (min/max/step). */
const numField = (name, label, value, attrs, unit = '') => html`<label for="set-${name}">${label} <span><input type="number" id="set-${name}" name="${name}" value="${value ?? ''}" ${raw(attrs)} aria-describedby="err-${name}">${unit && html` ${unit}`}</span></label><p class="field-err" id="err-${name}" hidden></p>`;
/** Checkbox row (`cls: 'sub'` indents it under the option it depends on). */
const checkField = (name, on, label, cls = '') => html`<label class="check ${cls}"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;

const SETTINGS_TABS = [['rider', 'tabRider'], ['riding', 'tabRiding'], ['sync', 'tabConnections'], ['app', 'tabApp']];
/** One tab panel; only the current tab is visible. */
const tabPane = (key, cur, body) => html`<div class="tab-pane" role="tabpanel" id="pane-${key}" aria-labelledby="tab-${key}" data-pane="${key}" ${key === cur ? '' : raw('hidden')}>${body}</div>`;

/** Rider: FTP, max HR, weight, personal bests, zone limits. */
function settingsRiderTab(s) {
  return html`
      <div class="form">
        ${numField('ftp', 'FTP', s.ftp, 'min="50" max="600"', 'W')}
        ${numField('maxHr', tHtml('maxHr'), s.maxHr, 'min="100" max="230"', 'bpm')}
        ${numField('weight', tHtml('weight'), s.weight, 'min="30" max="200" step="0.1"', 'kg')}
      </div>
      <h3>${tHtml('personalBests')} <small class="muted">${tHtml('personalBestsHint')}</small></h3>
      <div class="form">${[['s5', '5 s'], ['m1', '1 min'], ['m5', '5 min'], ['m20', '20 min']].map(([k, l]) => numField(`b_${k}`, l, s.bests?.[k], 'min="1" max="3000"', 'W'))}</div>
      <h3>${tHtml('trainingZones')} <small class="muted">${tHtml('trainingZonesHint')}</small></h3>
      <div class="zone-form" id="zone-form">
        ${ZONES.map((z, i) => html`<div class="zf"><i style="background:${z.color}"></i><span>${z.short} ${z.name}</span>
          ${i < 4
            ? html`<span>≤ <input type="number" name="z${i}" value="${s.zones[i]}" min="30" max="200" aria-label="${tText('zoneLimitAria', { zone: `${z.short} ${z.name}` })}" aria-describedby="err-zones"> %</span>`
            : html`<span>&gt; <b class="z5-lim" id="z5-lim">${s.zones[3]}</b> %</span>`}</div>`)}
        <p class="field-err" id="err-zones" hidden></p>
      </div>`;
}

/** Riding: sounds, ride behaviour, virtual shifting (gear tuning under Advanced). */
function settingsRidingTab(s, sh) {
  return html`
      <h3>${tHtml('grpSounds')}</h3>
      <div class="form">
        ${checkField('beeps', s.beeps, tHtml('optBeeps'))}
        ${checkField('beepDirection', s.beepDirection !== false, tHtml('optBeepDirection'), 'sub')}
        ${checkField('endChime', s.endChime !== false, tHtml('optEndChime'))}
      </div>
      <h3>${tHtml('grpDuringRide')}</h3>
      <div class="form">
        ${checkField('autoPause', s.autoPause !== false, tHtml('optAutoPause'))}
        ${checkField('coachHints', s.coachHints !== false, tHtml('optCoach'))}
        ${checkField('keyboardShortcuts', s.keyboardShortcuts !== false, tHtml('optKeys'))}
      </div>
      <h3>${tHtml('virtualShifting')} <small class="muted">${tHtml('virtualShiftingHint')}</small></h3>
      <div class="form">
        ${segRow('vs-mode', tHtml('vsDefault'), [['ask', tHtml('vsAsk')], ['gears', tHtml('realGears')], ['virtual', tHtml('virtualGears')]], sh.mode)}
        <p class="muted small hint" id="vs-mode-hint">${tHtml(`vsHint.${sh.mode}`)}</p>
        ${segRow('vs-diff', tHtml('difficulty'), ['easy', 'medium', 'hard'].map((k) => [k, tHtml(`diff.${k}`)]), sh.difficulty)}
        <p class="muted small hint">${tHtml('difficultyHint')}</p>
      </div>
      <details class="adv">
        <summary>${tHtml('advanced')}</summary>
        <div class="form">
          <label for="set-vsMin">${tHtml('gearRange')} <span><input type="number" id="set-vsMin" name="vsMin" value="${sh.minRatio}" min="0.4" max="2" step="0.05" aria-label="${tText('gearRangeMin')}" aria-describedby="err-vsMin"> – <input type="number" name="vsMax" value="${sh.maxRatio}" min="2.5" max="7" step="0.05" aria-label="${tText('gearRangeMax')}" aria-describedby="err-vsMax"></span></label>
          <p class="field-err" id="err-vsMin" hidden></p><p class="field-err" id="err-vsMax" hidden></p>
          <p class="muted small hint">${tHtml('gearRangeHint', { n: sh.gears })}</p>
          ${numField('vsStart', tHtml('startGear'), sh.startGear, `min="1" max="${sh.gears}"`, tHtml('ofN', { n: sh.gears }))}
        </div>
      </details>`;
}

const SYNC_ICON = raw('<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/></svg>');

/** One platform card (Intervals.icu, COROS): status, connect / disconnect, upload mode or import button. */
function serviceCard(sv) {
  const mode = svcMode(sv);
  const status = sv.connected ? (sv.account ? tHtml('connectedAs', { name: sv.account }) : tHtml('connectedCap')) : tHtml(sv.kind === 'manual' ? 'manualImport' : 'notConnected');
  const keyLabel = tText('apiKeyPlaceholder', { name: sv.name });
  const body = sv.connected ? modeSelect(`svc-${sv.id}`, mode)
    : sv.kind === 'apikey' ? html`<div class="cred"><input type="password" name="key-${sv.id}" placeholder="${keyLabel}" aria-label="${keyLabel}" autocomplete="off"><button class="btn primary sm" data-act="svc-key" data-id="${sv.id}">${tHtml('connect')}</button></div>
      <p class="muted small">${svcHint(sv)} <a href="#" class="link" data-act="svc-getkey">${tHtml('openIntervalsSettings')}</a></p>`
      : sv.manualUrl ? html`${segRow(`mode-svc-${sv.id}`, tHtml('afterRide'), [['off', tHtml('off')], ['manual', tHtml('showImportButton')]], mode, 'sync-mode')}<p class="muted small">${svcHint(sv)}</p>`
        : null;
  return html`<div class="svc svc-ext ${sv.connected ? 'on' : ''}"><div class="svc-head"><span class="svc-logo ext">${SVC_LOGO[sv.id] || sv.name[0]}</span><div><b>${sv.name}</b><small class="muted">${status}</small></div>${sv.connected && html`<button class="btn ghost sm" data-act="svc-off" data-id="${sv.id}">${tHtml('disconnect')}</button>`}</div>${body}</div>`;
}

/** Connections: profile sync folder, Garmin Connect, other platforms. */
function settingsSyncTab(s, { garmin, targets, svcs }) {
  const sp = syncOn() ? syncCfg.provider : 'off';
  const where = PLAT.onThisMachine;
  const syncRow = (id, label, path, found, extra = null) => html`<label class="sync-opt ${found ? '' : 'na'}"><input type="radio" name="syncp" value="${id}" ${sp === id ? 'checked' : ''} ${found ? '' : 'disabled'}><span><b>${label}</b><small class="muted">${extra || (path ? path.replace(/^\/Users\/[^/]+/, '~') : tHtml('syncNotFound', { where }))}</small></span></label>`;
  const syncState = syncCfg.lastError ? html`<span class="danger-text">${syncCfg.lastError}</span>` : syncCfg.lastSync ? tHtml('lastSynced', { when: agoText(syncCfg.lastSync) }) : tHtml('notSyncedYet');
  return html`
      <div class="svc">
        <div class="svc-head"><span class="svc-logo sync">${SYNC_ICON}</span>
          <div><b>${tHtml('profileSync')}</b><small class="muted" id="sync-status">${syncOn() ? html`${syncLabel(sp)} · ${syncState}` : tHtml('syncOffStatus', { where })}</small></div>
          ${syncOn() && html`<button class="btn ghost sm" data-act="sync-now">${tHtml('syncNow')}</button>`}</div>
        <div class="sync-opts" id="sync-opts" role="radiogroup" aria-label="${tText('profileSync')}">
          ${syncRow('off', tHtml('off'), null, true, tHtml('syncOffHint', { where }))}
          ${targets.map((tg) => syncRow(tg.provider, tg.label, tg.path, tg.found))}
          ${syncRow('folder', tHtml('otherFolder'), sp === 'folder' ? syncCfg.dir : null, true, sp === 'folder' ? syncCfg.dir : tHtml('otherFolderHint'))}
        </div>
        <p class="muted small">${tHtml('syncHint', { machine: PLAT.machine })}</p>
      </div>
      <div class="svc">
        <div class="svc-head"><span class="svc-logo garmin">G</span><div><b>Garmin Connect</b><small class="muted">${garmin.connected ? (garmin.name ? tHtml('signedInAs', { name: garmin.name }) : tHtml('signedIn')) : tHtml('notSignedIn')}</small></div>
          ${garmin.connected ? html`<button class="btn ghost sm" data-act="garmin-off">${tHtml('signOut')}</button>` : html`<button class="btn garmin" data-act="garmin-on">${tHtml('signInGarmin')}</button>`}</div>
        ${garmin.connected ? modeSelect('garminMode', syncMode('garmin')) : html`<p class="muted small">${tHtml('garminHint', { where })}</p>`}
        <p class="muted small">${tHtml('stravaHint')}</p>
        <details class="adv">
          <summary>${tHtml('manualFit')}</summary>
          <p class="muted small">${tHtml('manualFitHint', { app: PLAT.files })}</p>
          <div class="folder-row"><code>${s.garmin?.folder || 'Downloads'}</code><button class="btn ghost sm" data-act="garmin-dir">${tHtml('changeDots')}</button></div>
          ${checkField('garminAuto', s.garmin?.autoOpen, tHtml('manualFitAuto'))}
        </details>
      </div>
      ${svcs.length > 0 && html`<h3 class="svc-group">${tHtml('morePlatforms')}</h3>${svcs.map(serviceCard)}`}`;
}

const ABOUT_LINKS = [['https://steffenr.github.io/zwo-trainer/', 'website'], ['https://github.com/steffenr/zwo-trainer', 'sourceCode'], ['https://github.com/steffenr/zwo-trainer/releases/latest/download/THIRD-PARTY-NOTICES.html', 'thirdParty'], ['https://buymeacoffee.com/steffenr', 'buyCoffee']];

/** App: appearance, language, workouts folder, devices, updates, about. */
function settingsAppTab(s) {
  const devs = s.devices || {};
  const none = t('none');
  return html`
      <div class="form">
        ${segRow('theme-ctl', tHtml('appearance'), ['system', 'light', 'dark'].map((th) => [th, tHtml(THEME_LABEL[th])]), s.theme || 'system')}
        ${segRow('lang-ctl', tHtml('language'), LOCALES.map((l) => [l.value, l.nativeLabel, { lang: l.value }]), uiLang())}
      </div>
      <h3>${tHtml('workoutsFolder')}</h3>
      <div class="folder-row"><code>${library.root}</code><button class="btn ghost sm" data-act="dir">${tHtml('changeDots')}</button><button class="btn ghost sm" data-act="rescan" title="${tText('rescanTitle')}">${tHtml('rescan')}</button></div>
      <h3>${tHtml('devices')}</h3>
      <div class="dev-sum"><p class="muted small">${tHtml('devicesSummary', { trainer: devs.trainer?.name || none, hr: devs.hr?.name || none, shifter: (devs.controllers || []).map((c) => c.name).join(' + ') || none })}</p><button class="btn ghost sm" data-act="devices">${tHtml('manageDevices')}</button></div>
      ${updPrefs.available && html`<h3>${tHtml('updates')}</h3><div class="form upd-form"><div class="frow">${checkField('updAuto', updPrefs.auto !== false, tHtml('updAuto'))}<button class="btn ghost sm" data-act="upd-check">${tHtml('checkNow')}</button></div></div>`}
      <h3>${tHtml('about')}</h3>
      <p class="muted small">zwoTrainer <span id="app-ver"></span> · ${tHtml('mitLicense')} · © 2026 SteffenR</p>
      <p class="about-links small">${ABOUT_LINKS.map(([url, l], i) => html`${i > 0 && html`<span aria-hidden="true"> · </span>`}<a href="#" class="link" data-act="link" data-url="${url}">${tHtml(l)}</a>`)}</p>`;
}

/**
 * Settings: every control saves as soon as it changes (numbers when the field is left and valid).
 * There is no Cancel: Done, ✕, Esc and a click outside all just close. Views redraw once on close.
 * Markup: settings*Tab(); behaviour: bindSettingsFields() (inputs, checkboxes, segmented controls,
 * sync folder) and settingsActions() (buttons).
 */
async function openSettings(tab = 'rider') {
  const s = state.settings;
  const [garmin, targets, svcs] = await Promise.all([invoke('garmin_status').catch(() => ({})), invoke('sync_targets').catch(() => []), refreshServices()]);
  const ctx = { garmin, targets, svcs };
  openModal(html`
    ${dialogHead(html`${tHtml('settings')} <small class="muted">· ${state.name}</small>`)}
    <div class="tabs" id="set-tabs" role="tablist" aria-label="${tText('settings')}">${SETTINGS_TABS.map(([k, l]) => html`<button role="tab" id="tab-${k}" aria-controls="pane-${k}" aria-selected="${String(tab === k)}" tabindex="${tab === k ? 0 : -1}" data-tab="${k}" class="${tab === k ? 'on' : ''}">${tHtml(l)}</button>`)}</div>
    <div class="set-panes">
      ${tabPane('rider', tab, settingsRiderTab(s))}
      ${tabPane('riding', tab, settingsRidingTab(s, shifting()))}
      ${tabPane('sync', tab, settingsSyncTab(s, ctx))}
      ${tabPane('app', tab, settingsAppTab(s))}
    </div>
    <div class="modal-actions set-foot"><span class="set-status muted small" id="set-status" role="status">${tHtml('autoSaved')}</span><button class="btn" data-act="close">${tHtml('done')}</button></div>`, 'small settings');

  // ---- saving: one model for everything
  let statusTimer = null;
  const status = $('#set-status', modal);
  const savedOk = () => mount(status, html`<span class="ok-text">${IC.check} ${tHtml('savedOk')}</span>`);
  const save = async () => {
    settingsDirty = true;
    await api.saveState();
    savedOk();
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (status.textContent = t('autoSaved')), 1800);
  };
  // views (FTP, zones, …) redraw once, when Settings ends (closed, or replaced by a confirmation)
  // — never while typing
  onDialogEnd(() => { if (settingsDirty && !ride) route(); settingsDirty = false; });

  $('#set-tabs', modal).onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    $$('#set-tabs [role=tab]', modal).forEach((x) => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; });
    $$('.tab-pane', modal).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    $('.set-panes', modal).scrollTop = 0;
  };
  bindSettingsFields(s, { save, savedOk, svcs, targets });
  window.__TAURI__?.app?.getVersion?.().then((v) => { const el = $('#app-ver', modal); if (el) el.textContent = v; }).catch(() => {});
  bindActions(modal, settingsActions(svcs));
}

/**
 * Settings behaviour for everything that isn't a button: number fields (checked on input once an error
 * shows, saved on change when valid), zone limits (must increase), checkboxes and segmented controls
 * (saved at once), and the profile-sync folder choice.
 */
function bindSettingsFields(s, { save, savedOk, svcs, targets }) {
  const f = (n) => $(`[name=${n}]`, modal);
  const showErr = (id, msg, inputs) => {
    const el = $(`#err-${id}`, modal);
    el.textContent = msg || '';
    el.hidden = !msg;
    inputs.forEach((i) => i.setAttribute('aria-invalid', msg ? 'true' : 'false'));
  };
  const rangeErr = (el, optional = false) => {
    if (el.value === '') return optional ? '' : t('errRange', { min: fmtNum(+el.min), max: fmtNum(+el.max) });
    const v = +el.value;
    return Number.isFinite(v) && v >= +el.min && v <= +el.max ? '' : t('errRange', { min: fmtNum(+el.min), max: fmtNum(+el.max) });
  };
  // number fields → where the valid value goes
  const FIELDS = {
    ftp: { apply: (v) => (s.ftp = Math.round(v)) },
    maxHr: { apply: (v) => (s.maxHr = Math.round(v)) },
    weight: { optional: true, apply: (v) => (s.weight = v === null ? null : Math.round(v * 10) / 10) },
    vsMin: { apply: (v) => (s.shifting = { ...shifting(), minRatio: v }) },
    vsMax: { apply: (v) => (s.shifting = { ...shifting(), maxRatio: v }) },
    vsStart: { apply: (v) => (s.shifting = { ...shifting(), startGear: Math.round(v) }) },
  };
  for (const k of ['s5', 'm1', 'm5', 'm20']) FIELDS[`b_${k}`] = { optional: true, apply: (v) => { const b = { ...(s.bests || {}) }; if (v === null) delete b[k]; else b[k] = Math.round(v); s.bests = b; } };
  const validate = (name) => {
    const el = f(name);
    const msg = rangeErr(el, FIELDS[name].optional);
    showErr(name, msg, [el]);
    return !msg;
  };
  const zoneInputs = [0, 1, 2, 3].map((i) => f(`z${i}`));
  const checkZones = () => {
    const bad = zoneInputs.find((el) => rangeErr(el));
    const z = zoneInputs.map((el) => +el.value);
    const msg = bad ? rangeErr(bad) : z.every((v, i) => i === 0 || v > z[i - 1]) ? '' : t('errZones');
    showErr('zones', msg, zoneInputs);
    return msg ? null : z;
  };
  for (const name of Object.keys(FIELDS)) {
    const el = f(name);
    el.addEventListener('input', () => { if (el.getAttribute('aria-invalid') === 'true') validate(name); });
    el.addEventListener('change', () => { if (!validate(name)) return; FIELDS[name].apply(el.value === '' ? null : +el.value); save(); });
  }
  zoneInputs.forEach((el) => {
    el.addEventListener('input', () => { $('#z5-lim', modal).textContent = zoneInputs[3].value; if (el.getAttribute('aria-invalid') === 'true') checkZones(); });
    el.addEventListener('change', () => { const z = checkZones(); if (z) { s.zones = z; save(); } });
  });

  // checkboxes save at once
  for (const name of ['beeps', 'beepDirection', 'endChime', 'autoPause', 'coachHints', 'keyboardShortcuts']) f(name).onchange = (e) => { s[name] = e.target.checked; save(); };
  // the up/down cue belongs to the countdown beeps
  f('beepDirection').disabled = !s.beeps;
  f('beeps').addEventListener('change', (e) => { f('beepDirection').disabled = !e.target.checked; });
  f('garminAuto').onchange = (e) => { s.garmin = { ...(s.garmin || {}), autoOpen: e.target.checked }; save(); };
  const updAuto = f('updAuto');
  if (updAuto) updAuto.onchange = () => invoke('update_prefs', { auto: updAuto.checked }).then((p) => { setUpdPrefs(p); savedOk(); }).catch((err) => toast(String(err)));

  // segmented controls (radio groups) save at once
  const SEGS = {
    'theme-ctl': (v) => { s.theme = v; applyTheme(); save(); },
    'vs-mode': (v) => { s.shifting = { ...shifting(), mode: v }; $('#vs-mode-hint', modal).textContent = t(`vsHint.${v}`); save(); },
    'vs-diff': (v) => { s.shifting = { ...shifting(), difficulty: v }; save(); },
    'mode-garminMode': (v) => { s.garmin = { ...(s.garmin || {}), mode: v }; save(); },
    // a new language redraws the app and this dialog
    'lang-ctl': async (v) => {
      if (v === uiLang()) return;
      s.language = v;
      await save();
      applyLanguage();
      renderProfileChip();
      if (!ride) route();
      settingsDirty = false;
      toast(t('languageSet', { label: LOCALES.find((x) => x.value === v).nativeLabel }));
      openSettings('app');
    },
  };
  for (const sv of svcs) SEGS[`mode-svc-${sv.id}`] = (v) => { s.services = { ...(s.services || {}), [sv.id]: { ...(s.services?.[sv.id] || {}), mode: v } }; save(); };
  $$('[role=radiogroup].seg-ctl', modal).forEach((ctl) => (ctl.onclick = (e) => {
    const b = e.target.closest('[role=radio]');
    if (!b || b.getAttribute('aria-checked') === 'true') return;
    selectSeg(ctl, b);
    SEGS[ctl.id]?.(b.dataset.v);
  }));

  // profile sync: a known cloud folder, a folder of your choice, or off
  $('#sync-opts', modal).onchange = async (e) => {
    const v = e.target.value;
    let dir = null;
    if (v === 'folder') { dir = await invoke('pick_sync_dir').catch((err) => toast(String(err))); if (!dir) return openSettings('sync'); }
    else if (v !== 'off') dir = targets.find((tg) => tg.provider === v)?.path;
    try {
      setSyncCfg(await invoke('sync_config', { provider: v, dir, auto: true }));
      if (syncOn()) await runSync(false); else toast(t('profileSyncOff'));
    } catch (err) { toast(String(err)); }
    openSettings('sync');
  };
}

/** Settings buttons (data-act). Most reopen Settings on the same tab so it shows the new state. */
function settingsActions(svcs) {
  /** Show a busy label on the button while `fn` runs; restore it afterwards (also on errors). */
  const busy = async (el, label, fn) => {
    const old = el.textContent;
    el.disabled = true; el.textContent = label;
    try { return await fn(); } finally { if (el.isConnected) { el.disabled = false; el.textContent = old; } }
  };
  return {
    // an invalid number isn't saved: show it once instead of closing
    close: () => {
      const bad = $('[aria-invalid=true]', modal);
      if (!bad) return closeModal();
      const pane = bad.closest('.tab-pane');
      if (pane.hidden) $(`#tab-${pane.dataset.pane}`, modal).click();
      const adv = $('details.adv', pane);
      if (adv?.contains(bad)) adv.open = true;
      bad.focus();
    },
    link: (el) => openExternal('open_link', { url: el.dataset.url }),
    devices: () => { closeModal(); devicesMenu($('#btn-devices')); },
    'upd-check': async (el) => { const u = await busy(el, t('checking'), () => checkUpdate(false)); if (u && !ride) closeModal(); },
    dir: async () => { await pickDir(); openSettings('app'); },
    rescan: async (el) => {
      await busy(el, t('rescanning'), loadLibrary);
      settingsDirty = true;
      toast(t('plansFound', { n: library.plans.length }));
    },
    'garmin-dir': async () => {
      const dir = await invoke('pick_garmin_dir').catch((err) => toast(String(err)));
      if (dir) { setState((await api.appState()).profile); openSettings('sync'); }
    },
    'svc-getkey': () => openExternal('open_url', { url: 'https://intervals.icu/settings' }),
    'svc-key': async (el) => {
      const id = el.dataset.id;
      const apiKey = $(`[name=key-${id}]`, modal).value.trim();
      if (!apiKey) return toast(t('pasteKeyFirst'));
      try {
        setSvcCache(await busy(el, t('checking'), () => invoke('service_connect', { id, apiKey })));
        state.settings.services = { ...(state.settings.services || {}), [id]: { mode: 'auto' } };
        await api.saveState();
        const sv = svcCache.find((x) => x.id === id);
        toast(`${t('nameConnected', { name: sv?.name })}${sv?.account ? ` — ${sv.account}` : ''}`);
        openSettings('sync');
      } catch (err) { toast(String(err)); }
    },
    'svc-off': async (el) => {
      const sv = svcs.find((x) => x.id === el.dataset.id);
      if (await confirmDialog(t('disconnectQ', { name: sv.name }), t('disconnectText'), t('disconnect'), true)) {
        setSvcCache(await invoke('service_disconnect', { id: sv.id }).catch((err) => { toast(String(err)); return svcCache; }));
      }
      openSettings('sync');
    },
    'sync-now': async (el) => { el.disabled = true; await runSync(false); openSettings('sync'); },
    'garmin-on': async (el) => {
      try {
        const st = await busy(el, t('signInWindow'), () => invoke('garmin_connect'));
        state.settings.garmin = { ...(state.settings.garmin || {}), mode: 'auto' };
        await api.saveState();
        toast(`${t('garminLinked')}${st.name ? ` — ${st.name}` : ''}`);
        openSettings('sync');
      } catch (err) { toast(String(err)); }
    },
    'garmin-off': async () => {
      if (await confirmDialog(t('garminSignOutQ'), t('garminSignOutText'), t('signOut'), true)) await invoke('garmin_disconnect').catch((err) => toast(String(err)));
      openSettings('sync');
    },
  };
}

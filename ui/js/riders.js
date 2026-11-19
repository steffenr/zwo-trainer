// Riders: avatars (initials or emoji on the rider's colour), the rider chip in the top bar, "Who's riding?"
// at launch, the Riders dialog (switch, add, edit, delete) with the avatar editor, and afterProfileChange(),
// which reloads everything that depends on the rider. The rider list itself lives in core.js (profiles).
//
// Import cycles with app.js (applyAppState, loadLibrary; app.js wires the chip and asks who is riding) and
// views/settings.js (a new rider opens Settings, which redraws the chip), and through actions.js, devices.js
// and connections.js. Safe because nothing from those modules is used while this module is evaluated, only
// inside functions that run after boot.
import { invoke } from './ble.js';
import { t } from './i18n/index.js';
import { html, raw, tHtml, tText, mount } from './html.js';
import { dialogHead } from './components/dialog.js';
import { avatarInk } from './components/avatar.js';
import {
  PLAT, $, $$, state, trainer, hrm, ride, modal, openModal, closeModal, confirmDialog, toast, profiles,
} from './core.js';
import { loadLibrary, applyAppState } from './app.js';
import { bindActions } from './actions.js';
import { openSettings } from './views/settings.js';
import { autoConnect } from './devices.js';
import { refreshServices } from './connections.js';
import { scheduleSync } from './sync.js';

export { renderProfileChip, whoIsRiding, profileMenu };

const initials = (n) => (n || '?').trim().split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const AVATAR_COLORS = ['#338cff', '#59bf59', '#ff6639', '#b47cff', '#00a3c4', '#e0a800', '#ff4d8d', '#7f7f7f'];
const avatarColor = (id) => AVATAR_COLORS[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
const AVATAR_EMOJI = ['🚴', '🚵', '🏃', '🏊', '⚡', '🔥', '🚀', '🦊', '🐻', '🐼', '🦁', '🐯', '🐺', '🦅', '🐢', '🐝', '🌵', '🌊', '⛰️', '🌞', '⭐', '💪', '🎧', '🏁'];
/** Only a #rrggbb colour may reach markup or CSS (same rule as clean_avatar in state.rs). */
const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
const avatarBg = (p) => safeColor(p.avatar?.color) || avatarColor(p.id);
/** Classes of an avatar: emoji on a tint, or initials in black or white, whichever contrasts more with the fill. */
const avatarCls = (p, cls) => `avatar ${cls} ${p.avatar?.emoji ? 'emoji' : avatarInk(avatarBg(p)) === 'dark' ? 'ink-dark' : ''}`.replace(/\s+/g, ' ').trim();
/** Rider avatar: emoji on a tint, or the initials on the rider's colour (only a #rrggbb colour reaches CSS). */
const avatar = (p, cls = '') => html`<span class="${avatarCls(p, cls)}" style="--av:${avatarBg(p)}">${p.avatar?.emoji || initials(p.name)}</span>`;
/** DOM version of avatar() for live previews: user input is only ever set as text, never parsed as HTML. */
const avatarNode = (p, cls = '') => {
  const e = p.avatar?.emoji;
  const s = document.createElement('span');
  s.className = avatarCls(p, cls);
  s.style.setProperty('--av', avatarBg(p));
  s.textContent = e || initials(p.name);
  return s;
};

function renderProfileChip() {
  const b = $('#btn-profile');
  mount(b, avatar(state));
  b.title = t('ridersTitle', { name: state.name });
  b.setAttribute('aria-label', t('riderAria', { name: state.name }));
}

// ------------------------------------------------------------------ profiles
function whoIsRiding() {
  return new Promise((resolve) => {
    openModal(html`
      <div class="who">
        <h2>${tHtml('whoRiding')}</h2>
        <div class="who-grid">${profiles.map((p) => html`<button class="who-card" data-id="${p.id}">${raw(avatar(p, 'xl'))}<span>${p.name}</span></button>`)}</div>
      </div>`, 'small sticky');
    $('.who-grid', modal).onclick = async (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      closeModal();
      if (b.dataset.id !== state.id) applyAppState(await invoke('switch_profile', { id: b.dataset.id }));
      resolve();
    };
  });
}

/** Name, colour and emoji of a rider (the avatar replaces the initials when an emoji is set). */
function profileEditor(p) {
  const cur = { color: p.avatar?.color || null, emoji: p.avatar?.emoji || null };
  const previewProfile = () => ({ ...p, avatar: { color: cur.color, emoji: cur.emoji }, name: $('[name=pname]', modal)?.value || p.name });
  const preview = () => avatar(previewProfile(), 'xl');
  const own = cur.emoji && !AVATAR_EMOJI.includes(cur.emoji) ? cur.emoji : '';
  openModal(html`
    ${dialogHead(tHtml('editRider'))}
    <div class="pe">
      <div class="pe-preview" id="pe-preview">${raw(preview())}</div>
      <div class="pe-fields">
        <label class="pe-name">${tHtml('name')}<input type="text" name="pname" value="${p.name}" maxlength="40" autocomplete="off"></label>
        <div class="pe-label">${tHtml('colour')}</div>
        <div class="swatches" id="pe-colors">${AVATAR_COLORS.map((c) => html`<button type="button" data-color="${c}" style="--sw:${c}" class="${avatarBg({ ...p, avatar: cur }) === c ? 'on' : ''}" aria-label="${c}"></button>`)}<label class="sw-custom" title="${tText('customColour')}"><input type="color" id="pe-custom" value="${avatarBg(p)}">＋</label></div>
        <div class="pe-label">${tHtml('emoji')} <small class="muted">${tHtml('emojiHint')}</small></div>
        <div class="emoji-grid" id="pe-emoji"><button type="button" data-e="" class="${cur.emoji ? '' : 'on'}" title="${tText('initials')}">${initials(p.name)}</button>${AVATAR_EMOJI.map((e) => html`<button type="button" data-e="${e}" class="${cur.emoji === e ? 'on' : ''}">${e}</button>`)}</div>
        <input type="text" id="pe-emoji-own" class="pe-own" placeholder="${tText('emojiOwn')}${PLAT.emojiKey}" maxlength="8" value="${own}">
      </div>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-act="back">${tHtml('back')}</button><button class="btn primary" data-act="save">${tHtml('save')}</button></div>`, 'small');
  const refresh = () => {
    $('#pe-preview', modal).replaceChildren(avatarNode(previewProfile(), 'xl'));
    $$('#pe-colors [data-color]', modal).forEach((x) => x.classList.toggle('on', x.dataset.color === cur.color));
    $$('#pe-emoji [data-e]', modal).forEach((x) => x.classList.toggle('on', (x.dataset.e || null) === cur.emoji));
  };
  $('#pe-colors', modal).onclick = (e) => { const b = e.target.closest('[data-color]'); if (b) { cur.color = b.dataset.color; refresh(); } };
  $('#pe-custom', modal).oninput = (e) => { cur.color = safeColor(e.target.value); refresh(); };
  $('#pe-emoji', modal).onclick = (e) => { const b = e.target.closest('[data-e]'); if (b) { cur.emoji = b.dataset.e || null; $('#pe-emoji-own', modal).value = ''; refresh(); } };
  $('#pe-emoji-own', modal).oninput = (e) => { cur.emoji = e.target.value.trim() || null; refresh(); };
  $('[name=pname]', modal).oninput = refresh;
  bindActions(modal, {
    close: closeModal,
    back: profileMenu,
    save: async () => {
      try {
        applyAppState(await invoke('edit_profile', { id: p.id, name: $('[name=pname]', modal).value, avatar: cur }));
        scheduleSync();
        profileMenu();
      } catch (err) { toast(String(err)); }
    },
  });
}

function profileMenu() {
  if (ride) return toast(t('finishToSwitch'));
  openModal(html`
    ${dialogHead(tHtml('riders'))}
    <div class="profile-list">
      ${profiles.map((p) => html`
        <div class="profile-row ${p.id === state.id ? 'on' : ''}" data-id="${p.id}">
          <button class="profile-pick" data-act="switch">${raw(avatar(p))}<span>${p.name}</span>${p.id === state.id && html`<small class="muted">· ${tHtml('riding')}</small>`}</button>
          <button class="btn ghost sm" data-act="edit">${tHtml('edit')}</button>
          ${profiles.length > 1 && html`<button class="btn ghost sm" data-act="delete">${tHtml('delete')}</button>`}
        </div>`)}
    </div>
    <form class="add-profile" id="add-profile"><input type="text" name="name" placeholder="${tText('newRiderName')}" maxlength="40" autocomplete="off"><button class="btn primary" type="submit">${tHtml('addRider')}</button></form>
    <p class="muted small">${tHtml('ridersHint')}</p>`, 'small');
  $('#add-profile', modal).onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    try { closeModal(); await afterProfileChange(await invoke('create_profile', { name })); toast(t('welcomeRider', { name })); openSettings('rider'); }
    catch (err) { toast(String(err)); }
  };
  const rowOf = (el) => { const id = el.closest('[data-id]').dataset.id; return { id, p: profiles.find((x) => x.id === id) }; };
  bindActions(modal, {
    close: closeModal,
    switch: async (el) => { const { id } = rowOf(el); closeModal(); if (id !== state.id) await afterProfileChange(await invoke('switch_profile', { id })); },
    edit: (el) => profileEditor(rowOf(el).p),
    delete: async (el) => {
      const { id, p } = rowOf(el);
      if (await confirmDialog(t('deleteRiderQ', { name: p.name }), t('deleteRiderText'), t('delete'), true)) await afterProfileChange(await invoke('delete_profile', { id }));
      else profileMenu();
    },
  });
}

/** After switching/creating/deleting: reload everything that depends on the rider. */
async function afterProfileChange(a) {
  refreshServices();
  applyAppState(a);
  location.hash = '#/';
  // a rider with their own saved device takes it over; otherwise keep what's connected
  for (const [kind, dev] of [['trainer', trainer], ['hr', hrm]]) {
    const want = state.settings.devices?.[kind]?.id;
    if (dev.mode === 'ble' && want && dev.id && dev.id !== want) await dev.disconnect();
  }
  await loadLibrary();
  autoConnect();
}

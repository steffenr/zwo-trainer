// Markup for css/components/buttons.css: segmented control, favourite star, ⋯ menu.
import { html, raw, tText } from '../html.js';

/** Extra attributes from an object ({ lang: 'de', title: '…' }); names must be plain identifiers, values are escaped. */
const attrsOf = (o = {}) => {
  if (typeof o !== 'object' || o === null) throw new Error('segCtl: item attributes must be an object');
  return Object.entries(o).map(([k, v]) => {
    if (!/^[a-z][\w-]*$/i.test(k)) throw new Error(`segCtl: bad attribute name ${k}`);
    return html` ${raw(k)}="${v}"`;
  });
};

/**
 * Segmented control as a radio group: one tab stop, arrow keys move (rovingKey in core.js), the
 * selected button has .on and aria-checked. items: [[value, label, attrs?]] — label escaped unless
 * a fragment; attrs an object of extra attributes. The group needs an accessible name: `labelledBy`
 * (id of a visible label) or `label` (text).
 */
export function segCtl(id, items, cur, { labelledBy, label } = {}) {
  if (!labelledBy && !label) throw new Error(`segCtl ${id}: give labelledBy or label`);
  const sel = items.some(([v]) => v === cur) ? cur : items[0][0];
  return html`<span class="seg-ctl" id="${id}" role="radiogroup" ${labelledBy ? html`aria-labelledby="${labelledBy}"` : html`aria-label="${label}"`}>${items.map(([v, text, attrs]) =>
    html`<button type="button" role="radio" data-v="${v}" aria-checked="${String(v === cur)}" tabindex="${v === sel ? 0 : -1}" class="${v === cur ? 'on' : ''}"${attrsOf(attrs)}>${text}</button>`)}</span>`;
}

/** A labelled segmented control in a settings form row. */
export const segRow = (id, label, items, cur, cls = '') =>
  html`<div class="frow ${cls}"><span id="${id}-l">${label}</span>${segCtl(id, items, cur, { labelledBy: `${id}-l` })}</div>`;

/** Mark `b` as the selected item of segmented control `ctl`. */
export function selectSeg(ctl, b) {
  for (const x of ctl.querySelectorAll('[role=radio]')) {
    const on = x === b;
    x.classList.toggle('on', on);
    x.setAttribute('aria-checked', on);
    x.tabIndex = on ? 0 : -1;
  }
}

/** ⋯ button with its menu items (trusted markup or fragment) waiting in a <template>. */
export const menuBtn = (items, label = tText('moreActions')) =>
  html`<span class="menu-wrap"><button class="more" data-act="menu" title="${label}" aria-label="${label}">⋯</button><template>${raw(items)}</template></span>`;

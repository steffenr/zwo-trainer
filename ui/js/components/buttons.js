// Markup for css/components/buttons.css: segmented control, favourite star, ⋯ menu.
import { html, raw, tHtml } from '../html.js';

/**
 * Segmented control as a radio group: one tab stop, arrow keys move (rovingKey in app.js), the
 * selected button has .on and aria-checked. items: [[value, label, attrs?]] (label escaped unless a
 * fragment; attrs is trusted markup such as `title="…"`).
 */
export function segCtl(id, items, cur, { labelledBy, label } = {}) {
  const sel = items.some(([v]) => v === cur) ? cur : items[0][0];
  return html`<span class="seg-ctl" id="${id}" role="radiogroup" ${labelledBy ? html`aria-labelledby="${labelledBy}"` : html`aria-label="${label}"`}>${items.map(([v, text, attrs]) =>
    html`<button type="button" role="radio" data-v="${v}" aria-checked="${String(v === cur)}" tabindex="${v === sel ? 0 : -1}" class="${v === cur ? 'on' : ''}" ${raw(attrs ?? '')}>${text}</button>`)}</span>`;
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
export const menuBtn = (items, label = tHtml('moreActions')) =>
  html`<span class="menu-wrap"><button class="more" data-act="menu" title="${label}" aria-label="${label}">⋯</button><template>${raw(items)}</template></span>`;

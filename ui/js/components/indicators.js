// Markup for css/components/indicators.css: badge, week/day tag, zone tag.
// Text arguments are escaped; pass tHtml(…) or an html`` fragment for translated or marked-up text.
import { html, tHtml } from '../html.js';
import { ZONES } from '../render.js';

/** Badge: kind '' (accent), 'ok', 'warn', 'muted', 'test'. */
export const badge = (text, kind = '') => html`<span class="badge${kind ? ` ${kind}` : ''}">${text}</span>`;

/** Week/day tag (W3 D2, D2). */
export const wdTag = (text) => html`<span class="wd">${text}</span>`;

/** Zone tag "Z3" on the zone colour, with the full name as tooltip; nothing for zone 0 / unknown. */
export function zoneTag(z) {
  const zone = ZONES[z - 1];
  if (!zone) return html``;
  return html`<span class="ztag" style="--zc:${zone.color}" title="${tHtml('trainingIntensity', { zone: `${zone.short} ${zone.name}` })}">${zone.short}</span>`;
}

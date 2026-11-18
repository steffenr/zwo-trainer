// Safe HTML strings without a build step or a library.
//
//   html`<b>${name}</b>`          every interpolated value is escaped …
//   html`<ul>${items.map(li)}</ul>` … arrays are joined, null / undefined / false render nothing …
//   html`<p>${html`<i>x</i>`}</p>`  … and fragments made by html`` (or raw()) are inserted as markup.
//   tHtml(key, { name })          a translation (its markup is ours, so trusted) with escaped vars.
//   raw(markup)                   only for markup we generated ourselves: icons, renderMarkdown(),
//                                 miniProfile() SVG. Never for text from files, devices or the rider.
//   mount(el, fragment)           el.innerHTML = fragment; plain strings are shown as text.
//
// Limits: always quote attribute values (title="${x}"); values in style="" and href="" are escaped but
// not validated, so keep safeColor() / encodeURIComponent() there. Plain t() stays unescaped because it
// also feeds toast(), confirmDialog() and textContent, which are plain text.
import { t } from './i18n/index.js';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for HTML content and quoted attribute values. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]);

/** A piece of trusted markup. toString() returns it, so it also works inside plain template strings. */
export class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

/** Mark markup we built ourselves as trusted. */
export const raw = (s) => (s instanceof Safe ? s : new Safe(String(s ?? '')));

const part = (v) => (v == null || v === false ? '' : v instanceof Safe ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));

/** Tagged template: escapes every interpolation except Safe fragments; returns a Safe fragment. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}

/** t() for markup: the dictionary text is trusted, the vars are escaped unless they are Safe. */
export function tHtml(key, vars) {
  if (!vars) return new Safe(t(key));
  const safeVars = {};
  for (const [k, v] of Object.entries(vars)) safeVars[k] = k === 'n' && typeof v === 'number' ? v : part(v);
  return new Safe(t(key, safeVars));
}

/** The one place that writes innerHTML from a fragment. A plain string is treated as text. */
export function mount(el, v) {
  el.innerHTML = v instanceof Safe ? v.s : esc(v);
  return el;
}

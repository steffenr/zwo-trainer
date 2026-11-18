// Safe HTML strings without a build step or a library.
//
//   html`<b>${name}</b>`          every interpolated value is escaped …
//   html`<ul>${items.map(li)}</ul>` … arrays are joined, null / undefined / false / true render nothing …
//   html`<p>${html`<i>x</i>`}</p>`  … and fragments made by html`` (or raw()) are inserted as markup.
//   tHtml(key, { name })          a translation as markup (the dictionary may contain <b>, &amp; …;
//                                 it is ours, so trusted) with escaped vars. For element content.
//   tText(key, { name })          the same translation as plain text (tags dropped, entities decoded),
//                                 for attributes: title="${tText('x')}" — html`` then escapes it.
//   raw(markup)                   only for markup we generated ourselves: icons, renderMarkdown(),
//                                 miniProfile() SVG. Never for text from files, devices or the rider.
//   mount(el, fragment)           el.innerHTML = fragment; plain strings are shown as text.
//
// Booleans render nothing (handy for `${cond && html`…`}`), so an attribute that needs the word must
// say so: aria-checked="${String(on)}". Careful with numbers: `${count && html`…`}` renders "0" when
// count is 0; write `${count > 0 && html`…`}`.
// Limits: always quote attribute values (title="${x}"); never put tHtml() into an attribute (use
// tText()); values in style="" and href="" are escaped but not validated, so keep safeColor() /
// encodeURIComponent() there. Plain t() stays unescaped because it also feeds toast(),
// confirmDialog() and textContent, which are plain text.
import { t } from './i18n/index.js';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const DEC = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** A piece of trusted markup. toString() returns it, so it also works inside plain template strings. */
export class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

/** Escape text for HTML content and quoted attribute values. Safe fragments pass through unchanged. */
export const esc = (s) => (s instanceof Safe ? s.s : String(s ?? '').replace(/[&<>"']/g, (c) => ENT[c]));

/** Mark markup we built ourselves as trusted. */
export const raw = (s) => (s instanceof Safe ? s : new Safe(String(s ?? '')));

const part = (v) => (v == null || typeof v === 'boolean' ? '' : v instanceof Safe ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));

/** Tagged template: escapes every interpolation except Safe fragments; returns a Safe fragment. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}

/** Vars for t() inside markup: escaped unless Safe; the plural count `n` stays a number. */
const markupVars = (vars) => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, k === 'n' && typeof v === 'number' ? v : part(v)]));

/** t() for markup: the dictionary text is trusted, the vars are escaped unless they are Safe. */
export const tHtml = (key, vars) => new Safe(vars ? t(key, markupVars(vars)) : t(key));

/**
 * Markup → plain text: drop tags, then any stray < or > left by malformed or nested markup (a single
 * tag-stripping pass turns "<<b>script>" into "<script>"), then decode the entities we use. Real "<"
 * in a text must be written &lt;, so it survives as "<" only after this point. The result is text,
 * never markup: it still goes through html`` (escaped) like any other value.
 */
export const plain = (markup) => String(markup)
  .replace(/<[^>]*>/g, '')
  .replace(/[<>]/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => DEC[e]);

/**
 * t() as plain text, for attributes (title, aria-label, placeholder); html`` escapes it there.
 * The vars are escaped before and decoded after, so "<" or "&" in a workout name survive unchanged.
 */
export const tText = (key, vars) => plain(vars ? t(key, markupVars(vars)) : t(key));

/** The one place that writes innerHTML from a fragment. A plain string is treated as text; an array is joined like in html``. */
export function mount(el, v) {
  el.innerHTML = part(v);
  return el;
}

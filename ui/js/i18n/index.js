// UI translations. en.js is the source dictionary; de.js and fr.js must define the same keys
// (missing keys fall back to English). Values are strings or, for counts, plural objects
// ({ one, other }) picked with Intl.PluralRules from `vars.n`. `{name}` placeholders are
// replaced with `vars.name`. Values may contain our own markup (<b>, <code>, &amp;); anything
// that comes from files or the rider must be passed through esc() before it goes into `vars`.
import { en } from './en.js';
import { de } from './de.js';
import { fr } from './fr.js';

export const LOCALES = [
  { value: 'en', label: 'English', nativeLabel: 'English' },
  { value: 'de', label: 'German', nativeLabel: 'Deutsch' },
  { value: 'fr', label: 'French', nativeLabel: 'Français' },
];

export const DICTIONARIES = { en, de, fr };

const DEFAULT_LOCALE = 'en';
let current = DEFAULT_LOCALE;
let plurals = new Intl.PluralRules(DEFAULT_LOCALE);

/** A supported locale for any value (a saved setting, a browser language tag, junk). */
export function coerceLocale(value) {
  const v = String(value || '').toLowerCase().slice(0, 2);
  return DICTIONARIES[v] ? v : null;
}

/** The first supported language of the system (navigator.languages), else English. */
export function systemLocale() {
  for (const l of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const c = coerceLocale(l);
    if (c) return c;
  }
  return DEFAULT_LOCALE;
}

export const getLocale = () => current;

/** Switch the UI language; returns true when it changed. */
export function setLocale(locale) {
  const l = coerceLocale(locale) || DEFAULT_LOCALE;
  document.documentElement.lang = l;
  if (l === current) return false;
  current = l;
  plurals = new Intl.PluralRules(l);
  return true;
}

/** Locale for dates and numbers: the system's regional variant when it matches the UI language
 *  (en-GB stays en-GB), otherwise the plain UI language. */
export function fmtLocale() {
  const sys = navigator.languages?.find((x) => coerceLocale(x) === current);
  return sys || current;
}

/** Translate `key`; `vars` fill `{placeholders}`, `vars.n` also picks the plural form. */
export function t(key, vars) {
  let s = DICTIONARIES[current][key] ?? en[key];
  if (s === undefined) return key;
  if (typeof s === 'object') s = s[plurals.select(vars?.n ?? 0)] ?? s.other;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
}

/** Fill static markup: data-i18n (text), data-i18n-title, data-i18n-aria (aria-label). */
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

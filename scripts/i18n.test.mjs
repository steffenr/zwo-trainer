import test from 'node:test';
import assert from 'node:assert/strict';

// setLocale() writes <html lang>; that is the only DOM it touches. navigator is replaced per test.
globalThis.document = { documentElement: { lang: '' } };
const setNavigator = (languages, language = languages[0]) =>
  Object.defineProperty(globalThis, 'navigator', { value: { languages, language }, configurable: true, writable: true });
setNavigator(['en-US']);

const { t, pct, setLocale, getLocale, coerceLocale, systemLocale, fmtLocale, DICTIONARIES, LOCALES } =
  await import('../ui/js/i18n/index.js');

/** Run `fn` with the UI in `locale`, then switch back to English. */
function inLocale(locale, fn) {
  setLocale(locale);
  try { fn(); } finally { setLocale('en'); }
}

test('LOCALES and DICTIONARIES cover en, de and fr', () => {
  assert.deepEqual(LOCALES.map((l) => l.value), ['en', 'de', 'fr']);
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), ['de', 'en', 'fr']);
});

test('coerceLocale: language tags and saved settings to a supported locale, else null', () => {
  assert.equal(coerceLocale('de'), 'de');
  assert.equal(coerceLocale('de-AT'), 'de');
  assert.equal(coerceLocale('FR-ca'), 'fr');
  assert.equal(coerceLocale('en_GB'), 'en');
  assert.equal(coerceLocale('es'), null);
  assert.equal(coerceLocale(''), null);
  assert.equal(coerceLocale(null), null);
  assert.equal(coerceLocale(undefined), null);
  assert.equal(coerceLocale(42), null);
});

test('setLocale: switches language and <html lang>, reports changes, falls back to English', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(setLocale('de-DE'), true);
  assert.equal(getLocale(), 'de');
  assert.equal(document.documentElement.lang, 'de');
  assert.equal(setLocale('de'), false);
  assert.equal(setLocale('xx'), true);
  assert.equal(getLocale(), 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(setLocale(null), false);
});

test('systemLocale: first supported system language, else English', () => {
  try {
    setNavigator(['es-ES', 'fr-CH', 'de']);
    assert.equal(systemLocale(), 'fr');
    setNavigator(['es-ES', 'it']);
    assert.equal(systemLocale(), 'en');
    setNavigator([], 'de-CH');
    assert.equal(systemLocale(), 'de');
    setNavigator(undefined, 'fr');
    assert.equal(systemLocale(), 'fr');
  } finally { setNavigator(['en-US']); }
});

test('fmtLocale: the system\'s regional variant of the UI language, else the plain language', () => {
  try {
    setNavigator(['en-GB', 'de-AT']);
    assert.equal(fmtLocale(), 'en-GB');
    inLocale('de', () => assert.equal(fmtLocale(), 'de-AT'));
    inLocale('fr', () => assert.equal(fmtLocale(), 'fr'));
    setNavigator(undefined, 'en-US');
    assert.equal(fmtLocale(), 'en');
  } finally { setNavigator(['en-US']); }
});

test('t: placeholders filled from vars; unknown ones stay as written', () => {
  assert.equal(t('vo2Acsm', { w: 300 }), 'ACSM from 300 W (8-min power)');
  assert.equal(t('vo2Acsm', { w: 0 }), 'ACSM from 0 W (8-min power)');
  assert.equal(t('vo2Acsm', {}), 'ACSM from {w} W (8-min power)');
  assert.equal(t('vo2Acsm'), 'ACSM from {w} W (8-min power)');
  assert.equal(t('incRode', { ridden: '5:00', label: 'ramp', Label: 'Ramp' }), 'You rode 5:00 of the ramp.');
  // values are inserted as they are: escaping is the caller's job (tHtml / esc)
  assert.equal(t('vo2Acsm', { w: '<b>' }), 'ACSM from <b> W (8-min power)');
  assert.equal(t('vo2Acsm', { w: '$&' }), 'ACSM from $& W (8-min power)');
});

test('t: unknown keys return the key; keys missing in a language fall back to English', () => {
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(t('no.such.key', { n: 2 }), 'no.such.key');
  const { en } = DICTIONARIES;
  en.__testOnly = 'only in {lang}';
  try {
    inLocale('de', () => assert.equal(t('__testOnly', { lang: 'English' }), 'only in English'));
  } finally { delete en.__testOnly; }
  inLocale('de', () => assert.equal(t('segRamp'), 'Rampe'));
});

test('t: English plurals — 1 is singular, 0 and 2 are plural', () => {
  assert.equal(t('nWorkouts', { n: 1 }), '1 workout');
  assert.equal(t('nWorkouts', { n: 0 }), '0 workouts');
  assert.equal(t('nWorkouts', { n: 2 }), '2 workouts');
  assert.equal(t('nWorkouts', { n: 1.5 }), '1.5 workouts');
  assert.equal(t('nWorkouts'), '{n} workouts'); // no n counts as 0
});

test('t: German plurals — 1 is singular, 0 is plural', () => {
  inLocale('de', () => {
    assert.equal(t('nWeeks', { n: 1 }), '1 Woche');
    assert.equal(t('nWeeks', { n: 0 }), '0 Wochen');
    assert.equal(t('nWeeks', { n: 3 }), '3 Wochen');
    assert.equal(t('daysAgo', { n: 1 }), 'vor 1 Tag');
    assert.equal(t('daysAgo', { n: 12 }), 'vor 12 Tagen');
  });
});

test('t: French plurals — 0 and 1 are singular, 2 is plural', () => {
  inLocale('fr', () => {
    assert.equal(t('nWorkouts', { n: 0 }), '0 séance');
    assert.equal(t('nWorkouts', { n: 1 }), '1 séance');
    assert.equal(t('nWorkouts', { n: 1.5 }), '1.5 séance');
    assert.equal(t('nWorkouts', { n: 2 }), '2 séances');
    assert.equal(t('nWeeks', { n: 0 }), '0 semaine');
    assert.equal(t('daysAgo', { n: 3 }), 'il y a 3 jours');
  });
});

test('t: a plural object without the selected form uses "other"', () => {
  const { en } = DICTIONARIES;
  en.__testPlural = { other: '{n} things' };
  try {
    assert.equal(t('__testPlural', { n: 1 }), '1 things');
  } finally { delete en.__testPlural; }
});

test('pct: percent typography per language, numbers and ranges', () => {
  assert.equal(pct(75), '75%');
  assert.equal(pct('75–80'), '75–80%');
  inLocale('de', () => assert.equal(pct(75), '75%'));
  inLocale('fr', () => {
    assert.equal(pct(75), '75 %');
    assert.equal(pct('75–80'), '75–80 %');
    assert.equal(pct(0), '0 %');
  });
});

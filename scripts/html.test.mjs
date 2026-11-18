import test from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, esc, tHtml, mount, Safe } from '../ui/js/html.js';
import { en } from '../ui/js/i18n/en.js';

const s = (v) => String(v);

test('esc: the five HTML-special characters', () => {
  assert.equal(esc(`<a href="x">Tom & 'Jerry'</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('html: interpolations are escaped, in text and in quoted attributes', () => {
  const name = '<img src=x onerror=alert(1)>';
  assert.equal(s(html`<b title="${name}">${name}</b>`),
    '<b title="&lt;img src=x onerror=alert(1)&gt;">&lt;img src=x onerror=alert(1)&gt;</b>');
  assert.equal(s(html`<i>${'"quoted"'}</i>`), '<i>&quot;quoted&quot;</i>');
});

test('html: numbers, null, undefined and false', () => {
  assert.equal(s(html`${0}|${12.5}|${null}|${undefined}|${false}|${true}`), '0|12.5||||true');
});

test('html: nested fragments stay markup, arrays are joined', () => {
  const li = (x) => html`<li>${x}</li>`;
  assert.equal(s(html`<ul>${['a', '<b>'].map(li)}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  assert.equal(s(html`<p>${html`<i>${'&'}</i>`}</p>`), '<p><i>&amp;</i></p>');
});

test('raw: trusted markup is inserted as is; a plain string is not', () => {
  const icon = '<svg viewBox="0 0 24 24"></svg>';
  assert.equal(s(html`<span>${raw(icon)}</span>`), `<span>${icon}</span>`);
  assert.equal(s(html`<span>${icon}</span>`), '<span>&lt;svg viewBox=&quot;0 0 24 24&quot;&gt;&lt;/svg&gt;</span>');
  assert.equal(raw(raw('x')).s, 'x');
});

test('Safe fragments still work inside legacy template strings', () => {
  const frag = html`<b>${'<x>'}</b>`;
  assert.equal(`<p>${frag}</p>`, '<p><b>&lt;x&gt;</b></p>');
});

test('tHtml: dictionary markup is kept, vars are escaped unless Safe, plurals still work', () => {
  const key = Object.keys(en).find((k) => typeof en[k] === 'string' && /<b>\{\w+\}<\/b>|\{name\}/.test(en[k]));
  assert.ok(key, 'en.js has a string with a {placeholder}');
  const ph = en[key].match(/\{(\w+)\}/)[1];
  const out = s(tHtml(key, { [ph]: '<script>' }));
  assert.ok(out.includes('&lt;script&gt;') && !out.includes('<script>'), out);
  assert.ok(s(tHtml(key, { [ph]: html`<i>ok</i>` })).includes('<i>ok</i>'));
  const plural = Object.keys(en).find((k) => typeof en[k] === 'object' && en[k].one && en[k].other);
  assert.notEqual(s(tHtml(plural, { n: 1 })), s(tHtml(plural, { n: 2 })));
});

test('mount: fragments become markup, plain strings stay text', () => {
  const el = {};
  mount(el, html`<b>${'<i>'}</b>`);
  assert.equal(el.innerHTML, '<b>&lt;i&gt;</b>');
  mount(el, '<i>not markup</i>');
  assert.equal(el.innerHTML, '&lt;i&gt;not markup&lt;/i&gt;');
  assert.ok(html`` instanceof Safe);
});

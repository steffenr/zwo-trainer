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

test('html: numbers render, null / undefined / booleans render nothing', () => {
  assert.equal(s(html`${0}|${12.5}|${null}|${undefined}|${false}|${true}`), '0|12.5||||');
});

test('esc: a Safe fragment passes through (no double escaping in legacy strings)', () => {
  assert.equal(esc(html`<b>${'<x>'}</b>`), '<b>&lt;x&gt;</b>');
});

test('tText: plain text for attributes, vars survive unchanged, html`` escapes the result', async () => {
  const { tText, plain } = await import('../ui/js/html.js');
  assert.equal(plain('Privacy &amp; <b>Security</b>'), 'Privacy & Security');
  const key = Object.keys(en).find((k) => typeof en[k] === 'string' && /\{name\}/.test(en[k]));
  const out = tText(key, { name: 'A & <B>' });
  assert.ok(out.includes('A & <B>'), out);
  assert.ok(s(html`<i title="${out}"></i>`).includes('A &amp; &lt;B&gt;'));
});

test('segCtl: extra attributes are an escaped object; a name is required', async () => {
  const { segCtl } = await import('../ui/js/components/buttons.js');
  const out = s(segCtl('lang', [['de', 'Deutsch', { lang: 'de"x' }]], 'de', { label: 'Language' }));
  assert.ok(out.includes(' lang="de&quot;x"'), out);
  assert.throws(() => segCtl('x', [['a', 'A', 'lang="de"']], 'a', { label: 'L' }), /object/);
  assert.throws(() => segCtl('x', [['a', 'A']], 'a'), /labelledBy or label/);
});

test('segCtl: aria-checked says "false" for unselected items', async () => {
  const { segCtl } = await import('../ui/js/components/buttons.js');
  const out = s(segCtl('x', [['a', 'A'], ['b', '<B>']], 'a', { label: 'L' }));
  assert.ok(out.includes('data-v="a" aria-checked="true" tabindex="0"'), out);
  assert.ok(out.includes('data-v="b" aria-checked="false" tabindex="-1"'), out);
  assert.ok(out.includes('&lt;B&gt;') && out.includes('aria-label="L"'), out);
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
  mount(el, [html`<b>1</b>`, '<2>']);
  assert.equal(el.innerHTML, '<b>1</b>&lt;2&gt;');
  assert.ok(html`` instanceof Safe);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../ui/js/markdown.js';

const a = (url, label = url) =>
  `<a href="#" class="md-link" data-act="md-link" data-link="${url}" title="${url}">${label}</a>`;
const p = (s) => `<p>${s}</p>`;

test('bare URL with underscores stays one link, no <em>', () => {
  assert.equal(renderMarkdown('See https://x.com/_a_ now'), p(`See ${a('https://x.com/_a_')} now`));
  assert.equal(renderMarkdown('https://x.com/a*b*c'), p(a('https://x.com/a*b*c')));
});

test('Markdown link URL with underscores or stars is kept intact', () => {
  assert.equal(renderMarkdown('[plan](https://x.com/_a_/b__c__)'), p(a('https://x.com/_a_/b__c__', 'plan')));
  assert.equal(renderMarkdown('[plan](https://x.com/*a*)'), p(a('https://x.com/*a*', 'plan')));
});

test('bold and italic around a link', () => {
  assert.equal(renderMarkdown('**[plan](https://x.com/_a_)**'), p(`<strong>${a('https://x.com/_a_', 'plan')}</strong>`));
  assert.equal(renderMarkdown('_see [plan](https://x.com/_a_)_'), p(`<em>see ${a('https://x.com/_a_', 'plan')}</em>`));
  assert.equal(renderMarkdown('*https://x.com/_a_*'), p(`<em>${a('https://x.com/_a_')}</em>`));
  assert.equal(renderMarkdown('**see https://x.com/_a_**'), p(`<strong>see ${a('https://x.com/_a_')}</strong>`));
});

test('link text with underscores, and emphasis inside link text', () => {
  assert.equal(renderMarkdown('[my_plan_file](https://x.com)'), p(a('https://x.com', 'my_plan_file')));
  assert.equal(renderMarkdown('[a **bold** link](https://x.com)'), p(a('https://x.com', 'a <strong>bold</strong> link')));
});

test('HTML is escaped, never emitted', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), p('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(renderMarkdown('[<img src=x onerror=alert(1)>](https://x.com/"onmouseover="x)'),
    p(a('https://x.com/&quot;onmouseover=&quot;x', '&lt;img src=x onerror=alert(1)&gt;')));
  assert.doesNotMatch(renderMarkdown('**<b>x</b>** `<i>`'), /<b>|<i>/);
});

test('non-http links do not become links', () => {
  assert.equal(renderMarkdown('[click](javascript:alert(1))'), p('click)'));
  assert.equal(renderMarkdown('[mail](mailto:a@b.c)'), p('mail'));
  assert.equal(renderMarkdown('[file](file:///etc/passwd)'), p('file'));
  assert.doesNotMatch(renderMarkdown('ftp://x.com/a javascript:alert(1)'), /<a /);
});

test('code spans are left untouched', () => {
  assert.equal(renderMarkdown('`_a_ **b** https://x.com/_c_`'), p('<code>_a_ **b** https://x.com/_c_</code>'));
  assert.equal(renderMarkdown('`<b>` and _it_'), p('<code>&lt;b&gt;</code> and <em>it</em>'));
  assert.equal(renderMarkdown('[`snake_case`](https://x.com/_a_)'), p(a('https://x.com/_a_', '<code>snake_case</code>')));
});

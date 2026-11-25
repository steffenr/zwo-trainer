// Small, safe Markdown renderer for plan descriptions (no dependencies).
// Everything is HTML-escaped first; only the generated tags below are emitted.
// Supports: headings, paragraphs, line breaks, **bold**, *italic* / _italic_, ~~strike~~,
// `code`, fenced code blocks, [links](https://…), bare https:// URLs, bullet / numbered
// lists (one nesting level), > blockquotes, horizontal rules and simple tables.
// Only `https:` becomes a link (Rust's open_link refuses anything else): descriptions come from
// downloaded workout folders, so a plan can't send the rider to a plaintext http page.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** **bold**, *italic* / _italic_ and ~~strike~~ on already-escaped text. */
function emphasis(t) {
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

/** Whether `_italic_` is open at the end of `text` (an opening single `_` without its closing one).
 *  Earlier bare URLs are skipped: their underscores are part of the address. */
function italicOpen(text) {
  let open = false;
  for (const m of text.replace(/https?:\/\/\S+/g, ' ').matchAll(/_+/g)) {
    if (m[0].length !== 1) continue;
    const before = m.input[m.index - 1] || ' ', after = m.input[m.index + 1] || ' ';
    if (open ? !/\s/.test(before) && !/\w/.test(after) : !/\w/.test(before) && !/\s/.test(after)) open = !open;
  }
  return open;
}

/** Inline formatting on an already-escaped line. Links become data-link anchors.
 *  Code spans and finished links are swapped for placeholders before emphasis runs,
 *  so `_` / `*` in code, URLs or link markup never turn into <em> / <strong>. */
function inline(text) {
  const codes = [];
  const links = [];
  let t = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  const link = (label, url) => {
    const u = url.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (!/^https:\/\//i.test(u)) return label;
    links.push(`<a href="#" class="md-link" data-act="md-link" data-link="${esc(u)}" title="${esc(u)}">${label}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  };
  // A Markdown link's label gets its own emphasis pass; a bare URL is shown as it is
  // (it may sit inside *…* / **…**, so it never ends with a star). A URL may end in `_`, except
  // when an _italic_ opened before it on this line is still open: then that `_` closes it.
  t = t.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (_, l, u) => link(emphasis(l), u));
  t = t.replace(/(^|[\s(*])(_?)(https:\/\/[^\s<)]+[^\s<).,;:!?*])/g, (_, pre, us, u, at, all) => {
    // u[0]: an `_` directly before the URL opens only when a non-space follows it
    const close = u.endsWith('_') && italicOpen(all.slice(0, at) + pre + us + u[0]) ? '_' : '';
    if (close) u = u.slice(0, -1);
    return `${pre}${us}${link(u, u)}${close}`;
  });
  t = emphasis(t);
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => links[+i]);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

/** Markdown → HTML string. */
export function renderMarkdown(src) {
  const lines = esc(String(src || '')).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items: [[html, sub[]]] }
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map(([h, sub]) => `<li>${h}${sub.length ? `<ul>${sub.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    let m;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      flush();
      const lvl = Math.min(6, m[1].length + 2); // # → h3 inside the page
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
      flush();
      const q = [m[1]];
      while (i + 1 < lines.length && (m = lines[i + 1].match(/^\s*&gt;\s?(.*)$/))) { q.push(m[1]); i++; }
      out.push(`<blockquote>${renderMarkdown(q.join('\n').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      const nested = m[1].length >= 2 && list;
      if (nested) { list.items[list.items.length - 1][1].push(inline(m[3])); continue; }
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push([inline(m[3]), []]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1][0] += ` ${inline(line.trim())}`; continue; }
    flushList();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

/** First paragraph as plain text (for short previews). */
export function markdownSummary(src, max = 180) {
  const first = String(src || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#')) || '';
  const plain = first.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~>#]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, '')}…` : plain;
}

/** Markdown → plain text (links keep their label, formatting marks removed). */
export function markdownPlain(src) {
  return String(src || '')
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/[|*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shorten plain text to about `max` characters: end at a sentence if one ends late enough,
 *  otherwise at a word boundary, and add an ellipsis. Returns { text, cut }. */
export function smartTrim(text, max = 300) {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max + 1);
  const ends = [...head.matchAll(/[.!?…](?=\s|$)/g)].map((m) => m.index + 1);
  const sentence = ends.filter((i) => i >= max * 0.6).pop();
  if (sentence) return { text: head.slice(0, sentence), cut: true };
  const word = head.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s,;:–-]+$/, '');
  return { text: `${word}…`, cut: true };
}

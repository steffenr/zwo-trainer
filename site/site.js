// zwoTrainer site: theme toggle, scroll reveal, decorative workout bars, stagger indexes for the motion rules
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  var KEY = 'zt-site-theme';
  try { var t = localStorage.getItem(KEY); if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); } catch (e) {}
  function isDark() {
    var t = root.getAttribute('data-theme');
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function paint() { document.querySelectorAll('.theme-btn').forEach(function (b) { b.innerHTML = isDark() ? SUN : MOON; b.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode'); }); }
  var fadeT;
  document.addEventListener('DOMContentLoaded', function () {
    paint();
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var next = isDark() ? 'light' : 'dark';
        // cross-fade the colours for a moment instead of snapping (no-op under Reduce motion)
        root.classList.add('theme-anim');
        clearTimeout(fadeT); fadeT = setTimeout(function () { root.classList.remove('theme-anim'); }, 320);
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) {}
        paint();
        b.classList.remove('swap'); void b.offsetWidth; b.classList.add('swap');
      });
    });
    // decorative workout profiles: a sweet-spot-ish block structure in zone colours
    var Z = ['var(--z1)', 'var(--z2)', 'var(--z3)', 'var(--z4)', 'var(--z5)'];
    document.querySelectorAll('[data-bars]').forEach(function (el) {
      var shape = el.getAttribute('data-bars').split(',').map(Number);
      el.innerHTML = shape.map(function (h) {
        var z = h < 40 ? 0 : h < 58 ? 1 : h < 72 ? 2 : h < 86 ? 3 : 4;
        return '<i style="height:' + h + '%;background:' + Z[z] + '"></i>';
      }).join('');
    });
    // stagger: each element's place in its group (--i), read by the motion rules in site.css
    function index(sel) { document.querySelectorAll(sel).forEach(function (el) { var i = 0; for (var s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.matches(sel)) i++; el.style.setProperty('--i', i); }); }
    ['.rv', '.zones i', '[data-bars] i', '.strip .wrap > div', '.toc a', '.ticks li', '.cards .card', '.legend span', '.nots span', '.compat > div', '.howto li'].forEach(index);
    // reveal on scroll
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -8% 0px' });
      document.querySelectorAll('.rv').forEach(function (el) { io.observe(el); });
    } else document.querySelectorAll('.rv').forEach(function (el) { el.classList.add('in'); });
  });
})();

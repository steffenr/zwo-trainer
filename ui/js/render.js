// SVG rendering: zone colours, workout diagram, mini profiles and the power gauge.

// Zone colours follow the classic Zwift / WhatsOnZwift palette.
export const ZONES = [
  { id: 1, name: 'Recovery', short: 'Z1', color: '#7f7f7f' },
  { id: 2, name: 'Base endurance', short: 'Z2', color: '#338cff' },
  { id: 3, name: 'Tempo', short: 'Z3', color: '#59bf59' },
  { id: 4, name: 'Threshold', short: 'Z4', color: '#ffcc3f' },
  { id: 5, name: 'VO2max', short: 'Z5', color: '#ff6639' },
];
export const FREE_COLOR = '#b4bac2';

/** bounds: upper limits (in % FTP) of Z1..Z4, e.g. [55, 75, 90, 105] */
export function zoneOf(frac, bounds) {
  if (frac === null || frac === undefined) return null;
  const pct = frac * 100;
  for (let i = 0; i < bounds.length; i++) if (pct <= bounds[i] + 1e-9) return ZONES[i];
  return ZONES[4];
}
export const zoneColor = (frac, bounds) => (frac === null ? FREE_COLOR : zoneOf(frac, bounds).color);
/** Readable text colour for a zone (CSS variable, differs between light and dark theme). */
export const zoneInk = (frac, bounds) => (frac === null || frac === undefined ? 'var(--muted)' : `var(--z${zoneOf(frac, bounds).id}-ink)`);

const svgNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

export const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
export const fmtDur = (s) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`;
};

/** Small static profile from compact [dur, p0, p1] tuples. Returns an SVG string. */
export function miniProfile(profile, bounds, { width = 240, height = 40 } = {}) {
  const total = profile.reduce((a, p) => a + p[0], 0) || 1;
  const maxP = Math.max(1.2, ...profile.flatMap((p) => [p[1] ?? 0.6, p[2] ?? 0.6])) * 1.05;
  let x = 0, out = '';
  for (const [d, p0, p1] of profile) {
    const w = (d / total) * width;
    const a = p0 ?? 0.55, b = p1 ?? 0.55;
    const y0 = height - (a / maxP) * height, y1 = height - (b / maxP) * height;
    const c = p0 === null ? FREE_COLOR : zoneColor((a + b) / 2, bounds);
    out += `<path d="M${x.toFixed(2)},${height}L${x.toFixed(2)},${y0.toFixed(2)}L${(x + w).toFixed(2)},${y1.toFixed(2)}L${(x + w).toFixed(2)},${height}Z" fill="${c}"/>`;
    x += w;
  }
  return `<svg class="mini" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${out}</svg>`;
}

/**
 * Interactive workout diagram. Draws once; update(t, samples) moves the position line,
 * the completed bar and the live overlay lines (power, cadence, heart rate).
 */
export class Diagram {
  constructor(container, workout, { bounds, ftp, maxHr = 185, overlay = { power: true }, onSelect } = {}) {
    this.c = container;
    this.w = workout;
    this.bounds = bounds;
    this.ftp = ftp;
    this.maxHr = maxHr;
    this.overlay = overlay;
    this.onSelect = onSelect;
    this.W = 1000;
    this.H = 220;
    this.top = 22;
    this.draw();
  }

  get scale() { return this.adjust || 1; }

  draw() {
    const { W, H, top } = this;
    const total = this.w.duration || 1;
    const maxP = Math.max(1.2, ...this.w.segments.map((s) => Math.max(s.p0 ?? 0, s.p1 ?? 0))) * 1.08;
    this.maxP = maxP;
    const y = (p) => H - (p / maxP) * (H - top);
    const x = (t) => (t / total) * W;
    this.x = x; this.y = y;

    this.c.innerHTML = '';
    // The bars stretch with the window (preserveAspectRatio none); all text lives in HTML
    // layers on top so it keeps its proportions at any size (full screen included).
    const stage = document.createElement('div');
    stage.className = 'dg-stage';
    this.c.append(stage);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'diagram-svg' }, stage);
    this.svg = svg;
    const freeLayer = document.createElement('div');
    freeLayer.className = 'dg-free';
    stage.append(freeLayer);
    const labels = document.createElement('div');
    labels.className = 'dg-labels';
    this.c.append(labels);
    this.labels = labels;
    const pct = (v) => `${((v / W) * 100).toFixed(3)}%`;

    // grid: watt axis (HTML labels, nice steps) + FTP line
    const maxW = maxP * (this.ftp || 250);
    const step = [20, 25, 40, 50, 80, 100, 150, 200, 250, 500].find((st) => maxW / st <= 5) || 500;
    const axis = document.createElement('div');
    axis.className = 'dg-yaxis';
    for (let w = 0; w <= maxW; w += step) {
      const f = w / (this.ftp || 250);
      if (w > 0) el('line', { x1: 0, x2: W, y1: y(f), y2: y(f), class: 'grid' }, svg);
      const lab = document.createElement('span');
      lab.textContent = w;
      lab.style.top = `${(y(f) / H) * 100}%`;
      axis.append(lab);
    }
    stage.append(axis);
    el('line', { x1: 0, x2: W, y1: y(1), y2: y(1), class: 'grid ftp' }, svg);

    this.segEls = this.w.segments.map((s, i) => {
      const a = s.p0 ?? 0.5, b = s.p1 ?? 0.5;
      const x0 = x(s.start), x1 = x(s.start + s.duration);
      const color = s.p0 === null ? FREE_COLOR : zoneColor((a + b) / 2, this.bounds);
      const g = el('g', { class: 'seg', 'data-i': i }, svg);
      el('path', { d: `M${x0},${H} L${x0},${y(a)} L${x1},${y(b)} L${x1},${H} Z`, fill: color }, g);
      if (s.p0 === null) {
        const f = document.createElement('span');
        f.style.left = pct(x0); f.style.width = pct(x1 - x0);
        f.textContent = 'free';
        freeLayer.append(f);
      }
      g.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect?.(i, s); });
      // labels below — hidden by fitLabels() when the segment is too narrow on screen
      const lab = document.createElement('span');
      lab.style.left = pct(x0); lab.style.width = pct(x1 - x0);
      lab.textContent = s.reps ? `${s.label}${toSup(s.rep)}` : s.label;
      labels.append(lab);
      el('line', { x1: x0, x2: x0, y1: top - 4, y2: H, class: 'seg-sep' }, svg);
      return g;
    });

    this.traces = {
      hr: el('polyline', { class: 'trace trace-hr', points: '' }, svg),
      cadence: el('polyline', { class: 'trace trace-cad', points: '' }, svg),
      power: el('polyline', { class: 'trace trace-pow', points: '' }, svg),
    };
    this.setOverlay(this.overlay);
    this.done = el('rect', { x: 0, y: H - 4, width: 0, height: 4, class: 'done-bar' }, svg);
    this.pos = el('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'pos-line' }, svg);
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.fitLabels());
    this.ro.observe(this.c);
  }

  /** Show a segment label only if it fits its segment's on-screen width. */
  fitLabels() {
    for (const lab of this.labels.children) {
      lab.classList.remove('hide');
      if (lab.clientWidth < 22 || lab.scrollWidth > lab.clientWidth + 1) lab.classList.add('hide');
    }
  }

  highlight(i) {
    this.segEls.forEach((g, j) => g.classList.toggle('current', j === i));
  }

  setOverlay(o) {
    this.overlay = { ...o };
    for (const [k, line] of Object.entries(this.traces)) line.style.display = o[k] ? '' : 'none';
  }

  update(t, samples) {
    const X = this.x(t);
    this.pos.setAttribute('x1', X); this.pos.setAttribute('x2', X);
    this.done.setAttribute('width', X);
    if (!samples || !samples.length) return;
    const step = Math.max(1, Math.floor(samples.length / 700));
    const h = this.H - this.top;
    const clampY = (y) => Math.max(0, Math.min(this.H, y)).toFixed(1);
    const series = {
      // power: 3 s rolling average, same scale as the workout bars
      power: (i) => {
        let sum = 0, n = 0;
        for (let j = Math.max(0, i - 2); j <= i; j++) if (samples[j].p != null) { sum += samples[j].p; n++; }
        return n && this.ftp ? this.y(Math.min(sum / n / this.ftp, this.maxP)) : null;
      },
      // cadence: 0–150 rpm over the full height
      cadence: (i) => (samples[i].c != null ? this.H - (Math.min(samples[i].c, 150) / 150) * h : null),
      // heart rate: 0–max HR over the full height
      hr: (i) => (samples[i].hr ? this.H - (Math.min(samples[i].hr, this.maxHr) / this.maxHr) * h : null),
    };
    for (const [k, fn] of Object.entries(series)) {
      if (!this.overlay[k]) continue;
      let pts = '';
      for (let i = 0; i < samples.length; i += step) {
        const y = fn(i);
        if (y != null) pts += `${this.x(samples[i].t).toFixed(1)},${clampY(y)} `;
      }
      this.traces[k].setAttribute('points', pts);
    }
  }
}

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const toSup = (n) => String(n).split('').map((d) => SUP[+d]).join('');

/** Ring gauge: outer = target, inner = actual, blue tick = FTP. */
export class Gauge {
  constructor(container) {
    this.c = container;
    const S = 200, cx = 100, cy = 100;
    this.cx = cx; this.cy = cy;
    this.start = 135; this.sweep = 270;
    const svg = el('svg', { viewBox: `0 0 ${S} ${S}`, class: 'gauge-svg' }, container);
    this.svg = svg;
    el('path', { d: this.arc(86, 0, 1), class: 'g-track' }, svg);
    this.innerTrack = el('path', { d: this.arc(68, 0, 1), class: 'g-track inner' }, svg);
    this.target = el('path', { d: '', class: 'g-target' }, svg);
    this.actual = el('path', { d: '', class: 'g-actual' }, svg);
    this.ftpTick = el('line', { class: 'g-ftp' }, svg);
  }

  pt(r, f) {
    const a = ((this.start + this.sweep * f) * Math.PI) / 180;
    return [this.cx + r * Math.cos(a), this.cy + r * Math.sin(a)];
  }

  arc(r, f0, f1) {
    f1 = Math.max(f0 + 0.0001, Math.min(1, f1));
    const [x0, y0] = this.pt(r, f0), [x1, y1] = this.pt(r, f1);
    const large = this.sweep * (f1 - f0) > 180 ? 1 : 0;
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }

  update({ target, actual, ftp, bounds }) {
    const max = Math.max(ftp * 1.5, (target || 0) * 1.1, (actual || 0) * 1.05) || 1;
    if (target) {
      this.target.setAttribute('d', this.arc(86, 0, target / max));
      this.target.style.stroke = zoneColor(target / ftp, bounds);
    } else this.target.setAttribute('d', '');
    if (actual) {
      this.actual.setAttribute('d', this.arc(68, 0, actual / max));
      this.actual.style.stroke = zoneColor(actual / ftp, bounds);
    } else this.actual.setAttribute('d', '');
    const [x0, y0] = this.pt(76, ftp / max), [x1, y1] = this.pt(96, ftp / max);
    Object.entries({ x1: x0, y1: y0, x2: x1, y2: y1 }).forEach(([k, v]) => this.ftpTick.setAttribute(k, v));
  }
}

/** Circular segment progress. */
export class ProgressRing {
  constructor(container) {
    this.g = new Gauge(container);
    this.g.svg.classList.add('progress-svg');
    // a progress ring has a single line: segment progress (the watt gauge's inner
    // "actual power" track, FTP tick and actual arc don't belong here)
    this.g.ftpTick.remove();
    this.g.actual.remove();
    this.g.innerTrack.remove();
  }
  update(frac, color) {
    this.g.target.setAttribute('d', frac > 0 ? this.g.arc(86, 0, frac) : '');
    this.g.target.style.stroke = color;
  }
}

// Serialize presentation changes around the native window resize. The Ride and its loop
// keep running; failed transitions leave the previous view in place and can be retried.
export class CompactView {
  constructor({ resize, apply, report }) {
    this.resize = resize;
    this.apply = apply;
    this.report = report;
    this.active = false;
    this.busy = false; // true while the native window resizes: its in-between sizes are not the rider's choice
    this.pending = Promise.resolve();
  }

  /** Switch compact on or off. Calls are queued, so a fast double click can't interleave two resizes;
   * resolves true when the requested view is shown (false: the native resize failed, nothing changed). */
  set(active) {
    this.pending = this.pending.then(async () => {
      if (this.active === active) return true;
      this.busy = true;
      try {
        try {
          await this.resize(active);
        } catch (error) {
          this.report(error);
          return false;
        }
        this.active = active;
        this.apply(active);
        return true;
      } finally {
        this.busy = false;
      }
    });
    return this.pending;
  }

  /** Leaving the ride: like set(false), but the native side retries once and, if the window still can't be
   * restored, resets the minimum size and forgets its snapshot (`leave`). Either way the full view is applied,
   * so the next ride starts from a clean state; resolves false (after reporting) when the restore failed. */
  leave() {
    this.pending = this.pending.then(async () => {
      if (!this.active) return true;
      this.busy = true;
      let ok = true;
      try {
        await this.resize(false, true);
      } catch (error) {
        this.report(error);
        ok = false;
      }
      this.active = false;
      this.apply(false);
      this.busy = false;
      return ok;
    });
    return this.pending;
  }
}

// Pure logic of the compact ride view (see docs/superpowers/specs/2026-11-20-compact-graph-layout-design.md).
// No DOM and no imports, so node can test it. The DOM glue lives in ride.js, render.js and (fitTexts) below.

/**
 * Layout and what fits at a window size. layout: 'h' (wide: rail, live block, graph across) or 'v' (narrow:
 * live block on top, graph down). live: gauge on top ('col') or beside the target and tiles ('row').
 * foot: where play / workout left sit ('foot' bottom row, 'head' heading row when short, 'rail' horizontal).
 */
export function compactMode(width, height) {
  if (width >= 640 && width >= 1.5 * height) return { layout: 'h', live: 'row', graph: true, foot: 'rail', tiles: true };
  return { layout: 'v', live: height >= 520 ? 'col' : 'row', graph: height >= 360, foot: height < 244 ? 'head' : 'foot', tiles: height >= 190 };
}

/** Largest font size in [min, max] at which `measure(size)` (width in px) still fits `avail`. */
export function fitFontSize(measure, avail, min, max) {
  for (let size = max; size > min; size--) if (measure(size) <= avail) return size;
  return min;
}

/**
 * What a segment asks of the rider, with the intensity multiplier m and FTP F applied.
 * kind: 'allout' (erg === false), 'maxeffort' / 'free' (no target), 'range' (ramp, a → b), 'watts' (a).
 */
export function levelView(seg, m, F) {
  if (seg.erg === false) return { kind: 'allout' };
  if (seg.p0 === null) return { kind: seg.type === 'maxeffort' ? 'maxeffort' : 'free' };
  const a = Math.round(seg.p0 * F * m), b = Math.round(seg.p1 * F * m);
  return seg.p0 === seg.p1 ? { kind: 'watts', a, b } : { kind: 'range', a, b };
}

/** How far (px) the text of `el` sticks out of the space its layout gives it; <= 0 means it fits. */
function overflowOf(el) {
  const tgt = el.closest('.cp-tgt'), tile = el.closest('.cp-tile'), head = el.closest('.compact-head');
  const foot = el.closest('.compact-foot'), ph = el.closest('.cp-ph'), dial = el.closest('.cp-dial');
  if (tgt) return () => tgt.scrollWidth - tgt.clientWidth;
  if (tile) return () => tile.scrollWidth - tile.clientWidth;
  if (head) { // right-aligned row beside the macOS window buttons: what does not fit sticks out to the left of its content box
    return () => {
      const left = head.getBoundingClientRect().left + parseFloat(getComputedStyle(head).paddingLeft);
      const first = [...head.children].find((c) => c.getClientRects().length);
      return first ? Math.max(0, left - first.getBoundingClientRect().left) : 0;
    };
  }
  if (foot) return () => foot.scrollWidth - foot.clientWidth;
  if (ph) return () => ph.scrollWidth - ph.clientWidth;
  if (dial) return () => el.getBoundingClientRect().width - dial.clientWidth * 0.62; // the number lives inside the gauge ring
  return () => el.scrollWidth - el.clientWidth;
}

/**
 * Shrink the long values of the compact view to fit: every element with data-fit="<floor px>" goes back to its
 * CSS size, then down 1 px at a time (never below the floor) until it no longer sticks out. Call it when such a
 * text changed its length or the window size changed, not on every tick.
 */
export function fitTexts(root) {
  // transitions off while measuring: with "Reduce motion" every property has a (tiny) transition, and a size
  // set a moment ago would still read as the old one
  root.classList.add('fit-measuring');
  try {
    for (const el of root.querySelectorAll('[data-fit]')) {
      if (!el.getClientRects().length) continue; // not shown in this layout
      el.style.fontSize = '';
      const natural = parseFloat(getComputedStyle(el).fontSize), floor = Math.min(Number(el.dataset.fit), natural);
      const over = overflowOf(el);
      if (over() <= 0.5) continue;
      el.style.fontSize = `${fitFontSize((size) => { el.style.fontSize = `${size}px`; return over(); }, 0.5, floor, natural)}px`;
    }
  } finally {
    root.classList.remove('fit-measuring');
  }
}

/** Scale of the compact graph: the same rule as the full view's Diagram. */
export const maxPOf = (segments) => Math.max(1.2, ...segments.flatMap((s) => [s.p0 ?? 0, s.p1 ?? 0])) * 1.08;

/**
 * Corner points of one segment's bar as an SVG polygon string. Horizontal: time runs left to right over
 * `length`, power grows upwards in `breadth` below `top`. Vertical: time runs down over `length`, power grows
 * to the right of `gutter` within `breadth`. Free segments (no p) are drawn at 0.5.
 */
export function segmentPoints(seg, { orientation, total, maxP, length, breadth, top = 0, gutter = 0 }) {
  const a = seg.p0 ?? 0.5, b = seg.p1 ?? 0.5;
  const t0 = (seg.start / total) * length, t1 = ((seg.start + seg.duration) / total) * length;
  const pts = orientation === 'h'
    ? (() => { const y = (p) => breadth - (p / maxP) * (breadth - top); return [[t0, breadth], [t0, y(a)], [t1, y(b)], [t1, breadth]]; })()
    : (() => { const x = (p) => gutter + (p / maxP) * (breadth - gutter); return [[gutter, t0], [x(a), t0], [x(b), t1], [gutter, t1]]; })();
  return pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

// Block sizes of the vertical labels with the large (up to 24 px) watts line; the heights include the descent below the last baseline
const NOW_MIN = 54, NEXT_3 = 52, NEXT_2 = 40, GAP = 2;
/**
 * Vertical graph labels. NOW sits above the position line (its bottom, `nowBase`, is at least NOW_MIN from the
 * top), NEXT below the next segment's start (`yNext`, null without a next segment). NEXT is pulled up so it
 * fits the bottom; if it would then touch NOW, its third line goes, then the whole label.
 */
export function placeGraphLabels({ height, yNow, yNext }) {
  const nowBase = Math.max(yNow, NOW_MIN);
  if (yNext === null) return { nowBase, next: null };
  for (const [lines, h] of [[3, NEXT_3], [2, NEXT_2]]) {
    const top = Math.min(yNext, height - h);
    if (top >= nowBase + GAP) return { nowBase, next: { top, lines } };
  }
  return { nowBase, next: null };
}

/**
 * Horizontal graph labels. now / next are [full, short] strings; `measure(string)` gives the width in px.
 * Now ends left of the position line (xNow); when even its short form does not fit there, it moves to the
 * right of the line (nowSide 'right', and Next then has to clear it). Next starts right of the next segment's
 * start (xNext). A label that does not fit becomes ''.
 */
export function fitHorizontalLabels({ width, xNow, xNext, now, next, measure }) {
  const left = xNow - 6;
  let nowText, nowSide = 'left', nextFrom = 0;
  if (measure(now[0]) <= left) nowText = now[0];
  else if (measure(now[1]) <= left) nowText = now[1];
  else {
    nowSide = 'right';
    const end = xNow + 6 + measure(now[1]);
    nowText = end <= width ? now[1] : '';
    if (nowText) nextFrom = end + 8;
  }
  if (!next) return { now: nowText, next: '', nowSide };
  const fits = (s) => xNext + 6 >= nextFrom && xNext + 6 + measure(s) <= width;
  return { now: nowText, next: fits(next[0]) ? next[0] : fits(next[1]) ? next[1] : '', nowSide };
}

// Client-side helpers for workouts already parsed by zwo.rs (load_workout / scan_library).
// Segments: { start, duration, p0, p1, ... }; power values are fractions of FTP, p0 === null for free ride.

/** Target power fraction at elapsed second `sec` within a segment (linear ramps). */
export function powerAt(seg, sec) {
  if (!seg || seg.p0 === null) return null;
  if (seg.p0 === seg.p1 || seg.duration <= 1) return seg.p0;
  const f = Math.min(1, Math.max(0, sec / seg.duration));
  return seg.p0 + (seg.p1 - seg.p0) * f;
}

export function segmentAt(segments, t) {
  // binary search over start times
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.start + s.duration) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Rough training stress estimate (IF² × hours × 100) from the plan, freerides counted at 60%. */
export function estimateTss(segments) {
  let sum = 0, dur = 0;
  for (const s of segments) {
    const p0 = s.p0 ?? 0.6, p1 = s.p1 ?? 0.6;
    // integrate p^4 for normalized-power-like weighting
    const steps = Math.max(1, Math.min(20, Math.round(s.duration / 15)));
    for (let i = 0; i < steps; i++) {
      const p = p0 + (p1 - p0) * ((i + 0.5) / steps);
      sum += Math.pow(p, 4) * (s.duration / steps);
    }
    dur += s.duration;
  }
  if (!dur) return 0;
  const IF = Math.pow(sum / dur, 0.25);
  return Math.round(IF * IF * (dur / 3600) * 100);
}

/** Zone limits (fraction of FTP) used for workout classification — mirrors zwo.rs. */
export const ZONE_LIMITS = [0.55, 0.75, 0.90, 1.05];
export function zoneSeconds(segments) {
  const out = [0, 0, 0, 0, 0];
  for (const s of segments) {
    if (s.p0 == null || s.p1 == null) continue;
    const d = Math.max(1, s.duration);
    for (let i = 0; i < d; i++) {
      const p = s.p0 + (s.p1 - s.p0) * ((i + 0.5) / d);
      const z = ZONE_LIMITS.findIndex((l) => p <= l + 1e-9);
      out[z < 0 ? 4 : z]++;
    }
  }
  return out;
}
export function mainZone(zt) {
  const work = zt.reduce((a, b) => a + b, 0);
  if (!work) return 2;
  const need = Math.max(60, Math.floor(work * 0.08));
  for (let z = 4; z >= 1; z--) if (zt[z] >= need) return z + 1;
  return 1;
}
export function classify(segments) {
  const zt = zoneSeconds(segments);
  zt[1] += segments.filter((s) => s.p0 == null).reduce((a, s) => a + s.duration, 0);
  return mainZone(zt);
}

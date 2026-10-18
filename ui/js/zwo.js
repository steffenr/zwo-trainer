// ZWO (Zwift workout) parser — works in the browser and in Node (no DOM needed).
// Produces a flat list of timed segments. Power values are fractions of FTP.

const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;

function attrs(str) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str))) out[m[1].toLowerCase()] = decode(m[2]);
  return out;
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decode(m[1].trim()) : '';
}

const num = (v, d = null) => {
  if (v === undefined || v === null || v === '') return d;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

// Some third-party files store power in watts-ish or percent; Zwift uses fractions.
const frac = (v) => {
  const n = num(v);
  if (n === null) return null;
  return n > 5 ? n / 100 : n;
};

function cadenceOf(a, prefix = '') {
  const c = num(a[prefix + 'cadence']);
  const lo = num(a[prefix + 'cadencelow']);
  const hi = num(a[prefix + 'cadencehigh']);
  if (c) return { cadence: c };
  if (lo && hi) return { cadence: Math.round((lo + hi) / 2), cadenceLow: lo, cadenceHigh: hi };
  return {};
}

/**
 * Parse ZWO XML into { name, author, description, tags, segments, duration }.
 * segment: { idx, label, type, start, duration, p0, p1, cadence?, freeRide?, texts: [{t, msg}] }
 */
export function parseZwo(xml) {
  const workoutBody = (xml.match(/<workout>([\s\S]*?)<\/workout>/i) || [])[1] || '';
  const meta = {
    name: tagText(xml, 'name'),
    author: tagText(xml, 'author'),
    description: tagText(xml, 'description'),
    tags: [...xml.matchAll(/<tag\s+([^>]*?)\/?>/gi)].map((m) => attrs(m[1]).name).filter(Boolean),
  };

  // Tokenise top-level elements inside <workout>. Elements are either self-closing
  // or contain <textevent/> children.
  const elRe = /<([A-Za-z]+)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;
  const segments = [];
  const globalTexts = [];
  let t = 0;
  let block = 0;
  let m;

  const push = (seg, texts) => {
    seg.start = t;
    seg.texts = texts.filter((x) => x.t < seg.duration);
    segments.push(seg);
    t += seg.duration;
  };

  while ((m = elRe.exec(workoutBody))) {
    const tag = m[1].toLowerCase();
    const a = attrs(m[2]);
    const inner = m[4] || '';
    const texts = [...inner.matchAll(/<textevent\b([^>]*?)\/?>/gi)].map((x) => {
      const ta = attrs(x[1]);
      return { t: num(ta.timeoffset, 0), msg: ta.message || '' };
    });

    if (tag === 'textevent') {
      globalTexts.push({ t: num(a.timeoffset, 0), msg: a.message || '' });
      continue;
    }

    const dur = Math.round(num(a.duration, 0));
    block += 1;

    switch (tag) {
      case 'steadystate':
      case 'solidstate': {
        const p = frac(a.power ?? a.powerlow);
        push({ idx: block, label: `${block}`, type: 'steady', duration: dur, p0: p, p1: p, ...cadenceOf(a) }, texts);
        break;
      }
      case 'warmup':
      case 'cooldown':
      case 'ramp': {
        // Zwift semantics: PowerLow is the start value, PowerHigh the end value
        // (cooldowns are written with PowerLow > PowerHigh).
        push({
          idx: block, label: `${block}`, type: tag, duration: dur,
          p0: frac(a.powerlow), p1: frac(a.powerhigh), ...cadenceOf(a),
        }, texts);
        break;
      }
      case 'intervalst': {
        const reps = Math.max(1, Math.round(num(a.repeat, 1)));
        const onD = Math.round(num(a.onduration, 0));
        const offD = Math.round(num(a.offduration, 0));
        const onP = frac(a.onpower ?? a.poweronhigh ?? a.poweronlow);
        const offP = frac(a.offpower ?? a.poweroffhigh ?? a.powerofflow);
        const onCad = cadenceOf(a);
        const offCad = num(a.cadenceresting) ? { cadence: num(a.cadenceresting) } : {};
        const period = onD + offD;
        for (let r = 0; r < reps; r++) {
          // textevents inside IntervalsT have offsets relative to the whole block
          const base = r * period;
          const tOn = texts.filter((x) => x.t >= base && x.t < base + onD).map((x) => ({ t: x.t - base, msg: x.msg }));
          const tOff = texts.filter((x) => x.t >= base + onD && x.t < base + period).map((x) => ({ t: x.t - base - onD, msg: x.msg }));
          if (onD > 0) push({ idx: block, label: `${block}.1`, rep: r + 1, reps, type: 'on', duration: onD, p0: onP, p1: onP, ...onCad }, tOn);
          if (offD > 0) push({ idx: block, label: `${block}.2`, rep: r + 1, reps, type: 'off', duration: offD, p0: offP, p1: offP, ...offCad }, tOff);
        }
        break;
      }
      case 'freeride':
      case 'maxeffort': {
        push({ idx: block, label: `${block}`, type: tag === 'maxeffort' ? 'maxeffort' : 'freeride', duration: dur, p0: null, p1: null, freeRide: true, ...cadenceOf(a) }, texts);
        break;
      }
      default:
        block -= 1; // unknown element, ignore
    }
  }

  // Attach workout-level text events (absolute offsets) to their segments.
  for (const g of globalTexts) {
    const s = segments.find((x) => g.t >= x.start && g.t < x.start + x.duration);
    if (s) s.texts.push({ t: g.t - s.start, msg: g.msg });
  }
  segments.forEach((s) => s.texts.sort((a, b) => a.t - b.t));

  return { ...meta, segments, duration: t };
}

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

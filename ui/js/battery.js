// Battery badge for the devices popover: a small battery icon, filled to the level and coloured by state,
// followed by the percentage. Pure functions, no DOM access.

/** 'ok' from 40 %, 'low' from 16 %, 'critical' at 15 % and below, null when the level is unknown. */
export function batteryState(level) {
  if (typeof level !== 'number' || Number.isNaN(level)) return null;
  return level >= 40 ? 'ok' : level > 15 ? 'low' : 'critical';
}

/** The weakest level of several devices ({ id: level }), null when there are none. */
export function lowestLevel(levels) {
  const v = Object.values(levels || {}).filter((n) => typeof n === 'number');
  return v.length ? Math.min(...v) : null;
}

/** Icon + percentage as HTML; '' when the level is unknown. `label` is the accessible, already translated text;
 *  `fmt` writes the percentage in the UI language (i18n `pct`). */
export function batteryBadge(level, label, fmt = (n) => `${n}%`) {
  const state = batteryState(level);
  if (!state) return '';
  const pct = Math.max(0, Math.min(100, Math.round(level)));
  const fill = pct === 0 ? 0 : Math.max(1, Math.round((pct / 100) * 16));
  return `<span class="batt ${state}" role="img" aria-label="${label}" title="${label}">`
    + `<svg viewBox="0 0 24 14" aria-hidden="true"><rect class="body" x="1" y="1.5" width="19" height="11" rx="2.5"/>`
    + `<rect class="cap" x="21" y="5" width="2" height="4" rx="1"/>`
    + `<rect class="fill" x="3" y="3.5" width="${fill}" height="7" rx="1"/></svg>`
    + `<span class="pct">${fmt(pct)}</span></span>`;
}

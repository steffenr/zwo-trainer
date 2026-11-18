// Inline SVG icons (24×24, stroke = currentColor). All are trusted markup (Safe), so they can go
// straight into html`` templates and, via toString(), into legacy template strings.
import { raw } from '../html.js';

/** Line icon sized by CSS (.ic: 20 px, smaller/larger per context). */
const ic = (d, extra = '') => raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"${extra}>${d}</svg>`);
/** Fixed-size stroke icon for buttons and status lines. */
const fixed = (size, width, d) => raw(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);

export const IC = {
  // UI
  x: fixed(18, 2, '<path d="M6 6l12 12M18 6 6 18"/>'),
  check: fixed(14, 2.6, '<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  download: fixed(16, 2.2, '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  // ride screen
  pulse: ic('<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>', ' style="opacity:.6"'),
  bolt: ic('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  cad: ic('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M12 10V3.5M13.7 13l4.6 4.6"/>'),
  speed: ic('<path d="M3.5 17a9 9 0 1 1 17 0"/><path d="m12 14 4.5-4.5"/>'),
  heart: ic('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  target: ic('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  watch: ic('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M10 2h4M19 6l-1.5 1.5"/>'),
  flag: ic('<path d="M5 21V4M5 4h12l-2.5 4L17 12H5"/>'),
  layers: ic('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  dial: ic('<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 14 3-4"/>'),
  bars: ic('<path d="M5 20v-8M12 20V5M19 20v-5"/>'),
  chat: ic('<path d="M4 5h16v11H10l-5 4v-4H4z"/>'),
  flame: ic('<path d="M12 3c.8 3.6 5 5.4 5 10a5 5 0 0 1-10 0c0-2.4 1.3-3.9 2.4-5 .3 1.9 1.2 2.9 2.4 3-.6-2.9-.4-5.4.2-8z"/>'),
  plug: ic('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'),
  expand: ic('<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M3 3l6 6M21 3l-6 6M21 21l-6-6M3 21l6-6"/>'),
};

// Helpers for css/components/avatar.css. The rider picks any fill colour, so the initials ink follows it.

const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };

/** WCAG relative luminance of a #rrggbb colour (0 = black, 1 = white). */
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Initials ink on an avatar fill: 'dark' (black) when it contrasts more than white, else 'light'.
 *  The crossover is at luminance ≈ 0.179, where both give 4.58:1. */
export function avatarInk(hex) {
  const l = luminance(hex);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? 'dark' : 'light';
}

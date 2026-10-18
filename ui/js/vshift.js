// Virtual shifting: a virtual 24-speed drivetrain.
// cadence × gear ratio × wheel circumference → virtual speed → watts needed on a flat road
// (rolling resistance + aerodynamic drag), held by the trainer in ERG mode. Works with any
// FTMS smart trainer; shifting via Zwift Ride/Click/Play, keyboard or on-screen buttons.

export const WHEEL_M = 2.105;         // 700×25c circumference
const RHO = 1.225, CDA = 0.32, CRR = 0.004, G = 9.81, DRIVETRAIN = 0.97, BIKE_KG = 9;

export const DIFFICULTY = { easy: 0.8, medium: 1.0, hard: 1.25 };

export const DEFAULT_SHIFTING = { mode: 'ask', difficulty: 'medium', minRatio: 0.75, maxRatio: 5.0, gears: 24, startGear: 16 };

/** Gear ratios (chainring/cog) spaced geometrically between min and max. */
export function gearTable({ minRatio = 0.75, maxRatio = 5.0, gears = 24 } = {}) {
  const n = Math.max(2, Math.round(gears));
  const k = Math.pow(maxRatio / minRatio, 1 / (n - 1));
  return Array.from({ length: n }, (_, i) => Math.round(minRatio * Math.pow(k, i) * 100) / 100);
}

/** Virtual speed in km/h. */
export const virtualSpeed = (cadence, ratio) => ((cadence || 0) / 60) * ratio * WHEEL_M * 3.6;

/** Power (W) needed to ride `kmh` on a flat road for a rider of `kg`. */
export function flatPower(kmh, kg = 75, difficulty = 'medium') {
  const v = kmh / 3.6;
  const p = (CRR * (kg + BIKE_KG) * G * v + 0.5 * RHO * CDA * v * v * v) / DRIVETRAIN;
  return p * (DIFFICULTY[difficulty] ?? 1);
}

/** Target watts for the current cadence and gear (with a floor so the flywheel never locks). */
export function targetWatts(cadence, ratio, kg, difficulty) {
  if (!cadence || cadence < 15) return 30;
  return Math.max(30, Math.min(1500, Math.round(flatPower(virtualSpeed(cadence, ratio), kg, difficulty))));
}

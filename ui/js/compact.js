// Serialize presentation changes around the native window resize. The Ride and its loop
// keep running; failed transitions leave the previous view in place and can be retried.
export class CompactView {
  constructor({ resize, apply, report }) {
    this.resize = resize;
    this.apply = apply;
    this.report = report;
    this.active = false;
    this.pending = Promise.resolve();
  }

  /** Switch compact on or off. Calls are queued, so a fast double click can't interleave two resizes;
   * resolves true when the requested view is shown (false: the native resize failed, nothing changed). */
  set(active) {
    this.pending = this.pending.then(async () => {
      if (this.active === active) return true;
      try {
        await this.resize(active);
      } catch (error) {
        this.report(error);
        return false;
      }
      this.active = active;
      this.apply(active);
      return true;
    });
    return this.pending;
  }

  /** Leaving the ride: like set(false), but the native side retries once and, if the window still can't be
   * restored, resets the minimum size and forgets its snapshot (`leave`). Either way the full view is applied,
   * so the next ride starts from a clean state; resolves false (after reporting) when the restore failed. */
  leave() {
    this.pending = this.pending.then(async () => {
      if (!this.active) return true;
      let ok = true;
      try {
        await this.resize(false, true);
      } catch (error) {
        this.report(error);
        ok = false;
      }
      this.active = false;
      this.apply(false);
      return ok;
    });
    return this.pending;
  }
}

// Size tiers for the compact ride panels (see docs/superpowers/specs/2026-11-16-compact-three-panels-design.md).
// mode: w/n = wide/narrow (560 px), t/s = tall/short. short: controls move into the heading row.
export function compactMode(width, height) {
  const wide = width >= 560;
  return {
    mode: wide ? (height < 260 ? 'ws' : 'wt') : (height < 300 ? 'ns' : 'nt'),
    short: height < 240,
    tiny: width < 260 || height < 170,
    narrow: width < 420,
    xs: width < 300,
  };
}

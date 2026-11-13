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
}

/**
 * outsourcing.js
 * Production outsourcing (config.outsourcing, OFF by default): an external partner fills the backlog.
 * At the close of a shift with open orders the plant orders sets from the partner; they arrive in
 * finished goods at the START of a later shift (leadShifts, 1 = the next shift) and are shipped by
 * the normal OrderBook (oldest backlog first), so they are never counted twice.
 *
 * ASSUMPTIONS (the data package has no outsourcing row): EUR 150 per outsourced set, at most
 * 15 sets ordered per shift, delivery after 1 shift. Outsourced sets are not production: goodParts,
 * OEE and yield stay line-only. No randomness, so the paired comparison stays clean.
 *
 *   config.outsourcing = { enabled, maxSetsPerShift, pricePerSet, leadShifts }
 */

export const OUTSOURCING_DEFAULTS = { enabled: false, maxSetsPerShift: 15, pricePerSet: 150, leadShifts: 1 };

export class Outsourcing {
  constructor(cfg = {}) {
    this.cfg = { ...OUTSOURCING_DEFAULTS, ...cfg };
    this.pending = [];            // { arriveShift, qty }
    this.ordered = 0;             // sets ordered so far
    this.received = 0;            // sets received so far
    this.orderedThisShift = 0;
    this.receivedThisShift = 0;
  }

  get onOrder() {
    return this.pending.reduce((a, p) => a + p.qty, 0);
  }

  // Sets that arrive at the start of `shift` (1-based). Returns the quantity to add to finished goods.
  arrive(shift) {
    let n = 0;
    this.pending = this.pending.filter(p => {
      if (p.arriveShift > shift) return true;
      n += p.qty;
      return false;
    });
    this.received += n;
    this.receivedThisShift += n;
    return n;
  }

  // Called at the close of `shift`, after the order book has shipped. Never orders without a backlog,
  // never more than maxSetsPerShift, and not what is already on order.
  order(shift, backlog) {
    const qty = Math.max(0, Math.min(backlog - this.onOrder, this.cfg.maxSetsPerShift));
    if (qty > 0) {
      this.pending.push({ arriveShift: shift + this.cfg.leadShifts, qty });
      this.ordered += qty;
    }
    this.orderedThisShift = qty;
    return qty;
  }

  // Numbers for the shift row that closes now; resets the per-shift counters of the received sets
  closeShiftRow() {
    const row = { outsourced: this.receivedThisShift };
    this.receivedThisShift = 0;
    return row;
  }
}

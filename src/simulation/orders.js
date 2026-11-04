/**
 * orders.js
 * OrderBook: the Track B order rules as a pure class (no engine dependency).
 *
 * - Orders of shift s are due at the end of shift s (tick s * ticksPerShift).
 * - They are served from finished-goods stock, oldest orders first (FIFO lots).
 * - What cannot be shipped stays in the backlog and is served when stock arrives.
 * - Service level = units shipped on or before their due tick / units ordered.
 * - A unit not shipped by its due tick is a lost sale (charged once); the sale
 *   itself is kept if the unit is delivered later.
 */

export class OrderBook {
  /**
   * @param {object}   o
   * @param {number[]} o.demand               orders per shift (index 0 = shift 1)
   * @param {number}   [o.initialFinishedGoods]
   * @param {number}   [o.ticksPerShift]
   */
  constructor({ demand = [], initialFinishedGoods = 0, ticksPerShift = 480 } = {}) {
    this.demand = demand.map(d => (typeof d === 'number' ? d : Number(d.orders)));
    this.ticksPerShift = ticksPerShift;
    this.initialFinishedGoods = initialFinishedGoods;
    this.stock = initialFinishedGoods;
    this.lots = [];                 // FIFO backlog: { shift, qty }
    this.rows = [];                 // per-shift rows
    this.ordered = 0;
    this.shipped = 0;
    this.shippedOnTime = 0;
    this._producedThisShift = 0;
  }

  get backlog() {
    return this.lots.reduce((a, l) => a + l.qty, 0);
  }

  // One good part left the line.
  receive(n = 1) {
    this.stock += n;
    this._producedThisShift += n;
  }

  /**
   * Call at the end of every tick. At a due tick (multiple of ticksPerShift) it
   * books the shift's orders, ships oldest first and returns the shift row;
   * otherwise returns null.
   */
  closeTick(tick) {
    if (tick <= 0 || tick % this.ticksPerShift !== 0) return null;
    const shift = tick / this.ticksPerShift;
    const orders = this.demand[shift - 1] ?? 0;
    this.ordered += orders;
    if (orders > 0) this.lots.push({ shift, qty: orders });

    let toShip = this.stock;
    let shipped = 0;
    let onTime = 0;
    for (const lot of this.lots) {
      if (toShip <= 0) break;
      const q = Math.min(lot.qty, toShip);
      lot.qty -= q;
      toShip -= q;
      shipped += q;
      if (lot.shift === shift) onTime += q;     // only this shift's own orders are on time
    }
    this.lots = this.lots.filter(l => l.qty > 0);
    this.stock -= shipped;
    this.shipped += shipped;
    this.shippedOnTime += onTime;

    const row = {
      shift,
      produced: this._producedThisShift,
      orders,
      shipped,
      shippedOnTime: onTime,
      lostSales: orders - onTime,       // units past their due tick, charged once
      backlog: this.backlog,
      stock: this.stock,
    };
    this._producedThisShift = 0;
    this.rows.push(row);
    return row;
  }

  summary() {
    return {
      ordered: this.ordered,
      shipped: this.shipped,
      shippedOnTime: this.shippedOnTime,
      lostSales: this.ordered - this.shippedOnTime,
      backlog: this.backlog,
      stock: this.stock,
      serviceLevel: this.ordered > 0 ? this.shippedOnTime / this.ordered : 1,
      shiftsClosed: this.rows.length,
    };
  }
}

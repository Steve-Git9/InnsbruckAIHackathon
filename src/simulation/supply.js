/**
 * supply.js
 * Raw-material supply model (config.supply).
 *
 *  mode 'jit' (default): no raw stock. The source behaves exactly as in the
 *    starter and the supplier outage (config.source.outage) is a halt of the
 *    source. This keeps the four reference scenarios unchanged.
 *
 *  mode 'inventory': raw stock sits in front of the source; each release
 *    consumes one unit (FIFO lots, each with its own price multiplier).
 *    An (s,Q) policy orders Q units when stock + on-order <= s, with a supplier
 *    lead time. During the outage window config.source.outage = {startTick,endTick}
 *    the primary supplier ships nothing: orders placed in the window ship at its
 *    end and deliveries that would arrive inside it arrive right after it.
 *    Countermeasures: starting safety stock, a second supplier (price premium,
 *    qualification cost, own lead time) and expediting (price premium, short
 *    lead time) -- both only used when the primary is out.
 *
 * Lead times of the second supplier and of expediting are ASSUMPTIONS (the data
 * package gives only the price premiums), as is the raw-stock holding rate
 * (no rate-card row: defaults to the WIP holding rate, 0.3 EUR/unit/h).
 *
 *   config.supply = {
 *     mode: 'jit' | 'inventory',
 *     reorderPoint, orderQty, leadTime,       // ticks
 *     initialStock,                           // units already on hand at tick 0
 *     secondSupplier: { enabled, leadTime, premium },   // premium as fraction (0.08)
 *     expediting:     { enabled, leadTime, premium },   // (0.40)
 *     holdingCostRaw,                         // EUR/unit/h
 *   }
 */

export const SUPPLY_DEFAULTS = {
  mode: 'jit',
  reorderPoint: 60,
  orderQty: 100,
  leadTime: 480,
  initialStock: null,            // null -> reorderPoint + orderQty
  secondSupplier: { enabled: false, leadTime: 240, premium: 0.08, qualification: 2000 },
  expediting:     { enabled: false, leadTime: 60,  premium: 0.40 },
  holdingCostRaw: 0.3,
};

// Backup supplier of the jit mode (config.source.backupSupplier): the lead time, price premium and
// qualification cost of the second supplier of the inventory mode -- one set of numbers.
export function backupSupplierDefaults() {
  const { leadTime, premium, qualification } = SUPPLY_DEFAULTS.secondSupplier;
  return { enabled: true, leadTime, premium, qualification };
}

export function normaliseSupply(cfg = {}) {
  return {
    ...SUPPLY_DEFAULTS,
    ...cfg,
    secondSupplier: { ...SUPPLY_DEFAULTS.secondSupplier, ...(cfg.secondSupplier ?? {}) },
    expediting:     { ...SUPPLY_DEFAULTS.expediting,     ...(cfg.expediting ?? {}) },
  };
}

export class Supply {
  constructor(cfg, outage = null) {
    this.cfg = normaliseSupply(cfg);
    this.outage = outage;
    const start = this.cfg.initialStock ?? (this.cfg.reorderPoint + this.cfg.orderQty);
    this.lots = start > 0 ? [{ qty: start, mult: 1 }] : [];   // FIFO on-hand lots
    this.pipeline = [];                                      // { arrive, qty, mult, kind }
    this.initialStock = start;

    // accounting
    this.delivered = start;            // units that entered stock, including the initial stock
    this.released = 0;                 // units consumed by the source
    this.releasedCostMult = 0;         // sum of price multipliers of released units
    this.stockTickSum = 0;             // for raw-stock holding cost
    this.stockoutTicks = 0;            // ticks the source wanted a unit and had none
    this.orders = [];                  // log of placed orders
  }

  get stock() {
    return this.lots.reduce((a, l) => a + l.qty, 0);
  }
  get onOrder() {
    return this.pipeline.reduce((a, p) => a + p.qty, 0);
  }

  _inOutage(tick) {
    return !!this.outage && tick > this.outage.startTick && tick <= this.outage.endTick;
  }

  // Call once per tick before the source (deliveries, then re-order decision).
  step(tick) {
    // deliveries
    const due = this.pipeline.filter(p => p.arrive <= tick);
    if (due.length) {
      this.pipeline = this.pipeline.filter(p => p.arrive > tick);
      for (const p of due) {
        this.lots.push({ qty: p.qty, mult: p.mult });
        this.delivered += p.qty;
      }
    }

    // Re-order decision on the inventory position. During the outage the buyer
    // knows the primary supplier's open orders are stuck, so they do not count.
    const out = this._inOutage(tick);
    const onOrder = this.pipeline.reduce((a, p) => a + (out && p.kind === 'primary' ? 0 : p.qty), 0);
    const position = this.stock + onOrder;
    if (position <= this.cfg.reorderPoint) {
      if (out && this.cfg.secondSupplier.enabled) {
        this._order(tick, 'second', this.cfg.secondSupplier.leadTime, 1 + this.cfg.secondSupplier.premium);
      } else if (out && this.cfg.expediting.enabled) {
        this._order(tick, 'expedite', this.cfg.expediting.leadTime, 1 + this.cfg.expediting.premium);
      } else if (!this._primaryOrderPending()) {
        this._order(tick, 'primary', this.cfg.leadTime, 1);
      }
    }
    this.stockTickSum += this.stock;
  }

  _primaryOrderPending() {
    return this.pipeline.some(p => p.kind === 'primary');
  }

  _order(tick, kind, leadTime, mult) {
    let ship = tick;
    if (kind === 'primary' && this._inOutage(tick)) ship = this.outage.endTick;   // supplier is out: ships when back
    let arrive = ship + leadTime;
    if (kind === 'primary' && this._inOutage(arrive)) arrive = this.outage.endTick + 1;
    this.pipeline.push({ arrive, qty: this.cfg.orderQty, mult, kind });
    this.orders.push({ tick, kind, qty: this.cfg.orderQty, arrive, mult });
  }

  // The source asks for one unit. Returns the price multiplier, or null when out of stock.
  consume() {
    const lot = this.lots[0];
    if (!lot) { this.stockoutTicks++; return null; }
    lot.qty -= 1;
    if (lot.qty === 0) this.lots.shift();
    this.released += 1;
    this.releasedCostMult += lot.mult;
    return lot.mult;
  }

  snapshot() {
    return {
      mode: 'inventory',
      stock: this.stock,
      onOrder: this.onOrder,
      delivered: this.delivered,
      released: this.released,
      stockoutTicks: this.stockoutTicks,
      releasedCostMult: this.releasedCostMult,
      stockTickSum: this.stockTickSum,
      orders: this.orders.length,
    };
  }
}

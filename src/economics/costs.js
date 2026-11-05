/**
 * costs.js
 * Pure cost model of the Track B data package (rate_card.csv).
 *
 *   computeEconomics(result, config, baselineConfig, rateCard, opts)
 *
 * result  : { perShift, kpis, supply? } from runHeadless (either path)
 * config  : the configuration the run used (machines, buffers, supply)
 * baselineConfig : DEFAULT_CONFIG; one-time costs are derived by comparing to it
 * opts    : { initialFinishedGoods }  (the native path also reads config.initialFinishedGoods)
 *
 * Rules (DATA_README.md):
 *  - machine cost accrues for every scheduled hour, also while waiting
 *  - material is booked when a part is released (at the supplier lot's price)
 *  - holding: WIP on the average per shift; finished goods on the average stock
 *    (stock at the end of the previous shift + half of the shift's production)
 *  - lost sales: once per ordered unit not shipped by its due tick
 *  - one-time costs are amortised over 1,920 shifts; an extra machine counts
 *    the investment OR the per-shift depreciation, not both
 *  - finished goods are valued at EUR 103 (start charged, end credited)
 */

export const AMORTISATION_SHIFTS = 1920;
// Overtime has no rate-card row. ASSUMPTION: an overtime hour costs the hour rates of all
// machines on the line (they all run) plus a 50% overtime premium. Default line:
// (85 + 55 + 90 + 40) x 1.5 = EUR 405 per overtime hour. Override with config.overtime.ratePerHour.
export const OVERTIME_PREMIUM = 0.5;
export function overtimeRatePerHour(config, rate) {
  if (config.overtime?.ratePerHour != null) return config.overtime.ratePerHour;
  const line = config.machines.reduce((a, m) => a + rate[`machine_hour_rate_${baseId(m.id)}`], 0);
  return line * (1 + OVERTIME_PREMIUM);
}
export const FG_VALUE = 103;
export const SHIFT_HOURS = 8;
const TICKS_PER_SHIFT = 480;

const baseId = (id) => id.replace(/[a-z]+$/, '');

// One-time costs implied by the difference between config and baseline (EUR, not yet amortised).
export function oneTimeCosts(config, baselineConfig, rate) {
  const baseMachines = new Map(baselineConfig.machines.map(m => [m.id, m]));
  const baseBuffers = new Map(baselineConfig.buffers.map(b => [b.id, b]));

  const extraMachines = config.machines.filter(m => !baseMachines.has(m.id)).length;
  let bufferSlots = 0;
  for (const b of config.buffers) {
    const bb = baseBuffers.get(b.id);
    if (bb) bufferSlots += Math.max(0, b.capacity - bb.capacity);
  }
  let cycleTicks = 0, rejectPoints = 0;
  for (const m of config.machines) {
    // A spawned copy (M3b) is compared with the baseline machine of its station (M3): a faster
    // copy is charged for its cycle-time reduction too ("per tick per machine" in the rate card).
    const bm = baseMachines.get(m.id) ?? baseMachines.get(baseId(m.id));
    cycleTicks += Math.max(0, bm.cycleTime - m.cycleTime);
    rejectPoints += Math.max(0, ((bm.rejectRate ?? 0) - (m.rejectRate ?? 0)) * 100);
  }
  const secondSupplier = config.supply?.mode === 'inventory' && config.supply?.secondSupplier?.enabled ? 1 : 0;

  const items = {
    extraMachines:  extraMachines * rate.parallel_machine_investment,
    bufferSlots:    bufferSlots * rate.extra_buffer_slot,
    cycleTime:      cycleTicks * rate.cycle_time_reduction_investment,
    rejectRate:     rejectPoints * rate.reject_rate_reduction_investment,
    secondSupplier: secondSupplier * rate.second_supplier_qualification,
  };
  return { counts: { extraMachines, bufferSlots, cycleTicks, rejectPoints, secondSupplier }, items };
}

export function computeEconomics(result, config, baselineConfig, rate, opts = {}) {
  const perShiftRows = result.perShift;
  const shifts = result.kpis.shifts;
  const hours = shifts * SHIFT_HOURS;
  const initialFG = opts.initialFinishedGoods ?? config.initialFinishedGoods ?? 0;

  // ── Per shift ───────────────────────────────────────────────────────────
  let prevStock = initialFG;
  const perShift = perShiftRows.map(r => {
    const machine = config.machines.reduce((a, m) => a + rate[`machine_hour_rate_${baseId(m.id)}`] * SHIFT_HOURS, 0);
    const released = r.released ?? null;
    const holdWip = r.wip * SHIFT_HOURS * rate.holding_cost_wip;
    const holdFg = (prevStock + r.produced / 2) * SHIFT_HOURS * rate.holding_cost_finished_goods;
    prevStock = r.stock;
    const lost = (r.orders - r.shippedOnTime) * rate.lost_sales_penalty;
    const revenue = r.shipped * rate.selling_price_per_good_unit;
    return { shift: r.shift, machine, released, holdWip, holdFg, lostSales: lost, revenue };
  });

  // ── Totals ──────────────────────────────────────────────────────────────
  const sum = (k) => perShift.reduce((a, r) => a + r[k], 0);
  const machineCost = sum('machine');
  const released = result.kpis.released;
  const sup = result.supply;
  const materialCost = (sup?.mode === 'inventory' ? sup.releasedCostMult : released) * rate.material_cost_per_part;
  const holdingWip = sum('holdWip');
  const holdingFg = sum('holdFg');
  const holdRawRate = config.supply?.holdingCostRaw ?? rate.holding_cost_wip;     // assumption, see supply.js
  const holdingRaw = sup?.mode === 'inventory' ? (sup.stockTickSum / 60) * holdRawRate : 0;
  const lostSales = sum('lostSales');
  const overtimeHours = perShiftRows.reduce((a, r) => a + (r.overtimeMin ?? 0), 0) / 60;
  const overtimeCost = overtimeHours * overtimeRatePerHour(config, rate);
  const revenue = sum('revenue');

  const ot = oneTimeCosts(config, baselineConfig, rate);
  const factor = shifts / AMORTISATION_SHIFTS;
  const amortised = Object.values(ot.items).reduce((a, v) => a + v, 0) * factor;

  const startValue = initialFG * FG_VALUE;
  const endValue = result.kpis.finishedGoodsEnd * FG_VALUE;

  const profit = revenue - machineCost - overtimeCost - materialCost - holdingWip - holdingFg - holdingRaw
               - amortised - lostSales - startValue + endValue;
  const good = Math.max(1, result.kpis.goodParts);

  return {
    shifts,
    revenue, machineCost, overtimeHours, overtimeCost, materialCost, holdingWip, holdingFg, holdingRaw,
    lostSales, amortised, oneTime: ot, startValue, endValue,
    profit,
    // the data package's "baseline check" definition: machine + material + WIP holding
    costPerGoodUnit: (machineCost + overtimeCost + materialCost + holdingWip) / good,
    // everything that is charged against the run, per good unit
    costPerGoodUnitAll: (machineCost + overtimeCost + materialCost + holdingWip + holdingFg + holdingRaw + amortised) / good,
    perShift,
  };
}

export { TICKS_PER_SHIFT };

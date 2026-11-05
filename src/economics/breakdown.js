/**
 * breakdown.js
 * The "Cost of the improvement" numbers: what a countermeasure costs and what it brings back,
 * line by line, from two sets of economics (computeEconomics of the "without" and the "with" runs).
 * Pure: it only needs the per-run records, so a later long-term view can reuse it unchanged.
 *
 *   runRecord({ econ, perShift, config, rate, fgStart, fgEnd, ordered, released, goodParts })
 *     -> the per-run record that costBreakdown reads
 *   costBreakdown({ without, with: withRuns, rate, shifts, label })
 *
 * All amounts are means over the runs of the paired difference (with - without), in EUR.
 * Identity: sum(get) - sum(pay) = mean(profit(with) - profit(without)).
 */
import { AMORTISATION_SHIFTS, FG_VALUE, SHIFT_HOURS, overtimeRatePerHour, cycleReductions } from './costs.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';

const SHIFTS_PER_YEAR = 240;
const baseId = (id) => id.replace(/[a-z]+$/, '');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

// Everything the panel needs from one run (no per-shift detail)
export function runRecord({ econ, perShift, config, rate, fgStart, fgEnd, ordered, released, goodParts }) {
  const { perShift: _drop, ...lines } = econ;
  return {
    econ: lines,
    shipped: sum(perShift.map(r => r.shipped)),
    shippedOnTime: sum(perShift.map(r => r.shippedOnTime)),
    ordered, released, goodParts, fgStart, fgEnd,
    machines: config.machines.map(m => m.id),
    overtimeRate: overtimeRatePerHour(config, rate),
    reductions: cycleReductions(config, DEFAULT_CONFIG),
  };
}

const eur = (n) => `${n < 0 ? '−' : ''}€${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const price = (n) => `€${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const num1 = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });

// paired mean difference of a per-run number
const delta = (without, withRuns, f) => mean(withRuns.map((r, i) => f(r) - f(without[i])));

const NOTE_OVERTIME = 'No rate-card price for overtime: hour rates of all four machines (€270) + 50% premium';
const NOTE_ORGANISER = 'Organiser assumption (rate card)';

export function costBreakdown({ without, with: withRuns, rate, shifts, label = '' }) {
  if (!without?.length || without.length !== withRuns?.length) throw new Error('costBreakdown needs paired runs');
  const d = (f) => delta(without, withRuns, f);
  const E = (k) => (r) => r.econ[k];
  const storageOf = (r) => r.econ.holdingWip + r.econ.holdingFg + r.econ.holdingRaw;
  const allZero = (f) => withRuns.every((r, i) => f(r) === f(without[i]));
  const refW = withRuns[0], refO = without[0];

  const dAmortised = d(E('amortised')), dOvertime = d(E('overtimeCost')), dMachine = d(E('machineCost'));
  const dMaterial = d(E('materialCost')), dStorage = d(storageOf);
  const dStart = d(E('startValue')), dLost = d(E('lostSales')), dRevenue = d(E('revenue')), dEnd = d(E('endValue'));
  const rescuedOrders = d(r => r.shippedOnTime);
  const dShipped = d(r => r.shipped), dReleased = d(r => r.released);
  const dOtHours = d(E('overtimeHours'));

  // ── investment (cash, full amount) from the "with" runs ──────────────────
  const items = [];
  const cashOf = (k) => mean(withRuns.map(r => r.econ.oneTime.items[k]));
  const { counts } = refW.econ.oneTime;
  if (cashOf('extraMachines') > 0) {
    items.push({ key: 'extraMachines', label: 'Extra machine', amount: cashOf('extraMachines'),
      formula: counts.extraMachines > 1
        ? `${counts.extraMachines} × ${price(rate.parallel_machine_investment)} per extra machine`
        : `${price(rate.parallel_machine_investment)} per extra machine` });
  }
  if (cashOf('cycleTime') > 0) {
    const byMinutes = new Map();
    for (const c of refW.reductions.cycle) byMinutes.set(c.minutes, (byMinutes.get(c.minutes) ?? 0) + 1);
    const formula = [...byMinutes]
      .map(([min, n]) => `${min} min × ${price(rate.cycle_time_reduction_investment)} × ${n} machine${n > 1 ? 's' : ''}`).join(' + ');
    items.push({ key: 'cycleTime', label: 'Faster cycle time', amount: cashOf('cycleTime'), formula, assumption: NOTE_ORGANISER });
  }
  if (cashOf('rejectRate') > 0) {
    items.push({ key: 'rejectRate', label: 'Lower reject rate', amount: cashOf('rejectRate'), assumption: NOTE_ORGANISER,
      formula: `${num1(refW.reductions.rejectPoints)} percentage points × ${price(rate.reject_rate_reduction_investment)}` });
  }
  if (cashOf('bufferSlots') > 0) {
    items.push({ key: 'bufferSlots', label: 'Extra buffer slots', amount: cashOf('bufferSlots'),
      formula: `${counts.bufferSlots} slots × ${price(rate.extra_buffer_slot)}` });
  }
  if (cashOf('secondSupplier') > 0) {
    items.push({ key: 'secondSupplier', label: 'Second supplier', amount: cashOf('secondSupplier'),
      formula: `${price(rate.second_supplier_qualification)} qualification` });
  }
  const cash = sum(items.map(i => i.amount));

  // ── what you pay ─────────────────────────────────────────────────────────
  const extraMachines = refW.machines.filter(id => !refO.machines.includes(id));
  const payAll = [
    { key: 'investmentShare', label: 'Share of the investment', amount: dAmortised, zero: allZero(E('amortised')),
      formula: `${eur(cash)} ÷ ${AMORTISATION_SHIFTS.toLocaleString('en-US')} shifts × ${shifts} shifts` },
    { key: 'overtime', label: 'Overtime', amount: dOvertime, zero: allZero(E('overtimeCost')), assumption: NOTE_OVERTIME,
      formula: `${num1(dOtHours)} h × ${price(refW.overtimeRate)}/h` },
    { key: 'machineHours', label: 'Machine hours', amount: dMachine, zero: allZero(E('machineCost')),
      formula: extraMachines.length
        ? extraMachines.map(id => `${id}: ${price(rate[`machine_hour_rate_${baseId(id)}`])}/h × ${SHIFT_HOURS} h × ${shifts} shifts`).join(' + ')
        : `${price(dMachine / (shifts * SHIFT_HOURS))}/h × ${SHIFT_HOURS} h × ${shifts} shifts` },
    { key: 'material', label: 'Material', amount: dMaterial, zero: allZero(E('materialCost')),
      formula: `${num1(Math.abs(dReleased))} ${dReleased < 0 ? 'fewer' : 'extra'} parts × ${price(rate.material_cost_per_part)}` },
    { key: 'storage', label: 'Storage', amount: dStorage, zero: allZero(storageOf),
      formula: `parts in the line ${price(rate.holding_cost_wip)}/h, finished sets ${price(rate.holding_cost_finished_goods)}/h` },
    { key: 'startStock', label: 'Starting stock', amount: dStart, zero: allZero(E('startValue')),
      formula: `${num1(d(r => r.fgStart))} sets at the start × ${price(FG_VALUE)}` },
  ];
  const pay = payAll.filter(l => !l.zero).map(({ zero: _z, ...l }) => l);

  // ── what you get ─────────────────────────────────────────────────────────
  const getAll = [
    { key: 'penaltiesAvoided', label: 'Late-delivery penalties avoided', amount: -dLost, zero: allZero(E('lostSales')),
      formula: `${num1(rescuedOrders)} sets no longer late × ${price(rate.lost_sales_penalty)}` },
    { key: 'revenue', label: 'Revenue from extra deliveries', amount: dRevenue, zero: allZero(E('revenue')),
      formula: `${num1(dShipped)} sets × ${price(rate.selling_price_per_good_unit)}` },
    { key: 'endStockValue', label: 'Finished sets left at the end', amount: dEnd, zero: allZero(E('endValue')),
      formula: `${num1(d(r => r.fgEnd))} sets × ${price(FG_VALUE)}` },
  ];
  const get = getAll.filter(l => !l.zero).map(({ zero: _z, ...l }) => l);

  // ── totals ───────────────────────────────────────────────────────────────
  const costOfImprovement = sum(pay.map(l => l.amount));
  const benefits = sum(get.map(l => l.amount));
  const profitChangeOfficial = benefits - costOfImprovement;
  // extra unsold stock built beyond "without" is worth 0 in the conservative view (as in scenarios/sweep.js)
  const unsoldStockValue = FG_VALUE * mean(withRuns.map((r, i) =>
    Math.max(0, (r.fgEnd - r.fgStart) - (without[i].fgEnd - without[i].fgStart))));
  const unsoldSets = unsoldStockValue / FG_VALUE;
  const profitChangeConservative = profitChangeOfficial - unsoldStockValue;
  const penaltiesAvoided = get.find(l => l.key === 'penaltiesAvoided')?.amount ?? 0;

  // ── indicators ───────────────────────────────────────────────────────────
  const costPerRescuedOrder = rescuedOrders > 0 ? costOfImprovement / rescuedOrders : null;
  let payback = null;
  if (cash > 0) {
    const gainPerShift = (profitChangeConservative + dAmortised) / shifts;     // before the investment share
    const n = gainPerShift > 0 ? Math.ceil(cash / gainPerShift) : null;
    payback = { shifts: n, years: n == null ? null : n / SHIFTS_PER_YEAR, withinLife: n != null && n <= AMORTISATION_SHIFTS };
  }

  // ── headline ─────────────────────────────────────────────────────────────
  let headline;
  if (rescuedOrders <= 0) {
    headline = 'This does not deliver more orders on time.';
  } else {
    headline = `To deliver **${num1(rescuedOrders)}** more sets on time over ${shifts} shifts, you pay **${eur(costOfImprovement)}** `
      + `and avoid **${eur(penaltiesAvoided)}** in late-delivery penalties.`;
    if (cash > 0) {
      headline += payback.shifts != null
        ? ` It needs **${eur(cash)} upfront**, paid back after about ${payback.shifts} shifts (≈ ${num1(payback.years)} years).`
        : ` It needs **${eur(cash)} upfront**, which does **not** pay back at these numbers.`;
    } else {
      headline += ' **No upfront investment** is needed.';
    }
  }
  if (unsoldStockValue > 0) {
    headline += ` It also builds ${num1(unsoldSets)} sets nobody ordered (worth ${eur(unsoldStockValue)} on paper, not counted as profit here).`;
  }

  return {
    basis: { runs: without.length, shifts },
    label,
    pay, get,
    totals: { costOfImprovement, benefits, profitChangeOfficial, unsoldStockValue, unsoldSets, profitChangeConservative },
    investment: { cash, items, chargedThisPeriod: dAmortised },
    rescuedOrders,
    costPerRescuedOrder,
    penaltyPerLateOrder: rate.lost_sales_penalty,
    payback,
    // for the profit bridge chart: absolute profit "as is" and "with countermeasure"
    bridge: {
      start: mean(without.map(r => r.econ.profit)),
      end: mean(withRuns.map(r => r.econ.profit)),
    },
    headline,
  };
}

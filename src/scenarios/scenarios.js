/**
 * scenarios.js
 * Scenario definitions and a multi-seed runner (common random numbers: every
 * scenario uses the same seeds, and each random process has its own stream, so
 * differences between scenarios are not noise from different draws).
 *
 *   npm run scenarios [-- --seeds 30 --shifts 20]
 *
 * The four REFERENCE scenarios are unchanged (README: baseline ~100%, supplier
 * outage ~76%, demand swing ~57%, both ~48%). EXTRA scenarios use the added
 * realism (breakdowns, supply model). Each scenario can carry a `countermeasure`
 * (config / initialFinishedGoods overrides); without one the "with" row equals
 * the "without" row. Step 2 (AI advisor) fills that slot.
 */
import { pathToFileURL } from 'node:url';
import { runHeadless } from '../headless/run.js';
import { computeEconomics } from '../economics/costs.js';
import { loadRateCard, loadDemand } from '../data/loaders.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';

export const REFERENCE_OUTAGE = { startTick: 4800, endTick: 5760 };   // 2 shifts from the first tick of shift 11
const FLAT = 34;

const BREAKDOWNS = { enabled: true };
// default machines with one machine patched (e.g. a lower reject rate)
function machinesWithPatch(id, patch) {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG.machines)).map(m => (m.id === id ? { ...m, ...patch } : m));
}
const SAFETY_STOCK = { mode: 'inventory', reorderPoint: 150, orderQty: 150, initialStock: 250 };

// demand: 'flat' (34 per shift) | 'profile' (demand_profile.csv)
export const SCENARIOS = [
  // countermeasure = the Phase 2 recommendation for this scenario (see results/phase2_sweep.txt and
  // src/scenarios/sweep.js for the selection rule). The "with" row of the table runs it.
  { id: 'baseline',          group: 'reference', label: 'Baseline',                    demand: 'flat',    outage: false,
    countermeasure: { label: 'M2 reject rate 10%→5%', config: { machines: machinesWithPatch('M2', { rejectRate: 0.05 }) } } },
  { id: 'supplier-outage',   group: 'reference', label: 'Supplier outage',             demand: 'flat',    outage: true,
    countermeasure: { label: 'Finished-goods buffer 30', initialFinishedGoods: 30 } },
  { id: 'demand-swing',      group: 'reference', label: 'Demand swing',                demand: 'profile', outage: false,
    countermeasure: { label: 'Finished-goods buffer 50', initialFinishedGoods: 50 } },
  { id: 'both',              group: 'reference', label: 'Both (swing + outage)',       demand: 'profile', outage: true,
    countermeasure: { label: 'Finished-goods buffer 50', initialFinishedGoods: 50 } },

  { id: 'breakdowns',        group: 'extra', label: 'Breakdowns',                      demand: 'flat', outage: false, config: { failures: BREAKDOWNS } },
  { id: 'breakdowns-outage', group: 'extra', label: 'Breakdowns + outage',             demand: 'flat', outage: true,  config: { failures: BREAKDOWNS } },
  { id: 'outage-inventory',  group: 'extra', label: 'Outage, raw stock (s,Q) default', demand: 'flat', outage: true,  config: { supply: { mode: 'inventory' } } },
  { id: 'outage-safety',     group: 'extra', label: 'Outage + safety stock',           demand: 'flat', outage: true,  config: { supply: SAFETY_STOCK } },
  { id: 'outage-second',     group: 'extra', label: 'Outage + second supplier',        demand: 'flat', outage: true,  config: { supply: { mode: 'inventory', secondSupplier: { enabled: true } } } },
  { id: 'outage-expedite',   group: 'extra', label: 'Outage + expediting',             demand: 'flat', outage: true,  config: { supply: { mode: 'inventory', expediting: { enabled: true } } } },
];

const clone = (o) => JSON.parse(JSON.stringify(o));

// Apply a { failures, supply, machines, buffers, ... } override on top of DEFAULT_CONFIG.
export function buildConfig(overrides = {}) {
  const cfg = clone(DEFAULT_CONFIG);
  for (const [k, v] of Object.entries(overrides)) cfg[k] = clone(v);
  return cfg;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// Run one variant (config + initial stock) of a scenario over all seeds.
// `rows` keeps one entry per seed in seed order, so two variants can be compared pairwise.
export async function runVariant(spec, { config, initialFinishedGoods = 0 }, { seeds, shifts, rate, profile }) {
  const demand = spec.demand === 'flat' ? Array(Math.max(shifts, 60)).fill(FLAT) : profile;
  const cfg = buildConfig(config);
  const rows = [];
  for (const seed of seeds) {
    const r = await runHeadless({
      config: cfg, seed, shifts, demand, native: true,
      outage: spec.outage ? REFERENCE_OUTAGE : null, initialFinishedGoods,
    });
    const e = computeEconomics(r, { ...cfg, initialFinishedGoods }, DEFAULT_CONFIG, rate, { initialFinishedGoods });
    const k = r.kpis;
    rows.push({
      serviceLevel: k.serviceLevel, goodPerShift: k.goodPerShift, scrap: k.scrap, avgWip: k.avgWip, lineYield: k.lineYield,
      lostSales: k.lostSales,
      oee: Object.fromEntries(Object.entries(k.machines).map(([id, m]) => [id, m.oee.value])),
      costPerGoodUnit: e.costPerGoodUnit, costPerGoodUnitAll: e.costPerGoodUnitAll, profit: e.profit,
      fgStart: initialFinishedGoods, fgEnd: k.finishedGoodsEnd, overtimeHours: e.overtimeHours ?? 0,
    });
  }
  const stat = (f) => { const v = rows.map(f); return { mean: mean(v), sd: sd(v) }; };
  const machineIds = Object.keys(rows[0].oee);
  return {
    n: rows.length,
    serviceLevel: stat(r => r.serviceLevel), goodPerShift: stat(r => r.goodPerShift), scrap: stat(r => r.scrap),
    avgWip: stat(r => r.avgWip), lineYield: stat(r => r.lineYield), lostSales: stat(r => r.lostSales),
    costPerGoodUnit: stat(r => r.costPerGoodUnit), costPerGoodUnitAll: stat(r => r.costPerGoodUnitAll), profit: stat(r => r.profit),
    oee: Object.fromEntries(machineIds.map(id => [id, stat(r => r.oee[id])])),
    rows,
  };
}

/**
 * runScenario(spec, opts) -> { spec, without, with }
 * spec.countermeasure = { config?, initialFinishedGoods? } is merged over the scenario's own config.
 */
export async function runScenario(spec, { seeds = range(1, 30), shifts = 20, rate = loadRateCard(), profile = loadDemand() } = {}) {
  const ctx = { seeds, shifts, rate, profile };
  const without = await runVariant(spec, { config: spec.config ?? {}, initialFinishedGoods: spec.initialFinishedGoods ?? 0 }, ctx);
  let withCm = without;
  if (spec.countermeasure) {
    const cm = spec.countermeasure;
    withCm = await runVariant(spec, {
      config: { ...(spec.config ?? {}), ...(cm.config ?? {}) },
      initialFinishedGoods: cm.initialFinishedGoods ?? spec.initialFinishedGoods ?? 0,
    }, ctx);
  }
  return { spec, without, with: withCm };
}

export async function runAll(opts = {}, specs = SCENARIOS) {
  const out = [];
  for (const spec of specs) out.push(await runScenario(spec, opts));
  return out;
}

export const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ── Table ─────────────────────────────────────────────────────────────────

const pm = (s, d = 1, scale = 1) => `${(s.mean * scale).toFixed(d)} ±${(s.sd * scale).toFixed(d)}`;

export function formatTable(results) {
  const head = ['scenario', 'countermeasure', 'SL %', 'good/shift', 'scrap', 'WIP', 'yield %', 'OEE M1/M2/M3/M4 %', 'EUR/unit', 'profit EUR'];
  const lines = [];
  for (const r of results) {
    const cmLabel = r.spec.countermeasure?.label;
    for (const [tag, v] of [['without', r.without], [cmLabel ? `with: ${cmLabel}` : 'with', r.with]]) {
      const oee = ['M1', 'M2', 'M3', 'M4'].map(id => (v.oee[id] ? (v.oee[id].mean * 100).toFixed(0) : '-')).join('/');
      lines.push([
        r.spec.group === 'reference' ? r.spec.label : `${r.spec.label} (extra)`, tag,
        pm(v.serviceLevel, 1, 100), pm(v.goodPerShift, 1), pm(v.scrap, 0), pm(v.avgWip, 1), pm(v.lineYield, 1, 100),
        oee, pm(v.costPerGoodUnit, 1), pm(v.profit, 0),
      ]);
    }
  }
  const all = [head, ...lines];
  const w = head.map((_, i) => Math.max(...all.map(l => String(l[i]).length)));
  const fmt = (l) => l.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [fmt(head), w.map(n => '-'.repeat(n)).join('  '), ...lines.map(fmt)].join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
  const nSeeds = arg('seeds', 30), shifts = arg('shifts', 20);
  console.log(`Scenarios: ${shifts} shifts, seeds 1..${nSeeds} (common random numbers), mean ±sd`);
  console.log('"with" = the Phase 2 recommended countermeasure (reference scenarios); extras have none, so "with" equals "without".\n');
  const results = await runAll({ seeds: range(1, nSeeds), shifts });
  console.log(formatTable(results));
  console.log('\nReference service levels from the data package: baseline ~100, supplier outage ~76, demand swing ~57, both ~48.');
}


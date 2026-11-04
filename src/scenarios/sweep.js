/**
 * sweep.js — Phase 2: find the countermeasures.
 *
 * For each of the four reference scenarios, every candidate lever (and a few
 * combinations) is run over the same 30 seeds as the "without" row (common random
 * numbers). For each candidate we report the change in service level and profit
 * against "without", with a 95% confidence interval of the PAIRED difference
 * (seed by seed), so a gain is only called real when the interval excludes 0.
 *
 *   node src/scenarios/sweep.js [--seeds 30] [--shifts 20]
 *
 * Writes results/phase2_sweep.txt (readable) and results/phase2_sweep.json (all numbers).
 *
 * Selection rule for the recommendation (stated so the jury can check it):
 *   1. keep candidates whose profit gain is significant (95% CI above 0);
 *   2. among those, prefer service level >= 95%; pick the highest mean profit;
 *   3. if none reaches 95%, pick the highest mean profit.
 * Profit already contains the lost-sales penalty, holding costs and amortised investments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENARIOS, runVariant, range } from './scenarios.js';
import { loadRateCard, loadDemand } from '../data/loaders.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const SL_TARGET = 0.95;

// ── Candidate levers (all priced by the rate card or by material/holding cost) ──
const m3b = () => {
  const m = clone(DEFAULT_CONFIG.machines);
  const m3 = m.find(x => x.id === 'M3');
  m.push({ ...m3, id: 'M3b' });
  return m;
};
const machinesWith = (id, patch) => clone(DEFAULT_CONFIG.machines).map(m => (m.id === id ? { ...m, ...patch } : m));
const buffersWith = (id, cap) => clone(DEFAULT_CONFIG.buffers).map(b => (b.id === id ? { ...b, capacity: cap } : b));
const source = (interval) => ({ ...clone(DEFAULT_CONFIG.source), materialStock: -1, interval });

const SUPPLY = {
  rawStock:   { mode: 'inventory' },                                                        // (s,Q) 60/100, lead time 480
  safety:     { mode: 'inventory', reorderPoint: 150, orderQty: 150, initialStock: 250 },
  second:     { mode: 'inventory', secondSupplier: { enabled: true } },
  expedite:   { mode: 'inventory', expediting: { enabled: true } },
};

export function candidates(spec) {
  const list = [];
  const add = (id, label, cm, kind) => list.push({ id, label, kind, cm });

  for (const fg of [10, 20, 30, 40, 50, 60, 80, 100]) {
    add(`fg${fg}`, `Finished-goods stock ${fg}`, { initialFinishedGoods: fg }, 'stock');
  }
  add('m3b', 'Parallel M3', { config: { machines: m3b() } }, 'capacity');
  for (const iv of [9, 8, 7]) add(`m3b-i${iv}`, `Parallel M3 + release every ${iv} min`, { config: { machines: m3b(), source: source(iv) } }, 'capacity');
  add('m3-ct12', 'M3 cycle 13→12', { config: { machines: machinesWith('M3', { cycleTime: 12 }) } }, 'capacity');
  add('m3-ct12-i10', 'M3 cycle 13→12 + release every 10 min', { config: { machines: machinesWith('M3', { cycleTime: 12 }), source: source(10) } }, 'capacity');
  add('m3-ct11-i9', 'M3 cycle 13→11 + release every 9 min', { config: { machines: machinesWith('M3', { cycleTime: 11 }), source: source(9) } }, 'capacity');
  add('i10', 'Release every 10 min', { config: { source: source(10) } }, 'flow');
  add('buf2-8', 'BUF2 (before M3) 6→8', { config: { buffers: buffersWith('BUF2', 8) } }, 'flow');
  add('rej5', 'M2 reject 10%→5%', { config: { machines: machinesWith('M2', { rejectRate: 0.05 }) } }, 'quality');

  if (spec.outage) {
    add('sup-raw', 'Raw stock (s=60, Q=100)', { config: { supply: SUPPLY.rawStock } }, 'supply');
    add('sup-safety', 'Raw safety stock (250 start, s=150)', { config: { supply: SUPPLY.safety } }, 'supply');
    add('sup-second', 'Second supplier', { config: { supply: SUPPLY.second } }, 'supply');
    add('sup-expedite', 'Expediting', { config: { supply: SUPPLY.expedite } }, 'supply');
  }
  return list;
}

// Combinations built from the best single levers of each kind (second round).
function combos(spec, singles) {
  const best = (kind) => singles.filter(s => s.kind === kind).sort((a, b) => b.dProfitCons.mean - a.dProfitCons.mean)[0];
  const pairs = [];
  const stock = best('stock'), supply = best('supply'), cap = best('capacity');
  const merge = (a, b) => ({
    id: `${a.id}+${b.id}`, label: `${a.label} + ${b.label}`, kind: 'combo',
    cm: {
      initialFinishedGoods: a.cm.initialFinishedGoods ?? b.cm.initialFinishedGoods,
      config: { ...(a.cm.config ?? {}), ...(b.cm.config ?? {}) },
    },
  });
  if (stock && supply) pairs.push(merge(stock, supply));
  if (stock && cap) pairs.push(merge(stock, cap));
  return pairs;
}

// ── Statistics on paired differences ─────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
// two-sided 95% t quantile for n-1 degrees of freedom (n >= 2); close to 1.96 for large n
const T95 = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 9: 2.26, 19: 2.09, 29: 2.045 };
const t95 = (df) => T95[df] ?? (df < 30 ? 2.1 : 1.96);
function paired(a, b) {                     // b - a, seed by seed
  const d = a.map((x, i) => b[i] - x);
  const m = mean(d), half = t95(d.length - 1) * sd(d) / Math.sqrt(d.length);
  return { mean: m, lo: m - half, hi: m + half };
}

// Conservative profit: the official rule credits every finished unit left at the end at
// EUR 103, so a line that simply makes more than customers order looks profitable. Here,
// stock built up BEYOND the "without" run (net of any starting stock) is valued at 0:
// no order shows that it will ever be sold. Starting stock that is used up is unaffected.
const FG_VALUE = 103;
function conservative(baseRows, rows) {
  return rows.map((r, i) => {
    const extraBuild = (r.fgEnd - r.fgStart) - (baseRows[i].fgEnd - baseRows[i].fgStart);
    return r.profit - FG_VALUE * Math.max(0, extraBuild);
  });
}

export function compare(base, variant) {
  const sl = (v) => v.rows.map(r => r.serviceLevel);
  const pr = (v) => v.rows.map(r => r.profit);
  const extra = variant.rows.map((r, i) => (r.fgEnd - r.fgStart) - (base.rows[i].fgEnd - base.rows[i].fgStart));
  return {
    serviceLevel: variant.serviceLevel, profit: variant.profit,
    goodPerShift: variant.goodPerShift, avgWip: variant.avgWip, costPerGoodUnit: variant.costPerGoodUnit,
    extraStock: mean(extra),
    dSL: paired(sl(base), sl(variant)),
    dProfit: paired(pr(base), pr(variant)),
    dProfitCons: paired(pr(base), conservative(base.rows, variant.rows)),
  };
}

export function pickRecommendation(evaluated) {
  const pool = evaluated.filter(c => c.dProfitCons.lo > 0);          // significant, conservative gain
  const meetsTarget = pool.filter(c => c.serviceLevel.mean >= SL_TARGET);
  const from = meetsTarget.length ? meetsTarget : pool;
  return [...from].sort((a, b) => b.dProfitCons.mean - a.dProfitCons.mean)[0] ?? null;
}

// ── Run ──────────────────────────────────────────────────────────────────────
export async function sweep({ seeds = range(1, 30), shifts = 20, specs = SCENARIOS.filter(s => s.group === 'reference'), log = () => {} } = {}) {
  const ctx = { seeds, shifts, rate: loadRateCard(), profile: loadDemand() };
  const out = [];
  for (const spec of specs) {
    log(`\n${spec.label}: baseline ...`);
    const base = await runVariant(spec, { config: spec.config ?? {}, initialFinishedGoods: 0 }, ctx);
    const evalOne = async (c) => {
      const v = await runVariant(spec, {
        config: { ...(spec.config ?? {}), ...(c.cm.config ?? {}) },
        initialFinishedGoods: c.cm.initialFinishedGoods ?? 0,
      }, ctx);
      const r = { ...c, ...compare(base, v) };
      log(`  ${c.label.padEnd(48)} SL ${(r.serviceLevel.mean * 100).toFixed(1)}%  profit ${Math.round(r.profit.mean)}`);
      return r;
    };
    const singles = [];
    for (const c of candidates(spec)) singles.push(await evalOne(c));
    const combined = [];
    for (const c of combos(spec, singles)) combined.push(await evalOne(c));
    const all = [...singles, ...combined];
    const recommendation = pickRecommendation([...all]);

    // Out-of-sample check: the recommendation was chosen on demand shifts 1-20. Re-test it
    // on the unused shifts 21-40 and 41-60 of the demand profile (same outage window, same
    // seeds) to show it is not tuned to one particular week. Flat demand is the same everywhere.
    const holdout = [];
    if (recommendation && spec.demand === 'profile') {
      for (const [from, to] of [[20, 40], [40, 60]]) {
        const hctx = { ...ctx, profile: ctx.profile.slice(from, to) };
        const hb = await runVariant(spec, { config: spec.config ?? {}, initialFinishedGoods: 0 }, hctx);
        const hv = await runVariant(spec, {
          config: { ...(spec.config ?? {}), ...(recommendation.cm.config ?? {}) },
          initialFinishedGoods: recommendation.cm.initialFinishedGoods ?? 0,
        }, hctx);
        const c = compare(hb, hv);
        holdout.push({ shifts: `${from + 1}-${to}`, withoutSL: hb.serviceLevel.mean, withSL: c.serviceLevel.mean, dSL: c.dSL, dProfitCons: c.dProfitCons });
        log(`  hold-out shifts ${from + 1}-${to}: SL ${(hb.serviceLevel.mean * 100).toFixed(1)}% -> ${(c.serviceLevel.mean * 100).toFixed(1)}%`);
      }
    }
    out.push({
      scenario: spec.id, label: spec.label,
      baseline: { serviceLevel: base.serviceLevel, profit: base.profit, goodPerShift: base.goodPerShift, avgWip: base.avgWip, costPerGoodUnit: base.costPerGoodUnit },
      candidates: all,
      recommendation,
      holdout,
    });
  }
  return out;
}

const eur = (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pp = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)}`;

export function formatSweep(results, { seeds, shifts }) {
  const L = [];
  L.push(`Phase 2 — countermeasure sweep: ${shifts} shifts, ${seeds} seeds (same seeds for every row), mean values.`);
  L.push('ΔSL and Δprofit are paired differences vs. "without" with a 95% confidence interval; * = significant (CI excludes 0).');
  L.push('Δprofit = official profit rule (DATA_README). Δcons = conservative profit: extra unsold stock built beyond "without" is valued at 0, not EUR 103.');
  L.push('"extra stock" = finished units left at the end beyond the "without" run (net of starting stock): made, but not ordered.');
  L.push(`Recommendation rule: conservative gain significant (CI > 0); prefer service level >= ${SL_TARGET * 100}%; then highest conservative gain.\n`);
  for (const r of results) {
    L.push(`=== ${r.label} ===`);
    L.push(`without: SL ${(r.baseline.serviceLevel.mean * 100).toFixed(1)}%, profit EUR ${Math.round(r.baseline.profit.mean).toLocaleString('en-US')}, `
      + `${r.baseline.goodPerShift.mean.toFixed(1)} good/shift, WIP ${r.baseline.avgWip.mean.toFixed(1)}`);
    const head = ['countermeasure', 'SL %', 'ΔSL pts [95% CI]', 'Δprofit EUR', 'Δcons EUR [95% CI]', 'extra stock', 'good/sh', 'WIP'];
    const rows = [...r.candidates].sort((a, b) => b.dProfitCons.mean - a.dProfitCons.mean).map(c => [
      (r.recommendation?.id === c.id ? '► ' : '  ') + c.label,
      (c.serviceLevel.mean * 100).toFixed(1),
      `${pp(c.dSL.mean)} [${pp(c.dSL.lo)}, ${pp(c.dSL.hi)}]${c.dSL.lo > 0 || c.dSL.hi < 0 ? '*' : ''}`,
      eur(c.dProfit.mean),
      `${eur(c.dProfitCons.mean)} [${eur(c.dProfitCons.lo)}, ${eur(c.dProfitCons.hi)}]${c.dProfitCons.lo > 0 || c.dProfitCons.hi < 0 ? '*' : ''}`,
      c.extraStock.toFixed(0),
      c.goodPerShift.mean.toFixed(1),
      c.avgWip.mean.toFixed(1),
    ]);
    const all = [head, ...rows];
    const w = head.map((_, i) => Math.max(...all.map(l => String(l[i]).length)));
    const fmt = (l) => l.map((c, i) => String(c).padEnd(w[i])).join('  ');
    L.push(fmt(head), w.map(n => '-'.repeat(n)).join('  '), ...rows.map(fmt));
    const rec = r.recommendation;
    L.push(rec
      ? `RECOMMENDED: ${rec.label} → SL ${(rec.serviceLevel.mean * 100).toFixed(1)}% (${pp(rec.dSL.mean)} pts), `
        + `profit ${eur(rec.dProfitCons.mean)} EUR conservative (${eur(rec.dProfit.mean)} official) over ${shifts} shifts`
      : 'RECOMMENDED: no countermeasure (none gives a significant conservative profit gain)');
    for (const h of r.holdout ?? []) {
      L.push(`  out-of-sample check, demand shifts ${h.shifts}: SL ${(h.withoutSL * 100).toFixed(1)}% → ${(h.withSL * 100).toFixed(1)}% `
        + `(${pp(h.dSL.mean)} pts), profit ${eur(h.dProfitCons.mean)} EUR [${eur(h.dProfitCons.lo)}, ${eur(h.dProfitCons.hi)}]`);
    }
    L.push('');
  }
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : dflt; };
  const nSeeds = arg('seeds', 30), shifts = arg('shifts', 20);
  const results = await sweep({ seeds: range(1, nSeeds), shifts, log: (s) => console.error(s) });
  const text = formatSweep(results, { seeds: nSeeds, shifts });
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'phase2_sweep.txt'), text + '\n');
  const slim = results.map(r => ({ ...r, candidates: r.candidates.map(({ cm, ...c }) => ({ ...c, countermeasure: cm })) }));
  fs.writeFileSync(path.join(dir, 'phase2_sweep.json'), JSON.stringify(slim, null, 2));
  console.log(text);
  console.log(`Saved: results/phase2_sweep.txt and results/phase2_sweep.json`);
}

/**
 * evaluate.js
 * Simulate one countermeasure against one scenario and say, in plain terms,
 * whether it works. This is the "check" step of the AI shift advisor: nothing is
 * called effective until this function has run it.
 *
 *   const r = await evaluateCountermeasure('demand-swing', 'new-line', { releaseInterval: 8 });
 *
 * Same seeds for "without" and "with" (common random numbers); differences are paired
 * seed by seed with a 95% confidence interval. Profit is reported twice: the official
 * rule, and a conservative one in which extra unsold stock built beyond "without" is
 * worth 0 (see src/scenarios/sweep.js).
 *
 *   node src/countermeasures/evaluate.js [scenario] [--seeds 30]
 *   -> evaluates the 6 countermeasures of the pool at their default parameters in the given scenario
 *      (without an argument: in all 4 scenarios) and writes results/<scenario>_countermeasures.txt and .json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runVariant, range } from '../scenarios/scenarios.js';
import { compare } from '../scenarios/sweep.js';
import { costBreakdown } from '../economics/breakdown.js';
import { loadRateCard, loadDemand } from '../data/loaders.js';
import { DISRUPTIONS, catalogueFor, resolveSelection } from './catalog.js';

const baseCache = new Map();   // "disruption|seeds|shifts" -> baseline variant (the "without" run)

function verdictOf(c) {
  const slUp = c.dSL.lo > 0, slDown = c.dSL.hi < 0;
  const moneyUp = c.dProfitCons.lo > 0, moneyDown = c.dProfitCons.hi < 0;
  if (slUp && moneyUp) return { code: 'effective', text: 'Effective: more orders on time and more profit.' };
  if (slUp && moneyDown) return { code: 'costly', text: 'Improves delivery, but costs more than it earns.' };
  if (slUp) return { code: 'delivery-only', text: 'Improves delivery; the profit effect is not clearly positive or negative.' };
  if (slDown) return { code: 'harmful', text: 'Makes delivery worse.' };
  if (moneyUp) return { code: 'profit-only', text: 'No effect on delivery, but saves money.' };
  return { code: 'no-effect', text: 'No clear effect: do not apply.' };
}

// One countermeasure or any combination: selection = [{ id, params }]
export async function evaluateSelection(disruptionId, selection, {
  seeds = range(1, 30), shifts = 20, rate = loadRateCard(), profile = loadDemand(),
} = {}) {
  const d = DISRUPTIONS[disruptionId];
  if (!d) throw new Error(`unknown scenario "${disruptionId}" (allowed: ${Object.keys(DISRUPTIONS).join(', ')})`);
  const { items, label, override } = resolveSelection(selection, disruptionId);
  const ctx = { seeds, shifts, rate, profile };

  const key = `${disruptionId}|${seeds.join(',')}|${shifts}`;
  let base = baseCache.get(key);
  if (!base) {
    base = await runVariant(d.spec, { config: d.spec.config ?? {}, initialFinishedGoods: 0 }, ctx);
    baseCache.set(key, base);
  }
  const variant = await runVariant(d.spec, {
    config: { ...(d.spec.config ?? {}), ...(override.config ?? {}) },
    initialFinishedGoods: override.initialFinishedGoods ?? 0,
  }, ctx);
  const c = compare(base, variant);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const first = items[0];

  return {
    disruption: { id: d.id, label: d.label },
    countermeasure: {
      id: items.map(i => i.cm.id).join('+'), label,
      category: items.length === 1 ? first.cm.category : (items.every(i => i.cm.category === first.cm.category) ? first.cm.category : 'mixed'),
      params: items.length === 1 ? first.params : Object.fromEntries(items.map(i => [i.cm.id, i.params])),
      cost: items.map(i => i.cm.cost).join(' | '),
      items: items.map(i => ({ id: i.cm.id, label: i.cm.label, category: i.cm.category, params: i.params, cost: i.cm.cost })),
    },
    runs: seeds.length, shifts,
    without: {
      serviceLevel: base.serviceLevel.mean, profit: base.profit.mean,
      goodPerShift: base.goodPerShift.mean, lostSales: base.lostSales.mean, costPerGoodUnit: base.costPerGoodUnit.mean,
    },
    with: {
      serviceLevel: variant.serviceLevel.mean, profit: variant.profit.mean,
      goodPerShift: variant.goodPerShift.mean, lostSales: variant.lostSales.mean, costPerGoodUnit: variant.costPerGoodUnit.mean,
      extraUnsoldStock: c.extraStock,
      overtimeHours: mean(variant.rows.map(r => r.overtimeHours ?? 0)),
      outsourcedSets: mean(variant.rows.map(r => r.econ.outsourcedReceived ?? 0)),
      backupParts: mean(variant.rows.map(r => r.econ.backupParts ?? 0)),
    },
    change: { serviceLevel: c.dSL, profitOfficial: c.dProfit, profitConservative: c.dProfitCons },
    verdict: verdictOf(c),
    costs: costBreakdown({ without: base.rows, with: variant.rows, rate, shifts, label }),
  };
}

// One countermeasure (same output shape as before)
export function evaluateCountermeasure(disruptionId, countermeasureId, params = {}, opts = {}) {
  return evaluateSelection(disruptionId, [{ id: countermeasureId, params }], opts);
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const eur = (v) => `${v < 0 ? '−' : '+'}EUR ${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

export function formatEvaluations(list) {
  const L = [];
  const d = list[0]?.disruption;
  L.push(`Countermeasures for: ${d?.label} — ${list[0]?.shifts} shifts, ${list[0]?.runs} runs each (same seeds), mean values`);
  L.push(`Without any countermeasure: ${pct(list[0].without.serviceLevel)} of orders on time, profit EUR ${Math.round(list[0].without.profit).toLocaleString('en-US')}`);
  L.push('Profit change: conservative (extra unsold stock worth 0) with 95% CI; official rule in brackets.\n');
  for (const r of list) {
    const ps = Object.entries(r.countermeasure.params).map(([k, v]) => `${k}=${v}`).join(', ');
    L.push(`■ ${r.countermeasure.label} [${r.countermeasure.category}]${ps ? ` (${ps})` : ''}`);
    L.push(`  On time: ${pct(r.without.serviceLevel)} → ${pct(r.with.serviceLevel)}   `
      + `(${(r.change.serviceLevel.mean * 100).toFixed(1)} pts, 95% CI ${(r.change.serviceLevel.lo * 100).toFixed(1)} to ${(r.change.serviceLevel.hi * 100).toFixed(1)})`);
    L.push(`  Profit:  ${eur(r.change.profitConservative.mean)} conservative `
      + `(CI ${eur(r.change.profitConservative.lo)} to ${eur(r.change.profitConservative.hi)}); official ${eur(r.change.profitOfficial.mean)}`);
    L.push(`  Output:  ${r.with.goodPerShift.toFixed(1)} good sets/shift; extra unsold stock ${r.with.extraUnsoldStock.toFixed(0)} sets`
      + (r.with.outsourcedSets ? `; ${r.with.outsourcedSets.toFixed(1)} outsourced sets` : '')
      + (r.with.backupParts ? `; ${r.with.backupParts.toFixed(0)} parts from the additional supplier` : ''));
    L.push(`  Cost:    ${r.countermeasure.cost}`);
    L.push(`  VERDICT: ${r.verdict.text}\n`);
  }
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const given = process.argv.slice(2).find(a => !a.startsWith('--') && isNaN(Number(a)));
  const scenarios = given ? [given] : Object.keys(DISRUPTIONS);
  const i = process.argv.indexOf('--seeds');
  const seeds = range(1, i > 0 ? Number(process.argv[i + 1]) : 30);
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../results');
  fs.mkdirSync(dir, { recursive: true });
  for (const disruptionId of scenarios) {
    const list = [];
    for (const cm of catalogueFor(disruptionId)) {
      console.error(`${disruptionId}: simulating ${cm.label} ...`);
      list.push(await evaluateCountermeasure(disruptionId, cm.id, {}, { seeds }));
    }
    const text = formatEvaluations(list);
    fs.writeFileSync(path.join(dir, `${disruptionId}_countermeasures.txt`), `${text}\n`);
    fs.writeFileSync(path.join(dir, `${disruptionId}_countermeasures.json`), JSON.stringify(list, null, 2));
    console.log(`${text}\n`);
    console.log(`Saved: results/${disruptionId}_countermeasures.txt and .json\n`);
  }
}

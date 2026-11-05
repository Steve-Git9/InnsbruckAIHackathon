/**
 * cards.js
 * The numbers on the countermeasure cards, computed on the spot for ONE scenario and ONE run length
 * (the shift limit of the top bar): nothing is precomputed and nothing is saved to disk.
 *
 *   const store = createCardStore();
 *   const entry = store.request('demand-swing', 20);   // starts the background work if needed
 *   entry.cards  : Map(id -> card)    // what is done so far
 *   entry.pending: [id, ...]          // what is still running (empty = all 6 are ready)
 *   await store.whenReady('demand-swing', 20)  -> [card, ...] in catalogue order
 *
 * The results live in memory for the life of the server, by "scenario|shifts|seeds": going back to a
 * pair that was already computed is instant. Only ONE computation runs at a time, and it works on the most
 * recently requested pair: a new scenario or run length deprioritises the old one (it keeps what it has
 * and resumes only if it is requested again).
 *
 * A card holds the 4 comparable values at the DEFAULT parameters of the countermeasure.
 */
import { evaluateCountermeasure } from './evaluate.js';
import { COUNTERMEASURES, DISRUPTIONS } from './catalog.js';
import { range } from '../scenarios/scenarios.js';

export const CARD_SEEDS = range(1, 10);

// Running cost per shift: every cost line that is not the share of the investment or the starting stock
const NOT_RUNNING = new Set(['investmentShare', 'startStock']);

// The compact card of one evaluation (default parameters)
export function cardOf(cmId, r) {
  const cm = COUNTERMEASURES[cmId];
  const running = r.costs.pay.filter(l => !NOT_RUNNING.has(l.key)).reduce((a, l) => a + l.amount, 0) / r.shifts;
  return {
    id: cm.id, label: cm.label, category: cm.category, description: cm.description, cost: cm.cost,
    params: cm.params,
    defaults: Object.fromEntries(Object.entries(cm.params).map(([k, p]) => [k, p.default])),
    onTime: {
      without: r.without.serviceLevel, with: r.with.serviceLevel,
      points: r.change.serviceLevel.mean * 100,                 // percentage points
    },
    profit: {
      conservative: r.change.profitConservative.mean,           // extra unsold stock valued at EUR 0
      official: r.change.profitOfficial.mean,
    },
    investment: { cash: r.costs.investment.cash, runningPerShift: running },
    costPerGoodSet: { without: r.without.costPerGoodUnit, with: r.with.costPerGoodUnit },
    unsold: r.with.extraUnsoldStock,                            // extra unsold sets built beyond "without"
    verdict: r.verdict,
  };
}

export function createCardStore({ evaluate = evaluateCountermeasure, seeds = CARD_SEEDS } = {}) {
  const entries = new Map();        // key -> entry
  let latest = null;                // the entry the worker is working on
  let working = false;

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (latest && latest.pending.length) {
        const entry = latest, id = entry.pending[0];
        try {
          entry.cards.set(id, cardOf(id, await evaluate(entry.scenarioId, id, {}, { seeds, shifts: entry.shifts })));
        } catch (err) {
          entry.errors[id] = err.message;
        }
        entry.pending.shift();
        if (!entry.pending.length) entry.finish();
      }
    } finally {
      working = false;
    }
  }

  function request(scenarioId, shifts) {
    if (!DISRUPTIONS[scenarioId]) throw new Error(`unknown scenario "${scenarioId}" (allowed: ${Object.keys(DISRUPTIONS).join(', ')})`);
    const key = `${scenarioId}|${shifts}|${seeds.join(',')}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, scenarioId, shifts, runs: seeds.length, cards: new Map(), errors: {}, pending: Object.keys(COUNTERMEASURES) };
      entry.done = new Promise(resolve => { entry.finish = resolve; });
      entries.set(key, entry);
    }
    latest = entry;
    if (entry.pending.length) pump(); else entry.finish();
    return entry;
  }

  // All cards of the pair in catalogue order (waits for the computation; rejects when one failed)
  async function whenReady(scenarioId, shifts) {
    const entry = request(scenarioId, shifts);
    await entry.done;
    const failed = Object.entries(entry.errors);
    if (failed.length) throw new Error(`could not simulate ${failed.map(([id, m]) => `${id}: ${m}`).join('; ')}`);
    return Object.keys(COUNTERMEASURES).map(id => entry.cards.get(id));
  }

  // JSON for GET /api/countermeasures/cards: what is done so far, what is still pending
  function snapshot(scenarioId, shifts) {
    const entry = request(scenarioId, shifts);
    const order = Object.keys(COUNTERMEASURES);
    return {
      scenario: scenarioId, shifts, runs: entry.runs,
      ready: order.filter(id => entry.cards.has(id)).map(id => entry.cards.get(id)),
      pending: [...entry.pending],
      errors: entry.errors,
    };
  }

  return { request, whenReady, snapshot, size: () => entries.size };
}

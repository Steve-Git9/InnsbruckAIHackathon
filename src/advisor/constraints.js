/**
 * constraints.js
 * The CEO's answers to the questionnaire. The budget is a HARD limit: it narrows the catalogue in code
 * before the LLM sees it, and a proposal is checked against the narrowed catalogue afterwards. Goal, kind
 * of fix and the free text are soft: they only go to the prompt.
 *
 * answers = null ("Give me the best") or
 *   { goal: 'delivery'|'profit'|'balance', budget: 'none'|'60k'|'100k'|'unlimited',
 *     fixType: 'operational'|'strategic'|'any', notes: string }
 *
 * Old payloads still work: an `overtime` answer is ignored (overtime left the pool of countermeasures),
 * and the old fix types 'flexible' / 'permanent' mean 'operational' / 'strategic'.
 */
import { loadRateCard } from '../data/loaders.js';

export const MAX_NOTES = 500;

const OPTIONS = {
  goal: { delivery: 'On-time delivery', profit: 'Profit', balance: 'A balance of both' },
  budget: { none: 'Nothing', '60k': 'Up to €60,000', '100k': 'Up to €100,000', unlimited: 'No limit' },
  fixType: { operational: 'Operational — quick, no investment', strategic: 'Strategic — invest for the long term', any: 'No preference' },
};
const LEGACY_FIX_TYPE = { flexible: 'operational', permanent: 'strategic' };
const BUDGET_EUR = { none: 0, '60k': 60000, '100k': 100000, unlimited: Infinity };
const KEYS = [...Object.keys(OPTIONS), 'notes', 'overtime'];     // 'overtime': accepted from old clients, ignored

export const DEFAULT_ANSWERS = { goal: 'balance', budget: 'unlimited', fixType: 'any', notes: '' };

const eur = (n) => (n === 0 ? "nothing" : `€${n.toLocaleString("en-US")}`);

// -> normalised answers (missing keys get the questionnaire default) or throws
export function validateAnswers(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('answers must be an object or null');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) throw new Error(`unknown answer "${k}"`);
  const a = { ...DEFAULT_ANSWERS };
  for (const k of Object.keys(OPTIONS)) {
    if (raw[k] === undefined) continue;
    const v = k === 'fixType' && Object.hasOwn(LEGACY_FIX_TYPE, raw[k]) ? LEGACY_FIX_TYPE[raw[k]] : raw[k];
    if (typeof v !== 'string' || !Object.hasOwn(OPTIONS[k], v)) throw new Error(`invalid value for "${k}"`);
    a[k] = v;
  }
  if (raw.notes !== undefined) {
    if (typeof raw.notes !== 'string') throw new Error('"notes" must be text');
    if (raw.notes.length > MAX_NOTES) throw new Error(`"notes" is longer than ${MAX_NOTES} characters`);
    a.notes = raw.notes.trim();
  }
  return a;
}

// One-time investment (EUR) of a countermeasure option at a given parameter value, from rate_card.csv
export function investmentOf(id, params, rate) {
  if (id === 'improve-machine' || id === 'faster-m3') return rate.cycle_time_reduction_investment * (params.minutesSaved ?? 0);
  if (id === 'new-line' || id === 'second-m3') return rate.parallel_machine_investment;
  if (id === 'extra-supplier') return rate.second_supplier_qualification;
  return 0;          // outsourcing, raw-stock, finished-stock: nothing upfront
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// -> { catalogue: narrowed copy, applied: [plain-language reasons] }
export function applyConstraints(catalogue, answers, rate = loadRateCard()) {
  const out = clone(catalogue);
  const applied = [];
  if (!answers) return { catalogue: out, applied };

  const budget = BUDGET_EUR[answers.budget];
  const kept = [];
  for (const c of out) {
    if (budget !== Infinity) {
      const p = c.params.minutesSaved;
      if (c.id === 'improve-machine' && p) {
        const perMin = investmentOf(c.id, { minutesSaved: 1 }, rate);
        const maxMin = Math.min(p.max, Math.floor(budget / perMin));
        if (maxMin < p.min) { applied.push(`${budget === 0 ? "No investment allowed" : `Investment limited to ${eur(budget)}`}: "${c.label}" removed`); continue; }
        if (maxMin < p.max) {
          p.max = maxMin; p.default = Math.min(p.default, maxMin);
          applied.push(`Investment limited to ${eur(budget)}: "${c.label}" saves at most ${maxMin} min`);
        }
      } else if (investmentOf(c.id, {}, rate) > budget) {
        applied.push(`${budget === 0 ? "No investment allowed" : `Investment limited to ${eur(budget)}`}: "${c.label}" removed`);
        continue;
      }
    }
    kept.push(c);
  }
  return { catalogue: kept, applied };
}

// -> the effective params (omitted ones get the narrowed default); throws if outside the narrowed catalogue
export function checkProposal(proposal, catalogue) {
  const c = catalogue.find(x => x.id === proposal.id);
  if (!c) throw new Error(`countermeasure "${proposal.id}" is not allowed by the CEO's limits (allowed: ${catalogue.map(x => x.id).join(', ') || 'none'})`);
  const given = proposal.params ?? {};
  for (const k of Object.keys(given)) if (!(k in c.params)) throw new Error(`${c.id} has no parameter "${k}"`);
  const params = {};
  for (const [name, def] of Object.entries(c.params)) {
    const v = given[name] ?? def.default;
    if (typeof v !== 'number' || v < def.min || v > def.max) throw new Error(`${c.id}.${name}=${v} is outside the allowed ${def.min}..${def.max}`);
    params[name] = v;
  }
  return params;
}

// Readable lines for the prompt (CEO_ANSWERS)
export function describeAnswers(answers) {
  if (!answers) return 'No preferences given: choose the countermeasure you expect to improve on-time delivery the most without losing money.';
  return [
    `What matters most: ${OPTIONS.goal[answers.goal]}`,
    `Investment: ${OPTIONS.budget[answers.budget]}`,
    `Preferred kind of fix: ${OPTIONS.fixType[answers.fixType]}`,
  ].join('\n');
}

/**
 * constraints.js
 * The CEO's answers to the questionnaire. Budget and overtime are HARD limits: they narrow
 * the catalogue in code before the LLM sees it, and a proposal is checked against the narrowed
 * catalogue afterwards. Goal, fix type and the free text are soft: they only go to the prompt.
 *
 * answers = null ("Give me the best") or
 *   { goal: 'delivery'|'profit'|'balance', budget: 'none'|'60k'|'100k'|'unlimited',
 *     overtime: 'no'|'1h'|'2h'|'4h', fixType: 'flexible'|'permanent'|'any', notes: string }
 */
import { loadRateCard } from '../data/loaders.js';

export const MAX_NOTES = 500;

const OPTIONS = {
  goal: { delivery: 'On-time delivery', profit: 'Profit', balance: 'A balance of both' },
  budget: { none: 'Nothing', '60k': 'Up to €60,000', '100k': 'Up to €100,000', unlimited: 'No limit' },
  overtime: { no: 'No overtime', '1h': 'Up to 1 h per shift', '2h': 'Up to 2 h per shift', '4h': 'Up to 4 h per shift' },
  fixType: { flexible: 'Flexible (pay only when peaks happen)', permanent: 'Permanent (more capacity every shift)', any: 'No preference' },
};
const BUDGET_EUR = { none: 0, '60k': 60000, '100k': 100000, unlimited: Infinity };
const OVERTIME_MIN = { no: 0, '1h': 60, '2h': 120, '4h': 240 };
const KEYS = [...Object.keys(OPTIONS), 'notes'];

export const DEFAULT_ANSWERS = { goal: 'balance', budget: 'unlimited', overtime: '2h', fixType: 'any', notes: '' };

const eur = (n) => (n === 0 ? "nothing" : `€${n.toLocaleString("en-US")}`);

// -> normalised answers (missing keys get the questionnaire default) or throws
export function validateAnswers(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('answers must be an object or null');
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) throw new Error(`unknown answer "${k}"`);
  const a = { ...DEFAULT_ANSWERS };
  for (const k of Object.keys(OPTIONS)) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !Object.hasOwn(OPTIONS[k], raw[k])) throw new Error(`invalid value for "${k}"`);
    a[k] = raw[k];
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
  if (id === 'faster-m3') return rate.cycle_time_reduction_investment * (params.minutesSaved ?? 0);
  if (id === 'second-m3') return rate.parallel_machine_investment;
  return 0;
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
    if (c.id === 'overtime') {
      if (answers.overtime === 'no') { applied.push(`No overtime allowed: "${c.label}" removed`); continue; }
      const p = c.params.maxMinutesPerShift;
      const limit = OVERTIME_MIN[answers.overtime];
      if (limit < p.max) {
        p.max = limit;
        p.default = Math.min(p.default, limit);
        applied.push(`Overtime limited to ${limit} minutes per shift`);
      }
    } else if (budget !== Infinity) {
      const p = c.params.minutesSaved;
      if (c.id === 'faster-m3' && p) {
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
    `Overtime: ${OPTIONS.overtime[answers.overtime]}`,
    `Preferred kind of fix: ${OPTIONS.fixType[answers.fixType]}`,
  ].join('\n');
}

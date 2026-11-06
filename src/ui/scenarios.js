/**
 * scenarios.js (UI)
 * The four scenarios of the CEO interface. Each starts from DEFAULT_CONFIG with
 * unlimited material and no starting stock; they match the reference scenarios of the
 * data package. The run length is chosen by the CEO (1..60 shifts, default 20 = the
 * length the reference values refer to), and so is the seed (default 1): the seed picks
 * the random draws (M2 rejects, breakdowns), so another seed is "another week" of the
 * same scenario, and the same seed always gives the same run.
 *
 * The starting stock (start-stock.js, default empty) is the ERP stock when the CEO switches it on.
 *
 *   buildUiScenario(id, shifts = 20, seed = 1, start) -> { id, label, shifts, seed, start, configureOptions, disruptionId }
 * configureOptions go straight into engine.configureScenario().
 * disruptionId is the scenario id in the countermeasure catalogue (src/countermeasures/catalog.js):
 * all four scenarios offer the same pool of 6 countermeasures.
 */
import { REFERENCE_OUTAGE } from '../scenarios/scenarios.js';
import { loadDemand } from '../data/loaders.js';
import { normaliseStart } from '../countermeasures/start-stock.js';

export const RUN_SHIFTS = 20;          // default run length
export const MIN_SHIFTS = 1;
export const MAX_SHIFTS = 60;          // the demand profile has 60 rows
export const FLAT_DEMAND = 34;

export const DEFAULT_SEED = 1;
export const MAX_SEED = 99999;

// undefined/null -> seed 1; anything else must be a whole number from 0 to MAX_SEED, otherwise it throws
export function normaliseUiSeed(seed) {
  if (seed === undefined || seed === null) return DEFAULT_SEED;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw new Error(`seed must be a whole number from 0 to ${MAX_SEED}`);
  return seed;
}

// undefined/null -> the default; anything else must be an integer in range, otherwise it throws
export function normaliseShifts(shifts) {
  if (shifts === undefined || shifts === null) return RUN_SHIFTS;
  if (!Number.isInteger(shifts) || shifts < MIN_SHIFTS || shifts > MAX_SHIFTS) {
    throw new Error(`shifts must be a whole number from ${MIN_SHIFTS} to ${MAX_SHIFTS}`);
  }
  return shifts;
}

const DEFS = {
  standard:              { label: 'Standard',            disruptionId: 'standard', demand: n => Array(n).fill(FLAT_DEMAND), outage: null, failures: null },
  'demand-swing':        { label: 'Demand swing',        disruptionId: 'demand-swing', demand: n => loadDemand().slice(0, n), outage: null, failures: null },
  'supplier-outage':     { label: 'Supplier outage',     disruptionId: 'supplier-outage', demand: n => Array(n).fill(FLAT_DEMAND), outage: REFERENCE_OUTAGE, failures: null },
  'machinery-breakdown': { label: 'Machinery breakdown', disruptionId: 'machinery-breakdown', demand: n => Array(n).fill(FLAT_DEMAND), outage: null, failures: { enabled: true } },
};

export const UI_SCENARIO_IDS = Object.keys(DEFS);

export function buildUiScenario(id, shifts = RUN_SHIFTS, seed = DEFAULT_SEED, start = undefined) {
  const d = Object.hasOwn(DEFS, id) ? DEFS[id] : null;
  if (!d) throw new Error(`unknown scenario "${id}" (allowed: ${UI_SCENARIO_IDS.join(', ')})`);
  const n = normaliseShifts(shifts);
  const s = normaliseUiSeed(seed);
  const st = normaliseStart(start);
  const configureOptions = {
    seed: s,
    demand: d.demand(n),
    outage: d.outage ? { ...d.outage } : null,
    failures: d.failures ? { ...d.failures } : null,
    initialFinishedGoods: st.finished,
    rawSafetyStock: st.raw,
  };
  return { id, label: d.label, shifts: n, seed: s, start: st, configureOptions, disruptionId: d.disruptionId };
}

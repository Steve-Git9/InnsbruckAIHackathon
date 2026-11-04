/**
 * scenarios.js (UI)
 * The four scenarios of the CEO interface. Each starts from DEFAULT_CONFIG with
 * unlimited material, seed 1, 20 shifts and no starting stock; they match the
 * reference scenarios of the data package.
 *
 *   buildUiScenario(id) -> { id, label, configureOptions, disruptionId }
 * configureOptions go straight into engine.configureScenario().
 */
import { REFERENCE_OUTAGE } from '../scenarios/scenarios.js';
import { loadDemand } from '../data/loaders.js';

export const RUN_SHIFTS = 20;
export const FLAT_DEMAND = 34;

const flat = () => Array(RUN_SHIFTS).fill(FLAT_DEMAND);

const DEFS = {
  standard:              { label: 'Standard',            disruptionId: null,           demand: flat, outage: null, failures: null },
  'demand-swing':        { label: 'Demand swing',        disruptionId: 'demand-swing', demand: () => loadDemand().slice(0, RUN_SHIFTS), outage: null, failures: null },
  'supplier-outage':     { label: 'Supplier outage',     disruptionId: null,           demand: flat, outage: REFERENCE_OUTAGE, failures: null },
  'machinery-breakdown': { label: 'Machinery breakdown', disruptionId: null,           demand: flat, outage: null, failures: { enabled: true } },
};

export const UI_SCENARIO_IDS = Object.keys(DEFS);

export function buildUiScenario(id) {
  const d = Object.hasOwn(DEFS, id) ? DEFS[id] : null;
  if (!d) throw new Error(`unknown scenario "${id}" (allowed: ${UI_SCENARIO_IDS.join(', ')})`);
  const configureOptions = {
    seed: 1,
    demand: d.demand(),
    outage: d.outage ? { ...d.outage } : null,
    failures: d.failures ? { ...d.failures } : null,
    initialFinishedGoods: 0,
  };
  return { id, label: d.label, configureOptions, disruptionId: d.disruptionId };
}

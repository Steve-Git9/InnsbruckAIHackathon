/**
 * session-rules.js
 * The advanced controls act on the same engine as the CEO run. An action that resets or
 * reconfigures the engine makes the CEO Results stale, so the server forgets the run.
 * play, pause and speed keep it.
 */
const RECONFIGURING_ACTIONS = new Set([
  'reset', 'resetToDefaults', 'loadPreset', 'loadPlantDefault', 'configureScenario', 'spawnMachine', 'removeMachine',
]);
const RECONFIGURING_PARAMS = [
  'seed', 'outage', 'failures', 'supply', 'demand', 'initialFinishedGoods',     // realism layer
  'cycleTime', 'bufferCapacity', 'sourceInterval', 'materialStock', 'rejectRate',
];

export function reconfiguresEngine(action, params = {}) {
  if (action === 'runScenario') return false;          // starts the CEO run itself
  if (RECONFIGURING_ACTIONS.has(action)) return true;
  return RECONFIGURING_PARAMS.some(k => params?.[k] !== undefined);
}

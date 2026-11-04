/**
 * failures.js
 * Machine breakdowns (config.failures, OFF by default).
 *
 * Modes come from failure_rates.csv (AI4I 2020 counts, repair times are
 * organiser assumptions). A failure is drawn once per completed part, from its
 * own stream per machine and mode, so parallel machines fail independently and
 * switching modes on or off never moves the other random draws.
 *
 *   config.failures = {
 *     enabled: true,
 *     repairDistribution: 'fixed' | 'exponential',   // default 'fixed' (the data's assumption)
 *     modes: [{ mode, stations: ['M1'] | 'any', probability, repairTicks }],  // default below
 *   }
 */

export const DEFAULT_FAILURE_MODES = [
  { mode: 'TWF', description: 'Tool wear failure',        stations: ['M1'], probability: 0.0046, repairTicks: 20 },
  { mode: 'HDF', description: 'Heat dissipation failure', stations: ['M1'], probability: 0.0115, repairTicks: 45 },
  { mode: 'PWF', description: 'Power failure',            stations: ['M3'], probability: 0.0095, repairTicks: 30 },
  { mode: 'OSF', description: 'Overstrain failure',       stations: ['M3'], probability: 0.0098, repairTicks: 60 },
  { mode: 'RNF', description: 'Random failure',           stations: 'any',  probability: 0.0019, repairTicks: 15 },
];

// 'M3b' -> 'M3': a parallel machine inherits the failure modes of its station.
export function stationLabel(machineId) {
  return machineId.replace(/[a-z]+$/, '');
}

export function failuresEnabled(cfg) {
  return !!cfg?.enabled;
}

export function modesForMachine(cfg, machineId) {
  const modes = cfg?.modes ?? DEFAULT_FAILURE_MODES;
  const label = stationLabel(machineId);
  return modes.filter(m => m.stations === 'any' || m.stations.includes(label));
}

/**
 * Draw the failure outcome for one completed part of a machine.
 * All applicable modes are drawn every time (even after a hit), so the number of
 * draws per stream does not depend on earlier outcomes.
 * @returns {{mode:string, repair:number}|null}
 */
export function drawFailure(cfg, machineId, streams) {
  let hit = null;
  for (const m of modesForMachine(cfg, machineId)) {
    const hitNow = streams.get(`fail:${machineId}:${m.mode}`)() < m.probability;
    if (hitNow && !hit) {
      let repair = m.repairTicks;
      if (cfg.repairDistribution === 'exponential') {
        const u = streams.get(`repair:${machineId}:${m.mode}`)();
        repair = Math.max(1, Math.ceil(-Math.log(1 - u) * m.repairTicks));
      }
      hit = { mode: m.mode, repair };
    }
  }
  return hit;
}

// Expected downtime ticks per completed part at a machine (analytical value for tests/docs).
export function expectedDowntimePerPart(cfg, machineId) {
  return modesForMachine(cfg, machineId).reduce((a, m) => a + m.probability * m.repairTicks, 0);
}

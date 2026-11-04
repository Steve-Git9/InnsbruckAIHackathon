/**
 * analysis.js
 * Fact layer for the (later) AI shift advisor. No LLM here: these pure functions
 * condense the noisy event log and the per-tick history into numbers the advisor
 * may quote. The Track B README asks to summarise the log per machine and shift
 * before an advisor sees it.
 */

const TICKS_PER_SHIFT = 480;

/**
 * summariseEvents(events) -> per machine and shift, per machine, outage, shortfalls
 * `events` is the event log of runHeadless.
 */
export function summariseEvents(events, { ticksPerShift = TICKS_PER_SHIFT } = {}) {
  const cell = new Map();                       // "M3|11" -> row
  const get = (machine, shift) => {
    const k = `${machine}|${shift}`;
    let r = cell.get(k);
    if (!r) {
      r = { machine, shift, starvedTicks: 0, blockedTicks: 0, starvedEpisodes: 0, blockedEpisodes: 0, breakdowns: 0, downTicks: 0, modes: {} };
      cell.set(k, r);
    }
    return r;
  };
  let outage = null;
  const shortfalls = [];

  for (const e of events) {
    if (e.type === 'outage_start') outage = { ...(outage ?? {}), startTick: e.tick };
    else if (e.type === 'outage_end') outage = { ...(outage ?? {}), endTick: e.tick };
    else if (e.type === 'shortfall') shortfalls.push({ shift: e.shift, ordered: e.ordered, shippedOnTime: e.shippedOnTime, short: e.short });
    else if (e.type === 'machine_starved') { const r = get(e.machine, e.shift); r.starvedTicks += e.ticks; r.starvedEpisodes++; }
    else if (e.type === 'machine_blocked') { const r = get(e.machine, e.shift); r.blockedTicks += e.ticks; r.blockedEpisodes++; }
    else if (e.type === 'breakdown') {
      const r = get(e.machine, e.shift);
      r.breakdowns++; r.downTicks += e.ticks; r.modes[e.mode] = (r.modes[e.mode] ?? 0) + 1;
    }
  }

  const perMachineShift = [...cell.values()].sort((a, b) => a.machine.localeCompare(b.machine) || a.shift - b.shift);
  const perMachine = {};
  for (const r of perMachineShift) {
    const m = (perMachine[r.machine] ??= { starvedTicks: 0, blockedTicks: 0, breakdowns: 0, downTicks: 0, worstShift: null });
    m.starvedTicks += r.starvedTicks; m.blockedTicks += r.blockedTicks;
    m.breakdowns += r.breakdowns; m.downTicks += r.downTicks;
    const lost = r.starvedTicks + r.blockedTicks + r.downTicks;
    if (!m.worstShift || lost > m.worstShift.lost) m.worstShift = { shift: r.shift, lost };
  }
  return { perMachineShift, perMachine, outage, shortfalls, ticksPerShift };
}

// Ticks a part needs to get from the source to the machine's input: the sum of the
// cycle times upstream. After an outage the starved bottleneck needs about this
// long to see parts again, so that time still counts as "starved by the outage".
export function upstreamCycleTicks(config, machineId) {
  const m = config.machines.find(x => x.id === machineId);
  if (!m) return 0;
  const byStation = new Map();
  for (const x of config.machines) if (!byStation.has(x.stationId)) byStation.set(x.stationId, x);
  let ticks = 0;
  const stations = [...byStation.values()];
  const idx = stations.findIndex(x => x.stationId === m.stationId);
  for (let i = 0; i < idx; i++) ticks += stations[i].cycleTime;
  return ticks;
}

/**
 * bottleneckLoss(history, opts) -> where the bottleneck's minutes went
 *   processing | down | starvedOutage | starvedUpstream | blocked | other
 *
 *  - down:            broken down (breakdown repair time)
 *  - starvedOutage:   starved while the supplier outage was on, or while the line refilled after it
 *  - starvedUpstream: starved for any other reason (upstream stations, rejects, own shortage)
 *  - blocked:         finished but the next buffer was full
 *
 * opts: { machineIds?, outage?, refillTicks?, config?, ticksPerShift? }
 * Without machineIds the busiest station (most processing ticks) is taken.
 * Minutes of parallel machines add up.
 */
export function bottleneckLoss(history, opts = {}) {
  const tps = opts.ticksPerShift ?? TICKS_PER_SHIFT;
  const last = history[history.length - 1];
  if (!last) return { machines: [], total: emptyLoss(), perShift: [], lostMinutes: 0, lossShare: {} };

  let machineIds = opts.machineIds;
  if (!machineIds) {
    const ids = Object.keys(last).filter(k => k.endsWith('_ticksProcessing')).map(k => k.slice(0, -'_ticksProcessing'.length));
    const label = (id) => id.replace(/[a-z]+$/, '');
    const perLabel = new Map();
    for (const id of ids) perLabel.set(label(id), (perLabel.get(label(id)) ?? 0) + last[`${id}_ticksProcessing`]);
    const top = [...perLabel.entries()].sort((a, b) => b[1] - a[1])[0][0];
    machineIds = ids.filter(id => label(id) === top);
  }

  const outage = opts.outage ?? null;
  const refill = opts.refillTicks ?? (opts.config ? upstreamCycleTicks(opts.config, machineIds[0]) : 0);
  const outageStarvation = (tick) => !!outage && tick > outage.startTick && tick <= outage.endTick + refill;

  const total = emptyLoss();
  const perShift = [];
  for (const row of history) {
    const shift = Math.ceil(row.tick / tps);
    const ps = (perShift[shift - 1] ??= { shift, ...emptyLoss() });
    for (const id of machineIds) {
      const st = row[`${id}_state`];
      let cause;
      if (st === 'PROCESSING') cause = 'processing';
      else if (st === 'DOWN') cause = 'down';
      else if (st === 'STARVED') cause = outageStarvation(row.tick) ? 'starvedOutage' : 'starvedUpstream';
      else if (st === 'BLOCKED') cause = 'blocked';
      else cause = 'other';
      total[cause]++; ps[cause]++;
    }
  }
  const scheduled = Object.values(total).reduce((a, v) => a + v, 0);
  const lostMinutes = scheduled - total.processing;
  const lossShare = {};
  for (const k of Object.keys(total)) if (k !== 'processing') lossShare[k] = lostMinutes > 0 ? total[k] / lostMinutes : 0;
  return { machines: machineIds, total, perShift, scheduled, lostMinutes, lossShare };
}

function emptyLoss() {
  return { processing: 0, down: 0, starvedOutage: 0, starvedUpstream: 0, blocked: 0, other: 0 };
}

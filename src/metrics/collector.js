/**
 * collector.js
 * Pure metrics calculation — no side effects, no external state.
 *
 * This module receives a simulation state snapshot (the JSON object returned
 * by engine.getState()) and returns a plain metrics object. You can call it
 * from the REST API or from unit tests
 * without ever touching the simulation engine itself.
 *
 * Concept mapping (terms used in commercial line simulators such as Plant Simulation):
 *   - utilization      → Statistics object / "utilization"
 *   - bottleneck flag  → Bottleneck Analyzer result
 *   - avgLeadTime      → lead time (time a part spends in the line)
 *   - throughput       → production rate
 */

// A station whose average machine utilization exceeds this is "busy" — the
// first gate for being the line's constraint. Tunable.
const BOTTLENECK_UTIL_THRESHOLD = 0.6;
// A station blocked more than this fraction of the time is a *victim* of a
// downstream constraint, not the constraint itself — it fails the second gate.
const BLOCKED_MAX = 0.05;
// A station starved at least this fraction of the time is "starved"; also used
// for the source-starved diagnostic and the STARVED_BY_UPSTREAM classification.
const STARVED_MIN = 0.10;
// Confidence-score weights (sum to 1): utilization, un-blockedness, downstream
// starvation, upstream buffer fill.
const W_UTIL   = 0.4;
const W_BLOCK  = 0.2;
const W_STARVE = 0.2;
const W_FILL   = 0.2;
// Keep in sync with engine MAX_MACHINES_PER_STATION — no point suggesting a
// spawn for a station that is already full.
const MAX_MACHINES_PER_STATION = 4;
// Bottleneck detection is suppressed for the first WARMUP_TICKS of a run. The
// utilization window holds too little data early on, so ratios swing wildly and
// the verdict (marker, banner) would flicker. ~3s at the default 10 ticks/s.
const WARMUP_TICKS = 30;

/**
 * calculateMetrics(state) → metrics object
 *
 * @param {object} state  - snapshot from SimulationEngine.getState()
 * @returns {object}      - structured metrics, ready for JSON
 */
export function calculateMetrics(state) {
  const tick     = state.tick || 1; // avoid division by zero at tick 0
  const machines = state.machines  ?? [];
  const buffers  = state.buffers   ?? [];
  const sink     = state.sink      ?? { partsReceived: 0, recentParts: [] };
  const scrap    = state.scrap     ?? { partsReceived: 0 };

  // ── Throughput ─────────────────────────────────────────────────────────────
  // Parts completed per 100 ticks — a normalised rate students can compare
  // across different simulation run lengths.
  const throughput = tick > 0
    ? (sink.partsReceived / tick) * 100
    : 0;

  // ── Lead-time distribution ──────────────────────────────────────────────────
  // Ticks from Source emission to Sink arrival, over recent completed parts.
  // The mean alone hides spread; two lines with equal averages but different
  // variance behave very differently, so we also report min/max/median/p95/stdDev.
  const leadTimes = (sink.recentParts ?? []).map(p => p.completedAt - p.createdAt);
  const leadTimeStats = summariseLeadTimes(leadTimes);
  const avgLeadTime = leadTimeStats.avg;

  // ── Flow efficiency (value-added ratio) ─────────────────────────────────────
  // Fraction of a part's lead time actually spent being processed, vs waiting in
  // buffers. theoretical = sum of one machine's cycle time per station (parallel
  // machines add capacity, not extra processing steps, so each station counts
  // once). Usually low — the headline lean insight that most of a part's life is
  // spent queueing. 0 until parts complete (avgLeadTime still 0).
  const cycleByStation = new Map();
  for (const m of machines) {
    if (!cycleByStation.has(m.stationId)) cycleByStation.set(m.stationId, m.cycleTime ?? 0);
  }
  const theoreticalProcessing = [...cycleByStation.values()].reduce((s, c) => s + c, 0);
  const flowEfficiency = avgLeadTime > 0
    ? Math.round((theoreticalProcessing / avgLeadTime) * 100) / 100
    : 0;

  // ── Parts currently in the system ─────────────────────────────────────────
  // Sum of parts in all buffers + parts inside machines
  const partsInBuffers  = buffers.reduce((sum, b) => sum + b.load, 0);
  const partsInMachines = machines.filter(m => m.currentPartId !== null).length;
  const partsInSystem   = partsInBuffers + partsInMachines;

  // ── Per-machine metrics ────────────────────────────────────────────────────
  const bufferById = {};
  for (const b of buffers) bufferById[b.id] = b;

  // Utilization and bottleneck detection use recent-window tick counts (winX)
  // so the verdict reflects current flow; we fall back to lifetime counters for
  // snapshots that predate windowing (e.g. unit-test fixtures).
  const winTicks = (m) => ({
    proc:    m.winProcessing ?? m.ticksProcessing,
    blocked: m.winBlocked    ?? m.ticksBlocked,
    starved: m.winStarved    ?? m.ticksStarved,
    idle:    m.winIdle       ?? m.ticksIdle,
    down:    m.winDown       ?? m.ticksDown ?? 0,
  });

  const machineMetrics = machines.map(m => {
    const w = winTicks(m);
    const totalTicks = w.proc + w.blocked + w.starved + w.idle + w.down;
    const utilization  = totalTicks > 0 ? w.proc    / totalTicks : 0;
    const blockedRatio = totalTicks > 0 ? w.blocked / totalTicks : 0;
    const starvedRatio = totalTicks > 0 ? w.starved / totalTicks : 0;

    const upstreamBuffer = bufferById[m.inputBufferId] ?? null;
    const avgQueueWait   = upstreamBuffer && upstreamBuffer.totalPartsOut > 0
      ? upstreamBuffer.totalWaitTicks / upstreamBuffer.totalPartsOut
      : 0;

    // Per-machine throughput: parts this machine processed per 100 ticks,
    // normalised the same way as the line-level throughput above so students can
    // compare a station's actual output against the line and against capacity.
    const machineThroughput = tick > 0 ? (m.partsProcessed / tick) * 100 : 0;

    return {
      id:           m.id,
      stationId:    m.stationId,
      name:         m.name,
      utilization,
      throughput:   Math.round(machineThroughput * 100) / 100,
      avgQueueWait,
      downRatio:    totalTicks > 0 ? w.down / totalTicks : 0,
      downTime:     m.ticksDown ?? 0,
      blockedTime:  m.ticksBlocked,
      starvedTime:  m.ticksStarved,
      blockedRatio,                 // own ratio, 0–1
      starvedRatio,                 // own ratio, 0–1
      currentState: m.state,
      bottleneck:          false,   // filled in by detection below
      flowState:           'BALANCED',
      isPrimaryConstraint: false,
    };
  });

  // ── Bottleneck detection (flow-based: utilization gate + starvation/blocking) ─
  // A station is the *true constraint* when it is busy (high utilization) AND
  // barely blocked — a blocked station is a victim of a downstream constraint.
  // Two confirming flow signals (a starved downstream, a backed-up upstream
  // buffer) raise a confidence score used to rank constraints and pick the
  // primary one. See the design spec referenced in the file header.
  const clamp = (x) => Math.max(0, Math.min(1, x));

  // Aggregate per station (ratios of summed ticks across parallel machines).
  const stationAgg = new Map(); // stationId -> aggregate
  for (const mc of machines) {
    const w = winTicks(mc);
    const totalTicks = w.proc + w.blocked + w.starved + w.idle + w.down;
    const a = stationAgg.get(mc.stationId) ?? {
      stationId: mc.stationId, proc: 0, down: 0, blocked: 0, starved: 0, total: 0,
      // Parallel machines in a station share one input and one output buffer,
      // so the first machine's buffer ids represent the whole station.
      inputBufferId: mc.inputBufferId, outputBufferId: mc.outputBufferId,
    };
    a.proc    += w.proc;
    a.down    += w.down;
    a.blocked += w.blocked;
    a.starved += w.starved;
    a.total   += totalTicks;
    stationAgg.set(mc.stationId, a);
  }
  for (const a of stationAgg.values()) {
    a.avgUtil      = a.total > 0 ? a.proc    / a.total : 0;
    // A broken-down station is not idle: it cannot work, but it still paces the
    // line. For the constraint gate its down time counts as busy time.
    a.busyShare    = a.total > 0 ? (a.proc + a.down) / a.total : 0;
    a.blockedRatio = a.total > 0 ? a.blocked / a.total : 0;
    a.starvedRatio = a.total > 0 ? a.starved / a.total : 0;
    const inBuf = bufferById[a.inputBufferId] ?? null;
    a.inputFill  = inBuf && inBuf.capacity > 0 ? inBuf.load / inBuf.capacity : 0;
  }

  // Topology (linear chain): downstream station = the station whose input
  // buffer is this station's output buffer.
  const stationByInputBuffer = new Map();
  for (const a of stationAgg.values()) stationByInputBuffer.set(a.inputBufferId, a.stationId);
  for (const a of stationAgg.values()) {
    const downId = a.outputBufferId != null ? stationByInputBuffer.get(a.outputBufferId) : undefined;
    a.downstream = downId != null ? stationAgg.get(downId) : null;
  }

  // Gate + confidence score. Suppressed during warm-up (see WARMUP_TICKS): the
  // recent-window ratios are too noisy in the first few seconds to trust.
  const warmedUp = (state.tick ?? 0) >= WARMUP_TICKS;
  const constraints = [];
  for (const a of (warmedUp ? stationAgg.values() : [])) {
    const busy       = a.busyShare > BOTTLENECK_UTIL_THRESHOLD;
    const notBlocked = a.blockedRatio < BLOCKED_MAX;
    if (!(busy && notBlocked)) continue;
    // A constraint paces everything after it, so a starved downstream is a
    // positive signal. The last station has no downstream to starve, so treat
    // its absence as a full positive signal (1) rather than missing evidence.
    const starveTerm = a.downstream ? clamp(a.downstream.starvedRatio) : 1;
    a.confidence =
        W_UTIL   * clamp(a.avgUtil)
      + W_BLOCK  * (1 - a.blockedRatio / BLOCKED_MAX)
      + W_STARVE * starveTerm
      + W_FILL   * clamp(a.inputFill);
    constraints.push(a);
  }
  constraints.sort((x, y) => y.confidence - x.confidence);

  const constraintStationIds = new Set(constraints.map(a => a.stationId));
  const primaryStationId     = constraints[0]?.stationId ?? null;

  // Write flags + flowState onto each machine (station-level verdict).
  machineMetrics.forEach(mm => {
    const a = stationAgg.get(mm.stationId);
    mm.bottleneck          = constraintStationIds.has(mm.stationId);
    mm.isPrimaryConstraint = mm.stationId === primaryStationId;
    mm.flowState =
        mm.bottleneck                 ? 'CONSTRAINT'
      : a.blockedRatio >= BLOCKED_MAX  ? 'BLOCKED_BY_DOWNSTREAM'
      : a.starvedRatio >= STARVED_MIN  ? 'STARVED_BY_UPSTREAM'
      :                                  'BALANCED';
  });

  // Source-starved guard: only relevant when NO internal constraint was found.
  const outputBuffers = new Set(
    [...stationAgg.values()].map(a => a.outputBufferId).filter(id => id != null)
  );
  const firstStation = [...stationAgg.values()].find(a => !outputBuffers.has(a.inputBufferId)) ?? null;
  const sourceStarved = firstStation != null && firstStation.starvedRatio >= STARVED_MIN;
  const anyBusy = [...stationAgg.values()].some(a => a.busyShare > BOTTLENECK_UTIL_THRESHOLD);

  // Suggestions: one spawn per constraint with room, ranked by confidence.
  const suggestions = [];
  for (const a of constraints) {
    const stationMachines = machineMetrics.filter(mm => mm.stationId === a.stationId);
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) continue;
    const rep = stationMachines[0];
    suggestions.push({
      type: 'add-parallel-machine',
      stationId: a.stationId,
      machineId: rep.id,
      avgUtil: a.avgUtil,
      threshold: BOTTLENECK_UTIL_THRESHOLD,
      confidence: Math.round(a.confidence * 100) / 100,
      flowState: 'CONSTRAINT',
      label: `${rep.id} (${rep.name}) is the bottleneck: it limits the throughput of the line.`,
      reason: (() => {
        const util  = Math.round(a.avgUtil * 100);
        const block = Math.round(a.blockedRatio * 100);
        const fill  = Math.round(a.inputFill * 100);
        const downClause = a.downstream
          ? `, and the downstream station is waiting (${Math.round(a.downstream.starvedRatio * 100)}% idle)`
          : ' (last station on the line)';
        return `Detected because station ${a.stationId} is the constraint: ${util}% utilization, `
             + `only ${block}% blocked${downClause} — parts pile up in front of it `
             + `(input buffer ${fill}% full). A blocked station, by contrast, would `
             + `merely be the victim of a downstream constraint.`;
      })(),
    });
  }

  // Diagnostic note: no internal constraint, but the line is supply-limited or
  // everything is blocked. Emitted only when no station passed the gates.
  // A starved line is not always "supply-limited": the simple material limit may simply
  // have run out, or the supplier outage may be active. Say so instead of advising a
  // faster feed. These notes replace the generic one below.
  const out = state.outage;
  const inOutage = !!out && state.tick > out.startTick && state.tick <= out.endTick;
  const depleted = state.source?.materialStock === 0 && state.supply?.mode !== 'inventory';
  if (depleted) {
    suggestions.length = 0;
    suggestions.push({
      type: 'material-depleted',
      reason: 'Material stock has run out: the source has no parts left to release, so the line '
            + 'drains and stops. This is the starter\'s simple material limit (default 200 parts), '
            + 'not a bottleneck. Set the material slider to ∞ or click "Load plant default" for long runs.',
    });
  } else if (inOutage) {
    suggestions.length = 0;
    // with raw stock at the source (ERP start) the line keeps running from it until it is empty
    const raw = state.source?.rawOnHand ?? 0, level = state.source?.rawSafetyLevel ?? 0;
    suggestions.push({
      type: 'supplier-outage',
      reason: level > 0 && raw > 0
        ? `Supplier outage (ticks ${out.startTick}–${out.endTick}): no deliveries, but the raw stock at the source `
          + `keeps the line running (${raw} of ${level} units left). If it runs out before the outage ends, the line runs empty.`
        : `Supplier outage (ticks ${out.startTick}–${out.endTick}): the source releases no parts, `
          + `${level > 0 ? 'the raw stock is used up, ' : ''}so the line runs empty. Machines are starved by missing supply, `
          + 'not by a bottleneck; output returns after the outage ends.',
    });
  } else if (warmedUp && constraints.length === 0 && (sourceStarved || anyBusy)) {
    suggestions.push({
      type: 'no-internal-constraint',
      reason: 'No bottleneck at the machines — the line is running in balance. '
            + 'Throughput is limited by the material supply (the source delivers '
            + 'parts more slowly than the machines could process them). '
            + 'Additional machines or shorter cycle times will not help here; '
            + 'increase the material feed instead to reach more throughput.',
    });
  }

  // ── Buffer metrics ─────────────────────────────────────────────────────────
  const bufferMetrics = buffers.map(b => ({
    id:               b.id,
    currentLoad:      b.load,
    capacity:         b.capacity,
    utilizationRatio: b.capacity > 0 ? b.load / b.capacity : 0,
  }));

  return {
    throughput:    Math.round(throughput * 100) / 100,
    avgLeadTime:   Math.round(avgLeadTime * 10) / 10,
    leadTimeStats,
    flowEfficiency,
    scrappedParts: scrap.partsReceived,
    machines:      machineMetrics,
    buffers:       bufferMetrics,
    simTime:       tick,
    partsInSystem,
    suggestions,
  };
}

// Summarise a list of lead times into count/min/max/avg/p50/p95/stdDev.
// Percentiles use the nearest-rank method (index = ceil(p/100 · n) − 1). Returns
// all-zero stats for an empty list. Values rounded to 1 decimal place.
function summariseLeadTimes(values) {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, stdDev: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  const avg = sum / n;
  const variance = sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / n;
  const percentile = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    count:  n,
    min:    round1(sorted[0]),
    max:    round1(sorted[n - 1]),
    avg:    round1(avg),
    p50:    round1(percentile(50)),
    p95:    round1(percentile(95)),
    stdDev: round1(Math.sqrt(variance)),
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../src/metrics/collector.js';

// Build a minimal state snapshot from machine specs.
// Spec fields: { id, stationId, inputBufferId, outputBufferId?, proc,
//                blocked?, starved?, name?, cycleTime?, partsProcessed? }.
//   Total ticks fixed at 100; starved defaults to (100 - proc - blocked).
// Buffers are derived from the ids the machines reference. Override a buffer's
// capacity/load/wait via `bufferOverrides`, e.g. { BUF1: { load: 3, capacity: 3 } }.
// `sink` overrides the sink snapshot, e.g. { recentParts: [...] }.
function makeState(machineSpecs, bufferOverrides = {}, sink = undefined) {
  const bufferIds = new Set();
  for (const s of machineSpecs) {
    if (s.inputBufferId)  bufferIds.add(s.inputBufferId);
    if (s.outputBufferId) bufferIds.add(s.outputBufferId);
  }
  const buffers = [...bufferIds].map(id => ({
    id,
    capacity:       bufferOverrides[id]?.capacity ?? 4,
    load:           bufferOverrides[id]?.load ?? 0,
    totalWaitTicks: bufferOverrides[id]?.totalWaitTicks ?? 0,
    totalPartsOut:  bufferOverrides[id]?.totalPartsOut ?? 1,
  }));
  return {
    tick: 100,
    machines: machineSpecs.map(s => {
      const proc    = s.proc;
      const blocked = s.blocked ?? 0;
      const starved = s.starved ?? (100 - proc - blocked);
      return {
        id: s.id, stationId: s.stationId, name: s.name ?? s.id,
        inputBufferId: s.inputBufferId, outputBufferId: s.outputBufferId ?? null,
        state: 'PROCESSING', currentPartId: 1, cycleTime: s.cycleTime ?? 5, rejectRate: 0,
        ticksProcessing: proc, ticksBlocked: blocked,
        ticksStarved: starved, ticksIdle: 0,
        partsProcessed: s.partsProcessed ?? proc,
      };
    }),
    buffers,
    sink: sink ?? { partsReceived: 10, recentParts: [] },
    scrap: { partsReceived: 0 },
  };
}

// Sink snapshot with the given lead times (completedAt - createdAt per part).
function makeSink(leadTimes) {
  return {
    partsReceived: leadTimes.length,
    recentParts: leadTimes.map((lt, i) => ({ id: i + 1, createdAt: 0, completedAt: lt })),
  };
}

test('a single saturated station is flagged and gets one suggestion', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').bottleneck, true);
  assert.equal(m.machines.find(x => x.id === 'A').bottleneck, false);
  assert.equal(m.suggestions.length, 1);
  assert.equal(m.suggestions[0].type, 'add-parallel-machine');
  assert.equal(m.suggestions[0].stationId, 'S2');
  assert.equal(m.suggestions[0].machineId, 'B');
  assert.match(m.suggestions[0].label, /B/);
});

test('no bottleneck or suggestions during the warm-up window (early ticks fluctuate)', () => {
  const base = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95 },
  ]);

  // Early in the run the utilization window holds too little data to trust.
  const early = calculateMetrics({ ...base, tick: 10 });
  assert.equal(early.machines.find(x => x.id === 'B').bottleneck, false);
  assert.equal(early.suggestions.length, 0);

  // Once past the warm-up window the same saturation is flagged as before.
  const later = calculateMetrics({ ...base, tick: 100 });
  assert.equal(later.machines.find(x => x.id === 'B').bottleneck, true);
  assert.ok(later.suggestions.length >= 1);
});

test('multiple un-blocked constraints are suggested highest-confidence first', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.suggestions.length, 2);
  assert.deepEqual(m.suggestions.map(s => s.stationId), ['S2', 'S1']);
  assert.ok(m.suggestions[0].confidence >= m.suggestions[1].confidence);
  assert.equal(m.suggestions[0].flowState, 'CONSTRAINT');
});

test('a source-starved line yields no bottleneck and a diagnostic note', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 20, blocked: 0, starved: 80 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 25, blocked: 0, starved: 75 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.every(x => x.bottleneck === false));
  assert.equal(m.suggestions.length, 1);
  assert.equal(m.suggestions[0].type, 'no-internal-constraint');
  assert.equal(m.suggestions[0].machineId, undefined);
});

test('an everything-blocked line yields a diagnostic note', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 65, blocked: 35 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 65, blocked: 35 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.every(x => x.bottleneck === false));
  assert.equal(m.suggestions.length, 1);
  assert.equal(m.suggestions[0].type, 'no-internal-constraint');
});

test('a constraint at the machine cap is flagged but yields no spawn suggestion', () => {
  const state = makeState([
    { id: 'A',  stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B',  stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
    { id: 'Bb', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
    { id: 'Bc', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
    { id: 'Bd', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.ok(m.machines.find(x => x.id === 'B').bottleneck);
  assert.deepEqual(m.suggestions, []);
});

test('each spawn suggestion carries confidence, threshold, and a flow-aware reason', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  const sug = m.suggestions[0];
  assert.equal(sug.threshold, 0.6);
  assert.equal(typeof sug.confidence, 'number');
  assert.match(sug.reason, /S2/);
  assert.match(sug.reason, /95%/);
  assert.match(sug.reason, /blocked/);
});

test('avgQueueWait uses the machine input buffer', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ], {
    BUF0: { totalWaitTicks: 50,  totalPartsOut: 10 },
    BUF1: { totalWaitTicks: 200, totalPartsOut: 10 },
  });
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').avgQueueWait, 20); // 200/10
  assert.equal(m.machines.find(x => x.id === 'A').avgQueueWait, 5);  // 50/10
});

test('a busy, un-blocked station is flagged as the constraint', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  const b = m.machines.find(x => x.id === 'B');
  assert.equal(b.bottleneck, true);
  assert.equal(b.flowState, 'CONSTRAINT');
  assert.equal(b.isPrimaryConstraint, true);
});

test('a busy-but-blocked station is NOT the constraint (it is a downstream victim)', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 55, blocked: 40 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  const a = m.machines.find(x => x.id === 'A');
  const b = m.machines.find(x => x.id === 'B');
  assert.equal(a.bottleneck, false);
  assert.equal(a.flowState, 'BLOCKED_BY_DOWNSTREAM');
  assert.equal(b.bottleneck, true);
  assert.equal(b.isPrimaryConstraint, true);
});

test('the last station can be the constraint even with no downstream', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 90, blocked: 0 },
  ]);
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').bottleneck, true);
});

test('a starved-but-not-busy station is classified STARVED_BY_UPSTREAM', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 95, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 20, blocked: 0, starved: 80 },
  ]);
  const m = calculateMetrics(state);
  const b = m.machines.find(x => x.id === 'B');
  assert.equal(b.bottleneck, false);
  assert.equal(b.flowState, 'STARVED_BY_UPSTREAM');
});

test('two un-blocked busy stations are ranked by confidence, primary = highest', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 70, blocked: 0 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: 'BUF2', proc: 95, blocked: 0 },
    { id: 'C', stationId: 'S3', inputBufferId: 'BUF2', outputBufferId: null,   proc: 30, blocked: 0, starved: 70 },
  ], { BUF1: { load: 3, capacity: 3 } });
  const m = calculateMetrics(state);
  assert.equal(m.machines.find(x => x.id === 'B').isPrimaryConstraint, true);
  assert.equal(m.machines.find(x => x.id === 'A').isPrimaryConstraint, false);
});

// ── Flow efficiency (value-added ratio) ──────────────────────────────────────

test('flowEfficiency is theoretical processing time over average lead time', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30, cycleTime: 5 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 30, cycleTime: 10 },
  ], {}, makeSink([10, 20, 30, 40, 50]));   // avg lead time = 30
  const m = calculateMetrics(state);
  // theoretical = 5 + 10 = 15 ; 15 / 30 = 0.5
  assert.equal(m.flowEfficiency, 0.5);
});

test('flowEfficiency counts each station once even with parallel machines', () => {
  const state = makeState([
    { id: 'A',  stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30, cycleTime: 5 },
    { id: 'Ab', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30, cycleTime: 5 },
    { id: 'B',  stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 30, cycleTime: 10 },
  ], {}, makeSink([30]));   // avg lead time = 30
  const m = calculateMetrics(state);
  // theoretical = 5 (S1, counted once) + 10 (S2) = 15 ; 15 / 30 = 0.5
  assert.equal(m.flowEfficiency, 0.5);
});

test('flowEfficiency is 0 when no parts have completed', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: null, proc: 30, cycleTime: 5 },
  ], {}, makeSink([]));
  const m = calculateMetrics(state);
  assert.equal(m.flowEfficiency, 0);
});

// ── Lead-time distribution ────────────────────────────────────────────────────

test('leadTimeStats reports count, min, max, avg, median, p95 and stdDev', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: null, proc: 30 },
  ], {}, makeSink([10, 20, 30, 40, 50]));
  const s = calculateMetrics(state).leadTimeStats;
  assert.equal(s.count, 5);
  assert.equal(s.min, 10);
  assert.equal(s.max, 50);
  assert.equal(s.avg, 30);
  assert.equal(s.p50, 30);          // nearest-rank median
  assert.equal(s.p95, 50);
  assert.equal(s.stdDev, 14.1);     // sqrt(200) ≈ 14.14, rounded to 1 dp
});

test('leadTimeStats is all zeros with no completed parts', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: null, proc: 30 },
  ], {}, makeSink([]));
  const s = calculateMetrics(state).leadTimeStats;
  assert.deepEqual(s, { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, stdDev: 0 });
});

test('avgLeadTime still equals leadTimeStats.avg (backward compatible)', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: null, proc: 30 },
  ], {}, makeSink([10, 20, 30, 40, 50]));
  const m = calculateMetrics(state);
  assert.equal(m.avgLeadTime, m.leadTimeStats.avg);
});

// ── Per-machine throughput rate ───────────────────────────────────────────────

test('each machine reports throughput as parts processed per 100 ticks', () => {
  const state = makeState([
    { id: 'A', stationId: 'S1', inputBufferId: 'BUF0', outputBufferId: 'BUF1', proc: 30, partsProcessed: 25 },
    { id: 'B', stationId: 'S2', inputBufferId: 'BUF1', outputBufferId: null,   proc: 95, partsProcessed: 80 },
  ]);   // tick = 100
  const m = calculateMetrics(state);
  // (partsProcessed / tick) * 100, with tick = 100 → equals partsProcessed
  assert.equal(m.machines.find(x => x.id === 'A').throughput, 25);
  assert.equal(m.machines.find(x => x.id === 'B').throughput, 80);
});

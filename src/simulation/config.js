/**
 * config.js
 * Default simulation configuration. Most values can be changed at runtime
 * via POST /api/control (and the UI sliders).
 */

export const DEFAULT_CONFIG = {
  // Simulation clock: ticks per second of wall-clock time (affects animation speed)
  ticksPerSecond: 10,

  // Source node: generates one part every `interval` ticks.
  // With the cycle times below, M3 Assembly is the bottleneck of the default
  // line: the feed into M3 (after the M2 rejects) runs about 6% above its
  // capacity, so parts pile up in BUF2 (its input buffer).
  source: {
    interval: 11,         // ticks between part generations
    materialStock: 200,   // how many parts can be produced before material runs out (-1 = infinite)
  },

  // Machines: each declares its station and the buffers it pulls from / pushes to.
  // outputBufferId:null means the machine pushes finished parts to the Sink.
  machines: [
    { id: 'M1', stationId: 'S1', name: 'Machining',    cycleTime: 4,                  inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
    { id: 'M2', stationId: 'S2', name: 'Quality Check',  cycleTime: 3, rejectRate: 0.10, inputBufferId: 'BUF1', outputBufferId: 'BUF2' },
    { id: 'M3', stationId: 'S3', name: 'Assembly',           cycleTime: 13,                 inputBufferId: 'BUF2', outputBufferId: 'BUF3' },
    { id: 'M4', stationId: 'S4', name: 'Packaging',        cycleTime: 2,                  inputBufferId: 'BUF3', outputBufferId: null   },
  ],

  // Buffers between stations (order: BUF0=Source→M1, BUF1=M1→M2, BUF2=M2→M3, BUF3=M3→M4)
  // BUF2 (the queue in front of the M3 bottleneck) is roomier so the work-in-
  // progress piling up ahead of the constraint is clearly visible.
  buffers: [
    { id: 'BUF0', capacity: 4 },
    { id: 'BUF1', capacity: 3 },
    { id: 'BUF2', capacity: 6 },
    { id: 'BUF3', capacity: 2 },
  ],
};

/**
 * entities.js
 * Class definitions for every object in the simulation world:
 *   Part, Source, Buffer, Machine, Sink, ScrapSink
 *
 * These are plain data-carrying objects. The engine.js tick loop
 * orchestrates how they interact. Keeping data and logic separate
 * mirrors the object/method design of commercial line simulators.
 */

// ─── Machine states ────────────────────────────────────────────────────────
export const MachineState = {
  IDLE:       'IDLE',        // ready but no part available
  PROCESSING: 'PROCESSING',  // actively working on a part
  BLOCKED:    'BLOCKED',     // finished but downstream buffer is full
  STARVED:    'STARVED',     // no part in upstream buffer to work on
  DOWN:       'DOWN',        // broken down; holds its part until repaired (config.failures)
};

// ─── Part ──────────────────────────────────────────────────────────────────
export class Part {
  constructor(id, createdAt) {
    this.id            = id;
    this.createdAt     = createdAt;   // tick when the Source emitted this part
    this.enteredMachineAt = null;     // tick when the current/last machine started it
    this.completedAt   = null;        // tick when it reached the Sink
  }
}

// ─── Source ────────────────────────────────────────────────────────────────
// Generates parts at a fixed interval; stops when materialStock hits zero.
export class Source {
  constructor(cfg) {
    this.id            = 'SOURCE';
    this.interval      = cfg.interval;         // ticks between part emissions
    this.materialStock = cfg.materialStock;    // -1 means infinite, 0 means depleted
    this.ticksSinceLast = 0;                   // countdown to next emission
    this.totalGenerated = 0;
    this.lastEmitted   = false;               // true on the tick a part was emitted (for animation)
  }
}

// ─── Buffer ────────────────────────────────────────────────────────────────
// FIFO queue with a fixed capacity. Machines pull from it and push into it.
export class Buffer {
  constructor(cfg) {
    this.id       = cfg.id;
    this.capacity = cfg.capacity;
    this.parts    = [];             // array of Part objects, index 0 = oldest

    // Tracking for metrics
    this.totalWaitTicks  = 0;      // sum of ticks all parts spent waiting here
    this.totalPartsOut   = 0;      // parts that left this buffer (for avg wait calc)
    this.ticksAtLoad     = {};     // snapshot: { tick: load } — used by metrics
  }
}

// ─── Machine ───────────────────────────────────────────────────────────────
export class Machine {
  constructor(cfg) {
    this.id          = cfg.id;
    this.name        = cfg.name;
    this.cycleTime   = cfg.cycleTime;
    this.rejectRate  = cfg.rejectRate ?? 0;    // fraction 0–1; non-zero on M2
    this.stationId      = cfg.stationId;
    this.inputBufferId  = cfg.inputBufferId;
    this.outputBufferId = cfg.outputBufferId ?? null;   // null ⇒ pushes to Sink

    this.state       = MachineState.IDLE;
    this.currentPart = null;       // Part currently being processed
    this.ticksLeft   = 0;          // ticks remaining until processing completes

    // State-time counters (for utilization and bottleneck detection)
    this.ticksProcessing = 0;
    this.ticksBlocked    = 0;
    this.ticksStarved    = 0;
    this.ticksIdle       = 0;
    this.ticksDown       = 0;

    // Breakdown state: ticks of repair still to go while DOWN
    this.repairLeft      = 0;

    // Parts processed by this machine (for per-machine throughput)
    this.partsProcessed  = 0;
    this.scrapped        = 0;      // parts this machine rejected (quality gate)
  }
}

// ─── Sink ──────────────────────────────────────────────────────────────────
// Consumes finished, accepted parts and records lead times.
export class Sink {
  constructor() {
    this.id              = 'SINK';
    this.partsReceived   = 0;
    this.completedParts  = [];     // array of Part objects with completedAt set
  }
}

// ─── ScrapSink ─────────────────────────────────────────────────────────────
// Consumes rejected parts from the quality gate machine (M2).
export class ScrapSink {
  constructor() {
    this.id            = 'SCRAP';
    this.partsReceived = 0;
  }
}

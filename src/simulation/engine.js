/**
 * engine.js
 * Core discrete-event tick loop for the machine_sim teaching simulation.
 *
 * Architecture:
 *   - Each "tick" advances the simulation clock by 1 unit of simulated time.
 *   - Processing order within a tick: advance machines → pull/push parts → update states.
 *   - Machines are processed in descending station order (downstream stations
 *     before upstream ones), computed by walking the buffer graph. This prevents
 *     a part from moving through multiple stations in a single tick (the "domino effect"
 *     that would make a short line appear to have infinite throughput).
 *
 * Concept mapping (terms used in commercial line simulators such as Plant Simulation):
 *   - tick loop           → SimEvent / Simulation.run()
 *   - Machine.state       → Object attribute / EventController
 *   - Buffer              → Store / Queue object
 *   - BLOCKED logic       → "BackPressure" / cannot-enter condition
 *   - STARVED logic       → "NoPart" / cannot-start condition
 */

import EventEmitter from 'events';
import { Part, Source, Buffer, Machine, Sink, ScrapSink, MachineState } from './entities.js';
import { DEFAULT_CONFIG } from './config.js';
import { StreamSet } from './rng.js';
import { OrderBook } from './orders.js';
import { Supply } from './supply.js';
import { Outsourcing, OUTSOURCING_DEFAULTS } from './outsourcing.js';
import { failuresEnabled, drawFailure } from './failures.js';

// Overtime policy defaults (config.overtime). The rate card has no overtime price: the
// cost is an ASSUMPTION, see src/economics/costs.js (line hour rate + 50% premium).
export const OVERTIME_DEFAULTS = { enabled: false, maxMinutesPerShift: 120 };

// Maximum machines allowed per station (original + 3 parallel).
const MAX_MACHINES_PER_STATION = 4;
const SPAWN_SUFFIXES = ['b', 'c', 'd'];   // M3 → M3b → M3c → M3d

// Utilization (and therefore the bottleneck verdict) is measured over the most
// recent UTIL_WINDOW_TICKS ticks, not the whole run. This lets the verdict track
// *current* conditions: after a cycle-time change or a spawned machine resolves a
// constraint, the old high-utilization history ages out within this many ticks
// and the station stops being flagged — instead of a lifetime average dragging
// the banner/marker on long after the constraint is gone.
const UTIL_WINDOW_TICKS = 300;

export class SimulationEngine extends EventEmitter {
  constructor(config = DEFAULT_CONFIG) {
    super();
    this._config = JSON.parse(JSON.stringify(config)); // deep clone so mutations don't bleed
    this._reset();

    this._running     = false;
    this._intervalRef = null;
    this._speed       = 1;          // wall-clock speed multiplier (1×, 2×, 5×, 10×)
    this._nextPartId  = 1;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  play() {
    if (this._running) return;
    this._running = true;
    this._scheduleNext();
  }

  pause() {
    this._running = false;
    if (this._intervalRef) {
      clearTimeout(this._intervalRef);
      this._intervalRef = null;
    }
  }

  setSpeed(multiplier) {
    // Valid multipliers: 1, 2, 5, 10
    this._speed = multiplier;
    if (this._running) {
      // Restart the tick loop at the new rate
      clearTimeout(this._intervalRef);
      this._scheduleNext();
    }
  }

  // Resets state but keeps user-adjusted config values (cycle times, capacities, etc.)
  // Does not auto-start; call play() explicitly.
  reset() {
    this.pause();
    this._nextPartId = 1;
    this._reset();
  }

  // Resets state AND restores all config values to DEFAULT_CONFIG.
  // Does not auto-start; call play() explicitly.
  resetToDefaults() {
    this.pause();
    this._nextPartId = 1;
    this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this._reset();
  }

  // Loads an arbitrary full config (e.g. a curated preset) — same effect as
  // resetToDefaults() but with a caller-supplied config instead of DEFAULT_CONFIG.
  // Deep-clones so the caller's object can't mutate engine state. Stays paused
  // at tick 0; call play() explicitly.
  loadConfig(config) {
    this.pause();
    this._nextPartId = 1;
    this._config = JSON.parse(JSON.stringify(config));
    this._reset();
  }

  // Live config update — students can change parameters while the sim runs.
  // Also mirrors changes into _config so that reset() preserves them.
  updateConfig(params) {
    // Changes that can shift which station is the constraint reset the
    // utilization window (see _lastFlowChangeTick); plain speed changes do not.
    const flowChange = ['sourceInterval', 'cycleTime', 'rejectRate', 'bufferCapacity']
      .some(k => params[k] !== undefined);

    if (params.speed !== undefined) this.setSpeed(params.speed);

    if (params.sourceInterval !== undefined) {
      this.source.interval = params.sourceInterval;
      this._config.source.interval = params.sourceInterval;
    }
    if (params.materialStock !== undefined) {
      this.source.materialStock = params.materialStock;
      this._config.source.materialStock = params.materialStock;
    }

    if (params.machineId !== undefined) {
      const m = this.machines.find(m => m.id === params.machineId);
      if (m) {
        if (params.cycleTime !== undefined) {
          m.cycleTime = params.cycleTime;
          const cfgM = this._config.machines.find(cm => cm.id === params.machineId);
          if (cfgM) cfgM.cycleTime = params.cycleTime;
        }
        if (params.rejectRate !== undefined) {
          m.rejectRate = params.rejectRate;
          const cfgM = this._config.machines.find(cm => cm.id === params.machineId);
          if (cfgM) cfgM.rejectRate = params.rejectRate;
        }
      }
    }

    if (params.bufferId !== undefined) {
      const b = this.buffers.find(b => b.id === params.bufferId);
      if (b && params.bufferCapacity !== undefined) {
        b.capacity = params.bufferCapacity;
        const cfgB = this._config.buffers.find(cb => cb.id === params.bufferId);
        if (cfgB) cfgB.capacity = params.bufferCapacity;
        // If parts now exceed new capacity, leave them in (don't eject — too disruptive)
      }
    }

    if (flowChange) this._lastFlowChangeTick = this.tick;
  }

  // Scenario options of the realism layer (all OFF unless given). Merged into the
  // config so reset() keeps them; resets the run (tick 0), stays paused.
  //   seed, outage {startTick,endTick}|null, failures {...}|null, supply {...}|null,
  //   demand number[]|null, initialFinishedGoods
  configureScenario(opts = {}) {
    this.pause();
    const cfg = this._config;
    if (opts.seed !== undefined) cfg.seed = opts.seed;
    if (opts.outage !== undefined) {
      if (opts.outage) cfg.source.outage = { startTick: opts.outage.startTick, endTick: opts.outage.endTick };
      else delete cfg.source.outage;
    }
    if (opts.failures !== undefined) {
      if (opts.failures) cfg.failures = JSON.parse(JSON.stringify(opts.failures));
      else delete cfg.failures;
    }
    if (opts.supply !== undefined) {
      if (opts.supply) cfg.supply = JSON.parse(JSON.stringify(opts.supply));
      else delete cfg.supply;
    }
    if (opts.demand !== undefined) {
      if (opts.demand) cfg.demand = [...opts.demand];
      else delete cfg.demand;
    }
    if (opts.initialFinishedGoods !== undefined) cfg.initialFinishedGoods = opts.initialFinishedGoods;
    if (opts.rawSafetyStock !== undefined) {
      if (opts.rawSafetyStock) cfg.rawSafetyStock = opts.rawSafetyStock;
      else delete cfg.rawSafetyStock;
    }
    if (opts.overtime !== undefined) {
      if (opts.overtime) cfg.overtime = { ...OVERTIME_DEFAULTS, ...opts.overtime, enabled: true };
      else delete cfg.overtime;
    }
    if (opts.outsourcing !== undefined) {
      if (opts.outsourcing) cfg.outsourcing = { ...OUTSOURCING_DEFAULTS, ...opts.outsourcing, enabled: true };
      else delete cfg.outsourcing;
    }
    if (opts.runShifts !== undefined) {
      if (opts.runShifts) cfg.runShifts = opts.runShifts;
      else delete cfg.runShifts;
    }
    // Realism scenarios span many shifts: the starter's 200-part material limit would
    // stop the line after about 5 shifts, before e.g. the reference outage at tick 4800.
    const realism = cfg.source.outage || cfg.failures || cfg.demand || cfg.supply?.mode === 'inventory';
    if (realism) cfg.source.materialStock = -1;
    this._nextPartId = 1;
    this._reset();
  }

  // Plant clock: engine ticks minus overtime ticks. Due ticks, shifts and the outage
  // window follow this clock; it equals `tick` whenever no overtime is worked.
  get plantTick() {
    return this.tick - (this._otTicks ?? 0);
  }

  // The (cloned) config this engine runs with.
  getConfig() {
    return this._config;
  }

  // Add a parallel machine to a station. The new machine shares the station's
  // input/output buffers and copies its cycleTime / rejectRate. Returns
  // { ok, id?, reason? }. New machines are appended to _config so reset() keeps
  // them; resetToDefaults() drops them.
  spawnMachine({ stationId } = {}) {
    const stationMachines = this.machines.filter(m => m.stationId === stationId);
    if (stationMachines.length === 0) return { ok: false, reason: 'unknown-station' };
    if (stationMachines.length >= MAX_MACHINES_PER_STATION) {
      return { ok: false, reason: 'cap-reached' };
    }

    const template = stationMachines[0];
    const usedSuffixes = new Set(
      stationMachines
        .map(m => m.id.slice(template.id.length))
        .filter(Boolean)
    );
    const suffix = SPAWN_SUFFIXES.find(s => !usedSuffixes.has(s));
    if (!suffix) return { ok: false, reason: 'cap-reached' };
    const newId = template.id + suffix;

    const cfgEntry = {
      id: newId,
      stationId,
      name: template.name,
      cycleTime: template.cycleTime,
      rejectRate: template.rejectRate,
      inputBufferId: template.inputBufferId,
      outputBufferId: template.outputBufferId,
    };

    this._config.machines.push(cfgEntry);
    this.machines.push(new Machine(cfgEntry));
    this._reindex();
    this._lastFlowChangeTick = this.tick;

    return { ok: true, id: newId };
  }

  // Remove a spawned parallel machine. The station's original machine (first in
  // config order) cannot be removed. If the machine holds a part, the part is
  // returned to the head of its input buffer; if that buffer is full the part is
  // dropped. Returns { ok, reason? }.
  removeMachine({ machineId } = {}) {
    const machine = this.machines.find(m => m.id === machineId);
    if (!machine) return { ok: false, reason: 'unknown-machine' };

    const stationMachines = this.machines.filter(m => m.stationId === machine.stationId);
    if (stationMachines[0].id === machineId) {
      return { ok: false, reason: 'original-machine' };
    }

    if (machine.currentPart) {
      const buf = this._bufferById.get(machine.inputBufferId);
      if (buf && buf.parts.length < buf.capacity) {
        machine.currentPart._bufferEnterTick = this.tick;
        buf.parts.unshift(machine.currentPart);
      }
      machine.currentPart = null;
    }

    this.machines = this.machines.filter(m => m.id !== machineId);
    this._config.machines = this._config.machines.filter(m => m.id !== machineId);
    this._reindex();
    this._lastFlowChangeTick = this.tick;

    return { ok: true };
  }

  // Returns the per-tick history recorded since the last reset.
  // Each entry is a flat object — one row per simulated tick — suitable for
  // direct CSV/JSON export.
  getHistory() {
    return this._history;
  }

  // Returns a plain JSON-serialisable snapshot of the current state
  getState() {
    // Cumulative counters from the start of the utilization window, used to derive
    // the recent-window tick counts below by subtraction. _history records one row
    // of cumulative counters per tick (newest last), so the row `ticksBack` back is
    // the window's baseline. The window spans UTIL_WINDOW_TICKS ticks but never
    // reaches back past the last flow-affecting change, so a config edit makes the
    // verdict reflect post-change behaviour almost immediately. When the baseline
    // row is absent (young run, or a machine spawned more recently) it is treated
    // as 0, so the window covers the machine's whole life so far.
    const ticksBack  = Math.min(UTIL_WINDOW_TICKS, this.tick - this._lastFlowChangeTick);
    const windowBase = this._history[this._history.length - 1 - ticksBack];
    return {
      tick:     this.tick,
      plantTick: this.plantTick,
      overtimeActive: !!this._otActive,
      ticksPerSecond: this._config.ticksPerSecond,
      running:  this._running,
      speed:    this._speed,
      source: {
        id:            this.source.id,
        interval:      this.source.interval,
        materialStock: this.source.materialStock,
        rawOnHand:     this.rawOnHand,
        rawSafetyLevel: this.rawSafetyLevel,
        totalGenerated: this.source.totalGenerated,
        lastEmitted:   this.source.lastEmitted,
        ticksSinceLast: this.source.ticksSinceLast,
      },
      machines: this.machines.map(m => ({
        id:              m.id,
        stationId:       m.stationId,
        inputBufferId:   m.inputBufferId,
        outputBufferId:  m.outputBufferId,
        name:            m.name,
        cycleTime:       m.cycleTime,
        rejectRate:      m.rejectRate,
        state:           m.state,
        ticksLeft:       m.ticksLeft,
        ticksProcessing: m.ticksProcessing,
        ticksBlocked:    m.ticksBlocked,
        ticksStarved:    m.ticksStarved,
        ticksIdle:       m.ticksIdle,
        ticksDown:       m.ticksDown,
        repairLeft:      m.repairLeft,
        // Recent-window counts (last UTIL_WINDOW_TICKS ticks) = current cumulative
        // minus the cumulative at the window baseline. Used by the collector for
        // utilization and bottleneck detection so the verdict tracks current flow.
        winProcessing: m.ticksProcessing - (windowBase?.[`${m.id}_ticksProcessing`] ?? 0),
        winBlocked:    m.ticksBlocked    - (windowBase?.[`${m.id}_ticksBlocked`]    ?? 0),
        winStarved:    m.ticksStarved    - (windowBase?.[`${m.id}_ticksStarved`]    ?? 0),
        winIdle:       m.ticksIdle       - (windowBase?.[`${m.id}_ticksIdle`]       ?? 0),
        winDown:       m.ticksDown       - (windowBase?.[`${m.id}_ticksDown`]       ?? 0),
        partsProcessed:  m.partsProcessed,
        currentPartId:   m.currentPart?.id ?? null,
      })),
      buffers: this.buffers.map(b => ({
        id:           b.id,
        capacity:     b.capacity,
        load:         b.parts.length,
        partIds:      b.parts.map(p => p.id),
        totalWaitTicks: b.totalWaitTicks,
        totalPartsOut:  b.totalPartsOut,
      })),
      sink: {
        partsReceived: this.sink.partsReceived,
        // Last 20 completed parts for lead-time calculation
        recentParts: this.sink.completedParts.slice(-20).map(p => ({
          id: p.id, createdAt: p.createdAt, completedAt: p.completedAt,
        })),
      },
      scrap: {
        partsReceived: this.scrapSink.partsReceived,
      },
      seed:      this._config.seed ?? 1,
      outage:    this._config.source.outage ?? null,
      failures:  failuresEnabled(this._config.failures),
      supply:    this.supply ? this.supply.snapshot() : { mode: 'jit', backupParts: this.backupParts },
      outsourcing: this.outsourcing ? { ordered: this.outsourcing.ordered, received: this.outsourcing.received, onOrder: this.outsourcing.onOrder } : null,
      orders:    this.orders ? this.orders.summary() : null,
      events:    this.events.slice(-20),
    };
  }

  // ── Private: initialise/reset all simulation objects ─────────────────────

  _reset() {
    this.tick = 0;
    this._history = [];
    // Tick of the most recent flow-affecting change (cycle time, machine
    // spawn/remove, source/buffer edit). The utilization window never looks back
    // past this point, so after the user changes something the bottleneck verdict
    // reflects only post-change behaviour and a resolved constraint clears within
    // a few ticks instead of waiting out the full UTIL_WINDOW_TICKS history.
    this._lastFlowChangeTick = 0;

    const cfg = this._config;

    this.streams   = new StreamSet(cfg.seed);        // seeded random streams, one per process
    this.events    = [];                             // engine events (breakdowns)
    this.orders    = Array.isArray(cfg.demand)
      ? new OrderBook({ demand: cfg.demand, initialFinishedGoods: cfg.initialFinishedGoods ?? 0 })
      : null;
    this.supply    = cfg.supply?.mode === 'inventory'
      ? new Supply(cfg.supply, cfg.source.outage ?? null)
      : null;
    this.outsourcing = cfg.outsourcing?.enabled && this.orders ? new Outsourcing(cfg.outsourcing) : null;
    this.backupParts = 0;          // parts released by the backup supplier during an outage (jit mode)
    // Raw-material safety stock at the source (config.rawSafetyStock, jit mode, ERP starting stock): normal
    // deliveries keep it at its level; while the supplier is out the source releases from it until it is empty.
    this.rawSafetyLevel = Math.max(0, Math.floor(cfg.rawSafetyStock ?? 0));
    this.rawOnHand      = this.rawSafetyLevel;
    this.rawFromStock   = 0;       // parts released from the safety stock during the outage
    this._shiftWipSum  = 0;
    this._otTicks      = 0;        // overtime ticks so far (engine ticks that did not advance the plant clock)
    this._otActive     = false;    // true while the line works overtime at a shift end
    this._otShiftMin   = 0;        // overtime minutes worked for the current shift
    this._shiftScrap0  = 0;
    this._shiftReleased0 = 0;

    this.source    = new Source(cfg.source);
    this.buffers   = cfg.buffers.map(b => new Buffer(b));
    this.machines  = cfg.machines.map(m => new Machine(m));
    this.sink      = new Sink();
    this.scrapSink = new ScrapSink();

    this._reindex();

    // Store initial config values so reset always goes back to defaults
    this._initialConfig = JSON.parse(JSON.stringify(cfg));
  }

  // Rebuild the buffer lookup and station ordering. Call whenever the set of
  // machines or buffers changes (reset, spawn, remove).
  _reindex() {
    this._bufferById = new Map(this.buffers.map(b => [b.id, b]));
    this._assignStationOrder();
  }

  // Walk the buffer graph from the source-fed buffer (the one no machine
  // produces) and assign each station an increasing `order`. Machines sharing a
  // stationId share an order. Used to process downstream→upstream each tick.
  _assignStationOrder() {
    const produced = new Set(
      this.machines.map(m => m.outputBufferId).filter(id => id != null)
    );
    let curId = this.buffers.find(b => !produced.has(b.id))?.id
              ?? this.buffers[0]?.id;

    const stationOrder = new Map();   // stationId -> order
    let order = 0;
    const seen = new Set();
    while (curId != null && !seen.has(curId)) {
      seen.add(curId);
      const here = this.machines.filter(m => m.inputBufferId === curId);
      if (here.length === 0) break;
      const stationId = here[0].stationId;
      if (!stationOrder.has(stationId)) stationOrder.set(stationId, order++);
      curId = here[0].outputBufferId;   // parallel machines share output
    }
    for (const m of this.machines) {
      m._order = stationOrder.get(m.stationId) ?? 0;
    }
    // Machines processed end→start: highest order first.
    this._processOrder = [...this.machines].sort((a, b) => b._order - a._order);
  }

  // ── Private: tick scheduling ───────────────────────────────────────────────

  _scheduleNext() {
    if (!this._running) return;
    const msPerTick = 1000 / (this._config.ticksPerSecond * this._speed);
    this._intervalRef = setTimeout(() => {
      this._tick();
      this._scheduleNext();
    }, msPerTick);
  }

  // ── Private: one simulation tick ──────────────────────────────────────────

  _tick() {
    this.tick++;
    // Outsourced sets arrive at the start of the shift (the first tick after the close)
    if (this.outsourcing?.pending.length) {
      const n = this.outsourcing.arrive(Math.ceil(this.plantTick / this.orders.ticksPerShift));
      if (n > 0) this.orders.addStock(n);
    }
    // Overtime: the line works, but the plant clock (due ticks, outage window) stands still.
    if (this._otActive) { this._otTicks++; this._otShiftMin++; }

    // Reset "just emitted" flag from previous tick
    this.source.lastEmitted = false;

    // ── STEP 1: Advance machines (count down processing timers) ─────────────
    // Process downstream→upstream (highest station order first) to prevent a
    // part cascading through multiple machines in one tick.
    for (const machine of this._processOrder) {
      this._advanceMachine(machine);
    }

    // ── STEP 2: Source emits parts ───────────────────────────────────────────
    this._tickSource();

    // ── STEP 3: Pull parts from each machine's input buffer ──────────────────
    for (const machine of this._processOrder) {
      if (machine.state === MachineState.IDLE || machine.state === MachineState.STARVED) {
        const upstreamBuffer = this._bufferById.get(machine.inputBufferId);
        if (upstreamBuffer && upstreamBuffer.parts.length > 0) {
          const part = upstreamBuffer.parts.shift();
          upstreamBuffer.totalPartsOut++;

          const waitTicks = this.tick - part._bufferEnterTick;
          upstreamBuffer.totalWaitTicks += (waitTicks > 0 ? waitTicks : 0);

          part.enteredMachineAt = this.tick;
          machine.currentPart   = part;
          machine.ticksLeft     = machine.cycleTime;
          machine.state         = MachineState.PROCESSING;
        } else {
          machine.state = MachineState.STARVED;
        }
      }
    }

    // ── STEP 4: Accumulate state-time counters ───────────────────────────────
    for (const m of this.machines) {
      switch (m.state) {
        case MachineState.PROCESSING: m.ticksProcessing++; break;
        case MachineState.BLOCKED:    m.ticksBlocked++;    break;
        case MachineState.STARVED:    m.ticksStarved++;    break;
        case MachineState.IDLE:       m.ticksIdle++;       break;
        case MachineState.DOWN:       m.ticksDown++;       break;
      }
    }

    this._recordHistory();
    this._closeShiftIfDue();

    this.emit('tick', this.getState());

    // ── STEP 5: Auto-pause when all materials are done ───────────────────────
    // Conditions: source exhausted + no parts in any buffer + no machine holds a part
    if (!this.supply && this.source.materialStock === 0) {
      const noPipelineParts =
        this.buffers.every(b => b.parts.length === 0) &&
        this.machines.every(m => m.currentPart === null);

      if (noPipelineParts) {
        this.pause();
        this.emit('simulation-complete', this.getState());
      }
    }
  }

  // ── Private: shift bookkeeping (only when demand is configured) ──────────

  _wipNow() {
    let n = 0;
    for (const b of this.buffers) n += b.parts.length;
    for (const m of this.machines) if (m.currentPart) n++;
    return n;
  }

  // Units still missing at the end of the current plant shift:
  // this shift's orders + backlog - finished-goods stock.
  _openNeed(plantTick) {
    const o = this.orders;
    const shift = plantTick / o.ticksPerShift;
    return (o.demand[shift - 1] ?? 0) + o.backlog - o.stock;
  }

  _closeShiftIfDue() {
    if (!this.orders) return;
    this._shiftWipSum += this._wipNow();
    const pt = this.plantTick;
    if (pt <= 0 || pt % this.orders.ticksPerShift !== 0) return;

    // Overtime policy (config.overtime, OFF by default): when the shift ends with orders
    // that stock cannot cover, the line keeps working up to maxMinutesPerShift, and stops
    // as soon as the orders are covered. Shipping happens after the overtime.
    const ot = this._config.overtime ? { ...OVERTIME_DEFAULTS, ...this._config.overtime } : null;
    if (this._otActive) {
      if (this._otShiftMin < ot.maxMinutesPerShift && this._openNeed(pt) > 0) return;   // keep working
      this._otActive = false;
    } else if (ot?.enabled && this._otShiftMin === 0 && ot.maxMinutesPerShift > 0 && this._openNeed(pt) > 0) {
      this._otActive = true;                 // the next ticks are overtime ticks
      return;
    }

    const row = this.orders.closeTick(pt);
    if (!row) return;
    row.overtimeMin = this._otShiftMin;
    this._otShiftMin = 0;
    if (this.outsourcing) {
      Object.assign(row, this.outsourcing.closeShiftRow());
      row.outsourcedOrdered = this.outsourcing.order(row.shift, this.orders.backlog);
    }
    const tps = this.orders.ticksPerShift;
    row.scrap     = this.scrapSink.partsReceived - this._shiftScrap0;
    row.released  = this.source.totalGenerated - this._shiftReleased0;
    row.wip       = +(this._shiftWipSum / tps).toFixed(2);
    this._shiftScrap0 = this.scrapSink.partsReceived;
    this._shiftReleased0 = this.source.totalGenerated;
    this._shiftWipSum = 0;

    // Optional auto-stop after N closed shifts (config.runShifts, OFF by default)
    if (this._config.runShifts && this.orders.rows.length >= this._config.runShifts) {
      this.pause();
      this.emit('run-complete', this.getState());
    }
  }

  // ── Private: append a flat snapshot for this tick to the history buffer ───
  //
  // Rolling cap of 100k rows keeps long infinite-stock runs from leaking
  // unbounded memory; the oldest tick is dropped once the cap is hit.

  _recordHistory() {
    const row = {
      tick: this.tick,
      plantTick: this.plantTick,
      overtime: this._otActive ? 1 : 0,
      sourceTotalGenerated: this.source.totalGenerated,
      sourceMaterialStock:  this.source.materialStock,
    };

    for (const m of this.machines) {
      const id = m.id;
      row[`${id}_state`]            = m.state;
      row[`${id}_partsProcessed`]   = m.partsProcessed;
      row[`${id}_ticksProcessing`]  = m.ticksProcessing;
      row[`${id}_ticksBlocked`]     = m.ticksBlocked;
      row[`${id}_ticksStarved`]     = m.ticksStarved;
      row[`${id}_ticksIdle`]        = m.ticksIdle;
      row[`${id}_ticksDown`]        = m.ticksDown;
      row[`${id}_currentPartId`]    = m.currentPart?.id ?? '';
    }

    for (const b of this.buffers) {
      row[`${b.id}_load`]     = b.parts.length;
      row[`${b.id}_capacity`] = b.capacity;
    }

    row.sinkPartsReceived  = this.sink.partsReceived;
    row.scrapPartsReceived = this.scrapSink.partsReceived;
    if (this.supply) row.rawMaterialStock = this.supply.stock;
    if (this.orders) {
      row.finishedGoodsStock = this.orders.stock;
      row.orderBacklog       = this.orders.backlog;
    }

    this._history.push(row);
    if (this._history.length > 100_000) this._history.shift();
  }

  // ── Private: advance one machine for this tick ────────────────────────────

  _advanceMachine(machine) {
    if (machine.state === MachineState.BLOCKED) {
      this._tryPushDownstream(machine);
      return;
    }

    if (machine.state === MachineState.DOWN) {
      machine.repairLeft--;
      if (machine.repairLeft > 0) return;     // still being repaired
      this._completePart(machine);            // repaired: the held part is finished now
      return;
    }

    if (machine.state !== MachineState.PROCESSING) return;

    machine.ticksLeft--;
    if (machine.ticksLeft > 0) return; // still working

    // Breakdown draw, once per completed part (config.failures, off by default)
    if (failuresEnabled(this._config.failures)) {
      const f = drawFailure(this._config.failures, machine.id, this.streams);
      if (f) {
        machine.state      = MachineState.DOWN;
        machine.repairLeft = f.repair;
        this.events.push({ type: 'breakdown', machine: machine.id, mode: f.mode, start: this.tick, plantStart: this.plantTick, repair: f.repair });
        return;
      }
    }

    this._completePart(machine);
  }

  // The machine has finished its part (after any repair): quality gate, then push on.
  _completePart(machine) {
    machine.partsProcessed++;

    // Quality gate: reject parts based on rejectRate, from the machine's own seeded stream
    if (machine.rejectRate > 0 && this.streams.get(`reject:${machine.id}`)() < machine.rejectRate) {
      this.scrapSink.partsReceived++;
      machine.scrapped++;
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      return;
    }

    this._tryPushDownstream(machine);
  }

  _tryPushDownstream(machine) {
    const part = machine.currentPart;

    if (machine.outputBufferId == null) {
      // Pushes to the Sink
      part.completedAt = this.tick;
      this.sink.partsReceived++;
      this.orders?.receive(1);
      this.sink.completedParts.push(part);
      if (this.sink.completedParts.length > 200) this.sink.completedParts.shift();
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
      return;
    }

    const downstreamBuffer = this._bufferById.get(machine.outputBufferId);
    if (downstreamBuffer && downstreamBuffer.parts.length < downstreamBuffer.capacity) {
      part._bufferEnterTick = this.tick;
      downstreamBuffer.parts.push(part);
      machine.currentPart = null;
      machine.state       = MachineState.IDLE;
    } else {
      // Buffer full → BLOCKED (back-pressure propagates upstream)
      machine.state = MachineState.BLOCKED;
    }
  }

  // ── Private: source tick ──────────────────────────────────────────────────

  _tickSource() {
    // Inventory supply: deliveries and re-orders happen even while the source waits
    this.supply?.step(this.plantTick);

    // Supplier outage (config.source.outage): in jit mode the source is halted for
    // startTick < tick <= endTick -- its counter does not advance, no part is
    // released. In inventory mode the outage hits the supplier instead (supply.js).
    // Backup supplier (config.source.backupSupplier, jit mode): the source stays stopped for the
    // first leadTime ticks of the window, then releases normally; those parts cost the premium.
    const outage = this._config.source.outage;
    const pt = this.plantTick;
    let backup = false, fromStock = false;
    const inOutage = !this.supply && outage && pt > outage.startTick && pt <= outage.endTick;
    if (inOutage) {
      if (this.rawOnHand > 0) fromStock = true;      // the raw safety stock keeps the source running
      else {
        const bk = this._config.source.backupSupplier;
        if (!bk?.enabled || pt <= outage.startTick + bk.leadTime) return;
        backup = true;
      }
    } else if (this.rawOnHand < this.rawSafetyLevel) {
      this.rawOnHand = this.rawSafetyLevel;           // the supplier delivers again: stock back to its level
    }

    // Material starvation check: -1 means infinite stock; 0 means depleted.
    // In inventory mode the raw-stock model replaces this simple limit.
    if (!this.supply && this.source.materialStock === 0) return; // stock depleted, no more parts

    this.source.ticksSinceLast++;

    if (this.source.ticksSinceLast < this.source.interval) return;

    // Enough ticks elapsed — try to emit a part into BUF0
    const buf0 = this.buffers[0];
    if (buf0.parts.length >= buf0.capacity) return; // BUF0 full, can't emit

    // Inventory mode: a raw-material unit must be on hand
    if (this.supply && this.supply.consume() === null) return;

    // Emit a new part
    const part = new Part(this._nextPartId++, this.tick);
    part._bufferEnterTick = this.tick;
    buf0.parts.push(part);

    this.source.ticksSinceLast  = 0;
    this.source.totalGenerated++;
    this.source.lastEmitted     = true;
    if (backup) this.backupParts++;
    if (fromStock) { this.rawOnHand--; this.rawFromStock++; }

    // Decrement material stock; -1 means infinite (no decrement). Not used in inventory mode.
    if (!this.supply && this.source.materialStock > 0) {
      this.source.materialStock--;
    }
  }
}

/**
 * server.js
 * Fastify HTTP server — glues together the simulation engine, metrics, and
 * the static frontend. Entry point for the application.
 *
 * Each browser gets its own SimulationEngine, keyed by a `sid` cookie.
 * When a session's last SSE client disconnects, the engine is kept alive
 * for SESSION_TTL_MS to survive page reloads, then paused and discarded.
 *
 * Routes:
 *   GET  /              → serves index.html (the visual frontend)
 *   GET  /api/state     → current simulation state (JSON)
 *   GET  /api/metrics   → calculateMetrics() output (JSON, for frontend polling)
 *   GET  /api/events    → SSE stream, pushes state+metrics every 250 ms
 *   POST /api/control   → play/pause/reset/param updates
 *   GET  /api/presets   → scenario presets (id, label, description)
 *   GET  /api/export    → per-tick history as CSV (?format=csv) or JSON (the simulation log)
 *   GET  /api/kpis      → orders, service level and economics of the closed shifts
 *   GET  /api/results   → CEO interface: status of the scenario run + summary when done
 *   POST /api/advisor/explain, /api/advisor/improve → AI shift advisor (LLM called server-side only)
 *
 * POST /api/control also takes the realism-layer options (all off by default) in
 * `params`, with action 'configureScenario' (or together with any other action):
 *   seed, outage {startTick,endTick}|true|null, failures {...}|true|null,
 *   supply {...}|'jit'|'inventory'|null, demand 'profile'|'flat'|number[]|null,
 *   initialFinishedGoods. Applying them resets the run to tick 0 (paused).
 * Action 'loadPlantDefault' loads the plant as the data package describes it.
 */

import Fastify        from 'fastify';
import fastifyStatic  from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

import { SimulationEngine } from './simulation/engine.js';
import { DEFAULT_CONFIG }   from './simulation/config.js';
import { PRESETS, getPreset }   from './simulation/presets.js';
import { calculateMetrics } from './metrics/collector.js';
import * as controls from './controls.js';
import { liveResult, shiftRowsFromEngine } from './simulation/summary.js';
import { computeEconomics } from './economics/costs.js';
import { loadRateCard, loadDemand, loadCurrentSituation } from './data/loaders.js';
import { REFERENCE_OUTAGE } from './scenarios/scenarios.js';
import { buildUiScenario, normaliseShifts, UI_SCENARIO_IDS, RUN_SHIFTS } from './ui/scenarios.js';
import { reconfiguresEngine } from './ui/session-rules.js';
import { catalogueFor, resolveSelection } from './countermeasures/catalog.js';
import { evaluateSelection } from './countermeasures/evaluate.js';
import { range } from './scenarios/scenarios.js';
import { buildRunSummary } from './ui/run-summary.js';
import { createAdvisor } from './advisor/advisor.js';
import { validateAnswers } from './advisor/constraints.js';
import { CompareRunner } from './ui/compare-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT ?? '3000', 10);

// Grace period before a session with no clients is torn down.
const SESSION_TTL_MS = 30_000;

// ── Realism layer helpers ──────────────────────────────────────────────────

const RATE_CARD = loadRateCard();
const DEMAND_PROFILE = loadDemand();
const FLAT_DEMAND = 34;
const UI_SPEEDS = [1, 2, 10];       // speed selector of the CEO interface
const SCENARIO_KEYS = ['seed', 'outage', 'failures', 'supply', 'demand', 'initialFinishedGoods'];

// Translate the friendly API values into engine.configureScenario() options.
function parseScenarioParams(params) {
  const o = {};
  if (params.seed !== undefined) o.seed = Number.isFinite(Number(params.seed)) ? Number(params.seed) : 1;
  if (params.outage !== undefined) {
    o.outage = params.outage === true ? { ...REFERENCE_OUTAGE }
      : params.outage && Number.isFinite(params.outage.startTick) && Number.isFinite(params.outage.endTick)
        && params.outage.endTick > params.outage.startTick ? params.outage : null;
  }
  if (params.failures !== undefined) {
    o.failures = params.failures === true ? { enabled: true }
      : params.failures && typeof params.failures === 'object' ? { enabled: true, ...params.failures } : null;
  }
  if (params.supply !== undefined) {
    o.supply = params.supply === 'inventory' ? { mode: 'inventory' }
      : params.supply && typeof params.supply === 'object' && params.supply.mode === 'inventory' ? params.supply : null;
  }
  if (params.demand !== undefined) {
    const d = params.demand;
    o.demand = d === 'profile' ? [...DEMAND_PROFILE]
      : d === 'flat' ? Array(60).fill(FLAT_DEMAND)
      : typeof d === 'number' && d >= 0 ? Array(60).fill(d)
      : Array.isArray(d) && d.every(x => Number.isFinite(x) && x >= 0) ? d : null;
  }
  if (params.initialFinishedGoods !== undefined) {
    o.initialFinishedGoods = Math.max(0, Math.floor(Number(params.initialFinishedGoods) || 0));
  }
  return o;
}

function kpisFor(engine) {
  const state = engine.getState();
  const out = {
    tick: state.tick, shifts: Math.floor(state.tick / 480), seed: state.seed, outage: state.outage,
    failures: state.failures, supply: state.supply, orders: state.orders, economics: null,
    breakdowns: engine.events.filter(e => e.type === 'breakdown').length,
    downTicks: engine.machines.reduce((a, m) => a + m.ticksDown, 0),
    // closed shifts, oldest first (only when demand is loaded: the order book closes the shifts)
    perShift: shiftRowsFromEngine(engine),
  };
  const result = liveResult(engine);
  if (result) {
    const cfg = engine.getConfig();
    const e = computeEconomics(result, cfg, DEFAULT_CONFIG, RATE_CARD);
    const { perShift: _drop, ...rest } = e;
    out.economics = rest;
  }
  return out;
}

// ── Per-session engine registry ───────────────────────────────────────────

// sid -> { engine, sseClients: Set<res>, cleanupTimer: Timeout|null }
const sessions = new Map();

function getSession(sid) {
  let s = sessions.get(sid);
  if (!s) {
    // Start paused: the frontend shows a "Start simulation" prompt and the user
    // kicks off the run with Play (or the start banner). Avoids the line racing
    // ahead before the page has even rendered.
    const engine = new SimulationEngine(DEFAULT_CONFIG);
    s = { engine, sseClients: new Set(), cleanupTimer: null, scenario: null, runShifts: RUN_SHIFTS, advice: null, compare: null };
    sessions.set(sid, s);
  }
  if (s.cleanupTimer) {
    clearTimeout(s.cleanupTimer);
    s.cleanupTimer = null;
  }
  return s;
}

function scheduleCleanup(sid) {
  const s = sessions.get(sid);
  if (!s || s.sseClients.size > 0 || s.cleanupTimer) return;
  s.cleanupTimer = setTimeout(() => {
    s.engine.pause();
    s.compare?.stop();
    sessions.delete(sid);
  }, SESSION_TTL_MS);
}

// ── Session cookie ────────────────────────────────────────────────────────

function readSidCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const m = raw.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? m[1] : null;
}

// ── Create Fastify instance ────────────────────────────────────────────────

const app = Fastify({ logger: false });

// Stamp every response with an `sid` cookie if absent — including the initial
// HTML page load. Without this, the browser would hit /api/events before any
// cookie exists, and subsequent /api/control fetches would land on a different
// session than the one tied to the SSE stream.
app.addHook('onRequest', (req, reply, done) => {
  let sid = readSidCookie(req);
  if (!sid) {
    sid = randomUUID();
    reply.header('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  }
  req.sid = sid;
  done();
});

app.register(fastifyStatic, {
  root:   join(__dirname, 'public'),
  prefix: '/',
});

// ── SSE broadcast loop ─────────────────────────────────────────────────────

setInterval(() => {
  for (const s of sessions.values()) {
    if (s.sseClients.size === 0) continue;
    const state   = s.engine.getState();
    const metrics = calculateMetrics(state);
    const payload = { state, metrics };
    if (s.compare) payload.compare = comparePayload(s.compare);
    const line    = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of s.sseClients) {
      try { res.raw.write(line); } catch (_) { s.sseClients.delete(res); }
    }
  }
}, 250);

// Live data of the side-by-side comparison (A = as is, B = with the countermeasure)
function comparePayload(c) {
  const view = (e) => {
    const state = e.getState();
    const overtimeMin = e.orders.rows.reduce((a, r) => a + (r.overtimeMin ?? 0), 0) + (e._otShiftMin ?? 0);
    return { state, metrics: calculateMetrics(state), overtimeMin };
  };
  return {
    status: c.done ? 'done' : c.running ? 'running' : 'stopped',
    shiftsDone: { a: c.a.orders.rows.length, b: c.b.orders.rows.length },
    waitingA: c.waitingA,
    a: view(c.a), b: view(c.b),
    countermeasure: c.countermeasure,
  };
}

function dropCompare(session) {
  session.compare?.stop();
  session.compare = null;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// SSE stream
app.get('/api/events', (req, reply) => {
  const session = getSession(req.sid);

  // Forward any Set-Cookie the onRequest hook queued, since reply.raw.writeHead
  // bypasses Fastify's normal header flush.
  const setCookie = reply.getHeader('set-cookie');
  const headers = {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (setCookie) headers['Set-Cookie'] = setCookie;

  reply.raw.writeHead(200, headers);
  reply.raw.write(':\n\n');
  session.sseClients.add(reply);

  req.raw.on('close', () => {
    session.sseClients.delete(reply);
    scheduleCleanup(req.sid);
  });
});

// Current state (JSON)
app.get('/api/state', async (req) => getSession(req.sid).engine.getState());

// Computed metrics (JSON)
app.get('/api/metrics', async (req) => calculateMetrics(getSession(req.sid).engine.getState()));

// Curated scenario presets — metadata only (id/label/description), never the
// full configs. The frontend renders one load button per entry.
app.get('/api/presets', async () =>
  PRESETS.map(({ id, label, description }) => ({ id, label, description })));

// Control endpoint
app.post('/api/control', async (req, reply) => {
  const session = getSession(req.sid);
  const { engine } = session;
  const { action } = req.body ?? {};
  let params = req.body?.params ?? {};

  // The advanced controls share the engine: reconfiguring it makes the CEO run stale
  if (reconfiguresEngine(action, params)) {
    session.scenario = null;
    session.advice = null;
    dropCompare(session);
  }

  switch (action) {
    case 'play':            controls.play(engine);    break;
    case 'pause':           controls.pause(engine);   break;
    case 'reset':           controls.reset(engine);   break;
    case 'resetToDefaults': engine.resetToDefaults(); break;
    case 'spawnMachine':    engine.spawnMachine(params);  break;
    case 'removeMachine':   engine.removeMachine(params); break;
    case 'configureScenario': break;      // handled below with the other params
    case 'runScenario': {
      // CEO interface: one of the 4 scenarios, 20 shifts, animated at 10x, stops by itself
      const id = params.scenario;
      if (!UI_SCENARIO_IDS.includes(id)) {
        reply.code(400);
        return { ok: false, error: `unknown scenario (allowed: ${UI_SCENARIO_IDS.join(', ')})` };
      }
      let shifts;
      try { shifts = normaliseShifts(params.shifts === undefined ? undefined : Number(params.shifts)); }
      catch (err) { reply.code(400); return { ok: false, error: err.message }; }
      const sc = buildUiScenario(id, shifts);
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      cfg.source.materialStock = -1;
      engine.loadConfig(cfg);
      engine.configureScenario({ ...sc.configureOptions, runShifts: shifts });
      session.scenario = id;
      session.runShifts = shifts;
      session.advice = null;
      dropCompare(session);
      if (params.instant) {
        // run all shifts at once (about a second); the diagram jumps to the final state
        while ((engine.orders?.rows.length ?? 0) < shifts) engine._tick();
        return { ok: true, tick: engine.tick };
      }
      const speed = Number(params.speed);
      controls.setSpeed(engine, UI_SPEEDS.includes(speed) ? speed : 10);
      controls.play(engine);
      return { ok: true, tick: engine.tick };
    }
    case 'loadPlantDefault': {
      // The plant as the data package describes it: unlimited material, the demand profile, seed 1
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      cfg.source.materialStock = -1;
      engine.loadConfig(cfg);
      engine.configureScenario({ seed: 1, demand: [...DEMAND_PROFILE], initialFinishedGoods: 0 });
      return { ok: true, tick: engine.tick };
    }
    case 'loadPreset': {
      const cfg = getPreset(params.presetId);
      if (!cfg) return { ok: false, reason: 'unknown preset' };
      engine.loadConfig(cfg);
      return { ok: true, tick: engine.tick };
    }
    default:
      // No recognised action — may still have params to update
  }

  // Realism-layer options: merged into the config, the run restarts at tick 0
  if (SCENARIO_KEYS.some(k => params[k] !== undefined)) {
    engine.configureScenario(parseScenarioParams(params));
    params = Object.fromEntries(Object.entries(params).filter(([k]) => !SCENARIO_KEYS.includes(k)));
  }

  // Validate speed through controls.setSpeed before delegating to updateConfig,
  // so that invalid inputs (e.g. zero/negative multipliers) are rejected.
  if (params.speed !== undefined) {
    try {
      controls.setSpeed(engine, params.speed);
    } catch (err) {
      reply.code(400);
      return { ok: false, error: err.message };
    }
    const { speed: _omit, ...rest } = params;
    if (Object.keys(rest).length > 0) engine.updateConfig(rest);
  } else if (Object.keys(params).length > 0) {
    engine.updateConfig(params);
  }

  return { ok: true, tick: engine.tick };
});

// Orders, service level and economics of the shifts closed so far
app.get('/api/kpis', async (req) => kpisFor(getSession(req.sid).engine));

// CEO interface: where the scenario run is, and its summary once all shifts are closed
function resultsFor(session) {
  const { engine } = session;
  if (!session.scenario) return { status: 'idle', scenario: null, shiftsDone: 0, shiftsTotal: session.runShifts, summary: null };
  const shiftsDone = engine.orders?.rows.length ?? 0;
  const done = shiftsDone >= session.runShifts;
  return {
    status: done ? 'done' : 'running', scenario: session.scenario, shiftsDone, shiftsTotal: session.runShifts,
    summary: done ? buildRunSummary(engine, buildUiScenario(session.scenario, session.runShifts), RATE_CARD) : null,
  };
}

app.get('/api/results', async (req) => resultsFor(getSession(req.sid)));

// AI shift advisor. The LLM only words simulation numbers; errors carry no details.
const advisor = createAdvisor();

async function advise(req, reply, run) {
  const session = getSession(req.sid);
  const r = resultsFor(session);
  if (r.status !== 'done') {
    reply.code(409);
    return { error: 'Run a scenario to the end first' };
  }
  try {
    return await run(r.summary, buildUiScenario(session.scenario, session.runShifts));
  } catch (err) {
    reply.code(502);
    return { error: err.message };
  }
}

app.post('/api/advisor/explain', (req, reply) => advise(req, reply, (summary) => advisor.explain(summary)));
app.post('/api/advisor/improve', async (req, reply) => {
  let answers;
  try { answers = validateAnswers(req.body?.answers ?? null); }
  catch (err) { reply.code(400); return { error: err.message }; }
  const session = getSession(req.sid);
  if (session.compare?.running) {
    reply.code(409);
    return { error: 'Stop the comparison first' };
  }
  return advise(req, reply, async (summary, sc) => {
    const r = await advisor.improve(summary, sc, answers, { shifts: session.runShifts });
    if (r.status === 'proposed') {
      dropCompare(session);                    // a new proposal replaces the old comparison
      session.advice = {
        scenarioId: sc.id, selection: [{ id: r.countermeasure.id, params: r.countermeasure.params }],
        label: r.countermeasure.label, source: 'advisor', shifts: session.runShifts,
      };
    }
    return r;
  });
});

// The countermeasures the CEO can pick from for the current run (one source: the catalogue)
app.get('/api/countermeasures', async (req) => {
  const session = getSession(req.sid);
  if (!session.scenario) return [];
  const d = buildUiScenario(session.scenario, session.runShifts).disruptionId;
  return d ? catalogueFor(d) : [];
});

// Manual selection (one or several countermeasures): the simulation checks it, no LLM involved
app.post('/api/countermeasures/test', async (req, reply) => {
  const session = getSession(req.sid);
  const r = resultsFor(session);
  if (r.status !== 'done') { reply.code(409); return { error: 'Run a scenario to the end first' }; }
  if (session.compare?.running) { reply.code(409); return { error: 'Stop the comparison first' }; }
  const sc = buildUiScenario(session.scenario, session.runShifts);
  if (!sc.disruptionId) { reply.code(409); return { error: 'No countermeasures are available for this scenario' }; }
  const selection = req.body?.selection;
  let resolved;
  try { resolved = resolveSelection(selection, sc.disruptionId); }
  catch (err) { reply.code(400); return { error: err.message }; }
  try {
    const check = await evaluateSelection(sc.disruptionId, selection, { seeds: range(1, 10), shifts: session.runShifts });
    dropCompare(session);
    session.advice = {
      scenarioId: sc.id, selection: resolved.items.map(i => ({ id: i.cm.id, params: i.params })),
      label: resolved.label, source: 'manual', shifts: session.runShifts,
    };
    return {
      status: 'proposed', source: 'manual', countermeasure: check.countermeasure, constraintsApplied: [], answers: null,
      check: { runs: check.runs, without: check.without, with: check.with, change: check.change, verdict: check.verdict },
    };
  } catch (err) {
    reply.code(502);
    return { error: err.message };
  }
});

// Demo values for the Current Situation bar (visual only; the simulation does not read them)
app.get('/api/current-situation', async () => loadCurrentSituation());

// Side-by-side comparison: as is vs. with the proposed countermeasure
app.post('/api/compare/start', async (req, reply) => {
  const session = getSession(req.sid);
  if (!session.advice || session.advice.scenarioId !== session.scenario) {
    reply.code(409);
    return { error: 'Ask for an improvement first' };
  }
  const speed = Number(req.body?.speed);
  if (!session.compare) session.compare = new CompareRunner(session.advice);
  session.compare.start({ speed: UI_SPEEDS.includes(speed) ? speed : 1, instant: !!req.body?.instant });
  return { ok: true };
});

app.post('/api/compare/speed', async (req, reply) => {
  const speed = Number(req.body?.speed);
  if (!UI_SPEEDS.includes(speed)) { reply.code(400); return { error: 'speed must be 1, 2 or 10' }; }
  getSession(req.sid).compare?.setSpeed(speed);
  return { ok: true };
});

app.post('/api/compare/stop', async (req) => {
  getSession(req.sid).compare?.stop();
  return { ok: true };
});

app.get('/api/compare/results', async (req) => {
  const c = getSession(req.sid).compare;
  if (!c || !c.done) return { status: c ? (c.running ? 'running' : 'stopped') : 'idle' };
  return {
    status: 'done',
    countermeasure: c.countermeasure,
    a: buildRunSummary(c.a, c.scenario, RATE_CARD),
    b: buildRunSummary(c.b, c.scenario, RATE_CARD),
  };
});

// Per-tick history export — CSV or JSON download of every simulation step
// recorded since the last reset. Format defaults to JSON.
app.get('/api/export', async (req, reply) => {
  const { engine } = getSession(req.sid);
  const history    = engine.getHistory();
  const format     = (req.query?.format ?? 'json').toLowerCase();
  const stamp      = new Date().toISOString().replace(/[:.]/g, '-');

  if (format === 'csv') {
    const csv = historyToCsv(history);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="machine_sim-${stamp}.csv"`);
    return csv;
  }

  reply
    .header('Content-Type', 'application/json; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="machine_sim-${stamp}.json"`);
  return history;
});

function historyToCsv(rows) {
  if (rows.length === 0) return '';
  // Union of the keys over all rows (first-row order, then new keys in order of
  // appearance), so machines spawned during the run get their own columns.
  const seen = new Set();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  const columns = [...seen];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => escape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ── Start server ───────────────────────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Line simulation running at http://0.0.0.0:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  try { await app.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
 *   GET  /original/     → the starter's original interface (own simulation, same API)
 *   GET  /api/events    → SSE stream, pushes state+metrics every 250 ms
 *   POST /api/control   → play/pause/reset/param updates
 *   GET  /api/presets   → scenario presets (id, label, description)
 *   GET  /api/export    → per-tick history as CSV (?format=csv) or JSON (the simulation log)
 *   GET  /api/kpis      → orders, service level and economics of the closed shifts
 *   GET  /api/results   → CEO interface: status of the scenario run + summary when done
 *   POST /api/advisor/explain, /api/advisor/improve → AI shift advisor (LLM called server-side only);
 *        explain with { question } asks a follow-up in the explanation chat of this run
 *   GET  /api/advisor/usage → tokens used by the AI (this browser session and the local tally of all runs)
 *   GET  /api/countermeasures[/cards] → the pool of 6 countermeasures; the cards' simulated values (computed on the spot)
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
import { buildUiScenario, normaliseShifts, normaliseUiSeed, UI_SCENARIO_IDS, RUN_SHIFTS, DEFAULT_SEED } from './ui/scenarios.js';
import { reconfiguresEngine } from './ui/session-rules.js';
import { catalogueFor, resolveSelection } from './countermeasures/catalog.js';
import { evaluateSelection } from './countermeasures/evaluate.js';
import { createCardStore } from './countermeasures/cards.js';
import { range } from './scenarios/scenarios.js';
import { buildRunSummary, engineRecord } from './ui/run-summary.js';
import { costBreakdown } from './economics/breakdown.js';
import { createAdvisor, MAX_FOLLOW_UPS, QUESTION_MAX } from './advisor/advisor.js';
import { readUsage } from './advisor/llm.js';
import { validateAnswers } from './advisor/constraints.js';
import { NO_START, normaliseStart } from './countermeasures/start-stock.js';
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
    s = { engine, sseClients: new Set(), cleanupTimer: null, scenario: null, runShifts: RUN_SHIFTS, runSeed: DEFAULT_SEED, runStart: { ...NO_START }, advice: null, compare: null, chat: null, aiTokens: { calls: 0, totalTokens: 0 } };
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
  // The original starter interface (/original/) gets its own simulation, so its controls never touch
  // the CEO run of the main page. Its files are unchanged, so it is recognised by the page that sent the request.
  if (isOriginalPage(req)) sid += ':original';
  req.sid = sid;
  done();
});

function isOriginalPage(req) {
  if (req.url.startsWith('/original')) return true;
  try { return new URL(req.headers.referer ?? '').pathname.startsWith('/original'); }
  catch { return false; }
}

app.register(fastifyStatic, {
  root:   join(__dirname, 'public'),
  prefix: '/',
});

// The interface as received in the starter (src/public/original/, files unchanged), opened from the header
app.get('/original', (req, reply) => reply.redirect('/original/'));

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
    session.chat = null;
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
      // CEO interface: one of the 4 scenarios, the shifts and the seed of the Simulate bar, animated or instant, stops by itself
      const id = params.scenario;
      if (!UI_SCENARIO_IDS.includes(id)) {
        reply.code(400);
        return { ok: false, error: `unknown scenario (allowed: ${UI_SCENARIO_IDS.join(', ')})` };
      }
      let shifts, seed, start;
      try {
        shifts = normaliseShifts(params.shifts === undefined ? undefined : Number(params.shifts));
        seed = normaliseUiSeed(params.seed === undefined || params.seed === '' ? undefined : Number(params.seed));
        start = normaliseStart(params.start);          // the ERP stock when switched on; absent = empty stock
      } catch (err) { reply.code(400); return { ok: false, error: err.message }; }
      const sc = buildUiScenario(id, shifts, seed, start);
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      cfg.source.materialStock = -1;
      engine.loadConfig(cfg);
      engine.configureScenario({ ...sc.configureOptions, runShifts: shifts });
      session.scenario = id;
      session.runShifts = shifts;
      session.runSeed = seed;
      session.runStart = start;
      session.advice = null;
      session.chat = null;                     // a new run starts a new explanation chat
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
    status: done ? 'done' : 'running', scenario: session.scenario, shiftsDone, shiftsTotal: session.runShifts, seed: session.runSeed,
    start: session.runStart,
    summary: done ? buildRunSummary(engine, buildUiScenario(session.scenario, session.runShifts, session.runSeed, session.runStart), RATE_CARD) : null,
  };
}

app.get('/api/results', async (req) => resultsFor(getSession(req.sid)));

// AI shift advisor. The LLM only words simulation numbers; errors carry no details.
// The values on the countermeasure cards: simulated on the spot for the scenario and the run length of the
// top bar, kept in memory only (no precomputation, no file). Shared by the cards endpoint and the advisor.
const cardStore = createCardStore();
const advisor = createAdvisor({ getCards: (scenarioId, shifts, start) => cardStore.whenReady(scenarioId, shifts, start) });

async function advise(req, reply, run) {
  const session = getSession(req.sid);
  const r = resultsFor(session);
  if (r.status !== 'done') {
    reply.code(409);
    return { error: 'Run a scenario to the end first' };
  }
  try {
    return await run(r.summary, buildUiScenario(session.scenario, session.runShifts, session.runSeed, session.runStart));
  } catch (err) {
    reply.code(502);
    return { error: err.message };
  }
}

// Explanation chat. No question: a new explanation (starts the chat of this run again).
// { question }: a follow-up; the server keeps the conversation, so the browser cannot rewrite the AI's answers.
function countTokens(session, r) {
  session.aiTokens.calls += 1;
  session.aiTokens.totalTokens += r.usage?.totalTokens ?? 0;
  return { ...r, sessionTokens: { ...session.aiTokens } };
}

app.post('/api/advisor/explain', async (req, reply) => {
  const session = getSession(req.sid);
  const question = req.body?.question;
  if (question === undefined || question === null) {
    return advise(req, reply, async (summary) => {
      const r = await advisor.explain(summary);
      session.chat = { explanation: r.text, turns: [] };
      return { ...countTokens(session, r), followUpsLeft: MAX_FOLLOW_UPS };
    });
  }
  if (typeof question !== 'string' || !question.trim()) { reply.code(400); return { error: 'Type a question first' }; }
  if (question.trim().length > QUESTION_MAX) { reply.code(400); return { error: `Keep the question under ${QUESTION_MAX} characters` }; }
  if (!session.chat) { reply.code(409); return { error: 'Ask for the explanation first' }; }
  if (session.chat.turns.length >= MAX_FOLLOW_UPS) {
    reply.code(429);
    return { error: `That is the limit of ${MAX_FOLLOW_UPS} questions for this run. Ask for a new explanation to start again.` };
  }
  return advise(req, reply, async (summary) => {
    const chat = session.chat;
    const r = await advisor.ask(summary, chat, question);
    if (session.chat !== chat) throw new Error('The run changed while the AI was answering');
    chat.turns.push({ question: question.trim(), answer: r.text });
    return { ...countTokens(session, r), followUpsLeft: MAX_FOLLOW_UPS - chat.turns.length };
  });
});

app.get('/api/advisor/usage', async (req) => {
  const all = readUsage();
  return { session: getSession(req.sid).aiTokens, allRuns: { calls: all.calls, totalTokens: all.totalTokens, since: all.firstCall } };
});
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
    const r = await advisor.improve(summary, sc, answers, { shifts: session.runShifts, start: session.runStart });
    if (r.status === 'proposed') {
      dropCompare(session);                    // a new proposal replaces the old comparison
      session.advice = {
        scenarioId: sc.id, selection: [{ id: r.countermeasure.id, params: r.countermeasure.params }],
        label: r.countermeasure.label, source: 'advisor', shifts: session.runShifts, seed: session.runSeed, start: session.runStart,
      };
    } else if (r.status === 'none') {
      dropCompare(session);                    // "no countermeasure pays off": nothing to compare
      session.advice = null;
    }
    return r;
  });
});

// Scenario, run length and starting stock of a cards request: the query (the top bar and the ERP bar, before
// Simulate was pressed), else the scenario, shift limit and starting stock of the session. Throws for a bad value.
function cardsTarget(req) {
  const session = getSession(req.sid);
  const q = req.query ?? {};
  const scenario = q.scenario ?? session.scenario ?? 'standard';
  if (!UI_SCENARIO_IDS.includes(scenario)) throw new Error(`unknown scenario (allowed: ${UI_SCENARIO_IDS.join(', ')})`);
  const shifts = normaliseShifts(q.shifts === undefined ? session.runShifts : Number(q.shifts));
  const start = q.finished === undefined && q.raw === undefined
    ? session.runStart : normaliseStart({ finished: q.finished, raw: q.raw });
  return { scenario: buildUiScenario(scenario, shifts).disruptionId, shifts, start };
}

// The pool of 6 countermeasures (the same in every scenario; one source: the catalogue)
app.get('/api/countermeasures', async (req, reply) => {
  try { return catalogueFor(cardsTarget(req).scenario); }
  catch (err) { reply.code(400); return { error: err.message }; }
});

// The card values, simulated on the spot (10 runs each) for the scenario and the run length of the top bar.
// Returns what is done so far; the page polls until `pending` is empty. Results stay in memory for this
// server process only, so a pair that was computed before is instant.
app.get('/api/countermeasures/cards', async (req, reply) => {
  try {
    const { scenario, shifts, start } = cardsTarget(req);
    return cardStore.snapshot(scenario, shifts, start);
  } catch (err) {
    reply.code(400);
    return { error: err.message };
  }
});

// Manual selection (one or several countermeasures): the simulation checks it, no LLM involved
app.post('/api/countermeasures/test', async (req, reply) => {
  const session = getSession(req.sid);
  const r = resultsFor(session);
  if (r.status !== 'done') { reply.code(409); return { error: 'Run a scenario to the end first' }; }
  if (session.compare?.running) { reply.code(409); return { error: 'Stop the comparison first' }; }
  const sc = buildUiScenario(session.scenario, session.runShifts, session.runSeed, session.runStart);
  const selection = req.body?.selection;
  let resolved;
  try { resolved = resolveSelection(selection, sc.disruptionId); }
  catch (err) { reply.code(400); return { error: err.message }; }
  try {
    const check = await evaluateSelection(sc.disruptionId, selection, { seeds: range(1, 10), shifts: session.runShifts, start: session.runStart });
    dropCompare(session);
    session.advice = {
      scenarioId: sc.id, selection: resolved.items.map(i => ({ id: i.cm.id, params: i.params })),
      label: resolved.label, source: 'manual', shifts: session.runShifts, seed: session.runSeed, start: session.runStart,
    };
    return {
      status: 'proposed', source: 'manual', countermeasure: check.countermeasure, constraintsApplied: [], answers: null, costs: check.costs,
      check: { runs: check.runs, without: check.without, with: check.with, change: check.change, verdict: check.verdict },
    };
  } catch (err) {
    reply.code(502);
    return { error: err.message };
  }
});

// ERP values for the Current Situation bar (demo data). The simulation uses the stock only when the CEO
// switches "Start from the ERP stock" on; the page then sends it with Simulate as params.start.
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
    // this one run (same random draws): the same cost lines as in the proposal card
    costs: costBreakdown({ without: [engineRecord(c.a, RATE_CARD)], with: [engineRecord(c.b, RATE_CARD)], rate: RATE_CARD, shifts: c.shifts, label: c.countermeasure.label }),
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
